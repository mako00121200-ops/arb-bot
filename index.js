import http from "http";
import { sampleBinancePrices, fetchActiveShortDurationMarkets, analyzeMarket } from "./twap-oracle.js";
import { checkLogicalConstraints, WATCHED_PAIRS } from "./logic-checker.js";
import { recordSignal, resolveOpenPositions, getStats, getOpenCount, getRecentResolved } from "./paper-trader.js";

/**
 * 予測市場の歪み観測所
 * ------------------------------------------------------------
 * DEXの価格裁定(旧バージョン)は2日間の観測で機会ゼロだったため、
 * 予測市場(Polymarket)の2つの歪みに絞って観測所を作り直した。
 *
 *  1. TWAPオラクル観測: Polymarketの5分/15分BTC/ETH市場が2026年8月から
 *     採用したTWAP決済方式を自前で計算し、市場の表示価格とのズレを検出
 *  2. 論理矛盾チェッカー: 「AがBを含むならA≧Bのはず」といった
 *     算数的に成り立つべき関係の破れを検出
 *
 * 実際の注文は一切出さない。両方とも「もし賭けていたら」を記録し、
 * 市場確定後に勝率・純利益(手数料込み)を自動集計する。
 */

const BINANCE_SAMPLE_INTERVAL_SEC = parseInt(process.env.BINANCE_SAMPLE_INTERVAL_SEC || "2", 10);
const TWAP_CHECK_INTERVAL_SEC = parseInt(process.env.TWAP_CHECK_INTERVAL_SEC || "5", 10);
const LOGIC_CHECK_INTERVAL_SEC = parseInt(process.env.LOGIC_CHECK_INTERVAL_SEC || "60", 10);
const RESOLVE_CHECK_INTERVAL_SEC = parseInt(process.env.RESOLVE_CHECK_INTERVAL_SEC || "30", 10);
const EDGE_THRESHOLD = parseFloat(process.env.EDGE_THRESHOLD || "0.05");

let latestTwapSignals = [];
let latestLogicSignals = [];
let lastError = null;
let sampleCount = 0;
let twapCheckCount = 0;

async function twapCheckOnce() {
  try {
    const markets = await fetchActiveShortDurationMarkets();
    const results = [];
    for (const m of markets) {
      const r = await analyzeMarket(m);
      if (r) results.push(r);
    }
    latestTwapSignals = results;
    twapCheckCount++;

    for (const r of results) {
      if (Math.abs(r.edge) < EDGE_THRESHOLD) continue;
      const side = r.edge > 0 ? r.impliedDirection : (r.impliedDirection === "UP" ? "DOWN" : "UP");
      const entryPrice = side === r.impliedDirection ? r.marketPrice : 1 - r.marketPrice;
      const resolveAtMs = Date.now() + Math.max(r.remainingSec, 1) * 1000 + 15000;
      recordSignal("twap-oracle", side, entryPrice, resolveAtMs, {
        marketId: r.marketId, question: r.question, edge: r.edge, confidence: r.confidence,
      });
      console.log(`[TWAP] ${r.question}: 我々の推定${(r.ourEstimate*100).toFixed(1)}% vs 市場${(r.marketPrice*100).toFixed(1)}% ` +
        `(ズレ${(r.edge*100).toFixed(1)}pt, 残り${r.remainingSec}秒) → ${side}に紙上ベット記録`);
    }
  } catch (e) {
    lastError = e.message;
    console.error("TWAP観測エラー:", e.message);
  }
}

async function logicCheckOnce() {
  if (WATCHED_PAIRS.length === 0) return;
  try {
    const results = await checkLogicalConstraints();
    latestLogicSignals = results;
    for (const r of results) {
      if (!r.violated || r.magnitude < EDGE_THRESHOLD) continue;
      const resolveAtMs = Date.now() + 24 * 60 * 60 * 1000;
      recordSignal("logic-checker", "A", r.marketA.yesPrice, resolveAtMs, {
        label: r.label, edge: r.magnitude, marketA: r.marketA.slug, marketB: r.marketB.slug,
      });
      console.log(`[論理矛盾] ${r.label}: 矛盾を検出(差${(r.magnitude*100).toFixed(1)}pt) → 紙上ベット記録`);
    }
  } catch (e) {
    console.error("論理矛盾チェックエラー:", e.message);
  }
}

