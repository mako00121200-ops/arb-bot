import http from "http";
import { sampleBinancePrices, fetchActiveShortDurationMarkets, analyzeMarket, diagnoseSources, recordPriceTick, recordPolymarketTick, recordPolymarketBook, checkComplementArb, getDetectedComplementArbs, checkBacktestFeasibility } from "./twap-oracle.js";
import { startOkxFeed, startBybitFeed, startPolymarketFeed, updatePolymarketSubscription } from "./realtime.js";
import { checkLogicalConstraints, WATCHED_PAIRS } from "./logic-checker.js";
import { recordSignal, resolveOpenPositions, getStats, getOpenCount, getRecentResolved } from "./paper-trader.js";
import fs from "fs";
import { runProspect } from "./prospector.js";
import { startOnchainFeeds, updatePoolSubscriptions } from "./dex-onchain-realtime.js";

const DEX_FETCH_TIMEOUT_MS = 20000;

async function dexFetchWithTimeout(url, timeoutMs = DEX_FETCH_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function dexGetAmountOut(amountIn, reserveIn, reserveOut, feeRetain) {
  if (amountIn <= 0) return 0;
  const amountInWithFee = amountIn * feeRetain;
  return (reserveOut * amountInWithFee) / (reserveIn + amountInWithFee);
}

function dexComputeOptimalArbitrage(pool1, pool2) {
  const a = pool1.reserveY;
  const A = pool1.reserveX;
  const X2 = pool2.reserveX;
  const Y2 = pool2.reserveY;
  const g1 = 1 - pool1.fee;
  const g2 = 1 - pool2.fee;

  const P = Y2 * g2 * A;
  const Q = X2 * a;
  const R = X2 + g2 * A;
  const inner = g1 * P * Q;

  if (inner <= Q * Q) {
    return { amountIn: 0, grossProfit: 0, profitable: false };
  }

  const s = Math.sqrt(inner) - Q;
  const theoreticalAmountIn = s / (g1 * R);

  if (theoreticalAmountIn <= 0) {
    return { amountIn: 0, grossProfit: 0, profitable: false };
  }

  const simulateProfit = (t) => {
    const xOut = dexGetAmountOut(t, a, A, g1);
    const yOut = dexGetAmountOut(xOut, X2, Y2, g2);
    return yOut - t;
  };

  let bestT = theoreticalAmountIn;
  let bestProfit = simulateProfit(theoreticalAmountIn);

  for (let mult = 0.5; mult <= 1.5; mult += 0.01) {
    const t = theoreticalAmountIn * mult;
    const p = simulateProfit(t);
    if (p > bestProfit) {
      bestProfit = p;
      bestT = t;
    }
  }

  return { amountIn: bestT, grossProfit: bestProfit, profitable: bestProfit > 0 };
}

function dexEvaluateOpportunity({ cheapPool, expensivePool, gasCostInY, slippageBuffer = 0, pairLabel = "" }) {
  const priceCheap = cheapPool.reserveY / cheapPool.reserveX;
  const priceExpensive = expensivePool.reserveY / expensivePool.reserveX;

  const result = dexComputeOptimalArbitrage(cheapPool, expensivePool);
  const grossProfit = result.grossProfit;
  const slippageCost = grossProfit * slippageBuffer;
  const netProfit = grossProfit - gasCostInY - slippageCost;

  return {
    timestamp: new Date().toISOString(),
    pairLabel,
    priceDiffPercent: ((priceExpensive - priceCheap) / priceCheap) * 100,
    optimalAmountIn: result.amountIn,
    grossProfit,
    gasCostInY,
    slippageCost,
    netProfit,
    profitable: netProfit > 0,
  };
}

const DEXSCREENER_TOKEN_API = "https://api.dexscreener.com/latest/dex/tokens/";
const DEX_LOG_FILE = process.env.WATCHER_LOG_FILE || "/tmp/dex-arb-observations.json";

const DEX_DEFAULT_FEE_BY_DEX = {
  uniswap: 0.003,
  aerodrome: 0.0005,
  "aerodrome-slipstream": 0.0005,
  sushiswap: 0.003,
  camelot: 0.003,
  velodrome: 0.0005,
  default: 0.003,
};

function dexGetFeeForDex(dexId) {
  return DEX_DEFAULT_FEE_BY_DEX[(dexId || "").toLowerCase()] ?? DEX_DEFAULT_FEE_BY_DEX.default;
}

function dexNormalizeChain(chain) {
  const map = { base: "base", arbitrum: "arbitrum", optimism: "optimism", ethereum: "ethereum" };
  return map[(chain || "").toLowerCase()] || (chain || "").toLowerCase();
}

// チェーンごとの想定ガス代(USD)。イーサリアムL1はL2群より一桁以上高いため、
// 一律の値を使うと「小さな価格差」を誤って黒字判定してしまう。
const CHAIN_GAS_COST_USD = {
  base: 0.05,
  arbitrum: 0.10,
  optimism: 0.05,
  ethereum: 8.0,
  polygon: 0.02,
};
function getGasCostForChain(chain) {
  const key = dexNormalizeChain(chain);
  return CHAIN_GAS_COST_USD[key] ?? 0.25;
}

function dexLoadLog() {
  try {
    if (fs.existsSync(DEX_LOG_FILE)) return JSON.parse(fs.readFileSync(DEX_LOG_FILE, "utf8"));
  } catch (e) {
    /* 読み込み失敗時は空ログから再開 */
  }
  return [];
}

function dexSaveLog(entries) {
  try {
    const trimmed = entries.length > 2000 ? entries.slice(-2000) : entries;
    fs.writeFileSync(DEX_LOG_FILE, JSON.stringify(trimmed));
  } catch (e) {
    console.warn("観測ログの保存に失敗:", e.message);
  }
}

// tokenAだけで検索すると、人気トークン(WETH等)は上位30件がUSDC等の
// 出来高最大ペアで埋まり、本命のペアが枠外に押し出されることがある。
// tokenA・tokenB両方で検索して結果を合成することで、この取りこぼしを防ぐ。
async function dexFetchPairsForToken(tokenAddress, chain, otherTokenAddress) {
  const targetChain = dexNormalizeChain(chain);
  const target = tokenAddress.toLowerCase();
  const other = otherTokenAddress.toLowerCase();

  const [resA, resB] = await Promise.all([
    dexFetchWithTimeout(DEXSCREENER_TOKEN_API + tokenAddress),
    dexFetchWithTimeout(DEXSCREENER_TOKEN_API + otherTokenAddress),
  ]);
  if (!resA.ok && !resB.ok) {
    throw new Error(`DexScreener HTTP ${resA.status}/${resB.status}`);
  }

  const pairsA = resA.ok ? (await resA.json()).pairs || [] : [];
  const pairsB = resB.ok ? (await resB.json()).pairs || [] : [];

  const merged = new Map();
  for (const p of [...pairsA, ...pairsB]) {
    if (p.pairAddress) merged.set(p.pairAddress, p);
  }
  const allPairs = [...merged.values()];

  const filtered = allPairs.filter((p) => {
    if ((p.chainId || "").toLowerCase() !== targetChain) return false;
    const base = (p.baseToken?.address || "").toLowerCase();
    const quote = (p.quoteToken?.address || "").toLowerCase();
    const hasTarget = base === target || quote === target;
    const hasOther = base === other || quote === other;
    return hasTarget && hasOther;
  });

  const rawChainIds = [...new Set(allPairs.map((p) => p.chainId))];
  console.log(`[DEX診断] candidate.chain="${chain}" → 正規化後="${targetChain}" / DexScreener取得件数=${allPairs.length}件(tokenA検索${pairsA.length}件+tokenB検索${pairsB.length}件、重複除去後・chainId内訳: ${JSON.stringify(rawChainIds)}) / フィルター後=${filtered.length}件(うちDEX一覧: ${JSON.stringify([...new Set(filtered.map(p=>p.dexId))])})`);

  if (filtered.length === 0) {
    console.log(`[DEX診断詳細] tokenA(${target})・tokenB(${other})両方で検索したが、${chain}上で両方を含むペアが見つからなかった`);
  }

  return filtered;
}

const CONCENTRATED_LIQUIDITY_DEX_IDS = new Set([
  "aerodrome-slipstream", "velodrome-slipstream", "pancakeswap-v3", "uniswap-v3",
]);
function isConcentratedLiquidity(pair) {
  const labels = (pair.labels || []).map((l) => String(l).toLowerCase());
  if (labels.some((l) => /v3|concentrated|slipstream|\bcl\b/.test(l))) return true;
  if (CONCENTRATED_LIQUIDITY_DEX_IDS.has((pair.dexId || "").toLowerCase())) return true;
  return false;
}

function dexToPoolShape(pair, targetTokenAddress) {
  if (isConcentratedLiquidity(pair)) {
    console.log(`[DEX診断] ${pair.dexId}: 集中流動性型(V3方式)のため除外(labels=${JSON.stringify(pair.labels)}) - 今の計算式は通用しないため`);
    return null;
  }

  const liqBase = pair.liquidity?.base;
  const liqQuote = pair.liquidity?.quote;
  const priceNative = parseFloat(pair.priceNative);

  if (!liqBase || !liqQuote || !priceNative || !isFinite(priceNative)) {
    console.log(`[DEX診断] ${pair.dexId}: liquidity情報が不完全のため除外(liqBase=${liqBase}, liqQuote=${liqQuote}, priceNative=${pair.priceNative})`);
    return null;
  }

  const impliedPrice = liqQuote / liqBase;
  const deviation = Math.abs(impliedPrice - priceNative) / priceNative;
  if (deviation > 0.05) {
    console.log(`[DEX診断] ${pair.dexId}: 自己整合性チェック不合格のため除外(逆算価格=${impliedPrice.toFixed(6)}, 公表価格=${priceNative}, 乖離=${(deviation*100).toFixed(1)}%)`);
    return null;
  }

  const baseIsTarget = (pair.baseToken?.address || "").toLowerCase() === targetTokenAddress.toLowerCase();
  const reserveX = baseIsTarget ? liqBase : liqQuote;
  const reserveY = baseIsTarget ? liqQuote : liqBase;

  return {
    dexId: pair.dexId,
    pairAddress: pair.pairAddress,
    reserveX,
    reserveY,
    fee: dexGetFeeForDex(pair.dexId),
    priceUsd: pair.priceUsd,
  };
}

async function dexWatchOnePair(candidate) {
  const gasCostUsd = getGasCostForChain(candidate.chain);
  const rawPairs = await dexFetchPairsForToken(candidate.tokenA, candidate.chain, candidate.tokenB);

  const pools = rawPairs
    .map((p) => dexToPoolShape(p, candidate.tokenA))
    .filter(Boolean)
    .sort((a, b) => b.reserveX + b.reserveY - (a.reserveX + a.reserveY));

  if (pools.length < 2) return null;

  const [poolA, poolB] = pools;
  const priceA = poolA.reserveY / poolA.reserveX;
  const priceB = poolB.reserveY / poolB.reserveX;
  const [cheapPool, expensivePool] = priceA < priceB ? [poolA, poolB] : [poolB, poolA];

  const result = dexEvaluateOpportunity({
    cheapPool,
    expensivePool,
    gasCostInY: gasCostUsd,
    slippageBuffer: 0.002,
    pairLabel: `${candidate.symbol} on ${candidate.chain} (${cheapPool.dexId} -> ${expensivePool.dexId})`,
  });

  if (Math.abs(result.priceDiffPercent) > 20) {
    console.warn(`[DEX] 異常な価格差を検出、データ不備として除外 (${candidate.symbol} / ${candidate.chain}): ${result.priceDiffPercent.toFixed(1)}%`);
    return null;
  }

  return {
    ...result,
    chain: candidate.chain,
    tokenA: candidate.tokenA,
    tokenB: candidate.tokenB,
    cheapDex: cheapPool.dexId,
    expensiveDex: expensivePool.dexId,
    cheapPoolAddress: cheapPool.pairAddress,
    expensivePoolAddress: expensivePool.pairAddress,
  };
}

const DEX_PERSISTENCE_LOG_FILE = process.env.PERSISTENCE_LOG_FILE || "/tmp/dex-persistence-log.json";
const PERSISTENCE_CHECK_DELAYS_SEC = [5, 15, 30, 60];
const PERSISTENCE_TRIGGER_THRESHOLD_PCT = 0.1;

function dexLoadPersistenceLog() {
  try {
    if (fs.existsSync(DEX_PERSISTENCE_LOG_FILE)) return JSON.parse(fs.readFileSync(DEX_PERSISTENCE_LOG_FILE, "utf8"));
  } catch (e) {}
  return [];
}
function dexSavePersistenceLog(entries) {
  try {
    const trimmed = entries.length > 500 ? entries.slice(-500) : entries;
    fs.writeFileSync(DEX_PERSISTENCE_LOG_FILE, JSON.stringify(trimmed));
  } catch (e) {
    console.warn("持続性ログの保存に失敗:", e.message);
  }
}

function trackPersistence(candidate, initialResult) {
  const trackingId = `${candidate.chain}-${candidate.symbol}-${Date.now()}`;
  const record = {
    trackingId,
    pairLabel: initialResult.pairLabel,
    chain: candidate.chain,
    detectedAt: initialResult.timestamp,
    initialPriceDiffPercent: initialResult.priceDiffPercent,
    initialNetProfit: initialResult.netProfit,
    followUps: [],
  };

  console.log(`[DEX持続性] 追跡開始: ${initialResult.pairLabel}(初回ズレ${initialResult.priceDiffPercent.toFixed(2)}%) → 5/15/30/60秒後に再チェックします`);

  for (const delaySec of PERSISTENCE_CHECK_DELAYS_SEC) {
    setTimeout(async () => {
      try {
        const followUp = await dexWatchOnePair(candidate);
        const entry = followUp
          ? { delaySec, stillExists: true, priceDiffPercent: followUp.priceDiffPercent, netProfit: followUp.netProfit }
          : { delaySec, stillExists: false, priceDiffPercent: null, netProfit: null };
        record.followUps.push(entry);
        console.log(`[DEX持続性] ${initialResult.pairLabel} の${delaySec}秒後: ${entry.stillExists ? `まだ残っている(ズレ${entry.priceDiffPercent.toFixed(2)}%)` : "消えていた"}`);

        if (delaySec === PERSISTENCE_CHECK_DELAYS_SEC[PERSISTENCE_CHECK_DELAYS_SEC.length - 1]) {
          const log = dexLoadPersistenceLog();
          log.push(record);
          dexSavePersistenceLog(log);
        }
      } catch (e) {
        console.warn(`[DEX持続性] 再チェック失敗(${delaySec}秒後):`, e.message);
      }
    }, delaySec * 1000);
  }
}

function getPersistenceSummary() {
  const log = dexLoadPersistenceLog();
  if (log.length === 0) return null;

  const summary = PERSISTENCE_CHECK_DELAYS_SEC.map((delaySec) => {
    const withThisDelay = log
      .map((r) => r.followUps.find((f) => f.delaySec === delaySec))
      .filter(Boolean);
    const stillExisting = withThisDelay.filter((f) => f.stillExists).length;
    return {
      delaySec,
      total: withThisDelay.length,
      stillExisting,
      survivalRate: withThisDelay.length > 0 ? (stillExisting / withThisDelay.length) * 100 : null,
    };
  });

  return { trackedCount: log.length, byDelay: summary };
}

const DEX_PROSPECT_REFRESH_INTERVAL_MS = 60 * 60 * 1000;

let dexCachedCandidates = [];
let dexCandidateRotationOffset = 0;
const poolAddressToCandidate = new Map();
let onchainReactionCount = 0;
let onchainLatencyLog = [];

async function handleOnchainSync(chainName, poolAddress, reserve0, reserve1, receivedAt) {
  const entry = poolAddressToCandidate.get(poolAddress);
  if (!entry) return;
  try {
    const observed = await dexWatchOnePair(entry.candidate);
    const latencyMs = Date.now() - receivedAt;
    onchainReactionCount++;
    onchainLatencyLog.push(latencyMs);
    if (onchainLatencyLog.length > 200) onchainLatencyLog.shift();

    if (observed) {
      latestDexResults = [observed, ...latestDexResults].slice(0, 30);
      const log = dexLoadLog();
      log.push({ ...observed, viaOnchainEvent: true, reactionLatencyMs: latencyMs });
      dexSaveLog(log);
      console.log(`[オンチェーン反応] ${observed.pairLabel}: Sync検知から${latencyMs}ms後に再評価完了(ズレ${observed.priceDiffPercent.toFixed(2)}%、純利益${observed.netProfit>=0?'+':''}$${observed.netProfit.toFixed(2)})`);
    }
  } catch (e) {
    console.warn(`[オンチェーン反応] 再評価失敗:`, e.message);
  }
}

function getOnchainLatencyStats() {
  if (onchainLatencyLog.length === 0) return null;
  const sorted = [...onchainLatencyLog].sort((a, b) => a - b);
  const avg = sorted.reduce((s, v) => s + v, 0) / sorted.length;
  const median = sorted[Math.floor(sorted.length / 2)];
  return { count: onchainReactionCount, avgMs: avg, medianMs: median, minMs: sorted[0], maxMs: sorted[sorted.length - 1] };
}

let dexLastProspectAt = 0;
let dexProspectRefreshing = false;

async function dexGetCandidates(topN) {
  const now = Date.now();
  const needsRefresh = dexCachedCandidates.length === 0 || now - dexLastProspectAt > DEX_PROSPECT_REFRESH_INTERVAL_MS;

  if (needsRefresh && !dexProspectRefreshing) {
    dexProspectRefreshing = true;
    try {
      console.log("[DEX] 候補ペアを再選定中(DeFiLlama全件取得。数十秒かかることがあります)...");
      const prospect = await runProspect({ minTvlUSD: 20000, topN: 30 });
      dexCachedCandidates = prospect.topPairs;
      dexLastProspectAt = now;
      dexCandidateRotationOffset = 0;
      console.log(`[DEX] 候補ペア再選定完了: ${dexCachedCandidates.length}件`);
    } catch (e) {
      console.error("[DEX] 候補ペア選定に失敗(前回のキャッシュを使い続けます):", e.message);
    } finally {
      dexProspectRefreshing = false;
    }
  }

  const total = dexCachedCandidates.length;
  if (total === 0) return [];

  // 毎回同じ上位N件だけを見るのではなく、キャッシュ済みの全候補を
  // 順番にローテーションして観測する。こうすることでDeFiLlamaへの
  // 追加リクエストなしに、1時間待たず短時間で全候補を一巡できる。
  const batchSize = Math.min(topN, total);
  const start = dexCandidateRotationOffset % total;
  const selected = [];
  for (let i = 0; i < batchSize; i++) {
    selected.push(dexCachedCandidates[(start + i) % total]);
  }
  dexCandidateRotationOffset = (start + batchSize) % total;

  return selected;
}

async function runWatchCycle({ topN = 8 } = {}) {
  console.log("[DEX] 観測サイクル開始");
  const candidates = await dexGetCandidates(topN);

  if (candidates.length === 0) {
    console.log("[DEX] 候補ペアがまだありません(初回の選定待ち、または失敗)");
    return { scannedAt: new Date().toISOString(), checked: 0, logged: 0, results: [] };
  }

  const log = dexLoadLog();
  const results = [];

  for (const candidate of candidates) {
    try {
      const observed = await dexWatchOnePair(candidate);
      if (observed) {
        results.push(observed);
        log.push(observed);
        if (Math.abs(observed.priceDiffPercent) >= PERSISTENCE_TRIGGER_THRESHOLD_PCT) {
          trackPersistence(candidate, observed);
        }
        if (observed.cheapPoolAddress && observed.expensivePoolAddress) {
          poolAddressToCandidate.set(observed.cheapPoolAddress, { candidate });
          poolAddressToCandidate.set(observed.expensivePoolAddress, { candidate });
          updatePoolSubscriptions(candidate.chain, [observed.cheapPoolAddress, observed.expensivePoolAddress]);
        }
      }
    } catch (e) {
      console.warn(`[DEX] 観測失敗 (${candidate.symbol} / ${candidate.chain}):`, e.message);
    }
  }

  dexSaveLog(log);
  console.log(`[DEX] 観測サイクル完了: 対象${candidates.length}件・記録${results.length}件・黒字${results.filter(r=>r.profitable).length}件`);

  return {
    scannedAt: new Date().toISOString(),
    checked: candidates.length,
    logged: results.length,
    results,
  };
}

function getRecentObservations(n = 50) {
  return dexLoadLog().slice(-n).reverse();
}

const BINANCE_SAMPLE_INTERVAL_SEC = parseInt(process.env.BINANCE_SAMPLE_INTERVAL_SEC || "2", 10);
const TWAP_CHECK_INTERVAL_SEC = parseInt(process.env.TWAP_CHECK_INTERVAL_SEC || "5", 10);
const LOGIC_CHECK_INTERVAL_SEC = parseInt(process.env.LOGIC_CHECK_INTERVAL_SEC || "60", 10);
const RESOLVE_CHECK_INTERVAL_SEC = parseInt(process.env.RESOLVE_CHECK_INTERVAL_SEC || "30", 10);
const EDGE_THRESHOLD = parseFloat(process.env.EDGE_THRESHOLD || "0.05");
const DEX_WATCH_INTERVAL_SEC = parseInt(process.env.DEX_WATCH_INTERVAL_SEC || "180", 10);

let latestTwapSignals = [];
let latestLogicSignals = [];
let lastError = null;
let sampleCount = 0;
let twapCheckCount = 0;

let cachedMarkets = [];

let twapCheckRunning = false;
let lastTwapCheckAt = 0;
const MIN_CHECK_INTERVAL_MS = 500;

const recordedMarketIds = new Set();
const MAX_RECORDED_IDS = 2000;
const marketIdToUpTokenId = new Map();

let dexWatchRunning = false;
let dexWatchCount = 0;
let lastDexWatchAt = null;
let lastDexError = null;
let latestDexResults = [];

async function twapCheckOnce() {
  const now = Date.now();
  if (twapCheckRunning || now - lastTwapCheckAt < MIN_CHECK_INTERVAL_MS) return;
  twapCheckRunning = true;
  lastTwapCheckAt = now;
  try {
    const results = [];
    for (const m of cachedMarkets) {
      const r = await analyzeMarket(m);
      if (r) { results.push(r); marketIdToUpTokenId.set(r.marketId, m.upTokenId); }
      checkComplementArb(m);
    }
    latestTwapSignals = results;
    twapCheckCount++;

    for (const r of results) {
      if (Math.abs(r.edge) < EDGE_THRESHOLD) continue;
      if (recordedMarketIds.has(r.marketId)) continue;
      recordedMarketIds.add(r.marketId);
      if (recordedMarketIds.size > MAX_RECORDED_IDS) {
        const oldest = recordedMarketIds.values().next().value;
        recordedMarketIds.delete(oldest);
      }
      const side = r.edge > 0 ? "UP" : "DOWN";
      const midpointPrice = side === "UP" ? r.marketPrice : 1 - r.marketPrice;
      const realisticPrice = side === "UP" ? r.bestAsk : (r.bestBid !== null ? 1 - r.bestBid : null);
      const entryPrice = realisticPrice ?? midpointPrice;
      const resolveAtMs = Date.now() + Math.max(r.remainingSec, 1) * 1000 + 15000;
      recordSignal("twap-oracle", side, entryPrice, resolveAtMs, {
        marketId: r.marketId, question: r.question, edge: r.edge,
        predictedProbUp: r.ourEstimate,
        remainingSecAtEntry: r.remainingSec, usedRealisticPrice: realisticPrice !== null,
        marketPriceAgeSecAtEntry: r.marketPriceAgeSec,
        upTokenIdForBacktest: marketIdToUpTokenId.get(r.marketId) ?? null,
      });
      console.log(`[TWAP] ${r.question}: 我々の推定${(r.ourEstimate*100).toFixed(1)}% vs 市場${(r.marketPrice*100).toFixed(1)}%(${r.marketPriceAgeSec?.toFixed(1)}秒前) ` +
        `(ズレ${(r.edge*100).toFixed(1)}pt, 残り${r.remainingSec}秒) → ${side}に紙上ベット記録`);
    }
  } catch (e) {
    lastError = e.message;
    console.error("TWAP観測エラー:", e.message);
  } finally {
    twapCheckRunning = false;
  }
}

async function logicCheckOnce() {
  if (WATCHED_PAIRS.length === 0) return;
  try {
    const results = await checkLogicalConstraints();
    latestLogicSignals = results;
    for (const r of results) {
      if (!r.violated || r.magnitude < EDGE_THRESHOLD) continue;
      const resolveAtMs = Date.now() + 24 * 60 * 60 * 1000;
      recordSignal("logic-checker", "A", r.marketA.yesPrice, resolveAtMs, {
        label: r.label, edge: r.magnitude, marketA: r.marketA.slug, marketB: r.marketB.slug,
      });
      console.log(`[論理矛盾] ${r.label}: 矛盾を検出(差${(r.magnitude*100).toFixed(1)}pt) → 紙上ベット記録`);
    }
  } catch (e) {
    console.error("論理矛盾チェックエラー:", e.message);
  }
}

async function resolveOnce() {
  await resolveOpenPositions(async (pos) => {
    try {
      const res = await fetch(`https://gamma-api.polymarket.com/markets/${pos.meta.marketId}`);
      if (!res.ok) return { outcome: null };
      const m = await res.json();
      if (!m.closed) return { outcome: null };
      const prices = m.outcomePrices ? JSON.parse(m.outcomePrices) : null;
      if (!prices) return { outcome: null };
      const upWon = parseFloat(prices[0]) > 0.5;
      if (pos.meta.upTokenIdForBacktest) {
        checkBacktestFeasibility(pos.meta.upTokenIdForBacktest, new Date(m.endDate).getTime());
      }
      return { outcome: upWon ? "UP" : "DOWN" };
    } catch (e) {
      return { outcome: null };
    }
  });
}

async function dexWatchOnce() {
  if (dexWatchRunning) return;
  dexWatchRunning = true;
  try {
    const result = await runWatchCycle({ topN: 8 });
    latestDexResults = result.results;
    dexWatchCount++;
    lastDexWatchAt = new Date().toISOString();

    const profitable = result.results.filter((r) => r.profitable);
    if (profitable.length > 0) {
      for (const r of profitable) {
        console.log(`[DEX] ${r.pairLabel}: 純利益 +$${r.netProfit.toFixed(2)}(価格差${r.priceDiffPercent.toFixed(2)}%)`);
      }
    } else {
      console.log(`[DEX] 観測${result.checked}件・記録${result.logged}件・黒字0件`);
    }
  } catch (e) {
    lastDexError = e.message;
    console.error("DEX観測エラー:", e.message);
  } finally {
    dexWatchRunning = false;
  }
}

function renderPage() {
  const twapStats = getStats("twap-oracle");
  const logicStats = getStats("logic-checker");
  const complementArbs = getDetectedComplementArbs();
  const recentTrades = getRecentResolved(15);

  const twapRows = latestTwapSignals.slice(0, 15).map((r, i) => {
    const color = Math.abs(r.edge) >= EDGE_THRESHOLD ? (r.edge > 0 ? "#2ecc71" : "#e74c3c") : "#888";
    return `<tr><td>${i+1}</td><td>${r.asset}</td>
    <td style="font-size:9px;">${r.question.slice(0,30)}</td>
    <td style="text-align:right;">${r.remainingSec}秒</td>
    <td style="text-align:right;">${(r.ourEstimate*100).toFixed(1)}%</td>
    <td style="text-align:right;">${(r.marketPrice*100).toFixed(1)}%</td>
    <td style="text-align:right;color:${color};font-weight:600;">${r.edge>=0?'+':''}${(r.edge*100).toFixed(1)}pt</td></tr>`;
  }).join("") || `<tr><td colspan="7" style="color:#888;">観測データがまだありません(市場を待機中)</td></tr>`;

  const tradeRows = recentTrades.map((t, i) => {
    const color = t.won ? "#2ecc71" : "#e74c3c";
    return `<tr><td>${i+1}</td><td>${t.strategy}</td><td style="font-size:9px;">${(t.meta?.question||t.meta?.label||'').slice(0,25)}</td>
    <td style="text-align:right;">${t.side}</td>
    <td style="text-align:center;color:${color};">${t.won?'勝ち':'負け'}</td>
    <td style="text-align:right;color:${t.netPnl>=0?'#2ecc71':'#e74c3c'};">${t.netPnl>=0?'+':''}${(t.netPnl*100).toFixed(1)}pt</td></tr>`;
  }).join("") || `<tr><td colspan="6" style="color:#888;">まだ確定した紙上取引はありません</td></tr>`;

  const dexObservations = getRecentObservations(500);
  const dexProfitableAll = dexObservations.filter((r) => r.profitable);
  const dexBest = dexObservations.reduce((best, r) => (!best || r.netProfit > best.netProfit ? r : best), null);
  const persistenceSummary = getPersistenceSummary();
  const onchainLatencyStats = getOnchainLatencyStats();

  const dexRows = latestDexResults.slice(0, 15).map((r, i) => {
    const color = r.profitable ? "#2ecc71" : "#888";
    return `<tr><td>${i+1}</td><td style="font-size:9px;">${r.pairLabel}</td>
    <td style="text-align:right;">${r.priceDiffPercent.toFixed(2)}%</td>
    <td style="text-align:right;color:${color};font-weight:600;">${r.netProfit>=0?'+':''}$${r.netProfit.toFixed(2)}</td></tr>`;
  }).join("") || `<tr><td colspan="4" style="color:#888;">観測データがまだありません(次のサイクルを待機中)</td></tr>`;

  return `<!DOCTYPE html><html lang="ja"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1.0"><meta http-equiv="refresh" content="30">
<title>予測市場の歪み観測所</title><style>
body{font-family:-apple-system,sans-serif;background:#0d100c;color:#e8e6d8;margin:0;padding:18px 12px;}
h1{font-size:17px;margin:0 0 4px;} h2{font-size:13px;margin:0 0 10px;font-weight:600;}
.sub{color:#888;font-size:11px;margin-bottom:16px;}
.card{background:#14180f;border:1px solid #2a331d;border-radius:8px;padding:13px;margin-bottom:13px;}
table{width:100%;border-collapse:collapse;font-size:11px;}
th{text-align:left;color:#888;font-weight:500;font-size:9.5px;padding:5px 3px;border-bottom:1px solid #2a331d;}
td{padding:6px 3px;border-bottom:1px solid #1c1c1c;}
.note{font-size:10px;color:#888;line-height:1.6;margin-top:9px;padding-top:9px;border-top:1px solid #222;}
.stat{display:grid;grid-template-columns:repeat(4,1fr);gap:6px;margin-bottom:13px;}
.stat div{background:#14180f;border:1px solid #2a331d;border-radius:8px;padding:11px 4px;text-align:center;}
.stat .v{font-size:17px;font-weight:600;} .stat .l{font-size:8.5px;color:#888;margin-top:2px;}
</style></head><body>
<h1>🎯 予測市場の歪み観測所</h1>
<div class="sub">紙上取引のみ(実際の注文は出しません) / 観測${sampleCount}回・TWAPチェック${twapCheckCount}回・DEX観測${dexWatchCount}回</div>

<div class="card">
  <h2>🔍 DEXアービトラージ観測(Base等)</h2>
  <div class="stat">
    <div><div class="v">${dexObservations.length}</div><div class="l">記録件数</div></div>
    <div><div class="v" style="color:${dexProfitableAll.length>0?'#2ecc71':'#888'};">${dexProfitableAll.length}</div><div class="l">黒字だった件数</div></div>
    <div><div class="v" style="color:${dexBest && dexBest.netProfit>=0?'#2ecc71':'#e74c3c'};">${dexBest ? (dexBest.netProfit>=0?'+':'')+'$'+dexBest.netProfit.toFixed(2) : '-'}</div><div class="l">最高純利益</div></div>
    <div><div class="v">${lastDexWatchAt ? new Date(lastDexWatchAt).toLocaleTimeString('ja-JP') : '-'}</div><div class="l">最終観測時刻</div></div>
  </div>
  <table><thead><tr><th>#</th><th>ペア</th><th style="text-align:right;">価格差</th><th style="text-align:right;">純利益</th></tr></thead>
  <tbody>${dexRows}</tbody></table>
  <div class="note">
    prospector.jsが選んだ候補ペアを、DexScreenerのデータで観測 → ガス代・手数料込みの純利益を計算して記録。<br>
    実際の注文は出していません(紙上観測のみ)。${lastDexError ? `<br><span style="color:#e74c3c;">エラー: ${lastDexError}</span>` : ''}
  </div>
</div>

${persistenceSummary ? `<div class="card">
  <h2>⏱️ 歪みの持続性(最重要データ)</h2>
  <table><thead><tr><th>経過時間</th><th style="text-align:right;">追跡件数</th><th style="text-align:right;">まだ残っていた割合</th></tr></thead>
  <tbody>${persistenceSummary.byDelay.map(d => `<tr><td>${d.delaySec}秒後</td><td style="text-align:right;">${d.total}</td>
    <td style="text-align:right;color:${d.survivalRate!==null && d.survivalRate>50?'#2ecc71':'#e74c3c'};">${d.survivalRate!==null ? d.survivalRate.toFixed(0)+'%' : '-'}</td></tr>`).join('')}</tbody></table>
  <div class="note">
    検知した歪みが、その後も残っていたかを実測(追跡件数${persistenceSummary.trackedCount}件)。<br>
    60秒後の残存率が低ければ、今の3分間隔の観測では間に合わない証拠。高ければ、この間隔でも十分捕まえられる可能性がある。
  </div>
</div>` : ''}

${onchainLatencyStats ? `<div class="card">
  <h2>⚡ オンチェーン反応速度</h2>
  <div class="stat">
    <div><div class="v">${onchainLatencyStats.count}</div><div class="l">反応回数</div></div>
    <div><div class="v">${onchainLatencyStats.medianMs.toFixed(0)}ms</div><div class="l">中央値</div></div>
    <div><div class="v">${onchainLatencyStats.minMs.toFixed(0)}ms</div><div class="l">最速</div></div>
    <div><div class="v">${onchainLatencyStats.maxMs.toFixed(0)}ms</div><div class="l">最遅</div></div>
  </div>
  <div class="note">Syncイベントを検知してから、再評価が完了するまでの実測時間。3分間隔のポーリングと比べ、どれだけ速く反応できているかの指標。</div>
</div>` : ''}

<div class="card">
  <h2>📈 TWAPオラクル戦略 成績</h2>
  <div class="stat">
    <div><div class="v">${twapStats.count}</div><div class="l">確定件数</div></div>
    <div><div class="v" style="color:${twapStats.winRate>=50?'#2ecc71':'#e74c3c'};">${twapStats.winRate.toFixed(0)}%</div><div class="l">勝率</div></div>
    <div><div class="v" style="color:${twapStats.totalNetPnl>=0?'#2ecc71':'#e74c3c'};">${twapStats.totalNetPnl>=0?'+':''}${(twapStats.totalNetPnl*100).toFixed(1)}pt</div><div class="l">累積純損益</div></div>
    <div><div class="v">${getOpenCount()}</div><div class="l">確認待ち</div></div>
  </div>
  <div class="note">
    純損益は「1単位を賭け続けた場合」の確率ポイント換算。手数料相当(往復2%)は既に控除済み。<br>
    実際の板情報(Bid/Ask)が取れた場合はそちらを使い、無ければ中間値で代用。<br>
    プラスが続けば戦略に優位性がある可能性、マイナスが続けば見送るべき。
  </div>
  ${twapStats.brierScore !== null ? `<div class="note">
    <b>Brierスコア: ${twapStats.brierScore.toFixed(3)}</b>(0に近いほど精度が高い。0.25=当てずっぽう、0.20=まずまず、0.12〜0.18=予測市場の集合知レベル)
  </div>` : ''}
</div>

${twapStats.edgeBuckets?.some(b => b.count > 0) ? `<div class="card">
  <h2>ズレの大きさ別 勝率(較正の確認)</h2>
  <table><thead><tr><th>区分</th><th style="text-align:right;">件数</th><th style="text-align:right;">勝率</th></tr></thead>
  <tbody>${twapStats.edgeBuckets.map(b => `<tr><td>${b.label}</td><td style="text-align:right;">${b.count}</td>
    <td style="text-align:right;">${b.winRate !== null ? b.winRate.toFixed(0)+'%' : '-'}</td></tr>`).join('')}</tbody></table>
  <div class="note">ズレが大きい区分ほど勝率も高くなっているのが理想。そうなっていなければ推定ロジックの見直しが必要。</div>
</div>` : ''}

${twapStats.timeBuckets?.some(b => b.count > 0) ? `<div class="card">
  <h2>判定時の残り時間別 勝率</h2>
  <table><thead><tr><th>区分</th><th style="text-align:right;">件数</th><th style="text-align:right;">勝率</th></tr></thead>
  <tbody>${twapStats.timeBuckets.map(b => `<tr><td>${b.label}</td><td style="text-align:right;">${b.count}</td>
    <td style="text-align:right;">${b.winRate !== null ? b.winRate.toFixed(0)+'%' : '-'}</td></tr>`).join('')}</tbody></table>
  <div class="note">残り時間が短い(確定に近い)ほど勝率が高いのが理想。</div>
</div>` : ''}

${twapStats.priceAgeBuckets?.some(b => b.count > 0) ? `<div class="card">
  <h2>市場価格の「古さ」別 勝率</h2>
  <table><thead><tr><th>区分</th><th style="text-align:right;">件数</th><th style="text-align:right;">勝率</th></tr></thead>
  <tbody>${twapStats.priceAgeBuckets.map(b => `<tr><td>${b.label}</td><td style="text-align:right;">${b.count}</td>
    <td style="text-align:right;">${b.winRate !== null ? b.winRate.toFixed(0)+'%' : '-'}</td></tr>`).join('')}</tbody></table>
  <div class="note">古い価格の区分ほど勝率が高ければ「反応遅れを突けている」証拠。差が無ければ単なる逆張りの疑い。</div>
</div>` : ''}

${complementArbs.length > 0 ? `<div class="card">
  <h2>💎 コンプリメント裁定(理論上ノーリスク)</h2>
  <div class="stat">
    <div><div class="v">${complementArbs.length}</div><div class="l">検出件数</div></div>
    <div><div class="v" style="color:#2ecc71;">${(complementArbs.reduce((s,a)=>s+a.margin,0)*100).toFixed(1)}%</div><div class="l">合計利益余地</div></div>
  </div>
  <table><thead><tr><th>#</th><th>市場</th><th style="text-align:right;">UP</th><th style="text-align:right;">DOWN</th><th style="text-align:right;">利益余地</th></tr></thead>
  <tbody>${complementArbs.slice(0,10).map((a,i) => `<tr><td>${i+1}</td><td style="font-size:9px;">${a.question.slice(0,25)}</td>
    <td style="text-align:right;">${a.upAsk.toFixed(3)}</td><td style="text-align:right;">${a.downAsk.toFixed(3)}</td>
    <td style="text-align:right;color:#2ecc71;">+${(a.margin*100).toFixed(1)}%</td></tr>`).join('')}</tbody></table>
  <div class="note">UP+DOWNの合計が$1未満のため、両方買ってMergeすれば結果に関わらず利益が出る、理論上ノーリスクな機会。</div>
</div>` : ''}

<div class="card">
  <h2>今この瞬間の観測(TWAPオラクル)</h2>
  <table><thead><tr><th>#</th><th>資産</th><th>市場</th><th style="text-align:right;">残り</th><th style="text-align:right;">推定確率</th><th style="text-align:right;">市場価格</th><th style="text-align:right;">ズレ</th></tr></thead>
  <tbody>${twapRows}</tbody></table>
</div>

<div class="card">
  <h2>📐 論理矛盾チェッカー 成績</h2>
  <div class="stat">
    <div><div class="v">${logicStats.count}</div><div class="l">確定件数</div></div>
    <div><div class="v" style="color:${logicStats.winRate>=50?'#2ecc71':'#e74c3c'};">${logicStats.winRate.toFixed(0)}%</div><div class="l">勝率</div></div>
    <div><div class="v" style="color:${logicStats.totalNetPnl>=0?'#2ecc71':'#e74c3c'};">${logicStats.totalNetPnl>=0?'+':''}${(logicStats.totalNetPnl*100).toFixed(1)}pt</div><div class="l">累積純損益</div></div>
    <div><div class="v">${WATCHED_PAIRS.length}</div><div class="l">監視ペア数</div></div>
  </div>
  ${WATCHED_PAIRS.length === 0 ? `<div class="note" style="color:#e67e22;">監視ペアが未登録です。logic-checker.jsのWATCHED_PAIRSに、実際に見つけた関連市場ペアを追加してください。</div>` : ''}
</div>

<div class="card">
  <h2>直近の紙上取引結果</h2>
  <table><thead><tr><th>#</th><th>戦略</th><th>内容</th><th>方向</th><th style="text-align:center;">結果</th><th style="text-align:right;">損益</th></tr></thead>
  <tbody>${tradeRows}</tbody></table>
</div>

<div class="card">
  <div class="note">
    TWAP方式: Polymarketの5分/15分BTC/ETH市場は、終了直前30秒/60秒の平均価格で決済される(2026年8月〜)。<br>
    Binance価格を継続記録し、残り時間内に平均が逆転する余地をボラティリティから見積もっている。<br>
    ${lastError ? `<span style="color:#e74c3c;">エラー: ${lastError}</span>` : ''}
  </div>
</div>
</body></html>`;
}

function startServer() {
  const port = process.env.PORT || 8080;
  http.createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(renderPage());
  }).listen(port, () => console.log(`観測所ページ: ポート${port}`));
}

