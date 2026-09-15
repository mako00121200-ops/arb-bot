// index.js
//
// [設計] イベント駆動型のDEXアービトラージbot。V2形式とV3形式の両方を扱う。
//
// ①起動時: プール地図を読み込み、V3プールをファクトリーへ問い合わせて発見。
//          状態(V2の準備量 / V3の価格と流動性)は必ず全件を取り直す。
// ②常時:   V2のSyncとV3のSwapを1つの購読で受け取り、変化した経路だけを
//          メモリ上で即座に再計算する(判定はミリ秒)。
// ③発見:   Syncが届いた未知のV2プールは自動的に取り込む。
// ④除外:   税トークン・ハニーポット・価格が信用できないプールを恒久除外。
// ⑤実行:   送信直前に状態を同時取得し、V3は公式Quoterで受取量を確定させる。
//
// [今回の修正]
//   ・手数料実測が0件のまま進まない問題: 定期読み直しが通常列を埋め尽くし、
//     実測の要求が常に破棄されていた。読み直しの量を抑え、実測に枠を残す。
//   ・黒字なのに実行に至らなかった理由を、段階ごとに記録して画面に出す。
//   ・起動直後の無効化件数の内訳(過去の記録からの復元か、今回の判定か)を出す。

import http from "http";
import { ethers } from "ethers";
import { startOnchainFeeds, getSyncStats, isChainWsEnabled, isChainHealthy } from "./dex-onchain-realtime.js";
import { runMainnetDeploy } from "./scripts/mainnet-deploy.js";
import { getRealExecutionStats } from "./scripts/real-execution-log.js";
import { getCurrentTradeCapUsd, getSuccessCount } from "./scripts/trade-cap.js";
import { probePoolFeeBps, getRpcStatus, callWithRpc } from "./scripts/onchain-reserves.js";
import { fetchReservesBatch, fetchPoolTokensBatch } from "./scripts/multicall-reserves.js";
import { estimateGasCostUsd, getGasCostStatus } from "./scripts/gas-cost.js";
import { discoverFactory, discoverPoolsFromFactory } from "./scripts/pool-discovery.js";
import {
  registerPool, updateReservesFromSync, updateV3FromSwap, setPoolFee, getPool, getStats,
  setTokenDecimals, setTokenPriceUsd, getTokenPriceUsd,
  getAllPoolAddressesByChain, getPoolsForToken, getStalePools, getPoolsByKind,
  getArbitragablePairs, savePoolMap, loadPoolMap, hasUsableState, clearPoolState,
  KIND_V2, KIND_V3,
} from "./scripts/pool-registry.js";
import { scanForChangedPool, scanAllPairs } from "./scripts/opportunity-scanner.js";
import { executeOpportunity, ExecutionError, TAX_TOKEN_FEE_BPS } from "./scripts/execute-opportunity.js";
import { isBorrowable, getBorrowableTokens } from "./scripts/borrowable-tokens.js";
import { getVerifiedPairs } from "./scripts/verified-pairs.js";
import { isKnownIncompatiblePool, recordIncompatiblePool } from "./scripts/incompatible-pools.js";
import { journal, loadJournal, trimJournalIfNeeded, summarize } from "./scripts/opportunity-journal.js";
import { V3_FACTORIES, V3_FEE_TIERS, findV3Pool, readV3State, feeTierToBps } from "./scripts/v3-pools.js";
import { CHAIN_CONFIG } from "./chain-config.js";

