// index.js
//
// [設計] イベント駆動型のDEXアービトラージbot。
//
// ①起動時: プール地図をファイルから読み込む(無ければファクトリーから構築)。
//          準備量だけは必ず全件を再取得し、古い値で判定しない。
// ②常時:   チェーン上の全Syncイベントを1つの購読で受け取り、監視対象なら
//          メモリ上で準備量を更新して、その経路だけを即座に再計算する。
// ③補助:   Sync購読が無いチェーンは、定期的に一括読み直しする。

import http from "http";
import { startOnchainFeeds, getSyncStats } from "./dex-onchain-realtime.js";
import { runMainnetDeploy } from "./scripts/mainnet-deploy.js";
import { getRealExecutionStats } from "./scripts/real-execution-log.js";
import { getCurrentTradeCapUsd, getSuccessCount } from "./scripts/trade-cap.js";
import { probePoolFeeBps } from "./scripts/onchain-reserves.js";
import { fetchReservesBatch } from "./scripts/multicall-reserves.js";
import { estimateGasCostUsd } from "./scripts/gas-cost.js";
import { discoverFactory, discoverPoolsFromFactory } from "./scripts/pool-discovery.js";
import {
  registerPool, updateReservesFromSync, setPoolFee, getPool, getStats,
  setTokenDecimals, setTokenPriceUsd, getTokenPriceUsd,
  getAllPoolAddressesByChain, getPoolsForToken, getStalePools,
  getArbitragablePairs, savePoolMap, loadPoolMap,
} from "./scripts/pool-registry.js";
import { scanForChangedPool, scanAllPairs } from "./scripts/opportunity-scanner.js";
import { executeOpportunity } from "./scripts/execute-opportunity.js";
import { isBorrowable, getBorrowableTokens } from "./scripts/borrowable-tokens.js";
import { getVerifiedPairs } from "./scripts/verified-pairs.js";
import { isKnownIncompatiblePool, recordIncompatiblePool } from "./scripts/incompatible-pools.js";
import { CHAIN_CONFIG } from "./chain-config.js";

const MIN_PROFIT_USD = parseFloat(process.env.MIN_PROFIT_USD || "0.05");
const FULL_SCAN_INTERVAL_SEC = parseInt(process.env.FULL_SCAN_INTERVAL_SEC || "30", 10);
const REFRESH_STALE_SEC = parseInt(process.env.REFRESH_STALE_SEC || "60", 10);
// 1回の読み直しで扱うプール数。1,200件では13,783プールの一巡に11分かかり、
// 常に古い価格で判定していたため大幅に引き上げる。
const REFRESH_BATCH_SIZE = parseInt(process.env.REFRESH_BATCH_SIZE || "6000", 10);
// 手数料の実測ペース。読み直しと競合しないよう毎秒5件程度に抑える。
const FEE_PROBE_PER_TICK = parseInt(process.env.FEE_PROBE_PER_TICK || "5", 10);
const FEE_PROBE_INTERVAL_MS = 1000;
// 地図を保存する間隔。手数料の実測結果を取りこぼさないため。
const SAVE_MAP_INTERVAL_MS = 5 * 60 * 1000;
// 保存された地図がこれより古ければ、新しいプールを取り込むため再構築する。
const MAP_REBUILD_AFTER_HOURS = parseInt(process.env.MAP_REBUILD_AFTER_HOURS || "24", 10);

// ===== ガス代 =====
const FALLBACK_GAS = { base: 0.025, arbitrum: 0.03, optimism: 0.01, polygon: 0.033, avalanche: 0.002 };
const gasCostCache = new Map();
function getGasCost(chain) { return gasCostCache.get(chain) ?? FALLBACK_GAS[chain] ?? 0.05; }
async function refreshGasCosts() {
  for (const chain of Object.keys(CHAIN_CONFIG)) {
    try { gasCostCache.set(chain, await estimateGasCostUsd(chain)); } catch (e) {}
  }
  console.log(`[ガス代] ${[...gasCostCache.entries()].map(([c, v]) => `${c}:$${v.toFixed(4)}`).join(" ")}`);
}

