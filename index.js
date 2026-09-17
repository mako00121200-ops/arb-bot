// index.js
//
// [設計] イベント駆動型のDEXアービトラージbot。V2形式とV3形式の両方を扱う。
//
// [V3は価格表で判定する]
// 独自の近似式は公式Quoterより最大2,184%も過大な値を返していた(2026年9月16日)。
// V3は価格帯ごとに流動性が分かれており、近似式では表現できない。
// プールごとに公式Quoterで「代表的な投入額での受取量」を取得して表にし、
// 判定時はそこから補間する。RPCを使わずミリ秒で済み、誤差もない。
// 価格が動いたプールは表を作り直す。
//
// [問い合わせを束ねる(2026年9月16日)]
// Chainstackは1回=1リクエスト単位で課金される。V3の状態読み(1プール2回)と
// 価格表の作成(1プール12回)を個別に出していたため、Polygonだけで月約1,100万
// 単位に達していた。どちらもMulticall3で束ね、複数プール分を1〜数回で済ませる。
//
// [WebSocketの無いチェーンでも価格表を作り直す(2026年9月16日)]
// 価格表の作り直しは「WebSocketでSwapが届いた時」にしか予約されていなかった。
// Optimism・Arbitrum・Avalancheは定期読み直しで価格だけが更新され、表は
// 起動時のまま古くなり続けた。これが同じ経路を毎分「黒字」と誤判定し続けた
// 原因。定期読み直しでも価格が動いていれば表を作り直す。
//
// [フラッシュスワップ方式]
// 経路の最初のプール自身から先に受け取るため、借入手数料がかからず、
// 桁数と価格が分かる通貨なら何でも始点にできる。
//
// [監視対象の絞り込み]
// 2段の裁定は「同じペアに2つ以上のプールがある」時にしか成立しない。
// 候補だけに絞ることでイベント量が1/10になり、費用が予算内に収まる。

import http from "http";
import { ethers } from "ethers";
import { startOnchainFeeds, getSyncStats, isChainWsEnabled, isChainHealthy, setWatchedAddresses } from "./dex-onchain-realtime.js";
import { runMainnetDeploy } from "./scripts/mainnet-deploy.js";
import { runPoolSurvey } from "./scripts/pool-survey.js";
import { getRealExecutionStats } from "./scripts/real-execution-log.js";
import { getCurrentTradeCapUsd, getSuccessCount } from "./scripts/trade-cap.js";
import { probePoolFeeBps, getRpcStatus, getRpcCallTotals, callWithRpc } from "./scripts/onchain-reserves.js";
import { updateRpcUsage, formatRpcUsageLine } from "./scripts/rpc-usage.js";
import {
  fetchReservesBatch, fetchPoolTokensBatch, fetchTokenDecimalsBatch,
  fetchV3StatesBatch, getMulticallStats,
} from "./scripts/multicall-reserves.js";
import { estimateGasCostUsd, getGasCostStatus } from "./scripts/gas-cost.js";
import { discoverFactory, discoverPoolsFromFactory } from "./scripts/pool-discovery.js";
import {
  registerPool, removePool, pruneToCandidates, getSubscribedAddresses,
  updateReservesFromSync, updateV3FromSwap, setPoolFee, getPool, getStats,
  setTokenDecimals, getTokenDecimals, setTokenPriceUsd, getTokenPriceUsd,
  getAllPoolAddressesByChain, getPoolsForToken, getStalePools, getPoolsByKind,
  getArbitragablePairs, savePoolMap, loadPoolMap, snapshotFullMap,
  hasUsableState, clearPoolState, KIND_V2, KIND_V3,
} from "./scripts/pool-registry.js";
import { scanForChangedPool, scanAllPairs } from "./scripts/opportunity-scanner.js";
import { executeOpportunity, ExecutionError, TAX_TOKEN_FEE_BPS } from "./scripts/execute-opportunity.js";
import {
  getKnownTokens, isStableToken, isBorrowable,
  markUsableStart, clearUsableStarts, countUsableStarts,
} from "./scripts/borrowable-tokens.js";
import { getVerifiedPairs } from "./scripts/verified-pairs.js";
import { isKnownIncompatiblePool, recordIncompatiblePool } from "./scripts/incompatible-pools.js";
import { journal, loadJournal, trimJournalIfNeeded, summarize } from "./scripts/opportunity-journal.js";
import {
  V3_FACTORIES, V3_FEE_TIERS, findV3Pool, feeTierToBps,
  buildQuoteTablesBatch, hasQuoteTable, clearQuoteTable, countQuoteTables,
  verifyQuoteTable, QUOTE_SAMPLES_USD,
} from "./scripts/v3-pools.js";
import { CHAIN_CONFIG } from "./chain-config.js";

const MIN_PROFIT_USD = parseFloat(process.env.MIN_PROFIT_USD || "0.01");
const FULL_SCAN_INTERVAL_SEC = parseInt(process.env.FULL_SCAN_INTERVAL_SEC || "30", 10);
const REFRESH_STALE_SEC = parseInt(process.env.REFRESH_STALE_SEC || "60", 10);
const REFRESH_BATCH_SIZE = parseInt(process.env.REFRESH_BATCH_SIZE || "600", 10);
// V3の状態を読み直す本数(20秒ごと)。束ねて読むので本数を増やしても1〜2回で済む。
const V3_REFRESH_PER_TICK = parseInt(process.env.V3_REFRESH_PER_TICK || "120", 10);
// 価格表を作り直すプール数(1回あたり)。束ねて問い合わせるので数回で済む。
const QUOTE_TABLE_PER_TICK = parseInt(process.env.QUOTE_TABLE_PER_TICK || "6", 10);
const QUOTE_TABLE_INTERVAL_MS = parseInt(process.env.QUOTE_TABLE_INTERVAL_MS || "5000", 10);
// 価格が動いたV3プールは表を作り直す。この割合(%)以上動いたら対象。
const QUOTE_REBUILD_MOVE_PCT = parseFloat(process.env.QUOTE_REBUILD_MOVE_PCT || "0.1");
const FEE_PROBE_PER_TICK = parseInt(process.env.FEE_PROBE_PER_TICK || "4", 10);
const FEE_PROBE_INTERVAL_MS = 1000;
const SAVE_MAP_INTERVAL_MS = 5 * 60 * 1000;
const MAP_REBUILD_AFTER_HOURS = parseInt(process.env.MAP_REBUILD_AFTER_HOURS || "168", 10);
const HEARTBEAT_INTERVAL_MS = 60 * 1000;
const EXECUTION_TIMEOUT_MS = parseInt(process.env.EXECUTION_TIMEOUT_MS || "20000", 10);
const FAILURE_COOLDOWN_MS = 10 * 60 * 1000;
const DISABLE_AFTER_FAILURES = 3;
const MAX_SANE_RETURN_RATIO = parseFloat(process.env.MAX_SANE_RETURN_RATIO || "0.20");
const BIG_MOVE_PCT = parseFloat(process.env.BIG_MOVE_PCT || "0.5");
const V3_VERIFY_INTERVAL_MS = parseInt(process.env.V3_VERIFY_INTERVAL_MS || "120000", 10);
const MIN_PRICE_SOURCE_USD = parseFloat(process.env.MIN_PRICE_SOURCE_USD || "5000");
const PRICE_REFRESH_INTERVAL_MS = 5 * 60 * 1000;
const SCAM_REVERT_PATTERNS = [/blacklist/i, /not allowed/i, /forbidden/i, /trading (is )?not (enabled|open)/i, /cooldown/i, /max ?tx/i, /max ?wallet/i, /antiwhale/i];

// ===== ガス代 =====
const FALLBACK_GAS = { base: 0.010, arbitrum: 0.035, optimism: 0.005, polygon: 0.014, avalanche: 0.001 };
const gasCostCache = new Map();
function getGasCost(chain, kind = "2step") {
  return gasCostCache.get(`${chain}::${kind}`) ?? FALLBACK_GAS[chain] ?? 0.02;
}
async function refreshGasCosts() {
  for (const chain of Object.keys(CHAIN_CONFIG)) {
    for (const kind of ["2step", "3step"]) {
      try { gasCostCache.set(`${chain}::${kind}`, await estimateGasCostUsd(chain, kind)); } catch (e) {}
    }
  }
}

