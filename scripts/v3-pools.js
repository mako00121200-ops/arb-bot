// scripts/v3-pools.js
//
// Uniswap V3形式(集中流動性)のプールを扱う。
//
// [独自の概算式をやめた理由]
// 現在価格と流動性だけから受取量を近似していたが、実測すると公式Quoterより
// 最大2,184%も過大な値を返していた(2026年9月16日)。V3は価格帯ごとに
// 流動性が分かれており、価格帯をまたぐ場合の扱いが近似式では表現できない。
// 流動性の薄いプールほど誤差が大きく、幻の機会を大量に生んでいた。
//
// [代わりの方式: 価格表を持つ]
// プールごとに「代表的な投入額での受取量」を公式Quoterで取得し、メモリに
// 保持する。判定時はこの表から補間するため、RPCを使わずミリ秒で済み、
// かつ公式の計算に基づくので誤差がない。
//
// [価格表はまとめて作る(2026年9月16日)]
// 以前は投入額1つにつきQuoterを1回呼んでいた(1プールあたり12回)。
// Chainstackは1回=1リクエスト単位で課金されるため、Multicall3で束ねて
// 複数プール分の見積もりを1〜2回の呼び出しで済ませる。
//
// 表に無い投入額は、最も近い2点から線形に補間する。V3の受取量は投入額に
// 対して上に凸の曲線なので、直線で補間すると実際より少なめに出る(安全側)。

import { ethers } from "ethers";
import { callWithRpc } from "./onchain-reserves.js";
import { quoteV3Batch, quoteV3ByPoolBatch } from "./multicall-reserves.js";
import { getAnyChainConfig } from "../chain-config.js";

export const QUOTER_V2_ADDRESS = {
  polygon: "0x61fFE014bA17989E743c5F6cB21bF9697530B21e",
  base: "0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a",
  arbitrum: "0x61fFE014bA17989E743c5F6cB21bF9697530B21e",
  optimism: "0x61fFE014bA17989E743c5F6cB21bF9697530B21e",
  avalanche: "0xbe0F5544EC67e9B3b2D979aaA43f18Fd87E6257F",
};