// ===== 統計 =====
const stats = {
  scans: 0, opportunitiesFound: 0, executed: 0, failed: 0,
  lastOpportunity: null, recent: [], syncMatched: 0, latencies: [],
  ready: false, refreshCycles: 0, mapSource: "-", mapSavedAt: null,
};

// ===== プール地図の用意 =====
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
  if (totalSeeds === 0) {
    console.warn("[プール地図] 種にできる記録がありません(/data/verified-pairs.json)");
    return;
  }
  console.log(`[プール地図] 種プール${totalSeeds}件からファクトリーを逆算します(約50分かかります)`);

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

/// 全プールの準備量を一括で取得する(起動直後に必ず実行する)。
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
          }
        }
      } catch (e) {}
    }
  }
  console.log(`[プール地図] 準備量を${loaded}プール分取得しました`);
}

async function preparePoolMap() {
  const saved = loadPoolMap();
  let needBuild = saved.count === 0;

  if (saved.count > 0) {
    const ageHours = saved.savedAt ? (Date.now() - new Date(saved.savedAt).getTime()) / 3600000 : 999;
    console.log(`[プール地図] 保存済みの地図を読み込みました: ${saved.count}プール(${ageHours.toFixed(1)}時間前に保存)`);
    stats.mapSource = "保存済み";
    stats.mapSavedAt = saved.savedAt;
    if (ageHours > MAP_REBUILD_AFTER_HOURS) {
      console.log(`[プール地図] ${MAP_REBUILD_AFTER_HOURS}時間以上経過しているため、新しいプールを取り込みます`);
      needBuild = true;
    }
  }

  if (needBuild) {
    stats.mapSource = saved.count > 0 ? "保存済み+再構築" : "新規構築";
    await buildPoolMapFromFactories();
    const n = savePoolMap();
    stats.mapSavedAt = new Date().toISOString();
    console.log(`[プール地図] ${n}プールを保存しました(次回起動は数分で済みます)`);
  }

  await loadAllReserves();

  const s = getStats();
  console.log(`[プール地図] 準備完了: ${s.totalPools}プール / ${s.totalPairs}ペア / うち複数プールを持つペア${s.arbitragablePairs}件`);
  console.log(`[プール地図] チェーン別: ${Object.entries(s.byChain).map(([c, n]) => `${c}:${n}`).join(" / ") || "なし"}`);
  const missing = Object.keys(CHAIN_CONFIG).filter((c) => !s.byChain[c]);
  if (missing.length > 0) console.warn(`[プール地図] プールが0件のチェーン: ${missing.join(", ")}`);
}

// ===== 借りる通貨の桁数と価格 =====
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
// 未実測のプールは30bpsとして扱われるが、Aerodromeは実測99bpsなど大きく
// 異なる。放置すると偽の機会が出るため、裁定に直結するプールから先に埋める。
let feeProbeQueue = [];
async function probeFeesGradually() {
  if (!stats.ready) return;
  if (feeProbeQueue.length === 0) {
    const priority = new Set();
    // 複数プールを持つペア(=2ステップ裁定の候補)を最優先にする。
    for (const entry of getArbitragablePairs()) {
      for (const p of entry.pools) if (!p.feeProbed) priority.add(`${p.chain}::${p.address}`);
    }
    const pending = [...priority].map((k) => {
      const [chain, address] = k.split("::");
      return { chain, address, priority: true };
    });
    if (pending.length === 0) {
      for (const [chain, addresses] of Object.entries(getAllPoolAddressesByChain())) {
        for (const address of addresses) {
          const pool = getPool(chain, address);
          if (pool && !pool.feeProbed) pending.push({ chain, address, priority: false });
        }
      }
    }
    if (pending.length === 0) return;
    feeProbeQueue = pending;
    console.log(`[手数料実測] 未実測${pending.length}プール(${pending[0].priority ? "裁定候補を優先" : "全体"})`);
  }
  const batch = feeProbeQueue.splice(0, FEE_PROBE_PER_TICK);
  await Promise.all(batch.map(async ({ chain, address }) => {
    const pool = getPool(chain, address);
    if (!pool) return;
    pool.feeProbed = true;
    try {
      const fee = await probePoolFeeBps({
        chain, pairAddress: address, tokenInAddress: pool.token0,
        reserveIn: pool.raw0, reserveOut: pool.raw1,
      });
      if (fee != null && fee !== 30) setPoolFee(chain, address, fee);
    } catch (e) {}
  }));
}