// ===== 統計 =====
const reasons = { disabled: 0, taxToken: 0, cooldown: 0, trap: 0, belowMin: 0, executing: 0, notSent: 0, failed: 0, success: 0 };
const failStages = {};

const stats = {
  scans: 0, profitableFound: 0, examined: 0, executed: 0, failed: 0,
  skippedCooldown: 0, trapsRejected: 0, taxTokensRejected: 0, staleRejected: 0, bigMoves: 0,
  v3Found: 0, v3Matched: 0, v3Opportunities: 0, v3LiquidityEvents: 0,
  quoteTablesBuilt: 0, quoteTablesPending: 0, quoteRebuildsFromPolling: 0,
  v3VerifyCount: 0, v3VerifyWorst: null, v3VerifyRecent: [],
  disabledFromFile: 0, disabledRuntime: 0,
  prunedTotal: 0, prunedKept: 0,
  decimalsKnown: 0, pricedTokens: 0,
  lastOpportunity: null, recent: [], syncMatched: 0, syncUnknown: 0, disabled: 0,
  latencies: [], refreshCycles: 0, mapSource: "-", mapSavedAt: null,
  feeProbed: 0, feeProbePending: 0, lastHeartbeat: null, reservesLoaded: 0, journalLoaded: 0,
};

const chainReady = new Set();
function isReady(chain) { return chainReady.has(chain); }
function anyReady() { return chainReady.size > 0; }

// ===== 失敗の抑制と無効化 =====
const cooldownUntil = new Map();
const poolFailures = new Map();
const disabledPools = new Set();

function poolKeyOf(chain, address) { return `${chain}::${address.toLowerCase()}`; }

function disablePool(chain, address, reason, fromFile = false) {
  const key = poolKeyOf(chain, address);
  if (disabledPools.has(key)) return;
  disabledPools.add(key);
  stats.disabled++;
  if (fromFile) stats.disabledFromFile++; else stats.disabledRuntime++;
  clearPoolState(getPool(chain, address));
  clearQuoteTable(chain, address);
  if (!fromFile) {
    recordIncompatiblePool(chain, address, reason);
    console.log(`[無効化] ${chain} ${address.slice(0, 10)}…: ${reason.slice(0, 70)}`);
  }
}

function isScamRevert(message) {
  return SCAM_REVERT_PATTERNS.some((re) => re.test(message || ""));
}

function noteExecutionFailure(opp, error) {
  const reason = error?.message || String(error);
  const stage = error instanceof ExecutionError ? error.stage : "unknown";
  failStages[stage] = (failStages[stage] || 0) + 1;
  cooldownUntil.set(opp.poolAddresses.join("|").toLowerCase(), Date.now() + FAILURE_COOLDOWN_MS);

  if (error instanceof ExecutionError && error.taxToken) {
    stats.taxTokensRejected++;
    const targets = error.taxPools?.length ? error.taxPools : opp.poolAddresses;
    for (const address of targets) {
      disablePool(opp.chain, address, `送金時に税を取るトークン(手数料${TAX_TOKEN_FEE_BPS}bps超)`);
    }
    return;
  }
  if (error instanceof ExecutionError && error.staleReserves) {
    stats.staleRejected++;
    return;
  }

  const scam = isScamRevert(reason);
  for (const address of opp.poolAddresses) {
    const key = poolKeyOf(opp.chain, address);
    const n = (poolFailures.get(key) || 0) + 1;
    poolFailures.set(key, n);
    if (scam) {
      disablePool(opp.chain, address, `詐欺トークン: ${reason}`);
    } else if (n >= DISABLE_AFTER_FAILURES) {
      disablePool(opp.chain, address, `送信失敗${n}回(価格が信用できない): ${reason}`);
    }
  }
}

function hasDisabledPool(opp) {
  return opp.poolAddresses.some((a) => disabledPools.has(poolKeyOf(opp.chain, a)));
}

function pruneTaxTokenPools(opp) {
  let found = false;
  for (const address of opp.poolAddresses) {
    const pool = getPool(opp.chain, address);
    if (!pool || pool.kind === KIND_V3 || !pool.feeProbed) continue;
    if (pool.feeBps > TAX_TOKEN_FEE_BPS) {
      stats.taxTokensRejected++;
      disablePool(opp.chain, address, `実測手数料${pool.feeBps}bps(税トークン)`);
      found = true;
    }
  }
  return found;
}

function rejectIfTrap(opp) {
  if (opp.tradeAmountUsd <= 0) return false;
  const ratio = opp.netProfitUsd / opp.tradeAmountUsd;
  if (ratio <= MAX_SANE_RETURN_RATIO) return false;
  stats.trapsRejected++;
  const reason = `異常なリターン${(ratio * 100).toFixed(0)}%`;
  if (opp.hasV3) {
    console.log(`[罠の疑い] ${opp.kind} ${opp.chain} ${opp.label}: ${reason}。見送ります`);
    cooldownUntil.set(opp.poolAddresses.join("|").toLowerCase(), Date.now() + FAILURE_COOLDOWN_MS);
    return true;
  }
  console.log(`[罠] ${opp.kind} ${opp.chain} ${opp.label}: ${reason}(投入$${opp.tradeAmountUsd.toFixed(2)}→利益$${opp.netProfitUsd.toFixed(2)})。無効化します`);
  for (const address of opp.poolAddresses) disablePool(opp.chain, address, reason);
  return true;
}

// ===== 記録簿 =====
function record(opp, outcome, extra = {}) {
  journal({
    outcome, chain: opp.chain, kind: opp.kind, label: opp.label, hasV3: !!opp.hasV3,
    tradeAmountUsd: Number(opp.tradeAmountUsd?.toFixed?.(4) ?? 0),
    netProfitUsd: Number(opp.netProfitUsd?.toFixed?.(6) ?? 0),
    feeWallPercent: opp.feeWallPercent,
    pools: opp.poolAddresses,
    ...extra,
  });
}

// ===== トークンの桁数と価格 =====
async function loadTokenDecimals(chain) {
  const known = getKnownTokens(chain);
  const needed = new Set();
  for (const kind of [KIND_V2, KIND_V3]) {
    for (const pool of getPoolsByKind(chain, kind)) {
      for (const t of [pool.token0, pool.token1]) {
        if (known[t] || getTokenDecimals(chain, t) != null) continue;
        needed.add(t);
      }
    }
  }
  for (const [address, info] of Object.entries(known)) {
    setTokenDecimals(chain, address, info.decimals);
  }
  if (needed.size === 0) return 0;
  const found = await fetchTokenDecimalsBatch(chain, [...needed]);
  for (const [address, decimals] of found) setTokenDecimals(chain, address, decimals);
  return found.size;
}

function derivePriceFromStablePools(chain, token) {
  const decimals = getTokenDecimals(chain, token);
  if (decimals == null) return null;
  let best = null, bestLiquidityUsd = 0;
  for (const pool of getPoolsForToken(chain, token)) {
    if (pool.kind !== KIND_V2) continue;
    if (pool.raw0 <= 0n || pool.raw1 <= 0n) continue;
    const other = pool.token0 === token ? pool.token1 : pool.token0;
    if (!isStableToken(chain, other)) continue;
    const otherDecimals = getTokenDecimals(chain, other);
    if (otherDecimals == null) continue;
    const isToken0 = pool.token0 === token;
    const reserveToken = isToken0 ? pool.raw0 : pool.raw1;
    const reserveStable = isToken0 ? pool.raw1 : pool.raw0;
    const tokenAmount = Number(reserveToken) / Math.pow(10, decimals);
    const stableAmount = Number(reserveStable) / Math.pow(10, otherDecimals);
    if (tokenAmount <= 0 || stableAmount < MIN_PRICE_SOURCE_USD) continue;
    if (stableAmount > bestLiquidityUsd) {
      bestLiquidityUsd = stableAmount;
      best = stableAmount / tokenAmount;
    }
  }
  return best && isFinite(best) && best > 0 ? best : null;
}

