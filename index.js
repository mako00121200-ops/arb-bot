import http from "http";
import fs from "fs";
import { runProspect } from "./prospector.js";
import { startOnchainFeeds, updatePoolSubscriptions } from "./dex-onchain-realtime.js";
import { runTestnetDeployCheck } from "./scripts/testnet-deploy-check.js";
import { runMainnetDeploy } from "./scripts/mainnet-deploy.js";
import { maybeExecuteArb } from "./scripts/execute-arb.js";
import { getRealExecutionStats } from "./scripts/real-execution-log.js";
import { getCurrentTradeCapUsd, getSuccessCount } from "./scripts/trade-cap.js";
import { fetchOnchainReserves, fetchTokenDecimals, isOnchainReadAvailable } from "./scripts/onchain-reserves.js";
import { getRouterInfo } from "./router-addresses.js";
import {
  recordVerifiedPair, removePoolFromVerifiedPairs, getVerifiedPairs,
  getVerifiedPairsByChain, findVerifiedPairByPool, getVerifiedPairCount,
} from "./scripts/verified-pairs.js";
import { readVerifiedPairPools } from "./scripts/multicall-reserves.js";
import { shouldSkipChain, recordChainSuccess, recordChainFailure, getThrottleStatus } from "./scripts/chain-throttle.js";

const DEX_FETCH_TIMEOUT_MS = 20000;

async function dexFetchWithTimeout(url, timeoutMs = DEX_FETCH_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try { return await fetch(url, { signal: controller.signal }); }
  finally { clearTimeout(timer); }
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
  const a = pool1.reserveY, A = pool1.reserveX, X2 = pool2.reserveX, Y2 = pool2.reserveY;
  const g1 = 1 - pool1.fee, g2 = 1 - pool2.fee;
  const P = Y2 * g2 * A, Q = X2 * a, R = X2 + g2 * A;
  const inner = g1 * P * Q;
  if (inner <= Q * Q) return { amountIn: 0, grossProfit: 0, profitable: false };
  const theoreticalAmountIn = (Math.sqrt(inner) - Q) / (g1 * R);
  if (theoreticalAmountIn <= 0) return { amountIn: 0, grossProfit: 0, profitable: false };

  let bestT = theoreticalAmountIn;
  let bestProfit = dexSimulateProfitForAmount(pool1, pool2, theoreticalAmountIn);
  for (let mult = 0.5; mult <= 1.5; mult += 0.01) {
    const t = theoreticalAmountIn * mult;
    const p = dexSimulateProfitForAmount(pool1, pool2, t);
    if (p > bestProfit) { bestProfit = p; bestT = t; }
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
  const actualGrossProfitY = dexSimulateProfitForAmount(cheapPool, expensivePool, actualTradeAmountIn);
  const actualSlippageCostY = actualGrossProfitY * slippageBuffer;
  const aaveFeeInY = actualTradeAmountIn * AAVE_FLASHLOAN_FEE_RATE;
  const actualNetProfitY = actualGrossProfitY - gasCostInY - actualSlippageCostY - aaveFeeInY;

  return {
    timestamp: new Date().toISOString(), pairLabel, priceDiffPercent,
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
    cappedByBudget: optimalResult.amountIn > maxTradeAmountIn,
  };
}

const DEXSCREENER_TOKEN_API = "https://api.dexscreener.com/latest/dex/tokens/";
const DEX_LOG_FILE = process.env.WATCHER_LOG_FILE || "/tmp/dex-arb-observations.json";
const DEX_STATS_FILE = process.env.STATS_FILE || "/tmp/dex-arb-stats.json";
const KNOWN_DEX_FILE = process.env.KNOWN_DEX_FILE || "/tmp/dex-known-list.json";

const DEX_DEFAULT_FEE_BY_DEX = {
  uniswap: 0.003, aerodrome: 0.003, "aerodrome-slipstream": 0.003, sushiswap: 0.003,
  camelot: 0.003, velodrome: 0.003, quickswap: 0.003, traderjoe: 0.003, default: 0.003,
};
function dexGetFeeForDex(dexId) {
  return DEX_DEFAULT_FEE_BY_DEX[(dexId || "").toLowerCase()] ?? DEX_DEFAULT_FEE_BY_DEX.default;
}

function dexNormalizeChain(chain) {
  const map = { base: "base", arbitrum: "arbitrum", optimism: "optimism", "op mainnet": "optimism", ethereum: "ethereum" };
  return map[(chain || "").toLowerCase()] || (chain || "").toLowerCase();
}

const CHAIN_GAS_COST_USD = {
  base: 0.05, arbitrum: 0.10, optimism: 0.05, ethereum: 8.0,
  polygon: 0.05, avalanche: 0.05, bsc: 0.10, binance: 0.10, bnb: 0.10, flare: 0.02,
};
function getGasCostForChain(chain) { return CHAIN_GAS_COST_USD[dexNormalizeChain(chain)] ?? 0.25; }

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
  try { if (fs.existsSync(KNOWN_DEX_FILE)) return JSON.parse(fs.readFileSync(KNOWN_DEX_FILE, "utf8")); } catch (e) {}
  return {};
}
function checkAndRecordNewDex(dexId, chain) {
  if (!dexId) return;
  const key = `${chain}::${dexId}`;
  const known = dexLoadKnownDexes();
  if (known[key]) return;
  known[key] = new Date().toISOString();
  try { fs.writeFileSync(KNOWN_DEX_FILE, JSON.stringify(known)); } catch (e) {}
  console.log(`[DEX診断] 新しいDEXを初めて検出: "${dexId}" on ${chain}`);
}

