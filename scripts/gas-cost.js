// scripts/gas-cost.js
//
// ガス代を固定値ではなく、チェーンの現在のガス価格から実測する。
//
// [修正] ガス使用量を90万で見積もっていたが、これはコントラクトの
// デプロイ時の値。実際の裁定実行(フラッシュローン+2〜3回のプール直接
// スワップ)は35〜50万程度で、ガス代を2.5倍過大に引いていた。
// 事前判定には経路の段数に応じた概算を使い、送信直前には実際の
// estimateGas の結果を使う(gasUnitsToUsd)。
//
// [単価の修正(2026年9月17日)]
// 単価に feeData.maxFeePerGas を使っていたが、これは ethers が
//   maxFeePerGas = baseFeePerGas × 2 + maxPriorityFeePerGas
// で作る「上限」であり、実際に払う額ではない(ethers v6.17.0 の
// abstract-provider.js で確認)。実際に払うのは baseFee + priority。
// 過大の幅は baseFee と priority の比で変わり、priority が小さいほど
// 2倍に近づく(Polygonの priority が高い状況では約1.45倍だった)。
// 上限は送信時に取り消されないために要るが、利益の判定に使うと
// 本物の機会を赤字と誤判定する。
// ここではブロックの baseFeePerGas を直接読み、priority を足した
// 「実際に払う見込みの単価」を返す。
//
// [ガス使用量の修正(2026年9月17日)]
// 2段の概算を35万としていたが、本番の実測は256,409〜272,246だった
// (2026年9月17日の成功4件)。実測が貯まればその平均を使い、
// 無ければ実測に近い既定値を使う。

import { ethers } from "ethers";
import { callWithRpc } from "./onchain-reserves.js";
import { getAverageGasUnits } from "./real-execution-log.js";

// 事前判定用の概算ガス使用量。送信直前は estimateGas の実測値で上書きする。
// 2段は本番の実測(256k〜272k)に少しだけ余裕を足した値。
// 3段は2段の実測比で見積もった値(3段の成功例がまだ無いため)。
export const ESTIMATED_GAS_UNITS = { "2step": 285_000n, "3step": 390_000n };

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

/// 実際に払う見込みのガス単価(wei)。上限(maxFeePerGas)ではない。
/// EIP-1559のチェーンでは baseFeePerGas + maxPriorityFeePerGas を払う。
async function getGasPriceWei(chain) {
  const cached = gasPriceCache.get(chain);
  if (cached && Date.now() - cached.at < GAS_PRICE_CACHE_MS) return cached.value;
  try {
    const [feeData, block] = await Promise.all([
      callWithRpc(chain, (p) => p.getFeeData()),
      callWithRpc(chain, (p) => p.getBlock("latest")),
    ]);
    const price = effectiveGasPrice(feeData, block);
    if (price && price > 0n) {
      gasPriceCache.set(chain, { value: price, at: Date.now() });
      return price;
    }
  } catch (e) {}
  // 取得に失敗しても、前回の値があればそれを使う(判定を止めないため)。
  return cached?.value ?? null;
}

/// 手に入った情報から、実際に払う見込みの単価を求める。
/// 上から順に、より確かな方法を試す。
function effectiveGasPrice(feeData, block) {
  const priority = feeData?.maxPriorityFeePerGas ?? 0n;
  // ① ブロックの baseFeePerGas が読めた場合(最も確か)
  if (block?.baseFeePerGas != null && block.baseFeePerGas > 0n) {
    return block.baseFeePerGas + priority;
  }
  // ② maxFeePerGas から baseFee を逆算する
  //    maxFeePerGas = baseFee × 2 + priority なので baseFee = (maxFee - priority) / 2
  if (feeData?.maxFeePerGas != null && feeData.maxFeePerGas > priority) {
    return (feeData.maxFeePerGas + priority) / 2n;
  }
  // ③ EIP-1559でないチェーン
  return feeData?.gasPrice ?? null;
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

/// 実際に払った額(wei)をUSDに換算する。確定後の純利益の計算に使う。
/// 単価は receipt の実効単価が既に掛かっているので、ここでは換算だけ行う。
export async function weiToUsd(chain, wei) {
  const nativePriceUsd = await getNativePriceUsd((chain || "").toLowerCase());
  if (!nativePriceUsd) return null;
  return parseFloat(ethers.formatEther(BigInt(wei))) * nativePriceUsd;
}

/// 指定したガス使用量をUSDに換算する。送信直前の estimateGas 結果に使う。
export async function gasUnitsToUsd(chain, gasUnits) {
  const key = (chain || "").toLowerCase();
  const [gasPriceWei, nativePriceUsd] = await Promise.all([getGasPriceWei(key), getNativePriceUsd(key)]);
  if (!gasPriceWei || !nativePriceUsd) return null;
  const costNative = parseFloat(ethers.formatEther(BigInt(gasUnits) * gasPriceWei));
  return costNative * nativePriceUsd;
}

/// 事前判定に使うガス使用量。実測が貯まっていればその平均を使う。
/// 実測は「そのチェーン・その段数で実際に使われた量」なので、
/// 想定値より確かで、チェーンごとの差も自動的に反映される。
export function gasUnitsFor(chain, kind = "2step") {
  const measured = getAverageGasUnits(chain, kind);
  if (measured && measured > 0n) return measured;
  return ESTIMATED_GAS_UNITS[kind] ?? ESTIMATED_GAS_UNITS["2step"];
}

/// 事前判定用の概算ガス代(USD)。kind は "2step" / "3step"。
export async function estimateGasCostUsd(chain, kind = "2step") {
  const key = (chain || "").toLowerCase();
  const usd = await gasUnitsToUsd(key, gasUnitsFor(key, kind));
  return usd ?? (FALLBACK_GAS_COST_USD[key] ?? 0.02);
}

/// ダッシュボード表示用。
export function getGasCostStatus() {
  const out = {};
  for (const chain of Object.keys(NATIVE_TOKEN_FOR_PRICE)) {
    const gp = gasPriceCache.get(chain), np = nativePriceCache.get(chain);
    if (!gp || !np) continue;
    const costNative = parseFloat(ethers.formatEther(gasUnitsFor(chain, "2step") * gp.value));
    out[chain] = {
      gwei: parseFloat(ethers.formatUnits(gp.value, "gwei")).toFixed(3),
      nativeUsd: np.value.toFixed(2),
      costUsd: (costNative * np.value).toFixed(4),
    };
  }
  return out;
}
