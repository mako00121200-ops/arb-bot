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
import { getAnyChainConfig } from "../chain-config.js";

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

// ===== OP Stack の L1 データ手数料(2026年9月20日) =====
//
// [なぜ要るか]
// Optimism / Base(OP Stack)は、L2 の実行費(gasUsed × 単価)とは別に、取引の
// データを L1 に書く費用を取引ごとに取る。receipt の l1Fee に出るが、ethers の
// receipt.gasUsed × receipt.gasPrice には入らない。bot はこれを数えておらず、
// Optimism の費用を実態より低く見積もっていた。L2 の実行費は極小なので、
// L1 側が費用の大半になり得る。
//
// [求め方]
// 予備コントラクト GasPriceOracle(0x4200…000F)の getL1Fee(取引のバイト列)に
// 聞く。送信直前は実際の呼び出しデータで作った取引(署名は仮)で聞き、
// 事前判定には代表的な大きさ(2段 420バイト)の取引で聞いた値を5分だけ覚えて
// 使う。確定後は receipt の l1Fee を読んで費用に足し、代表値の学習にも使う。
const OP_STACK_CHAINS = new Set(["optimism", "base"]);
const GAS_PRICE_ORACLE = "0x420000000000000000000000000000000000000F";
const ORACLE_IFACE = new ethers.Interface(["function getL1Fee(bytes data) view returns (uint256)"]);
const L1_FEE_CACHE_MS = 5 * 60 * 1000;
const L1_FEE_SAMPLES = 8;
const l1FeeTypical = new Map();  // chain -> { value(wei), at, source }
const l1FeeMeasured = new Map(); // chain -> { value(wei), samples }

export function isOpStackChain(chain) {
  return OP_STACK_CHAINS.has((chain || "").toLowerCase());
}

/// 呼び出しデータから「送る取引のバイト列」を作る。署名は仮(長さだけ合わせる)。
/// L1 データ手数料は長さと圧縮のしやすさで決まるので、中身の正確さは要らない。
function buildProbeTx(chainId, to, data, gasLimit) {
  const tx = ethers.Transaction.from({
    type: 2, chainId, to, data, value: 0n, nonce: 1,
    gasLimit: BigInt(gasLimit || 300_000n),
    maxFeePerGas: 1_000_000_000n, maxPriorityFeePerGas: 1_000_000n,
  });
  // s は曲線の半分より小さい値でないと ethers が拒否する(仮なので小さい値でよい)。
  tx.signature = ethers.Signature.from({ r: "0x" + "ab".repeat(32), s: "0x" + "12".repeat(32), v: 27 });
  return tx.serialized;
}

/// 代表的な2段の呼び出しデータ(420バイト)。住所とゼロが混ざる実物に近い形。
const REPRESENTATIVE_CALLDATA = "0x" + Array.from({ length: 13 }, (_, i) =>
  (i % 3 === 0 ? "5a".repeat(20) + "00".repeat(12) : "00".repeat(28) + "12".repeat(4))).join("") + "1234";

/// 実際の呼び出しデータで L1 データ手数料(wei)を聞く。OP Stack 以外は 0。
export async function estimateL1FeeWei(chain, to, data, gasLimit) {
  const key = (chain || "").toLowerCase();
  if (!isOpStackChain(key)) return 0n;
  const chainId = getAnyChainConfig(key)?.chainId;
  if (!chainId) return 0n;
  const raw = buildProbeTx(chainId, to, data, gasLimit);
  const ret = await callWithRpc(key, (p) => p.call({ to: GAS_PRICE_ORACLE, data: ORACLE_IFACE.encodeFunctionData("getL1Fee", [raw]) }), true);
  return ORACLE_IFACE.decodeFunctionResult("getL1Fee", ret)[0];
}

/// 事前判定用の L1 データ手数料(wei)。実測があればその平均、無ければ代表的な
/// 取引で予備コントラクトに聞いた値。5分だけ覚える。OP Stack 以外は 0。
export async function getTypicalL1FeeWei(chain) {
  const key = (chain || "").toLowerCase();
  if (!isOpStackChain(key)) return 0n;
  const measured = l1FeeMeasured.get(key);
  if (measured && measured.samples >= 1) return measured.value;
  const cached = l1FeeTypical.get(key);
  if (cached && Date.now() - cached.at < L1_FEE_CACHE_MS) return cached.value;
  try {
    const value = await estimateL1FeeWei(key, GAS_PRICE_ORACLE, REPRESENTATIVE_CALLDATA, 300_000n);
    // 初回と、前回から2割以上動いた時だけログに出す(実額の確認用)。
    const prevValue = cached?.value ?? null;
    const moved = prevValue == null || prevValue === 0n || (value > prevValue ? value - prevValue : prevValue - value) * 5n > prevValue;
    l1FeeTypical.set(key, { value, at: Date.now(), source: "oracle" });
    if (moved) {
      let usd = null;
      try { usd = await weiToUsd(key, value); } catch (e) {}
      console.log(`[L1データ手数料] ${key}: 代表的な2段の取引で ${ethers.formatEther(value)} ETH${usd != null ? `(約$${usd.toFixed(4)})` : ""}`);
    }
    return value;
  } catch (e) {
    // 失敗しても5分は聞き直さない(ガス代の更新は数十秒ごとなので、警告が並ばないように)。
    l1FeeTypical.set(key, { value: cached?.value ?? 0n, at: Date.now(), source: "失敗" });
    console.warn(`[L1データ手数料] ${key}: 予備コントラクトに聞けず: ${(e.message || "").slice(0, 80)}`);
  }
  return cached?.value ?? 0n;
}