function refreshTokenPrices() {
  clearUsableStarts();
  let priced = 0;
  for (const chain of Object.keys(CHAIN_CONFIG)) {
    for (const [address, info] of Object.entries(getKnownTokens(chain))) {
      setTokenDecimals(chain, address, info.decimals);
      if (info.stable) setTokenPriceUsd(chain, address, 1);
      else if (info.priceHintUsd && !getTokenPriceUsd(chain, address)) {
        setTokenPriceUsd(chain, address, info.priceHintUsd);
      }
    }
    for (let round = 0; round < 2; round++) {
      for (const pool of getPoolsByKind(chain, KIND_V2)) {
        for (const token of [pool.token0, pool.token1]) {
          if (getTokenPriceUsd(chain, token)) continue;
          const price = derivePriceFromStablePools(chain, token);
          if (price) setTokenPriceUsd(chain, token, price);
        }
      }
    }
    const seen = new Set();
    for (const kind of [KIND_V2, KIND_V3]) {
      for (const pool of getPoolsByKind(chain, kind)) {
        for (const token of [pool.token0, pool.token1]) {
          if (seen.has(token)) continue;
          seen.add(token);
          if (getTokenDecimals(chain, token) == null) continue;
          if (!getTokenPriceUsd(chain, token)) continue;
          markUsableStart(chain, token);
          priced++;
        }
      }
    }
  }
  stats.pricedTokens = priced;
  return priced;
}

// ===== V3の価格表 =====
// 公式Quoterに代表的な投入額を問い合わせ、結果を表として保持する。
// 判定はこの表から補間するため、RPCを使わずミリ秒で済み、誤差もない。

const quoteRebuildQueue = new Set(); // "chain::pool" 作り直しが必要なプール

function queueQuoteRebuild(chain, address) {
  quoteRebuildQueue.add(poolKeyOf(chain, address));
}

/// 指定した投入額(USD)を、そのトークンの生の整数に直す。
function usdToAmount(chain, token, usd) {
  const decimals = getTokenDecimals(chain, token);
  const priceUsd = getTokenPriceUsd(chain, token);
  if (decimals == null || !priceUsd) return null;
  const amount = usd / priceUsd;
  try {
    const [intPart, fracPart = ""] = amount.toFixed(Math.min(decimals, 18)).split(".");
    const v = BigInt(intPart + fracPart.padEnd(decimals, "0").slice(0, decimals));
    return v > 0n ? v : null;
  } catch (e) { return null; }
}

/// 1つのV3プールについて、両方向の価格表の「作り方」を用意する(RPCは使わない)。
function quoteJobsForPool(pool) {
  const chain = pool.chain;
  const jobs = [];
  for (const zeroForOne of [true, false]) {
    const tokenIn = zeroForOne ? pool.token0 : pool.token1;
    const tokenOut = zeroForOne ? pool.token1 : pool.token0;
    const amountsIn = [];
    for (const usd of QUOTE_SAMPLES_USD) {
      const amount = usdToAmount(chain, tokenIn, usd);
      if (amount) amountsIn.push(amount);
    }
    if (amountsIn.length === 0) continue;
    jobs.push({ pool: pool.address, zeroForOne, tokenIn, tokenOut, feeTier: pool.feeTier, amountsIn });
  }
  return jobs;
}

/// 複数のV3プールの価格表を、チェーンごとにまとめて作る。
async function buildTablesForPools(pools) {
  const byChain = new Map();
  for (const pool of pools) {
    const jobs = quoteJobsForPool(pool);
    if (jobs.length === 0) continue;
    if (!byChain.has(pool.chain)) byChain.set(pool.chain, []);
    byChain.get(pool.chain).push(...jobs);
  }
  let built = 0;
  await Promise.all([...byChain.entries()].map(async ([chain, jobs]) => {
    try { built += await buildQuoteTablesBatch(chain, jobs); } catch (e) {}
  }));
  return built;
}

let quoteCursor = 0;
let quoteRefreshRunning = false;
async function refreshQuoteTables() {
  if (!anyReady() || quoteRefreshRunning) return;
  quoteRefreshRunning = true;
  try {
    const selected = [];

    // 価格が動いたプールを優先して作り直す。
    const urgent = [...quoteRebuildQueue].slice(0, QUOTE_TABLE_PER_TICK);
    for (const key of urgent) {
      quoteRebuildQueue.delete(key);
      if (disabledPools.has(key)) continue;
      const [chain, address] = key.split("::");
      const pool = getPool(chain, address);
      if (!pool || pool.kind !== KIND_V3) continue;
      selected.push(pool);
    }

    // 残り枠で、表がまだ無いプール(破棄された表を含む)を順に埋める。
    const budget = QUOTE_TABLE_PER_TICK - urgent.length;
    if (budget > 0) {
      const targets = [];
      for (const chain of chainReady) {
        for (const pool of getPoolsByKind(chain, KIND_V3)) {
          if (disabledPools.has(poolKeyOf(chain, pool.address))) continue;
          if (!hasUsableState(pool)) continue;
          const done = hasQuoteTable(chain, pool.address, true) && hasQuoteTable(chain, pool.address, false);
          if (!done) targets.push(pool);
        }
      }
      stats.quoteTablesPending = targets.length + quoteRebuildQueue.size;
      for (let i = 0; i < Math.min(budget, targets.length); i++) {
        selected.push(targets[quoteCursor % targets.length]);
        quoteCursor++;
      }
    } else {
      stats.quoteTablesPending = quoteRebuildQueue.size;
    }

    if (selected.length === 0) return;
    stats.quoteTablesBuilt += await buildTablesForPools(selected);
  } finally {
    quoteRefreshRunning = false;
  }
}

/// 価格表の補間が公式Quoterとどれだけ一致するかを確かめる。
let v3VerifyCursor = 0;
async function verifyV3Calculations() {
  if (!anyReady()) return;
  const candidates = [];
  for (const chain of chainReady) {
    for (const pool of getPoolsByKind(chain, KIND_V3)) {
      if (disabledPools.has(poolKeyOf(chain, pool.address))) continue;
      if (!hasQuoteTable(chain, pool.address, true)) continue;
      candidates.push(pool);
    }
  }
  if (candidates.length === 0) return;
  const pool = candidates[v3VerifyCursor % candidates.length];
  v3VerifyCursor++;

  // 表の点と点の間の値で確かめる($20は表にない値)。
  const amountIn = usdToAmount(pool.chain, pool.token0, 20);
  if (!amountIn) return;

  const result = await verifyQuoteTable({
    chain: pool.chain, pool: pool.address, zeroForOne: true,
    tokenIn: pool.token0, tokenOut: pool.token1, feeTier: pool.feeTier, amountIn,
  });
  if (!result) return;

  stats.v3VerifyCount++;
  const entry = {
    chain: pool.chain, address: pool.address, dexId: pool.dexId,
    feeBps: pool.feeBps, diffPercent: result.diffPercent, at: new Date().toISOString(),
  };
  stats.v3VerifyRecent = [entry, ...stats.v3VerifyRecent].slice(0, 10);
  if (!stats.v3VerifyWorst || Math.abs(result.diffPercent) > Math.abs(stats.v3VerifyWorst.diffPercent)) {
    stats.v3VerifyWorst = entry;
  }
  if (Math.abs(result.diffPercent) > 1) {
    console.log(`[V3検証] ${pool.chain} ${pool.address.slice(0, 10)}…(${(pool.feeBps / 100).toFixed(2)}%): 補間が公式より${result.diffPercent > 0 ? "過大" : "過小"}${Math.abs(result.diffPercent).toFixed(2)}%`);
  }
}

