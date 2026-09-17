// scripts/pool-survey.js
//
// V3型プールをDEX(ファクトリー)別に調べる、1回きりの調査。
//
// [何のための調査か]
// 現在監視しているV3ファクトリーは Uniswap V3 の1つだけ(v3-pools.js の
// V3_FACTORIES)。PolygonのDEX出来高は Uniswap 約51% / RamsesX 約16% /
// Metric 約14% / QuickSwap 約12% なので、残り約半分は見えていない。
// 「見えていないDEXに、いま取引している通貨ペアのプールがあるか」を
// 確かめれば、Ramses系・Algebra系への対応が利益を増やすかどうかが決まる。
//
// [プールの見つけ方: 推測しない]
// ファクトリーのアドレスは手で書かない。チェーン上のV3型Swapイベントを
// 一定期間だけ拾い、出てきたプールに factory() を呼んで逆算する
// (pool-discovery.js と同じ考え方)。
//
// [イベント識別子は必ず ethers.id() で計算する]
// 過去に識別子を手書きして1文字欠け、最初期から一度も受信できていなかった。
// ここでは署名の文字列だけを書き、ハッシュは ethers.id() に計算させる。
//
// [Algebra系(QuickSwap V3 / Ramses系)への配慮]
// Algebra は手数料が動的なため、プール照会が getPool(a,b,fee) ではなく
// poolByPair(a,b) の場合がある。どちらが正しいかは実物で確かめるまで
// 決めつけず、両方を allowFailure 付きで投げて反応した方を採用する。
// Swapイベントも版によって引数が増えている可能性があるため、候補を
// 複数用意して「いずれか一致」で拾う。
//
// [RPC枠を浪費しない]
// 過去に「必ず失敗するループ」でRPC枠を浪費した。ここでは
//   ・総リクエスト数に上限を設ける(超えたら即座に打ち切る)
//   ・失敗したブロック幅は半分にし、最小幅でも失敗したら「飛ばして進む」
//   ・一度きりの実行。setInterval は使わない
// を守る。全ての呼び出しは callWithRpc 経由なのでタイムアウトも効く。

import { ethers } from "ethers";
import { callWithRpc } from "./onchain-reserves.js";
import { MULTICALL3_ADDRESS, fetchV3StatesBatch } from "./multicall-reserves.js";
import { getKnownTokens } from "./borrowable-tokens.js";
import { V3_FACTORIES, V3_FEE_TIERS } from "./v3-pools.js";

// ---- 調査の規模(環境変数で変えられる) ----

/// 遡るブロック数。Polygonは約2秒/ブロックなので、既定の30,000は約16〜17時間分。
const SURVEY_BLOCKS = parseInt(process.env.SURVEY_BLOCKS || "30000", 10);
/// 1回の eth_getLogs で読むブロック幅。
/// 手数料実測(onchain-reserves.js)は1プールに絞って2,000ブロック読むが、
/// こちらはアドレス指定なしでチェーン全体を読むため戻り件数が桁違いに多い。
/// RPCの「結果が多すぎる」制限に当たりにくい幅から始める。
const SURVEY_CHUNK_BLOCKS = parseInt(process.env.SURVEY_CHUNK_BLOCKS || "500", 10);
/// これ以上ブロック幅を小さくしない下限。ここでも失敗したら、その区間は飛ばす。
const MIN_CHUNK_BLOCKS = 250;
/// 調査全体で許すRPCリクエストの上限。超えたら打ち切って、集まった分だけ報告する。
const SURVEY_MAX_REQUESTS = parseInt(process.env.SURVEY_MAX_REQUESTS || "120", 10);
/// ファクトリーを逆算する対象にするプールの上限(Swapの多い順)。
const MAX_POOLS_TO_IDENTIFY = parseInt(process.env.SURVEY_MAX_POOLS || "400", 10);
/// 報告時に各ファクトリーの代表として出すプール数。
const SAMPLE_POOLS_PER_FACTORY = 3;
/// ペア照会まで行う未監視ファクトリーの数(Swapの多い順)。
/// 小さなDEXまで全部調べると枠を食い切るため、上位だけに絞る。
const MAX_FACTORIES_TO_PROBE = parseInt(process.env.SURVEY_MAX_FACTORIES || "6", 10);
/// Multicall3 に一度に詰める呼び出し数。
const BATCH_SIZE = 200;

// ---- イベント識別子(ハッシュは ethers.id() に計算させる) ----

/// Uniswap V3 と Algebra V1(QuickSwap V3)は引数の型が同じなので識別子も同じ。
/// 新しい Algebra Integral は引数が増えている版があるため候補に入れる。
/// 実在しない署名を混ぜても「一致しない」だけで害はない。
const SWAP_SIGNATURES = [
  "Swap(address,address,int256,int256,uint160,uint128,int24)",
  "Swap(address,address,int256,int256,uint160,uint128,int24,uint24,uint24)",
  "Swap(address,address,int256,int256,uint160,uint128,int24,uint24)",
];
const SWAP_TOPICS = SWAP_SIGNATURES.map((sig) => ethers.id(sig));

