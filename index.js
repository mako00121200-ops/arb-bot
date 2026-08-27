import http from "http";
import fs from "fs";
import { ethers } from "ethers";
import { runProspect } from "./prospector.js";
import { measureSpread, findOptimalSize, checkTokenSafety, CHAIN_CONFIG, getProvider } from "./measure.js";

/**
 * 裁定機会の観測所(実測機能つき)
 * ------------------------------------------------------------
 * 1. DeFiLlamaで全チェーン・全DEXを精査 → 競争の薄い候補を抽出
 * 2. 上位候補について、実際にオンチェーンから価格を取得して
 *    「本当にいくら儲かるか」を測定
 * 3. 安全性チェック、最適サイズ推定、時間帯分析を記録
 *
 * 取引は一切行わない(観測のみ)。
 */

const PROSPECT_INTERVAL_MIN = parseInt(process.env.PROSPECT_INTERVAL_MIN || "60", 10);
const MIN_TVL_USD = parseFloat(process.env.MIN_TVL_USD || "10000");
const MEASURE_TOP_N = parseInt(process.env.MEASURE_TOP_N || "30", 10);
const HISTORY_FILE = process.env.HISTORY_FILE || "/tmp/prospect-history.json";
const MAX_HISTORY = 200;

const V2_PROJECTS = new Set(["uniswap-v2", "sushiswap"]);
const V3_PROJECTS = new Set(["uniswap-v3", "sushiswap-v3"]);

function ethers_getAddress(addr) {
  try { return ethers.getAddress(addr); } catch (e) { return addr; }
}

function loadHistory() {
  try {
    if (fs.existsSync(HISTORY_FILE)) return JSON.parse(fs.readFileSync(HISTORY_FILE, "utf8"));
  } catch (e) { console.warn("履歴読み込み失敗:", e.message); }
  return { snapshots: [], pairTracking: {}, measurements: {}, hourlyStats: {} };
}
function saveHistory(h) {
  try {
    if (h.snapshots.length > MAX_HISTORY) h.snapshots = h.snapshots.slice(-MAX_HISTORY);
    fs.writeFileSync(HISTORY_FILE, JSON.stringify(h));
  } catch (e) { console.warn("履歴保存失敗:", e.message); }
}
const history = loadHistory();
if (!history.measurements) history.measurements = {};
if (!history.hourlyStats) history.hourlyStats = {};

let latest = null;
let latestMeasurements = [];
let lastError = null;
let runCount = 0;

function updatePairTracking(result) {
  for (const p of result.quietPairs) {
    const key = `${p.chain}||${p.symbol}`;
    if (!history.pairTracking[key]) {
      history.pairTracking[key] = {
        chain: p.chain, symbol: p.symbol, venues: p.venues,
        appearances: 0, firstSeen: result.scannedAt, minTurnover: p.turnover, maxTvl: p.minTvl,
      };
    }
    const t = history.pairTracking[key];
    t.appearances++;
    t.lastSeen = result.scannedAt;
    t.venues = p.venues;
    if (p.turnover < t.minTurnover) t.minTurnover = p.turnover;
    if (p.minTvl > t.maxTvl) t.maxTvl = p.minTvl;
  }
  const keys = Object.keys(history.pairTracking);
  if (keys.length > 500) {
    const sorted = keys.sort((a, b) => history.pairTracking[b].appearances - history.pairTracking[a].appearances);
    const keep = new Set(sorted.slice(0, 400));
    for (const k of keys) if (!keep.has(k)) delete history.pairTracking[k];
  }
}

function selectMeasurable(arbitragable) {
  const targets = [];
  for (const a of arbitragable) {
    if (!CHAIN_CONFIG[a.chain]) continue;
    const projects = a.venues.map((v) => v.project);
    const hasV2 = projects.some((p) => V2_PROJECTS.has(p));
    const hasV3 = projects.some((p) => V3_PROJECTS.has(p));
    if (hasV2 && hasV3) targets.push(a);
  }
  targets.sort((a, b) => {
    const qa = a.turnover, qb = b.turnover;
    if (qa !== qb) return qa - qb;
    return b.minTvl - a.minTvl;
  });
  return targets.slice(0, MEASURE_TOP_N);
}