/// V3型プールのファクトリー。
///
/// [fork: true を付けたもの(2026年9月17日に調査で見つけた)]
/// Uniswap公式のQuoterでは見積もれないファクトリー。自前コントラクトの
/// quoteV3 が要るため、ENABLE_FORK_QUOTER でそのチェーンを有効にするまで
/// 探索対象にしない。有効にせずに足すと、価格表が作れないプールを監視して
/// イベントとRPCを捨てるだけになる。
///
/// アドレスは推測していない。チェーン上のSwap/Syncイベントから出てきた
/// プールに factory() を呼んで逆算した(scripts/pool-survey.js)。
/// style(uniswap / algebra)も推測ではない。調査は同じファクトリーに
/// getPool と poolByPair の両方を allowFailure 付きで投げ、実際に住所を
/// 返した方を採っている(pool-survey.js の probeFactoryForPairs)。
///
/// 残る不確かさは「調査結果をここへ書き写す作業」だけ。実際にチェックサムの
/// 大文字小文字を3件書き間違えていた。そのため discoverV3PoolsForChain は
/// fork のファクトリーごとに発見件数をログに出す。0件が続くなら書き写しが
/// 誤っているので、そこで直す。
export const V3_FACTORIES = {
  polygon: [
    { address: "0x1F98431c8aD98523631AE4a59f267346ea31F984", dexId: "uniswap-v3", style: "uniswap" },
    // 調査期間中のV3 Swapの22.4%を占めた、未監視で最大のファクトリー。
    { address: "0x411b0fAcC3489691f28ad58c47006AF5E3Ab3A28", dexId: "algebra-a", style: "algebra", fork: true },
    { address: "0x917933899c6a5F8E37F31E19f92CdBFF7e8FF0e2", dexId: "univ3-fork-a", style: "uniswap", fork: true },
    { address: "0x91e1B99072f238352f59e58de875691e20Dc19c1", dexId: "univ3-fork-b", style: "uniswap", fork: true },
  ],
  base: [
    { address: "0x33128a8fC17869897dcE68Ed026d694621f6FDfD", dexId: "uniswap-v3", style: "uniswap" },
    // Baseは監視中ペアのV3プールが18件。その大半がこの2ファクトリー側にある。
    { address: "0xc35DADB65012eC5796536bD9864eD8773aBc74C4", dexId: "univ3-fork-c", style: "uniswap", fork: true },
    { address: "0x36077D39cdC65E1e3FB65810430E5b2c4D5fA29E", dexId: "algebra-b", style: "algebra", fork: true },
  ],
  arbitrum: [
    { address: "0x1F98431c8aD98523631AE4a59f267346ea31F984", dexId: "uniswap-v3", style: "uniswap" },
  ],
  optimism: [
    { address: "0x1F98431c8aD98523631AE4a59f267346ea31F984", dexId: "uniswap-v3", style: "uniswap" },
    // Optimismは監視中ペアのV3プールが27件あり、手数料の壁が最小0.06%まで下がる。
    { address: "0x9c6522117e2ed1fE5bdb72bb0eD5E3f2bdE7DBe0", dexId: "univ3-fork-d", style: "uniswap", fork: true },
  ],
  avalanche: [
    { address: "0x740b1c1de25031C31FF4fC9A62f554A55cdC1baD", dexId: "uniswap-v3", style: "uniswap" },
    // 調査期間中のV3 Swap 2,176回のうち924回(42%)を占めた最大の未監視DEX。
    // 監視中の10ペアに9プール。うち流動性があるのは USDC/USDT 0.01%、
    // USDC/WAVAX 0.01%、USDC/WAVAX 0.05% の3件。
    { address: "0x1128F23D0bc0A8396E9FBC3c0c68f5EA228B8256", dexId: "univ3-fork-e", style: "uniswap", fork: true },
    // Swapは8回と少ないが、監視中ペアに13プールあり流動性が厚い。
    // 動きが遅い=価格が取り残されやすいので、相手側として狙う価値がある。
    { address: "0x3e603C14aF37EBdaD31709C4f848Fc6aD5BEc715", dexId: "univ3-fork-f", style: "uniswap", fork: true },
    // 0x5F1dddbf…(Algebra形式、1プール)は調査で「流動性=読めず」だった。
    // globalState には対応したが、監視中ペアのプールが1件だけで
    // 流動性も確認できていないため、今は足さない。
  ],
};

/// そのファクトリーがフォーク(公式Quoterで見積もれない)かどうか。
/// 公式Quoterはプール住所を取らず、公式ファクトリーから住所を計算してしまうため、
/// フォークのプールを公式Quoterに投げると「別のプールの価格」が返ってくる。
/// それをそのプールの価格表として保存すると、存在しない利益機会を生む。
export function isForkFactory(chain, factory) {
  if (!factory) return false;
  const target = factory.toLowerCase();
  const list = V3_FACTORIES[(chain || "").toLowerCase()] || [];
  const hit = list.find((f) => f.address.toLowerCase() === target);
  // 一覧に無いファクトリーは公式と断定できないので、安全側(フォーク扱い)に倒す。
  return hit ? hit.fork === true : true;
}

/// Algebra形式のプールを実際に使えるかどうか。
///
/// 2026年9月18日に対応した。必要だったのは次の3つ。
///   ① 状態の読み取り: multicall-reserves.js が globalState() に対応。
///      返り値の並びは版によって違うので、共通する先頭2語だけを自前で読む
///   ② WebSocketの購読: dex-onchain-realtime.js に、手数料を含む
///      Algebra の Swap 識別子2種を追加(引数の位置は共通なので復号は同じ)
///   ③ 見積もり: プール住所を直接受け取る自前の quoteV3。
///      コントラクトは algebraSwapCallback を元から持っている
/// なお ①②③ が揃っても、ENABLE_FORK_QUOTER に入れたチェーンでしか
/// フォークは探索されない(quoteV3 入りのコントラクトが要るため)。
const ALGEBRA_SUPPORTED = true;