// ---- 呼び出しの型 ----

const MULTICALL3_ABI = [
  "function aggregate3((address target, bool allowFailure, bytes callData)[] calls) view returns ((bool success, bytes returnData)[] returnData)",
];
const POOL_IFACE = new ethers.Interface([
  "function factory() view returns (address)",
  "function token0() view returns (address)",
  "function token1() view returns (address)",
  "function fee() view returns (uint24)",
]);
/// 照会の関数名はDEXによって違う。決めつけず両方投げる。
const FACTORY_IFACE = new ethers.Interface([
  "function getPool(address tokenA, address tokenB, uint24 fee) view returns (address)",
  "function poolByPair(address tokenA, address tokenB) view returns (address)",
]);

// ---- RPC回数の管理 ----

let requestsUsed = 0;
function budgetLeft() {
  return SURVEY_MAX_REQUESTS - requestsUsed;
}

async function multicall(chain, calls) {
  requestsUsed++;
  return callWithRpc(chain, (p) =>
    new ethers.Contract(MULTICALL3_ADDRESS, MULTICALL3_ABI, p).aggregate3(calls));
}

// ---- 手順1: V3型Swapイベントからプールを拾う ----

/// 直近のブロックを遡り、V3型のSwapを出したプールのアドレスと回数を集める。
/// アドレス指定なしのログ取得なので、まだ知らないDEXのプールも入ってくる。
async function collectPoolsFromSwaps(chain) {
  requestsUsed++;
  const latest = await callWithRpc(chain, (p) => p.getBlockNumber());
  const oldest = Math.max(0, latest - SURVEY_BLOCKS + 1);

  const swapCounts = new Map(); // アドレス(小文字) -> Swap回数
  let chunk = SURVEY_CHUNK_BLOCKS;
  let toBlock = latest;
  let skipped = 0;

  while (toBlock >= oldest) {
    if (budgetLeft() <= 0) {
      console.warn(`[プール調査] RPC上限 ${SURVEY_MAX_REQUESTS} 回に達したため、ログ収集を打ち切ります`);
      break;
    }
    const fromBlock = Math.max(oldest, toBlock - chunk + 1);
    let logs = null;
    try {
      requestsUsed++;
      logs = await callWithRpc(chain, (p) => p.getLogs({ topics: [SWAP_TOPICS], fromBlock, toBlock }));
    } catch (e) {
      // 幅が広すぎる/重すぎる場合は半分にして同じ区間をやり直す。
      if (chunk > MIN_CHUNK_BLOCKS) {
        chunk = Math.max(MIN_CHUNK_BLOCKS, Math.floor(chunk / 2));
        console.warn(`[プール調査] ログ取得に失敗したため幅を ${chunk} ブロックに縮小します: ${e.message}`);
        continue;
      }
      // 最小幅でも駄目な区間は飛ばす。ここで粘ると枠を浪費する。
      skipped++;
      console.warn(`[プール調査] ${fromBlock}〜${toBlock} は最小幅でも取得できないため飛ばします: ${e.message}`);
      toBlock = fromBlock - 1;
      continue;
    }
    for (const log of logs) {
      const key = (log.address || "").toLowerCase();
      if (!key) continue;
      swapCounts.set(key, (swapCounts.get(key) || 0) + 1);
    }
    toBlock = fromBlock - 1;
  }

  return { swapCounts, latest, oldest, skipped };
}

// ---- 手順2: プールからファクトリーを逆算する ----