function recordMeasurement(key, m, safety, optimal) {
  if (!history.measurements[key]) {
    history.measurements[key] = {
      chain: m.chain, symbol: key.split("||")[1],
      samples: 0, positiveCount: 0,
      maxNetPct: m.netPctBeforeGas, sumNetPct: 0,
      bestNetUSD: null, lastSafety: null,
      consecutivePositive: 0, maxConsecutivePositive: 0,
      recent: [],
    };
  }
  const r = history.measurements[key];
  r.samples++;
  r.sumNetPct += m.netPctBeforeGas;
  if (m.netPctBeforeGas > r.maxNetPct) r.maxNetPct = m.netPctBeforeGas;

  const isPositive = m.netPctBeforeGas > 0;
  if (isPositive) {
    r.positiveCount++;
    r.consecutivePositive++;
    if (r.consecutivePositive > r.maxConsecutivePositive) r.maxConsecutivePositive = r.consecutivePositive;
  } else {
    r.consecutivePositive = 0;
  }

  if (safety) r.lastSafety = safety;
  if (optimal && (!r.bestNetUSD || optimal.netUSD > r.bestNetUSD.netUSD)) {
    r.bestNetUSD = { netUSD: optimal.netUSD, sizeUSD: optimal.sizeUSD, at: m.measuredAt };
  }

  r.recent.push({ at: m.measuredAt, netPct: m.netPctBeforeGas, buyOn: m.buyOn });
  if (r.recent.length > 48) r.recent = r.recent.slice(-48);

  const hour = new Date(m.measuredAt).getUTCHours();
  if (!history.hourlyStats[hour]) history.hourlyStats[hour] = { samples: 0, positives: 0, sumNetPct: 0 };
  const hs = history.hourlyStats[hour];
  hs.samples++;
  hs.sumNetPct += m.netPctBeforeGas;
  if (isPositive) hs.positives++;
}

async function runOnce() {
  const startedAt = Date.now();
  console.log(`\n[${new Date().toISOString()}] 精査開始…`);
  try {
    const result = await runProspect({ minTvlUSD: MIN_TVL_USD, topN: 50 });
    latest = result;
    lastError = null;
    runCount++;

    const s = result.stats;
    console.log(`全${s.totalPools}プール中、DEXプール${s.dexPoolCount}件、裁定候補 ${s.arbitragableCount}件`);

    history.snapshots.push({
      at: result.scannedAt,
      arbitragableCount: s.arbitragableCount,
      quietCount: result.quietPairs.length,
      topChains: result.chainSummary.slice(0, 5).map((c) => ({ chain: c.chain, pairs: c.pairCount, quiet: c.quietPairs })),
    });
    updatePairTracking(result);

    const targets = selectMeasurable(result.arbitragableRaw || []);
    console.log(`\n実測対象(V2×V3ペア): ${targets.length}件`);

    latestMeasurements = [];
    for (const t of targets) {
      const key = `${t.chain}||${t.symbol}`;
      try {
        const m = await measureSpread(t.chain, ethers_getAddress(t.tokenA), ethers_getAddress(t.tokenB));
        if (!m) continue;

        let safety = history.measurements[key]?.lastSafety ?? null;
        const needSafetyCheck = !safety || !safety.at ||
          (Date.now() - new Date(safety.at).getTime() > 24 * 60 * 60 * 1000);
        if (needSafetyCheck) {
          const cfg = CHAIN_CONFIG[t.chain];
          const provider = getProvider(t.chain);
          const sc = await checkTokenSafety(cfg, provider, ethers_getAddress(t.tokenA), ethers_getAddress(t.tokenB), m.decA);
          safety = { ...sc, at: new Date().toISOString() };
        }

        let optimal = null;
        if (m.netPctBeforeGas > 0) {
          optimal = await findOptimalSize(t.chain, ethers_getAddress(t.tokenA), ethers_getAddress(t.tokenB), {
            gasCostUSD: m.gasCostUSD ?? 0.5,
          });
        }

        recordMeasurement(key, m, safety, optimal);
        latestMeasurements.push({ ...m, symbol: t.symbol, minTvl: t.minTvl, turnover: t.turnover, safety, optimal });

        const mark = m.netPctBeforeGas > 0 ? "✅" : "  ";
        console.log(`${mark} [${t.chain}] ${t.symbol}: ${m.netPctBeforeGas >= 0 ? "+" : ""}${m.netPctBeforeGas.toFixed(4)}% ` +
          `(${m.buyOn}→${m.sellOn})` +
          (optimal ? ` 最適$${optimal.sizeUSD}で純利益$${optimal.netUSD.toFixed(2)}` : "") +
          (safety?.warnings?.length ? ` ⚠️ ${safety.warnings[0]}` : ""));
      } catch (e) {
        console.log(`   [${t.chain}] ${t.symbol}: 実測失敗 (${e.message})`);
      }
    }

    latestMeasurements.sort((a, b) => b.netPctBeforeGas - a.netPctBeforeGas);
    const positives = latestMeasurements.filter((m) => m.netPctBeforeGas > 0);
    console.log(`\n実測完了: ${latestMeasurements.length}件測定、うちプラスの価格差 ${positives.length}件`);

    saveHistory(history);
    console.log(`精査完了(${((Date.now()-startedAt)/1000).toFixed(1)}秒)。次回は${PROSPECT_INTERVAL_MIN}分後。`);
  } catch (e) {
    lastError = e.message;
    console.error("精査エラー:", e.message);
  }
}

