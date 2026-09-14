// scripts/gas-cost.js
//
// ガス代を固定値ではなく、チェーンの現在のガス価格から実測する。
//
// [修正] ガス使用量を90万で見積もっていたが、これはコントラクトの
// デプロイ時の値。実際の裁定実行(フラッシュローン+2〜3回のプール直接
// スワップ)は35〜50万程度で、ガス代を2.5倍過大に引いていた。
// 事前判定には経路の段数に応じた概算を使い、送信直前には実際の
// estimateGas の結果を使う(gasUnitsToUsd)。

import { ethers } from "ethers";
import { callWithRpc } from "./onchain-reserves.js";

// 事前判定用の概算ガス使用量。送信直前は estimateGas の実測値で上書きする。
export const ESTIMATED_GAS_UNITS = { "2step": 350_000n, "3step": 480_000n };

const GAS_PRICE_CACHE_MS = 60 * 1000;
const NATIVE_PRICE_CACHE_MS = 10 * 60 * 1000;

// 各チェーンのネイティブトークン(ガス代の支払い通貨)の価格を調べる先。
const NATIVE_TOKEN_FOR_PRICE = {
  base: "0x4200000000000000000000000000000000000006",      // WETH
  optimism: "0x4200000000000000000000000000000000000006",  // WETH
  polygon: "0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270",   // WMATIC(POL)
  avalanche: "0xB31f66AA3C1e785363F0875A1B74E27b85FD66c7", // WAVAX
  arbitrum: "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1",  // WETH
};

// 取得に失敗した時の保守的な既定値(35万ガス換算)。
const FALLBACK_GAS_COST_USD = { base: 0.010, polygon: 0.012, optimism: 0.005, avalanche: 0.001, arbitrum: 0.015 };

const gasPriceCache = new Map();
const nativePriceCache = new Map();

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
  } catch (e) {}
  // 取得に失敗しても、前回の値があればそれを使う(判定を止めないため)。
  return cached?.value ?? null;
}

async function getNativePriceUsd(chain) {
  const cached = nativePriceCache.get(chain);
  if (cached && Date.now() - cached.at < NATIVE_PRICE_CACHE_MS) return cached.value;
  const token = NATIVE_TOKEN_FOR_PRICE[chain];
  if (!token) return null;
  try {
    const res = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${token}`);
    if (res.ok) {
      const json = await res.json();
      const pairs = (json.pairs || []).filter((p) => (p.chainId || "").toLowerCase() === chain);
      pairs.sort((a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0));
      const price = parseFloat(pairs[0]?.priceUsd);
      if (isFinite(price) && price > 0) {
        nativePriceCache.set(chain, { value: price, at: Date.now() });
        return price;
      }
    }
  } catch (e) {}
  return cached?.value ?? null;
}

/// 指定したガス使用量をUSDに換算する。送信直前の estimateGas 結果に使う。
export async function gasUnitsToUsd(chain, gasUnits) {
  const key = (chain || "").toLowerCase();
  const [gasPriceWei, nativePriceUsd] = await Promise.all([getGasPriceWei(key), getNativePriceUsd(key)]);
  if (!gasPriceWei || !nativePriceUsd) return null;
  const costNative = parseFloat(ethers.formatEther(BigInt(gasUnits) * gasPriceWei));
  return costNative * nativePriceUsd;
}

/// 事前判定用の概算ガス代(USD)。kind は "2step" / "3step"。
export async function estimateGasCostUsd(chain, kind = "2step") {
  const key = (chain || "").toLowerCase();
  const units = ESTIMATED_GAS_UNITS[kind] ?? ESTIMATED_GAS_UNITS["2step"];
  const usd = await gasUnitsToUsd(key, units);
  return usd ?? (FALLBACK_GAS_COST_USD[key] ?? 0.02);
}

/// ダッシュボード表示用。
export function getGasCostStatus() {
  const out = {};
  for (const chain of Object.keys(NATIVE_TOKEN_FOR_PRICE)) {
    const gp = gasPriceCache.get(chain), np = nativePriceCache.get(chain);
    if (!gp || !np) continue;
    const costNative = parseFloat(ethers.formatEther(ESTIMATED_GAS_UNITS["2step"] * gp.value));
    out[chain] = {
      gwei: parseFloat(ethers.formatUnits(gp.value, "gwei")).toFixed(3),
      nativeUsd: np.value.toFixed(2),
      costUsd: (costNative * np.value).toFixed(4),
    };
  }
  return out;
}
