/**
 * TWAPオラクル観測モジュール
 * ------------------------------------------------------------
 * Polymarketの5分/15分のBTC/ETH市場は、2026年8月7日から
 * 「瞬間価格」ではなく「終了直前30秒(5分市場)/60秒(15分市場)の
 * 平均価格(TWAP)」で決済される方式に変わった。
 *
 * これを踏まえ、単純な「価格が動いたか」ではなく、
 * 「残り時間内に平均が引っくり返る余地がどれだけあるか」を
 * 実際に計算し、市場の表示価格とズレがあれば記録する。
 *
 * 実際の注文は一切出さない(紙上取引での検証のみ)。
 */

const BINANCE_BASE = "https://api.binance.com";
const GAMMA_BASE = "https://gamma-api.polymarket.com";
const CLOB_BASE = "https://clob.polymarket.com";

const SYMBOLS = { BTC: "BTCUSDT", ETH: "ETHUSDT" };

// ============ Binance価格のローリング記録 ============
const priceHistory = { BTC: [], ETH: [] };
const MAX_HISTORY_SEC = 20 * 60;

export async function sampleBinancePrices() {
  const now = Date.now();
  for (const [asset, symbol] of Object.entries(SYMBOLS)) {
    try {
      const res = await fetch(`${BINANCE_BASE}/api/v3/ticker/price?symbol=${symbol}`);
      if (!res.ok) continue;
      const json = await res.json();
      const price = parseFloat(json.price);
      if (!isFinite(price)) continue;
      priceHistory[asset].push({ t: now, p: price });
    } catch (e) {}
  }
  const cutoff = now - MAX_HISTORY_SEC * 1000;
  for (const asset of Object.keys(priceHistory)) {
    priceHistory[asset] = priceHistory[asset].filter((s) => s.t >= cutoff);
  }
}

function samplesInWindow(asset, fromMs, toMs) {
  return priceHistory[asset].filter((s) => s.t >= fromMs && s.t <= toMs);
}

function average(samples) {
  if (samples.length === 0) return null;
  return samples.reduce((s, x) => s + x.p, 0) / samples.length;
}

function estimateVolatility(asset, lookbackSec = 300) {
  const now = Date.now();
  const samples = samplesInWindow(asset, now - lookbackSec * 1000, now);
  if (samples.length < 10) return null;
  const returns = [];
  for (let i = 1; i < samples.length; i++) {
    const dt = (samples[i].t - samples[i - 1].t) / 1000;
    if (dt <= 0) continue;
    const r = (samples[i].p - samples[i - 1].p) / samples[i - 1].p;
    returns.push(r / Math.sqrt(dt));
  }
  if (returns.length === 0) return null;
  const mean = returns.reduce((s, x) => s + x, 0) / returns.length;
  const variance = returns.reduce((s, x) => s + (x - mean) ** 2, 0) / returns.length;
  return Math.sqrt(variance);
}

function estimateConfidence(currentAvg, referencePrice, remainingSec, volatilityPerSec) {
  if (!currentAvg || !referencePrice || !volatilityPerSec || remainingSec 