function dexLoadLog() {
  try {
    if (fs.existsSync(DEX_LOG_FILE)) {
      return JSON.parse(fs.readFileSync(DEX_LOG_FILE, "utf8")).filter((e) => {
        if (e.cheapDex === e.expensiveDex) return false;
        if (isKnownFalsePositive({ symbol: e.pairLabel, cheapDexId: e.cheapDex, expensiveDexId: e.expensiveDex, chain: e.chain })) return false;
        return true;
      });
    }
  } catch (e) {}
  return [];
}
function dexSaveLog(entries) {
  try { fs.writeFileSync(DEX_LOG_FILE, JSON.stringify(entries.length > 2000 ? entries.slice(-2000) : entries)); } catch (e) {}
}

function dexLoadStats() {
  try { if (fs.existsSync(DEX_STATS_FILE)) return JSON.parse(fs.readFileSync(DEX_STATS_FILE, "utf8")); } catch (e) {}
  const existing = dexLoadLog();
  const profitable = existing.filter((r) => r.profitable);
  const seeded = {
    totalObserved: existing.length, totalProfitableCount: profitable.length,
    cumulativeProfit: profitable.reduce((s, r) => s + r.netProfit, 0),
    onchainVerifiedCount: 0, onchainVerifiedProfit: 0,
  };
  dexSaveStats(seeded);
  return seeded;
}
function dexSaveStats(stats) { try { fs.writeFileSync(DEX_STATS_FILE, JSON.stringify(stats)); } catch (e) {} }
function dexRecordStats(observed) {
  const stats = dexLoadStats();
  stats.totalObserved = (stats.totalObserved || 0) + 1;
  if (observed.profitable) {
    stats.totalProfitableCount = (stats.totalProfitableCount || 0) + 1;
    stats.cumulativeProfit = (stats.cumulativeProfit || 0) + observed.netProfit;
    if ((observed.reserveSource || "").startsWith("onchain")) {
      stats.onchainVerifiedCount = (stats.onchainVerifiedCount || 0) + 1;
      stats.onchainVerifiedProfit = (stats.onchainVerifiedProfit || 0) + observed.netProfit;
    }
  }
  dexSaveStats(stats);
}

async function dexFetchPairsForToken(tokenAddress, chain, otherTokenAddress) {
  const targetChain = dexNormalizeChain(chain);
  const target = tokenAddress.toLowerCase(), other = otherTokenAddress.toLowerCase();
  const [resA, resB] = await Promise.all([
    dexFetchWithTimeout(DEXSCREENER_TOKEN_API + tokenAddress),
    dexFetchWithTimeout(DEXSCREENER_TOKEN_API + otherTokenAddress),
  ]);
  if (!resA.ok && !resB.ok) throw new Error(`DexScreener HTTP ${resA.status}/${resB.status}`);
  const pairsA = resA.ok ? (await resA.json()).pairs || [] : [];
  const pairsB = resB.ok ? (await resB.json()).pairs || [] : [];
  const merged = new Map();
  for (const p of [...pairsA, ...pairsB]) if (p.pairAddress) merged.set(p.pairAddress, p);
  return [...merged.values()].filter((p) => {
    if ((p.chainId || "").toLowerCase() !== targetChain) return false;
    const base = (p.baseToken?.address || "").toLowerCase(), quote = (p.quoteToken?.address || "").toLowerCase();
    return (base === target || quote === target) && (base === other || quote === other);
  });
}