// ===== 機会が見つかった時の処理 =====
const executing = new Set();
async function handleOpportunity(opp) {
  stats.opportunitiesFound++;
  stats.lastOpportunity = new Date().toISOString();
  stats.recent = [{ ...opp, at: new Date().toISOString() }, ...stats.recent.filter((r) => r.label !== opp.label)].slice(0, 20);

  if (!opp.profitable || opp.netProfitUsd < MIN_PROFIT_USD) return;

  const key = opp.poolAddresses.join("|").toLowerCase();
  if (executing.has(key)) return;
  executing.add(key);
  try {
    console.log(`[機会] ${opp.kind} ${opp.chain} ${opp.label}: 純利益+$${opp.netProfitUsd.toFixed(4)}(投入$${opp.tradeAmountUsd.toFixed(2)} 壁${opp.feeWallPercent.toFixed(2)}%)`);
    const ok = await executeOpportunity(opp);
    if (ok) stats.executed++; else stats.failed++;
  } catch (e) {
    stats.failed++;
    const msg = e.message || "";
    if (msg.includes("execution reverted") || msg.includes("CALL_EXCEPTION")) {
      for (const addr of opp.poolAddresses) recordIncompatiblePool(opp.chain, addr, msg.slice(0, 80));
    }
    console.warn(`[実行] エラー: ${msg.slice(0, 120)}`);
  } finally {
    executing.delete(key);
  }
}

// ===== Syncイベント受信(最速経路) =====
function handleSync(chain, poolAddress, reserve0, reserve1, receivedAt) {
  const pool = updateReservesFromSync(chain, poolAddress, reserve0, reserve1);
  if (!pool) return false;
  stats.syncMatched++;
  if (!stats.ready) return true;

  try {
    const opp = scanForChangedPool({
      chain, poolAddress, capUsd: getCurrentTradeCapUsd(),
      gasCostUsd: getGasCost(chain), isBorrowable,
    });
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
      const opportunities = scanAllPairs({
        chain, capUsd: getCurrentTradeCapUsd(),
        gasCostUsd: getGasCost(chain), isBorrowable,
      });
      for (const opp of opportunities.slice(0, 3)) await handleOpportunity(opp);
    }
    stats.scans++;
  } catch (e) {
    console.error(`[全件スキャン] エラー: ${e.message.slice(0, 100)}`);
  } finally {
    fullScanRunning = false;
  }
}

