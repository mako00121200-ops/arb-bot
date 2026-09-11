import http from "http";
import fs from "fs";
import { runProspect } from "./prospector.js";
import { startOnchainFeeds, updatePoolSubscriptions } from "./dex-onchain-realtime.js";
import { runTestnetDeployCheck } from "./scripts/testnet-deploy-check.js";
import { runMainnetDeploy } from "./scripts/mainnet-deploy.js";
import { maybeExecuteArb } from "./scripts/execute-arb.js";
import { getRealExecutionStats } from "./scripts/real-execution-log.js";
import { getCurrentTradeCapUsd, getSuccessCount } from "./scripts/trade-cap.js";
import { fetchOnchainReserves, fetchTokenDecimals, isOnchainReadAvailable, probePoolFeeBps, getRpcStatus } from "./scripts/onchain-reserves.js";
import { estimateGasCostUsd, getGasCostStatus } from "./scripts/gas-cost.js";
import { getRouterInfo } from "./router-addresses.js";
import {
  recordVerifiedPair, removePoolFromVerifiedPairs, getVerifiedPairs,
  getVerifiedPairsByChain, findVerifiedPairByPool, getVerifiedPairCount, pruneInvalidVerifiedPairs,
} from "./scripts/verified-pairs.js";
import { readVerifiedPairPools } from "./scripts/multicall-reserves.js";
import { shouldSkipChain, recordChainSuccess, recordChainFailure, getThrottleStatus } from "./scripts/chain-throttle.js";

const DEX_FETCH_TIMEOUT_MS = 20000;
async function dexFetchWithTimeout(url, timeoutMs = DEX_FETCH_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try { return await fetch(url, { signal: controller.signal }); } finally { clearTimeout(timer); }
}

const MAX_TRADE_USD = parseFloat(process.env.MAX_TRADE_USD || "2000");
const AAVE_FLASHLOAN_FEE_RATE = 0.0005;
const MIN_MARKET_CAP_USD = 100000;
const DEFAULT_FEE_BPS = 30;

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
  let bestT = theoreticalAmountIn, bestProfit = dexSimulateProfitForAmount(pool1, pool2, theoreticalAmountIn);
  for (let mult = 0.5; mult <= 1.5; mult += 0.01) {
    const t = theoreticalAmountIn * mult, p = dexSimulateProfitForAmount(pool1, pool2, t);
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
    tradeAmountUsd: actualTradeAmountIn * priceUsdPerY, tradeAmountIn: actualTradeAmountIn,
    grossProfit: actualGrossProfitY * priceUsdPerY, gasCostInY: gasCostUsd,
    slippageCost: actualSlippageCostY * priceUsdPerY, aaveFeeCost: aaveFeeInY * priceUsdPerY,
    netProfit: actualNetProfitY * priceUsdPerY, profitable: actualNetProfitY > 0,
    optimalAmountIn: optimalResult.amountIn, optimalGrossProfitUsd: optimalResult.grossProfit * priceUsdPerY,
    cappedByBudget: optimalResult.amountIn > maxTradeAmountIn,
  };
}

const DEXSCREENER_TOKEN_API = "https://api.dexscreener.com/latest/dex/tokens/";
const DEX_LOG_FILE = process.env.WATCHER_LOG_FILE || "/tmp/dex-arb-observations.json";
const DEX_STATS_FILE = process.env.STATS_FILE || "/tmp/dex-arb-stats.json";
const KNOWN_DEX_FILE = process.env.KNOWN_DEX_FILE || "/tmp/dex-known-list.json";

function dexNormalizeChain(chain) {
  const map = { base: "base", arbitrum: "arbitrum", optimism: "optimism", "op mainnet": "optimism", ethereum: "ethereum" };
  return map[(chain || "").toLowerCase()] || (chain || "").toLowerCase();
}

