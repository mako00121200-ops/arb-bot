// scripts/gas-cost.js
//
// ガス代を固定値ではなく、チェーンの現在のガス価格から実測する。
//
// [なぜ必要か] 以前は一律$0.05で見積もっていたが、Polygonの実際は
// $0.005程度で、10倍の過大見積もりだった。中小プール狙いに転換して
// 1回の利益が$0.1〜$2が中心になると、この誤差が黒字案件を軒並み
// 赤字判定にしてしまう(観測画面の「-$0.05」がほぼ全てこれだった)。
//
// 計算式: ガス使用量 × ガス価格 × ネイティブトークンのUSD価格
//   ガス使用量は、フラッシュローン+2回スワップの実測値(約90万)を使う。
//   ガス価格はチェーンから取得し、1分間キャッシュする。
//   ネイティブトークンのUSD価格はDexScreenerから取得し、10分間キャッシュする。

import { ethers } from "ethers";
import { callWithRpc } from "./onchain-reserves.js";

// Base mainnetへのデプロイ実測値(896,304)に余裕を持たせた値。
const ESTIMATED_GAS_UNITS = 900_000n;

const GAS_PRICE_CACHE_MS = 60 * 1000;
const NATIVE_PRICE_CACHE_MS = 10 * 60 * 1000;

// 各チェーンのネイティブトークンの価格を調べるための代表プール
// (DexScreenerのトークンアドレス)。
const NATIVE_TOKEN_FOR_PRICE = {
  base: "0x4200000000000000000000000000000000000006",      // WETH on Base
  optimism: "0x4200000000000000000000000000000000000006",  // WETH on Optimism
  polygon: "0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270",   // WMATIC
  avalanche: "0xB31f66AA3C1e785363F0875A1B74E27b85FD66c7", // WAVAX
  arbitrum: "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1",  // WETH on Arbitrum
};

// 取得に失敗した時に使う保守的な既定値(USD)。
const FALLBACK_GAS_COST_USD = {
  base: 0.01, polygon: 0.01, optimism: 0.01, avalanche: 0.03, arbitrum: 0.03,
};

const gasPriceCache = new Map();   // chain -> { value: bigint, at: number }
const nativePriceCache = new Map(); // chain -> { value: number, at: number }

async function getGasPriceWei(chain) {
  const cached = gasPriceCache.get(chain);
  if (cached && Date.now() - cached.at < GAS_PRICE_CACHE_MS) return cached.value;
  try {
    const feeData = await callWithRpc(chain, (p) => p.getFeeData());
    const price = feeData.maxFeePerGas ?? feeData.gasPrice;
    if (price && price > 0n) {
      gasPriceCache.set(chain, { value: price, at: Date.now() });
      return price;
    }
  } catch (e) { /* 取得失敗時は既定値へ */ }
  return null;
}

async function getNativePriceUsd(chain) {
  const cached = nativePriceCache.get(chain);
  if (cached && Date.now() - cached.at < NATIVE_PRICE_CACHE_MS) return cached.value;

  const token = NATIVE_TOKEN_FOR_PRICE[chain];
  if (!token) return null;
  try {
    const res = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${token}`);
    if (!res.ok) return null;
    const json = await res.json();
    const pairs = (json.pairs || []).filter((p) => (p.chainId || "").toLowerCase() === chain);
    // 流動性が最も大きいプールの価格を採用する(最も信頼できるため)。
    pairs.sort((a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0));
    const price = parseFloat(pairs[0]?.priceUsd);
    if (isFinite(price) && price > 0) {
      nativePriceCache.set(chain, { value: price, at: Date.now() });
      return price;
    }
  } catch (e) { /* 取得失敗時は既定値へ */ }
  return null;
}

/// このチェーンで1回のアービトラージ実行にかかるガス代(USD)を実測する。
export async function estimateGasCostUsd(chain) {
  const key = (chain || "").toLowerCase();
  const [gasPriceWei, nativePriceUsd] = await Promise.all([getGasPriceWei(key), getNativePriceUsd(key)]);

  if (!gasPriceWei || !nativePriceUsd) {
    return FALLBACK_GAS_COST_USD[key] ?? 0.05;
  }
  const gasCostNative = parseFloat(ethers.formatEther(ESTIMATED_GAS_UNITS * gasPriceWei));
  return gasCostNative * nativePriceUsd;
}

/// ダッシュボード表示用。
export function getGasCostStatus() {
  const out = {};
  for (const chain of Object.keys(NATIVE_TOKEN_FOR_PRICE)) {
    const gp = gasPriceCache.get(chain), np = nativePriceCache.get(chain);
    if (!gp || !np) continue;
    const costNative = parseFloat(ethers.formatEther(ESTIMATED_GAS_UNITS * gp.value));
    out[chain] = {
      gwei: parseFloat(ethers.formatUnits(gp.value, "gwei")).toFixed(3),
      nativeUsd: np.value.toFixed(2),
      costUsd: (costNative * np.value).toFixed(4),
    };
  }
  return out;
}