const CONCENTRATED_LIQUIDITY_DEX_IDS = new Set(["aerodrome-slipstream", "velodrome-slipstream", "pancakeswap-v3", "uniswap-v3"]);
function isConcentratedLiquidity(pair) {
  const labels = (pair.labels || []).map((l) => String(l).toLowerCase());
  if (labels.some((l) => /v3|v4|concentrated|slipstream|\bcl\b/.test(l))) return true;
  return CONCENTRATED_LIQUIDITY_DEX_IDS.has((pair.dexId || "").toLowerCase());
}

function dexPrefilterPair(pair, chain) {
  checkAndRecordNewDex(pair.dexId, chain);
  if (isConcentratedLiquidity(pair) || isDeadPool(pair)) return null;
  const marketCap = pair.marketCap ?? pair.fdv;
  if (marketCap != null && marketCap < MIN_MARKET_CAP_USD) return null;
  const priceNative = parseFloat(pair.priceNative), basePriceUsd = parseFloat(pair.priceUsd);
  if (!priceNative || !isFinite(priceNative) || !isFinite(basePriceUsd) || basePriceUsd <= 0) return null;
  return { pair, priceNative, basePriceUsd };
}

async function buildPoolFromOnchain(prefiltered, targetTokenAddress, chain, decimalsX, decimalsY) {
  const { pair, priceNative, basePriceUsd } = prefiltered;
  const baseIsTarget = (pair.baseToken?.address || "").toLowerCase() === targetTokenAddress.toLowerCase();
  let reserves;
  try {
    reserves = await fetchOnchainReserves({ chain, pairAddress: pair.pairAddress, tokenXAddress: targetTokenAddress, decimalsX, decimalsY });
  } catch (e) {
    return null;
  }
  if (!reserves.reserveX || !reserves.reserveY) return null;
  const quotePriceUsd = basePriceUsd / priceNative;
  return {
    dexId: pair.dexId, pairAddress: pair.pairAddress,
    reserveX: reserves.reserveX, reserveY: reserves.reserveY,
    fee: dexGetFeeForDex(pair.dexId), liquidityUsd: (pair.liquidity?.usd ?? null),
    priceUsdPerY: baseIsTarget ? quotePriceUsd : basePriceUsd, reserveSource: "onchain",
  };
}

function buildPoolFromDexScreener(prefiltered, targetTokenAddress) {
  const { pair, priceNative, basePriceUsd } = prefiltered;
  const liqBase = pair.liquidity?.base, liqQuote = pair.liquidity?.quote;
  if (!liqBase || !liqQuote) return null;
  const deviation = Math.abs(liqQuote / liqBase - priceNative) / priceNative;
  if (deviation > 0.05) return null;
  const baseIsTarget = (pair.baseToken?.address || "").toLowerCase() === targetTokenAddress.toLowerCase();
  const quotePriceUsd = basePriceUsd / priceNative;
  return {
    dexId: pair.dexId, pairAddress: pair.pairAddress,
    reserveX: baseIsTarget ? liqBase : liqQuote, reserveY: baseIsTarget ? liqQuote : liqBase,
    fee: dexGetFeeForDex(pair.dexId), liquidityUsd: (pair.liquidity?.usd ?? null),
    priceUsdPerY: baseIsTarget ? quotePriceUsd : basePriceUsd, reserveSource: "dexscreener",
  };
}

