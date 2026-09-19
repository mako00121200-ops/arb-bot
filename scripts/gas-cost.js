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

// [キャッシュを短くした(2026年9月17日)]
// 60秒にしていたが、実測すると見積もり$0.0114に対し実際は$0.0079で、
// ガス使用量はほぼ的中(285,000 対 285,579)だったのに単価が1.44倍だった。
// Polygonの baseFee は数十秒で大きく動くため、キャッシュの古さがそのまま
// 過大な見積もりになり、薄い機会を取り逃がす。RPCの消費は増えるが、
// 月2,000万の枠に対して9倍の余力があるので問題にならない。
const GAS_PRICE_CACHE_MS = parseInt(process.env.GAS_PRICE_CACHE_MS || "15000", 10);
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

// ===== 単価の補正(2026年9月19日) =====
//
// [なぜ要るか]
// 実測すると、事前の見積もりが実際に払った額より一貫して高かった。
//   見積もり$0.0107 / 実際$0.0074、$0.0139 / $0.0090、$0.0125 / $0.0082
// ガス使用量はほぼ的中しているので、ずれているのは**単価**。
// baseFeePerGas + maxPriorityFeePerGas は「送信時にこれだけ出す用意がある」
// 額で、実際にブロックに入る時の実効単価はそれより低いことが多い。
//
// 過大な単価はそのままハードルの高さになり、本物の機会を赤字と判定する。
// そこで receipt の実効単価と見積もりの比を覚えて、次から掛ける。
//
// [安全のための歯止め]
// 比は 0.7〜1.0 に収める。**見積もりを実際より低くする方向には振らない**
// (1.0を超えない)し、7割より下げもしない。ガスが急に上がった場面で
// 過小評価して赤字を出さないため。
const GAS_PRICE_RATIO_MIN = 0.7;
const GAS_PRICE_RATIO_SAMPLES = 8;
const gasPriceRatio = new Map(); // chain -> { ratio, samples }

/// 送信後に、見積もりの単価と実際の実効単価を突き合わせて学習する。
export function recordActualGasPrice(chain, estimatedWei, actualWei) {
  const key = (chain || "").toLowerCase();
  if (!estimatedWei || !actualWei || estimatedWei <= 0n || actualWei <= 0n) return null;
  let observed = Number(actualWei) / Number(estimatedWei);
  if (!isFinite(observed) || observed <= 0) return null;
  if (observed > 1) observed = 1;               // 高い側へは振らない
  if (observed < GAS_PRICE_RATIO_MIN) observed = GAS_PRICE_RATIO_MIN;

  const prev = gasPriceRatio.get(key);
  // 少ない実測で大きく動かさないよう、件数で重みを付けた平均にする。
  const n = Math.min((prev?.samples ?? 0) + 1, GAS_PRICE_RATIO_SAMPLES);
  const ratio = prev ? prev.ratio + (observed - prev.ratio) / n : observed;
  gasPriceRatio.set(key, { ratio, samples: n });
  return { ratio, samples: n, observed };
}

export function getGasPriceRatio(chain) {
  return gasPriceRatio.get((chain || "").toLowerCase())?.ratio ?? 1;
}

/// 事前判定に使う単価。実測から学んだ比を掛けたもの。
export async function getEstimatedGasPriceWei(chain) {
  const key = (chain || "").toLowerCase();
  const raw = await getGasPriceWei(key);
  if (!raw) return null;
  const ratio = getGasPriceRatio(key);
  if (ratio >= 1) return raw;
  const adjusted = (raw * BigInt(Math.round(ratio * 10000))) / 10000n;
  return adjusted > 0n ? adjusted : raw;
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
  const [gasPriceWei, nativePriceUsd] = await Promise.all([getEstimatedGasPriceWei(key), getNativePriceUsd(key)]);
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
    const ratio = getGasPriceRatio(chain);
    const adjusted = ratio >= 1 ? gp.value : (gp.value * BigInt(Math.round(ratio * 10000))) / 10000n;
    const costNative = parseFloat(ethers.formatEther(gasUnitsFor(chain, "2step") * adjusted));
    out[chain] = {
      gwei: parseFloat(ethers.formatUnits(adjusted, "gwei")).toFixed(3),
      nativeUsd: np.value.toFixed(2),
      costUsd: (costNative * np.value).toFixed(4),
      priceRatio: ratio.toFixed(3),
    };
  }
  return out;
}
