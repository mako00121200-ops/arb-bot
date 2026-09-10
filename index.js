import http from "http";
import fs from "fs";
import { runProspect } from "./prospector.js";
import { startOnchainFeeds, updatePoolSubscriptions } from "./dex-onchain-realtime.js";
import { runTestnetDeployCheck } from "./scripts/testnet-deploy-check.js";
import { runMainnetDeploy } from "./scripts/mainnet-deploy.js";
import { maybeExecuteArb } from "./scripts/execute-arb.js";
import { getRealExecutionStats } from "./scripts/real-execution-log.js";
import { getCurrentTradeCapUsd, getSuccessCount } from "./scripts/trade-cap.js";

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

const MAX_TRADE_USD = parseFloat(process.env.MAX_TRADE_USD || "300");
const AAVE_FLASHLOAN_FEE_RATE = 0.0005;
const MIN_MARKET_CAP_USD = 100000;

function dexGetAmountOut(amountIn, reserveIn, reserveOut, feeRetain) {
  if (amountIn <= 0) return 0;
  const amountInWithFee = amountIn * feeRetain;
  return (reserveOut * amountInWithFee) / (reserveIn + amountInWithFee);
}

function dexSimulateProfitForAmount(pool1, pool2, amountIn) {
  const xOut = dexGetAmountOut(amountIn, pool1.reserveY, pool1.reserveX, 1 - pool1.fee);
  const yOut = dexGetAmountOut(xOut, pool2.reserveX, pool2.reserveY, 1 - pool2.fee);
  return yOut - amountIn;
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

  let bestT = theoreticalAmountIn;
  let bestProfit = dexSimulateProfitForAmount(pool1, pool2, theoreticalAmountIn);

  for (let mult = 0.5; mult <= 1.5; mult += 0.01) {
    const t = theoreticalAmountIn * mult;
    const p = dexSimulateProfitForAmount(pool1, pool2, t);
    if (p > bestProfit) {
      bestProfit = p;
      bestT = t;
    }
  }

  return { amountIn: bestT, grossProfit: bestProfit, profitable: bestProfit > 0 };
}

function dexEvaluateOpportunity({ cheapPool, expensivePool, gasCostUsd, maxTradeAmountUsd, slippageBuffer = 0, pairLabel = "" }) {
  const priceCheap = cheapPool.reserveY / cheapPool.reserveX;
  const priceExpensive = expensivePool.reserveY / expensivePool.reserveX;
  const priceDiffPercent = ((priceExpensive - priceCheap) / priceCheap) * 100;

  const priceUsdPerY = cheapPool.priceUsdPerY;
  const maxTradeAmountIn = maxTradeAmountUsd / priceUsdPerY;
  const gasCostInY = gasCostUsd / priceUsdPerY;

  const optimalResult = dexComputeOptimalArbitrage(cheapPool, expensivePool);

  const actualTradeAmountIn = Math.min(optimalResult.amountIn, maxTradeAmountIn);
  const cappedByBudget = optimalResult.amountIn > maxTradeAmountIn;

  const actualGrossProfitY = dexSimulateProfitForAmount(cheapPool, expensivePool, actualTradeAmountIn);
  const actualSlippageCostY = actualGrossProfitY * slippageBuffer;
  const aaveFeeInY = actualTradeAmountIn * AAVE_FLASHLOAN_FEE_RATE;
  const actualNetProfitY = actualGrossProfitY - gasCostInY - actualSlippageCostY - aaveFeeInY;

  return {
    timestamp: new Date().toISOString(),
    pairLabel,
    priceDiffPercent,
    tradeAmountUsd: actualTradeAmountIn * priceUsdPerY,
    tradeAmountIn: actualTradeAmountIn,
    grossProfit: actualGrossProfitY * priceUsdPerY,
    gasCostInY: gasCostUsd,
    slippageCost: actualSlippageCostY * priceUsdPerY,
    aaveFeeCost: aaveFeeInY * priceUsdPerY,
    netProfit: actualNetProfitY * priceUsdPerY,
    profitable: actualNetProfitY > 0,
    optimalAmountIn: optimalResult.amountIn,
    optimalGrossProfitUsd: optimalResult.grossProfit * priceUsdPerY,
    cappedByBudget,
  };
}