// ガス代はチェーンから実測する。固定値($0.05)は実際の10倍近い過大見積もりで、
// 中小プール狙いで中心となる$0.1〜$2の利益を軒並み赤字判定にしていた。
const FALLBACK_GAS_COST_USD = { base: 0.01, arbitrum: 0.03, optimism: 0.01, ethereum: 8.0, polygon: 0.01, avalanche: 0.03 };
const gasCostCache = new Map();
function getGasCostForChain(chain) {
  const key = dexNormalizeChain(chain);
  return gasCostCache.get(key) ?? FALLBACK_GAS_COST_USD[key] ?? 0.05;
}
async function refreshGasCosts() {
  for (const chain of ["base", "polygon", "optimism", "avalanche", "arbitrum"]) {
    try { gasCostCache.set(chain, await estimateGasCostUsd(chain)); } catch (e) {}
  }
  const summary = [...gasCostCache.entries()].map(([c, v]) => `${c}:$${v.toFixed(4)}`).join(" ");
  console.log(`[ガス代実測] ${summary}`);
}

const DEAD_POOL_MIN_VOLUME_USD = 50, DEAD_POOL_MIN_TXNS_24H = 3;
function isDeadPool(pair) {
  const volume24h = pair.volume?.h24 ?? 0;
  const txns24h = (pair.txns?.h24?.buys ?? 0) + (pair.txns?.h24?.sells ?? 0);
  return volume24h < DEAD_POOL_MIN_VOLUME_USD || txns24h < DEAD_POOL_MIN_TXNS_24H;
}
function isKnownFalsePositive({ symbol, cheapDexId, expensiveDexId, chain }) {
  const upperSymbol = (symbol || "").toUpperCase();
  if (upperSymbol.includes("USDBC") || upperSymbol.includes("USDC.E") || upperSymbol.includes("USDCE")) return true;
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
  const key = `${chain}::${dexId}`, known = dexLoadKnownDexes();
  if (known[key]) return;
  known[key] = new Date().toISOString();
  try { fs.writeFileSync(KNOWN_DEX_FILE, JSON.stringify(known)); } catch (e) {}
  console.log(`[DEX診断] 新しいDEXを初めて検出: "${dexId}" on ${chain}`);
}

function dexLoadLog() {
  try {
    if (fs.existsSync(DEX_LOG_FILE)) {
      return JSON.parse(fs.readFileSync(DEX_LOG_FILE, "utf8")).filter((e) =>
        e.cheapDex !== e.expensiveDex && !isKnownFalsePositive({ symbol: e.pairLabel, cheapDexId: e.cheapDex, expensiveDexId: e.expensiveDex, chain: e.chain }));
    }
  } catch (e) {}
  return [];
}
function dexSaveLog(entries) {
  try { fs.writeFileSync(DEX_LOG_FILE, JSON.stringify(entries.length > 2000 ? entries.slice(-2000) : entries)); } catch (e) {}
}
// 高速観測の成果も記録に残す(以前は定期観測とSync反応でしか保存していなかった)。
function appendToLog(observed, extra = {}) {
  const log = dexLoadLog();
  log.push({ ...observed, ...extra });
  dexSaveLog(log);
}

