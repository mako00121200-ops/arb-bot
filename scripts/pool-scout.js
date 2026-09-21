// scripts/pool-scout.js
//
// チェーン上の Swap / Sync イベントから、**ファクトリーの住所を知らないまま**
// プールを見つけて地図に載せる。
//
// [なぜ要るか(2026年9月20日の実測)]
// Optimism は壁が最小6bpsでガスも最安、1件の見込みが桁違いに大きい
// (`[試算] optimism: 壁-29bps:35本 $29.39(最大$4.42/投入$2000)`。
// 同じ条件で Polygon は最大$0.18)。ところが5時間見ても黒字判定は0件だった。
// 原因は速さではなく**見ている範囲**で、監視は9ペア・57プールしかない。
// Velodrome(Optimism 最大のDEX)が1つも入っておらず、同じペアに
// 0.05% と 0.30% しか並んでいないため、最小の壁が35bpsのままだった。
//
// ファクトリーの住所は公式資料で確定できないものが多い(Ramses系・Slipstream系)。
// そこで住所を当てにせず、**実際に取引が起きているプール**をイベントから拾う。
// 見つけたプールは tickSpacing で形式を見分け、見積もりは自前コントラクトの
// quoteV3(プール住所を直接渡す)、コールバックは名前不問の fallback で通る。
//
// [増やしすぎない]
// プールを増やすとWebSocketの受信がそのままRPCの消費になる(1件=1リクエスト)。
// Optimism は57プールで1日約9万件。無制限に足すと枠2,000万を超える。
// そこで「今の監視ペアを深くする」ものだけ載せる:
//   ① 両方のトークンが手書きの一覧にある      → 必ず載せる(壁が下がる)
//   ② 片方が一覧にあり、そのペアが既に地図にある → 載せる(比べる相手が増える)
//   ③ 片方が一覧にあり、取引が最も多い上位             → 載せる(価格は相手から導出)
//   ④ それ以外                                  → 載せずに件数と上位だけ報告する
// ③ は「次に広げる候補」を数字で見るためのもので、判断してから足す。

import { ethers } from "ethers";
import { callWithRpc } from "./onchain-reserves.js";
import { MULTICALL3_ADDRESS } from "./multicall-reserves.js";
import { registerPool, getPool, getPoolsForPair, KIND_V2, KIND_V3 } from "./pool-registry.js";
import { getKnownTokens } from "./borrowable-tokens.js";
import { isForkFactory, isForkQuoterEnabled, V3_FACTORIES, feeTierToBps } from "./v3-pools.js";
import { isKnownIncompatiblePool } from "./incompatible-pools.js";
import { getLastRpcUsage } from "./rpc-usage.js";

/// 調べるチェーン。自前の見積もり(ENABLE_FORK_QUOTER)が有効なチェーンでのみ
/// 意味がある(住所の分からないファクトリーのプールは公式Quoterで引けないため)。
const SCOUT_CHAINS = (process.env.SCOUT_CHAINS ?? "optimism")
  .split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
