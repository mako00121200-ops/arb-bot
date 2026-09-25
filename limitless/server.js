// ダッシュボード。/ で画面、/api/state で JSON を返す。読み取り専用。
// DASHBOARD_TOKEN を設定した場合は ?token=… が要る(cookie に残す)。
import http from 'node:http';

export function startServer({ port, getState, token = '' }) {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    if (token) {
      const cookie = /(?:^|;\s*)dt=([^;]+)/.exec(req.headers.cookie ?? '')?.[1];
      const q = url.searchParams.get('token');
      if (q !== token && cookie !== token) { res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' }); res.end('token が要ります'); return; }
      if (q === token) res.setHeader('set-cookie', `dt=${token}; Path=/; Max-Age=31536000; SameSite=Lax; HttpOnly`);
    }
    if (url.pathname === '/healthz') { res.writeHead(200); res.end('ok'); return; }
    if (url.pathname === '/api/state') {
      let body;
      try { body = JSON.stringify(getState()); } catch (e) { res.writeHead(500, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: e.message })); return; }
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      res.end(body);
      return;
    }
    if (url.pathname === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      res.end(PAGE);
      return;
    }
    res.writeHead(404); res.end();
  });
  server.listen(port, () => console.log(`[画面] http://0.0.0.0:${port}/ で待受`));
  return server;
}