// ===== V3プールの発見と状態 =====
async function discoverV3PoolsForChain(chain) {
  const factories = V3_FACTORIES[chain];
  if (!factories) return 0;
  const tokens = Object.keys(getKnownTokens(chain));
  if (tokens.length < 2) return 0;
  let found = 0;
  for (const factory of factories) {
    for (let i = 0; i < tokens.length; i++) {
      for (let j = i + 1; j < tokens.length; j++) {
        for (const feeTier of V3_FEE_TIERS) {
          const address = await findV3Pool(chain, factory.address, tokens[i], tokens[j], feeTier);
          if (!address) continue;
          if (isKnownIncompatiblePool(chain, address)) continue;
          const [t0, t1] = [tokens[i].toLowerCase(), tokens[j].toLowerCase()].sort();
          registerPool({
            chain, address, dexId: factory.dexId, factory: factory.address, kind: KIND_V3,
            token0: t0, token1: t1, feeTier, feeBps: feeTierToBps(feeTier),
          });
          found++;
        }
      }
    }
  }
  return found;
}

async function loadV3StatesForChain(chain) {
  const pools = getPoolsByKind(chain, KIND_V3).filter((p) => !disabledPools.has(poolKeyOf(chain, p.address)));
  if (pools.length === 0) return 0;
  let states;
  try {
    states = await fetchV3StatesBatch(chain, pools.map((p) => p.address));
  } catch (e) {
    return 0;
  }
  let loaded = 0;
  for (const pool of pools) {
    const s = states.get(pool.address.toLowerCase());
    if (!s) continue;
    updateV3FromSwap(chain, pool.address, s.sqrtPriceX96, s.liquidity);
    loaded++;
  }
  return loaded;
}

const v3NeedsRefresh = new Set();
let v3RefreshCursor = 0;
let v3RefreshRunning = false;
async function refreshV3States() {
  if (!anyReady() || v3RefreshRunning) return;
  v3RefreshRunning = true;
  try {
    const urgentByChain = new Map();
    const normalByChain = new Map();
    const push = (map, chain, address) => {
      if (!map.has(chain)) map.set(chain, []);
      map.get(chain).push(address);
    };

    // 流動性が変わったプールを優先する。
    const urgentKeys = [...v3NeedsRefresh].slice(0, V3_REFRESH_PER_TICK);
    for (const key of urgentKeys) {
      v3NeedsRefresh.delete(key);
      if (disabledPools.has(key)) continue;
      const [chain, address] = key.split("::");
      push(urgentByChain, chain, address);
    }

    // 残り枠で、WebSocketが無い(または不達の)チェーンのV3を順に読み直す。
    const budget = V3_REFRESH_PER_TICK - urgentKeys.length;
    if (budget > 0) {
      const targets = [];
      for (const chain of chainReady) {
        if (isChainWsEnabled(chain) && isChainHealthy(chain)) continue;
        for (const pool of getPoolsByKind(chain, KIND_V3)) {
          if (disabledPools.has(poolKeyOf(chain, pool.address))) continue;
          targets.push(pool);
        }
      }
      for (let n = 0; n < Math.min(budget, targets.length); n++) {
        const pool = targets[v3RefreshCursor % targets.length];
        v3RefreshCursor++;
        push(normalByChain, pool.chain, pool.address);
      }
    }

    const jobs = [];
    for (const [chain, addresses] of urgentByChain) {
      jobs.push((async () => {
        const states = await fetchV3StatesBatch(chain, addresses, true);
        for (const address of addresses) {
          const s = states.get(address.toLowerCase());
          if (!s) continue;
          updateV3FromSwap(chain, address, s.sqrtPriceX96, s.liquidity);
          queueQuoteRebuild(chain, address);
        }
      })());
    }
    for (const [chain, addresses] of normalByChain) {
      jobs.push((async () => {
        const states = await fetchV3StatesBatch(chain, addresses, false);
        for (const address of addresses) {
          const s = states.get(address.toLowerCase());
          if (!s) continue;
          const pool = updateV3FromSwap(chain, address, s.sqrtPriceX96, s.liquidity);
          // 定期読み直しでも、価格が動いていれば表を作り直す。
          if (pool && (pool.lastMovePct || 0) >= QUOTE_REBUILD_MOVE_PCT) {
            queueQuoteRebuild(chain, address);
            stats.quoteRebuildsFromPolling++;
          }
        }
      })());
    }
    await Promise.all(jobs.map((j) => j.catch(() => {})));
  } finally {
    v3RefreshRunning = false;
  }
}

// ===== プール地図 =====
function collectSeedPools() {
  const seedsByChain = {};
  for (const pair of getVerifiedPairs()) {
    if (!CHAIN_CONFIG[pair.chain]) continue;
    if (!seedsByChain[pair.chain]) seedsByChain[pair.chain] = new Map();
    for (const pool of pair.pools) {
      const dexId = (pool.dexId || "unknown").toLowerCase();
      if (!seedsByChain[pair.chain].has(dexId)) seedsByChain[pair.chain].set(dexId, pool.address);
    }
  }
  return seedsByChain;
}

const knownFactories = new Set();

async function buildPoolMapFromFactories() {
  const seedsByChain = collectSeedPools();
  const totalSeeds = Object.values(seedsByChain).reduce((s, m) => s + m.size, 0);
  if (totalSeeds === 0) return;
  console.log(`[プール地図] 種プール${totalSeeds}件からファクトリーを逆算します`);
  for (const [chain, dexMap] of Object.entries(seedsByChain)) {
    for (const [dexId, address] of dexMap.entries()) {
      try {
        const factory = await discoverFactory(chain, address);
        if (!factory) continue;
        const fkey = `${chain}::${factory.toLowerCase()}`;
        if (knownFactories.has(fkey)) continue;
        knownFactories.add(fkey);
        const pools = await discoverPoolsFromFactory(chain, factory, dexId);
        for (const p of pools) {
          if (isKnownIncompatiblePool(chain, p.address)) continue;
          registerPool({ ...p, kind: KIND_V2 });
        }
      } catch (e) {
        console.warn(`[プール発見] ${dexId} on ${chain}: 失敗 ${e.message.slice(0, 70)}`);
      }
    }
  }
}

async function prepareChain(chain) {
  try {
    const v3 = await discoverV3PoolsForChain(chain);
    stats.v3Found += v3;

    const addresses = getAllPoolAddressesByChain(KIND_V2)[chain] || [];
    let loaded = 0;
    const CHUNK = 1000;
    for (let i = 0; i < addresses.length; i += CHUNK) {
      const chunk = addresses.slice(i, i + CHUNK);
      try {
        const batch = await fetchReservesBatch(chain, chunk.map((a) => ({ address: a })));
        for (const address of chunk) {
          const r = batch.get(address.toLowerCase());
          if (r && r.raw0 > 0n && r.raw1 > 0n) {
            updateReservesFromSync(chain, address, r.raw0, r.raw1);
            loaded++;
          }
        }
      } catch (e) {}
    }
    stats.reservesLoaded += loaded;

    const v3Loaded = await loadV3StatesForChain(chain);
    const decimalsFound = await loadTokenDecimals(chain);
    stats.decimalsKnown += decimalsFound;

    for (const key of disabledPools) {
      if (!key.startsWith(`${chain}::`)) continue;
      const [, address] = key.split("::");
      clearPoolState(getPool(chain, address));
    }

    const watched = getSubscribedAddresses(chain).filter((a) => !disabledPools.has(poolKeyOf(chain, a)));
    setWatchedAddresses(chain, watched);

    chainReady.add(chain);
    console.log(`[準備完了] ${chain}: V2 ${loaded}件 / V3 ${v3Loaded}件、桁数${decimalsFound}トークン、${watched.length}プールを監視します`);
  } catch (e) {
    console.error(`[準備] ${chain}: 失敗 ${e.message.slice(0, 100)}`);
  }
}

