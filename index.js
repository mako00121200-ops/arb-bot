// index.js
//
// [設計] イベント駆動型のDEXアービトラージbot。
//
// 従来はDeFiLlama→DexScreener経由で150ペアを22分周期で見ていたため、
// 専業bot(数千プールを常時監視)に対して構造的に機会を見逃していた。
//
// 新設計:
//   ①起動時: 実在が確認済みのプールからファクトリーを逆算し、全プールを
//            列挙してメモリ上の「プール地図」を構築する
//   ②常時:   Syncイベントで準備量を差分更新し、変化したプールを含む経路
//            だけをメモリ上で即座に再計算する(RPC不要・ミリ秒)
//   ③補助:   Sync購読が無いチェーンは、定期的に一括読み直しする

import http from "http";
import { startOnchainFeeds, updatePoolSubscriptions, getSubscriptionCounts } from "./dex-onchain-realtime.js";
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
// 1回の読み直しで扱うプール数。Multicallで一括なので大きめに取れる。
const REFRESH_BATCH_SIZE = 1200;

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
  lastOpportunity: null, recent: [], syncEvents: 0, latencies: [],
  discoveryDone: false,
};

// ===== 起動時のプール発見 =====
// 種プールは推測せず、既に実在が確認できている「実行可能ペア」から取る。
// 過去、記憶や推測でアドレスを置いて何度も失敗したため。
function collectSeedPools() {
  const seedsByChain = {};
  for (const pair of getVerifiedPairs()) {
    if (!CHAIN_CONFIG[pair.chain]) continue;
    if (!seedsByChain[pair.chain]) seedsByChain[pair.chain] = new Map();
    for (const pool of pair.pools) {
      const dexId = (pool.dexId || "unknown").toLowerCase();
      // 同じDEXからは1つあれば十分(ファクトリーは同一のため)。
      if (!seedsByChain[pair.chain].has(dexId)) {
        seedsByChain[pair.chain].set(dexId, pool.address);
      }
    }
  }
  return seedsByChain;
}

