// index.js
//
// [設計] イベント駆動型のDEXアービトラージbot。
//
// ①起動時: プール地図をファイルから読み込む(無ければファクトリーから構築)。
//          準備量だけは必ず全件を再取得し、古い値で判定しない。
// ②常時:   チェーン上の全Syncイベントを1つの購読で受け取り、監視対象なら
//          メモリ上で準備量を更新して、その経路だけを即座に再計算する。
// ③発見:   Syncが届いた未知のプールは「実際に取引が起きている証拠」なので、
//          自動的に地図へ取り込む。
// ④抑制:   送信に失敗した組み合わせは10分間再試行しない。3回失敗した
//          プールは無効化する(以前は同じ失敗を1.5秒ごとに無限に繰り返した)。

import http from "http";
import { startOnchainFeeds, getSyncStats, isChainWsEnabled } from "./dex-onchain-realtime.js";
import { runMainnetDeploy } from "./scripts/mainnet-deploy.js";
import { getRealExecutionStats } from "./scripts/real-execution-log.js";
import { getCurrentTradeCapUsd, getSuccessCount } from "./scripts/trade-cap.js";
import { probePoolFeeBps, getRpcStatus } from "./scripts/onchain-reserves.js";
import { fetchReservesBatch, fetchPoolTokensBatch } from "./scripts/multicall-reserves.js";
import { estimateGasCostUsd } from "./scripts/gas-cost.js";
import { discoverFactory, discoverPoolsFromFactory } from "./scripts/pool-discovery.js";
import {
  registerPool, updateReservesFromSync, setPoolFee, getPool, getStats,
  setTokenDecimals, setTokenPriceUsd, getTokenPriceUsd,
  getAllPoolAddressesByChain, getPoolsForToken, getStalePools,
  getArbitragablePairs, savePoolMap, loadPoolMap,
} from "./scripts/pool-registry.js";
import { scanForChangedPool, scanAllPairs } from "./scripts/opportunity-scanner.js";
import { executeOpportunity, ExecutionError } from "./scripts/execute-opportunity.js";
import { isBorrowable, getBorrowableTokens } from "./scripts/borrowable-tokens.js";
import { getVerifiedPairs } from "./scripts/verified-pairs.js";
import { isKnownIncompatiblePool, recordIncompatiblePool } from "./scripts/incompatible-pools.js";
import { CHAIN_CONFIG } from "./chain-config.js";

const MIN_PROFIT_USD = parseFloat(process.env.MIN_PROFIT_USD || "0.05");
const FULL_SCAN_INTERVAL_SEC = parseInt(process.env.FULL_SCAN_INTERVAL_SEC || "30", 10);
const REFRESH_STALE_SEC = parseInt(process.env.REFRESH_STALE_SEC || "60", 10);
const REFRESH_BATCH_SIZE = parseInt(process.env.REFRESH_BATCH_SIZE || "4000", 10);
const FEE_PROBE_PER_TICK = parseInt(process.env.FEE_PROBE_PER_TICK || "5", 10);
const FEE_PROBE_INTERVAL_MS = 1000;
const SAVE_MAP_INTERVAL_MS = 5 * 60 * 1000;
const MAP_REBUILD_AFTER_HOURS = parseInt(process.env.MAP_REBUILD_AFTER_HOURS || "168", 10);
const HEARTBEAT_INTERVAL_MS = 60 * 1000;
const EXECUTION_TIMEOUT_MS = 60 * 1000;
const ADOPT_INTERVAL_MS = 5000;
const ADOPT_PER_TICK = 60;
// 送信失敗後、同じ組み合わせを再試行しない時間。
const FAILURE_COOLDOWN_MS = 10 * 60 * 1000;
// この回数失敗したプールは無効化する。
const DISABLE_AFTER_FAILURES = 3;

// ===== ガス代 =====
const FALLBACK_GAS = { base: 0.025, arbitrum: 0.03, optimism: 0.01, polygon: 0.033, avalanche: 0.002 };
const gasCostCache = new Map();
function getGasCost(chain) { return gasCostCache.get(chain) ?? FALLBACK_GAS[chain] ?? 0.05; }
async function refreshGasCosts() {
  for (const chain of Object.keys(CHAIN_CONFIG)) {
    try { gasCostCache.set(chain, await estimateGasCostUsd(chain)); } catch (e) {}
  }
}