/// 遡るブロック数。Optimism は2秒/ブロックなので3,000で約100分。
const SCOUT_BLOCKS = parseInt(process.env.SCOUT_BLOCKS || "3000", 10);
/// 1回の eth_getLogs で読む幅。RPCの「結果が多すぎる」制限に当たったら半分にする。
const SCOUT_CHUNK_BLOCKS = parseInt(process.env.SCOUT_CHUNK_BLOCKS || "500", 10);
const MIN_CHUNK_BLOCKS = 100;
/// 1回の調査で使うRPCの上限。
const SCOUT_MAX_REQUESTS = parseInt(process.env.SCOUT_MAX_REQUESTS || "40", 10);
/// 1回の調査で新しく地図に載せるプールの上限(受信の増えすぎを防ぐ)。
const SCOUT_MAX_NEW_POOLS = parseInt(process.env.SCOUT_MAX_NEW_POOLS || "150", 10);
/// 正体を調べるプールの上限(Swapの多い順)。
const SCOUT_MAX_IDENTIFY = parseInt(process.env.SCOUT_MAX_IDENTIFY || "300", 10);
/// 「片方だけ既知」の新しいペアを取り込む上限(取引の多い順の順位)。
///
/// [なぜ順位で切るか(2026年9月20日の実測)]
/// 初回の発見で、Optimism の**最も取引の多いプール(100分で4,181回)**が
/// 「新しいペア(片方だけ既知)」として見送られていた。相手のトークンが
/// 手書きの一覧に無いだけで、取引はチェーンで一番厚い。価格は相手側
/// (USDC等)から自動で導出できるので、価格の推測は要らない。
/// ただしプールを増やすと受信がそのままRPCの消費になるため、
/// **取引の多い上位だけ**に絞る。件数ではなく順位で切ると、
/// チェーンの活発さが変わっても増え方が読める。
/// 「片方だけ既知」の新しいペアを、取引の多い順に何位まで採るか。
///
/// [8 → 50 に広げた(2026年9月21日、オーナーの指示)]
/// 実測でこうなっていた:
///   [プール発見] optimism: 3,000ブロックで264プールが稼働。264件を調べ、**0件**を追加。
///     見送り: 既に地図にある110 / **新しいペア(片方だけ既知)125** / 両方とも未知20 / 流動性が0 9
///   未採用で取引の多いペア上位: 132回 / 104回 / 90回 / 76回 / 75回(USDC・WETHと組んだペア)
///
/// **264本動いているのを見て、0本しか採っていなかった。**
/// ファクトリーを辿る必要は無かった。`getLogs` は住所を指定せず、
/// チェーン上の全ての取引を既に見ている。**採用の閾値だけが絞っていた。**
const SCOUT_ONE_KNOWN_TOP = parseInt(process.env.SCOUT_ONE_KNOWN_TOP || "50", 10);

/// 枠の月末見込がこれを超えたら、**新しいプールの採用を自分で止める**。
///
/// [なぜ要るか]
/// 課金は「購読で届くログ1件ごと」。監視するプールを増やすと受信が増え、
/// **枠を使い切れば端点に切られて bot ごと止まる**。
/// 増やす仕組みを入れるなら、**止める仕組みを同時に入れる**
/// (「再試行する仕組みを作ったら止め方も作る」と同じ)。
const SCOUT_QUOTA_STOP_PCT = parseFloat(process.env.SCOUT_QUOTA_STOP_PCT || "70");

/// 枠が危なければ true。採用を見送る。
function quotaTooTight() {
  const u = getLastRpcUsage();
  if (!u || !u.reliable) return false;   // まだ測れていないうちは止めない
  return u.projectedPercent >= SCOUT_QUOTA_STOP_PCT;
}

// Uniswap V3形式の Swap。Ramses系・Slipstream系のCLプールも同じ形。
const V3_SWAP_TOPIC = ethers.id("Swap(address,address,int256,int256,uint160,uint128,int24)");
// Algebra形式(末尾に手数料が付く版が2種)。
const ALGEBRA_SWAP_TOPICS = [
  ethers.id("Swap(address,address,int256,int256,uint160,uint128,int24,uint24)"),
  ethers.id("Swap(address,address,int256,int256,uint160,uint128,int24,uint24,uint24)"),
];
const SYNC_TOPIC = ethers.id("Sync(uint112,uint112)");
const ALL_TOPICS = [V3_SWAP_TOPIC, ...ALGEBRA_SWAP_TOPICS, SYNC_TOPIC];

const MULTICALL3_ABI = [
  "function aggregate3((address target, bool allowFailure, bytes callData)[] calls) view returns ((bool success, bytes returnData)[] returnData)",
];

const POOL_IFACE = new ethers.Interface([
  "function factory() view returns (address)",
  "function token0() view returns (address)",
  "function token1() view returns (address)",
  "function fee() view returns (uint24)",
  "function tickSpacing() view returns (int24)",
  "function liquidity() view returns (uint128)",
  "function getReserves() view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast)",
  "function stable() view returns (bool)",
]);

/// tickSpacing から手数料を見積もる。
///
/// [これは推測であることを明記する]
/// Uniswap V3 は fee() を持つのでそちらを使う。Ramses系・Slipstream系の
/// CLプールは fee() を持たないことがあり、その時だけこの対応表を使う。
/// 判定の真偽は価格表(自前の quoteV3)が決めるので、ここがずれても
/// 「ふるいを通る/通らない」が変わるだけで、嘘の利益にはならない。
/// 低めに見積もると、ふるいを通ってから価格表で落ちるだけ(安全側)。
/// 高めに見積もると本物を捨てるので、**迷ったら低い方**にする。
function feeBpsFromTickSpacing(spacing) {
  const s = Math.abs(Number(spacing) || 0);
  if (s <= 0) return 30;
  if (s <= 1) return 1;     // 0.01%(安定通貨どうし)
  if (s <= 10) return 5;    // 0.05%
  if (s <= 50) return 5;    // 0.05%(Slipstream の中間帯)
  if (s <= 100) return 30;  // 0.30%
  return 100;               // 1%
}