async function discoverAllPools() {
  const seedsByChain = collectSeedPools();
  const totalSeeds = Object.values(seedsByChain).reduce((s, m) => s + m.size, 0);
  if (totalSeeds === 0) {
    console.warn("[プール発見] 種にできる実行可能ペアがありません。過去の記録(/data/verified-pairs.json)が必要です。");
    return;
  }
  console.log(`[プール発見] 種プール${totalSeeds}件からファクトリーを逆算します`);

  for (const [chain, dexMap] of Object.entries(seedsByChain)) {
    const seenFactories = new Set();
    for (const [dexId, address] of dexMap.entries()) {
      try {
        const factory = await discoverFactory(chain, address);
        if (!factory || seenFactories.has(factory.toLowerCase())) continue;
        seenFactories.add(factory.toLowerCase());
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

  const s = getStats();
  console.log(`[プール地図] 構築完了: ${s.totalPools}プール / ${s.totalPairs}ペア / うち複数プールを持つペア${s.arbitragablePairs}件`);
  console.log(`[プール地図] チェーン別: ${Object.entries(s.byChain).map(([c, n]) => `${c}:${n}`).join(" / ") || "なし"}`);
  stats.discoveryDone = true;
}

// ===== 借りる通貨の桁数と価格を用意する =====
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
  // 非安定通貨は、安定通貨と組んだ実際のプールから価格を実測する。
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

// ===== 手数料の実測(バックグラウンドで少しずつ) =====
let feeProbeQueue = [];
let feeProbedCount = 0;
async function probeFeesGradually() {
  if (feeProbeQueue.length === 0) {
    for (const [chain, addresses] of Object.entries(getAllPoolAddressesByChain())) {
      for (const address of addresses) {
        const pool = getPool(chain, address);
        if (pool && !pool.feeProbed) feeProbeQueue.push({ chain, address });
      }
    }
    if (feeProbeQueue.length > 0) console.log(`[手数料実測] ${feeProbeQueue.length}プールを順次確認します`);
  }
  const batch = feeProbeQueue.splice(0, 5);
  for (const { chain, address } of batch) {
    const pool = getPool(chain, address);
    if (!pool) continue;
    pool.feeProbed = true;
    feeProbedCount++;
    try {
      const fee = await probePoolFeeBps({
        chain, pairAddress: address, tokenInAddress: pool.token0,
        reserveIn: pool.raw0, reserveOut: pool.raw1,
      });
      if (fee != null && fee !== 30) setPoolFee(chain, address, fee);
    } catch (e) {}
  }
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
    if (ok) stats.executed++;
    else stats.failed++;
  } catch (e) {
    stats.failed++;
    // 送信がコントラクト側で拒否されたプールは記録し、同じ失敗を繰り返さない。
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
async function handleSync(chain, poolAddress, reserve0, reserve1, receivedAt) {
  stats.syncEvents++;
  const pool = updateReservesFromSync(chain, poolAddress, reserve0, reserve1);
  if (!pool) return;
  try {
    const opp = scanForChangedPool({
      chain, poolAddress, capUsd: getCurrentTradeCapUsd(),
      gasCostUsd: getGasCost(chain), isBorrowable,
    });
    const latency = Date.now() - receivedAt;
    stats.latencies.push(latency);
    if (stats.latencies.length > 200) stats.latencies.shift();
    if (opp) await handleOpportunity(opp);
  } catch (e) {}
}

// ===== 全件スキャン =====
let fullScanRunning = false;
async function fullScanOnce() {
  if (fullScanRunning || !stats.discoveryDone) return;
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
  if (refreshRunning || !stats.discoveryDone) return;
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
  const subs = getSubscriptionCounts();

  const realRows = real.recent.map((e) => `<tr><td>${new Date(e.timestamp).toLocaleString('ja-JP')}</td><td style="font-size:9px">${e.pairLabel}</td>
    <td style="text-align:right">$${e.tradeAmountUsd.toFixed(2)}</td>
    <td style="text-align:right;color:#2ecc71;font-weight:600">${e.actualProfitUsd != null ? `+$${e.actualProfitUsd.toFixed(4)}` : '-'}</td>
    <td><a href="${e.explorerUrl}" target="_blank">確認</a></td></tr>`).join('') || `<tr><td colspan="5" style="color:#888">まだ実際の取引はありません</td></tr>`;

  const oppRows = stats.recent.slice(0, 15).map((o, i) => `<tr><td>${i+1}</td>
    <td style="font-size:9px">${o.kind} ${o.chain}<br>${o.label}</td>
    <td style="text-align:right">${o.feeWallPercent.toFixed(2)}%</td>
    <td style="text-align:right">$${o.tradeAmountUsd.toFixed(0)}</td>
    <td style="text-align:right;color:${o.profitable?'#2ecc71':'#888'};font-weight:600">${o.netProfitUsd>=0?'+':''}$${o.netProfitUsd.toFixed(4)}</td></tr>`).join('') || `<tr><td colspan="5" style="color:#888">まだ機会が見つかっていません</td></tr>`;

  return `<!DOCTYPE html><html lang="ja"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"><meta http-equiv="refresh" content="20">
<title>DEXアービトラージ</title><style>${STYLE}</style></head><body>
<h1>🔍 DEXアービトラージ</h1><div class="sub">イベント駆動型 / Sync受信${stats.syncEvents}回 / 全件スキャン${stats.scans}回${stats.discoveryDone ? '' : ' / <span style="color:#e8a33d">プール地図を構築中…</span>'}</div>

<div class="card real"><h2>💰 実際の取引結果</h2>
<div class="stat"><div><div class="v">${real.count}</div><div class="l">実行回数</div></div>
<div><div class="v" style="color:#2ecc71">+$${real.totalProfitUsd.toFixed(4)}</div><div class="l">累積利益</div></div>
<div><div class="v">$${getCurrentTradeCapUsd()}</div><div class="l">取引上限</div></div>
<div><div class="v" style="color:${isLive?'#2ecc71':'#888'}">${isLive?'稼働中':'停止中'}</div><div class="l">自動売買</div></div></div>
<table><thead><tr><th>日時</th><th>経路</th><th style="text-align:right">投入</th><th style="text-align:right">利益</th><th></th></tr></thead><tbody>${realRows}</tbody></table>
<div class="note">成功実績${getSuccessCount()}回に応じて取引上限が自動的に上がります。</div></div>

<div class="card"><h2>🗺️ プール地図(メモリ上)</h2>
<div class="stat"><div><div class="v">${s.totalPools}</div><div class="l">監視中プール</div></div>
<div><div class="v">${s.arbitragablePairs}</div><div class="l">複数プールのペア</div></div>
<div><div class="v">${s.totalTokens}</div><div class="l">トークン数</div></div>
<div><div class="v">${lat != null ? lat + 'ms' : '-'}</div><div class="l">判定時間(中央値)</div></div></div>
<div class="note">ファクトリーから直接列挙した全プールをメモリ上に保持し、Syncイベントで差分更新しています。判定はRPCを使わずメモリ上で完結します。<br>
プール数: ${Object.entries(s.byChain).map(([c, n]) => `${c}:${n}`).join(' / ') || '構築中'}<br>
Sync購読: ${Object.entries(subs).map(([c, n]) => `${c}:${n}`).join(' / ') || 'なし'}<br>
手数料実測済み: ${feeProbedCount}プール</div></div>

<div class="card"><h2>🎯 検出した機会</h2>
<div class="stat"><div><div class="v" style="color:${stats.opportunitiesFound>0?'#2ecc71':'#888'}">${stats.opportunitiesFound}</div><div class="l">検出数</div></div>
<div><div class="v">${stats.executed}</div><div class="l">実行成功</div></div>
<div><div class="v">${stats.failed}</div><div class="l">実行失敗</div></div>
<div><div class="v">${stats.lastOpportunity ? new Date(stats.lastOpportunity).toLocaleTimeString('ja-JP') : '-'}</div><div class="l">最終検出</div></div></div>
<table><thead><tr><th>#</th><th>経路</th><th style="text-align:right">壁</th><th style="text-align:right">投入</th><th style="text-align:right">純利益</th></tr></thead><tbody>${oppRows}</tbody></table>
<div class="note">「壁」はその経路で黒字になる最低ラインの価格差(往復手数料+Aave0.05%)です。純利益は実測ガス代を差し引いた後の値です。最低$${MIN_PROFIT_USD}を超えたものだけ送信します。</div></div>

<div class="footerlink"><a href="/about">→ 仕組みについて</a></div></body></html>`;
}

function renderAbout() {
  return `<!DOCTYPE html><html lang="ja"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"><title>仕組み</title><style>${STYLE}</style></head><body>
<h1>📊 仕組み</h1>
<div class="card"><h2>① プール地図の構築(起動時)</h2><div class="note">既に実在が確認できているプールに factory() を呼んでファクトリーアドレスを逆算し、そこから全プールを列挙します。推測でアドレスを置かないため間違いが起きません。Uniswap V2形式(allPairs)とSolidly形式(allPools)の両方に対応し、計算式が異なるstableプールは除外します。</div></div>
<div class="card"><h2>② 差分更新(常時)</h2><div class="note">取引が起きるとSyncイベントが届き、そのプールの準備量だけをメモリ上で更新します。RPCへの問い合わせは不要です。購読は400プールずつに分割して送ります。</div></div>
<div class="card"><h2>③ 即時判定</h2><div class="note">変化したプールを含む経路(2ステップ・三角の両方)だけを再計算します。全てメモリ上の計算なのでミリ秒で完了します。</div></div>
<div class="card"><h2>④ 実行</h2><div class="note">送信直前にプール自身へ受取量を問い合わせて確定させ、Aaveのフラッシュローンで実行します。利益が出なければ取引全体が無効化されます(実害はガス代のみ)。拒否されたプールは記録し、同じ失敗を繰り返しません。</div></div>
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

  console.log("[起動] プール地図を構築中(数分かかります)...");
  await discoverAllPools();
  prepareBorrowableTokens();

  startOnchainFeeds(handleSync);
  for (const [chain, addresses] of Object.entries(getAllPoolAddressesByChain())) {
    updatePoolSubscriptions(chain, addresses);
  }

  setInterval(probeFeesGradually, 3000);
  setInterval(refreshStaleReserves, REFRESH_STALE_SEC * 1000);
  setTimeout(fullScanOnce, 10000);
  setInterval(fullScanOnce, FULL_SCAN_INTERVAL_SEC * 1000);

  console.log(`[起動] 準備完了 / 取引上限$${getCurrentTradeCapUsd()} / 最低利益$${MIN_PROFIT_USD}`);
}

main().catch((e) => { console.error("致命的エラー:", e); process.exit(1); });