/// factory() / token0() / token1() / fee() を一括で読む。
/// fee() を持たないプール(Algebraは動的手数料)は null のままにする。
async function identifyPools(chain, addresses) {
  const info = new Map(); // アドレス(小文字) -> { factory, token0, token1, fee }
  const perChunk = Math.floor(BATCH_SIZE / 4);

  for (let i = 0; i < addresses.length; i += perChunk) {
    if (budgetLeft() <= 0) {
      console.warn("[プール調査] RPC上限に達したため、ファクトリーの逆算を打ち切ります");
      break;
    }
    const slice = addresses.slice(i, i + perChunk);
    const calls = [];
    for (const addr of slice) {
      const target = ethers.getAddress(addr);
      calls.push({ target, allowFailure: true, callData: POOL_IFACE.encodeFunctionData("factory") });
      calls.push({ target, allowFailure: true, callData: POOL_IFACE.encodeFunctionData("token0") });
      calls.push({ target, allowFailure: true, callData: POOL_IFACE.encodeFunctionData("token1") });
      calls.push({ target, allowFailure: true, callData: POOL_IFACE.encodeFunctionData("fee") });
    }
    let returned;
    try {
      returned = await multicall(chain, calls);
    } catch (e) {
      console.warn(`[プール調査] 一括読み取りに失敗しました(この分は諦めます): ${e.message}`);
      continue;
    }
    for (let j = 0; j < slice.length; j++) {
      const [rf, r0, r1, rfee] = returned.slice(j * 4, j * 4 + 4);
      if (!rf?.success || rf.returnData === "0x") continue;
      try {
        const factory = POOL_IFACE.decodeFunctionResult("factory", rf.returnData)[0];
        const entry = { factory: factory.toLowerCase(), token0: null, token1: null, fee: null };
        if (r0?.success && r0.returnData !== "0x") {
          entry.token0 = POOL_IFACE.decodeFunctionResult("token0", r0.returnData)[0].toLowerCase();
        }
        if (r1?.success && r1.returnData !== "0x") {
          entry.token1 = POOL_IFACE.decodeFunctionResult("token1", r1.returnData)[0].toLowerCase();
        }
        if (rfee?.success && rfee.returnData !== "0x") {
          try { entry.fee = Number(POOL_IFACE.decodeFunctionResult("fee", rfee.returnData)[0]); } catch (inner) {}
        }
        info.set(slice[j].toLowerCase(), entry);
      } catch (inner) {}
    }
  }
  return info;
}

// ---- 手順3: 監視中の通貨ペアが、そのファクトリーにあるか ----

/// 監視トークンから作れる全ペアを返す。
function buildPairs(tokens) {
  const list = Object.keys(tokens).map((a) => a.toLowerCase());
  const pairs = [];
  for (let i = 0; i < list.length; i++) {
    for (let j = i + 1; j < list.length; j++) pairs.push([list[i], list[j]]);
  }
  return pairs;
}

/// 1つのファクトリーに対して、全ペア × 全手数料帯 の getPool と、
/// 手数料引数なしの poolByPair を投げ、反応した組み合わせを拾う。
async function probeFactoryForPairs(chain, factory, pairs, tokens) {
  if (budgetLeft() <= 0) return { found: [], style: null };
  const target = ethers.getAddress(factory);
  const calls = [];
  const meta = [];

  for (const [a, b] of pairs) {
    for (const fee of V3_FEE_TIERS) {
      calls.push({ target, allowFailure: true, callData: FACTORY_IFACE.encodeFunctionData("getPool", [a, b, fee]) });
      meta.push({ a, b, fee, fn: "getPool" });
    }
    calls.push({ target, allowFailure: true, callData: FACTORY_IFACE.encodeFunctionData("poolByPair", [a, b]) });
    meta.push({ a, b, fee: null, fn: "poolByPair" });
  }

  const found = [];
  const styleHits = { getPool: 0, poolByPair: 0 };

  for (let i = 0; i < calls.length; i += BATCH_SIZE) {
    if (budgetLeft() <= 0) {
      console.warn("[プール調査] RPC上限に達したため、ペア照会を打ち切ります");
      break;
    }
    let returned;
    try {
      returned = await multicall(chain, calls.slice(i, i + BATCH_SIZE));
    } catch (e) {
      console.warn(`[プール調査] ペア照会に失敗しました(この分は諦めます): ${e.message}`);
      continue;
    }
    for (let j = 0; j < returned.length; j++) {
      const r = returned[j];
      if (!r?.success || r.returnData === "0x") continue;
      const m = meta[i + j];
      try {
        const addr = FACTORY_IFACE.decodeFunctionResult(m.fn, r.returnData)[0];
        if (!addr || addr === ethers.ZeroAddress) continue;
        styleHits[m.fn]++;
        found.push({
          address: addr.toLowerCase(),
          symbol: `${tokens[m.a]?.symbol || m.a.slice(0, 8)}/${tokens[m.b]?.symbol || m.b.slice(0, 8)}`,
          fee: m.fee,
          fn: m.fn,
        });
      } catch (inner) {}
    }
  }

  // どちらの関数名が通ったかで、そのDEXの形式を判断する(推測ではなく反応で決める)。
  const style = styleHits.getPool >= styleHits.poolByPair
    ? (styleHits.getPool > 0 ? "getPool(手数料帯あり=Uniswap V3形式)" : null)
    : "poolByPair(手数料が動的=Algebra形式)";

  return { found, style };
}

// ---- 報告 ----

function formatLiquidity(liquidity) {
  if (liquidity === null || liquidity === undefined) return "読めず";
  if (liquidity === 0n) return "0(空)";
  return liquidity.toString();
}