async function preparePoolMap() {
  const saved = loadPoolMap();
  let needBuild = saved.count === 0;
  if (saved.count > 0) {
    const ageHours = saved.savedAt ? (Date.now() - new Date(saved.savedAt).getTime()) / 3600000 : 999;
    console.log(`[プール地図] 保存済みを読み込みました: ${saved.count}プール(${ageHours.toFixed(1)}時間前)`);
    stats.mapSource = "保存済み";
    stats.mapSavedAt = saved.savedAt;
    if (ageHours > MAP_REBUILD_AFTER_HOURS) needBuild = true;
  }
  if (needBuild) {
    stats.mapSource = saved.count > 0 ? "保存済み+再構築" : "新規構築";
    await buildPoolMapFromFactories();
  }

  for (const [chain, addresses] of Object.entries(getAllPoolAddressesByChain())) {
    for (const address of addresses) {
      if (isKnownIncompatiblePool(chain, address)) disablePool(chain, address, "過去の記録から復元", true);
    }
  }
  console.log(`[無効化] 過去の記録から${stats.disabledFromFile}件を復元しました`);

  const full = snapshotFullMap();
  const { kept, removed } = pruneToCandidates();
  stats.prunedTotal = removed;
  stats.prunedKept = kept;
  console.log(`[絞り込み] 全${full}プールのうち、裁定候補${kept}プールを残し${removed}プールを監視対象から外しました`);

  const s = getStats();
  console.log(`[プール地図] 候補: V2 ${s.byKind.v2}件 / V3 ${s.byKind.v3}件 / ${s.arbitragablePairs}ペア(うちV2とV3が共存${s.mixedPairs}件)`);

  await Promise.all(Object.keys(CHAIN_CONFIG).map((chain) => prepareChain(chain)));

  const priced = refreshTokenPrices();
  console.log(`[始点] 桁数と価格が揃い、経路の始点として使えるトークン: ${priced}件`);
  console.log(`[V3価格表] 公式Quoterで作成を開始します(V3プール${s.byKind.v3}件 × 2方向、まとめて問い合わせ)`);

  savePoolMap();
  stats.mapSavedAt = new Date().toISOString();
}

// ===== V2の手数料の実測 =====
let feeProbeQueue = [];
async function probeFeesGradually() {
  if (!anyReady()) return;
  if (feeProbeQueue.length === 0) {
    const pending = [];
    const seen = new Set();
    for (const entry of getArbitragablePairs()) {
      if (!isReady(entry.chain)) continue;
      for (const p of entry.pools) {
        if (p.kind === KIND_V3 || p.feeProbed) continue;
        const key = poolKeyOf(p.chain, p.address);
        if (disabledPools.has(key) || seen.has(key)) continue;
        seen.add(key);
        pending.push({ chain: p.chain, address: p.address });
      }
    }
    feeProbeQueue = pending;
    stats.feeProbePending = feeProbeQueue.length;
    if (feeProbeQueue.length === 0) return;
    console.log(`[手数料実測] 裁定候補のうち未実測${feeProbeQueue.length}プールを確認します`);
  }
  const batch = feeProbeQueue.splice(0, FEE_PROBE_PER_TICK);
  stats.feeProbePending = feeProbeQueue.length;
  await Promise.all(batch.map(async ({ chain, address }) => {
    const pool = getPool(chain, address);
    if (!pool) return;
    try {
      const fee = await probePoolFeeBps({ chain, pairAddress: address, tokenInAddress: pool.token0, reserveIn: pool.raw0, reserveOut: pool.raw1 });
      if (fee != null) {
        if (fee !== 30) setPoolFee(chain, address, fee);
        pool.feeProbed = true;
        stats.feeProbed++;
        if (fee > TAX_TOKEN_FEE_BPS) {
          stats.taxTokensRejected++;
          disablePool(chain, address, `実測手数料${fee}bps(税トークン)`);
        }
      }
    } catch (e) {}
  }));
}

// ===== 機会が見つかった時の処理 =====
const executing = new Set();
async function handleOpportunity(opp, meta = {}) {
  stats.examined++;
  if (hasDisabledPool(opp)) { reasons.disabled++; return; }
  if (pruneTaxTokenPools(opp)) { reasons.taxToken++; record(opp, "tax_token"); return; }

  const key = opp.poolAddresses.join("|").toLowerCase();
  const until = cooldownUntil.get(key);
  if (until && Date.now() < until) { reasons.cooldown++; stats.skippedCooldown++; return; }

  if (rejectIfTrap(opp)) { reasons.trap++; record(opp, "trap"); return; }
  if (!opp.profitable) return;

  stats.profitableFound++;
  if (opp.hasV3) stats.v3Opportunities++;
  stats.lastOpportunity = new Date().toISOString();
  stats.recent = [{ ...opp, at: new Date().toISOString(), ...meta }, ...stats.recent.filter((r) => r.label !== opp.label)].slice(0, 20);

  if (opp.netProfitUsd < MIN_PROFIT_USD) { reasons.belowMin++; record(opp, "below_min", meta); return; }
  if (executing.has(key)) { reasons.executing++; return; }
  executing.add(key);
  try {
    console.log(`[機会] ${opp.kind} ${opp.chain} ${opp.label}: 純利益+$${opp.netProfitUsd.toFixed(4)}(投入$${opp.tradeAmountUsd.toFixed(2)} 壁${opp.feeWallPercent.toFixed(2)}%${opp.hasV3 ? " V3含む" : ""})`);
    const ok = await Promise.race([
      executeOpportunity(opp),
      new Promise((_, reject) => setTimeout(() => reject(new ExecutionError("実行が制限時間を超えました", { stage: "timeout" })), EXECUTION_TIMEOUT_MS)),
    ]);
    if (ok) {
      stats.executed++; reasons.success++;
      cooldownUntil.delete(key);
      record(opp, "success", meta);
    } else {
      reasons.notSent++;
      cooldownUntil.set(key, Date.now() + 30 * 1000);
      record(opp, "not_sent", meta);
    }
  } catch (e) {
    stats.failed++; reasons.failed++;
    const msg = (e.message || "").slice(0, 120);
    const stage = e instanceof ExecutionError ? e.stage : "unknown";
    console.warn(`[実行] 失敗(${stage}): ${msg}`);
    noteExecutionFailure(opp, e);
    record(opp, "failed", { ...meta, error: msg, stage });
  } finally {
    executing.delete(key);
  }
}

function reactToPoolChange(chain, poolAddress, pool, receivedAt, source) {
  if (!isReady(chain)) return;
  const movePct = pool.lastMovePct || 0;
  if (movePct >= BIG_MOVE_PCT) stats.bigMoves++;
  try {
    const opp = scanForChangedPool({
      chain, poolAddress, capUsd: getCurrentTradeCapUsd(),
      gasCostUsd: getGasCost(chain, "2step"), gasCostUsd3: getGasCost(chain, "3step"), isBorrowable,
    });
    const latency = Date.now() - receivedAt;
    stats.latencies.push(latency);
    if (stats.latencies.length > 200) stats.latencies.shift();
    if (opp) handleOpportunity(opp, { source, movePct }).catch(() => {});
  } catch (e) {}
}

function handleSync(chain, poolAddress, reserve0, reserve1, receivedAt) {
  if (disabledPools.has(poolKeyOf(chain, poolAddress))) return false;
  const pool = updateReservesFromSync(chain, poolAddress, reserve0, reserve1);
  if (!pool) { stats.syncUnknown++; return false; }
  stats.syncMatched++;
  reactToPoolChange(chain, poolAddress, pool, receivedAt, "sync");
  return true;
}

function handleV3Swap(chain, poolAddress, sqrtPriceX96, liquidity, receivedAt) {
  if (disabledPools.has(poolKeyOf(chain, poolAddress))) return false;
  const pool = updateV3FromSwap(chain, poolAddress, sqrtPriceX96, liquidity);
  if (!pool) return false;
  stats.v3Matched++;
  // 価格が動いたら表を作り直す。小さな変化では作り直さない。
  if ((pool.lastMovePct || 0) >= QUOTE_REBUILD_MOVE_PCT) queueQuoteRebuild(chain, poolAddress);
  reactToPoolChange(chain, poolAddress, pool, receivedAt, "v3swap");
  return true;
}