// ===== 統計 =====
const stats = {
  scans: 0, opportunitiesFound: 0, executed: 0, failed: 0, skippedCooldown: 0,
  lastOpportunity: null, recent: [], syncMatched: 0, syncUnknown: 0, adopted: 0, disabled: 0,
  latencies: [], ready: false, refreshCycles: 0, mapSource: "-", mapSavedAt: null,
  feeProbed: 0, lastHeartbeat: null, reservesLoaded: 0,
};

// ===== 失敗の抑制と無効化 =====
const cooldownUntil = new Map();   // 組み合わせキー → 再試行してよい時刻
const poolFailures = new Map();    // "chain::address" → 失敗回数
const disabledPools = new Set();   // 無効化したプール

function poolKeyOf(chain, address) { return `${chain}::${address.toLowerCase()}`; }

function disablePool(chain, address, reason) {
  const key = poolKeyOf(chain, address);
  if (disabledPools.has(key)) return;
  disabledPools.add(key);
  stats.disabled++;
  // 準備量を0にして判定対象から外す(Syncによる更新も止める)。
  const pool = getPool(chain, address);
  if (pool) { pool.raw0 = 0n; pool.raw1 = 0n; }
  recordIncompatiblePool(chain, address, reason);
  console.log(`[無効化] ${chain} ${address.slice(0, 10)}…: ${reason.slice(0, 60)}`);
}

function noteExecutionFailure(opp, reason) {
  cooldownUntil.set(opp.poolAddresses.join("|").toLowerCase(), Date.now() + FAILURE_COOLDOWN_MS);
  for (const address of opp.poolAddresses) {
    const key = poolKeyOf(opp.chain, address);
    const n = (poolFailures.get(key) || 0) + 1;
    poolFailures.set(key, n);
    if (n >= DISABLE_AFTER_FAILURES) disablePool(opp.chain, address, `送信失敗${n}回: ${reason}`);
  }
}

function hasDisabledPool(opp) {
  return opp.poolAddresses.some((a) => disabledPools.has(poolKeyOf(opp.chain, a)));
}

// ===== Syncで見つかった未知のプールを取り込む =====
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
        registerPool({ chain, address: item.address, dexId: "sync発見", token0: t.token0, token1: t.token1, raw0: item.raw0, raw1: item.raw1 });
        stats.adopted++;
      }
    } catch (e) {
      for (const item of items) pendingAdoption.set(item.key, item);
    }
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
  console.log(`[プール地図] 種プール${totalSeeds}件からファクトリーを逆算します(約50分)`);
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
          registerPool(p);
        }
      } catch (e) {
        console.warn(`[プール発見] ${dexId} on ${chain}: 失敗 ${e.message.slice(0, 70)}`);
      }
    }
  }
}

async function loadAllReserves() {
  let loaded = 0;
  for (const [chain, addresses] of Object.entries(getAllPoolAddressesByChain())) {
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
    console.log(`[プール地図] ${chain}の準備量を取得(累計${loaded}プール)`);
  }
  console.log(`[プール地図] 準備量の取得完了: ${loaded}プール`);
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
    savePoolMap();
    stats.mapSavedAt = new Date().toISOString();
  }
  // 過去に非対応と判明したプールは、読み込んだ地図からも外す。
  for (const [chain, addresses] of Object.entries(getAllPoolAddressesByChain())) {
    for (const address of addresses) {
      if (isKnownIncompatiblePool(chain, address)) {
        disabledPools.add(poolKeyOf(chain, address));
        const pool = getPool(chain, address);
        if (pool) { pool.raw0 = 0n; pool.raw1 = 0n; }
      }
    }
  }
  await loadAllReserves();
  for (const key of disabledPools) {
    const [chain, address] = key.split("::");
    const pool = getPool(chain, address);
    if (pool) { pool.raw0 = 0n; pool.raw1 = 0n; }
  }
  const s = getStats();
  console.log(`[プール地図] 準備完了: ${s.totalPools}プール / 裁定候補${s.arbitragablePairs}ペア / 無効化${disabledPools.size}件`);
  console.log(`[プール地図] チェーン別: ${Object.entries(s.byChain).map(([c, n]) => `${c}:${n}`).join(" / ") || "なし"}`);
}