/// 調査の本体。環境変数 RUN_POOL_SURVEY にチェーン名を入れて起動すると、一度だけ走る。
export async function runPoolSurvey(chain) {
  requestsUsed = 0;
  const started = Date.now();
  const tokens = getKnownTokens(chain) || {};
  const tokenCount = Object.keys(tokens).length;
  if (tokenCount === 0) {
    console.warn(`[プール調査] ${chain} の監視トークンが空のため中止します`);
    return;
  }
  const pairs = buildPairs(tokens);

  console.log("=".repeat(70));
  console.log(`[プール調査] ${chain} を調べます`);
  console.log(`[プール調査] 監視トークン ${tokenCount} 種 → ${pairs.length} ペア / RPC上限 ${SURVEY_MAX_REQUESTS} 回`);

  // 手順1
  const { swapCounts, latest, oldest, skipped } = await collectPoolsFromSwaps(chain);
  console.log(`[プール調査] ブロック ${oldest}〜${latest} を走査 / V3型Swapを出したプール ${swapCounts.size} 件${skipped > 0 ? ` / 取得できず飛ばした区間 ${skipped} 件` : ""}`);
  if (swapCounts.size === 0) {
    console.warn("[プール調査] Swapが1件も拾えませんでした。SURVEY_BLOCKS を増やすか、RPCの状態を確認してください");
    return;
  }

  // Swapの多い順に絞る。取引の無いプールは裁定には使えない。
  const ranked = [...swapCounts.entries()].sort((a, b) => b[1] - a[1]);
  const targets = ranked.slice(0, MAX_POOLS_TO_IDENTIFY).map(([addr]) => addr);

  // 手順2
  const info = await identifyPools(chain, targets);
  const byFactory = new Map(); // ファクトリー -> { pools:[], swaps:number }
  for (const [addr, entry] of info) {
    if (!byFactory.has(entry.factory)) byFactory.set(entry.factory, { pools: [], swaps: 0 });
    const bucket = byFactory.get(entry.factory);
    bucket.pools.push(addr);
    bucket.swaps += swapCounts.get(addr) || 0;
  }

  const known = new Set((V3_FACTORIES[chain] || []).map((f) => f.address.toLowerCase()));
  const sorted = [...byFactory.entries()].sort((a, b) => b[1].swaps - a[1].swaps);

  console.log("-".repeat(70));
  console.log("[プール調査] ファクトリー別の内訳(Swapの多い順)");
  for (const [factory, bucket] of sorted) {
    const mark = known.has(factory) ? "監視中" : "未監視";
    const samples = bucket.pools.slice(0, SAMPLE_POOLS_PER_FACTORY).join(", ");
    console.log(`  [${mark}] ${factory} : プール ${bucket.pools.length} 件 / Swap ${bucket.swaps} 回`);
    console.log(`           代表プール: ${samples}`);
  }

  // 手順3: 未監視のファクトリーだけ、監視中のペアがあるか確かめる。
  const unknown = sorted.filter(([factory]) => !known.has(factory));
  if (unknown.length === 0) {
    console.log("[プール調査] 未監視のファクトリーは見つかりませんでした");
  }

  if (unknown.length > MAX_FACTORIES_TO_PROBE) {
    console.log(`[プール調査] 未監視ファクトリーは ${unknown.length} 件。Swapの多い上位 ${MAX_FACTORIES_TO_PROBE} 件だけ照会します`);
  }
  for (const [factory, bucket] of unknown.slice(0, MAX_FACTORIES_TO_PROBE)) {
    if (budgetLeft() <= 0) break;
    console.log("-".repeat(70));
    console.log(`[プール調査] 未監視ファクトリー ${factory}(Swap ${bucket.swaps} 回)で、監視中の ${pairs.length} ペアを照会します`);
    const { found, style } = await probeFactoryForPairs(chain, factory, pairs, tokens);
    if (style) console.log(`[プール調査] 照会形式: ${style}`);
    if (found.length === 0) {
      console.log("[プール調査] → 監視中のペアのプールはありませんでした(このDEXの出来高は対象外トークンにある可能性が高い)");
      continue;
    }
    const states = await fetchV3StatesBatch(chain, found.map((f) => f.address));
    requestsUsed += Math.ceil(found.length / 60); // fetchV3StatesBatch の内部呼び出し分を概算で計上
    console.log(`[プール調査] → ${found.length} 件のプールが見つかりました`);
    for (const f of found) {
      const st = states.get(f.address);
      const feeLabel = f.fee === null ? "動的" : `${f.fee / 10000}%`;
      console.log(`    ${f.symbol} 手数料${feeLabel} ${f.address} 流動性=${formatLiquidity(st?.liquidity ?? null)}`);
    }
  }

  console.log("-".repeat(70));
  console.log(`[プール調査] 完了。RPC使用 約${requestsUsed} 回 / 所要 ${((Date.now() - started) / 1000).toFixed(1)} 秒`);
  console.log("[プール調査] 終わったら RUN_POOL_SURVEY を false に戻してください");
  console.log("=".repeat(70));
}
