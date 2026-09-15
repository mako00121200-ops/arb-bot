// scripts/v3-pools.js
//
// Uniswap V3形式(集中流動性)のプールを扱う。
//
// [V2との違い]
// V2は「準備量が2つ」だけで価格が決まるが、V3は価格帯ごとに流動性が分かれて
// おり、正確な受取量の計算にはティック構造をたどる必要がある。自前で実装すると
// 間違いが起きやすいので、見積もりはUniswap公式の QuoterV2 コントラクトに
// 任せる(送信直前の1回だけ呼ぶ)。
//
// [大まかな価格の把握]
// 常時の判定にQuoterを呼ぶとRPCが持たないため、slot0(現在価格)と liquidity
// (現在の価格帯の流動性)をメモリに持ち、まず概算で絞り込む。
// 概算で有望なものだけ、Quoterで正確に確認する。
//
// [対応する形式]
// Uniswap V3 / PancakeSwap V3 / Aerodrome Slipstream は同じ関数構成。
// Algebra(QuickSwap V3等)は slot0 の名前が globalState なので別途対応する。

import { ethers } from "ethers";
import { callWithRpc } from "./onchain-reserves.js";

// QuoterV2 は「実際にスワップを試して結果だけ返す」コントラクト。
// 状態を変えないので eth_call で安全に呼べる。
export const QUOTER_V2_ADDRESS = {
  polygon: "0x61fFE014bA17989E743c5F6cB21bF9697530B21e",
  base: "0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a",
  arbitrum: "0x61fFE014bA17989E743c5F6cB21bF9697530B21e",
  optimism: "0x61fFE014bA17989E743c5F6cB21bF9697530B21e",
  avalanche: "0xbe0F5544EC67e9B3b2D979aaA43f18Fd87E6257F",
};

// V3ファクトリー(手数料ごとにプールが分かれる)。
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

// V3で一般的な手数料区分(100=0.01%, 500=0.05%, 3000=0.3%, 10000=1%)。
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

// Uniswap V3のSwapイベント。V2のSyncに相当する「価格が動いた」合図。
// keccak256("Swap(address,address,int256,int256,uint160,uint128,int24)")
export const V3_SWAP_TOPIC = "0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67";

const Q96 = 2n ** 96n;

/// Swapイベントのデータから、更新後の価格・流動性・ティックを取り出す。
/// データは (int256 amount0, int256 amount1, uint160 sqrtPriceX96,
///           uint128 liquidity, int24 tick) の順で詰まっている。
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

/// 指定したトークン組・手数料区分のV3プールアドレスを問い合わせる。
/// 存在しなければゼロアドレスが返るので、それは除く。
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

/// V3プールの現在の状態(価格・流動性)を読む。
export async function readV3State(chain, poolAddress, priority = false) {
  try {
    const contract = (p) => new ethers.Contract(ethers.getAddress(poolAddress), V3_POOL_ABI, p);
    const slot0 = await callWithRpc(chain, (p) => contract(p).slot0(), priority);
    const liquidity = await callWithRpc(chain, (p) => contract(p).liquidity(), priority);
    if (slot0[0] <= 0n) return null;
    return { sqrtPriceX96: slot0[0], tick: Number(slot0[1]), liquidity };
  } catch (e) {
    return null;
  }
}

/// 現在価格での「1単位あたりの交換比率」を求める(概算用)。
/// sqrtPriceX96 は token1/token0 の平方根を 2^96 倍した値。
export function priceFromSqrtX96(sqrtPriceX96) {
  const ratio = Number(sqrtPriceX96) / Number(Q96);
  return ratio * ratio; // token1 / token0
}

/// 集中流動性の近似式で受取量を概算する。
/// 価格帯をまたがない範囲でのみ正確。あくまで絞り込み用で、
/// 送信前には必ず quoteExactInput で確認する。
export function estimateV3AmountOut({ amountIn, sqrtPriceX96, liquidity, feeBps, zeroForOne }) {
  if (amountIn <= 0n || liquidity <= 0n || sqrtPriceX96 <= 0n) return 0n;
  const amountInAfterFee = (amountIn * (10000n - BigInt(feeBps))) / 10000n;
  if (amountInAfterFee <= 0n) return 0n;

  try {
    if (zeroForOne) {
      // token0 を入れて token1 を受け取る。価格は下がる方向。
      const numerator = liquidity * Q96;
      const denominator = liquidity * Q96 / sqrtPriceX96 + amountInAfterFee;
      if (denominator <= 0n) return 0n;
      const sqrtPriceAfter = numerator / denominator;
      if (sqrtPriceAfter <= 0n || sqrtPriceAfter >= sqrtPriceX96) return 0n;
      return (liquidity * (sqrtPriceX96 - sqrtPriceAfter)) / Q96;
    } else {
      // token1 を入れて token0 を受け取る。価格は上がる方向。
      const sqrtPriceAfter = sqrtPriceX96 + (amountInAfterFee * Q96) / liquidity;
      if (sqrtPriceAfter <= sqrtPriceX96) return 0n;
      const numerator = liquidity * Q96 * (sqrtPriceAfter - sqrtPriceX96);
      const denominator = sqrtPriceAfter * sqrtPriceX96;
      if (denominator <= 0n) return 0n;
      return numerator / denominator;
    }
  } catch (e) {
    return 0n;
  }
}

/// 送信直前の正確な見積もり。Uniswap公式の QuoterV2 に実際の計算をさせる。
/// 状態を変えないので eth_call(staticCall)で呼べる。
export async function quoteV3Exact({ chain, tokenIn, tokenOut, amountIn, feeTier }) {
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
      }), true);
    const amountOut = result[0];
    return amountOut > 0n ? amountOut : null;
  } catch (e) {
    return null;
  }
}

/// V3の手数料区分(100/500/3000/10000)をbpsに直す。
/// 区分の単位は「100万分率」なので、100で割るとbpsになる。
export function feeTierToBps(feeTier) {
  return Math.round(Number(feeTier) / 100);
}