function evaluatePools({ pools, symbol, chain, tokenA, tokenB, reserveSource }) {
  pools.sort((a, b) => b.reserveX + b.reserveY - (a.reserveX + a.reserveY));
  if (pools.length < 2) return null;
  const [poolA, poolB] = pools;
  if (poolA.dexId === poolB.dexId) return null;
  if (isKnownFalsePositive({ symbol, cheapDexId: poolA.dexId, expensiveDexId: poolB.dexId, chain })) return null;

  const priceA = poolA.reserveY / poolA.reserveX, priceB = poolB.reserveY / poolB.reserveX;
  const [cheapPool, expensivePool] = priceA < priceB ? [poolA, poolB] : [poolB, poolA];
  if (!cheapPool.priceUsdPerY || !isFinite(cheapPool.priceUsdPerY) || cheapPool.priceUsdPerY <= 0) return null;

  const result = dexEvaluateOpportunity({
    cheapPool, expensivePool, gasCostUsd: getGasCostForChain(chain),
    maxTradeAmountUsd: MAX_TRADE_USD, slippageBuffer: 0.002,
    pairLabel: `${symbol} on ${chain} (${cheapPool.dexId} -> ${expensivePool.dexId})`,
  });
  if (Math.abs(result.priceDiffPercent) > 20) return null;

  if (reserveSource === "dexscreener") {
    const bothDeep = (cheapPool.liquidityUsd ?? 0) >= DEEP_POOL_LIQUIDITY_USD && (expensivePool.liquidityUsd ?? 0) >= DEEP_POOL_LIQUIDITY_USD;
    if (bothDeep && Math.abs(result.priceDiffPercent) > DEEP_POOL_MAX_GAP_PCT) return null;
  }

  return {
    ...result, chain, tokenA, tokenB,
    cheapDex: cheapPool.dexId, expensiveDex: expensivePool.dexId,
    cheapPoolAddress: cheapPool.pairAddress, expensivePoolAddress: expensivePool.pairAddress,
    cheapPoolLiquidityUsd: cheapPool.liquidityUsd, expensivePoolLiquidityUsd: expensivePool.liquidityUsd,
    reserveSource,
  };
}

async function dexWatchOnePair(candidate) {
  const rawPairs = await dexFetchPairsForToken(candidate.tokenA, candidate.chain, candidate.tokenB);
  const prefiltered = rawPairs.map((p) => dexPrefilterPair(p, candidate.chain)).filter(Boolean);
  if (prefiltered.length < 2) return null;

  const normalizedChain = dexNormalizeChain(candidate.chain);
  const useOnchain = isOnchainReadAvailable(normalizedChain);

  let pools = [];
  let decimalsX, decimalsY;
  if (useOnchain) {
    try {
      decimalsX = await fetchTokenDecimals(normalizedChain, candidate.tokenA);
      decimalsY = await fetchTokenDecimals(normalizedChain, candidate.tokenB);
    } catch (e) {
      pools = prefiltered.map((p) => buildPoolFromDexScreener(p, candidate.tokenA)).filter(Boolean);
    }
    if (decimalsX !== undefined && decimalsY !== undefined) {
      for (const p of prefiltered) {
        const built = await buildPoolFromOnchain(p, candidate.tokenA, normalizedChain, decimalsX, decimalsY);
        if (built) pools.push(built);
      }
      const executablePools = pools.filter((p) => getRouterInfo(normalizedChain, p.dexId));
      if (executablePools.length >= 2) {
        const isNew = recordVerifiedPair({
          chain: normalizedChain, symbol: candidate.symbol,
          tokenA: candidate.tokenA, tokenB: candidate.tokenB, decimalsX, decimalsY,
          priceUsdPerY: executablePools[0].priceUsdPerY,
          pools: executablePools.map((p) => ({ address: p.pairAddress, dexId: p.dexId })),
        });
        updatePoolSubscriptions(normalizedChain, executablePools.map((p) => p.pairAddress));
        if (isNew) console.log(`[実行可能ペア] ${candidate.symbol} on ${normalizedChain} を追加(合計${getVerifiedPairCount()}件)`);
      }
    }
  } else {
    pools = prefiltered.map((p) => buildPoolFromDexScreener(p, candidate.tokenA)).filter(Boolean);
  }

  return evaluatePools({
    pools, symbol: candidate.symbol, chain: candidate.chain,
    tokenA: candidate.tokenA, tokenB: candidate.tokenB,
    reserveSource: pools[0]?.reserveSource || "dexscreener",
  });
}

// ===== 高速観測 =====
// Multicallで1ペア1回のRPC呼び出しに抑えているため、5秒間隔でも
// Chainstack無料枠(毎秒25回)に十分収まる。
const FAST_WATCH_INTERVAL_SEC = parseInt(process.env.FAST_WATCH_INTERVAL_SEC || "5", 10);
let fastWatchRunning = false;
let fastWatchCount = 0;
let fastWatchLastAt = null;
const executingPairs = new Set();

async function evaluateAndMaybeExecute(observed, source) {
  if (!observed) return;
  const key = `${observed.chain}::${observed.tokenA}::${observed.tokenB}`.toLowerCase();
  dexRecordStats(observed);
  if (!observed.profitable) return;
  if (executingPairs.has(key)) return;
  executingPairs.add(key);
  try {
    console.log(`[${source}] ${observed.pairLabel}: 純利益 +$${observed.netProfit.toFixed(2)}(価格差${observed.priceDiffPercent.toFixed(2)}%、投入額$${observed.tradeAmountUsd.toFixed(2)}）`);
    latestDexResults = [observed, ...latestDexResults.filter((r) => r.pairLabel !== observed.pairLabel)].slice(0, 30);
    await maybeExecuteArb(observed);
  } catch (e) {
    console.warn(`[実行判定] エラー:`, e.message);
  } finally {
    executingPairs.delete(key);
  }
}

