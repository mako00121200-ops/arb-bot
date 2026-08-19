import http from "http";
import fs from "fs";
import { runProspect } from "./prospector.js";

/**
 * 裁定機会の観測所
 * ------------------------------------------------------------
 * ガス代も秘密鍵も不要。DeFiLlamaの公開データを定期的に精査し、
 * 「どのチェーン・どのDEXの組み合わせに機会がありそうか」を
 * 継続的に観測・記録する。
 *
 * 実際の取引機能は、この観測で狙う場所が定まってから実装する。
 */

const PROSPECT_INTERVAL_MIN = parseInt(process.env.PROSPECT_INTERVAL_MIN || "60", 10);
const MIN_TVL_USD = parseFloat(process.env.MIN_TVL_USD || "10000");
const HISTORY_FILE = process.env.HISTORY_FILE || "/tmp/prospect-history.json";
const MAX_HISTORY = 200;

function loadHistory() {
  try {
    if (fs.existsSync(HISTORY_FILE)) return JSON.parse(fs.readFileSync(HISTORY_FILE, "utf8"));
  } catch (e) { console.warn("履歴読み込み失敗:", e.message); }
  return { snapshots: [], pairTracking: {} };
}
function saveHistory(h) {
  try {
    if (h.snapshots.length > MAX_HISTORY) h.snapshots = h.snapshots.slice(-MAX_HISTORY);
    fs.writeFileSync(HISTORY_FILE, JSON.stringify(h));
  } catch (e) { console.warn("履歴保存失敗:", e.message); }
}
const history = loadHistory();

let latest = null;
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

async function runOnce() {
  const startedAt = Date.now();
  console.log(`\n[${new Date().toISOString()}] 精査開始…`);
  try {
    const result = await runProspect({ minTvlUSD: MIN_TVL_USD, topN: 50 });
    latest = result;
    lastError = null;
    runCount++;

    const s = result.stats;
    console.log(`全${s.totalPools}プール中、DEXプール${s.dexPoolCount}件、` +
      `ユニークペア${s.groupCount}件、複数DEXに存在する裁定候補 ${s.arbitragableCount}件`);

    console.log("\n【チェーン別】候補ペアが多い順(上位10)");
    for (const [i, c] of result.chainSummary.slice(0, 10).entries()) {
      const tvl = c.totalTvl >= 1e9 ? `$${(c.totalTvl/1e9).toFixed(1)}B`
                : c.totalTvl >= 1e6 ? `$${(c.totalTvl/1e6).toFixed(0)}M` : `$${(c.totalTvl/1e3).toFixed(0)}k`;
      console.log(`  ${String(i+1).padStart(2)}. ${c.chain.padEnd(18)} 候補${String(c.pairCount).padStart(4)}件 / ` +
        `DEX${String(c.dexCount).padStart(3)}種 / TVL${tvl.padStart(8)} / 回転率${c.turnover.toFixed(3)} / 静かなペア${c.quietPairs}件`);
    }

    console.log("\n【特に競争が少なそうなペア】上位10");
    if (result.quietPairs.length === 0) {
      console.log("  該当なし");
    } else {
      for (const [i, p] of result.quietPairs.slice(0, 10).entries()) {
        const tvl = p.minTvl >= 1e6 ? `$${(p.minTvl/1e6).toFixed(1)}M` : `$${(p.minTvl/1e3).toFixed(0)}k`;
        console.log(`  ${String(i+1).padStart(2)}. [${p.chain}] ${p.symbol} 回転率${(p.turnover*100).toFixed(2)}% ` +
          `最小TVL${tvl} ${p.venueCount}箇所: ${p.venues.join("/")}`);
      }
    }

    history.snapshots.push({
      at: result.scannedAt,
      arbitragableCount: s.arbitragableCount,
      quietCount: result.quietPairs.length,
      topChains: result.chainSummary.slice(0, 5).map((c) => ({ chain: c.chain, pairs: c.pairCount, quiet: c.quietPairs })),
    });
    updatePairTracking(result);
    saveHistory(history);

    console.log(`\n精査完了(${((Date.now()-startedAt)/1000).toFixed(1)}秒)。次回は${PROSPECT_INTERVAL_MIN}分後。`);
  } catch (e) {
    lastError = e.message;
    console.error("精査エラー:", e.message);
  }
}