/// 確定後に receipt の l1Fee を学習する(件数で重みを付けた平均)。
export function recordActualL1Fee(chain, wei) {
  const key = (chain || "").toLowerCase();
  if (wei == null || wei < 0n) return null;
  const prev = l1FeeMeasured.get(key);
  const n = Math.min((prev?.samples ?? 0) + 1, L1_FEE_SAMPLES);
  const value = prev ? prev.value + (wei - prev.value) / BigInt(n) : wei;
  l1FeeMeasured.set(key, { value, samples: n });
  return { value, samples: n };
}

/// receipt の l1Fee(wei)を読む。ethers の receipt には無いので生の応答を読む。
/// OP Stack 以外、または読めなければ 0。
export async function readL1FeeFromReceipt(chain, txHash) {
  const key = (chain || "").toLowerCase();
  if (!isOpStackChain(key)) return 0n;
  try {
    const raw = await callWithRpc(key, (p) => p.send("eth_getTransactionReceipt", [txHash]), true);
    const hex = raw?.l1Fee;
    if (typeof hex === "string" && hex.startsWith("0x")) return BigInt(hex);
  } catch (e) {}
  return 0n;
}

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

// ===== 学んだ比の持ち越し(2026年9月20日) =====
//
// [なぜ要るか]
// この学習は**送信が成功した時にしか進まない**。成功は1日数件しかないのに、
// 手を入れて再デプロイするたびに比は 1.0(=補正なし)へ戻っていた。
// つまり実際には一度も貯まっていない。
//
// 実測(2026年9月20日 17:22 UTC、polygon):
//   [実行] 確定: 粗利+$0.0201 − ガス$0.0105 = 純利益+$0.0096(見積もりガス$0.0125)
// 見積もりが実際より **19%高い**。同じ30分の下限の内訳は
//   polygon:127件 粗利中央$0.0138 ガス中央$0.0124
// なので、この19%はそのままハードルの高さとして効いていて、
// 見送った127件の多くがこの差の中にいる。
//
// 比は「出す用意のあった単価」と「実際に取られた単価」の比なので、
// ガスの相場そのものより安定している。古すぎる値は使わない。
export function exportGasPriceRatios() {
  const out = {};
  for (const [chain, v] of gasPriceRatio.entries()) out[chain] = { ratio: v.ratio, samples: v.samples };
  return out;
}

/// 保存しておいた比を戻す。戻した件数を返す。
/// 件数(samples)は最大4に抑えるので、その後の実測がすぐ効くようにする。
export function importGasPriceRatios(saved) {
  if (!saved || typeof saved !== "object") return 0;
  let n = 0;
  for (const [chain, v] of Object.entries(saved)) {
    const ratio = Number(v?.ratio);
    if (!isFinite(ratio) || ratio <= 0 || ratio > 1) continue;
    const bounded = Math.max(GAS_PRICE_RATIO_MIN, Math.min(1, ratio));
    const samples = Math.min(Math.max(1, Number(v?.samples) || 1), 4);
    gasPriceRatio.set((chain || "").toLowerCase(), { ratio: bounded, samples });
    n++;
  }
  return n;
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

/// **同じネイティブ通貨(ETH)を使うチェーン。** 自分のチェーンで価格が取れない時に借りる。
///
/// [なぜ(2026年9月23日、optimism の送信再開の準備で発覚)]
/// base と optimism は WETH の住所が同じ(0x4200…0006)。DexScreener に聞くと返る候補が
/// 取引量の多い base の組で埋まり、optimism の組が1つも入らず**価格不明**になっていた。
/// その結果 optimism では、ガス代の見積もりが予備の既定値のまま、優先手数料は入札されず、
/// 約定後のガス代もドルに直せなかった。**ETH の値段はどのチェーンでも同じ**なので借りてよい。
const SAME_NATIVE = { optimism: ["base", "arbitrum"], base: ["arbitrum", "optimism"], arbitrum: ["base", "optimism"] };

async function getNativePriceUsd(chain) {
  const own = await getNativePriceUsdOwn(chain);
  if (own != null) return own;
  for (const alt of SAME_NATIVE[chain] || []) {
    const v = await getNativePriceUsdOwn(alt);
    if (v != null) return v;
  }
  return null;
}

async function getNativePriceUsdOwn(chain) {
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
/// OP Stack では L1 データ手数料を足す(l1FeeWei を渡さなければ代表値)。
export async function gasUnitsToUsd(chain, gasUnits, l1FeeWei = null) {
  const key = (chain || "").toLowerCase();
  const [gasPriceWei, nativePriceUsd, l1Wei] = await Promise.all([
    getEstimatedGasPriceWei(key),
    getNativePriceUsd(key),
    l1FeeWei != null ? Promise.resolve(BigInt(l1FeeWei)) : getTypicalL1FeeWei(key),
  ]);
  if (!gasPriceWei || !nativePriceUsd) return null;
  const costNative = parseFloat(ethers.formatEther(BigInt(gasUnits) * gasPriceWei + (l1Wei || 0n)));
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