// 戻り値: 評価結果 / null(黒字でない等) / undefined(読み取り自体に失敗)
async function evaluateVerifiedPair(pair, source) {
  let pools;
  try {
    pools = await readVerifiedPairPools(pair);
  } catch (e) {
    return undefined;
  }
  const readable = new Set(pools.map((p) => p.pairAddress.toLowerCase()));
  for (const p of pair.pools) {
    if (!readable.has(p.address.toLowerCase())) removePoolFromVerifiedPairs(pair.chain, p.address);
  }
  if (pools.length === 0) return undefined;
  if (pools.length < 2 || !pair.priceUsdPerY) return null;

  const shaped = pools.map((p) => ({
    ...p, fee: dexGetFeeForDex(p.dexId), liquidityUsd: null,
    priceUsdPerY: pair.priceUsdPerY, reserveSource: "onchain-fast",
  }));
  const observed = evaluatePools({
    pools: shaped, symbol: pair.symbol, chain: pair.chain,
    tokenA: pair.tokenA, tokenB: pair.tokenB, reserveSource: "onchain-fast",
  });
  await evaluateAndMaybeExecute(observed, source);
  return observed;
}

async function fastWatchOnce() {
  if (fastWatchRunning) return;
  fastWatchRunning = true;
  try {
    for (const [chain, pairs] of Object.entries(getVerifiedPairsByChain())) {
      // 公開RPCが制限に当たっているチェーンは、そのチェーンだけ休む。
      // Base(自前ノード)の速度を巻き添えで落とさないため。
      if (shouldSkipChain(chain)) continue;
      let anyFailed = false;
      for (const pair of pairs) {
        const result = await evaluateVerifiedPair(pair, "高速観測");
        if (result === undefined) anyFailed = true;
      }
      if (anyFailed) recordChainFailure(chain, "プール読み取りに失敗");
      else recordChainSuccess(chain);
    }
    fastWatchCount++;
    fastWatchLastAt = new Date().toISOString();
  } catch (e) {
    console.error("[高速観測] エラー:", e.message);
  } finally {
    fastWatchRunning = false;
  }
}

// ===== Syncイベント受信時の高速経路 =====
let onchainReactionCount = 0;
let onchainLatencyLog = [];

async function handleOnchainSync(chainName, poolAddress, reserve0, reserve1, receivedAt) {
  const pair = findVerifiedPairByPool(chainName, poolAddress);
  if (!pair) return;
  try {
    const observed = await evaluateVerifiedPair(pair, "Sync反応");
    const latencyMs = Date.now() - receivedAt;
    onchainReactionCount++;
    onchainLatencyLog.push(latencyMs);
    if (onchainLatencyLog.length > 200) onchainLatencyLog.shift();
    if (observed) {
      const log = dexLoadLog();
      log.push({ ...observed, viaOnchainEvent: true, reactionLatencyMs: latencyMs });
      dexSaveLog(log);
    }
  } catch (e) {
    console.warn(`[Sync反応] 失敗:`, e.message);
  }
}

function getOnchainLatencyStats() {
  if (onchainLatencyLog.length === 0) return null;
  const sorted = [...onchainLatencyLog].sort((a, b) => a - b);
  return {
    count: onchainReactionCount, medianMs: sorted[Math.floor(sorted.length / 2)],
    minMs: sorted[0], maxMs: sorted[sorted.length - 1],
  };
}

// ===== 定期観測(発掘用) =====
const DEX_PROSPECT_REFRESH_INTERVAL_MS = 60 * 60 * 1000;
let dexCachedCandidates = [];
let dexCandidateRotationOffset = 0;
let dexLastProspectAt = 0;
let dexProspectRefreshing = false;