export const PAGE = `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>Limitless 観測</title>
<style>
  :root { color-scheme: light dark;
    --bg:#f6f6f4; --surface:#fcfcfb; --line:#e3e2dd; --text:#0b0b0b; --text2:#52514e; --muted:#8a8985;
    --s1:#2a78d6; --s2:#eb6834; --s3:#1baf7a; --pos:#2a78d6; --neg:#e34948; --mid:#f0efec; --good:#0ca30c; --crit:#d03b3b; }
  @media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) {
    --bg:#111110; --surface:#1a1a19; --line:#2e2e2b; --text:#fff; --text2:#c3c2b7; --muted:#8a8985;
    --s1:#3987e5; --s2:#d95926; --s3:#199e70; --pos:#3987e5; --neg:#e66767; --mid:#383835; } }
  :root[data-theme="dark"] { --bg:#111110; --surface:#1a1a19; --line:#2e2e2b; --text:#fff; --text2:#c3c2b7; --s1:#3987e5; --s2:#d95926; --s3:#199e70; --pos:#3987e5; --neg:#e66767; --mid:#383835; }
  * { box-sizing:border-box } body { margin:0; background:var(--bg); color:var(--text); font:15px/1.5 -apple-system,BlinkMacSystemFont,"Hiragino Sans","Noto Sans JP",sans-serif; padding:12px 16px calc(24px + env(safe-area-inset-bottom)); }
  h1 { font-size:18px; margin:4px 0 2px } .sub { color:var(--text2); font-size:12px; margin-bottom:12px }
  .grid { display:grid; gap:10px; grid-template-columns:repeat(2,1fr) } @media (min-width:700px){ .grid{ grid-template-columns:repeat(4,1fr) } }
  .tile { background:var(--surface); border:1px solid var(--line); border-radius:10px; padding:10px 12px } .tile .k { font-size:11px; color:var(--text2) } .tile .v { font-size:24px; font-weight:700; letter-spacing:-.02em; font-variant-numeric:tabular-nums } .tile .d { font-size:11px; color:var(--muted) }
  .card { background:var(--surface); border:1px solid var(--line); border-radius:12px; padding:12px; margin-top:12px } .card h2 { font-size:14px; margin:0 0 2px } .card .note { font-size:12px; color:var(--text2); margin:0 0 8px }
  .chart { position:relative; height:200px }
  .tbl { overflow-x:auto; -webkit-overflow-scrolling:touch } table { border-collapse:collapse; width:100%; font-size:12.5px; font-variant-numeric:tabular-nums; white-space:nowrap } th,td { padding:5px 8px; border-bottom:1px solid var(--line); text-align:right } th:first-child,td:first-child { text-align:left } th { color:var(--text2); font-weight:600; font-size:11px; position:sticky; top:0; background:var(--surface) }
  .bar { display:inline-block; height:10px; border-radius:3px; vertical-align:middle } .pos{background:var(--pos)} .neg{background:var(--neg)}
  .tag { display:inline-block; font-size:10px; padding:1px 6px; border-radius:99px; background:var(--mid); color:var(--text2); margin-left:4px }
  .up { color:var(--good) } .dn { color:var(--crit) } .ok::before{content:"✓ "} .ng::before{content:"✗ "}
  .legend { display:flex; gap:12px; font-size:11px; color:var(--text2); margin:4px 0 6px } .legend i { display:inline-block; width:14px; height:2px; vertical-align:middle; margin-right:4px } .legend b { display:inline-block; width:10px; height:10px; border-radius:2px; vertical-align:middle; margin-right:4px }
  .empty { color:var(--muted); font-size:12px; padding:8px 0 }
</style>
</head>
<body>
<h1>Limitless 観測(実弾なし)</h1>
<div class="sub" id="sub">読み込み中…</div>
<div class="grid" id="kpi"></div>

<div class="card"><h2>遅延の推移(直近24時間、p50)</h2><p class="note">板取得の HTTP 往復が「注文を送れる速さ」の代理。WS は板の更新が届くまでの遅れ。</p>
  <div class="legend"><span><i style="background:var(--s1)"></i>HTTP 板取得</span><span><i style="background:var(--s2)"></i>WS 板</span><span><i style="background:var(--s3)"></i>Binance</span></div>
  <div class="chart"><canvas id="latency"></canvas></div></div>

<div class="card"><h2>寄り付き5秒の的中率(UTC日別)</h2><p class="note">「理論価格」と「板の中値」が、決済結果の側を指していた割合。理論 &gt; 板 なら寄り付きに乗る価値がある。</p>
  <div class="legend"><span><b style="background:var(--s1)"></b>理論</span><span><b style="background:var(--s2)"></b>板</span></div>
  <div class="chart"><canvas id="hit"></canvas></div>
  <div class="tbl"><table id="hitKind"></table></div></div>

<div class="card"><h2>板と理論価格の乖離(今日、UTC)</h2><p class="note">理論 − 板 の大きい方を秒ごとに数えたもの。2¢ 超が多いほどテイカーで取れる余地がある。</p>
  <div class="chart"><canvas id="edge"></canvas></div></div>

<div class="card"><h2>勝者(直近24時間、損益確定分)</h2><p class="note">Base 上の約定をアドレス別に集計。テイカー率・側・満期前秒数が「戦術」。</p><div class="tbl"><table id="lead24"></table></div></div>
<div class="card"><h2>常連(直近7日)</h2><p class="note">日別トップ10に入った日数の多い順。連日出る人の型を真似る候補。</p><div class="tbl"><table id="lead7"></table></div></div>
<div class="card"><h2>監視中の市場</h2><div class="tbl"><table id="markets"></table></div></div>
<div class="card"><h2>最近の決済</h2><div class="tbl"><table id="recent"></table></div></div>
<div class="card"><h2>最近の約定(Base)</h2><div class="tbl"><table id="fills"></table></div></div>

<script src="https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.4.1/chart.umd.min.js"></script>
<script>
const css = (v) => getComputedStyle(document.documentElement).getPropertyValue(v).trim();
const fmt = { n:(v,d=0)=> v===null||v===undefined||Number.isNaN(v)?'-':Number(v).toLocaleString('ja-JP',{maximumFractionDigits:d,minimumFractionDigits:d}), pct:(v)=> v===null||v===undefined?'-':Math.round(v*100)+'%', usd:(v)=> v===null||v===undefined?'-':(v>=0?'+':'')+'$'+Number(v).toFixed(2), t:(ms)=> ms?new Date(ms).toLocaleTimeString('ja-JP',{hour:'2-digit',minute:'2-digit',second:'2-digit'}):'-' };
const short = (a) => a ? a.slice(0,6)+'…'+a.slice(-4) : '-';
function el(tag, attrs={}, ...kids){ const e=document.createElement(tag); for(const [k,v] of Object.entries(attrs)){ if(k==='class') e.className=v; else if(k==='style') e.style.cssText=v; else e.setAttribute(k,v);} for(const k of kids){ if(k===null||k===undefined) continue; e.append(k.nodeType?k:document.createTextNode(String(k))); } return e; }
function table(id, head, rows, empty='まだデータがありません'){ const t=document.getElementById(id); t.replaceChildren(); if(!rows.length){ t.append(el('tr',{},el('td',{class:'empty',colspan:String(head.length)},empty))); return; } t.append(el('thead',{},el('tr',{},...head.map(h=>el('th',{},h))))); const tb=el('tbody'); for(const r of rows) tb.append(el('tr',{},...r.map(c=>el('td',{},c)))); t.append(tb); }
function pnlCell(v, max){ const w=Math.min(60, Math.abs(v)/Math.max(max,1e-9)*60); return el('span',{}, el('span',{class:'bar '+(v>=0?'pos':'neg'), style:'width:'+w+'px;margin-right:6px'}), fmt.usd(v)); }
function who(r){ return el('span',{}, short(r.owner), r.name? el('span',{class:'tag'}, r.name):null); }
const charts = {};
function lineChart(id, labels, datasets){ const ctx=document.getElementById(id); if(charts[id]){ charts[id].data.labels=labels; charts[id].data.datasets.forEach((d,i)=>d.data=datasets[i].data); charts[id].update('none'); return; }
  charts[id]=new Chart(ctx,{type:'line',data:{labels,datasets:datasets.map(d=>({...d,borderWidth:2,pointRadius:0,pointHitRadius:12,tension:.2}))},options:{animation:false,responsive:true,maintainAspectRatio:false,interaction:{mode:'index',intersect:false},plugins:{legend:{display:false},tooltip:{callbacks:{label:(c)=>c.parsed.y===null?'':c.dataset.label+': '+Math.round(c.parsed.y)+' ms'}}},scales:{x:{ticks:{color:css('--text2'),maxTicksLimit:6,font:{size:10}},grid:{display:false}},y:{beginAtZero:true,ticks:{color:css('--text2'),font:{size:10},callback:(v)=>v+' ms'},grid:{color:css('--line')}}}}}); }
function barChart(id, labels, datasets, opts={}){ const ctx=document.getElementById(id); if(charts[id]){ charts[id].data.labels=labels; charts[id].data.datasets.forEach((d,i)=>d.data=datasets[i].data); charts[id].update('none'); return; }
  charts[id]=new Chart(ctx,{type:'bar',data:{labels,datasets:datasets.map(d=>({...d,borderRadius:4,borderSkipped:'bottom',maxBarThickness:28}))},options:{animation:false,responsive:true,maintainAspectRatio:false,interaction:{mode:'index',intersect:false},plugins:{legend:{display:false},tooltip:{callbacks:{label:(c)=>c.dataset.label+': '+(opts.pct?Math.round(c.parsed.y)+'%':c.parsed.y.toLocaleString())}}},scales:{x:{ticks:{color:css('--text2'),font:{size:10}},grid:{display:false}},y:{beginAtZero:true,max:opts.pct?100:undefined,ticks:{color:css('--text2'),font:{size:10},callback:(v)=>opts.pct?v+'%':v},grid:{color:css('--line')}}}}}); }

async function refresh(){
  let s; try { s = await (await fetch('/api/state',{cache:'no-store'})).json(); } catch(e){ document.getElementById('sub').textContent='取得失敗: '+e.message; return; }
  document.getElementById('sub').textContent = '更新 '+fmt.t(s.now)+' / 稼働 '+Math.round((s.now-s.startedAt)/3600000*10)/10+'h / 記録 '+Object.entries(s.counts).map(([k,v])=>k+':'+v).join(' ');
  const L = s.latency ?? {};
  const kpis = [
    ['監視中の市場', s.markets.length+'件', s.assets.join(', ')],
    ['板取得の往復 p50', (L.http_orderbook?.p50??'-')+' ms', 'p95 '+(L.http_orderbook?.p95??'-')+' ms'],
    ['WS 板の受信遅れ p50', (L.ws_book_lag?.p50??'-')+' ms', 'Binance '+(L.binance_lag?.p50??'-')+' ms'],
    ['24h 確定約定', s.lead24.resolvedFills+'件', '未確定 '+s.lead24.unresolved+'件'],
    ['24h 合計損益(全員)', fmt.usd(s.lead24.totalPnl), 'アドレス '+s.lead24.addresses],
    ['今日の決済市場', String(Object.values(s.today.markets).reduce((a,m)=>a+m.n,0))+'件', '約定 '+s.today.fills+'件'],
  ];
  document.getElementById('kpi').replaceChildren(...kpis.map(([k,v,d])=>el('div',{class:'tile'},el('div',{class:'k'},k),el('div',{class:'v'},v),el('div',{class:'d'},d))));
  const lat = s.latencyHistory;
  lineChart('latency', lat.map(x=>fmt.t(x.t).slice(0,5)), [ {label:'HTTP 板取得',data:lat.map(x=>x.http),borderColor:css('--s1')}, {label:'WS 板',data:lat.map(x=>x.ws),borderColor:css('--s2')}, {label:'Binance',data:lat.map(x=>x.cex),borderColor:css('--s3')} ]);
  const days = s.days;
  const agg = days.map(d=>{ let j=0,t=0,m=0; for(const k of Object.values(d.markets)){ j+=k.judged; t+=k.theoRight; m+=k.midRight; } return {date:d.date, theo:j?t/j*100:null, mid:j?m/j*100:null, j}; });
  barChart('hit', agg.map(a=>a.date.slice(5)+' (n='+a.j+')'), [ {label:'理論',data:agg.map(a=>a.theo),backgroundColor:css('--s1')}, {label:'板',data:agg.map(a=>a.mid),backgroundColor:css('--s2')} ], {pct:true});
  const today = s.today; const kinds = Object.entries(today.markets);
  table('hitKind', ['種別(今日)','決済','判定可','理論の的中','板の的中'], kinds.map(([k,m])=>[k, m.n, m.judged, fmt.pct(m.judged?m.theoRight/m.judged:null), fmt.pct(m.judged?m.midRight/m.judged:null)]));
  barChart('edge', s.edgeLabels, [ {label:'秒数',data:today.edge,backgroundColor:css('--s1')} ]);
  const mx24 = Math.max(...s.lead24.topByPnl.map(r=>Math.abs(r.pnl)), 0);
  table('lead24', ['アドレス','損益','約定','勝率','名目','テイカー','買YES','買NO','売','満期前'], s.lead24.topByPnl.map(r=>[who(r), pnlCell(r.pnl,mx24), r.n, fmt.pct(r.winRate), '$'+fmt.n(r.notional), fmt.pct(r.takerRate), fmt.pct(r.buyYesRate), fmt.pct(r.buyNoRate), fmt.pct(r.sellRate), r.avgSecToExpiry===null?'-':Math.round(r.avgSecToExpiry)+'s']));
  const mx7 = Math.max(...s.lead7.byConsistency.map(r=>Math.abs(r.pnl)), 0);
  table('lead7', ['アドレス','Top10入り','損益7日','約定','勝率','テイカー','買YES','買NO','売','満期前'], s.lead7.byConsistency.map(r=>[who(r), r.daysTop10+'/'+r.days+'日', pnlCell(r.pnl,mx7), r.n, fmt.pct(r.winRate), fmt.pct(r.takerRate), fmt.pct(r.buyYesRate), fmt.pct(r.buyNoRate), fmt.pct(r.sellRate), r.avgSecToExpiry===null?'-':Math.round(r.avgSecToExpiry)+'s']));
  table('markets', ['市場','行使価格','現在値','残り','理論','買値','売値','乖離(買YES)','乖離(売YES)'], s.markets.map(m=>[m.slug.replace(/-up-or-down-/,' ').replace(/-\\d+$/,''), fmt.n(m.K,2), m.S===null?'-':fmt.n(m.S,2)+' ('+(m.src??'')+')', m.tauSec===null?'-':Math.floor(m.tauSec/60)+'分'+(m.tauSec%60)+'秒', m.pTheo===null?'-':m.pTheo.toFixed(3), m.bid??'-', m.ask??'-', m.edgeBuyYes===null?'-':el('span',{class:m.edgeBuyYes>0.02?'up':''},(m.edgeBuyYes*100).toFixed(1)+'¢'), m.edgeSellYes===null?'-':el('span',{class:m.edgeSellYes>0.02?'up':''},(m.edgeSellYes*100).toFixed(1)+'¢')]));
  table('recent', ['時刻','市場','結果','始値','寄付乖離','理論5s','板5s','理論','板'], s.recentSummaries.map(r=>[fmt.t(r.t), (r.slug||'').replace(/-up-or-down-/,' ').replace(/-\\d+$/,''), el('span',{class:r.up===1?'up':r.up===0?'dn':''}, r.up===1?'Up':r.up===0?'Down':'?'), fmt.n(r.K,2), r.gapBps===null?'-':fmt.n(r.gapBps,1)+'bps', r.theo5===null?'-':r.theo5.toFixed(3), r.mid5===null?'-':r.mid5.toFixed(3), r.theoRight===null?'-':el('span',{class:r.theoRight?'ok up':'ng dn'},''), r.midRight===null?'-':el('span',{class:r.midRight?'ok up':'ng dn'},'')]));
  table('fills', ['時刻','アドレス','役割','側','市場','価格','枚数','満期前','損益'], s.recentFills.map(f=>[fmt.t(f.t), who({owner:f.owner,name:f.name}), f.role==='taker'?'テイカー':'メイカー', (f.side==='BUY'?'買':'売')+' '+f.outcome, (f.slug||'').replace(/-up-or-down-/,' ').replace(/-\\d+$/,''), f.price===null?'-':f.price.toFixed(3), fmt.n(f.shares,1), f.secToExpiry===null?'-':f.secToExpiry+'s', f.pnl===null?el('span',{class:'tag'},'未確定'):el('span',{class:f.pnl>=0?'up':'dn'},fmt.usd(f.pnl))]));
}
refresh(); setInterval(refresh, 30000);
</script>
</body>
</html>`;