function handleV3Liquidity(chain, poolAddress) {
  const key = poolKeyOf(chain, poolAddress);
  if (disabledPools.has(key)) return false;
  const pool = getPool(chain, poolAddress);
  if (!pool || pool.kind !== KIND_V3) return false;
  stats.v3LiquidityEvents++;
  v3NeedsRefresh.add(key);
  queueQuoteRebuild(chain, poolAddress);
  return true;
}

// ===== 全件スキャン =====
let fullScanRunning = false;
async function fullScanOnce() {
  if (fullScanRunning || !anyReady()) return;
  fullScanRunning = true;
  try {
    for (const chain of chainReady) {
      const opportunities = scanAllPairs({
        chain, capUsd: getCurrentTradeCapUsd(),
        gasCostUsd: getGasCost(chain, "2step"), gasCostUsd3: getGasCost(chain, "3step"), isBorrowable,
      });
      for (const opp of opportunities.slice(0, 3)) await handleOpportunity(opp, { source: "scan" });
    }
    stats.scans++;
  } catch (e) {
    console.error(`[全件スキャン] エラー: ${e.message.slice(0, 100)}`);
  } finally {
    fullScanRunning = false;
  }
}

// ===== V2準備量の読み直し =====
let refreshRunning = false;
async function refreshStaleReserves() {
  if (refreshRunning || !anyReady()) return;
  refreshRunning = true;
  try {
    for (const chain of chainReady) {
      if (isChainWsEnabled(chain) && isChainHealthy(chain)) continue;
      const stale = getStalePools(chain, REFRESH_STALE_SEC * 1000, KIND_V2)
        .filter((p) => !disabledPools.has(poolKeyOf(chain, p.address)))
        .slice(0, REFRESH_BATCH_SIZE);
      if (stale.length === 0) continue;
      const batch = await fetchReservesBatch(chain, stale.map((p) => ({ address: p.address })));
      for (const pool of stale) {
        const r = batch.get(pool.address.toLowerCase());
        if (r) updateReservesFromSync(chain, pool.address, r.raw0, r.raw1);
      }
    }
    stats.refreshCycles++;
  } catch (e) {
  } finally {
    refreshRunning = false;
  }
}

// ===== コントラクトに溜まった利益 =====
const BALANCE_ABI = ["function balancesOf(address[] tokens) view returns (uint256[])"];
let contractBalances = {};
async function refreshContractBalances() {
  if (!anyReady()) return;
  const out = {};
  for (const [chain, config] of Object.entries(CHAIN_CONFIG)) {
    const address = process.env[config.contractAddressEnvVar];
    if (!address) continue;
    const tokens = Object.entries(getKnownTokens(chain));
    if (tokens.length === 0) continue;
    try {
      const amounts = await callWithRpc(chain, (p) =>
        new ethers.Contract(address, BALANCE_ABI, p).balancesOf(tokens.map(([a]) => a)));
      const held = [];
      for (let i = 0; i < tokens.length; i++) {
        const [, info] = tokens[i];
        if (amounts[i] > 0n) {
          const amount = Number(amounts[i]) / Math.pow(10, info.decimals);
          const usd = amount * (getTokenPriceUsd(chain, tokens[i][0]) ?? 0);
          held.push({ symbol: info.symbol, amount, usd });
        }
      }
      if (held.length > 0) out[chain] = held;
    } catch (e) {}
  }
  contractBalances = out;
}

// ===== 生存確認 =====
function heartbeat() {
  stats.lastHeartbeat = new Date().toISOString();
  const rpc = getRpcStatus();
  const queued = Object.entries(rpc).filter(([, v]) => v.queued > 0).map(([c, v]) => `${c}:${v.normalQueued}`).join(" ");
  const stageLine = Object.entries(failStages).map(([k, v]) => `${k}:${v}`).join(" ") || "なし";
  const sync = getSyncStats();
  const ev = Object.entries(sync).map(([c, v]) => `${c}:${v.received}`).join(" ") || "なし";
  const mc = getMulticallStats();
  // RPCの月間使用量を更新する。呼び出しとWebSocket受信の両方が枠を消費する。
  // 生存ログは稼働の健全性を見る唯一の手段なので、使用量の計測が失敗しても
  // ログ自体は必ず出るようにする。
  let usageLine = "";
  try {
    const wsEvents = Object.values(sync).reduce((sum, v) => sum + (v.received || 0), 0);
    usageLine = " " + formatRpcUsageLine(updateRpcUsage(getRpcCallTotals().total, wsEvents));
  } catch (e) {
    usageLine = " 枠[計測できず: " + e.message + "]";
  }
  console.log(`[生存] 稼働${[...chainReady].join(",") || "なし"} 始点${countUsableStarts()} 価格表${countQuoteTables()}(待${stats.quoteTablesPending} 定期で作り直し${stats.quoteRebuildsFromPolling}) スキャン${stats.scans} 精査${stats.examined} 黒字${stats.profitableFound} 実行${stats.executed}/${stats.failed} 内訳[無効${reasons.disabled} 冷却${reasons.cooldown} 罠${reasons.trap} 下限${reasons.belowMin} 見送${reasons.notSent}] 失敗段階[${stageLine}] 受信[${ev}] 手数料${stats.feeProbed}(残${stats.feeProbePending}) 行列[${queued || "空"}] 束ね[${mc.calls}回で${mc.subcalls}件]${usageLine}`);
}

// ===== ダッシュボード =====
const STYLE = `body{font-family:-apple-system,sans-serif;background:#0d100c;color:#e8e6d8;margin:0;padding:18px 12px}
h1{font-size:17px;margin:0 0 4px}h2{font-size:13px;margin:0 0 10px;font-weight:600}
.sub{color:#888;font-size:11px;margin-bottom:16px}
.card{background:#14180f;border:1px solid #2a331d;border-radius:8px;padding:13px;margin-bottom:13px}
.card.real{border-color:#2ecc71}
table{width:100%;border-collapse:collapse;font-size:11px}
th{text-align:left;color:#888;font-weight:500;font-size:9.5px;padding:5px 3px;border-bottom:1px solid #2a331d}
td{padding:6px 3px;border-bottom:1px solid #1c1c1c}
.note{font-size:10px;color:#888;line-height:1.6;margin-top:9px;padding-top:9px;border-top:1px solid #222}
.stat{display:grid;grid-template-columns:repeat(4,1fr);gap:6px;margin-bottom:13px}
.stat div{background:#14180f;border:1px solid #2a331d;border-radius:8px;padding:11px 4px;text-align:center}
.stat .v{font-size:17px;font-weight:600}.stat .l{font-size:8.5px;color:#888;margin-top:2px}
a{color:#6fae62}.footerlink{margin-top:18px;font-size:11px}`;

const REASON_LABEL = {
  disabled: "無効化済みのプールを含む", taxToken: "税トークン", cooldown: "冷却中(直近に失敗)",
  trap: "罠または計算の誤差", belowMin: `最低利益$${MIN_PROFIT_USD}未満`, executing: "実行中で重複",
  notSent: "送信条件を満たさず", failed: "送信に失敗", success: "送信成功",
};
const STAGE_LABEL = {
  state: "状態取得に失敗(RPCが遅い)", quote: "受取量の確定に失敗", estimateGas: "ガス見積もりで拒否",
  feeLadder: "手数料を上げても拒否", shortfall: "量が足りず拒否", send: "送信時のエラー", wait: "確定待ちで失敗",
  timeout: "制限時間超過", unknown: "不明",
};