/// そのチェーンで探索してよいファクトリー。
/// fork: true のものは ENABLE_FORK_QUOTER に入っているチェーンでだけ返す。
export function activeV3Factories(chain) {
  const all = V3_FACTORIES[chain] || [];
  const usable = ALGEBRA_SUPPORTED ? all : all.filter((f) => f.style !== "algebra");
  if (isForkQuoterEnabled(chain)) return usable;
  return usable.filter((f) => !f.fork);
}

export const V3_FEE_TIERS = [100, 500, 3000, 10000];

export const V3_POOL_ABI = [
  "function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)",
  "function liquidity() view returns (uint128)",
  "function token0() view returns (address)",
  "function token1() view returns (address)",
  "function fee() view returns (uint24)",
];

const V3_FACTORY_ABI = [
  "function getPool(address tokenA, address tokenB, uint24 fee) view returns (address)",
  // Algebra系は手数料が動的なので、手数料帯の引数を取らない。
  "function poolByPair(address tokenA, address tokenB) view returns (address)",
];

const QUOTER_V2_ABI = [
  "function quoteExactInputSingle((address tokenIn, address tokenOut, uint256 amountIn, uint24 fee, uint160 sqrtPriceLimitX96)) returns (uint256 amountOut, uint160 sqrtPriceX96After, uint32 initializedTicksCrossed, uint256 gasEstimate)",
];

export const V3_SWAP_TOPIC = "0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67";
export const V3_MINT_TOPIC = "0x7a53080ba414158be7ec69b987b5fb7d07dee101fe85488f0853ae16239d0bde";
export const V3_BURN_TOPIC = "0x0c396cd989a39f4459b5fa1aed6a9a8dcdbc45908acfd67e028cd568da98982c";

const Q96 = 2n ** 96n;

// 価格表を作るときの投入額(USD相当)。小さい側を細かく取る。
// 実際の裁定は$1〜$500の範囲に収まるため、この範囲を重点的に刻む。
// 取引上限は成功回数で $500 → $1,000 → $2,000 と上がるが、V3を含む経路の
// 投入額はここの最大点で頭打ちになる(routeMaxAmountIn)。$300のままでは
// 上限$2,000に一度も届かない。倍率はこれまでと同じ約3倍刻みを保つ
// (間隔を空けすぎると、点と点の間の補間が過大になる)。
// 流動性が足りないプールでは大きい額の見積もりが失敗するが、その点が
// 表から抜けるだけで、表はそのプールで通る最大額までになる。
export const QUOTE_SAMPLES_USD = [1, 3, 10, 30, 100, 300, 1000, 2000];

// プールごとの価格表。"chain::pool::zeroForOne" -> { points: [{in, out}], at }
const quoteTables = new Map();

export function decodeV3SwapData(dataHex) {
  const data = dataHex.startsWith("0x") ? dataHex.slice(2) : dataHex;
  if (data.length < 320) return null;
  try {
    const sqrtPriceX96 = BigInt("0x" + data.slice(128, 192));
    const liquidity = BigInt("0x" + data.slice(192, 256));
    if (sqrtPriceX96 <= 0n) return null;
    return { sqrtPriceX96, liquidity };
  } catch (e) {
    return null;
  }
}

/// ファクトリーからプールを1つ探す。
/// style が "algebra" の場合は手数料帯を取らない poolByPair を使う
/// (2026年9月17日の調査で、どちらが通るかを実物で確かめた)。
export async function findV3Pool(chain, factory, tokenA, tokenB, fee, style = "uniswap") {
  try {
    const address = await callWithRpc(chain, (p) => {
      const c = new ethers.Contract(factory, V3_FACTORY_ABI, p);
      return style === "algebra" ? c.poolByPair(tokenA, tokenB) : c.getPool(tokenA, tokenB, fee);
    });
    if (!address || address === ethers.ZeroAddress) return null;
    return address;
  } catch (e) {
    return null;
  }
}