/// 既知のファクトリーなら、その表示名を返す。知らなければ住所から作る。
function dexIdForFactory(chain, factory) {
  const known = (V3_FACTORIES[chain] || []).find((f) => f.address.toLowerCase() === factory);
  if (known) return known.dexId;
  return `cl-${factory.slice(0, 8)}`;
}

let requestsUsed = 0;

/// 直近のブロックから、取引が起きたプールの住所と回数を集める。
async function collectActivePools(chain) {
  requestsUsed++;
  const latest = await callWithRpc(chain, (p) => p.getBlockNumber());
  const oldest = Math.max(0, latest - SCOUT_BLOCKS + 1);

  const counts = new Map(); // 住所(小文字) -> 回数
  let chunk = SCOUT_CHUNK_BLOCKS;
  let toBlock = latest;

  while (toBlock >= oldest && requestsUsed < SCOUT_MAX_REQUESTS) {
    const fromBlock = Math.max(oldest, toBlock - chunk + 1);
    let logs;
    try {
      requestsUsed++;
      logs = await callWithRpc(chain, (p) => p.getLogs({ topics: [ALL_TOPICS], fromBlock, toBlock }));
    } catch (e) {
      if (chunk > MIN_CHUNK_BLOCKS) {
        chunk = Math.max(MIN_CHUNK_BLOCKS, Math.floor(chunk / 2));
        continue;
      }
      toBlock = fromBlock - 1;
      continue;
    }
    for (const log of logs) {
      const key = (log.address || "").toLowerCase();
      if (!key) continue;
      counts.set(key, (counts.get(key) || 0) + 1);
    }
    toBlock = fromBlock - 1;
  }
  return { counts, scanned: latest - oldest + 1 };
}

/// プールの正体(ファクトリー・トークン・手数料・形式)をまとめて読む。
/// 1プールにつき読む項目。stable は Solidly系(Velodrome・Dystopia・Ramses系)の
/// 判別に使う。stable プールは x³y+y³x 曲線で、x·y=k の式が通用しない。
const FIELDS = ["factory", "token0", "token1", "fee", "tickSpacing", "liquidity", "getReserves", "stable"];

async function identifyPools(chain, addresses) {
  const info = new Map();
  const PER_CALL = 25; // 1プールにつき8つ読むので、1回200件以内に収める

  for (let i = 0; i < addresses.length; i += PER_CALL) {
    if (requestsUsed >= SCOUT_MAX_REQUESTS) break;
    const slice = addresses.slice(i, i + PER_CALL);
    const calls = [];
    for (const addr of slice) {
      const target = ethers.getAddress(addr);
      for (const fn of FIELDS) {
        calls.push({ target, allowFailure: true, callData: POOL_IFACE.encodeFunctionData(fn) });
      }
    }
    let returned;
    try {
      requestsUsed++;
      returned = await callWithRpc(chain, (p) =>
        new ethers.Contract(MULTICALL3_ADDRESS, MULTICALL3_ABI, p).aggregate3(calls));
    } catch (e) {
      continue;
    }
    for (let j = 0; j < slice.length; j++) {
      const n = FIELDS.length;
      const [rf, r0, r1, rFee, rSpacing, rLiq, rRes, rStable] = returned.slice(j * n, j * n + n);
      const ok = (r) => !!(r?.success && r.returnData !== "0x");
      if (!ok(rf) || !ok(r0) || !ok(r1)) continue;
      try {
        const entry = {
          factory: POOL_IFACE.decodeFunctionResult("factory", rf.returnData)[0].toLowerCase(),
          token0: POOL_IFACE.decodeFunctionResult("token0", r0.returnData)[0].toLowerCase(),
          token1: POOL_IFACE.decodeFunctionResult("token1", r1.returnData)[0].toLowerCase(),
          fee: ok(rFee) ? Number(POOL_IFACE.decodeFunctionResult("fee", rFee.returnData)[0]) : null,
          tickSpacing: ok(rSpacing) ? Number(POOL_IFACE.decodeFunctionResult("tickSpacing", rSpacing.returnData)[0]) : null,
          liquidity: ok(rLiq) ? POOL_IFACE.decodeFunctionResult("liquidity", rLiq.returnData)[0] : null,
          hasReserves: ok(rRes),
          stable: false,
        };
        if (ok(rStable)) {
          try { entry.stable = POOL_IFACE.decodeFunctionResult("stable", rStable.returnData)[0]; } catch (e2) {}
        }
        // V2 は getReserves を持ち、tickSpacing も liquidity(uint128) も持たない。
        entry.kind = entry.hasReserves && entry.tickSpacing == null ? KIND_V2 : KIND_V3;
        info.set(slice[j].toLowerCase(), entry);
      } catch (inner) {}
    }
  }
  return info;
}