function dexLoadStats() {
  try { if (fs.existsSync(DEX_STATS_FILE)) return JSON.parse(fs.readFileSync(DEX_STATS_FILE, "utf8")); } catch (e) {}
  const existing = dexLoadLog(), profitable = existing.filter((r) => r.profitable);
  const seeded = { totalObserved: existing.length, totalProfitableCount: profitable.length, cumulativeProfit: profitable.reduce((s, r) => s + r.netProfit, 0), onchainVerifiedCount: 0, onchainVerifiedProfit: 0 };
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
  const [resA, resB] = await Promise.all([dexFetchWithTimeout(DEXSCREENER_TOKEN_API + tokenAddress), dexFetchWithTimeout(DEXSCREENER_TOKEN_API + otherTokenAddress)]);
  if (!resA.ok && !resB.ok) throw new Error(`DexScreener HTTP ${resA.status}/${resB.status}`);
  const pairsA = resA.ok ? (await resA.json()).pairs || [] : [], pairsB = resB.ok ? (await resB.json()).pairs || [] : [];
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

async function buildPoolFromOnchain(prefiltered, targetTokenAddress, otherTokenAddress, chain, decimalsX, decimalsY) {
  const { pair, priceNative, basePriceUsd } = prefiltered;
  const baseIsTarget = (pair.baseToken?.address || "").toLowerCase() === targetTokenAddress.toLowerCase();
  let reserves;
  try {
    reserves = await fetchOnchainReserves({ chain, pairAddress: pair.pairAddress, tokenXAddress: targetTokenAddress, decimalsX, decimalsY });
  } catch (e) { return null; }
  if (!reserves.reserveX || !reserves.reserveY) return null;

  const probed = await probePoolFeeBps({ chain, pairAddress: pair.pairAddress, tokenInAddress: otherTokenAddress, reserveIn: reserves.rawY, reserveOut: reserves.rawX });
  const feeBps = probed ?? DEFAULT_FEE_BPS;
  const quotePriceUsd = basePriceUsd / priceNative;
  return {
    dexId: pair.dexId, pairAddress: pair.pairAddress, reserveX: reserves.reserveX, reserveY: reserves.reserveY,
    fee: feeBps / 10000, feeBps, liquidityUsd: (pair.liquidity?.usd ?? null),
    priceUsdPerY: baseIsTarget ? quotePriceUsd : basePriceUsd, reserveSource: "onchain",
  };
}
function buildPoolFromDexScreener(prefiltered, targetTokenAddress) {
  const { pair, priceNative, basePriceUsd } = prefiltered;
  const liqBase = pair.liquidity?.base, liqQuote = pair.liquidity?.quote;
  if (!liqBase || !liqQuote) return null;
  if (Math.abs(liqQuote / liqBase - priceNative) / priceNative > 0.05) return null;
  const baseIsTarget = (pair.baseToken?.address || "").toLowerCase() === targetTokenAddress.toLowerCase();
  const quotePriceUsd = basePriceUsd / priceNative;
  return {
    dexId: pair.dexId, pairAddress: pair.pairAddress,
    reserveX: baseIsTarget ? liqBase : liqQuote, reserveY: baseIsTarget ? liqQuote : liqBase,
    fee: DEFAULT_FEE_BPS / 10000, feeBps: DEFAULT_FEE_BPS, liquidityUsd: (pair.liquidity?.usd ?? null),
    priceUsdPerY: baseIsTarget ? quotePriceUsd : basePriceUsd, reserveSource: "dexscreener",
  };
}

function evaluatePools({ pools, symbol, chain, tokenA, tokenB, reserveSource }) {
  if (pools.length < 2) return null;
  const withPrice = pools.map((p) => ({ ...p, price: p.reserveY / p.reserveX }));
  withPrice.sort((a, b) => a.price - b.price);
  const cheapPool = withPrice[0], expensivePool = withPrice[withPrice.length - 1];
  if (cheapPool.dexId === expensivePool.dexId) return null;
  if (isKnownFalsePositive({ symbol, cheapDexId: cheapPool.dexId, expensiveDexId: expensivePool.dexId, chain })) return null;
  if (!cheapPool.priceUsdPerY || !isFinite(cheapPool.priceUsdPerY) || cheapPool.priceUsdPerY <= 0) return null;

  const result = dexEvaluateOpportunity({
    cheapPool, expensivePool, gasCostUsd: getGasCostForChain(chain), maxTradeAmountUsd: MAX_TRADE_USD, slippageBuffer: 0.002,
    pairLabel: `${symbol} on ${chain} (${cheapPool.dexId} -> ${expensivePool.dexId})`,
  });
  if (Math.abs(result.priceDiffPercent) > 20) return null;
  return {
    ...result, chain, tokenA, tokenB, cheapDex: cheapPool.dexId, expensiveDex: expensivePool.dexId,
    cheapPoolAddress: cheapPool.pairAddress, expensivePoolAddress: expensivePool.pairAddress,
    cheapFeeBps: cheapPool.feeBps, expensiveFeeBps: expensivePool.feeBps,
    cheapPoolLiquidityUsd: cheapPool.liquidityUsd, expensivePoolLiquidityUsd: expensivePool.liquidityUsd, reserveSource,
  };
}

async function dexWatchOnePair(candidate) {
  const rawPairs = await dexFetchPairsForToken(candidate.tokenA, candidate.chain, candidate.tokenB);
  const prefiltered = rawPairs.map((p) => dexPrefilterPair(p, candidate.chain)).filter(Boolean);
  if (prefiltered.length < 2) return null;

  const normalizedChain = dexNormalizeChain(candidate.chain);
  let pools = [], decimalsX, decimalsY;
  if (isOnchainReadAvailable(normalizedChain)) {
    try {
      decimalsX = await fetchTokenDecimals(normalizedChain, candidate.tokenA);
      decimalsY = await fetchTokenDecimals(normalizedChain, candidate.tokenB);
    } catch (e) {
      pools = prefiltered.map((p) => buildPoolFromDexScreener(p, candidate.tokenA)).filter(Boolean);
    }
    if (decimalsX !== undefined && decimalsY !== undefined) {
      for (const p of prefiltered) {
        const built = await buildPoolFromOnchain(p, candidate.tokenA, candidate.tokenB, normalizedChain, decimalsX, decimalsY);
        if (built) pools.push(built);
      }
      const executablePools = pools.filter((p) => getRouterInfo(normalizedChain, p.dexId));
      // 登録時だけでなく毎回、最新のUSD換算価格も一緒に更新する。
      // 価格が動いたまま古い値を使うと、投入額の計算がズレるため。
      const isNew = recordVerifiedPair({
        chain: normalizedChain, symbol: candidate.symbol, tokenA: candidate.tokenA, tokenB: candidate.tokenB,
        decimalsX, decimalsY, priceUsdPerY: executablePools[0]?.priceUsdPerY,
        pools: executablePools.map((p) => ({ address: p.pairAddress, dexId: p.dexId, feeBps: p.feeBps })),
      });
      if (isNew) updatePoolSubscriptions(normalizedChain, executablePools.map((p) => p.pairAddress));
    }
  } else {
    pools = prefiltered.map((p) => buildPoolFromDexScreener(p, candidate.tokenA)).filter(Boolean);
  }
  return evaluatePools({ pools, symbol: candidate.symbol, chain: candidate.chain, tokenA: candidate.tokenA, tokenB: candidate.tokenB, reserveSource: pools[0]?.reserveSource || "dexscreener" });
}

// ===== 高速観測 =====
const FAST_WATCH_INTERVAL_SEC = parseInt(process.env.FAST_WATCH_INTERVAL_SEC || "5", 10);
let fastWatchRunning = false, fastWatchCount = 0, fastWatchLastAt = null;
const executingPairs = new Set();
const lastStatRecordAt = new Map();
const STAT_DEDUP_MS = 3 * 60 * 1000;

async function evaluateAndMaybeExecute(observed, source) {
  if (!observed) return;
  const key = `${observed.chain}::${observed.tokenA}::${observed.tokenB}`.toLowerCase();
  const last = lastStatRecordAt.get(key) || 0;
  if (Date.now() - last > STAT_DEDUP_MS) {
    dexRecordStats(observed);
    appendToLog(observed, { source });
    lastStatRecordAt.set(key, Date.now());
  }
  if (!observed.profitable || executingPairs.has(key)) return;
  executingPairs.add(key);
  try {
    console.log(`[${source}] ${observed.pairLabel}: 純利益 +$${observed.netProfit.toFixed(2)}(価格差${observed.priceDiffPercent.toFixed(2)}%、投入額$${observed.tradeAmountUsd.toFixed(2)}、手数料${observed.cheapFeeBps ?? "?"}/${observed.expensiveFeeBps ?? "?"}bps、ガス$${getGasCostForChain(observed.chain).toFixed(4)}）`);
    latestDexResults = [observed, ...latestDexResults.filter((r) => r.pairLabel !== observed.pairLabel)].slice(0, 30);
    await maybeExecuteArb(observed);
  } catch (e) { console.warn(`[実行判定] エラー:`, e.message); }
  finally { executingPairs.delete(key); }
}

async function evaluateVerifiedPair(pair, source) {
  let pools;
  try { pools = await readVerifiedPairPools(pair); } catch (e) { return undefined; }
  const readable = new Set(pools.map((p) => p.pairAddress.toLowerCase()));
  for (const p of pair.pools) if (!readable.has(p.address.toLowerCase())) removePoolFromVerifiedPairs(pair.chain, p.address);
  if (pools.length === 0) return undefined;
  if (pools.length < 2 || !pair.priceUsdPerY) return null;

  const feeByAddress = new Map(pair.pools.map((p) => [p.address.toLowerCase(), p.feeBps]));
  const shaped = pools.map((p) => {
    const feeBps = feeByAddress.get(p.pairAddress.toLowerCase()) ?? DEFAULT_FEE_BPS;
    return { ...p, fee: feeBps / 10000, feeBps, liquidityUsd: null, priceUsdPerY: pair.priceUsdPerY, reserveSource: "onchain-fast" };
  });
  const observed = evaluatePools({ pools: shaped, symbol: pair.symbol, chain: pair.chain, tokenA: pair.tokenA, tokenB: pair.tokenB, reserveSource: "onchain-fast" });
  await evaluateAndMaybeExecute(observed, source);
  return observed;
}

async function fastWatchOnce() {
  if (fastWatchRunning) return;
  fastWatchRunning = true;
  try {
    for (const [chain, pairs] of Object.entries(getVerifiedPairsByChain())) {
      if (shouldSkipChain(chain)) continue;
      let anyFailed = false;
      for (const pair of pairs) if ((await evaluateVerifiedPair(pair, "高速観測")) === undefined) anyFailed = true;
      if (anyFailed) recordChainFailure(chain, "プール読み取りに失敗"); else recordChainSuccess(chain);
    }
    fastWatchCount++;
    fastWatchLastAt = new Date().toISOString();
  } catch (e) { console.error("[高速観測] エラー:", e.message); }
  finally { fastWatchRunning = false; }
}

let onchainReactionCount = 0, onchainLatencyLog = [];
async function handleOnchainSync(chainName, poolAddress, reserve0, reserve1, receivedAt) {
  const pair = findVerifiedPairByPool(chainName, poolAddress);
  if (!pair) return;
  try {
    await evaluateVerifiedPair(pair, "Sync反応");
    const latencyMs = Date.now() - receivedAt;
    onchainReactionCount++;
    onchainLatencyLog.push(latencyMs);
    if (onchainLatencyLog.length > 200) onchainLatencyLog.shift();
  } catch (e) { console.warn(`[Sync反応] 失敗:`, e.message); }
}
function getOnchainLatencyStats() {
  if (onchainLatencyLog.length === 0) return null;
  const sorted = [...onchainLatencyLog].sort((a, b) => a - b);
  return { count: onchainReactionCount, medianMs: sorted[Math.floor(sorted.length / 2)], minMs: sorted[0], maxMs: sorted[sorted.length - 1] };
}

// ===== 定期観測(発掘用) =====
const DEX_PROSPECT_REFRESH_INTERVAL_MS = 60 * 60 * 1000;
let dexCachedCandidates = [], dexCandidateRotationOffset = 0, dexLastProspectAt = 0, dexProspectRefreshing = false;
async function dexGetCandidates(topN) {
  const now = Date.now();
  if ((dexCachedCandidates.length === 0 || now - dexLastProspectAt > DEX_PROSPECT_REFRESH_INTERVAL_MS) && !dexProspectRefreshing) {
    dexProspectRefreshing = true;
    try {
      const prospect = await runProspect({ topN: 150 });
      dexCachedCandidates = prospect.topPairs; dexLastProspectAt = now; dexCandidateRotationOffset = 0;
      console.log(`[DEX] 候補ペア再選定完了: ${dexCachedCandidates.length}件`);
    } catch (e) { console.error("[DEX] 候補ペア選定に失敗:", e.message); }
    finally { dexProspectRefreshing = false; }
  }
  const total = dexCachedCandidates.length;
  if (total === 0) return [];
  const batchSize = Math.min(topN, total), start = dexCandidateRotationOffset % total, selected = [];
  for (let i = 0; i < batchSize; i++) selected.push(dexCachedCandidates[(start + i) % total]);
  dexCandidateRotationOffset = (start + batchSize) % total;
  return selected;
}

async function runWatchCycle({ topN = 8 } = {}) {
  const candidates = await dexGetCandidates(topN);
  if (candidates.length === 0) return { checked: 0, logged: 0, results: [] };
  const results = [];
  for (const candidate of candidates) {
    try {
      const observed = await dexWatchOnePair(candidate);
      if (observed) { results.push(observed); await evaluateAndMaybeExecute(observed, "定期観測"); }
    } catch (e) { console.warn(`[DEX] 観測失敗 (${candidate.symbol} / ${candidate.chain}):`, e.message); }
  }
  console.log(`[DEX] 定期観測完了: 対象${candidates.length}件・記録${results.length}件・黒字${results.filter(r=>r.profitable).length}件 / 実行可能ペア${getVerifiedPairCount()}件`);
  return { checked: candidates.length, logged: results.length, results };
}

const DEX_WATCH_INTERVAL_SEC = parseInt(process.env.DEX_WATCH_INTERVAL_SEC || "70", 10);
let dexWatchRunning = false, dexWatchCount = 0, lastDexError = null, latestDexResults = [];
async function dexWatchOnce() {
  if (dexWatchRunning) return;
  dexWatchRunning = true;
  try {
    const result = await runWatchCycle({ topN: 8 });
    for (const r of result.results) if (!latestDexResults.some((x) => x.pairLabel === r.pairLabel)) latestDexResults = [r, ...latestDexResults].slice(0, 30);
    dexWatchCount++;
  } catch (e) { lastDexError = e.message; console.error("DEX観測エラー:", e.message); }
  finally { dexWatchRunning = false; }
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
  const real = getRealExecutionStats(), isLive = process.env.DRY_RUN === "false";
  const rows = real.recent.map((e) => `<tr><td>${new Date(e.timestamp).toLocaleString('ja-JP')}</td><td style="font-size:9px;">${e.pairLabel}</td>
    <td style="text-align:right;">$${e.tradeAmountUsd.toFixed(2)}</td><td style="text-align:right;color:#2ecc71;font-weight:600;">${e.actualProfitUsd != null ? `${e.actualProfitUsd >= 0 ? '+' : ''}$${e.actualProfitUsd.toFixed(4)}` : '取得できず'}</td>
    <td><a href="${e.explorerUrl}" target="_blank">確認</a></td></tr>`).join('') || `<tr><td colspan="5" style="color:#888;">まだ実際の取引はありません</td></tr>`;
  return `<div class="card real"><h2>💰 実際の取引結果(本物のお金)</h2>
    <div class="stat"><div><div class="v">${real.count}</div><div class="l">実行回数</div></div>
      <div><div class="v" style="color:${real.totalProfitUsd>=0?'#2ecc71':'#e74c3c'};">${real.totalProfitUsd>=0?'+':''}$${real.totalProfitUsd.toFixed(4)}</div><div class="l">実際の累積利益</div></div>
      <div><div class="v">$${getCurrentTradeCapUsd()}</div><div class="l">現在の取引上限</div></div>
      <div><div class="v" style="color:${isLive?'#2ecc71':'#888'};">${isLive ? '稼働中' : '停止中'}</div><div class="l">自動売買</div></div></div>
    <table><thead><tr><th>日時</th><th>ペア</th><th style="text-align:right;">投入額</th><th style="text-align:right;">実際の利益</th><th></th></tr></thead><tbody>${rows}</tbody></table>
    <div class="note"><strong>これが本当のお金の結果です。</strong>取引上限は成功実績(${getSuccessCount()}回)に応じて自動的に上がります($500→$1000→$2000)。</div></div>`;
}
function renderFastWatchSection() {
  const pairs = getVerifiedPairs(), throttle = getThrottleStatus(), rpc = getRpcStatus(), gas = getGasCostStatus();
  const byChain = {};
  for (const p of pairs) byChain[p.chain] = (byChain[p.chain] || 0) + 1;
  const chainList = Object.entries(byChain).map(([c, n]) => { const t = throttle[c]; return `${c}:${n}${t && t.pausedForSec > 0 ? `<span style="color:#e74c3c;">(${t.pausedForSec}秒休止中)</span>` : ''}`; }).join(' / ') || 'なし';
  const gasList = Object.entries(gas).map(([c, g]) => `${c}: $${g.costUsd}(${g.gwei}gwei)`).join(' / ') || '取得中';
  const rpcList = Object.entries(rpc).map(([c, r]) => `${c}: ${r.url.replace(/^https?:\/\//, '')}`).join('<br>');
  const rows = pairs.slice(0, 25).map((p) => `<tr><td style="font-size:9px;">${p.symbol}</td><td>${p.chain}</td>
    <td style="font-size:9px;">${p.pools.map((x) => `${x.dexId}${x.feeBps != null ? `(${x.feeBps}bps)` : ''}`).join(', ')}</td></tr>`).join('') || `<tr><td colspan="3" style="color:#888;">まだ登録されていません</td></tr>`;
  return `<div class="card"><h2>⚡ 高速観測(実行可能ペア)</h2>
    <div class="stat"><div><div class="v">${pairs.length}</div><div class="l">実行可能ペア</div></div><div><div class="v">${FAST_WATCH_INTERVAL_SEC}秒</div><div class="l">観測間隔</div></div>
      <div><div class="v">${fastWatchCount}</div><div class="l">観測回数</div></div><div><div class="v">${fastWatchLastAt ? new Date(fastWatchLastAt).toLocaleTimeString('ja-JP') : '-'}</div><div class="l">最終観測</div></div></div>
    <table><thead><tr><th>ペア</th><th>チェーン</th><th>DEX(実測手数料)</th></tr></thead><tbody>${rows}</tbody></table>
    <div class="note">異なるDEXのプールが2つ以上あるペアを、Multicallで一括読み取り。手数料はプール自身から逆算した実測値。<br>内訳: ${chainList}<br>実測ガス代(1回あたり): ${gasList}<br>使用中RPC:<br>${rpcList}</div></div>`;
}
function renderPage() {
  const dexStats = dexLoadStats(), lat = getOnchainLatencyStats();
  const dexRows = latestDexResults.slice(0, 15).map((r, i) => `<tr><td>${i+1}</td><td style="font-size:9px;">${r.pairLabel} ${(r.reserveSource || "").startsWith("onchain") ? `<span class="badge">実測</span>` : ''}</td><td style="text-align:right;">${r.priceDiffPercent.toFixed(2)}%</td>
    <td style="text-align:right;color:${r.profitable?'#2ecc71':'#888'};font-weight:600;">${r.netProfit>=0?'+':''}$${r.netProfit.toFixed(2)}</td></tr>`).join("") || `<tr><td colspan="4" style="color:#888;">観測データがまだありません</td></tr>`;
  return `<!DOCTYPE html><html lang="ja"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"><meta http-equiv="refresh" content="30">
<title>DEXアービトラージ観測所</title><style>${PAGE_STYLE}</style></head><body>
<h1>🔍 DEXアービトラージ観測所</h1><div class="sub">定期観測${dexWatchCount}回 / 高速観測${fastWatchCount}回 / 観測上限$${MAX_TRADE_USD}</div>
${renderRealExecutionSection()}${renderFastWatchSection()}
<div class="card"><h2>🔍 観測データ(紙上シミュレーション)</h2>
  <div class="stat"><div><div class="v">${dexStats.totalObserved}</div><div class="l">記録件数</div></div><div><div class="v" style="color:${dexStats.totalProfitableCount>0?'#2ecc71':'#888'};">${dexStats.totalProfitableCount}</div><div class="l">黒字だった件数</div></div>
    <div><div class="v" style="color:#2ecc71;">${dexStats.onchainVerifiedCount||0}</div><div class="l">うちオンチェーン実測</div></div><div><div class="v" style="color:#2ecc71;">+$${(dexStats.onchainVerifiedProfit||0).toFixed(2)}</div><div class="l">実測ベースの利益</div></div></div>
  <table><thead><tr><th>#</th><th>ペア</th><th style="text-align:right;">価格差</th><th style="text-align:right;">純利益</th></tr></thead><tbody>${dexRows}</tbody></table>
  <div class="note"><strong>これは「もし取引していたら」の理論値です。</strong>同じ案件は3分に1回だけ数えます。理論上の累積利益(全件): ${dexStats.cumulativeProfit>=0?'+':''}$${dexStats.cumulativeProfit.toFixed(2)}。${lastDexError ? `<br><span style="color:#e74c3c;">エラー: ${lastDexError}</span>` : ''}</div></div>
${lat ? `<div class="card"><h2>⚡ Sync反応速度</h2><div class="stat"><div><div class="v">${lat.count}</div><div class="l">反応回数</div></div><div><div class="v">${lat.medianMs}ms</div><div class="l">中央値</div></div><div><div class="v">${lat.minMs}ms</div><div class="l">最速</div></div><div><div class="v">${lat.maxMs}ms</div><div class="l">最遅</div></div></div><div class="note">取引が起きた瞬間の通知を受けてから判定完了までの実測時間(Polygon)。</div></div>` : ''}
<div class="footerlink"><a href="/about">→ このサイトが集めているデータについて</a></div></body></html>`;
}
function renderAboutPage() {
  return `<!DOCTYPE html><html lang="ja"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"><title>収集データについて</title><style>${PAGE_STYLE}</style></head><body>
<h1>📊 このサイトが集めているデータ</h1>
<div class="card"><h2>① 発掘(定期観測)</h2><div class="note">DeFiLlamaから、流動性$3万〜$300万の中小プールで、かつルーター確認済みDEXが2つ以上あるペアを150件選びます。専業botが常時監視する大型ペアは価格差が手数料を超えないため、意図的に避けています。手数料の低いPolygon・Arbitrumを優先します。</div></div>
<div class="card"><h2>② 高速観測(${FAST_WATCH_INTERVAL_SEC}秒ごと)</h2><div class="note">実行可能ペアだけを、Multicall3で一括読み取り。手数料はプール自身のgetAmountOutから逆算した実測値を使います(Aerodromeは実測99bpsで、既定の30bpsとは大きく違いました)。</div></div>
<div class="card"><h2>③ ガス代の実測</h2><div class="note">チェーンの現在のガス価格とネイティブトークンのUSD価格から、1回あたりの実費を5分ごとに算出します。以前は一律$0.05の固定値で、実際の10倍近い過大見積もりになっていました。</div></div>
<div class="card"><h2>④ 実行</h2><div class="note">実行直前にプール自身へ問い合わせて受取量を確定し、Aave手数料(0.05%)込みの返済額を上回り、かつ最低利益以上の場合のみ送信します。利益が出なければ取引全体が無効化されます(実害はガス代のみ)。</div></div>
<div class="footerlink"><a href="/">← 観測所トップに戻る</a></div></body></html>`;
}
function startServer() {
  const port = process.env.PORT || 8080;
  http.createServer((req, res) => { res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }); res.end(req.url === "/about" ? renderAboutPage() : renderPage()); }).listen(port, () => console.log(`観測所ページ: ポート${port}`));
}