/// 1プールの状態を読む(単発用)。複数まとめて読むときは
/// multicall-reserves.js の fetchV3StatesBatch を使う。
/// 注意: この関数は slot0() しか見ないため、Algebra形式のプールでは必ず
/// 失敗する。今は誰も呼んでいない。使う場合は multicall-reserves.js の
/// fetchV3StatesBatch(globalState に対応済み)を使うこと。
export async function readV3State(chain, poolAddress, priority = false) {
  try {
    const contract = (p) => new ethers.Contract(ethers.getAddress(poolAddress), V3_POOL_ABI, p);
    const [slot0, liquidity] = await Promise.all([
      callWithRpc(chain, (p) => contract(p).slot0(), priority),
      callWithRpc(chain, (p) => contract(p).liquidity(), priority),
    ]);
    if (slot0[0] <= 0n) return null;
    return { sqrtPriceX96: slot0[0], tick: Number(slot0[1]), liquidity };
  } catch (e) {
    return null;
  }
}

export function priceFromSqrtX96(sqrtPriceX96) {
  const ratio = Number(sqrtPriceX96) / Number(Q96);
  return ratio * ratio; // token1 / token0
}

/// 送信直前の正確な見積もり。Uniswap公式の QuoterV2 に計算させる。
export async function quoteV3Exact({ chain, tokenIn, tokenOut, amountIn, feeTier, priority = true }) {
  const quoter = QUOTER_V2_ADDRESS[chain];
  if (!quoter) return null;
  try {
    const result = await callWithRpc(chain, (p) =>
      new ethers.Contract(quoter, QUOTER_V2_ABI, p).quoteExactInputSingle.staticCall({
        tokenIn: ethers.getAddress(tokenIn),
        tokenOut: ethers.getAddress(tokenOut),
        amountIn,
        fee: feeTier,
        sqrtPriceLimitX96: 0,
      }), priority);
    const amountOut = result[0];
    return amountOut > 0n ? amountOut : null;
  } catch (e) {
    return null;
  }
}

function tableKey(chain, pool, zeroForOne) {
  return `${chain}::${pool.toLowerCase()}::${zeroForOne ? "0" : "1"}`;
}

/// 自前コントラクトを使う見積もりを有効にするチェーン。
/// コントラクトに quoteV3 を入れて再デプロイするまでは有効にしない
/// (未対応のコントラクトに投げても失敗するだけでRPCを捨てるため)。
/// 例: ENABLE_FORK_QUOTER=polygon,optimism
const FORK_QUOTER_CHAINS = new Set(
  (process.env.ENABLE_FORK_QUOTER || "").split(",").map((c) => c.trim().toLowerCase()).filter(Boolean)
);

export function isForkQuoterEnabled(chain) {
  return FORK_QUOTER_CHAINS.has((chain || "").toLowerCase());
}

/// 公式のQuoterで求まらなかった分を、自前コントラクトで埋める。
/// results は requests と同じ並びで、埋まっていない所だけを対象にする。
async function fillWithForkQuoter(chain, requests, results) {
  if (!isForkQuoterEnabled(chain)) return;
  const config = getAnyChainConfig(chain);
  const contractAddress = config && process.env[config.contractAddressEnvVar];
  if (!contractAddress) return;

  const pending = [];
  const indexes = [];
  for (let i = 0; i < requests.length; i++) {
    if (results[i] != null) continue;
    if (!requests[i].pool) continue;
    pending.push({ pool: requests[i].pool, tokenIn: requests[i].tokenIn, amountIn: requests[i].amountIn });
    indexes.push(i);
  }
  if (pending.length === 0) return;

  const outs = await quoteV3ByPoolBatch(chain, contractAddress, pending, false);
  for (let k = 0; k < indexes.length; k++) {
    if (outs[k] != null && outs[k] > 0n) results[indexes[k]] = outs[k];
  }
}

