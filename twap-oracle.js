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

// ============ Polymarket側: 5分/15分のBTC/ETH市場を取得 ============
const SERIES_SLUGS = [
  { slug: "btc-up-or-down-5m", asset: "BTC", durationMin: 5 },
  { slug: "eth-up-or-down-5m", asset: "ETH", durationMin: 5 },
  { slug: "btc-up-or-down-15m", asset: "BTC", durationMin: 15 },
  { slug: "eth-up-or-down-15m", asset: "ETH", durationMin: 15 },
];

async function fetchCurrentEventForSeries(seriesSlug) {
  try {
    const now = Date.now();
    const minEndIso = new Date(now - 20 * 60 * 1000).toISOString();
    const url = `${GAMMA_BASE}/events?series_slug=${seriesSlug}&closed=false&limit=50&order=endDate&ascending=false&end_date_min=${encodeURIComponent(minEndIso)}`;
    const res = await fetch(url);
    if (!res.ok) return null;
    const events = await res.json();
    if (!Array.isArray(events) || events.length === 0) return null;

    const inProgress = events.find((e) => {
      const start = new Date(e.startDate ?? e.eventStartTime ?? e.startTime).getTime();
      const end = new Date(e.endDate).getTime();
      return start <= now && now < end;
    });
    if (inProgress) return inProgress;

    const sorted = [...events].sort((a, b) =>
      Math.abs(new Date(a.endDate).getTime() - now) - Math.abs(new Date(b.endDate).getTime() - now));
    return sorted[0] ?? null;
  } catch (e) {
    return null;
  }
}

export async function fetchActiveShortDurationMarkets() {
  const results = [];
  for (const series of SERIES_SLUGS) {
    try {
      const event = await fetchCurrentEventForSeries(series.slug);
      if (!event) continue;
      const market = Array.isArray(event.markets) ? event.markets[0] : event;
      if (!market) continue;

      results.push({
        id: market.id ?? event.id,
        slug: market.slug ?? event.slug,
        question: market.question ?? event.title,
        asset: series.asset,
        endDate: market.endDate ?? event.endDate,
        startDate: market.startDate ?? event.startDate ?? event.eventStartTime,
        clobTokenIds: market.clobTokenIds
          ? (typeof market.clobTokenIds === "string" ? JSON.parse(market.clobTokenIds) : market.clobTokenIds)
          : null,
        durationMin: series.durationMin,
      });
    } catch (e) {
      console.warn(`シリーズ${series.slug}の取得失敗:`, e.message);
    }
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