/// そのプールを地図に載せてよいか。載せない理由も返す。
/// rank は取引の多い順の順位(0が最多)。
function decide(chain, address, entry, knownSet, rank) {
  if (isKnownIncompatiblePool(chain, address)) return { take: false, why: "過去に不適合" };
  if (getPool(chain, address)) return { take: false, why: "既に地図にある" };
  if (!entry.token0 || !entry.token1 || entry.token0 === entry.token1) return { take: false, why: "トークンが読めず" };
  // Solidly系の stable プールは x³y+y³x 曲線で、判定に使う x·y=k の式が
  // 通用しない。ファクトリーからの取り込み(pool-discovery.js)では以前から
  // 除いているので、イベントからの発見でも同じ扱いに揃える。
  // [2026年9月20日] polygon の dystopia プールが「手数料0bps」と実測され、
  // 判定は黒字・チェーン上では −79〜−204bps、送信前の確認で K検算に弾かれて
  // 自動的に無効化された。Optimism の Velodrome も同じ系統なので、
  // 主戦場を広げる前にここで止める。
  if (entry.stable) return { take: false, why: "stable曲線のプール" };
  if (entry.kind === KIND_V3 && (entry.liquidity == null || entry.liquidity <= 0n)) {
    return { take: false, why: "流動性が0" };
  }
  // 住所の分からないファクトリーは自前の見積もりが要る。使えないチェーンでは載せない。
  if (entry.kind === KIND_V3 && isForkFactory(chain, entry.factory) && !isForkQuoterEnabled(chain)) {
    return { take: false, why: "自前の見積もりが無効" };
  }
  const k0 = knownSet.has(entry.token0);
  const k1 = knownSet.has(entry.token1);
  if (k0 && k1) return { take: true, why: "両方が手書きの通貨" };
  if (k0 || k1) {
    // 片方だけの時は、そのペアが既に地図にあれば載せる(比べる相手が増える)。
    if (getPoolsForPair(chain, entry.token0, entry.token1).length > 0) {
      return { take: true, why: "既にあるペアを深くする" };
    }
    // 新しいペアでも、取引の多い上位なら載せる。相手が既知なので価格は
    // そのプールから導出でき、価格を推測せずに始点として使えるようになる。
    if (rank < SCOUT_ONE_KNOWN_TOP) {
      return { take: true, why: "新しいペア(取引が多い上位)" };
    }
    return { take: false, why: "新しいペア(片方だけ既知)" };
  }
  return { take: false, why: "新しいペア(両方とも未知)" };
}