function renderPage() {
  if (!latest) {
    return `<!DOCTYPE html><html lang="ja"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1.0"><meta http-equiv="refresh" content="15">
<title>裁定機会の観測所</title><style>body{font-family:-apple-system,sans-serif;background:#0d100c;color:#e8e6d8;padding:40px 20px;text-align:center;}</style>
</head><body><h2>初回の精査を実行中です…</h2><p style="color:#888;">15秒ごとに自動更新されます</p>
${lastError?`<p style="color:#e74c3c;">エラー: ${lastError}</p>`:''}</body></html>`;
  }

  const s = latest.stats;

  const chainRows = latest.chainSummary.slice(0, 20).map((c, i) => {
    const tvl = c.totalTvl >= 1e9 ? `$${(c.totalTvl/1e9).toFixed(1)}B`
              : c.totalTvl >= 1e6 ? `$${(c.totalTvl/1e6).toFixed(0)}M` : `$${(c.totalTvl/1e3).toFixed(0)}k`;
    return `<tr><td>${i+1}</td><td><b>${c.chain}</b></td><td style="text-align:right;">${c.pairCount}</td>
    <td style="text-align:right;">${c.dexCount}</td><td style="text-align:right;">${tvl}</td>
    <td style="text-align:right;">${c.turnover.toFixed(3)}</td>
    <td style="text-align:right;color:${c.quietPairs>0?'#ffb000':'#666'};">${c.quietPairs}</td></tr>`;
  }).join("");

  const quietRows = latest.quietPairs.slice(0, 25).map((p, i) => {
    const tvl = p.minTvl >= 1e6 ? `$${(p.minTvl/1e6).toFixed(1)}M` : `$${(p.minTvl/1e3).toFixed(0)}k`;
    return `<tr><td>${i+1}</td><td>${p.chain}</td><td>${p.symbol}</td>
    <td style="text-align:right;color:#2ecc71;">${(p.turnover*100).toFixed(2)}%</td>
    <td style="text-align:right;">${tvl}</td><td style="font-size:10px;color:#888;">${p.venues.join(" / ")}</td></tr>`;
  }).join("") || `<tr><td colspan="6" style="color:#888;">該当なし</td></tr>`;

  const tracked = Object.values(history.pairTracking)
    .filter((t) => t.appearances >= 2)
    .sort((a, b) => b.appearances - a.appearances)
    .slice(0, 20);
  const trackedRows = tracked.map((t, i) => {
    const tvl = t.maxTvl >= 1e6 ? `$${(t.maxTvl/1e6).toFixed(1)}M` : `$${(t.maxTvl/1e3).toFixed(0)}k`;
    const rate = runCount > 0 ? ((t.appearances / runCount) * 100).toFixed(0) : "-";
    return `<tr><td>${i+1}</td><td>${t.chain}</td><td>${t.symbol}</td>
    <td style="text-align:right;color:#2ecc71;">${t.appearances}回 (${rate}%)</td>
    <td style="text-align:right;">${(t.minTurnover*100).toFixed(2)}%</td>
    <td style="text-align:right;">${tvl}</td></tr>`;
  }).join("") || `<tr><td colspan="6" style="color:#888;">まだデータが不足しています(複数回の精査が必要)</td></tr>`;

  const recent = history.snapshots.slice(-24);
  const trendBars = recent.map((sn) => {
    const h = Math.max(2, Math.min(40, sn.quietCount * 2));
    const time = new Date(sn.at).toLocaleTimeString('ja-JP', {hour:'2-digit', minute:'2-digit'});
    return `<div style="display:inline-block;width:${100/Math.max(recent.length,1)}%;text-align:center;vertical-align:bottom;">
      <div style="background:#ffb000;height:${h}px;margin:0 1px;" title="${time}: 静かなペア${sn.quietCount}件"></div>
    </div>`;
  }).join("");

  return `<!DOCTYPE html><html lang="ja"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1.0"><meta http-equiv="refresh" content="60">
<title>裁定機会の観測所</title><style>
body{font-family:-apple-system,sans-serif;background:#0d100c;color:#e8e6d8;margin:0;padding:18px 14px;}
h1{font-size:17px;margin:0 0 4px;} h2{font-size:13px;margin:0 0 10px;font-weight:600;}
.sub{color:#888;font-size:11.5px;margin-bottom:18px;}
.card{background:#14180f;border:1px solid #2a331d;border-radius:8px;padding:14px;margin-bottom:14px;}
.row{display:flex;justify-content:space-between;padding:5px 0;font-size:12.5px;border-bottom:1px solid #222;}
.row:last-child{border-bottom:none;} .label{color:#888;}
table{width:100%;border-collapse:collapse;font-size:11.5px;}
th{text-align:left;color:#888;font-weight:500;font-size:10px;padding:5px 4px;border-bottom:1px solid #2a331d;}
td{padding:7px 4px;border-bottom:1px solid #1c1c1c;}
.note{font-size:10.5px;color:#888;line-height:1.6;margin-top:10px;padding-top:10px;border-top:1px solid #222;}
.stat{display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin-bottom:14px;}
.stat div{background:#14180f;border:1px solid #2a331d;border-radius:8px;padding:12px 6px;text-align:center;}
.stat .v{font-size:19px;font-weight:600;} .stat .l{font-size:9.5px;color:#888;margin-top:2px;}
</style></head><body>
<h1>🔍 裁定機会の観測所</h1>
<div class="sub">全チェーン・全DEXを${PROSPECT_INTERVAL_MIN}分ごとに精査 / 最終更新: ${new Date(latest.scannedAt).toLocaleString('ja-JP')}</div>

<div class="stat">
  <div><div class="v">${s.arbitragableCount}</div><div class="l">裁定候補ペア</div></div>
  <div><div class="v" style="color:#ffb000;">${latest.quietPairs.length}</div><div class="l">競争が薄い候補</div></div>
  <div><div class="v">${runCount}</div><div class="l">精査回数</div></div>
</div>

${history.snapshots.length > 1 ? `<div class="card">
  <h2>「競争が薄い候補」の推移(直近24回)</h2>
  <div style="height:44px;display:flex;align-items:flex-end;">${trendBars}</div>
  <div class="note">時間帯によって機会の数が変わるかを観測しています。</div>
</div>` : ''}

<div class="card">
  <h2>継続的に競争が薄いペア(狙い目候補)</h2>
  <table><thead><tr><th>#</th><th>チェーン</th><th>ペア</th><th style="text-align:right;">検出率</th><th style="text-align:right;">最低回転率</th><th style="text-align:right;">TVL</th></tr></thead>
  <tbody>${trackedRows}</tbody></table>
  <div class="note">
    毎回の精査で繰り返し「静か」と判定されたペア。一時的な現象ではなく、<br>
    構造的に競争が少ない可能性が高い場所です。ここが最有力候補になります。
  </div>
</div>

<div class="card">
  <h2>チェーン別ランキング</h2>
  <table><thead><tr><th>#</th><th>チェーン</th><th style="text-align:right;">候補</th><th style="text-align:right;">DEX</th><th style="text-align:right;">TVL</th><th style="text-align:right;">回転率</th><th style="text-align:right;">静か</th></tr></thead>
  <tbody>${chainRows}</tbody></table>
  <div class="note">
    回転率 = 24h取引量 ÷ TVL。低いほど取引が閑散しており、価格が乖離しやすい傾向。<br>
    「静か」列は、そのチェーンで競争が薄いと判定されたペアの数です。
  </div>
</div>

<div class="card">
  <h2>今回検出された競争の薄いペア</h2>
  <table><thead><tr><th>#</th><th>チェーン</th><th>ペア</th><th style="text-align:right;">回転率</th><th style="text-align:right;">TVL</th><th>DEX</th></tr></thead>
  <tbody>${quietRows}</tbody></table>
</div>

<div class="card">
  <div class="row"><span class="label">DeFiLlama全プール数</span><span>${s.totalPools}</span></div>
  <div class="row"><span class="label">うちDEXプール(TVL$${MIN_TVL_USD}以上)</span><span>${s.dexPoolCount}</span></div>
  <div class="row"><span class="label">ユニークなトークンペア</span><span>${s.groupCount}</span></div>
  ${lastError?`<div class="row"><span class="label">エラー</span><span style="color:#e74c3c;">${lastError}</span></div>`:''}
</div>
</body></html>`;
}

function startServer() {
  const port = process.env.PORT || 3000;
  http.createServer((req, res) => {
    if (req.url === "/data.json") {
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ latest, history: history.snapshots.slice(-50), tracking: history.pairTracking }, null, 2));
      return;
    }
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(renderPage());
  }).listen(port, () => console.log(`観測所ページ: ポート${port}`));
}

async function main() {
  console.log("=== 裁定機会の観測所 起動 ===");
  console.log(`精査間隔: ${PROSPECT_INTERVAL_MIN}分 / 最低TVL: $${MIN_TVL_USD}`);
  console.log(`過去の精査回数: ${history.snapshots.length}回分の履歴あり`);
  startServer();

  while (true) {
    await runOnce();
    await new Promise((r) => setTimeout(r, PROSPECT_INTERVAL_MIN * 60 * 1000));
  }
}

main().catch((e) => { console.error("致命的エラー:", e); process.exit(1); });