const DEXSCREENER_TOKEN_API = "https://api.dexscreener.com/latest/dex/tokens/";
const DEX_LOG_FILE = process.env.WATCHER_LOG_FILE || "/tmp/dex-arb-observations.json";
const DEX_STATS_FILE = process.env.STATS_FILE || "/tmp/dex-arb-stats.json";
const KNOWN_DEX_FILE = process.env.KNOWN_DEX_FILE || "/tmp/dex-known-list.json";

// Solidly系(Aerodrome/Velodrome)のvolatileプール(x*y=k型、本システムの
// 対象)は手数料0.3%。0.05%はstableプール用の値で、以前これを誤って使い、
// 手数料を6分の1に見積もっていたため利益を過大評価していた。
const DEX_DEFAULT_FEE_BY_DEX = {
  uniswap: 0.003,
  aerodrome: 0.003,
  "aerodrome-slipstream": 0.003,
  sushiswap: 0.003,
  camelot: 0.003,
  velodrome: 0.003,
  quickswap: 0.003,
  traderjoe: 0.003,
  default: 0.003,
};

function dexGetFeeForDex(dexId) {
  return DEX_DEFAULT_FEE_BY_DEX[(dexId || "").toLowerCase()] ?? DEX_DEFAULT_FEE_BY_DEX.default;
}

function dexNormalizeChain(chain) {
  const map = {
    base: "base",
    arbitrum: "arbitrum",
    optimism: "optimism",
    "op mainnet": "optimism",
    ethereum: "ethereum",
  };
  return map[(chain || "").toLowerCase()] || (chain || "").toLowerCase();
}

const CHAIN_GAS_COST_USD = {
  base: 0.05,
  arbitrum: 0.10,
  optimism: 0.05,
  ethereum: 8.0,
  polygon: 0.05,
  avalanche: 0.05,
  bsc: 0.10,
  binance: 0.10,
  bnb: 0.10,
  flare: 0.02,
};
function getGasCostForChain(chain) {
  const key = dexNormalizeChain(chain);
  return CHAIN_GAS_COST_USD[key] ?? 0.25;
}

const DEEP_POOL_LIQUIDITY_USD = 500000;
const DEEP_POOL_MAX_GAP_PCT = 1;

const DEAD_POOL_MIN_VOLUME_USD = 50;
const DEAD_POOL_MIN_TXNS_24H = 3;
function isDeadPool(pair) {
  const volume24h = pair.volume?.h24 ?? 0;
  const txns24h = (pair.txns?.h24?.buys ?? 0) + (pair.txns?.h24?.sells ?? 0);
  return volume24h < DEAD_POOL_MIN_VOLUME_USD || txns24h < DEAD_POOL_MIN_TXNS_24H;
}

function isKnownFalsePositive({ symbol, cheapDexId, expensiveDexId, chain }) {
  const upperSymbol = (symbol || "").toUpperCase();
  if (upperSymbol.includes("USDBC")) return true;
  if (upperSymbol.includes("USDC.E") || upperSymbol.includes("USDCE")) return true;
  if (cheapDexId === "zipswap" || expensiveDexId === "zipswap") return true;

  const lowerChain = dexNormalizeChain(chain);
  if (lowerChain === "arbitrum" && (cheapDexId === "pancakeswap" || expensiveDexId === "pancakeswap")) return true;

  if ((cheapDexId || "").includes("sparkdex") || (expensiveDexId || "").includes("sparkdex")) return true;

  if ((cheapDexId || "").includes("traderjoe-v2") || (expensiveDexId || "").includes("traderjoe-v2")) return true;

  if (lowerChain === "base" && (cheapDexId === "quickswap" || expensiveDexId === "quickswap")) return true;

  return false;
}

