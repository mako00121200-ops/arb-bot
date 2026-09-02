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

let ACTIVE_SOURCE = "okx";
export function setActiveSource(name) { ACTIVE_SOURCE = name; }

let tickCount = 0;
export function recordPriceTick(asset, price, timestamp) {
  if (!priceHistory[asset]) return;
  priceHistory[asset].push({ t: timestamp, p: price });
  tickCount++;
  const cutoff = timestamp - MAX_HISTORY_SEC * 1000;
  if (tickCount % 100 === 0) {
    for (const a of Object.keys(priceHistory)) {
      priceHistory[a] = priceHistory[a].filter((s) => s.t >= cutoff);
    }
  }
}

export async function sampleBinancePrices() {
  const now = Date.now();
  const fn = PRICE_SOURCES[ACTIVE_SOURCE];
  for (const [asset, symbol] of Object.entries(SYMBOLS)) {
    try {
      const r = await fn(symbol);
      if (r.error || !isFinite(r.price)) continue;
      priceHistory[asset].push({ t: now, p: r.price });
    } catch (e) {}
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

const loggedMarketIds = new Set();
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

      const parsedTokenIds = market.clobTokenIds
        ? (typeof market.clobTokenIds === "string" ? JSON.parse(market.clobTokenIds) : market.clobTokenIds)
        : null;

      const parsedOutcomes = market.outcomes
        ? (typeof market.outcomes === "string" ? JSON.parse(market.outcomes) : market.outcomes)
        : null;
      let upTokenId = parsedTokenIds?.[0] ?? null;
      let downTokenId = parsedTokenIds?.[1] ?? null;
      if (parsedOutcomes && parsedTokenIds) {
        const upIndex = parsedOutcomes.findIndex((o) => /up/i.test(String(o)));
        const downIndex = parsedOutcomes.findIndex((o) => /down/i.test(String(o)));
        if (upIndex >= 0 && parsedTokenIds[upIndex]) upTokenId = parsedTokenIds[upIndex];
        if (downIndex >= 0 && parsedTokenIds[downIndex]) downTokenId = parsedTokenIds[downIndex];
      }

      results.push({
        id: market.id ?? event.id,
        slug: market.slug ?? event.slug,
        question: market.question ?? event.title,
        asset: series.asset,
        endDate: market.endDate ?? event.endDate,
        startDate: market.startDate ?? event.startDate ?? event.eventStartTime,
        clobTokenIds: parsedTokenIds,
        upTokenId, downTokenId,
        durationMin: series.durationMin,
      });
      if (!loggedMarketIds.has(market.id)) {
        loggedMarketIds.add(market.id);
        console.log(`[診断] 新しい市場: ${market.question ?? event.title} / clobTokenIds=${JSON.stringify(parsedTokenIds)} / outcomes=${JSON.stringify(parsedOutcomes)} / 判定したUPトークン=${upTokenId?.slice(0,12)}...`);
      }

    } catch (e) {
      console.warn(`シリーズ${series.slug}の取得失敗:`, e.message);
    }
  }
  return results;
}

const livePolyPrices = {};
export function recordPolymarketTick(tokenId, price, timestamp) {
  livePolyPrices[tokenId] = { price, at: timestamp ?? Date.now() };
}

const livePolyBook = {};
export function recordPolymarketBook(tokenId, bestBid, bestAsk) {
  livePolyBook[tokenId] = { bestBid, bestAsk, at: Date.now() };
}
export function getBook(tokenId) {
  return livePolyBook[tokenId] ?? null;
}