function fmtUsd(v) {
  if (v == null) return "-";
  return v >= 1e9 ? `$${(v/1e9).toFixed(1)}B` : v >= 1e6 ? `$${(v/1e6).toFixed(1)}M`
       : v >= 1e3 ? `$${(v/1e3).toFixed(0)}k` : `$${v.toFixed(0)}`;
}

function renderPage() {
  if (!latest) {
    return `<!DOCTYPE html><html lang="ja"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1.0"><meta http-equiv="refresh" content="15">
<title>裁定機会の観測所</title><style>body{font-family:-apple-system,sans-serif;background:#0d100c;color:#e8e6d8;padding:40px 20px;text-align:center;}</style>
</head><body><h2>初回の精査を実行中です…</h2><p style="color:#888;">全チェーン精査と実測に数分かかります</p>
${lastError?`<p style="color:#e74c3c;">エラー: ${lastError}</p>`:''}</body></html>`;
  }

  const s = latest.stats;

  const measureRows = latestMeasurements.slice(0, 30).map((m, i) => {
    const pct = m.netPctBeforeGas;
    const color = pct > 0 ? "#2ecc71" : "#e74c3c";
    const warn = m.safety?.warnings?.length ? `<div style="font-size:9px;color:#e67e22;">⚠️ ${m.safety.warnings[0]}</div>` : "";
    const opt = m.optimal ? `$${m.optimal.sizeUSD}<br><span style="color:#2ecc71;">+$${m.optimal.netUSD.toFixed(2)}</span>` : "-";
    return `<tr><td>${i+1}</td><td>${m.chain}</td>
    <td>${m.symbol}${warn}</td>
    <td style="text-align:right;color:${color};font-weight:600;">${pct>=0?'+':''}${pct.toFixed(4)}%</td>
    <td style="font-size:9px;">${m.buyOn.replace('uniswap-','')}<br>→${m.sellOn.replace('uniswap-','')}</td>
    <td style="text-align:right;font-size:10px;">${opt}</td>
    <td style="text-align:right;font-size:10px;">${fmtUsd(m.minTvl)}</td></tr>`;
  }).join("") || `<tr><td colspan="7" style="color:#888;">実測データがまだありません</td></tr>`;

  const measureSummary = Object.entries(history.measurements)
    .map(([k, r]) => ({ key: k, ...r, avgNetPct: r.samples > 0 ? r.sumNetPct / r.samples : 0,
                        positiveRate: r.samples > 0 ? (r.positiveCount / r.samples) * 100 : 0 }))
    .filter((r) => r.samples >= 2)
    .sort((a, b) => b.positiveRate - a.positiveRate || b.maxNetPct - a.maxNetPct)
    .slice(0, 20);
  const summaryRows = measureSummary.map((r, i) => {
    const best = r.bestNetUSD ? `$${r.bestNetUSD.netUSD.toFixed(2)}<br><span style="font-size:9px;color:#888;">(${fmtUsd(r.bestNetUSD.sizeUSD)}投入時)</span>` : "-";
    const safe = r.lastSafety?.sellable === false ? '<span style="color:#e74c3c;">危険</span>'
               : r.lastSafety?.warnings?.length ? '<span style="color:#e67e22;">注意</span>'
               : '<span style="color:#2ecc71;">OK</span>';
    return `<tr><td>${i+1}</td><td>${r.chain}</td><td>${r.symbol}</td>
    <td style="text-align:right;color:${r.positiveRate>0?'#2ecc71':'#888'};">${r.positiveRate.toFixed(0)}%<br><span style="font-size:9px;color:#888;">${r.positiveCount}/${r.samples}回</span></td>
    <td style="text-align:right;">${r.maxNetPct>=0?'+':''}${r.maxNetPct.toFixed(3)}%</td>
    <td style="text-align:right;">${r.maxConsecutivePositive}回<br><span style="font-size:9px;color:#888;">連続</span></td>
    <td style="text-align:right;font-size:10px;">${best}</td>
    <td style="text-align:center;font-size:10px;">${safe}</td></tr>`;
  }).join("") || `<tr><td colspan="8" style="color:#888;">複数回の測定が必要です</td></tr>`;

  const hours = Array.from({length:24}, (_,h) => h);
  const maxHourly = Math.max(1, ...hours.map((h) => history.hourlyStats[h]?.positives ?? 0));
  const hourBars = hours.map((h) => {
    const st = history.hourlyStats[h];
    const val = st?.positives ?? 0;
    const height = Math.round((val / maxHourly) * 36) + 2;
    const jstHour = (h + 9) % 24;
    return `<div style="flex:1;text-align:center;">
      <div style="background:${val>0?'#2ecc71':'#2a331d'};height:${height}px;margin:0 1px;" title="JST${jstHour}時: プラス${val}回/${st?.samples??0}回"></div>
      <div style="font-size:7px;color:#666;margin-top:2px;">${jstHour}</div>
    </div>`;
  }).join("");

  const chainRows = latest.chainSummary.slice(0, 15).map((c, i) =>
    `<tr><td>${i+1}</td><td><b>${c.chain}</b></td><td style="text-align:right;">${c.pairCount}</td>
    <td style="text-align:right;">${c.dexCount}</td><td style="text-align:right;">${fmtUsd(c.totalTvl)}</td>
    <td style="text-align:right;color:${c.quietPairs>0?'#ffb000':'#666'};">${c.quietPairs}</td></tr>`).join("");

  const positiveNow = latestMeasurements.filter((m) => m.netPctBeforeGas > 0).length;

  return `<!DOCTYPE html><html lang="ja"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1.0"><meta http-equiv="refresh" content="60">
<title>裁定機会の観測所</title><style>
body{font-family:-apple-system,sans-serif;background:#0d100c;color:#e8e6d8;margin:0;padding:18px 12px;}
h1{font-size:17px;margin:0 0 4px;} h2{font-size:13px;margin:0 0 10px;font-weight:600;}
.sub{color:#888;font-size:11px;margin-bottom:16px;}
.card{background:#14180f;border:1px solid #2a331d;border-radius:8px;padding:13px;margin-bottom:13px;}
.row{display:flex;justify-content:space-between;padding:5px 0;font-size:12px;border-bottom:1px solid #222;}
.row:last-child{border-bottom:none;} .label{color:#888;}
table{width:100%;border-collapse:collapse;font-size:11px;}
th{text-align:left;color:#888;font-weight:500;font-size:9.5px;padding:5px 3px;border-bottom:1px solid #2a331d;}
td{padding:6px 3px;border-bottom:1px solid #1c1c1c;vertical-align:top;}
.note{font-size:10px;color:#888;line-height:1.6;margin-top:9px;padding-top:9px;border-top:1px solid #222;}
.stat{display:grid;grid-template-columns:repeat(4,1fr);gap:6px;margin-bottom:13px;}
.stat div{background:#14180f;border:1px solid #2a331d;border-radius:8px;padding:11px 4px;text-align:center;}
.stat .v{font-size:17px;font-weight:600;} .stat .l{font-size:8.5px;color:#888;margin-top:2px;}
</style></head><body>
<h1>🔍 裁定機会の観測所</h1>
<div class="sub">${PROSPECT_INTERVAL_MIN}分ごとに全チェーン精査 + 上位${MEASURE_TOP_N}件を実測 / 最終更新: ${new Date(latest.scannedAt).toLocaleString('ja-JP')}</div>

<div class="stat">
  <div><div class="v">${s.arbitragableCount}</div><div class="l">裁定候補</div></div>
  <div><div class="v" style="color:#ffb000;">${latest.quietPairs.length}</div><div class="l">競争薄い</div></div>
  <div><div class="v" style="color:${positiveNow>0?'#2ecc71':'#666'};">${positiveNow}</div><div class="l">今プラス</div></div>
  <div><div class="v">${runCount}</div><div class="l">精査回数</div></div>
</div>

<div class="card">
  <h2>💰 実測: 今この瞬間の価格差(手数料控除後)</h2>
  <table><thead><tr><th>#</th><th>Chain</th><th>ペア</th><th style="text-align:right;">純利益率</th><th>経路</th><th style="text-align:right;">最適サイズ</th><th style="text-align:right;">TVL</th></tr></thead>
  <tbody>${measureRows}</tbody></table>
  <div class="note">
    DEX手数料とフラッシュローン手数料(0.05%)を引いた後の利益率。<br>
    プラスなら理論上は利益が出る状態(ガス代は別途)。「最適サイズ」は実測した最も利益が大きい投入額。
  </div>
</div>

<div class="card">
  <h2>📊 累積分析: どのペアが継続的に有望か</h2>
  <table><thead><tr><th>#</th><th>Chain</th><th>ペア</th><th style="text-align:right;">プラス率</th><th style="text-align:right;">最大</th><th style="text-align:right;">連続</th><th style="text-align:right;">最高利益</th><th>安全性</th></tr></thead>
  <tbody>${summaryRows}</tbody></table>
  <div class="note">
    <b>プラス率</b>: 測定回数のうち利益が出る状態だった割合。高いほど機会が持続的。<br>
    <b>連続</b>: 何回連続でプラスが続いたか。長いほど実行が間に合いやすい。<br>
    <b>安全性</b>: 売却可能か・送金手数料がないかの検査結果。「危険」は絶対に取引しないこと。
  </div>
</div>

<div class="card">
  <h2>🕐 時間帯分析(日本時間)</h2>
  <div style="display:flex;align-items:flex-end;height:52px;">${hourBars}</div>
  <div class="note">各時間にプラスの価格差が観測された回数。棒が高い時間帯に機会が集中しています。</div>
</div>

<div class="card">
  <h2>チェーン別ランキング</h2>
  <table><thead><tr><th>#</th><th>チェーン</th><th style="text-align:right;">候補</th><th style="text-align:right;">DEX</th><th style="text-align:right;">TVL</th><th style="text-align:right;">静か</th></tr></thead>
  <tbody>${chainRows}</tbody></table>
</div>

<div class="card">
  <div class="row"><span class="label">全プール数</span><span>${s.totalPools}</span></div>
  <div class="row"><span class="label">DEXプール(TVL$${MIN_TVL_USD}以上)</span><span>${s.dexPoolCount}</span></div>
  <div class="row"><span class="label">実測対象</span><span>V2×V3のペア 上位${MEASURE_TOP_N}件</span></div>
  ${lastError?`<div class="row"><span class="label">エラー</span><span style="color:#e74c3c;">${lastError}</span></div>`:''}
</div>
</body></html>`;
}

function startServer() {
  const port = process.env.PORT || 8080;
  http.createServer((req, res) => {
    if (req.url === "/data.json") {
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({
        latest, measurements: latestMeasurements,
        history: history.snapshots.slice(-50),
        tracking: history.pairTracking,
        measureHistory: history.measurements,
        hourlyStats: history.hourlyStats,
      }, null, 2));
      return;
    }
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(renderPage());
  }).listen(port, () => console.log(`観測所ページ: ポート${port}`));
}

async function main() {
  console.log("=== 裁定機会の観測所(実測機能つき) 起動 ===");
  console.log(`精査間隔: ${PROSPECT_INTERVAL_MIN}分 / 実測対象: 上位${MEASURE_TOP_N}件(V2×V3)`);
  console.log(`過去の履歴: ${history.snapshots.length}回分`);
  startServer();

  while (true) {
    await runOnce();
    await new Promise((r) => setTimeout(r, PROSPECT_INTERVAL_MIN * 60 * 1000));
  }
}

main().catch((e) => { console.error("致命的エラー:", e); process.exit(1); });