// ===== 借りる通貨 =====
function derivePriceFromPools(chain, token, decimals) {
  const borrowables = getBorrowableTokens(chain);
  let best = null, bestLiquidity = 0n;
  for (const pool of getPoolsForToken(chain, token)) {
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

// ===== 手数料の実測 =====
let feeProbeQueue = [];
async function probeFeesGradually() {
  if (!stats.ready) return;
  if (feeProbeQueue.length === 0) {
    const priority = new Set();
    for (const entry of getArbitragablePairs()) {
      for (const p of entry.pools) if (!p.feeProbed && !disabledPools.has(poolKeyOf(p.chain, p.address))) priority.add(`${p.chain}::${p.address}`);
    }
    const pending = [...priority].map((k) => { const [chain, address] = k.split("::"); return { chain, address }; });
    if (pending.length === 0) return;
    feeProbeQueue = pending;
    console.log(`[手数料実測] 裁定候補のうち未実測${pending.length}プール`);
  }
  const batch = feeProbeQueue.splice(0, FEE_PROBE_PER_TICK);
  await Promise.all(batch.map(async ({ chain, address }) => {
    const pool = getPool(chain, address);
    if (!pool) return;
    try {
      const fee = await probePoolFeeBps({ chain, pairAddress: address, tokenInAddress: pool.token0, reserveIn: pool.raw0, reserveOut: pool.raw1 });
      if (fee != null && fee !== 30) setPoolFee(chain, address, fee);
      pool.feeProbed = true;
      stats.feeProbed++;
    } catch (e) {}
  }));
}

// ===== 機会が見つかった時の処理 =====
const executing = new Set();
async function handleOpportunity(opp) {
  if (hasDisabledPool(opp)) return;

  const key = opp.poolAddresses.join("|").toLowerCase();
  const until = cooldownUntil.get(key);
  if (until && Date.now() < until) { stats.skippedCooldown++; return; }

  stats.opportunitiesFound++;
  stats.lastOpportunity = new Date().toISOString();
  stats.recent = [{ ...opp, at: new Date().toISOString() }, ...stats.recent.filter((r) => r.label !== opp.label)].slice(0, 20);

  if (!opp.profitable || opp.netProfitUsd < MIN_PROFIT_USD) return;
  if (executing.has(key)) return;
  executing.add(key);
  try {
    console.log(`[機会] ${opp.kind} ${opp.chain} ${opp.label}: 純利益+$${opp.netProfitUsd.toFixed(4)}(投入$${opp.tradeAmountUsd.toFixed(2)} 壁${opp.feeWallPercent.toFixed(2)}%)`);
    const ok = await Promise.race([
      executeOpportunity(opp),
      new Promise((_, reject) => setTimeout(() => reject(new ExecutionError("実行が制限時間を超えました")), EXECUTION_TIMEOUT_MS)),
    ]);
    if (ok) {
      stats.executed++;
      cooldownUntil.delete(key);
    } else {
      // 条件を満たさず見送っただけ。短い冷却で連打を避ける。
      cooldownUntil.set(key, Date.now() + 30 * 1000);
    }
  } catch (e) {
    stats.failed++;
    const msg = e.message || "";
    console.warn(`[実行] 失敗: ${msg.slice(0, 120)}`);
    noteExecutionFailure(opp, msg);
  } finally {
    executing.delete(key);
  }
}

// ===== Syncイベント受信 =====
function handleSync(chain, poolAddress, reserve0, reserve1, receivedAt) {
  if (disabledPools.has(poolKeyOf(chain, poolAddress))) return false;
  const pool = updateReservesFromSync(chain, poolAddress, reserve0, reserve1);
  if (!pool) {
    stats.syncUnknown++;
    queueUnknownPool(chain, poolAddress, reserve0, reserve1);
    return false;
  }
  stats.syncMatched++;
  if (!stats.ready) return true;
  try {
    const opp = scanForChangedPool({ chain, poolAddress, capUsd: getCurrentTradeCapUsd(), gasCostUsd: getGasCost(chain), isBorrowable });
    const latency = Date.now() - receivedAt;
    stats.latencies.push(latency);
    if (stats.latencies.length > 200) stats.latencies.shift();
    if (opp) handleOpportunity(opp).catch(() => {});
  } catch (e) {}
  return true;
}

// ===== 全件スキャン =====
let fullScanRunning = false;
async function fullScanOnce() {
  if (fullScanRunning || !stats.ready) return;
  fullScanRunning = true;
  try {
    for (const chain of Object.keys(CHAIN_CONFIG)) {
      const opportunities = scanAllPairs({ chain, capUsd: getCurrentTradeCapUsd(), gasCostUsd: getGasCost(chain), isBorrowable });
      for (const opp of opportunities.slice(0, 3)) await handleOpportunity(opp);
    }
    stats.scans++;
  } catch (e) {
    console.error(`[全件スキャン] エラー: ${e.message.slice(0, 100)}`);
  } finally {
    fullScanRunning = false;
  }
}

// ===== 準備量の読み直し(Syncが届かないチェーンのみ) =====
let refreshRunning = false;
async function refreshStaleReserves() {
  if (refreshRunning || !stats.ready) return;
  refreshRunning = true;
  try {
    for (const chain of Object.keys(CHAIN_CONFIG)) {
      if (isChainWsEnabled(chain)) continue;
      const stale = getStalePools(chain, REFRESH_STALE_SEC * 1000)
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

// ===== 生存確認 =====
function heartbeat() {
  stats.lastHeartbeat = new Date().toISOString();
  const rpc = getRpcStatus();
  const queued = Object.entries(rpc).filter(([, v]) => v.queued > 0).map(([c, v]) => `${c}:${v.queued}`).join(" ");
  console.log(`[生存] スキャン${stats.scans} 読直${stats.refreshCycles} 検出${stats.opportunitiesFound} 実行${stats.executed}/${stats.failed} 冷却${stats.skippedCooldown} 無効${stats.disabled} Sync一致${stats.syncMatched}/未知${stats.syncUnknown} 取込${stats.adopted} 手数料${stats.feeProbed} 行列[${queued || "空"}]`);
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

function renderPage() {
  const s = getStats();
  const real = getRealExecutionStats();
  const isLive = process.env.DRY_RUN === "false";
  const lat = stats.latencies.length ? [...stats.latencies].sort((a, b) => a - b)[Math.floor(stats.latencies.length / 2)] : null;
  const syncStats = getSyncStats();
  const rpc = getRpcStatus();
  const hbAge = stats.lastHeartbeat ? Math.round((Date.now() - new Date(stats.lastHeartbeat).getTime()) / 1000) : null;
  const total = stats.syncMatched + stats.syncUnknown;
  const matchRate = total > 0 ? (stats.syncMatched / total * 100).toFixed(1) : "0.0";

  const realRows = real.recent.map((e) => `<tr><td>${new Date(e.timestamp).toLocaleString('ja-JP')}</td><td style="font-size:9px">${e.pairLabel}</td>
    <td style="text-align:right">$${e.tradeAmountUsd.toFixed(2)}</td>
    <td style="text-align:right;color:#2ecc71;font-weight:600">${e.actualProfitUsd != null ? `+$${e.actualProfitUsd.toFixed(4)}` : '-'}</td>
    <td><a href="${e.explorerUrl}" target="_blank">確認</a></td></tr>`).join('') || `<tr><td colspan="5" style="color:#888">まだ実際の取引はありません</td></tr>`;

  const oppRows = stats.recent.slice(0, 15).map((o, i) => `<tr><td>${i+1}</td>
    <td style="font-size:9px">${o.kind} ${o.chain}<br>${o.label}</td>
    <td style="text-align:right">${o.feeWallPercent.toFixed(2)}%</td>
    <td style="text-align:right">$${o.tradeAmountUsd.toFixed(0)}</td>
    <td style="text-align:right;color:${o.profitable?'#2ecc71':'#888'};font-weight:600">${o.netProfitUsd>=0?'+':''}$${o.netProfitUsd.toFixed(4)}</td></tr>`).join('') || `<tr><td colspan="5" style="color:#888">まだ機会が見つかっていません</td></tr>`;

  const syncLine = Object.entries(syncStats).map(([c, v]) => `${c}: 受信${v.received.toLocaleString()}件${v.connected ? '' : ' <span style="color:#e74c3c">(切断中)</span>'}`).join('<br>') || 'WebSocket未設定';

  return `<!DOCTYPE html><html lang="ja"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"><meta http-equiv="refresh" content="20">
<title>DEXアービトラージ</title><style>${STYLE}</style></head><body>
<h1>🔍 DEXアービトラージ</h1><div class="sub">イベント駆動型 / スキャン${stats.scans}回${stats.ready ? '' : ' / <span style="color:#e8a33d">準備中…</span>'}</div>

<div class="card real"><h2>💰 実際の取引結果</h2>
<div class="stat"><div><div class="v">${real.count}</div><div class="l">実行回数</div></div>
<div><div class="v" style="color:#2ecc71">+$${real.totalProfitUsd.toFixed(4)}</div><div class="l">累積利益</div></div>
<div><div class="v">$${getCurrentTradeCapUsd()}</div><div class="l">取引上限</div></div>
<div><div class="v" style="color:${isLive?'#2ecc71':'#888'}">${isLive?'稼働中':'停止中'}</div><div class="l">自動売買</div></div></div>
<table><thead><tr><th>日時</th><th>経路</th><th style="text-align:right">投入</th><th style="text-align:right">利益</th><th></th></tr></thead><tbody>${realRows}</tbody></table>
<div class="note">成功実績${getSuccessCount()}回に応じて取引上限が自動的に上がります。</div></div>

<div class="card"><h2>🎯 検出した機会</h2>
<div class="stat"><div><div class="v" style="color:${stats.opportunitiesFound>0?'#2ecc71':'#888'}">${stats.opportunitiesFound}</div><div class="l">検出数</div></div>
<div><div class="v">${stats.executed}</div><div class="l">実行成功</div></div>
<div><div class="v" style="color:${stats.failed>0?'#e74c3c':'#888'}">${stats.failed}</div><div class="l">実行失敗</div></div>
<div><div class="v">${stats.disabled}</div><div class="l">無効化プール</div></div></div>
<table><thead><tr><th>#</th><th>経路</th><th style="text-align:right">壁</th><th style="text-align:right">投入</th><th style="text-align:right">純利益</th></tr></thead><tbody>${oppRows}</tbody></table>
<div class="note">送信に失敗した組み合わせは10分間再試行せず、3回失敗したプールは無効化します。「壁」は黒字になる最低ラインの価格差です。最低$${MIN_PROFIT_USD}を超えたものだけ送信します。</div></div>

<div class="card"><h2>🔭 活発なプールの自動発見</h2>
<div class="stat"><div><div class="v" style="color:#2ecc71">${stats.adopted.toLocaleString()}</div><div class="l">新たに取り込んだ</div></div>
<div><div class="v">${matchRate}%</div><div class="l">取引の捕捉率</div></div>
<div><div class="v">${stats.syncUnknown.toLocaleString()}</div><div class="l">未知プールの取引</div></div>
<div><div class="v">${pendingAdoption.size.toLocaleString()}</div><div class="l">取り込み待ち</div></div></div>
<div class="note">Syncイベントが届いた未知のプールは、取引が起きている証拠なので自動的に取り込みます(stable型は除外)。捕捉率は当初3.8%でした。</div></div>

<div class="card"><h2>🩺 システムの生存確認</h2>
<div class="stat"><div><div class="v" style="color:${hbAge != null && hbAge < 120 ? '#2ecc71' : '#e74c3c'}">${hbAge != null ? hbAge + '秒前' : '-'}</div><div class="l">最終生存確認</div></div>
<div><div class="v">${stats.syncMatched.toLocaleString()}</div><div class="l">監視対象の更新</div></div>
<div><div class="v">${lat != null ? lat + 'ms' : '-'}</div><div class="l">判定時間</div></div>
<div><div class="v">${stats.feeProbed.toLocaleString()}</div><div class="l">手数料実測済み</div></div></div>
<div class="note">${syncLine}<br>待ち行列: ${Object.entries(rpc).map(([c, v]) => `${c}:${v.queued}`).join(' / ')}</div></div>

<div class="card"><h2>🗺️ プール地図(メモリ上)</h2>
<div class="stat"><div><div class="v">${s.totalPools.toLocaleString()}</div><div class="l">プール</div></div>
<div><div class="v">${s.arbitragablePairs.toLocaleString()}</div><div class="l">裁定候補ペア</div></div>
<div><div class="v">${s.totalTokens.toLocaleString()}</div><div class="l">トークン</div></div>
<div><div class="v" style="font-size:11px">${stats.mapSource}</div><div class="l">地図の由来</div></div></div>
<div class="note">チェーン別: ${Object.entries(s.byChain).map(([c, n]) => `${c}:${n.toLocaleString()}`).join(' / ') || '構築中'}<br>${stats.mapSavedAt ? `最終保存: ${new Date(stats.mapSavedAt).toLocaleString('ja-JP')}` : ''}</div></div>

<div class="footerlink"><a href="/about">→ 仕組みについて</a></div></body></html>`;
}

function renderAbout() {
  return `<!DOCTYPE html><html lang="ja"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"><title>仕組み</title><style>${STYLE}</style></head><body>
<h1>📊 仕組み</h1>
<div class="card"><h2>① プール地図</h2><div class="note">実在が確認できているプールからファクトリーを逆算し、全プールを列挙します。地図はファイルに保存し、再起動時は数秒で復元します。準備量は毎回全件を取得し直します。</div></div>
<div class="card"><h2>② 活発なプールの自動発見</h2><div class="note">Syncイベントが届いた未知のプールは、取引が起きている証拠なので自動的に取り込みます。stable型(計算式が異なる)は除外します。</div></div>
<div class="card"><h2>③ 即時判定</h2><div class="note">変化したプールを含む経路だけをメモリ上で再計算します。RPCを使わないためミリ秒で完了します。</div></div>
<div class="card"><h2>④ 失敗の抑制</h2><div class="note">送信に失敗した組み合わせは10分間再試行しません。3回失敗したプールは無効化し、記録して次回起動時も除外します。以前は同じ失敗を1.5秒ごとに無限に繰り返していました。</div></div>
<div class="card"><h2>⑤ 実行</h2><div class="note">送信直前にプール自身へ受取量を問い合わせて確定させ、Aaveのフラッシュローンで実行します。利益が出なければ取引全体が無効化されます(実害はガス代のみ)。</div></div>
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
  console.log("=== DEXアービトラージ(イベント駆動型) 起動 ===");
  startServer();

  const deployTarget = process.env.RUN_MAINNET_DEPLOY;
  if (deployTarget && deployTarget !== "false") {
    try { await runMainnetDeploy(deployTarget); } catch (e) { console.error("[本番デプロイ] 失敗:", e.message); }
  }

  setInterval(heartbeat, HEARTBEAT_INTERVAL_MS);
  await refreshGasCosts();
  setInterval(refreshGasCosts, 5 * 60 * 1000);

  startOnchainFeeds(handleSync);

  await preparePoolMap();
  prepareBorrowableTokens();
  stats.ready = true;

  setInterval(adoptPendingPools, ADOPT_INTERVAL_MS);
  setInterval(probeFeesGradually, FEE_PROBE_INTERVAL_MS);
  setInterval(refreshStaleReserves, REFRESH_STALE_SEC * 1000);
  setInterval(() => { savePoolMap(); stats.mapSavedAt = new Date().toISOString(); }, SAVE_MAP_INTERVAL_MS);
  setTimeout(fullScanOnce, 10000);
  setInterval(fullScanOnce, FULL_SCAN_INTERVAL_SEC * 1000);

  console.log(`[起動] 準備完了 / 取引上限$${getCurrentTradeCapUsd()} / 最低利益$${MIN_PROFIT_USD}`);
}

main().catch((e) => { console.error("致命的エラー:", e); process.exit(1); });