let midpointDiagCount = 0;
async function fetchMidpoint(tokenId) {
  midpointDiagCount++;
  const shouldLog = midpointDiagCount % 5 === 1;
  const cached = livePolyPrices[tokenId];
  if (cached !== undefined) {
    const ageSec = (Date.now() - cached.at) / 1000;
    if (shouldLog) console.log(`[診断] fetchMidpoint: WebSocketキャッシュから取得 tokenId=${tokenId.slice(0,12)}... 値=${cached.price} 経過${ageSec.toFixed(1)}秒`);
    return { price: cached.price, ageSec };
  }
  try {
    const res = await fetch(`${CLOB_BASE}/midpoint?token_id=${tokenId}`);
    if (!res.ok) {
      console.log(`[診断] fetchMidpoint: REST APIエラー tokenId=${tokenId.slice(0,12)}... HTTP${res.status}`);
      return null;
    }
    const json = await res.json();
    const val = parseFloat(json.mid);
    if (shouldLog) console.log(`[診断] fetchMidpoint: REST APIから取得 tokenId=${tokenId.slice(0,12)}... 生レスポンス=${JSON.stringify(json)} 解析値=${val}`);
    return { price: val, ageSec: 0 };
  } catch (e) {
    console.log(`[診断] fetchMidpoint: 例外 ${e.message}`);
    return null;
  }
}

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

  if (!market.upTokenId) {
    console.log(`[診断] ${market.asset}: UPトークンIDが無い(clobTokenIds=${JSON.stringify(market.clobTokenIds)})`);
    return null;
  }
  const midpointResult = await fetchMidpoint(market.upTokenId);
  if (midpointResult === null) {
    console.log(`[診断] ${market.asset}: CLOB midpoint取得失敗(tokenId=${market.upTokenId})`);
    return null;
  }
  const { price: marketPrice, ageSec: marketPriceAgeSec } = midpointResult;
  console.log(`[診断] ${market.asset}: 判定成功! 推定=${confidence.toFixed(3)} 市場価格=${marketPrice}(${marketPriceAgeSec.toFixed(1)}秒前の情報) 残り${remainingInWindow.toFixed(0)}秒`);

  const ourEstimate = impliedDirection === "UP" ? confidence : 1 - confidence;
  const edge = ourEstimate - marketPrice;

  const book = getBook(market.upTokenId);

  let beyondHalfSpread = null;
  if (book?.bestBid !== null && book?.bestBid !== undefined && book?.bestAsk !== null && book?.bestAsk !== undefined) {
    const halfSpread = (book.bestAsk - book.bestBid) / 2;
    beyondHalfSpread = Math.abs(edge) > halfSpread;
  }

  return {
    marketId: market.id, question: market.question, asset: market.asset,
    remainingSec: Math.round(remainingInWindow),
    currentAvg, referencePrice, impliedDirection, confidence,
    marketPrice, marketPriceAgeSec, ourEstimate, edge, beyondHalfSpread,
    bestBid: book?.bestBid ?? null, bestAsk: book?.bestAsk ?? null,
    measuredAt: new Date().toISOString(),
  };
}

const detectedComplementArbs = [];
const complementArbMarketIds = new Set();

export function checkComplementArb(market) {
  if (!market.upTokenId || !market.downTokenId) return null;
  const upBook = getBook(market.upTokenId);
  const downBook = getBook(market.downTokenId);
  if (!upBook?.bestAsk || !downBook?.bestAsk) return null;

  const totalCost = upBook.bestAsk + downBook.bestAsk;
  const margin = 1 - totalCost;
  const MIN_MARGIN = 0.02;

  if (margin > MIN_MARGIN) {
    const key = `${market.id}`;
    if (!complementArbMarketIds.has(key)) {
      complementArbMarketIds.add(key);
      const entry = {
        marketId: market.id, question: market.question, asset: market.asset,
        upAsk: upBook.bestAsk, downAsk: downBook.bestAsk, margin,
        detectedAt: new Date().toISOString(),
      };
      detectedComplementArbs.push(entry);
      if (detectedComplementArbs.length > 200) detectedComplementArbs.shift();
      console.log(`[コンプリメント裁定] ${market.question}: UP=${upBook.bestAsk} + DOWN=${downBook.bestAsk} = ${totalCost.toFixed(3)}(利益余地 ${(margin*100).toFixed(1)}%)`);
      return entry;
    }
  }
  return null;
}
export function getDetectedComplementArbs() { return [...detectedComplementArbs].reverse(); }

let backtestFeasibilityChecked = false;
export async function checkBacktestFeasibility(closedMarketTokenId, endTimeMs) {
  if (backtestFeasibilityChecked || !closedMarketTokenId) return;
  backtestFeasibilityChecked = true;
  try {
    const startTs = Math.floor((endTimeMs - 5 * 60 * 1000) / 1000);
    const endTs = Math.floor(endTimeMs / 1000);
    const url = `${CLOB_BASE}/prices-history?market=${closedMarketTokenId}&startTs=${startTs}&endTs=${endTs}&fidelity=1`;
    const res = await fetch(url);
    if (!res.ok) {
      console.log(`[診断] 過去データ検証: HTTPエラー ${res.status}(バックテストは実現困難と判断)`);
      return;
    }
    const json = await res.json();
    const count = json?.history?.length ?? 0;
    if (count === 0) {
      console.log(`[診断] 過去データ検証: 終了済み市場で細かい粒度(1分)のデータが0件。海外で報告されていたバグの通り、バックテストは困難な可能性が高い。`);
    } else {
      console.log(`[診断] 過去データ検証: 成功! ${count}件のデータポイントを取得できた。バックテストは実現可能な可能性が高い。サンプル: ${JSON.stringify(json.history.slice(0,3))}`);
    }
  } catch (e) {
    console.log(`[診断] 過去データ検証: 例外 ${e.message}`);
  }
}