async function dexGetCandidates(topN) {
  const now = Date.now();
  if ((dexCachedCandidates.length === 0 || now - dexLastProspectAt > DEX_PROSPECT_REFRESH_INTERVAL_MS) && !dexProspectRefreshing) {
    dexProspectRefreshing = true;
    try {
      const prospect = await runProspect({ minTvlUSD: 5000, topN: 60 });
      dexCachedCandidates = prospect.topPairs;
      dexLastProspectAt = now;
      dexCandidateRotationOffset = 0;
      console.log(`[DEX] 候補ペア再選定完了: ${dexCachedCandidates.length}件`);
    } catch (e) {
      console.error("[DEX] 候補ペア選定に失敗:", e.message);
    } finally { dexProspectRefreshing = false; }
  }
  const total = dexCachedCandidates.length;
  if (total === 0) return [];
  const batchSize = Math.min(topN, total), start = dexCandidateRotationOffset % total;
  const selected = [];
  for (let i = 0; i < batchSize; i++) selected.push(dexCachedCandidates[(start + i) % total]);
  dexCandidateRotationOffset = (start + batchSize) % total;
  return selected;
}

async function runWatchCycle({ topN = 8 } = {}) {
  const candidates = await dexGetCandidates(topN);
  if (candidates.length === 0) return { checked: 0, logged: 0, results: [] };

  const log = dexLoadLog();
  const results = [];
  for (const candidate of candidates) {
    try {
      const observed = await dexWatchOnePair(candidate);
      if (observed) {
        results.push(observed);
        log.push(observed);
        await evaluateAndMaybeExecute(observed, "定期観測");
      }
    } catch (e) {
      console.warn(`[DEX] 観測失敗 (${candidate.symbol} / ${candidate.chain}):`, e.message);
    }
  }
  dexSaveLog(log);
  console.log(`[DEX] 定期観測完了: 対象${candidates.length}件・記録${results.length}件・黒字${results.filter(r=>r.profitable).length}件 / 実行可能ペア${getVerifiedPairCount()}件`);
  return { checked: candidates.length, logged: results.length, results };
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
    for (const r of result.results) {
      if (!latestDexResults.some((x) => x.pairLabel === r.pairLabel)) latestDexResults = [r, ...latestDexResults].slice(0, 30);
    }
    dexWatchCount++;
    lastDexWatchAt = new Date().toISOString();
  } catch (e) {
    lastDexError = e.message;
    console.error("DEX観測エラー:", e.message);
  } finally { dexWatchRunning = false; }
}