// ===== 古くなった準備量の読み直し =====
let refreshRunning = false;
async function refreshStaleReserves() {
  if (refreshRunning || !stats.ready) return;
  refreshRunning = true;
  try {
    for (const chain of Object.keys(CHAIN_CONFIG)) {
      const stale = getStalePools(chain, REFRESH_STALE_SEC * 1000).slice(0, REFRESH_BATCH_SIZE);
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

  const realRows = real.recent.map((e) => `<tr><td>${new Date(e.timestamp).toLocaleString('ja-JP')}</td><td style="font-size:9px">${e.pairLabel}</td>
    <td style="text-align:right">$${e.tradeAmountUsd.toFixed(2)}</td>
    <td style="text-align:right;color:#2ecc71;font-weight:600">${e.actualProfitUsd != null ? `+$${e.actualProfitUsd.toFixed(4)}` : '-'}</td>
    <td><a href="${e.explorerUrl}" target="_blank">確認</a></td></tr>`).join('') || `<tr><td colspan="5" style="color:#888">まだ実際の取引はありません</td></tr>`;

  const oppRows = stats.recent.slice(0, 15).map((o, i) => `<tr><td>${i+1}</td>
    <td style="font-size:9px">${o.kind} ${o.chain}<br>${o.label}</td>
    <td style="text-align:right">${o.feeWallPercent.toFixed(2)}%</td>
    <td style="text-align:right">$${o.tradeAmountUsd.toFixed(0)}</td>
    <td style="text-align:right;color:${o.profitable?'#2ecc71':'#888'};font-weight:600">${o.netProfitUsd>=0?'+':''}$${o.netProfitUsd.toFixed(4)}</td></tr>`).join('') || `<tr><td colspan="5" style="color:#888">まだ機会が見つかっていません</td></tr>`;

  const syncLine = Object.entries(syncStats).map(([c, v]) =>
    `${c}: 受信${v.received.toLocaleString()}件 / うち監視対象${v.matched.toLocaleString()}件${v.connected ? '' : ' <span style="color:#e74c3c">(切断中)</span>'}`
  ).join('<br>') || 'WebSocket未設定';

  return `<!DOCTYPE html><html lang="ja"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"><meta http-equiv="refresh" content="20">
<title>DEXアービトラージ</title><style>${STYLE}</style></head><body>
<h1>🔍 DEXアービトラージ</h1><div class="sub">イベント駆動型 / スキャン${stats.scans}回 / 読み直し${stats.refreshCycles}巡${stats.ready ? '' : ' / <span style="color:#e8a33d">準備中…</span>'}</div>

<div class="card real"><h2>💰 実際の取引結果</h2>
<div class="stat"><div><div class="v">${real.count}</div><div class="l">実行回数</div></div>
<div><div class="v" style="color:#2ecc71">+$${real.totalProfitUsd.toFixed(4)}</div><div class="l">累積利益</div></div>
<div><div class="v">$${getCurrentTradeCapUsd()}</div><div class="l">取引上限</div></div>
<div><div class="v" style="color:${isLive?'#2ecc71':'#888'}">${isLive?'稼働中':'停止中'}</div><div class="l">自動売買</div></div></div>
<table><thead><tr><th>日時</th><th>経路</th><th style="text-align:right">投入</th><th style="text-align:right">利益</th><th></th></tr></thead><tbody>${realRows}</tbody></table>
<div class="note">成功実績${getSuccessCount()}回に応じて取引上限が自動的に上がります。</div></div>

<div class="card"><h2>⚡ リアルタイム監視</h2>
<div class="stat"><div><div class="v" style="color:${stats.syncMatched>0?'#2ecc71':'#888'}">${stats.syncMatched.toLocaleString()}</div><div class="l">監視対象の更新</div></div>
<div><div class="v">${lat != null ? lat + 'ms' : '-'}</div><div class="l">判定時間(中央値)</div></div>
<div><div class="v">${s.feeProbed.toLocaleString()}</div><div class="l">手数料実測済み</div></div>
<div><div class="v">${s.totalPools.toLocaleString()}</div><div class="l">監視中プール</div></div></div>
<div class="note">チェーン上の全Syncイベントを1つの購読で受け取り、監視対象だった時だけメモリ上で更新して即座に再計算します。<br>${syncLine}</div></div>

<div class="card"><h2>🗺️ プール地図(メモリ上)</h2>
<div class="stat"><div><div class="v">${s.totalPools.toLocaleString()}</div><div class="l">プール</div></div>
<div><div class="v">${s.arbitragablePairs.toLocaleString()}</div><div class="l">複数プールのペア</div></div>
<div><div class="v">${s.totalTokens.toLocaleString()}</div><div class="l">トークン</div></div>
<div><div class="v" style="font-size:11px">${stats.mapSource}</div><div class="l">地図の由来</div></div></div>
<div class="note">ファクトリーから列挙した全プールをファイルに保存しており、再起動時は数分で復元されます(準備量は必ず全件を再取得します)。<br>
チェーン別: ${Object.entries(s.byChain).map(([c, n]) => `${c}:${n.toLocaleString()}`).join(' / ') || '構築中'}<br>
${stats.mapSavedAt ? `最終保存: ${new Date(stats.mapSavedAt).toLocaleString('ja-JP')}` : ''}</div></div>

<div class="card"><h2>🎯 検出した機会</h2>
<div class="stat"><div><div class="v" style="color:${stats.opportunitiesFound>0?'#2ecc71':'#888'}">${stats.opportunitiesFound}</div><div class="l">検出数</div></div>
<div><div class="v">${stats.executed}</div><div class="l">実行成功</div></div>
<div><div class="v">${stats.failed}</div><div class="l">実行失敗</div></div>
<div><div class="v">${stats.lastOpportunity ? new Date(stats.lastOpportunity).toLocaleTimeString('ja-JP') : '-'}</div><div class="l">最終検出</div></div></div>
<table><thead><tr><th>#</th><th>経路</th><th style="text-align:right">壁</th><th style="text-align:right">投入</th><th style="text-align:right">純利益</th></tr></thead><tbody>${oppRows}</tbody></table>
<div class="note">「壁」はその経路で黒字になる最低ラインの価格差(往復手数料+Aave0.05%)です。最低$${MIN_PROFIT_USD}を超えたものだけ送信します。</div></div>

<div class="footerlink"><a href="/about">→ 仕組みについて</a></div></body></html>`;
}

function renderAbout() {
  return `<!DOCTYPE html><html lang="ja"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"><title>仕組み</title><style>${STYLE}</style></head><body>
<h1>📊 仕組み</h1>
<div class="card"><h2>① プール地図</h2><div class="note">実在が確認できているプールに factory() を呼んでファクトリーを逆算し、そこから全プールを列挙します。推測でアドレスを置かないため間違いが起きません。構築した地図はファイルに保存し、再起動時は数分で復元します。準備量だけは毎回全件を取得し直すため、古い値で判定することはありません。</div></div>
<div class="card"><h2>② 全Syncイベントの購読</h2><div class="note">アドレスを指定して購読すると、数千件ではRPC側の制限に当たり1件も届きませんでした。チェーン上の全Syncを1つの購読で受け取り、監視対象かどうかは手元で判定します。</div></div>
<div class="card"><h2>③ 即時判定</h2><div class="note">変化したプールを含む経路(2ステップ・三角の両方)だけを再計算します。全てメモリ上の計算なのでミリ秒で完了します。</div></div>
<div class="card"><h2>④ 実行</h2><div class="note">送信直前にプール自身へ受取量を問い合わせて確定させ、Aaveのフラッシュローンで実行します。利益が出なければ取引全体が無効化されます(実害はガス代のみ)。</div></div>
<div class="card"><h2>⑤ 無料枠の役割分担</h2><div class="note">読み取り用とイベント監視用のRPCを環境変数で別々に指定できます。無料枠のノードを複数用意して役割を分けることで、1ノードあたりの制限を回避しつつ速度を保てます。</div></div>
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

  await refreshGasCosts();
  setInterval(refreshGasCosts, 5 * 60 * 1000);

  // Syncの購読は地図の準備より先に始める。準備中に届いた更新も
  // メモリ上には反映されるため、取りこぼしが減る。
  startOnchainFeeds(handleSync);

  await preparePoolMap();
  prepareBorrowableTokens();
  stats.ready = true;

  setInterval(probeFeesGradually, FEE_PROBE_INTERVAL_MS);
  setInterval(refreshStaleReserves, REFRESH_STALE_SEC * 1000);
  setInterval(() => { savePoolMap(); stats.mapSavedAt = new Date().toISOString(); }, SAVE_MAP_INTERVAL_MS);
  setTimeout(fullScanOnce, 10000);
  setInterval(fullScanOnce, FULL_SCAN_INTERVAL_SEC * 1000);

  console.log(`[起動] 準備完了 / 取引上限$${getCurrentTradeCapUsd()} / 最低利益$${MIN_PROFIT_USD}`);
}

main().catch((e) => { console.error("致命的エラー:", e); process.exit(1); });