function renderPage() {
  const s = getStats();
  const real = getRealExecutionStats();
  const isLive = process.env.DRY_RUN === "false";
  const lat = stats.latencies.length ? [...stats.latencies].sort((a, b) => a - b)[Math.floor(stats.latencies.length / 2)] : null;
  const syncStats = getSyncStats();
  const rpc = getRpcStatus();
  const gas = getGasCostStatus();
  const hbAge = stats.lastHeartbeat ? Math.round((Date.now() - new Date(stats.lastHeartbeat).getTime()) / 1000) : null;
  const sum = summarize(24);
  const maxQueue = Math.max(0, ...Object.values(rpc).map((v) => v.queued));
  const totalEvents = Object.values(syncStats).reduce((a, v) => a + v.received, 0);
  const mc = getMulticallStats();

  const realRows = real.recent.map((e) => `<tr><td>${new Date(e.timestamp).toLocaleString('ja-JP')}</td><td style="font-size:9px">${e.pairLabel}</td>
    <td style="text-align:right">$${e.tradeAmountUsd.toFixed(2)}</td>
    <td style="text-align:right;color:#2ecc71;font-weight:600">${e.actualProfitUsd != null ? `+$${e.actualProfitUsd.toFixed(4)}` : '-'}</td>
    <td><a href="${e.explorerUrl}" target="_blank">確認</a></td></tr>`).join('') || `<tr><td colspan="5" style="color:#888">まだ実際の取引はありません</td></tr>`;

  const oppRows = stats.recent.slice(0, 10).map((o, i) => `<tr><td>${i+1}</td>
    <td style="font-size:9px">${o.kind} ${o.chain}${o.hasV3 ? ' <span style="color:#6fae62">V3</span>' : ''}<br>${o.label}</td>
    <td style="text-align:right">${o.feeWallPercent.toFixed(2)}%</td>
    <td style="text-align:right">$${o.tradeAmountUsd.toFixed(2)}</td>
    <td style="text-align:right;color:#2ecc71;font-weight:600">+$${o.netProfitUsd.toFixed(4)}</td></tr>`).join('') || `<tr><td colspan="5" style="color:#888">まだ黒字の機会が見つかっていません</td></tr>`;

  const reasonRows = Object.entries(reasons).filter(([, v]) => v > 0).sort((a,b)=>b[1]-a[1]).map(([k, v]) =>
    `<tr><td>${REASON_LABEL[k] || k}</td><td style="text-align:right">${v.toLocaleString()}件</td></tr>`).join('') || `<tr><td colspan="2" style="color:#888">まだ記録がありません</td></tr>`;

  const stageRows = Object.entries(failStages).sort((a,b)=>b[1]-a[1]).map(([k, v]) =>
    `<tr><td>${STAGE_LABEL[k] || k}</td><td style="text-align:right">${v.toLocaleString()}件</td></tr>`).join('') || `<tr><td colspan="2" style="color:#888">送信の失敗はありません</td></tr>`;

  const verifyRows = stats.v3VerifyRecent.map((v) => `<tr>
    <td style="font-size:9px">${v.chain}<br>${v.address.slice(0, 10)}…(${(v.feeBps/100).toFixed(2)}%)</td>
    <td style="text-align:right;color:${Math.abs(v.diffPercent) > 5 ? '#e74c3c' : Math.abs(v.diffPercent) > 1 ? '#e8a33d' : '#2ecc71'}">${v.diffPercent > 0 ? '+' : ''}${v.diffPercent.toFixed(3)}%</td>
    </tr>`).join('') || `<tr><td colspan="2" style="color:#888">まだ検証していません</td></tr>`;

  const balanceLine = Object.entries(contractBalances).map(([c, held]) =>
    `${c}: ${held.map((h) => `${h.symbol} ${h.amount.toFixed(4)}($${h.usd.toFixed(2)})`).join(" / ")}`).join('<br>') || '残高なし';

  const syncLine = Object.entries(syncStats).map(([c, v]) =>
    `${c}: ${v.watched.toLocaleString()}プールを${v.subscriptions}回で購読 / 受信 V2 ${v.v2.toLocaleString()}・V3 ${v.v3.toLocaleString()}・流動性 ${v.liquidity.toLocaleString()} ${v.healthy ? '<span style="color:#2ecc71">正常</span>' : `<span style="color:#e74c3c">不達</span>`}`
  ).join('<br>') || 'WebSocket未設定';

  const gasLine = Object.entries(gas).map(([c, g]) => `${c}: $${g.costUsd}`).join(' / ') || '取得中';
  const readyLine = Object.keys(CHAIN_CONFIG).map((c) => `${c}: ${isReady(c) ? '<span style="color:#2ecc71">稼働中</span>' : '<span style="color:#e8a33d">準備中</span>'}`).join(' / ');
  const startsLine = Object.keys(CHAIN_CONFIG).map((c) => `${c}:${countUsableStarts(c)}`).join(' / ');

  return `<!DOCTYPE html><html lang="ja"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"><meta http-equiv="refresh" content="20">
<title>DEXアービトラージ</title><style>${STYLE}</style></head><body>
<h1>🔍 DEXアービトラージ</h1><div class="sub">フラッシュスワップ方式 / V2 + V3 / ${readyLine}</div>

<div class="card real"><h2>💰 実際の取引結果</h2>
<div class="stat"><div><div class="v">${real.count}</div><div class="l">実行回数</div></div>
<div><div class="v" style="color:#2ecc71">+$${real.totalProfitUsd.toFixed(4)}</div><div class="l">累積利益</div></div>
<div><div class="v">$${getCurrentTradeCapUsd()}</div><div class="l">取引上限</div></div>
<div><div class="v" style="color:${isLive?'#2ecc71':'#888'}">${isLive?'稼働中':'停止中'}</div><div class="l">自動売買</div></div></div>
<table><thead><tr><th>日時</th><th>経路</th><th style="text-align:right">投入</th><th style="text-align:right">利益</th><th></th></tr></thead><tbody>${realRows}</tbody></table>
<div class="note">経路の最初のプール自身から先に受け取るため、借入手数料はかかりません。<br>コントラクトに溜まっている利益: ${balanceLine}</div></div>

<div class="card"><h2>📐 V3の価格表(公式Quoter)</h2>
<div class="stat"><div><div class="v" style="color:#6fae62">${countQuoteTables().toLocaleString()}</div><div class="l">作成済みの表</div></div>
<div><div class="v">${stats.quoteTablesPending.toLocaleString()}</div><div class="l">作成待ち</div></div>
<div><div class="v" style="color:${stats.v3VerifyWorst && Math.abs(stats.v3VerifyWorst.diffPercent) > 5 ? '#e74c3c' : '#2ecc71'}">${stats.v3VerifyWorst ? stats.v3VerifyWorst.diffPercent.toFixed(2) + '%' : '-'}</div><div class="l">補間の最大誤差</div></div>
<div><div class="v">${stats.v3Opportunities}</div><div class="l">V3を含む機会</div></div></div>
<table><thead><tr><th>プール</th><th style="text-align:right">補間と公式の差</th></tr></thead><tbody>${verifyRows}</tbody></table>
<div class="note">V3は価格帯ごとに流動性が分かれるため、独自の近似式では最大2,184%も過大な値になりました。今はプールごとに公式Quoterで「代表的な投入額での受取量」を取得して表にし、判定はそこから補間しています。価格が動いた表は作り直します(WebSocketの無いチェーンでも、定期読み直しで価格の動きを検知して作り直します。これまでに${stats.quoteRebuildsFromPolling}回)。<br>表が無いV3プールは判定に使いません(幻の機会を防ぐため)。</div></div>

<div class="card"><h2>🔎 機会がどこで止まっているか</h2>
<div class="stat"><div><div class="v">${stats.examined.toLocaleString()}</div><div class="l">精査した経路</div></div>
<div><div class="v" style="color:${stats.profitableFound>0?'#2ecc71':'#888'}">${stats.profitableFound}</div><div class="l">黒字と判定</div></div>
<div><div class="v" style="color:${stats.executed>0?'#2ecc71':'#888'}">${stats.executed}</div><div class="l">送信成功</div></div>
<div><div class="v" style="color:${stats.failed>0?'#e74c3c':'#888'}">${stats.failed}</div><div class="l">送信失敗</div></div></div>
<table><thead><tr><th>止まった理由</th><th style="text-align:right">件数</th></tr></thead><tbody>${reasonRows}</tbody></table>
<div class="note"><strong>送信に失敗した段階</strong></div>
<table><thead><tr><th>段階</th><th style="text-align:right">件数</th></tr></thead><tbody>${stageRows}</tbody></table></div>

<div class="card"><h2>📡 監視対象と始点</h2>
<div class="stat"><div><div class="v" style="color:#6fae62">${stats.prunedKept.toLocaleString()}</div><div class="l">監視中プール</div></div>
<div><div class="v">${countUsableStarts().toLocaleString()}</div><div class="l">始点に使える通貨</div></div>
<div><div class="v">${totalEvents.toLocaleString()}</div><div class="l">受信イベント</div></div>
<div><div class="v">${s.arbitragablePairs.toLocaleString()}</div><div class="l">裁定候補ペア</div></div></div>
<div class="note">${syncLine}<br>始点の内訳: ${startsLine}</div></div>

<div class="card"><h2>🩺 システムの健全性</h2>
<div class="stat"><div><div class="v" style="color:${hbAge != null && hbAge < 120 ? '#2ecc71' : '#e74c3c'}">${hbAge != null ? hbAge + '秒前' : '-'}</div><div class="l">最終生存確認</div></div>
<div><div class="v" style="color:${maxQueue > 500 ? '#e74c3c' : maxQueue > 100 ? '#e8a33d' : '#2ecc71'}">${maxQueue.toLocaleString()}</div><div class="l">待ち行列</div></div>
<div><div class="v">${lat != null ? lat + 'ms' : '-'}</div><div class="l">判定時間</div></div>
<div><div class="v">${stats.feeProbed.toLocaleString()}</div><div class="l">手数料実測済み</div></div></div>
<div class="note">実測ガス代(2step): ${gasLine}<br>
問い合わせの束ね: ${mc.calls.toLocaleString()}回の呼び出しで${mc.subcalls.toLocaleString()}件を処理(分割再試行${mc.splits}回)<br>
プール: V2 ${s.byKind.v2.toLocaleString()} / V3 ${s.byKind.v3.toLocaleString()}(V2とV3が共存${s.mixedPairs}ペア)<br>
チェーン別: ${Object.entries(s.byChain).map(([c, n]) => `${c}:${n.toLocaleString()}`).join(' / ') || '構築中'}<br>
無効化${stats.disabled}件(過去の記録${stats.disabledFromFile} / 今回${stats.disabledRuntime})<br>
手数料の未実測: 残${stats.feeProbePending.toLocaleString()}プール</div></div>

<div class="card"><h2>📒 24時間の記録簿</h2>
<div class="stat"><div><div class="v">${sum.count.toLocaleString()}</div><div class="l">記録件数</div></div>
<div><div class="v" style="color:#e8a33d">+$${sum.profitableUsd.toFixed(3)}</div><div class="l">黒字判定の合計</div></div>
<div><div class="v" style="color:#2ecc71">+$${sum.realizedUsd.toFixed(4)}</div><div class="l">実際に得た利益</div></div>
<div><div class="v">${stats.bigMoves.toLocaleString()}</div><div class="l">大口取引の検知</div></div></div>
<table><thead><tr><th>#</th><th>経路</th><th style="text-align:right">壁</th><th style="text-align:right">投入</th><th style="text-align:right">純利益</th></tr></thead><tbody>${oppRows}</tbody></table></div>

<div class="footerlink"><a href="/about">→ 仕組みについて</a></div></body></html>`;
}