const MIN_PROFIT_USD = parseFloat(process.env.MIN_PROFIT_USD || "0.01");
const FULL_SCAN_INTERVAL_SEC = parseInt(process.env.FULL_SCAN_INTERVAL_SEC || "30", 10);
const REFRESH_STALE_SEC = parseInt(process.env.REFRESH_STALE_SEC || "60", 10);
// 1回の定期読み直しで扱うプール数。大きすぎると通常列を埋め尽くし、
// 手数料実測の要求が常に破棄される(2026年9月15日に実測0件の原因と判明)。
const REFRESH_BATCH_SIZE = parseInt(process.env.REFRESH_BATCH_SIZE || "600", 10);
const V3_REFRESH_PER_TICK = parseInt(process.env.V3_REFRESH_PER_TICK || "30", 10);
const FEE_PROBE_PER_TICK = parseInt(process.env.FEE_PROBE_PER_TICK || "4", 10);
const FEE_PROBE_INTERVAL_MS = 1000;
const SAVE_MAP_INTERVAL_MS = 5 * 60 * 1000;
const MAP_REBUILD_AFTER_HOURS = parseInt(process.env.MAP_REBUILD_AFTER_HOURS || "168", 10);
const HEARTBEAT_INTERVAL_MS = 60 * 1000;
// 実行の制限時間。古い機会を追い続けても取れないため短くする。
const EXECUTION_TIMEOUT_MS = parseInt(process.env.EXECUTION_TIMEOUT_MS || "20000", 10);
const ADOPT_INTERVAL_MS = 5000;
const ADOPT_PER_TICK = 40;
const FAILURE_COOLDOWN_MS = 10 * 60 * 1000;
const DISABLE_AFTER_FAILURES = 3;
const MAX_SANE_RETURN_RATIO = parseFloat(process.env.MAX_SANE_RETURN_RATIO || "0.20");
const BIG_MOVE_PCT = parseFloat(process.env.BIG_MOVE_PCT || "0.5");
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
// 黒字と判定された案件が、どの段階で止まったかを数える。
const reasons = {
  disabled: 0, taxToken: 0, cooldown: 0, trap: 0,
  belowMin: 0, executing: 0, notSent: 0, failed: 0, success: 0,
};
const failStages = {}; // 実行時の失敗を段階別に数える

const stats = {
  scans: 0, profitableFound: 0, examined: 0, executed: 0, failed: 0,
  skippedCooldown: 0, trapsRejected: 0, taxTokensRejected: 0, staleRejected: 0, bigMoves: 0,
  v3Found: 0, v3Matched: 0, v3Opportunities: 0,
  disabledFromFile: 0, disabledRuntime: 0,
  lastOpportunity: null, recent: [], syncMatched: 0, syncUnknown: 0, adopted: 0, disabled: 0,
  latencies: [], ready: false, refreshCycles: 0, mapSource: "-", mapSavedAt: null,
  feeProbed: 0, feeProbePending: 0, lastHeartbeat: null, reservesLoaded: 0, journalLoaded: 0,
};

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
    return; // RPCが遅かっただけ。プールのせいではない
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

// ===== Syncで見つかった未知のV2プールを取り込む =====
const pendingAdoption = new Map();
const rejectedPools = new Set();

function queueUnknownPool(chain, address, raw0, raw1) {
  const key = poolKeyOf(chain, address);
  if (rejectedPools.has(key) || pendingAdoption.has(key) || disabledPools.has(key)) return;
  if (isKnownIncompatiblePool(chain, address)) { rejectedPools.add(key); return; }
  pendingAdoption.set(key, { chain, address, raw0, raw1 });
}

async function adoptPendingPools() {
  if (!stats.ready || pendingAdoption.size === 0) return;
  const byChain = new Map();
  for (const [key, v] of pendingAdoption) {
    if (!byChain.has(v.chain)) byChain.set(v.chain, []);
    if (byChain.get(v.chain).length < ADOPT_PER_TICK) {
      byChain.get(v.chain).push({ key, ...v });
      pendingAdoption.delete(key);
    }
  }
  for (const [chain, items] of byChain) {
    try {
      const tokens = await fetchPoolTokensBatch(chain, items.map((i) => i.address));
      for (const item of items) {
        const t = tokens.get(item.address.toLowerCase());
        if (!t) { rejectedPools.add(item.key); continue; }
        registerPool({ chain, address: item.address, dexId: "sync発見", kind: KIND_V2, token0: t.token0, token1: t.token1, raw0: item.raw0, raw1: item.raw1 });
        stats.adopted++;
      }
    } catch (e) {
      for (const item of items) pendingAdoption.set(item.key, item);
    }
  }
}