/// 複数プール・両方向の価格表をまとめて作る。
/// @param jobs [{ pool, zeroForOne, tokenIn, tokenOut, feeTier, amountsIn, fork }] の配列
/// 戻り値: 作れた表の数(点が1つ以上あるもの)
export async function buildQuoteTablesBatch(chain, jobs) {
  if (jobs.length === 0) return 0;
  const quoter = QUOTER_V2_ADDRESS[chain];

  const requests = [];
  const owners = [];
  for (let j = 0; j < jobs.length; j++) {
    for (const amountIn of jobs[j].amountsIn) {
      if (amountIn <= 0n) continue;
      requests.push({
        pool: jobs[j].pool,
        tokenIn: jobs[j].tokenIn, tokenOut: jobs[j].tokenOut,
        amountIn, feeTier: jobs[j].feeTier, fork: jobs[j].fork === true,
      });
      owners.push(j);
    }
  }
  if (requests.length === 0) return 0;

  // ① まず今までどおり公式のQuoterで求める。公式ファクトリーのプールは
  //    ここで全て揃うので、既存の動きは変わらない。
  //
  //    振り分けは「手数料帯の有無」ではなく「フォークかどうか」で行う。
  //    フォークにも手数料帯を持つもの(Uniswap形式のフォーク)があり、
  //    それを公式Quoterに投げると、公式側に同じペア・同じ手数料帯の
  //    プールがある場合に「別プールの価格」が返り、それをフォークの
  //    価格表として保存してしまうため。
  const useOfficial = (r) => r.fork !== true && r.feeTier != null;
  const outs = quoter
    ? await quoteV3Batch(chain, quoter, requests.filter(useOfficial), false)
    : [];
  // 公式に投げた分だけの配列なので、元の並びに戻す。
  const official = new Array(requests.length).fill(null);
  {
    let k = 0;
    for (let i = 0; i < requests.length; i++) {
      if (!useOfficial(requests[i])) continue;
      official[i] = outs[k++] ?? null;
    }
  }

  // ② 公式で求まらなかった分だけ、自前コントラクトで求め直す。
  //    フォークのプールと、手数料が動的なAlgebra系がここに来る。
  //    公式で足りている間は1件も投げないので、RPCは増えない。
  await fillWithForkQuoter(chain, requests, official);

  const pointsByJob = jobs.map(() => []);
  for (let i = 0; i < requests.length; i++) {
    const out = official[i];
    if (out == null || out <= 0n) continue;
    pointsByJob[owners[i]].push({ in: requests[i].amountIn, out });
  }

  let built = 0;
  const now = Date.now();
  for (let j = 0; j < jobs.length; j++) {
    const key = tableKey(chain, jobs[j].pool, jobs[j].zeroForOne);
    const points = pointsByJob[j].sort((a, b) => (a.in < b.in ? -1 : a.in > b.in ? 1 : 0));
    if (points.length === 0) {
      quoteTables.delete(key);
      continue;
    }
    quoteTables.set(key, { points, at: now });
    built++;
  }
  return built;
}

/// 1プール1方向の価格表を作る(単発用。まとめて作るときは buildQuoteTablesBatch)。
export async function buildQuoteTable({ chain, pool, zeroForOne, tokenIn, tokenOut, feeTier, amountsIn, fork = false }) {
  const built = await buildQuoteTablesBatch(chain, [{ pool, zeroForOne, tokenIn, tokenOut, feeTier, amountsIn, fork }]);
  if (built === 0) return 0;
  const t = quoteTables.get(tableKey(chain, pool, zeroForOne));
  return t ? t.points.length : 0;
}

export function hasQuoteTable(chain, pool, zeroForOne) {
  return quoteTables.has(tableKey(chain, pool, zeroForOne));
}