// ===== ダッシュボード =====
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
.badge{font-size:8px;padding:1px 4px;border-radius:3px;background:#2a331d;color:#6fae62;}
a{color:#6fae62;} .footerlink{margin-top:18px;font-size:11px;}
`;

function renderRealExecutionSection() {
  const real = getRealExecutionStats();
  const isLive = process.env.DRY_RUN === "false";
  const rows = real.recent.map((e) => {
    const actual = e.actualProfitUsd != null ? `${e.actualProfitUsd >= 0 ? '+' : ''}$${e.actualProfitUsd.toFixed(4)}` : '取得できず';
    return `<tr><td>${new Date(e.timestamp).toLocaleString('ja-JP')}</td><td style="font-size:9px;">${e.pairLabel}</td>
    <td style="text-align:right;">$${e.tradeAmountUsd.toFixed(2)}</td><td style="text-align:right;color:#2ecc71;font-weight:600;">${actual}</td>
    <td><a href="${e.explorerUrl}" target="_blank">確認</a></td></tr>`;
  }).join('') || `<tr><td colspan="5" style="color:#888;">まだ実際の取引はありません</td></tr>`;
  return `<div class="card real"><h2>💰 実際の取引結果(本物のお金)</h2>
    <div class="stat">
      <div><div class="v">${real.count}</div><div class="l">実行回数</div></div>
      <div><div class="v" style="color:${real.totalProfitUsd>=0?'#2ecc71':'#e74c3c'};">${real.totalProfitUsd>=0?'+':''}$${real.totalProfitUsd.toFixed(4)}</div><div class="l">実際の累積利益</div></div>
      <div><div class="v">$${getCurrentTradeCapUsd()}</div><div class="l">現在の取引上限</div></div>
      <div><div class="v" style="color:${isLive?'#2ecc71':'#888'};">${isLive ? '稼働中' : '停止中'}</div><div class="l">自動売買</div></div>
    </div>
    <table><thead><tr><th>日時</th><th>ペア</th><th style="text-align:right;">投入額</th><th style="text-align:right;">実際の利益</th><th></th></tr></thead><tbody>${rows}</tbody></table>
    <div class="note"><strong>これが本当のお金の結果です。</strong>利益はコントラクト内に蓄積されます。取引上限は成功実績(${getSuccessCount()}回)に応じて自動的に上がります。</div></div>`;
}

function renderFastWatchSection() {
  const pairs = getVerifiedPairs();
  const throttle = getThrottleStatus();
  const byChain = {};
  for (const p of pairs) byChain[p.chain] = (byChain[p.chain] || 0) + 1;
  const chainList = Object.entries(byChain).map(([c, n]) => {
    const t = throttle[c];
    const status = t && t.pausedForSec > 0 ? `<span style="color:#e74c3c;">(${t.pausedForSec}秒休止中)</span>` : '';
    return `${c}:${n}${status}`;
  }).join(' / ') || 'なし';
  const rows = pairs.slice(0, 20).map((p) => `<tr><td style="font-size:9px;">${p.symbol}</td><td>${p.chain}</td>
    <td style="font-size:9px;">${p.pools.map((x) => x.dexId).join(', ')}</td></tr>`).join('') || `<tr><td colspan="3" style="color:#888;">まだ登録されていません(定期観測で確認でき次第、自動追加されます)</td></tr>`;
  return `<div class="card"><h2>⚡ 高速観測(実行可能ペア)</h2>
    <div class="stat">
      <div><div class="v">${pairs.length}</div><div class="l">実行可能ペア</div></div>
      <div><div class="v">${FAST_WATCH_INTERVAL_SEC}秒</div><div class="l">観測間隔</div></div>
      <div><div class="v">${fastWatchCount}</div><div class="l">観測回数</div></div>
      <div><div class="v">${fastWatchLastAt ? new Date(fastWatchLastAt).toLocaleTimeString('ja-JP') : '-'}</div><div class="l">最終観測</div></div>
    </div>
    <table><thead><tr><th>ペア</th><th>チェーン</th><th>DEX</th></tr></thead><tbody>${rows}</tbody></table>
    <div class="note">「準備量を読めた かつ ルーター確認済み」のプールが2つ以上あるペアを、Multicallで一括読み取り(1ペア1回のRPC呼び出し)。DexScreenerを経由しないため${FAST_WATCH_INTERVAL_SEC}秒間隔で全件を観測できます。<br>
    公開RPCが不安定なチェーンは、そのチェーンだけ自動的に休止し、Base(自前ノード)の速度は落としません。内訳: ${chainList}</div></div>`;
}

function renderPage() {
  const dexStats = dexLoadStats();
  const lat = getOnchainLatencyStats();
  const dexRows = latestDexResults.slice(0, 15).map((r, i) => {
    const badge = (r.reserveSource || "").startsWith("onchain") ? `<span class="badge">実測</span>` : '';
    return `<tr><td>${i+1}</td><td style="font-size:9px;">${r.pairLabel} ${badge}</td><td style="text-align:right;">${r.priceDiffPercent.toFixed(2)}%</td>
    <td style="text-align:right;color:${r.profitable?'#2ecc71':'#888'};font-weight:600;">${r.netProfit>=0?'+':''}$${r.netProfit.toFixed(2)}</td></tr>`;
  }).join("") || `<tr><td colspan="4" style="color:#888;">観測データがまだありません</td></tr>`;

  return `<!DOCTYPE html><html lang="ja"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"><meta http-equiv="refresh" content="30">
<title>DEXアービトラージ観測所</title><style>${PAGE_STYLE}</style></head><body>
<h1>🔍 DEXアービトラージ観測所</h1>
<div class="sub">定期観測${dexWatchCount}回 / 高速観測${fastWatchCount}回 / 観測上限$${MAX_TRADE_USD}</div>
${renderRealExecutionSection()}
${renderFastWatchSection()}
<div class="card"><h2>🔍 観測データ(紙上シミュレーション)</h2>
  <div class="stat">
    <div><div class="v">${dexStats.totalObserved}</div><div class="l">記録件数</div></div>
    <div><div class="v" style="color:${dexStats.totalProfitableCount>0?'#2ecc71':'#888'};">${dexStats.totalProfitableCount}</div><div class="l">黒字だった件数</div></div>
    <div><div class="v" style="color:#2ecc71;">${dexStats.onchainVerifiedCount||0}</div><div class="l">うちオンチェーン実測</div></div>
    <div><div class="v" style="color:#2ecc71;">+$${(dexStats.onchainVerifiedProfit||0).toFixed(2)}</div><div class="l">実測ベースの利益</div></div>
  </div>
  <table><thead><tr><th>#</th><th>ペア</th><th style="text-align:right;">価格差</th><th style="text-align:right;">純利益</th></tr></thead><tbody>${dexRows}</tbody></table>
  <div class="note"><strong>これは「もし取引していたら」の理論値です。</strong>理論上の累積利益(全件): ${dexStats.cumulativeProfit>=0?'+':''}$${dexStats.cumulativeProfit.toFixed(2)}。${lastDexError ? `<br><span style="color:#e74c3c;">エラー: ${lastDexError}</span>` : ''}</div></div>
${lat ? `<div class="card"><h2>⚡ Sync反応速度</h2>
  <div class="stat"><div><div class="v">${lat.count}</div><div class="l">反応回数</div></div><div><div class="v">${lat.medianMs}ms</div><div class="l">中央値</div></div>
  <div><div class="v">${lat.minMs}ms</div><div class="l">最速</div></div><div><div class="v">${lat.maxMs}ms</div><div class="l">最遅</div></div></div>
  <div class="note">取引が起きた瞬間の通知(Sync)を受けてから、判定完了までの実測時間(Baseのみ)。</div></div>` : ''}
<div class="footerlink"><a href="/about">→ このサイトが集めているデータについて</a></div>
</body></html>`;
}

function renderAboutPage() {
  return `<!DOCTYPE html><html lang="ja"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>収集データについて</title><style>${PAGE_STYLE}</style></head><body>
<h1>📊 このサイトが集めているデータ</h1>
<div class="card"><h2>① 発掘(定期観測、3分ごと)</h2><div class="note">DeFiLlamaの候補60件を8件ずつ、DexScreenerでプールを探し、対応4チェーンではチェーンから直接準備量を読みます。「読めた かつ ルーター確認済み」のプールが2つ以上あるペアを「実行可能ペア」として登録します。</div></div>
<div class="card"><h2>② 高速観測(${FAST_WATCH_INTERVAL_SEC}秒ごと)</h2><div class="note">実行可能ペアだけを対象に、Multicall3で全プールを一括読み取り(1ペア1回のRPC呼び出し)。DexScreenerを経由しないため、レート制限を気にせず頻繁に観測できます。読み取りが3回連続で失敗したチェーンは、そのチェーンだけ一時的に休止します。</div></div>
<div class="card"><h2>③ Sync反応(即時、Baseのみ)</h2><div class="note">実行可能ペアのプールでの取引を即座に検知し、そのペアだけを読み直して判定します。他チェーンは②の${FAST_WATCH_INTERVAL_SEC}秒間隔で代替しており、追加費用なしでほぼ同等の反応速度を確保しています。</div></div>
<div class="card"><h2>④ 実行</h2><div class="note">黒字判定された案件は、実行直前にプール自身のgetAmountOutで最低受取量を確定し、フラッシュローンで実行します。利益が出なければ取引全体が無効化されます(実害はガス代のみ)。3つの観測経路が同じペアを同時に実行しないよう排他制御しています。</div></div>
<div class="footerlink"><a href="/">← 観測所トップに戻る</a></div></body></html>`;
}

function startServer() {
  const port = process.env.PORT || 8080;
  http.createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(req.url === "/about" ? renderAboutPage() : renderPage());
  }).listen(port, () => console.log(`観測所ページ: ポート${port}`));
}

async function main() {
  console.log("=== DEXアービトラージ観測所 起動 ===");
  startServer();

  if (process.env.RUN_TESTNET_DEPLOY_CHECK === "true") {
    try { await runTestnetDeployCheck(); } catch (e) { console.error("[テストネット検証] 失敗:", e.message); }
  }
  const deployTarget = process.env.RUN_MAINNET_DEPLOY;
  if (deployTarget && deployTarget !== "false") {
    try { await runMainnetDeploy(deployTarget); } catch (e) { console.error("[本番デプロイ] 失敗:", e.message); }
  }

  startOnchainFeeds(handleOnchainSync);

  for (const [chain, pairs] of Object.entries(getVerifiedPairsByChain())) {
    updatePoolSubscriptions(chain, pairs.flatMap((p) => p.pools.map((x) => x.address)));
  }
  console.log(`[起動] 実行可能ペア${getVerifiedPairCount()}件を読み込み / 高速観測${FAST_WATCH_INTERVAL_SEC}秒間隔`);

  dexWatchOnce();
  setInterval(dexWatchOnce, DEX_WATCH_INTERVAL_SEC * 1000);

  setTimeout(fastWatchOnce, 5000);
  setInterval(fastWatchOnce, FAST_WATCH_INTERVAL_SEC * 1000);
}

main().catch((e) => { console.error("致命的エラー:", e); process.exit(1); });