// ===== V3プールの発見 =====
async function discoverV3Pools() {
  let found = 0;
  for (const [chain, factories] of Object.entries(V3_FACTORIES)) {
    if (!CHAIN_CONFIG[chain]) continue;
    const borrowables = Object.keys(getBorrowableTokens(chain));
    if (borrowables.length < 2) continue;
    for (const factory of factories) {
      for (let i = 0; i < borrowables.length; i++) {
        for (let j = i + 1; j < borrowables.length; j++) {
          for (const feeTier of V3_FEE_TIERS) {
            const address = await findV3Pool(chain, factory.address, borrowables[i], borrowables[j], feeTier);
            if (!address) continue;
            if (isKnownIncompatiblePool(chain, address)) continue;
            const [t0, t1] = [borrowables[i].toLowerCase(), borrowables[j].toLowerCase()].sort();
            registerPool({
              chain, address, dexId: factory.dexId, factory: factory.address, kind: KIND_V3,
              token0: t0, token1: t1, feeTier, feeBps: feeTierToBps(feeTier),
            });
            found++;
          }
        }
      }
    }
  }
  stats.v3Found = found;
  console.log(`[V3発見] 完了: ${found}プールを登録しました`);
}

async function loadV3States() {
  let loaded = 0;
  for (const chain of Object.keys(CHAIN_CONFIG)) {
    for (const pool of getPoolsByKind(chain, KIND_V3)) {
      if (disabledPools.has(poolKeyOf(chain, pool.address))) continue;
      const state = await readV3State(chain, pool.address);
      if (state) {
        updateV3FromSwap(chain, pool.address, state.sqrtPriceX96, state.liquidity);
        loaded++;
      }
    }
  }
  console.log(`[V3] 状態を${loaded}プール分取得しました`);
}

