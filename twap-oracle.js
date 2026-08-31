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
  if (!currentAvg || !referencePrice || !volatilityPerSec || remainingSec <= 0) return 0;
  const diff = Math.abs(currentAvg - referencePrice) / referencePrice;
  const possibleMove = volatilityPerSec * Math.sqrt(remainingSec);
  if (possibleMove <= 0) return diff > 0 ? 1 : 0;
  const zScore = diff / possibleMove;
  if (zScore >= 3) return 0.997;
  if (zScore >= 2) return 0.95;
  if (zScore >= 1) return 0.68;
  return zScore * 0.68;
}

export async function fetchActiveShortDurationMarkets() {
  const results = [];
  try {
    const res = await fetch(`${GAMMA_BASE}/markets?closed=false&limit=100&order=volume24hr&ascending=false&tag=crypto`);
    if (!res.ok) return results;
    const markets = await res.json();
    for (const m of markets) {
      const q = (m.question || "").toLowerCase();
      const isShortDuration = /\b(5|15)[- ]?min/.test(q) || /\b(5|15)分/.test(q);
      const asset = q.includes("bitcoin") || q.includes("btc") ? "BTC" : q.includes("ethereum") || q.includes("eth") ? "ETH" : null;
      if (!isShortDuration || !asset) continue;
      results.push({
        id: m.id, slug: m.slug, question: m.question, asset,
        endDate: m.endDate, startDate: m.startDate,
        clobTokenIds: m.clobTokenIds ? JSON.parse(m.clobTokenIds) : null,
        durationMin: /\b15/.test(q) ? 15 : 5,
      });
    }
  } catch (e) {
    console.warn("Polymarket市場取得失敗:", e.message);
  }
  return results;
}

async function fetchMidpoint(tokenId) {
  try {
    const res = await fetch(`${CLOB_BASE}/midpoint?token_id=${tokenId}`);
    if (!res.ok) return null;
    const json = await res.json();
    return parseFloat(json.mid);
  } catch (e) {
    return null;
  }
}

export async function analyzeMarket(market) {
  const now = Date.now();
  const endMs = new Date(market.endDate).getTime();
  const remainingSec = (endMs - now) / 1000;
  if (remainingSec <= 0 || remainingSec > market.durationMin * 60) return null;

  const twapWindowSec = market.durationMin === 5 ? 30 : 60;
  const windowStart = endMs - twapWindowSec * 1000;

  if (now < windowStart) return null;

  const samples = samplesInWindow(market.asset, windowStart, now);
  const currentAvg = average(samples);
  if (!currentAvg) return null;

  const openSamples = samplesInWindow(market.asset, new Date(market.startDate).getTime(), new Date(market.startDate).getTime() + 5000);
  const referencePrice = average(openSamples) ?? samples[0]?.p;
  if (!referencePrice) return null;

  const vol = estimateVolatility(market.asset);
  const remainingInWindow = (endMs - now) / 1000;
  const confidence = estimateConfidence(currentAvg, referencePrice, remainingInWindow, vol);
  const impliedDirection = currentAvg >= referencePrice ? "UP" : "DOWN";

  if (!market.clobTokenIds || market.clobTokenIds.length < 1) return null;
  const marketPrice = await fetchMidpoint(market.clobTokenIds[0]);
  if (marketPrice === null) return null;

  const ourEstimate = impliedDirection === "UP" ? confidence : 1 - confidence;
  const edge = ourEstimate - marketPrice;

  return {
    marketId: market.id, question: market.question, asset: market.asset,
    remainingSec: Math.round(remainingInWindow),
    currentAvg, referencePrice, impliedDirection, confidence,
    marketPrice, ourEstimate, edge,
    measuredAt: new Date().toISOString(),
  };
}