let currentTokenIds = [];

async function refreshMarketSubscriptions() {
  try {
    const markets = await fetchActiveShortDurationMarkets();
    cachedMarkets = markets;
    const tokenIds = markets.flatMap((m) => m.clobTokenIds || []);
    if (tokenIds.length > 0) {
      updatePolymarketSubscription(tokenIds);
      currentTokenIds = tokenIds;
    }
  } catch (e) {
    console.error("市場購読の更新に失敗:", e.message);
  }
}

async function main() {
  console.log("=== 予測市場の歪み観測所(WebSocketリアルタイム版) 起動 ===");
  console.log(`監視ペア数(論理矛盾): ${WATCHED_PAIRS.length}`);
  startServer();

  await diagnoseSources();
  await sampleBinancePrices();

  let gotAnyPriceTick = false;
  const onPriceTick = (asset, price, timestamp) => {
    gotAnyPriceTick = true;
    recordPriceTick(asset, price, timestamp);
    sampleCount++;
    twapCheckOnce();
  };
  startBybitFeed(onPriceTick);
  setTimeout(() => {
    if (!gotAnyPriceTick) {
      console.log("[価格フィード] Bybitから15秒間データが無いため、OKXに切り替えます");
      startOkxFeed(onPriceTick);
    }
  }, 15000);

  startPolymarketFeed(
    (tokenId, price, timestamp) => {
      recordPolymarketTick(tokenId, price, timestamp);
      if (currentTokenIds.includes(tokenId)) twapCheckOnce();
    },
    (tokenId, bestBid, bestAsk) => {
      recordPolymarketBook(tokenId, bestBid, bestAsk);
    }
  );

  await refreshMarketSubscriptions();
  setInterval(refreshMarketSubscriptions, 60 * 1000);

  setInterval(logicCheckOnce, LOGIC_CHECK_INTERVAL_SEC * 1000);
  setInterval(resolveOnce, RESOLVE_CHECK_INTERVAL_SEC * 1000);

  dexWatchOnce();
  setInterval(dexWatchOnce, DEX_WATCH_INTERVAL_SEC * 1000);

  startOnchainFeeds(handleOnchainSync);
}

main().catch((e) => { console.error("致命的エラー:", e); process.exit(1); });