let v3RefreshCursor = 0;
async function refreshV3States() {
  if (!stats.ready) return;
  const targets = [];
  for (const chain of Object.keys(CHAIN_CONFIG)) {
    if (isChainWsEnabled(chain) && isChainHealthy(chain)) continue;
    for (const pool of getPoolsByKind(chain, KIND_V3)) {
      if (disabledPools.has(poolKeyOf(chain, pool.address))) continue;
      targets.push(pool);
    }
  }
  if (targets.length === 0) return;
  for (let n = 0; n < Math.min(V3_REFRESH_PER_TICK, targets.length); n++) {
    const pool = targets[v3RefreshCursor % targets.length];
    v3RefreshCursor++;
    const state = await readV3State(pool.chain, pool.address);
    if (state) updateV3FromSwap(pool.chain, pool.address, state.sqrtPriceX96, state.liquidity);
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

async function loadAllReserves() {
  let loaded = 0;
  await Promise.all(Object.entries(getAllPoolAddressesByChain(KIND_V2)).map(async ([chain, addresses]) => {
    const CHUNK = 2000;
    for (let i = 0; i < addresses.length; i += CHUNK) {
      const chunk = addresses.slice(i, i + CHUNK);
      try {
        const batch = await fetchReservesBatch(chain, chunk.map((a) => ({ address: a })));
        for (const address of chunk) {
          const r = batch.get(address.toLowerCase());
          if (r && r.raw0 > 0n && r.raw1 > 0n) {
            updateReservesFromSync(chain, address, r.raw0, r.raw1);
            loaded++;
            stats.reservesLoaded = loaded;
          }
        }
      } catch (e) {}
    }
    console.log(`[プール地図] ${chain}のV2準備量を取得完了`);
  }));
  console.log(`[プール地図] V2準備量の取得完了: ${loaded}プール`);
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

  await discoverV3Pools();
  savePoolMap();
  stats.mapSavedAt = new Date().toISOString();

  // 過去に「使えない」と判明した記録を復元する。これは新たな判定ではなく、
  // これまでの累積を読み込んでいるだけ(起動直後に件数が一気に増える理由)。
  for (const [chain, addresses] of Object.entries(getAllPoolAddressesByChain())) {
    for (const address of addresses) {
      const pool = getPool(chain, address);
      const isTax = pool && pool.kind === KIND_V2 && pool.feeProbed && pool.feeBps > TAX_TOKEN_FEE_BPS;
      if (isKnownIncompatiblePool(chain, address)) {
        disablePool(chain, address, "過去の記録から復元", true);
      } else if (isTax) {
        disablePool(chain, address, `実測手数料${pool.feeBps}bps(税トークン)`);
      }
    }
  }
  console.log(`[無効化] 過去の記録から${stats.disabledFromFile}件を復元しました(今回の判定によるものではありません)`);

  await loadAllReserves();
  await loadV3States();

  for (const key of disabledPools) {
    const [chain, address] = key.split("::");
    clearPoolState(getPool(chain, address));
  }

  const s = getStats();
  console.log(`[プール地図] 準備完了: V2 ${s.byKind.v2}件 / V3 ${s.byKind.v3}件 / 裁定候補${s.arbitragablePairs}ペア(うちV2とV3が共存${s.mixedPairs}件) / 無効化${disabledPools.size}件`);
}

// ===== 借りる通貨 =====
function derivePriceFromPools(chain, token, decimals) {
  const borrowables = getBorrowableTokens(chain);
  let best = null, bestLiquidity = 0n;
  for (const pool of getPoolsForToken(chain, token)) {
    if (pool.kind !== KIND_V2) continue;
    const other = pool.token0 === token.toLowerCase() ? pool.token1 : pool.token0;
    const otherInfo = borrowables[other];
    if (!otherInfo || !otherInfo.stable) continue;
    const isToken0 = pool.token0 === token.toLowerCase();
    const reserveToken = isToken0 ? pool.raw0 : pool.raw1;
    const reserveStable = isToken0 ? pool.raw1 : pool.raw0;
    if (reserveToken <= 0n || reserveStable <= 0n) continue;
    if (reserveStable > bestLiquidity) {
      bestLiquidity = reserveStable;
      const tokenAmount = Number(reserveToken) / Math.pow(10, decimals);
      const stableAmount = Number(reserveStable) / Math.pow(10, otherInfo.decimals);
      if (tokenAmount > 0) best = stableAmount / tokenAmount;
    }
  }
  return best && isFinite(best) && best > 0 ? best : null;
}

function prepareBorrowableTokens() {
  for (const chain of Object.keys(CHAIN_CONFIG)) {
    for (const [address, info] of Object.entries(getBorrowableTokens(chain))) {
      setTokenDecimals(chain, address, info.decimals);
      if (info.stable) setTokenPriceUsd(chain, address, 1);
      else if (info.priceHintUsd) setTokenPriceUsd(chain, address, info.priceHintUsd);
    }
  }
  for (const chain of Object.keys(CHAIN_CONFIG)) {
    for (const [address, info] of Object.entries(getBorrowableTokens(chain))) {
      if (info.stable) continue;
      const price = derivePriceFromPools(chain, address, info.decimals);
      if (price) setTokenPriceUsd(chain, address, price);
    }
  }
  const prices = [];
  for (const chain of Object.keys(CHAIN_CONFIG)) {
    for (const [address, info] of Object.entries(getBorrowableTokens(chain))) {
      if (info.stable) continue;
      const p = getTokenPriceUsd(chain, address);
      if (p) prices.push(`${chain}/${info.symbol}:$${p.toFixed(2)}`);
    }
  }
  console.log(`[価格実測] ${prices.join(" ") || "なし"}`);
}

// ===== V2の手数料の実測 =====
// 裁定候補のプールだけを対象にする。全プールを対象にすると、いつまでも
// 候補に辿り着けず、肝心の判定が45bps仮定のまま進んでしまう。
let feeProbeQueue = [];
let feeProbeFailed = 0;
async function probeFeesGradually() {
  if (!stats.ready) return;
  if (feeProbeQueue.length === 0) {
    const pending = [];
    const seen = new Set();
    for (const entry of getArbitragablePairs()) {
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
      // getAmountOutを持たないV2プールはnullが返る。実行時の学習に委ねる。
    } catch (e) {
      feeProbeFailed++;
    }
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
      stats.executed++;
      reasons.success++;
      cooldownUntil.delete(key);
      record(opp, "success", meta);
    } else {
      reasons.notSent++;
      cooldownUntil.set(key, Date.now() + 30 * 1000);
      record(opp, "not_sent", meta);
    }
  } catch (e) {
    stats.failed++;
    reasons.failed++;
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
  if (!stats.ready) return;
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
  if (!pool) {
    stats.syncUnknown++;
    queueUnknownPool(chain, poolAddress, reserve0, reserve1);
    return false;
  }
  stats.syncMatched++;
  reactToPoolChange(chain, poolAddress, pool, receivedAt, "sync");
  return true;
}

function handleV3Swap(chain, poolAddress, sqrtPriceX96, liquidity, receivedAt) {
  if (disabledPools.has(poolKeyOf(chain, poolAddress))) return false;
  const pool = updateV3FromSwap(chain, poolAddress, sqrtPriceX96, liquidity);
  if (!pool) return false;
  stats.v3Matched++;
  reactToPoolChange(chain, poolAddress, pool, receivedAt, "v3swap");
  return true;
}

// ===== 全件スキャン =====
let fullScanRunning = false;
async function fullScanOnce() {
  if (fullScanRunning || !stats.ready) return;
  fullScanRunning = true;
  try {
    for (const chain of Object.keys(CHAIN_CONFIG)) {
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
  if (refreshRunning || !stats.ready) return;
  refreshRunning = true;
  try {
    for (const chain of Object.keys(CHAIN_CONFIG)) {
      if (isChainWsEnabled(chain) && isChainHealthy(chain)) continue;
      // 裁定候補のプールを優先して読み直す。全件を追うと通常列が埋まり、
      // 手数料実測が進まなくなる。
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
  if (!stats.ready) return;
  const out = {};
  for (const [chain, config] of Object.entries(CHAIN_CONFIG)) {
    const address = process.env[config.contractAddressEnvVar];
    if (!address) continue;
    const tokens = Object.entries(getBorrowableTokens(chain));
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
  const queued = Object.entries(rpc).filter(([, v]) => v.queued > 0).map(([c, v]) => `${c}:${v.priorityQueued}+${v.normalQueued}`).join(" ");
  const stageLine = Object.entries(failStages).map(([k, v]) => `${k}:${v}`).join(" ") || "なし";
  console.log(`[生存] スキャン${stats.scans} 精査${stats.examined} 黒字${stats.profitableFound}(V3含む${stats.v3Opportunities}) 実行${stats.executed}/${stats.failed} 内訳[無効${reasons.disabled} 冷却${reasons.cooldown} 罠${reasons.trap} 下限${reasons.belowMin} 見送${reasons.notSent}] 失敗段階[${stageLine}] 手数料${stats.feeProbed}(残${stats.feeProbePending}) 行列[${queued || "空"}]`);
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
  trap: "罠(ハニーポット)", belowMin: `最低利益$${MIN_PROFIT_USD}未満`, executing: "実行中で重複",
  notSent: "送信条件を満たさず", failed: "送信に失敗", success: "送信成功",
};
const STAGE_LABEL = {
  state: "状態取得に失敗(RPCが遅い)", quote: "受取量の確定に失敗", estimateGas: "ガス見積もりで拒否",
  feeLadder: "手数料を上げても拒否", send: "送信時のエラー", wait: "確定待ちで失敗",
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

  const balanceLine = Object.entries(contractBalances).map(([c, held]) =>
    `${c}: ${held.map((h) => `${h.symbol} ${h.amount.toFixed(4)}($${h.usd.toFixed(2)})`).join(" / ")}`).join('<br>') || '残高なし';

  const syncLine = Object.entries(syncStats).map(([c, v]) =>
    `${c}: V2 ${v.v2.toLocaleString()}件 / V3 ${v.v3.toLocaleString()}件 ${v.healthy ? '<span style="color:#2ecc71">正常</span>' : `<span style="color:#e74c3c">不達→定期読み直しに切替中</span>`}`
  ).join('<br>') || 'WebSocket未設定';

  const queueLine = Object.entries(rpc).map(([c, v]) =>
    `${c}: 優先${v.priorityQueued}/通常${v.normalQueued}${v.dropped > 0 ? ` 破棄${v.dropped}` : ''}`).join('<br>');
  const gasLine = Object.entries(gas).map(([c, g]) => `${c}: $${g.costUsd}`).join(' / ') || '取得中';

  return `<!DOCTYPE html><html lang="ja"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"><meta http-equiv="refresh" content="20">
<title>DEXアービトラージ</title><style>${STYLE}</style></head><body>
<h1>🔍 DEXアービトラージ</h1><div class="sub">V2 + V3 対応 / スキャン${stats.scans}回${stats.ready ? '' : ' / <span style="color:#e8a33d">準備中…</span>'}</div>

<div class="card real"><h2>💰 実際の取引結果</h2>
<div class="stat"><div><div class="v">${real.count}</div><div class="l">実行回数</div></div>
<div><div class="v" style="color:#2ecc71">+$${real.totalProfitUsd.toFixed(4)}</div><div class="l">累積利益</div></div>
<div><div class="v">$${getCurrentTradeCapUsd()}</div><div class="l">取引上限</div></div>
<div><div class="v" style="color:${isLive?'#2ecc71':'#888'}">${isLive?'稼働中':'停止中'}</div><div class="l">自動売買</div></div></div>
<table><thead><tr><th>日時</th><th>経路</th><th style="text-align:right">投入</th><th style="text-align:right">利益</th><th></th></tr></thead><tbody>${realRows}</tbody></table>
<div class="note">コントラクトに溜まっている利益: ${balanceLine}</div></div>

<div class="card"><h2>🔎 機会がどこで止まっているか</h2>
<div class="stat"><div><div class="v">${stats.examined.toLocaleString()}</div><div class="l">精査した経路</div></div>
<div><div class="v" style="color:${stats.profitableFound>0?'#2ecc71':'#888'}">${stats.profitableFound}</div><div class="l">黒字と判定</div></div>
<div><div class="v" style="color:${stats.executed>0?'#2ecc71':'#888'}">${stats.executed}</div><div class="l">送信成功</div></div>
<div><div class="v" style="color:${stats.failed>0?'#e74c3c':'#888'}">${stats.failed}</div><div class="l">送信失敗</div></div></div>
<table><thead><tr><th>止まった理由</th><th style="text-align:right">件数</th></tr></thead><tbody>${reasonRows}</tbody></table>
<div class="note"><strong>送信に失敗した段階</strong></div>
<table><thead><tr><th>段階</th><th style="text-align:right">件数</th></tr></thead><tbody>${stageRows}</tbody></table></div>

<div class="card"><h2>🆕 V3(集中流動性)</h2>
<div class="stat"><div><div class="v" style="color:#6fae62">${s.byKind.v3.toLocaleString()}</div><div class="l">V3プール</div></div>
<div><div class="v">${s.mixedPairs.toLocaleString()}</div><div class="l">V2とV3が共存</div></div>
<div><div class="v">${stats.v3Matched.toLocaleString()}</div><div class="l">V3の価格更新</div></div>
<div><div class="v" style="color:${stats.v3Opportunities>0?'#2ecc71':'#888'}">${stats.v3Opportunities}</div><div class="l">V3を含む機会</div></div></div>
<div class="note">V3は判定を概算で絞り込み、送信直前にUniswap公式のQuoterで正確に確定させます。</div></div>

<div class="card"><h2>🩺 システムの健全性</h2>
<div class="stat"><div><div class="v" style="color:${hbAge != null && hbAge < 120 ? '#2ecc71' : '#e74c3c'}">${hbAge != null ? hbAge + '秒前' : '-'}</div><div class="l">最終生存確認</div></div>
<div><div class="v" style="color:${maxQueue > 1000 ? '#e74c3c' : maxQueue > 200 ? '#e8a33d' : '#2ecc71'}">${maxQueue.toLocaleString()}</div><div class="l">待ち行列(最大)</div></div>
<div><div class="v">${lat != null ? lat + 'ms' : '-'}</div><div class="l">判定時間</div></div>
<div><div class="v">${stats.feeProbed.toLocaleString()}</div><div class="l">手数料実測済み</div></div></div>
<div class="note">${syncLine}<br>${queueLine}<br>実測ガス代(2step): ${gasLine}<br>
手数料の未実測(裁定候補のみ): 残${stats.feeProbePending.toLocaleString()}プール<br>
無効化${stats.disabled}件(うち過去の記録から復元${stats.disabledFromFile}件 / 今回の判定${stats.disabledRuntime}件)<br>
実行に必要な問い合わせは専用の処理装置で、背景作業を待たずに処理されます。</div></div>

<div class="card"><h2>📒 24時間の記録簿</h2>
<div class="stat"><div><div class="v">${sum.count.toLocaleString()}</div><div class="l">記録件数</div></div>
<div><div class="v" style="color:#e8a33d">+$${sum.profitableUsd.toFixed(3)}</div><div class="l">黒字判定の合計</div></div>
<div><div class="v" style="color:#2ecc71">+$${sum.realizedUsd.toFixed(4)}</div><div class="l">実際に得た利益</div></div>
<div><div class="v">${stats.bigMoves.toLocaleString()}</div><div class="l">大口取引の検知</div></div></div>
<table><thead><tr><th>#</th><th>経路</th><th style="text-align:right">壁</th><th style="text-align:right">投入</th><th style="text-align:right">純利益</th></tr></thead><tbody>${oppRows}</tbody></table></div>

<div class="card"><h2>🗺️ プール地図(メモリ上)</h2>
<div class="stat"><div><div class="v">${s.totalPools.toLocaleString()}</div><div class="l">プール合計</div></div>
<div><div class="v">${s.byKind.v2.toLocaleString()}</div><div class="l">V2形式</div></div>
<div><div class="v">${s.byKind.v3.toLocaleString()}</div><div class="l">V3形式</div></div>
<div><div class="v">${s.arbitragablePairs.toLocaleString()}</div><div class="l">裁定候補ペア</div></div></div>
<div class="note">チェーン別: ${Object.entries(s.byChain).map(([c, n]) => `${c}:${n.toLocaleString()}`).join(' / ') || '構築中'}<br>${stats.mapSavedAt ? `最終保存: ${new Date(stats.mapSavedAt).toLocaleString('ja-JP')}` : ''}</div></div>

<div class="footerlink"><a href="/about">→ 仕組みについて</a></div></body></html>`;
}

function renderAbout() {
  return `<!DOCTYPE html><html lang="ja"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"><title>仕組み</title><style>${STYLE}</style></head><body>
<h1>📊 仕組み</h1>
<div class="card"><h2>① V2形式とV3形式</h2><div class="note">V2は準備量が2つだけで価格が決まります。V3は価格帯ごとに流動性が分かれ、手数料区分ごとに別のプールが存在します。両方を同じ経路に混ぜて組めます。</div></div>
<div class="card"><h2>② 待ち行列の分離</h2><div class="note">実行に必要な問い合わせは専用の処理装置で、間隔を空けずに処理します。手数料実測やプール取込といった背景作業は別の装置で間隔を守るため、実行が背景作業に待たされることはありません。</div></div>
<div class="card"><h2>③ 手数料の実測</h2><div class="note">V3は手数料が区分で確定しています。V2は問い合わせる関数が無いため、ガス見積もりの拒否理由から実測します。対象は裁定候補のプールに絞り、判定に直結する分から埋めます。</div></div>
<div class="card"><h2>④ 無効化の内訳</h2><div class="note">起動直後に無効化の件数が一気に増えるのは、過去に「使えない」と判明した記録を復元しているためで、新たな判定ではありません。画面では復元分と今回の判定分を分けて表示しています。</div></div>
<div class="card"><h2>⑤ 送信直前の確定</h2><div class="note">全段の状態を同時に取り直し、V3はUniswap公式のQuoterで受取量を確定させます。ガス見積もりが失敗すればプールに拒否されているので、送信せずに済みガス代を失いません。</div></div>
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
  console.log("=== DEXアービトラージ(V2 + V3) 起動 ===");
  startServer();

  const deployTarget = process.env.RUN_MAINNET_DEPLOY;
  if (deployTarget && deployTarget !== "false") {
    try { await runMainnetDeploy(deployTarget); } catch (e) { console.error("[本番デプロイ] 失敗:", e.message); }
  }

  stats.journalLoaded = loadJournal();
  if (stats.journalLoaded > 0) console.log(`[記録簿] 直近${stats.journalLoaded}件を読み込みました`);

  setInterval(heartbeat, HEARTBEAT_INTERVAL_MS);
  await refreshGasCosts();
  setInterval(refreshGasCosts, 5 * 60 * 1000);

  startOnchainFeeds(handleSync, handleV3Swap);

  await preparePoolMap();
  prepareBorrowableTokens();
  stats.ready = true;

  setInterval(adoptPendingPools, ADOPT_INTERVAL_MS);
  setInterval(probeFeesGradually, FEE_PROBE_INTERVAL_MS);
  setInterval(refreshStaleReserves, REFRESH_STALE_SEC * 1000);
  setInterval(refreshV3States, 20000);
  setInterval(() => { savePoolMap(); stats.mapSavedAt = new Date().toISOString(); }, SAVE_MAP_INTERVAL_MS);
  setInterval(trimJournalIfNeeded, 30 * 60 * 1000);
  setTimeout(refreshContractBalances, 30000);
  setInterval(refreshContractBalances, 10 * 60 * 1000);
  setTimeout(fullScanOnce, 10000);
  setInterval(fullScanOnce, FULL_SCAN_INTERVAL_SEC * 1000);

  console.log(`[起動] 準備完了 / 取引上限$${getCurrentTradeCapUsd()} / 最低利益$${MIN_PROFIT_USD}`);
}

main().catch((e) => { console.error("致命的エラー:", e); process.exit(1); });