async function main() {
  console.log("=== DEXアービトラージ観測所 起動 ===");
  startServer();
  if (process.env.RUN_TESTNET_DEPLOY_CHECK === "true") { try { await runTestnetDeployCheck(); } catch (e) { console.error("[テストネット検証] 失敗:", e.message); } }
  const deployTarget = process.env.RUN_MAINNET_DEPLOY;
  if (deployTarget && deployTarget !== "false") { try { await runMainnetDeploy(deployTarget); } catch (e) { console.error("[本番デプロイ] 失敗:", e.message); } }

  pruneInvalidVerifiedPairs();
  startOnchainFeeds(handleOnchainSync);
  for (const [chain, pairs] of Object.entries(getVerifiedPairsByChain())) updatePoolSubscriptions(chain, pairs.flatMap((p) => p.pools.map((x) => x.address)));

  await refreshGasCosts();
  setInterval(refreshGasCosts, 5 * 60 * 1000);
  console.log(`[起動] 実行可能ペア${getVerifiedPairCount()}件 / 高速観測${FAST_WATCH_INTERVAL_SEC}秒 / 定期観測${DEX_WATCH_INTERVAL_SEC}秒 / 取引上限$${getCurrentTradeCapUsd()}`);

  dexWatchOnce();
  setInterval(dexWatchOnce, DEX_WATCH_INTERVAL_SEC * 1000);
  setTimeout(fastWatchOnce, 5000);
  setInterval(fastWatchOnce, FAST_WATCH_INTERVAL_SEC * 1000);
}
main().catch((e) => { console.error("致命的エラー:", e); process.exit(1); });