function dexLoadKnownDexes() {
  try {
    if (fs.existsSync(KNOWN_DEX_FILE)) return JSON.parse(fs.readFileSync(KNOWN_DEX_FILE, "utf8"));
  } catch (e) {}
  return {};
}
function dexSaveKnownDexes(known) {
  try {
    fs.writeFileSync(KNOWN_DEX_FILE, JSON.stringify(known));
  } catch (e) {
    console.warn("既知DEX一覧の保存に失敗:", e.message);
  }
}
function checkAndRecordNewDex(dexId, chain) {
  if (!dexId) return;
  const key = `${chain}::${dexId}`;
  const known = dexLoadKnownDexes();
  if (known[key]) return;
  known[key] = new Date().toISOString();
  dexSaveKnownDexes(known);
  console.log(`[DEX診断] 新しいDEXを初めて検出: "${dexId}" on ${chain} — 実在確認・信頼性の調査を推奨`);
}

function dexLoadLog() {
  try {
    if (fs.existsSync(DEX_LOG_FILE)) {
      const entries = JSON.parse(fs.readFileSync(DEX_LOG_FILE, "utf8"));
      return entries.filter((e) => {
        if (e.cheapDex === e.expensiveDex) return false;
        if (isKnownFalsePositive({ symbol: e.pairLabel, cheapDexId: e.cheapDex, expensiveDexId: e.expensiveDex, chain: e.chain })) return false;
        const bothDeep = (e.cheapPoolLiquidityUsd ?? 0) >= DEEP_POOL_LIQUIDITY_USD
          && (e.expensivePoolLiquidityUsd ?? 0) >= DEEP_POOL_LIQUIDITY_USD;
        if (bothDeep && Math.abs(e.priceDiffPercent) > DEEP_POOL_MAX_GAP_PCT) return false;
        return true;
      });
    }
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

function dexLoadStats() {
  try {
    if (fs.existsSync(DEX_STATS_FILE)) return JSON.parse(fs.readFileSync(DEX_STATS_FILE, "utf8"));
  } catch (e) {}
  const existing = dexLoadLog();
  const profitable = existing.filter((r) => r.profitable);
  const seeded = {
    totalObserved: existing.length,
    totalProfitableCount: profitable.length,
    cumulativeProfit: profitable.reduce((s, r) => s + r.netProfit, 0),
  };
  dexSaveStats(seeded);
  return seeded;
}
function dexSaveStats(stats) {
  try {
    fs.writeFileSync(DEX_STATS_FILE, JSON.stringify(stats));
  } catch (e) {
    console.warn("累積統計の保存に失敗:", e.message);
  }
}
function dexRecordStats(observed) {
  const stats = dexLoadStats();
  stats.totalObserved = (stats.totalObserved || 0) + 1;
  if (observed.profitable) {
    stats.totalProfitableCount = (stats.totalProfitableCount || 0) + 1;
    stats.cumulativeProfit = (stats.cumulativeProfit || 0) + observed.netProfit;
  }
  dexSaveStats(stats);
}

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
  console.log(`[DEX診断] candidate.chain="${chain}" → 正規化後="${targetChain}" / DexScreener取得件数=${allPairs.length}件 / フィルター後=${filtered.length}件(うちDEX一覧: ${JSON.stringify([...new Set(filtered.map(p=>p.dexId))])})`);

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

function dexToPoolShape(pair, targetTokenAddress, chain) {
  checkAndRecordNewDex(pair.dexId, chain);

  if (isConcentratedLiquidity(pair)) {
    console.log(`[DEX診断] ${pair.dexId}: 集中流動性型(V3方式)のため除外(labels=${JSON.stringify(pair.labels)})`);
    return null;
  }

  if (isDeadPool(pair)) {
    const volume24h = pair.volume?.h24 ?? 0;
    const txns24h = (pair.txns?.h24?.buys ?? 0) + (pair.txns?.h24?.sells ?? 0);
    console.log(`[DEX診断] ${pair.dexId}: 取引がほぼ枯れているため除外(24時間出来高=$${volume24h.toFixed(2)}, 取引件数=${txns24h}件)`);
    return null;
  }

  const marketCap = pair.marketCap ?? pair.fdv;
  if (marketCap != null && marketCap < MIN_MARKET_CAP_USD) {
    console.log(`[DEX診断] ${pair.dexId}: 時価総額$${Math.round(marketCap).toLocaleString()}が小さすぎるため除外(基準$${MIN_MARKET_CAP_USD.toLocaleString()})`);
    return null;
  }

  const liqBase = pair.liquidity?.base;
  const liqQuote = pair.liquidity?.quote;
  const priceNative = parseFloat(pair.priceNative);

  if (!liqBase || !liqQuote || !priceNative || !isFinite(priceNative)) {
    console.log(`[DEX診断] ${pair.dexId}: liquidity情報が不完全のため除外`);
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

  const basePriceUsd = parseFloat(pair.priceUsd);
  let priceUsdPerY = null;
  if (isFinite(basePriceUsd) && basePriceUsd > 0) {
    const quotePriceUsd = basePriceUsd / priceNative;
    priceUsdPerY = baseIsTarget ? quotePriceUsd : basePriceUsd;
  }

  return {
    dexId: pair.dexId,
    pairAddress: pair.pairAddress,
    reserveX,
    reserveY,
    fee: dexGetFeeForDex(pair.dexId),
    priceUsd: pair.priceUsd,
    liquidityUsd: (pair.liquidity?.usd ?? null),
    priceUsdPerY,
  };
}

async function dexWatchOnePair(candidate) {
  const gasCostUsd = getGasCostForChain(candidate.chain);
  const rawPairs = await dexFetchPairsForToken(candidate.tokenA, candidate.chain, candidate.tokenB);

  const pools = rawPairs
    .map((p) => dexToPoolShape(p, candidate.tokenA, candidate.chain))
    .filter(Boolean)
    .sort((a, b) => b.reserveX + b.reserveY - (a.reserveX + a.reserveY));

  if (pools.length < 2) return null;

  const [poolA, poolB] = pools;

  if (poolA.dexId === poolB.dexId) {
    console.log(`[DEX診断] ${candidate.symbol} on ${candidate.chain}: 同じDEX名同士(${poolA.dexId})のため除外`);
    return null;
  }

  if (isKnownFalsePositive({ symbol: candidate.symbol, cheapDexId: poolA.dexId, expensiveDexId: poolB.dexId, chain: candidate.chain })) {
    console.log(`[DEX診断] ${candidate.symbol} on ${candidate.chain}: 調査により「見せかけの歪み」と確定済みのため除外`);
    return null;
  }

  const priceA = poolA.reserveY / poolA.reserveX;
  const priceB = poolB.reserveY / poolB.reserveX;
  const [cheapPool, expensivePool] = priceA < priceB ? [poolA, poolB] : [poolB, poolA];

  if (!cheapPool.priceUsdPerY || !isFinite(cheapPool.priceUsdPerY) || cheapPool.priceUsdPerY <= 0) {
    console.log(`[DEX診断] ${candidate.symbol} on ${candidate.chain}: USD換算価格が取得できないため除外`);
    return null;
  }

  const result = dexEvaluateOpportunity({
    cheapPool,
    expensivePool,
    gasCostUsd,
    maxTradeAmountUsd: MAX_TRADE_USD,
    slippageBuffer: 0.002,
    pairLabel: `${candidate.symbol} on ${candidate.chain} (${cheapPool.dexId} -> ${expensivePool.dexId})`,
  });

  if (Math.abs(result.priceDiffPercent) > 20) {
    console.warn(`[DEX] 異常な価格差を検出、データ不備として除外 (${candidate.symbol} / ${candidate.chain}): ${result.priceDiffPercent.toFixed(1)}%`);
    return null;
  }

  const bothPoolsDeep = (cheapPool.liquidityUsd ?? 0) >= DEEP_POOL_LIQUIDITY_USD
    && (expensivePool.liquidityUsd ?? 0) >= DEEP_POOL_LIQUIDITY_USD;
  if (bothPoolsDeep && Math.abs(result.priceDiffPercent) > DEEP_POOL_MAX_GAP_PCT) {
    console.warn(`[DEX] 両プールとも流動性十分なのに価格差${result.priceDiffPercent.toFixed(2)}%は不自然、データ不備として除外`);
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
    cheapPoolLiquidityUsd: cheapPool.liquidityUsd,
    expensivePoolLiquidityUsd: expensivePool.liquidityUsd,
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
  const record = {
    trackingId: `${candidate.chain}-${candidate.symbol}-${Date.now()}`,
    pairLabel: initialResult.pairLabel,
    chain: candidate.chain,
    detectedAt: initialResult.timestamp,
    initialPriceDiffPercent: initialResult.priceDiffPercent,
    initialNetProfit: initialResult.netProfit,
    followUps: [],
  };

  console.log(`[DEX持続性] 追跡開始: ${initialResult.pairLabel}(初回ズレ${initialResult.priceDiffPercent.toFixed(2)}%)`);

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
      dexRecordStats(observed);
      console.log(`[オンチェーン反応] ${observed.pairLabel}: Sync検知から${latencyMs}ms後に再評価完了(純利益${observed.netProfit>=0?'+':''}$${observed.netProfit.toFixed(2)})`);
      if (observed.profitable) {
        try {
          await maybeExecuteArb(observed);
        } catch (e) {
          console.warn(`[実行判定] ${observed.pairLabel}: エラー:`, e.message);
        }
      }
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
      console.log("[DEX] 候補ペアを再選定中...");
      const prospect = await runProspect({ minTvlUSD: 5000, topN: 60 });
      dexCachedCandidates = prospect.topPairs;
      dexLastProspectAt = now;
      dexCandidateRotationOffset = 0;
      console.log(`[DEX] 候補ペア再選定完了: ${dexCachedCandidates.length}件`);
    } catch (e) {
      console.error("[DEX] 候補ペア選定に失敗:", e.message);
    } finally {
      dexProspectRefreshing = false;
    }
  }

  const total = dexCachedCandidates.length;
  if (total === 0) return [];

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
    console.log("[DEX] 候補ペアがまだありません");
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
        dexRecordStats(observed);
        if (Math.abs(observed.priceDiffPercent) >= PERSISTENCE_TRIGGER_THRESHOLD_PCT) {
          trackPersistence(candidate, observed);
        }
        if (observed.cheapPoolAddress && observed.expensivePoolAddress) {
          poolAddressToCandidate.set(observed.cheapPoolAddress, { candidate });
          poolAddressToCandidate.set(observed.expensivePoolAddress, { candidate });
          updatePoolSubscriptions(candidate.chain, [observed.cheapPoolAddress, observed.expensivePoolAddress]);
        }
        if (observed.profitable) {
          try {
            await maybeExecuteArb(observed);
          } catch (e) {
            console.warn(`[実行判定] ${observed.pairLabel}: エラー:`, e.message);
          }
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

const DEX_WATCH_INTERVAL_SEC = parseInt(process.env.DEX_WATCH_INTERVAL_SEC || "180", 10);

let dexWatchRunning = false;
let dexWatchCount = 0;
let lastDexWatchAt = null;
let lastDexError = null;
let latestDexResults = [];

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
        console.log(`[DEX] ${r.pairLabel}: 純利益 +$${r.netProfit.toFixed(2)}(価格差${r.priceDiffPercent.toFixed(2)}%、投入額$${r.tradeAmountUsd.toFixed(2)}）`);
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

const PAGE_STYLE = `
body{font-family:-apple-system,sans-serif;background:#0d100c;color:#e8e6d8;margin:0;padding:18px 12px;}
h1{font-size:17px;margin:0 0 4px;} h2{font-size:13px;margin:0 0 10px;font-weight:600;}
.sub{color:#888;font-size:11px;margin-bottom:16px;}
.card{background:#14180f;border:1px solid #2a331d;border-radius:8px;padding:13px;margin-bottom:13px;}
.card.real{border-color:#2ecc71;}
table{width:100%;border-collapse:collapse;font-size:11px;}
th{text-align:left;color:#888;font-weight:500;font-size:9.5px;padding:5px 3px;border-bottom:1px solid #2a331d;}
td{padding:6px 3px;border-bottom:1px solid #1c1c1c;}
.note{font-size:10px;color:#888;line-height:1.6;margin-top:9px;padding-top:9px;border-top:1px solid #222;}
.stat{display:grid;grid-template-columns:repeat(4,1fr);gap:6px;margin-bottom:13px;}
.stat div{background:#14180f;border:1px solid #2a331d;border-radius:8px;padding:11px 4px;text-align:center;}
.stat .v{font-size:17px;font-weight:600;} .stat .l{font-size:8.5px;color:#888;margin-top:2px;}
a{color:#6fae62;}
.footerlink{margin-top:18px;font-size:11px;}
`;

function renderRealExecutionSection() {
  const real = getRealExecutionStats();
  const cap = getCurrentTradeCapUsd();
  const successes = getSuccessCount();
  const isLive = process.env.DRY_RUN === "false";

  const rows = real.recent.map((e) => {
    const actual = e.actualProfitUsd !== null && e.actualProfitUsd !== undefined
      ? `${e.actualProfitUsd >= 0 ? '+' : ''}$${e.actualProfitUsd.toFixed(4)}` : '取得できず';
    return `<tr><td>${new Date(e.timestamp).toLocaleString('ja-JP')}</td>
    <td style="font-size:9px;">${e.pairLabel}</td>
    <td style="text-align:right;">$${e.tradeAmountUsd.toFixed(2)}</td>
    <td style="text-align:right;color:#2ecc71;font-weight:600;">${actual}</td>
    <td><a href="${e.explorerUrl}" target="_blank">確認</a></td></tr>`;
  }).join('') || `<tr><td colspan="5" style="color:#888;">まだ実際の取引はありません</td></tr>`;

  return `<div class="card real">
    <h2>💰 実際の取引結果(本物のお金)</h2>
    <div class="stat">
      <div><div class="v">${real.count}</div><div class="l">実行回数</div></div>
      <div><div class="v" style="color:${real.totalProfitUsd>=0?'#2ecc71':'#e74c3c'};">${real.totalProfitUsd>=0?'+':''}$${real.totalProfitUsd.toFixed(4)}</div><div class="l">実際の累積利益</div></div>
      <div><div class="v">$${cap}</div><div class="l">現在の取引上限</div></div>
      <div><div class="v" style="color:${isLive?'#2ecc71':'#888'};">${isLive ? '稼働中' : '停止中'}</div><div class="l">自動売買</div></div>
    </div>
    <table><thead><tr><th>日時</th><th>ペア</th><th style="text-align:right;">投入額</th><th style="text-align:right;">実際の利益</th><th></th></tr></thead>
    <tbody>${rows}</tbody></table>
    <div class="note">
      <strong>これが本当のお金の結果です。</strong>下の観測データ(紙上シミュレーション)とは別物です。<br>
      利益額は、コントラクトがブロックチェーン上に記録した確定値です。<br>
      取引上限は成功実績に応じて自動的に引き上がります(成功${successes}回、$50→$200→$500→$1000→$2000)。<br>
      利益はコントラクト内に蓄積されます(ウォレット残高には反映されません)。
    </div>
  </div>`;
}

function renderPage() {
  const dexStats = dexLoadStats();
  const persistenceSummary = getPersistenceSummary();
  const onchainLatencyStats = getOnchainLatencyStats();

  const dexRows = latestDexResults.slice(0, 15).map((r, i) => {
    const color = r.profitable ? "#2ecc71" : "#888";
    return `<tr><td>${i+1}</td><td style="font-size:9px;">${r.pairLabel}</td>
    <td style="text-align:right;">${r.priceDiffPercent.toFixed(2)}%</td>
    <td style="text-align:right;color:${color};font-weight:600;">${r.netProfit>=0?'+':''}$${r.netProfit.toFixed(2)}</td></tr>`;
  }).join("") || `<tr><td colspan="4" style="color:#888;">観測データがまだありません</td></tr>`;

  return `<!DOCTYPE html><html lang="ja"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1.0"><meta http-equiv="refresh" content="30">
<title>DEXアービトラージ観測所</title><style>${PAGE_STYLE}</style></head><body>
<h1>🔍 DEXアービトラージ観測所</h1>
<div class="sub">DEX観測${dexWatchCount}回 / 観測上限$${MAX_TRADE_USD}</div>

${renderRealExecutionSection()}

<div class="card">
  <h2>🔍 観測データ(紙上シミュレーション)</h2>
  <div class="stat">
    <div><div class="v">${dexStats.totalObserved}</div><div class="l">記録件数</div></div>
    <div><div class="v" style="color:${dexStats.totalProfitableCount>0?'#2ecc71':'#888'};">${dexStats.totalProfitableCount}</div><div class="l">黒字だった件数</div></div>
    <div><div class="v" style="color:${dexStats.cumulativeProfit>=0?'#2ecc71':'#e74c3c'};">${dexStats.cumulativeProfit>=0?'+':''}$${dexStats.cumulativeProfit.toFixed(2)}</div><div class="l">理論上の累積利益</div></div>
    <div><div class="v">${lastDexWatchAt ? new Date(lastDexWatchAt).toLocaleTimeString('ja-JP') : '-'}</div><div class="l">最終観測時刻</div></div>
  </div>
  <table><thead><tr><th>#</th><th>ペア</th><th style="text-align:right;">価格差</th><th style="text-align:right;">純利益</th></tr></thead>
  <tbody>${dexRows}</tbody></table>
  <div class="note">
    <strong>これは「もし取引していたら」の理論値です。</strong>実際に実行できる案件は、ルーター確認済みDEX・対応チェーンに限られるため、この数字より少なくなります。<br>
    ガス代・DEX手数料(0.3%)・Aaveのフラッシュローン手数料(0.05%)・スリッページを差し引いて計算しています。${lastDexError ? `<br><span style="color:#e74c3c;">エラー: ${lastDexError}</span>` : ''}
  </div>
</div>

${persistenceSummary ? `<div class="card">
  <h2>⏱️ 歪みの持続性</h2>
  <table><thead><tr><th>経過時間</th><th style="text-align:right;">追跡件数</th><th style="text-align:right;">まだ残っていた割合</th></tr></thead>
  <tbody>${persistenceSummary.byDelay.map(d => `<tr><td>${d.delaySec}秒後</td><td style="text-align:right;">${d.total}</td>
    <td style="text-align:right;color:${d.survivalRate!==null && d.survivalRate>50?'#2ecc71':'#e74c3c'};">${d.survivalRate!==null ? d.survivalRate.toFixed(0)+'%' : '-'}</td></tr>`).join('')}</tbody></table>
  <div class="note">検知した歪みが、その後も残っていたかを実測(追跡件数${persistenceSummary.trackedCount}件)。</div>
</div>` : ''}

${onchainLatencyStats ? `<div class="card">
  <h2>⚡ オンチェーン反応速度</h2>
  <div class="stat">
    <div><div class="v">${onchainLatencyStats.count}</div><div class="l">反応回数</div></div>
    <div><div class="v">${onchainLatencyStats.medianMs.toFixed(0)}ms</div><div class="l">中央値</div></div>
    <div><div class="v">${onchainLatencyStats.minMs.toFixed(0)}ms</div><div class="l">最速</div></div>
    <div><div class="v">${onchainLatencyStats.maxMs.toFixed(0)}ms</div><div class="l">最遅</div></div>
  </div>
  <div class="note">Syncイベント検知から再評価完了までの実測時間。</div>
</div>` : ''}

<div class="footerlink"><a href="/about">→ このサイトが集めているデータについて</a></div>
</body></html>`;
}

function renderNewDexSection() {
  const known = dexLoadKnownDexes();
  const entries = Object.entries(known).sort((a, b) => new Date(b[1]) - new Date(a[1]));
  if (entries.length === 0) return '';
  const rows = entries.slice(0, 20).map(([key, firstSeen]) => {
    const [chain, dexId] = key.split("::");
    return `<tr><td>${dexId}</td><td>${chain}</td><td>${new Date(firstSeen).toLocaleDateString('ja-JP')}</td></tr>`;
  }).join('');
  return `<div class="card">
    <h2>🆕 これまでに検出したDEX(直近${Math.min(entries.length, 20)}件、新しい順)</h2>
    <table><thead><tr><th>DEX名</th><th>チェーン</th><th>初検出日</th></tr></thead><tbody>${rows}</tbody></table>
    <div class="note">全${entries.length}件のDEXを検出済み。直近に増えたものを優先的に信頼性を調査してください。</div>
  </div>`;
}

function renderAboutPage() {
  return `<!DOCTYPE html><html lang="ja"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>収集データについて</title><style>${PAGE_STYLE}</style></head><body>
<h1>📊 このサイトが集めているデータ</h1>
<div class="sub">DEXアービトラージ観測所が、裏で何をしているかの説明ページ</div>

<div class="card">
  <h2>① 候補ペアの選定(1時間ごと)</h2>
  <div class="note">
    DeFiLlamaから全DEXプールのデータを取得し、「同じトークンペアが複数のDEXに存在する組み合わせ」を洗い出します。<br>
    Ethereumはガス代が確実に利益を上回るため除外しています。流動性・出来高の少なさからスコアリングして上位60件をキャッシュします。
  </div>
</div>

<div class="card">
  <h2>② DEX観測ログ(3分ごと)</h2>
  <div class="note">
    キャッシュした候補を8件ずつDexScreenerで価格チェックします。<br>
    純利益には、DEXの取引手数料(0.3%)・ガス代・Aaveのフラッシュローン手数料(0.05%)・スリッページの見積もりを差し引いています。<br>
    時価総額が$100,000未満の超小型トークンは、詐欺・急激な価格操作のリスクが高いため除外しています。
  </div>
</div>

<div class="card">
  <h2>③ 実際の自動売買</h2>
  <div class="note">
    黒字判定された案件のうち、対応チェーン(Base/Polygon/Optimism/Avalanche)かつルーター確認済みDEXの組み合わせだけが実行対象です。<br>
    ルーターには2つの呼び出し形式(Uniswap V2形式 / Aerodrome・Velodromeが使うSolidly形式)があり、それぞれ正しい形式で呼び分けています。<br>
    実行直前にプールの状態を再確認し、利益が消えていれば見送ります。スリッページ保護(1%)も設定します。<br>
    Aaveのフラッシュローンを使うため、取引資金は借りたもので、利益が出なければ取引全体が自動的に無かったことになります(実害はガス代のみ)。<br>
    実際に送信する金額は、成功実績に応じて段階的に引き上がります($50→$200→$500→$1000→$2000)。
  </div>
</div>

${renderNewDexSection()}

<div class="card">
  <h2>④ 持続性の追跡</h2>
  <div class="note">
    価格差が0.1%以上見つかった時だけ、5秒後・15秒後・30秒後・60秒後に再チェックし、「まだ残っていたか」を記録します。
  </div>
</div>

<div class="card">
  <h2>⑤ オンチェーン反応速度</h2>
  <div class="note">
    BaseのSyncイベントをリアルタイムで購読し、検知から再評価完了までの時間を計測します。
  </div>
</div>

<div class="footerlink"><a href="/">← 観測所トップに戻る</a></div>
</body></html>`;
}

function startServer() {
  const port = process.env.PORT || 8080;
  http.createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    if (req.url === "/about") {
      res.end(renderAboutPage());
    } else {
      res.end(renderPage());
    }
  }).listen(port, () => console.log(`観測所ページ: ポート${port}`));
}

async function main() {
  console.log("=== DEXアービトラージ観測所 起動 ===");
  startServer();

  if (process.env.RUN_TESTNET_DEPLOY_CHECK === "true") {
    try {
      await runTestnetDeployCheck();
    } catch (e) {
      console.error("[テストネット検証] 失敗:", e.message);
    }
  }
  const deployTarget = process.env.RUN_MAINNET_DEPLOY;
  if (deployTarget && deployTarget !== "false") {
    try {
      await runMainnetDeploy(deployTarget);
    } catch (e) {
      console.error("[本番デプロイ] 失敗:", e.message);
    }
  }

  dexWatchOnce();
  setInterval(dexWatchOnce, DEX_WATCH_INTERVAL_SEC * 1000);

  startOnchainFeeds(handleOnchainSync);
}

main().catch((e) => { console.error("致命的エラー:", e); process.exit(1); });
