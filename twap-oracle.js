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

// Binanceは地域制限(HTTP 451)によりRailwayから直接アクセスできなかった。
// 複数の候補を一斉に試し、実際にどれが繋がるかをログで確認する診断モードを用意した。
const GAMMA_BASE = "https://gamma-api.polymarket.com";
const CLOB_BASE = "https://clob.polymarket.com";

const SYMBOLS = { BTC: "BTC-USD", ETH: "ETH-USD" };

const PRICE_SOURCES = {
  coinbase: async (symbol) => {
    const res = await fetch(`https://api.coinbase.com/v2/prices/${symbol}/spot`);
    if (!res.ok) return { error: `HTTP ${res.status}` };
    const json = await res.json();
    return { price: parseFloat(json?.data?.amount) };
  },
  kraken: async (symbol) => {
    const pair = symbol === "BTC-USD" ? "XBTUSD" : "ETHUSD";
    const res = await fetch(`https://api.kraken.com/0/public/Ticker?pair=${pair}`);
    if (!res.ok) return { error: `HTTP ${res.status}` };
    const json = await res.json();
    const key = Object.keys(json.result || {})[0];
    return { price: parseFloat(json.result?.[key]?.c?.[0]) };
  },
  coingecko: async (symbol) => {
    const id = symbol === "BTC-USD" ? "bitcoin" : "ethereum";
    const res = await fetch(`https://api.coingecko.com/api/v3/simple/price?ids=${id}&vs_currencies=usd`);
    if (!res.ok) return { error: `HTTP ${res.status}` };
    const json = await res.json();
    return { price: parseFloat(json?.[id]?.usd) };
  },
  bitstamp: async (symbol) => {
    const pair = symbol === "BTC-USD" ? "btcusd" : "ethusd";
    const res = await fetch(`https://www.bitstamp.net/api/v2/ticker/${pair}/`);
    if (!res.ok) return { error: `HTTP ${res.status}` };
    const json = await res.json();
    return { price: parseFloat(json?.last) };
  },
  okx: async (symbol) => {
    const inst = symbol === "BTC-USD" ? "BTC-USDT" : "ETH-USDT";
    const res = await fetch(`https://www.okx.com/api/v5/market/ticker?instId=${inst}`);
    if (!res.ok) return { error: `HTTP ${res.status}` };
    const json = await res.json();
    return { price: parseFloat(json?.data?.[0]?.last) };
  },
};

export async function diagnoseSources() {
  console.log("=== 価格ソース診断開始 ===");
  for (const [name, fn] of Object.entries(PRICE_SOURCES)) {
    try {
      const r = await fn("BTC-USD");
      if (r.error) console.log(`[診断] ${name}: 失敗 - ${r.error}`);
      else if (!isFinite(r.price)) console.log(`[診断] ${name}: 価格が不正 - ${JSON.stringify(r)}`);
      else console.log(`[診断] ${name}: 成功! BTC=$${r.price}`);
    } catch (e) {
      console.log(`[診断] ${name}: 例外 - ${e.message}`);
    }
  }
  console.log("=== 価格ソース診断終了 ===");
}

const priceHistory = { BTC: [], ETH: [] };
const MAX_HISTORY_SEC = 20 * 60;

let ACTIVE_SOURCE = "coinbase";
export function setActiveSource(name) { ACTIVE_SOURCE = name; }

let sampleDiagCounter = 0;
export async function sampleBinancePrices() {
  const now = Date.now();
  sampleDiagCounter++;
  const shouldLog = sampleDiagCounter % 10 === 1;
  const fn = PRICE_SOURCES[ACTIVE_SOURCE];
  for (const [asset, symbol] of Object.entries(SYMBOLS)) {
    try {
      const r = await fn(symbol);
      if (r.error) {
        console.log(`[診断] ${ACTIVE_SOURCE} ${symbol}: ${r.error}`);
        continue;
      }
      if (!isFinite(r.price)) {
        console.log(`[診断] ${ACTIVE_SOURCE} ${symbol}: 価格が数値でない`);
        continue;
      }
      priceHistory[asset].push({ t: now, p: r.price });
      if (shouldLog) console.log(`[診断] ${ACTIVE_SOURCE} ${symbol}: 取得成功 $${r.price}(累計${priceHistory[asset].length}件)`);
    } catch (e) {
      console.log(`[診断] ${ACTIVE_SOURCE} ${symbol}: 例外 ${e.message}`);
    }
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
    const url = `${GAMMA_BASE}/events?series_slug=${seriesSlug}&closed=false&limit=50&order=endDate&ascending=true&end_date_min=${encodeURIComponent(minEndIso)}`;
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
/**
 * 1つの市場について、独自のTWAP計算による確信度と、
 * Polymarketの表示価格を突き合わせ、歪みがあれば返す。
 */
let diagCounter = 0;
export async function analyzeMarket(market) {
  const now = Date.now();
  const endMs = new Date(market.endDate).getTime();
  const remainingSec = (endMs - now) / 1000;
  diagCounter++;
  const shouldLog = diagCounter % 3 === 0;

  if (remainingSec <= 0 || remainingSec > market.durationMin * 60) {
    if (shouldLog) console.log(`[診断] ${market.asset}(${market.durationMin}分): 対象外(残り${remainingSec.toFixed(0)}秒、期間${market.durationMin*60}秒)`);
    return null;
  }

  const twapWindowSec = market.durationMin === 5 ? 30 : 60;
  const windowStart = endMs - twapWindowSec * 1000;

  if (now < windowStart) {
    if (shouldLog) console.log(`[診断] ${market.asset}(${market.durationMin}分): TWAP窓前(あと${((windowStart-now)/1000).toFixed(0)}秒で窓に入る)`);
    return null;
  }

  const samples = samplesInWindow(market.asset, windowStart, now);
  const currentAvg = average(samples);
  if (!currentAvg) {
    console.log(`[診断] ${market.asset}: TWAP窓内だがサンプル無し(サンプル数${samples.length})`);
    return null;
  }

  const openSamples = samplesInWindow(market.asset, new Date(market.startDate).getTime(), new Date(market.startDate).getTime() + 5000);
  const referencePrice = average(openSamples) ?? samples[0]?.p;
  if (!referencePrice) {
    console.log(`[診断] ${market.asset}: 参照価格なし`);
    return null;
  }

  const vol = estimateVolatility(market.asset);
  const remainingInWindow = (endMs - now) / 1000;
  const confidence = estimateConfidence(currentAvg, referencePrice, remainingInWindow, vol);
  const impliedDirection = currentAvg >= referencePrice ? "UP" : "DOWN";

  if (!market.clobTokenIds || market.clobTokenIds.length < 1) {
    console.log(`[診断] ${market.asset}: clobTokenIdsが無い(market.clobTokenIds=${JSON.stringify(market.clobTokenIds)})`);
    return null;
  }
  const marketPrice = await fetchMidpoint(market.clobTokenIds[0]);
  if (marketPrice === null) {
    console.log(`[診断] ${market.asset}: CLOB midpoint取得失敗(tokenId=${market.clobTokenIds[0]})`);
    return null;
  }
  console.log(`[診断] ${market.asset}: 判定成功! 推定=${confidence.toFixed(3)} 市場価格=${marketPrice} 残り${remainingInWindow.toFixed(0)}秒`);

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