function renderAbout() {
  return `<!DOCTYPE html><html lang="ja"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"><title>仕組み</title><style>${STYLE}</style></head><body>
<h1>📊 仕組み</h1>
<div class="card"><h2>① フラッシュスワップ方式</h2><div class="note">経路の最初のプールから出力通貨を先に受け取り、残りの経路を回って投入通貨に戻し、それで最初のプールに支払います。外部から借りないため手数料がかからず、始点に使える通貨の制限もありません。</div></div>
<div class="card"><h2>② V3は公式Quoterの価格表で判定</h2><div class="note">V3は価格帯ごとに流動性が分かれるため、現在価格と流動性だけの近似式では正しく計算できません(実測で最大2,184%の過大)。プールごとに公式Quoterで代表的な投入額の受取量を取得して表にし、判定はそこから補間します。表が無いプールは判定に使いません。</div></div>
<div class="card"><h2>③ 始点に使える通貨</h2><div class="note">桁数と価格が分かる通貨はすべて始点にできます。桁数はプールのトークンから一括取得し、価格は安定通貨と繋がるプールから逆算します。</div></div>
<div class="card"><h2>④ 監視対象を絞る</h2><div class="note">2段の裁定は「同じペアに2つ以上のプールがある」時にしか成立しません。比べる相手のいないプールは監視してもイベント量が増えるだけなので、候補だけに絞っています。</div></div>
<div class="card"><h2>⑤ 問い合わせを束ねる</h2><div class="note">RPCは1回の呼び出しごとに課金されるため、V3の状態読みと価格表の作成はMulticall3で複数プール分をまとめて1回にしています。</div></div>
<div class="card"><h2>⑥ 安全策</h2><div class="note">ガス見積もりが失敗すればプールに拒否されているので、送信せずに済みガス代を失いません。利益は実行前後の残高差分で判定するため、過去の利益が残っていても誤判定しません。</div></div>
<div class="footerlink"><a href="/">← 戻る</a></div></body></html>`;
}

function startServer() {
  const port = process.env.PORT || 8080;
  http.createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(req.url === "/about" ? renderAbout() : renderPage());
  }).listen(port, () => console.log(`ダッシュボード: ポート${port}`));
}

async function main() {
  console.log("=== DEXアービトラージ(フラッシュスワップ / V2 + V3) 起動 ===");
  startServer();

  const deployTarget = process.env.RUN_MAINNET_DEPLOY;
  if (deployTarget && deployTarget !== "false") {
    try { await runMainnetDeploy(deployTarget); } catch (e) { console.error("[本番デプロイ] 失敗:", e.message); }
  }

  // 環境変数 RUN_POOL_SURVEY にチェーン名を入れた時だけ、V3型プールの調査を一度だけ行う。
  // 未監視のDEXに、いま取引しているペアのプールがあるかを確かめるための読み取り専用の処理。
  // 終わったら RUN_POOL_SURVEY を false に戻すこと。
  const surveyTarget = process.env.RUN_POOL_SURVEY;
  if (surveyTarget && surveyTarget !== "false") {
    try { await runPoolSurvey(surveyTarget); } catch (e) { console.error("[プール調査] 失敗:", e.message); }
  }

  stats.journalLoaded = loadJournal();
  if (stats.journalLoaded > 0) console.log(`[記録簿] 直近${stats.journalLoaded}件を読み込みました`);

  setInterval(heartbeat, HEARTBEAT_INTERVAL_MS);
  await refreshGasCosts();
  setInterval(refreshGasCosts, 5 * 60 * 1000);

  startOnchainFeeds(handleSync, handleV3Swap, handleV3Liquidity);

  await preparePoolMap();

  setInterval(probeFeesGradually, FEE_PROBE_INTERVAL_MS);
  setInterval(refreshStaleReserves, REFRESH_STALE_SEC * 1000);
  setInterval(refreshV3States, 20000);
  setInterval(refreshQuoteTables, QUOTE_TABLE_INTERVAL_MS);
  setInterval(verifyV3Calculations, V3_VERIFY_INTERVAL_MS);
  setInterval(refreshTokenPrices, PRICE_REFRESH_INTERVAL_MS);
  setInterval(() => { savePoolMap(); stats.mapSavedAt = new Date().toISOString(); }, SAVE_MAP_INTERVAL_MS);
  setInterval(trimJournalIfNeeded, 30 * 60 * 1000);
  setTimeout(refreshContractBalances, 30000);
  setInterval(refreshContractBalances, 10 * 60 * 1000);
  setTimeout(fullScanOnce, 10000);
  setInterval(fullScanOnce, FULL_SCAN_INTERVAL_SEC * 1000);

  console.log(`[起動] 準備完了 / 取引上限$${getCurrentTradeCapUsd()} / 最低利益$${MIN_PROFIT_USD}`);
}

main().catch((e) => { console.error("致命的エラー:", e); process.exit(1); });