export function getQuoteTableAge(chain, pool, zeroForOne) {
  const t = quoteTables.get(tableKey(chain, pool, zeroForOne));
  return t ? Date.now() - t.at : null;
}

export function countQuoteTables() {
  return quoteTables.size;
}

export function clearQuoteTable(chain, pool) {
  quoteTables.delete(tableKey(chain, pool, true));
  quoteTables.delete(tableKey(chain, pool, false));
}

/// 価格表から受取量を求める。表に無い投入額は、最も近い2点から補間する。
/// 表の範囲外(最大点より大きい)は判定に使わない(過大評価を避けるため)。
export function quoteFromTable({ chain, pool, zeroForOne, amountIn }) {
  const t = quoteTables.get(tableKey(chain, pool, zeroForOne));
  if (!t || t.points.length === 0 || amountIn <= 0n) return 0n;
  const pts = t.points;

  // 最小点より小さい場合は、最小点の比率をそのまま使う(V3は小額なら線形)。
  if (amountIn <= pts[0].in) {
    return (pts[0].out * amountIn) / pts[0].in;
  }
  const last = pts[pts.length - 1];
  if (amountIn > last.in) return 0n;

  for (let i = 1; i < pts.length; i++) {
    if (amountIn > pts[i].in) continue;
    const lo = pts[i - 1], hi = pts[i];
    const span = hi.in - lo.in;
    if (span <= 0n) return lo.out;
    const ratio = amountIn - lo.in;
    return lo.out + ((hi.out - lo.out) * ratio) / span;
  }
  return 0n;
}

/// 価格表に載っている投入額の範囲(判定に使える範囲)。
export function getTableRange(chain, pool, zeroForOne) {
  const t = quoteTables.get(tableKey(chain, pool, zeroForOne));
  if (!t || t.points.length === 0) return null;
  return { min: t.points[0].in, max: t.points[t.points.length - 1].in };
}

/// 保存用に、いま持っている価格表を書き出す。
/// BigInt はJSONにできないので文字列にする。
export function exportQuoteTables() {
  const out = [];
  for (const [key, t] of quoteTables.entries()) {
    if (!t || !t.points || t.points.length === 0) continue;
    out.push({
      key, at: t.at,
      points: t.points.map((pt) => ({ in: pt.in.toString(), out: pt.out.toString() })),
    });
  }
  return out;
}

/// 保存しておいた価格表を1本戻す。
/// **古さと「プールが動いていないか」の確認は呼び出し側の責任**。
/// ここは形の検査だけを行う。
export function importQuoteTable(key, points, at) {
  if (typeof key !== "string" || !Array.isArray(points) || points.length === 0) return false;
  try {
    const parsed = points
      .map((pt) => ({ in: BigInt(pt.in), out: BigInt(pt.out) }))
      .filter((pt) => pt.in > 0n && pt.out > 0n)
      .sort((a, b) => (a.in < b.in ? -1 : a.in > b.in ? 1 : 0));
    if (parsed.length === 0) return false;
    quoteTables.set(key, { points: parsed, at: typeof at === "number" ? at : Date.now() });
    return true;
  } catch (e) {
    return false;
  }
}

/// 価格表と公式Quoterの一致を確かめる(表の中間の値で検証する)。
export async function verifyQuoteTable({ chain, pool, zeroForOne, tokenIn, tokenOut, feeTier, amountIn }) {
  const estimated = quoteFromTable({ chain, pool, zeroForOne, amountIn });
  if (estimated <= 0n) return null;
  const exact = await quoteV3Exact({ chain, tokenIn, tokenOut, amountIn, feeTier, priority: false });
  if (!exact || exact <= 0n) return null;
  const diffPercent = (Number(estimated - exact) / Number(exact)) * 100;
  return { estimated, exact, diffPercent };
}

export function feeTierToBps(feeTier) {
  return Math.round(Number(feeTier) / 100);
}
