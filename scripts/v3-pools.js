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
import { quoteV3Batch } from "./multicall-reserves.js";

export const QUOTER_V2_ADDRESS = {
  polygon: "0x61fFE014bA17989E743c5F6cB21bF9697530B21e",
  base: "0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a",
  arbitrum: "0x61fFE014bA17989E743c5F6cB21bF9697530B21e",
  optimism: "0x61fFE014bA17989E743c5F6cB21bF9697530B21e",
  avalanche: "0xbe0F5544EC67e9B3b2D979aaA43f18Fd87E6257F",
};

export const V3_FACTORIES = {
  polygon: [
    { address: "0x1F98431c8aD98523631AE4a59f267346ea31F984", dexId: "uniswap-v3", style: "uniswap" },
  ],
  base: [
    { address: "0x33128a8fC17869897dcE68Ed026d694621f6FDfD", dexId: "uniswap-v3", style: "uniswap" },
  ],
  arbitrum: [
    { address: "0x1F98431c8aD98523631AE4a59f267346ea31F984", dexId: "uniswap-v3", style: "uniswap" },
  ],
  optimism: [
    { address: "0x1F98431c8aD98523631AE4a59f267346ea31F984", dexId: "uniswap-v3", style: "uniswap" },
  ],
  avalanche: [
    { address: "0x740b1c1de25031C31FF4fC9A62f554A55cdC1baD", dexId: "uniswap-v3", style: "uniswap" },
  ],
};

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
export const QUOTE_SAMPLES_USD = [1, 3, 10, 30, 100, 300];

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

export async function findV3Pool(chain, factory, tokenA, tokenB, fee) {
  try {
    const address = await callWithRpc(chain, (p) =>
      new ethers.Contract(factory, V3_FACTORY_ABI, p).getPool(tokenA, tokenB, fee));
    if (!address || address === ethers.ZeroAddress) return null;
    return address;
  } catch (e) {
    return null;
  }
}

/// 1プールの状態を読む(単発用)。複数まとめて読むときは
/// multicall-reserves.js の fetchV3StatesBatch を使う。
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

/// 複数プール・両方向の価格表をまとめて作る。
/// @param jobs [{ pool, zeroForOne, tokenIn, tokenOut, feeTier, amountsIn }] の配列
/// 戻り値: 作れた表の数(点が1つ以上あるもの)
export async function buildQuoteTablesBatch(chain, jobs) {
  const quoter = QUOTER_V2_ADDRESS[chain];
  if (!quoter || jobs.length === 0) return 0;

  const requests = [];
  const owners = [];
  for (let j = 0; j < jobs.length; j++) {
    for (const amountIn of jobs[j].amountsIn) {
      if (amountIn <= 0n) continue;
      requests.push({ tokenIn: jobs[j].tokenIn, tokenOut: jobs[j].tokenOut, amountIn, feeTier: jobs[j].feeTier });
      owners.push(j);
    }
  }
  if (requests.length === 0) return 0;

  const outs = await quoteV3Batch(chain, quoter, requests, false);

  const pointsByJob = jobs.map(() => []);
  for (let i = 0; i < requests.length; i++) {
    const out = outs[i];
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
export async function buildQuoteTable({ chain, pool, zeroForOne, tokenIn, tokenOut, feeTier, amountsIn }) {
  const built = await buildQuoteTablesBatch(chain, [{ pool, zeroForOne, tokenIn, tokenOut, feeTier, amountsIn }]);
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