/// 1チェーンを調べて、条件に合うプールを地図に載せる。
/// 戻り値: { added, scanned, active, skipped }
export async function scoutChain(chain) {
  const key = (chain || "").toLowerCase();
  requestsUsed = 0;
  const knownSet = new Set(Object.keys(getKnownTokens(key)).map((t) => t.toLowerCase()));

  const { counts, scanned } = await collectActivePools(key);
  if (counts.size === 0) {
    console.log(`[プール発見] ${key}: ${scanned.toLocaleString()}ブロックで取引のあるプールが見つかりませんでした`);
    return { added: 0, scanned, active: 0, skipped: {} };
  }

  // 取引の多い順に、上限まで正体を調べる。
  const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, SCOUT_MAX_IDENTIFY);
  const info = await identifyPools(key, ranked.map(([a]) => a));

  const skipped = {};
  const candidates = []; // 載せずに保留した「次の候補」
  let added = 0, v2Added = 0, v3Added = 0, addedSwaps = 0;

  // **枠が危なければ、今回は1本も採らない。** 増やす前に止められるようにする。
  if (quotaTooTight()) {
    const u = getLastRpcUsage();
    console.warn(`[プール発見] ${key}: 枠の月末見込が${u.projectedPercent.toFixed(0)}%(上限${SCOUT_QUOTA_STOP_PCT}%)のため、**今回は新しいプールを採りません**`);
    return { added: 0, scanned, active: counts.size, skipped: { "枠が危ない": ranked.length } };
  }

  // **順位は「まだ地図に無いプール」の中で数える。**
  //
  // [なぜ(2026年9月21日、上位8→50に広げた直後の実測で判明)]
  //   [プール発見] optimism: 364プールが稼働。300件を調べ、17件を追加。
  //     見送り: **既に地図にある115** / …… / **新しいペア(片方だけ既知)131**
  //
  // 順位は「取引の多い順」で全プールに振っていた。だが上位は
  // **既に地図にあるプールが占める**(取引が多いから先に採用されている)。
  // つまり**地図が育つほど、新しいプールの順位が押し下げられて入れなくなる**。
  // 増やすための仕組みが、増えるほど効かなくなる**逆向きのラチェット**だった。
  //
  // 「上位50まで」は「**新しいプールの中で上位50まで**」の意味にする。
  let newRank = 0;
  for (let rank = 0; rank < ranked.length; rank++) {
    const [address, swaps] = ranked[rank];
    const entry = info.get(address);
    if (!entry) { skipped["正体が読めず"] = (skipped["正体が読めず"] || 0) + 1; continue; }
    const alreadyMapped = !!getPool(key, address);
    const { take, why } = decide(key, address, entry, knownSet, newRank);
    if (!alreadyMapped) newRank++;
    if (!take) {
      skipped[why] = (skipped[why] || 0) + 1;
      if (why.startsWith("新しいペア")) candidates.push({ address, swaps, entry });
      continue;
    }
    if (added >= SCOUT_MAX_NEW_POOLS) { skipped["上限に達した"] = (skipped["上限に達した"] || 0) + 1; continue; }

    const isV3 = entry.kind === KIND_V3;
    const feeBps = isV3
      ? (entry.fee != null ? feeTierToBps(entry.fee) : feeBpsFromTickSpacing(entry.tickSpacing))
      : 30; // V2 は手数料の実測(getAmountOut か取引記録)に任せる
    registerPool({
      chain: key, address, dexId: dexIdForFactory(key, entry.factory), factory: entry.factory,
      kind: entry.kind,
      token0: entry.token0, token1: entry.token1,
      feeTier: isV3 ? entry.fee : null,
      feeBps,
      // V2 の準備量と V3 の状態は、この後の prepareChain がまとめて読む。
      updatedAt: 0,
    });
    added++;
    addedSwaps += swaps;
    if (isV3) v3Added++; else v2Added++;
  }

  const skipLine = Object.entries(skipped).map(([k, n]) => `${k}${n}`).join(" / ") || "なし";
  console.log(`[プール発見] ${key}: ${scanned.toLocaleString()}ブロックで${counts.size}プールが稼働。${ranked.length}件を調べ、**${added}件**を地図に追加(V3 ${v3Added} / V2 ${v2Added})。見送り: ${skipLine}。RPC${requestsUsed}回。追加分の取引${addedSwaps.toLocaleString()}回/${scanned.toLocaleString()}ブロック`);

  // 次に広げる候補を、取引の多い順に数件だけ出す。判断の材料にする。
  if (candidates.length > 0) {
    const top = candidates.slice(0, 5).map((c) =>
      `${c.address.slice(0, 10)}…(${c.swaps}回 ${c.entry.token0}/${c.entry.token1})`).join(" ");
    console.log(`[プール発見] ${key}: 未採用で取引の多いペア上位: ${top}`);
  }
  return { added, scanned, active: counts.size, skipped };
}

/// 設定されたチェーンをまとめて調べる。
export async function scoutAllChains(activeChains) {
  const targets = SCOUT_CHAINS.filter((c) => activeChains.includes(c));
  const result = {};
  for (const chain of targets) {
    try {
      result[chain] = await scoutChain(chain);
    } catch (e) {
      console.warn(`[プール発見] ${chain}: 失敗 ${(e.message || "").slice(0, 100)}`);
      result[chain] = null;
    }
  }
  return result;
}

export function getScoutChains() { return [...SCOUT_CHAINS]; }
export const SCOUT_INTERVAL_MS = parseFloat(process.env.SCOUT_INTERVAL_HOURS || "6") * 60 * 60 * 1000;