async function resolveOnce() {
  await resolveOpenPositions(async (pos) => {
    try {
      const res = await fetch(`https://gamma-api.polymarket.com/markets/${pos.meta.marketId}`);
      if (!res.ok) return { outcome: null };
      const m = await res.json();
      if (!m.closed) return { outcome: null };
      const prices = m.outcomePrices ? JSON.parse(m.outcomePrices) : null;
      if (!prices) return { outcome: null };
      const upWon = parseFloat(prices[0]) > 0.5;
      return { outcome: upWon ? "UP" : "DOWN" };
    } catch (e) {
      return { outcome: null };
    }
  });
}

function renderPage() {
  const twapStats = getStats("twap-oracle");
  const logicStats = getStats("logic-checker");
  const recentTrades = getRecentResolved(15);

  const twapRows = latestTwapSignals.slice(0, 15).map((r, i) => {
    const color = Math.abs(r.edge) >= EDGE_THRESHOLD ? (r.edge > 0 ? "#2ecc71" : "#e74c3c") : "#888";
    return `<tr><td>${i+1}</td><td>${r.asset}</td>
    <td style="font-size:9px;">${r.question.slice(0,30)}</td>
    <td style="text-align:right;">${r.remainingSec}秒</td>
    <td style="text-align:right;">${(r.ourEstimate*100).toFixed(1)}%</td>
    <td style="text-align:right;">${(r.marketPrice*100).toFixed(1)}%</td>
    <td style="text-align:right;color:${color};font-weight:600;">${r.edge>=0?'+':''}${(r.edge*100).toFixed(1)}pt</td></tr>`;
  }).join("") || `<tr><td colspan="7" style="color:#888;">観測データがまだありません(市場を待機中)</td></tr>`;

  const tradeRows = recentTrades.map((t, i) => {
    const color = t.won ? "#2ecc71" : "#e74c3c";
    return `<tr><td>${i+1}</td><td>${t.strategy}</td><td style="font-size:9px;">${(t.meta?.question||t.meta?.label||'').slice(0,25)}</td>
    <td style="text-align:right;">${t.side}</td>
    <td style="text-align:center;color:${color};">${t.won?'勝ち':'負け'}</td>
    <td style="text-align:right;color:${t.netPnl>=0?'#2ecc71':'#e74c3c'};">${t.netPnl>=0?'+':''}${(t.netPnl*100).toFixed(1)}pt</td></tr>`;
  }).join("") || `<tr><td colspan="6" style="color:#888;">まだ確定した紙上取引はありません</td></tr>`;

  return `<!DOCTYPE html><html lang="ja"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1.0"><meta http-equiv="refresh" content="30">
<title>予測市場の歪み観測所</title><style>
body{font-family:-apple-system,sans-serif;background:#0d100c;color:#e8e6d8;margin:0;padding:18px 12px;}
h1{font-size:17px;margin:0 0 4px;} h2{font-size:13px;margin:0 0 10px;font-weight:600;}
.sub{color:#888;font-size:11px;margin-bottom:16px;}
.card{background:#14180f;border:1px solid #2a331d;border-radius:8px;padding:13px;margin-bottom:13px;}
table{width:100%;border-collapse:collapse;font-size:11px;}
th{text-align:left;color:#888;font-weight:500;font-size:9.5px;padding:5px 3px;border-bottom:1px solid #2a331d;}
td{padding:6px 3px;border-bottom:1px solid #1c1c1c;}
.note{font-size:10px;color:#888;line-height:1.6;margin-top:9px;padding-top:9px;border-top:1px solid #222;}
.stat{display:grid;grid-template-columns:repeat(4,1fr);gap:6px;margin-bottom:13px;}
.stat div{background:#14180f;border:1px solid #2a331d;border-radius:8px;padding:11px 4px;text-align:center;}
.stat .v{font-size:17px;font-weight:600;} .stat .l{font-size:8.5px;color:#888;margin-top:2px;}
</style></head><body>
<h1>🎯 予測市場の歪み観測所</h1>
<div class="sub">紙上取引のみ(実際の注文は出しません) / 観測${sampleCount}回・TWAPチェック${twapCheckCount}回</div>

<div class="card">
  <h2>📈 TWAPオラクル戦略 成績</h2>
  <div class="stat">
    <div><div class="v">${twapStats.count}</div><div class="l">確定件数</div></div>
    <div><div class="v" style="color:${twapStats.winRate>=50?'#2ecc71':'#e74c3c'};">${twapStats.winRate.toFixed(0)}%</div><div class="l">勝率</div></div>
    <div><div class="v" style="color:${twapStats.totalNetPnl>=0?'#2ecc71':'#e74c3c'};">${twapStats.totalNetPnl>=0?'+':''}${(twapStats.totalNetPnl*100).toFixed(1)}pt</div><div class="l">累積純損益</div></div>
    <div><div class="v">${getOpenCount()}</div><div class="l">確認待ち</div></div>
  </div>
  <div class="note">
    純損益は「1単位を賭け続けた場合」の確率ポイント換算。手数料相当(往復2%)は既に控除済み。<br>
    プラスが続けば戦略に優位性がある可能性、マイナスが続けば見送るべき。
  </div>
</div>

<div class="card">
  <h2>今この瞬間の観測(TWAPオラクル)</h2>
  <table><thead><tr><th>#</th><th>資産</th><th>市場</th><th style="text-align:right;">残り</th><th style="text-align:right;">推定確率</th><th style="text-align:right;">市場価格</th><th style="text-align:right;">ズレ</th></tr></thead>
  <tbody>${twapRows}</tbody></table>
</div>

<div class="card">
  <h2>📐 論理矛盾チェッカー 成績</h2>
  <div class="stat">
    <div><div class="v">${logicStats.count}</div><div class="l">確定件数</div></div>
    <div><div class="v" style="color:${logicStats.winRate>=50?'#2ecc71':'#e74c3c'};">${logicStats.winRate.toFixed(0)}%</div><div class="l">勝率</div></div>
    <div><div class="v" style="color:${logicStats.totalNetPnl>=0?'#2ecc71':'#e74c3c'};">${logicStats.totalNetPnl>=0?'+':''}${(logicStats.totalNetPnl*100).toFixed(1)}pt</div><div class="l">累積純損益</div></div>
    <div><div class="v">${WATCHED_PAIRS.length}</div><div class="l">監視ペア数</div></div>
  </div>
  ${WATCHED_PAIRS.length === 0 ? `<div class="note" style="color:#e67e22;">監視ペアが未登録です。logic-checker.jsのWATCHED_PAIRSに、実際に見つけた関連市場ペアを追加してください。</div>` : ''}
</div>

<div class="card">
  <h2>直近の紙上取引結果</h2>
  <table><thead><tr><th>#</th><th>戦略</th><th>内容</th><th>方向</th><th style="text-align:center;">結果</th><th style="text-align:right;">損益</th></tr></thead>
  <tbody>${tradeRows}</tbody></table>
</div>

<div class="card">
  <div class="note">
    TWAP方式: Polymarketの5分/15分BTC/ETH市場は、終了直前30秒/60秒の平均価格で決済される(2026年8月〜)。<br>
    Binance価格を継続記録し、残り時間内に平均が逆転する余地をボラティリティから見積もっている。<br>
    ${lastError ? `<span style="color:#e74c3c;">エラー: ${lastError}</span>` : ''}
  </div>
</div>
</body></html>`;
}

function startServer() {
  const port = process.env.PORT || 8080;
  http.createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(renderPage());
  }).listen(port, () => console.log(`観測所ページ: ポート${port}`));
}

async function main() {
  console.log("=== 予測市場の歪み観測所 起動 ===");
  console.log(`監視ペア数(論理矛盾): ${WATCHED_PAIRS.length}`);
  startServer();

  setInterval(async () => { await sampleBinancePrices(); sampleCount++; }, BINANCE_SAMPLE_INTERVAL_SEC * 1000);
  await sampleBinancePrices();

  setInterval(twapCheckOnce, TWAP_CHECK_INTERVAL_SEC * 1000);
  setInterval(logicCheckOnce, LOGIC_CHECK_INTERVAL_SEC * 1000);
  setInterval(resolveOnce, RESOLVE_CHECK_INTERVAL_SEC * 1000);
}

main().catch((e) => { console.error("致命的エラー:", e); process.exit(1); });
