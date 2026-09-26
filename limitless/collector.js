// Limitless Exchange の 1時間 Up/Down 市場を観測するだけのスクリプト。
//
// やること
//   - 毎時の新しい市場(btc/eth-up-or-down-hourly-<開始時刻>)を見つけて、
//     始値(openPrice)・板・オラクル価格を JSONL に貯める
//   - 参照価格から理論価格 p = Φ(ln(S/K) / (σ√τ)) を毎秒計算し、板との乖離を記録する
//   - 市場が決済されるたびに「寄り付きの乖離 → 板 → 理論価格 → 結果」を1行で出す
//
// やらないこと
//   - 注文は一切出さない。APIキーも秘密鍵も要らない(公開チャネルのみ)
//
// 入力は全て環境変数。秘密情報は無い。
//   LIMITLESS_API_URL   既定 https://api.limitless.exchange
//   LIMITLESS_WS_URL    既定 wss://ws.limitless.exchange
//   DATA_DIR            JSONL の保存先。既定 ./data (Railway では Volume を /data に付けて指定)
//   ASSETS              既定 btc,eth
//   HOURLY_SLUG_PATTERN 既定 ^(btc|eth)-up-or-down-(hourly-p|hourly|\d+-min)-(\d+)$ (ASSETS から生成)
//                       2026年9月25日の実測: 1時間市場は -hourly-p-<ミリ秒>、5分/15分市場は -5-min-<秒>
//   BOOK_DEPTH          板を何段まで記録するか。既定 5
//   THEO_INTERVAL_MS    理論価格の記録間隔。既定 1000
//   DISCOVER_INTERVAL_MS 新市場の探索間隔。既定 60000
//   SIGMA_FALLBACK_1H   σの推定材料が足りない時の1時間σ。既定 0.0045 (=0.45%)
//   PYTH_HERMES_URL     既定は無効(2026年9月25日に401=キー必須になっていた)。URLを入れると有効
//   BINANCE_WS_URL      既定 wss://data-stream.binance.vision/stream (空文字で無効化)
//   KEEP_DAYS           JSONL を何日分残すか。既定 14(前日分は gzip される)
//   MIN_FREE_MB         空き容量がこれを下回ったら記録を止める。既定 50
//   BASE_RPC_URL        Base の RPC。設定するとオンチェーンの約定(誰が・いつ・いくらで)を読む。未設定なら読まない
//   EVENTS_INTERVAL_MS  公開の市場イベント(/markets/{slug}/events)の取得間隔。既定 20000。0 で無効
//   LATENCY_PROBE_MS    HTTP往復の計測間隔。既定 15000
//   PORT                ダッシュボードの待受ポート。既定 8080(Railway のドメインは 8080 に向けてある)
//   DASHBOARD_TOKEN     設定すると画面に ?token=… が要る。未設定なら誰でも見られる(読み取り専用)

import { io } from 'socket.io-client';
import WebSocket from 'ws';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { LatencyStats } from './latency.js';
import { startChainWatcher, decodeOrderFilled, TOPICS, CONTRACTS } from './onchain.js';
import { FillLedger, formatLeader } from './ledger.js';
import { Stats, EDGE_LABELS } from './stats.js';
import { startServer } from './server.js';
import { runBacktest, formatBacktest } from './backtest.js';
import { EndgameMaker, twapProb } from './endgame.js';
import { PairMaker } from './pair.js';

const env = (k, d) => (process.env[k] === undefined || process.env[k] === '' ? d : process.env[k]);
const API_URL = env('LIMITLESS_API_URL', 'https://api.limitless.exchange').replace(/\/$/, '');
const WS_URL = env('LIMITLESS_WS_URL', 'wss://ws.limitless.exchange').replace(/\/$/, '');
let DATA_DIR = env('DATA_DIR', path.resolve('data'));
// 2026年9月26日: XRP・SOL・DOGE・BNB を追加(1時間市場のみ。slug の接頭辞そのまま: solana / doge)
const ASSETS = env('ASSETS', 'btc,eth,xrp,solana,doge,bnb').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
// 1群=資産, 2群=種別(hourly-p / hourly / 5-min …), 3群=slugの数字(秒でもミリ秒でも可)
const SLUG_RE = new RegExp(env('HOURLY_SLUG_PATTERN', `^(${ASSETS.join('|')})-up-or-down-(hourly-p|hourly|\\d+-min)-(\\d+)$`));
const BOOK_DEPTH = Number(env('BOOK_DEPTH', 5));
const THEO_INTERVAL_MS = Number(env('THEO_INTERVAL_MS', 1000));
const DISCOVER_INTERVAL_MS = Number(env('DISCOVER_INTERVAL_MS', 60000));
const SIGMA_FALLBACK_1H = Number(env('SIGMA_FALLBACK_1H', 0.0045));
// PYTH_HERMES_URL / BINANCE_WS_URL は「未設定なら既定、空文字なら無効」にしたいので env() を通さない
// 2026年9月25日の実測で Hermes は 401(キー必須)を返したので既定は無効。決済値は Limitless の oraclePriceData から取れる
const PYTH_HERMES_URL = process.env.PYTH_HERMES_URL ?? '';
const BINANCE_WS_URL = process.env.BINANCE_WS_URL === undefined ? 'wss://data-stream.binance.vision/stream' : process.env.BINANCE_WS_URL;

// Pyth の本番フィードID(市場の priceOracleMetadata.pythAddress が取れればそちらを優先)
const PYTH_FEED_IDS = {
  btc: 'e62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43',
  eth: 'ff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace',
};
const BINANCE_SYMBOLS = { btc: 'btcusdt', eth: 'ethusdt', xrp: 'xrpusdt', solana: 'solusdt', doge: 'dogeusdt', bnb: 'bnbusdt' };
// cex 行を JSONL に残す資産(検証で使う BTC/ETH だけ。容量節約)
const CEX_LOG_ASSETS = new Set(['btc', 'eth']);

// 参照価格の鮮度。これより古い価格は理論価格に使わない
const REF_STALE_MS = 5000;
// σのEWMA半減期(秒)と、推定を信用するまでの最小サンプル数
const SIGMA_HALFLIFE_SEC = 600;
const SIGMA_MIN_SAMPLES = 120;
const SIGMA_CLAMP = [0.0015, 0.02];
// 寄り付き後、何秒時点の板と理論価格を要約に残すか
const OPEN_SNAPSHOT_OFFSETS_SEC = [5, 30, 120];

// ---------------------------------------------------------------- 数学
import { normCdf, theoUp } from './math.js';
export { normCdf, theoUp };

// 1秒足の対数収益率から EWMA で1時間σを推定する
export class SigmaEstimator {
  constructor(halflifeSec = SIGMA_HALFLIFE_SEC) {
    this.lambda = Math.exp(-Math.LN2 / halflifeSec);
    this.varSec = null;
    this.n = 0;
    this.lastSec = null;
    this.lastPrice = null;
    this.bucketPrice = null;
  }
  push(price, tMs) {
    if (!(price > 0)) return;
    const sec = Math.floor(tMs / 1000);
    if (this.lastSec === null) {
      this.lastSec = sec;
      this.bucketPrice = price;
      return;
    }
    if (sec === this.lastSec) {
      this.bucketPrice = price;
      return;
    }
    // 秒が変わった: 閉じた秒の終値と、その前に閉じた秒の終値で収益率を作る(空いた秒は経過秒で割る)
    const close = this.bucketPrice;
    if (this.lastPrice !== null) {
      const dt = sec - this.lastSec;
      const r = Math.log(close / this.lastPrice);
      const r2PerSec = (r * r) / dt;
      // 立ち上がりは単純平均、十分たまったら EWMA
      this.varSec = this.varSec === null ? r2PerSec
        : this.n < SIGMA_MIN_SAMPLES ? (this.varSec * this.n + r2PerSec) / (this.n + 1)
        : this.lambda * this.varSec + (1 - this.lambda) * r2PerSec;
      this.n += 1;
    }
    this.lastPrice = close;
    this.lastSec = sec;
    this.bucketPrice = price;
  }
  sigma1h() {
    if (this.varSec === null || this.n < SIGMA_MIN_SAMPLES) return null;
    const s = Math.sqrt(this.varSec * 3600);
    return Math.min(SIGMA_CLAMP[1], Math.max(SIGMA_CLAMP[0], s));
  }
}

// ---------------------------------------------------------------- 記録
const counts = {};
let stream = null;
let streamDate = null;
const KEEP_DAYS = Number(env('KEEP_DAYS', 7)); // 500MB の Volume に収めるため7日(9/26に14から変更)
const MIN_FREE_MB = Number(env('MIN_FREE_MB', 50));
const BASE_RPC_URL = process.env.BASE_RPC_URL ?? '';
const EVENTS_INTERVAL_MS = Number(env('EVENTS_INTERVAL_MS', 20000));
const LATENCY_PROBE_MS = Number(env('LATENCY_PROBE_MS', 15000));
const latency = new LatencyStats();
const ledger = new FillLedger({ exchangeAddresses: CONTRACTS.exchanges });
const LEADER_REPORT_MS = Number(env('LEADER_REPORT_MS', 3600000));
// 終盤メイカー(紙上)。ENDGAME=off で止める。実際の注文は出さない
const ENDGAME = (process.env.ENDGAME ?? 'paper').toLowerCase();
const endgame = new EndgameMaker({ dataDir: DATA_DIR, writeRow: (t, o) => writeRow(t, o), exchangeAddresses: CONTRACTS.exchanges });
const LEDGER_FILE = path.join(DATA_DIR, 'ledger.json');
// 両側買い(紙上)。PAIR=off で止める
const PAIR = (process.env.PAIR ?? 'paper').toLowerCase();
const pair = new PairMaker({ dataDir: DATA_DIR, writeRow: (t, o) => writeRow(t, o), exchangeAddresses: CONTRACTS.exchanges });
const minSizeLogged = new Set();
// 測り方の点検(30分ごと)。チェーンの約定がどれだけ遅れて届いているか等
const AUDIT_INTERVAL_MS = Number(env('AUDIT_INTERVAL_MS', 30 * 60000));
let auditWin = { chainFills: 0, ingestLagMax: 0, ingestLagSum: 0 };
let zeroSumWarnedAt = 0;
const PORT = Number(env('PORT', 8080));
const DASHBOARD_TOKEN = process.env.DASHBOARD_TOKEN ?? '';
const stats = new Stats({ dataDir: DATA_DIR, keepDays: 14 });
const BACKTEST_INTERVAL_MS = Number(env('BACKTEST_INTERVAL_MS', 3600000));
const BACKTEST_DAYS = Number(env('BACKTEST_DAYS', 3));
const BACKTEST_RECENT_HOURS = Number(env('BACKTEST_RECENT_HOURS', 2));
let lastBacktestRecent = null;
let lastBacktest = null;
let lowDiskWarnedAt = 0;
// 前日分を gzip し、KEEP_DAYS より古いファイルを消す(失敗しても記録は止めない)
function rotateFiles(prevDate) {
  try {
    if (prevDate) {
      const src = path.join(DATA_DIR, `${prevDate}.jsonl`);
      if (fs.existsSync(src)) {
        const gz = zlib.createGzip();
        fs.createReadStream(src).pipe(gz).pipe(fs.createWriteStream(`${src}.gz`)).on('finish', () => fs.unlink(src, () => {}));
      }
    }
    const cutoff = Date.now() - KEEP_DAYS * 86400000;
    for (const f of fs.readdirSync(DATA_DIR)) {
      const mm = /^(\d{4}-\d{2}-\d{2})\.jsonl(\.gz)?$/.exec(f);
      if (mm && Date.parse(mm[1]) < cutoff) fs.unlink(path.join(DATA_DIR, f), () => {});
    }
  } catch (e) {
    console.error('[ファイル整理失敗]', e.message);
  }
}
function diskOk() {
  try {
    const st = fs.statfsSync(DATA_DIR);
    const freeMb = (st.bavail * st.bsize) / 1048576;
    if (freeMb >= MIN_FREE_MB) return true;
    if (Date.now() - lowDiskWarnedAt > 5 * 60000) { lowDiskWarnedAt = Date.now(); console.error(`[空き容量不足] ${freeMb.toFixed(0)}MB。記録を止めている(ログ出力は続く)`); }
    return false;
  } catch { return true; }
}
function ensureStream() {
  const d = new Date().toISOString().slice(0, 10);
  if (stream && streamDate === d) return stream;
  if (stream) stream.end();
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const prev = streamDate;
  stream = fs.createWriteStream(path.join(DATA_DIR, `${d}.jsonl`), { flags: 'a' });
  streamDate = d;
  rotateFiles(prev);
  return stream;
}
const errorLastShown = new Map();
function writeRow(type, obj) {
  counts[type] = (counts[type] || 0) + 1;
  const row = { t: Date.now(), type, ...obj };
  if (type === 'error') {
    const last = errorLastShown.get(obj.where) ?? 0;
    if (row.t - last > 5 * 60000) { errorLastShown.set(obj.where, row.t); console.error(`[エラー] ${obj.where}: ${obj.msg}`); }
  }
  try { stats.onRow(type, row); } catch (e) { console.error('[集計失敗]', e.message); }
  try {
    if (diskOk()) ensureStream().write(JSON.stringify(row) + '\n');
  } catch (e) {
    console.error('[記録失敗]', e.message);
  }
  return row;
}
// 受信形式の確認用に、イベント種別ごとに最初の1件だけ生データを残す
const seenRaw = new Set();
function logRawOnce(key, payload) {
  if (seenRaw.has(key)) return;
  seenRaw.add(key);
  let s;
  try { s = JSON.stringify(payload); } catch { s = String(payload); }
  writeRow('raw_sample', { key, sample: s.slice(0, 4000) });
  console.log(`[生データ] ${key}: ${s.slice(0, 300)}`);
}
function normTs(v) {
  // 秒でもミリ秒でもISO文字列でも、ミリ秒に揃える
  if (v === null || v === undefined) return null;
  if (typeof v === 'string' && !/^\d+$/.test(v)) {
    const ms = Date.parse(v);
    return Number.isFinite(ms) ? ms : null;
  }
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  return n < 1e12 ? n * 1000 : n;
}

// ---------------------------------------------------------------- 状態
// asset -> 参照価格と σ
const refs = Object.fromEntries(ASSETS.map((a) => [a, {
  lmts: null, pyth: null, cex: null, // { price, t }  lmts は Limitless の oraclePriceData(発行元は lmtsSource)
  lmtsSource: null,
  sigma: new SigmaEstimator(), // Binance の約定だけから作る。TWAPを混ぜると基差が偽の収益率になる
  cexLastLogSec: 0,
  secs: new Map(), // 秒 -> その秒の最後の Binance 約定(直近180秒)。TWAPモデル用
}]));
// slug -> 市場
const markets = new Map();
// tokenId -> { slug, outcome }、conditionId -> slug(オンチェーンの約定を市場に結びつける)。決済後も当日中は残す
const tokenIndex = new Map();
const conditionIndex = new Map();
function resolveToken(tokenId) {
  const hit = tokenIndex.get(String(tokenId));
  if (!hit) return null;
  const m = markets.get(hit.slug);
  return { slug: hit.slug, outcome: hit.outcome, kind: m?.kind ?? hit.kind ?? null, expiryTs: m?.expiryTs ?? hit.expiryTs ?? null, openPrice: m?.openPrice ?? null };
}
function resolveCondition(conditionId) {
  const slug = conditionIndex.get(String(conditionId).toLowerCase());
  if (!slug) return null;
  const m = markets.get(slug);
  return { slug, kind: m?.kind ?? null };
}
let socket = null;

// 市場の種別で参照価格の優先順位を変える。
//   1時間市場は Binance の足が決済そのものなので Binance を最優先
//   5分/15分市場は Chainlink 60秒TWAP が決済なので Limitless のオラクル値を最優先
function pickRef(asset, kind) {
  const r = refs[asset];
  const now = Date.now();
  const order = kind && kind.startsWith('hourly') ? ['cex', 'lmts', 'pyth'] : ['lmts', 'cex', 'pyth'];
  for (const src of order) {
    const v = r[src];
    if (v && now - v.t <= REF_STALE_MS) return { src, ...v };
  }
  return null;
}
function sigmaFor(asset) {
  return refs[asset].sigma.sigma1h() ?? SIGMA_FALLBACK_1H;
}
function bookSummary(m) {
  if (!m.book) return null;
  const bid = m.book.bids[0]?.price ?? null;
  const ask = m.book.asks[0]?.price ?? null;
  const mid = bid !== null && ask !== null ? (bid + ask) / 2 : (bid ?? ask);
  return { bid, ask, mid, bidSize: m.book.bids[0]?.size ?? null, askSize: m.book.asks[0]?.size ?? null };
}

// ---------------------------------------------------------------- Limitless REST
async function getJson(pathname, latencyKey = null) {
  const t0 = Date.now();
  const res = await fetch(API_URL + pathname, { headers: { accept: 'application/json' } });
  if (latencyKey) latency.push(latencyKey, Date.now() - t0);
  if (!res.ok) throw new Error(`${res.status} ${pathname}`);
  return res.json();
}
// 「注文を送れる速さ」の代理指標: 板の取得(小さいGET)の往復時間を定期的に測る。
// 注文APIは署名付きPOSTなので実測はもう少し遅くなるが、ネットワーク距離はこれで分かる
async function latencyProbe() {
  const m = [...markets.values()].find((x) => !x.resolved);
  if (!m) return;
  try { await getJson(`/markets/${m.slug}/orderbook`, 'http_orderbook'); } catch (e) { writeRow('error', { where: 'latencyProbe', msg: e.message }); }
}
// 公開の市場イベント(ORDER_PLACED 等)。誰が・どんな注文を出したかが取れるかは中身次第なので、まず生で貯める
const seenEventIds = new Map(); // slug -> Set
async function pollMarketEvents() {
  for (const m of markets.values()) {
    if (m.resolved) continue;
    try {
      const res = await getJson(`/markets/${m.slug}/events?page=1&limit=50`, 'http_events');
      const events = Array.isArray(res?.events) ? res.events : Array.isArray(res) ? res : [];
      if (events.length) {
        if (!seenRaw.has('rest:events:full')) console.log(`[生データ] rest:events 1件全文: ${JSON.stringify(events[0]).slice(0, 1500)}`);
        logRawOnce('rest:events:full', events[0]);
      }
      const seen = seenEventIds.get(m.slug) ?? new Set();
      for (const ev of events) {
        const key = ev?.id ?? `${ev?.type}:${ev?.timestamp}:${JSON.stringify(ev?.data ?? {}).slice(0, 80)}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const kind = ev?.type ?? ev?.eventType ?? ev?.kind ?? null;
        writeRow('mevent', { slug: m.slug, id: ev?.id ?? null, kind, srcTs: normTs(ev?.timestamp ?? ev?.createdAt), data: ev?.data ?? ev });
        ledger.setName(ev?.profile?.account ?? ev?.data?.profile?.account, ev?.profile?.username ?? ev?.data?.profile?.username);
      }
      seenEventIds.set(m.slug, seen);
    } catch (e) {
      writeRow('error', { where: 'marketEvents', msg: e.message });
    }
  }
  for (const slug of seenEventIds.keys()) if (!markets.has(slug)) seenEventIds.delete(slug);
}

// 種別文字列から市場の長さ(秒)を出す。hourly-p / hourly → 3600、5-min → 300
export function durationSecOf(kind) {
  if (!kind) return null;
  if (kind.startsWith('hourly')) return 3600;
  const mm = /^(\d+)-min$/.exec(kind);
  return mm ? Number(mm[1]) * 60 : null;
}

// 市場JSONの「どこに行使価格があるか」を突き止めるため、種別ごとに1回だけ
// キー一覧・価格らしきフィールド・説明文(HTMLを剥がしたもの)をログに出す
const describedKinds = new Set();
function describeMarketOnce(kind, raw) {
  if (describedKinds.has(kind)) return;
  describedKinds.add(kind);
  const keys = Object.keys(raw ?? {});
  const priceLike = {};
  const walk = (o, prefix, depth) => {
    if (!o || typeof o !== 'object' || depth > 2) return;
    for (const [k, v] of Object.entries(o)) {
      const name = prefix ? `${prefix}.${k}` : k;
      if (/price|open|strike|start|twap|oracle|settle|resol|deadline|expir|created|window/i.test(k) && (typeof v !== 'object' || v === null)) priceLike[name] = v;
      else if (v && typeof v === 'object' && !Array.isArray(v)) walk(v, name, depth + 1);
    }
  };
  walk(raw, '', 0);
  const desc = String(raw?.description ?? '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 1200);
  console.log(`[市場JSON:${kind}] keys=${keys.join(',')}`);
  console.log(`[市場JSON:${kind}] 価格らしき項目=${JSON.stringify(priceLike)}`);
  console.log(`[市場JSON:${kind}] 説明=${desc}`);
  writeRow('market_shape', { kind, keys, priceLike, description: desc });
}

function parseMarket(slug, raw) {
  const m = SLUG_RE.exec(slug);
  const asset = m ? m[1].toLowerCase() : null;
  const kind = m ? m[2] : null;
  const durationSec = durationSecOf(kind);
  const slugTs = m && m[3] ? normTs(m[3]) : null;
  const expiry = normTs(raw.expirationTimestamp) ?? normTs(raw.deadline) ?? normTs(raw.expirationDate)
    ?? (slugTs && durationSec ? slugTs + durationSec * 1000 : null);
  // 開始時刻は slug の数字に頼らず「満期 − 長さ」から出す(-p- 市場の数字は作成時刻で、時刻に揃っていない)
  // 2026年9月25日の実測: 行使価格は metadata.openPrice(文字列)、開始時刻は startAt
  const openRaw = raw.openPrice ?? raw.metadata?.openPrice;
  const openPrice = openRaw !== undefined && openRaw !== null && openRaw !== '' ? Number(openRaw) : null;
  const startTs = normTs(raw.startAt) ?? normTs(raw.metadata?.openPriceCapturedAt);
  const pythId = typeof raw.priceOracleMetadata?.pythAddress === 'string' ? raw.priceOracleMetadata.pythAddress.replace(/^0x/, '').toLowerCase() : null;
  const desc = String(raw.description ?? '');
  const resolutionSource = raw.metadata?.chainlinkDataStream
    ? `chainlink_twap${raw.metadata.chainlinkDataStream.twapWindowSeconds ?? ''}s`
    : /binance/i.test(desc) ? 'binance_candle' : /pyth/i.test(desc) ? 'pyth' : /chainlink/i.test(desc) ? 'chainlink' : null;
  // 開始時刻は startAt を最優先。無ければ「満期 − 長さ」(-p- 市場の slug の数字は作成時刻で、時刻に揃っていない)
  const openTs = startTs ?? (expiry && durationSec ? expiry - durationSec * 1000 : slugTs);
  return {
    asset,
    kind,
    durationSec,
    openTs,
    expiryTs: expiry,
    openPrice: Number.isFinite(openPrice) ? openPrice : null,
    resolutionSource,
    tieRule: 'up', // 実測: どちらの種別も「以上(≥)で Up」
    pythId,
    status: raw.status ?? null,
    tradeType: raw.tradeType ?? raw.marketType ?? null,
    winningIndex: raw.winning_index ?? raw.winningIndex ?? null,
    settings: raw.settings ?? null,
    oracle: raw.priceOracleMetadata ?? null,
    title: raw.title ?? null,
  };
}

async function addMarket(slug, via) {
  if (markets.has(slug)) return;
  const m = {
    slug, via, asset: null, openTs: null, expiryTs: null, openPrice: null, pythId: null,
    book: null, bookTs: null, resolved: null, snapshots: {}, fetchTries: 0, lastTheo: null,
    discoveredAt: Date.now(),
  };
  markets.set(slug, m);
  await refreshMarket(m);
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const ob = await getJson(`/markets/${slug}/orderbook`);
      logRawOnce('rest:orderbook', ob);
      applyBook(m, ob, 'rest');
      break;
    } catch (e) {
      // 作成直後は板がまだ無く 404 になるので、3秒おいて1回だけ取り直す
      if (attempt === 0 && /404/.test(e.message)) { await sleep(3000); continue; }
      writeRow('error', { where: 'orderbook', slug, msg: e.message });
    }
  }
  subscribePrices();
  console.log(`[市場] 発見 ${slug} (${via}) 始値=${m.openPrice ?? '未確定'} 満期=${m.expiryTs ? new Date(m.expiryTs).toISOString() : '不明'}`);
}

async function refreshMarket(m) {
  m.fetchTries += 1;
  try {
    const raw = await getJson(`/markets/${m.slug}`);
    logRawOnce('rest:market', raw);
    const p = parseMarket(m.slug, raw);
    describeMarketOnce(p.kind ?? 'unknown', raw);
    const openPriceWasNull = m.openPrice === null;
    if (p.settings) m.settings = p.settings;
    Object.assign(m, { asset: p.asset ?? m.asset, kind: p.kind ?? m.kind, openTs: p.openTs ?? m.openTs, expiryTs: p.expiryTs ?? m.expiryTs, pythId: p.pythId ?? m.pythId, status: p.status, winningIndex: p.winningIndex, resolutionSource: p.resolutionSource ?? m.resolutionSource });
    if (p.openPrice !== null) { m.openPrice = p.openPrice; m.openPriceSrc = 'api'; }
    // オンチェーンの約定を市場に結びつけるための索引
    const yes = raw.tokens?.yes ?? raw.outcomeTokens?.[0] ?? null;
    const no = raw.tokens?.no ?? raw.outcomeTokens?.[1] ?? null;
    if (yes) tokenIndex.set(String(yes), { slug: m.slug, outcome: 'YES', kind: m.kind, expiryTs: m.expiryTs });
    if (no) tokenIndex.set(String(no), { slug: m.slug, outcome: 'NO', kind: m.kind, expiryTs: m.expiryTs });
    if (raw.conditionId) { m.conditionId = String(raw.conditionId).toLowerCase(); conditionIndex.set(m.conditionId, m.slug); }
    writeRow('market', { slug: m.slug, ...p, tokens: raw.tokens ?? null, conditionId: raw.conditionId ?? null, venue: raw.venue ?? null });
    if (openPriceWasNull && m.openPrice !== null) console.log(`[市場] ${m.slug} 始値確定 ${m.openPrice}`);
    if (m.asset && m.pythId && !PYTH_FEED_IDS[m.asset]) PYTH_FEED_IDS[m.asset] = m.pythId;
  } catch (e) {
    writeRow('error', { where: 'market', slug: m.slug, msg: e.message });
  }
}

function applyBook(m, ob, src) {
  const book = ob?.orderbook ?? ob;
  if (!book || !Array.isArray(book.bids) || !Array.isArray(book.asks)) return;
  const norm = (arr, desc) => arr
    .map((e) => ({ price: Number(e.price), size: Number(e.size) }))
    .filter((e) => Number.isFinite(e.price))
    .sort((a, b) => (desc ? b.price - a.price : a.price - b.price));
  m.book = { bids: norm(book.bids, true), asks: norm(book.asks, false), tokenId: book.tokenId ?? null };
  m.bookTs = Date.now();
  if (book.minSize !== undefined && book.minSize !== null) {
    m.minSize = book.minSize;
    const k = m.kind ?? '?';
    if (!minSizeLogged.has(k)) {
      minSizeLogged.add(k);
      const raw = Number(book.minSize);
      console.log(`[最低枚数] ${k}: 板の minSize=${book.minSize}(1e6単位なら ${Number.isFinite(raw) ? raw / 1e6 : '-'} 枚)/ 市場設定の minSize=${m.settings?.minSize ?? '-'} / maxSpread=${book.maxSpread ?? '-'}`);
      writeRow('min_size', { kind: k, slug: m.slug, bookMinSize: book.minSize, settingsMinSize: m.settings?.minSize ?? null, maxSpread: book.maxSpread ?? null });
    }
  }
  // 記録は市場ごとに秒1回まで(メモリ上の板は毎回更新する)
  if (src === 'ws' && m.bookLogTs && m.bookTs - m.bookLogTs < 1000) return;
  m.bookLogTs = m.bookTs;
  writeRow('book', {
    slug: m.slug, src,
    bids: m.book.bids.slice(0, BOOK_DEPTH), asks: m.book.asks.slice(0, BOOK_DEPTH),
    adjustedMidpoint: book.adjustedMidpoint ?? null, lastTradePrice: book.lastTradePrice ?? null,
    maxSpread: book.maxSpread ?? null, minSize: book.minSize ?? null,
    srcTs: normTs(ob?.timestamp),
  });
}

async function discover() {
  let list;
  try {
    list = await getJson('/markets/active/slugs', 'http_active_slugs');
  } catch (e) {
    writeRow('error', { where: 'discover', msg: e.message });
    return;
  }
  logRawOnce('rest:active-slugs', Array.isArray(list) ? list.slice(0, 3) : list);
  const flat = [];
  for (const item of Array.isArray(list) ? list : []) {
    if (item?.slug) flat.push(item.slug);
    for (const sub of item?.markets ?? []) if (sub?.slug) flat.push(sub.slug);
  }
  let added = false;
  for (const slug of flat) {
    if (SLUG_RE.test(slug)) {
      if (!markets.has(slug)) added = true;
      await addMarket(slug, 'rest');
    } else if (/hourly|up-or-down/i.test(slug)) {
      // 命名規則の確認用。パターンに合わなかった「それっぽい」slugを1回だけ残す
      logRawOnce(`slug:${slug.replace(/\d+/g, 'N')}`, { slug });
    }
  }
  if (!added) subscribePrices();
}

// ---------------------------------------------------------------- Limitless WS (socket.io)
// 購読は毎回「監視中の全 slug」で送る。市場ごとに1件ずつ送ると、サーバーが上書き型の場合に
// 古い市場の板が更新されなくなる(2026年9月25日、板の鮮度が平均4〜5分になっていた原因の疑い)
function subscribePrices() {
  if (!socket?.connected) return;
  const slugs = [...markets.values()].filter((m) => !m.resolved).map((m) => m.slug);
  if (slugs.length === 0) return;
  socket.emit('subscribe_market_prices', { marketSlugs: slugs });
}
function connectLimitlessWs() {
  socket = io(WS_URL + '/markets', {
    transports: ['websocket'],
    reconnection: true,
    reconnectionDelay: 1000,
    reconnectionDelayMax: 30000,
    randomizationFactor: 0.2,
    timeout: 20000,
  });
  socket.on('connect', () => {
    console.log('[WS] Limitless 接続');
    writeRow('ws', { ev: 'connect' });
    socket.emit('subscribe_market_lifecycle', {});
    subscribePrices();
  });
  socket.on('disconnect', (reason) => { writeRow('ws', { ev: 'disconnect', reason }); console.log('[WS] Limitless 切断', reason); });
  socket.on('connect_error', (e) => writeRow('ws', { ev: 'connect_error', msg: e?.message }));
  socket.on('orderbookUpdate', (d) => {
    logRawOnce('ws:orderbookUpdate', d);
    const m = markets.get(d?.marketSlug);
    const st = normTs(d?.timestamp);
    if (st) latency.push('ws_book_lag', Date.now() - st);
    if (m) applyBook(m, d, 'ws');
  });
  socket.on('oraclePriceData', (d) => {
    logRawOnce('ws:oraclePriceData', d);
    const m = markets.get(d?.marketSlug);
    const asset = m?.asset ?? null;
    const price = Number(d?.value);
    const t = normTs(d?.timestamp) ?? Date.now();
    if (Number.isFinite(t)) latency.push('ws_oracle_lag', Date.now() - t);
    writeRow('oracle', { slug: d?.marketSlug ?? null, asset, price, srcTs: t, source: d?.source ?? null, marketAddress: d?.marketAddress ?? null });
    // APIに始値が無い市場: 開始時刻から±15秒以内で最初に届いたオラクル値を行使価格にする
    if (m && m.openPrice === null && m.openTs && Number.isFinite(price) && Math.abs(t - m.openTs) <= 15000) {
      m.openPrice = price;
      m.openPriceSrc = 'oracle_at_open';
      writeRow('open_price', { slug: m.slug, K: price, src: m.openPriceSrc, srcTs: t, offsetMs: t - m.openTs });
      console.log(`[市場] ${m.slug} 行使価格=オラクル開始値 ${price} (開始から${((t - m.openTs) / 1000).toFixed(1)}s)`);
    }
    if (m && Number.isFinite(price)) m.oracle = { v: price, t: Date.now() };
    if (asset && refs[asset] && Number.isFinite(price)) {
      refs[asset].lmts = { price, t: Date.now() };
      refs[asset].lmtsSource = d?.source ?? null;
    }
  });
  socket.on('newPriceData', (d) => logRawOnce('ws:newPriceData', d));
  socket.on('marketCreated', (d) => {
    logRawOnce('ws:marketCreated', d);
    writeRow('lifecycle', { ev: 'created', slug: d?.slug, title: d?.title, kind: d?.type });
    if (d?.slug && SLUG_RE.test(d.slug)) addMarket(d.slug, 'ws').catch((e) => writeRow('error', { where: 'addMarket', msg: e.message }));
  });
  socket.on('marketResolved', (d) => {
    logRawOnce('ws:marketResolved', d);
    writeRow('lifecycle', { ev: 'resolved', slug: d?.slug, winningOutcome: d?.winningOutcome, winningIndex: d?.winningIndex });
    const m = markets.get(d?.slug);
    if (m) finishMarket(m, d?.winningIndex ?? (d?.winningOutcome === 'YES' ? 0 : d?.winningOutcome === 'NO' ? 1 : null), 'ws');
  });
  // 想定外のイベント名を知るため。既知のものは上で処理済み
  const known = new Set(['orderbookUpdate', 'oraclePriceData', 'newPriceData', 'marketCreated', 'marketResolved']);
  socket.onAny((ev, ...args) => { if (!known.has(ev)) logRawOnce(`ws:unknown:${ev}`, args[0]); });
}

// ---------------------------------------------------------------- Pyth Hermes (参照価格の予備)
async function runHermes() {
  if (!PYTH_HERMES_URL) return;
  const idToAsset = () => Object.fromEntries(ASSETS.filter((a) => PYTH_FEED_IDS[a]).map((a) => [PYTH_FEED_IDS[a].toLowerCase(), a]));
  let backoff = 1000;
  for (;;) {
    const map = idToAsset();
    const ids = Object.keys(map);
    if (ids.length === 0) { await sleep(10000); continue; }
    const url = `${PYTH_HERMES_URL.replace(/\/$/, '')}/v2/updates/price/stream?${ids.map((i) => `ids[]=${i}`).join('&')}&parsed=true`;
    try {
      const res = await fetch(url, { headers: { accept: 'text/event-stream' } });
      if (!res.ok || !res.body) throw new Error(`hermes ${res.status}`);
      writeRow('ws', { ev: 'hermes_connect' });
      backoff = 1000;
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let idx;
        while ((idx = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, idx).trim();
          buf = buf.slice(idx + 1);
          if (!line.startsWith('data:')) continue;
          let msg;
          try { msg = JSON.parse(line.slice(5).trim()); } catch { continue; }
          logRawOnce('hermes:update', msg);
          for (const p of msg?.parsed ?? []) {
            const asset = map[String(p?.id ?? '').replace(/^0x/, '').toLowerCase()];
            const pr = p?.price;
            if (!asset || !pr) continue;
            const price = Number(pr.price) * 10 ** Number(pr.expo);
            const t = normTs(pr.publish_time) ?? Date.now();
            if (!Number.isFinite(price)) continue;
            refs[asset].pyth = { price, t: Date.now() };
            writeRow('pyth', { asset, price, srcTs: t, conf: pr.conf !== undefined ? Number(pr.conf) * 10 ** Number(pr.expo) : null });
          }
        }
      }
      writeRow('ws', { ev: 'hermes_end' });
    } catch (e) {
      writeRow('error', { where: 'hermes', msg: e.message });
    }
    await sleep(backoff);
    backoff = Math.min(backoff * 2, 60000);
  }
}

// ---------------------------------------------------------------- Binance 公開ストリーム (CEX参照、σの材料)
function runBinance() {
  if (!BINANCE_WS_URL) return;
  const streams = ASSETS.filter((a) => BINANCE_SYMBOLS[a]).map((a) => `${BINANCE_SYMBOLS[a]}@aggTrade`);
  if (streams.length === 0) return;
  const symToAsset = Object.fromEntries(ASSETS.filter((a) => BINANCE_SYMBOLS[a]).map((a) => [BINANCE_SYMBOLS[a].toUpperCase(), a]));
  let backoff = 1000;
  const connect = () => {
    const ws = new WebSocket(`${BINANCE_WS_URL}?streams=${streams.join('/')}`);
    ws.on('open', () => { backoff = 1000; writeRow('ws', { ev: 'binance_connect' }); });
    ws.on('message', (buf) => {
      let msg;
      try { msg = JSON.parse(buf.toString()); } catch { return; }
      logRawOnce('binance:aggTrade', msg);
      const d = msg?.data ?? msg;
      const asset = symToAsset[d?.s];
      const price = Number(d?.p);
      if (!asset || !Number.isFinite(price)) return;
      const t = normTs(d?.T) ?? Date.now();
      if (d?.E) latency.push('binance_lag', Date.now() - Number(d.E));
      refs[asset].cex = { price, t: Date.now() };
      refs[asset].sigma.push(price, t);
      const secMap = refs[asset].secs;
      const s0 = Math.floor(t / 1000);
      secMap.set(s0, price);
      if (secMap.size > 200) for (const k of secMap.keys()) { if (k < s0 - 180) secMap.delete(k); else break; }
      // 約定は多いので記録は秒に1回まで
      const sec = Math.floor(t / 1000);
      if (sec !== refs[asset].cexLastLogSec && CEX_LOG_ASSETS.has(asset)) {
        refs[asset].cexLastLogSec = sec;
        writeRow('cex', { asset, price, srcTs: t });
      }
    });
    ws.on('close', () => { writeRow('ws', { ev: 'binance_close' }); setTimeout(connect, backoff); backoff = Math.min(backoff * 2, 60000); });
    ws.on('error', (e) => { writeRow('error', { where: 'binance', msg: e.message }); ws.close(); });
  };
  connect();
}

// ---------------------------------------------------------------- 理論価格と要約
function theoTick() {
  const now = Date.now();
  for (const m of markets.values()) {
    if (m.resolved || !m.asset || !m.expiryTs) continue;
    // 始値が無い、またはオラクル開始値で代用中なら、APIの正式値を30秒ごとに取り直す(最大3回)
    if ((m.openPrice === null || m.openPriceSrc === 'oracle_at_open') && m.fetchTries < 3 && now - m.discoveredAt > m.fetchTries * 30000) refreshMarket(m);
    if (m.openPrice === null) continue;
    const ref = pickRef(m.asset, m.kind);
    const tauSec = (m.expiryTs - now) / 1000;
    if (!ref || tauSec < 0) continue;
    // 記録量を抑える: 寄り付き60秒と満期前120秒は毎秒、それ以外は5秒に1回(theo 行の記録だけ。戦略の判定は毎秒)
    const sinceOpen = m.openTs ? (now - m.openTs) / 1000 : Infinity;
    const dense = sinceOpen <= 60 || tauSec <= 120;
    const skipLog = !dense && m.lastTheo && now - m.lastTheo.t < 5000;
    const sigma = sigmaFor(m.asset);
    const th = theoUp(ref.price, m.openPrice, sigma, tauSec);
    const bs = bookSummary(m);
    const cexFresh = refs[m.asset].cex && now - refs[m.asset].cex.t < 5000;
    const isHourly = (m.kind ?? '').startsWith('hourly');
    if (ENDGAME !== 'off' && tauSec <= 150 && cexFresh && (isHourly || (m.oracle && now - m.oracle.t < 5000))) {
      try {
        endgame.onTick({ slug: m.slug, kind: m.kind, model: isHourly ? 'point' : 'twap', tauSec, K: m.openPrice, tw: m.oracle?.v ?? null, secs: refs[m.asset].secs, pNow: refs[m.asset].cex.price, nowSec: Math.floor(now / 1000), sigma1h: sigma, bid: bs?.bid ?? null, ask: bs?.ask ?? null }, now);
      } catch (e) { writeRow('error', { where: 'endgame', msg: e.message }); }
    }
    if (PAIR !== 'off' && th) {
      try {
        // 公正価格は Binance(受信遅れ約56ms)+ Chainlink との基差から。Chainlink だけだと約1.3秒遅れで、古い指値が拾われる
        let pUp = th.p;
        if (!isHourly && cexFresh && m.oracle && now - m.oracle.t < 5000) {
          const tp = twapProb({ tw: m.oracle.v, secs: refs[m.asset].secs, pNow: refs[m.asset].cex.price, nowSec: Math.floor(now / 1000), tauSec, K: m.openPrice, sigma1h: sigma, sigmaMult: 1 });
          if (tp && Number.isFinite(tp.p)) pUp = tp.p;
        }
        pair.onTick({ slug: m.slug, kind: m.kind, tauSec, pUp, bid: bs?.bid ?? null, ask: bs?.ask ?? null }, now);
      } catch (e) { writeRow('error', { where: 'pair', msg: e.message }); }
    }
    if (skipLog) continue;
    const row = {
      t: now, slug: m.slug, kind: m.kind ?? null, S: ref.price, src: ref.src, K: m.openPrice, Ksrc: m.openPriceSrc ?? null, tauSec: Math.round(tauSec),
      sigma1h: sigma, sigmaEst: refs[m.asset].sigma.sigma1h() !== null,
      z: th?.z ?? null, pTheo: th?.p ?? null,
      bid: bs?.bid ?? null, ask: bs?.ask ?? null, mid: bs?.mid ?? null, bidSize: bs?.bidSize ?? null, askSize: bs?.askSize ?? null,
      bookAgeMs: m.bookTs ? now - m.bookTs : null,
      // 正なら「板が理論より安い=YESを買う余地」/「板が理論より高い=YESを売る余地」
      edgeBuyYes: th && bs?.ask !== null && bs?.ask !== undefined ? th.p - bs.ask : null,
      edgeSellYes: th && bs?.bid !== null && bs?.bid !== undefined ? bs.bid - th.p : null,
    };
    m.lastTheo = row;
    writeRow('theo', row);
    // 寄り付き後 N 秒時点の状態を要約用に保存
    if (m.openTs) {
      const since = (now - m.openTs) / 1000;
      for (const off of OPEN_SNAPSHOT_OFFSETS_SEC) {
        // 途中から拾った市場に「寄付5s」として数分後の値が入らないよう、+10秒以内に取れた時だけ記録する
        if (!m.snapshots[off] && since >= off && since <= off + 10) m.snapshots[off] = { S: ref.price, mid: bs?.mid ?? null, pTheo: th?.p ?? null, z: th?.z ?? null, sinceSec: Math.round(since) };
      }
    }
  }
}

// たまった JSONL で案1・案2を検証し、ログと画面に出す
async function backtestOnce() {
  try {
    const rep = await runBacktest({ dataDir: DATA_DIR, days: BACKTEST_DAYS });
    lastBacktest = rep;
    console.log(formatBacktest(rep));
    writeRow('backtest', { days: rep.days, rows: rep.rows, short: rep.short, hourly: rep.hourly });
    // 直近だけ(購読修正の後など、条件が変わった後の姿を見る)
    const recent = await runBacktest({ dataDir: DATA_DIR, days: 1, since: Date.now() - BACKTEST_RECENT_HOURS * 3600000 });
    recent.samples = [];
    lastBacktestRecent = recent;
    console.log(`[検証 直近${BACKTEST_RECENT_HOURS}時間だけ]\n` + formatBacktest(recent));
  } catch (e) {
    writeRow('error', { where: 'backtest', msg: e.message });
  }
}

// 測り方の点検。30分ごとに1行で出し、JSONL の audit 行にも残す
let lastAudit = null;
function audit() {
  const now = Date.now();
  const active = [...markets.values()].filter((m) => !m.resolved && m.expiryTs && m.expiryTs > now);
  const byKind = {};
  let staleBooks = 0, noBook = 0, noK = 0;
  for (const m of active) {
    byKind[m.kind ?? '?'] = (byKind[m.kind ?? '?'] || 0) + 1;
    if (!m.bookTs) noBook++; else if (now - m.bookTs > 30000) staleBooks++;
    if (m.openPrice === null) noK++;
  }
  const L = latency.summary();
  const staleRefs = ASSETS.filter((a) => !refs[a].cex || now - refs[a].cex.t > 10000);
  const eg = ENDGAME !== 'off' ? { ...endgame.diag } : null;
  const pr = PAIR !== 'off' ? { ...pair.diag } : null;
  const warn = [];
  if (auditWin.chainFills === 0) warn.push('チェーンの約定が30分間0件(読み取り停止の疑い)');
  if (auditWin.ingestLagMax > 150000) warn.push(`約定の到着遅れが最大${Math.round(auditWin.ingestLagMax / 1000)}秒(損益確定の待ち180秒に迫る)`);
  if (staleBooks + noBook > active.length / 2) warn.push(`板が古い/無い市場が ${staleBooks + noBook}/${active.length}`);
  if (staleRefs.length) warn.push(`Binance 価格が止まっている: ${staleRefs.join(',')}`);
  if (eg && eg.late > 0) warn.push(`終盤: 損益確定後に届いた約定 ${eg.late}件`);
  if (eg && eg.priceOkOutside > eg.credited && eg.priceOkOutside >= 3) warn.push(`終盤: 値段は合うのに有効時間外の約定 ${eg.priceOkOutside}件(数えた ${eg.credited}件)`);
  if (pr && pr.late > 0) warn.push(`両側: 損益確定後に届いた約定 ${pr.late}件`);
  // 片側だけが多いのは「戦略の成績」であって測り方の誤りではない(上限超えが0なら判定は正しい)。警告ではなく所見として出す
  const notes = [];
  if (pr && pr.oneSided > pr.hedged && pr.oneSided >= 2) notes.push(`両側: 片側だけの市場 ${pr.oneSided} > そろった市場 ${pr.hedged}`);
  if (pr && pr.overLimit > 0) warn.push(`両側: 上限を超えて約定した市場 ${pr.overLimit}(紙上のルール判定が壊れている)`);
  const row = {
    windowMin: Math.round(AUDIT_INTERVAL_MS / 60000), activeMarkets: active.length, byKind, staleBooks, noBook, noK,
    chainFills: auditWin.chainFills, ingestLagAvgSec: auditWin.chainFills ? +(auditWin.ingestLagSum / auditWin.chainFills / 1000).toFixed(1) : null, ingestLagMaxSec: +(auditWin.ingestLagMax / 1000).toFixed(1),
    latency: { http: L.http_orderbook?.p50 ?? null, wsBook: L.ws_book_lag?.p50 ?? null, oracle: L.ws_oracle_lag?.p50 ?? null, binance: L.binance_lag?.p50 ?? null },
    endgame: eg, pair: pr, warn, notes,
  };
  lastAudit = { t: now, ...row };
  writeRow('audit', row);
  console.log(`[点検 ${row.windowMin}分] 市場=${active.length} ${JSON.stringify(byKind)} 板古い/無し=${staleBooks}/${noBook} 行使価格なし=${noK} | チェーン約定=${row.chainFills}件 到着遅れ 平均${row.ingestLagAvgSec ?? '-'}s 最大${row.ingestLagMaxSec}s | 遅延 http=${row.latency.http}ms 板WS=${row.latency.wsBook}ms Binance=${row.latency.binance}ms` +
    (eg ? ` | 終盤 指値=${eg.places} 取消=${eg.cancels} 届いた約定=${eg.tracked} 値段一致=${eg.priceOk} 時間外=${eg.priceOkOutside} 数えた=${eg.credited} 遅着=${eg.late}` : '') +
    (pr ? ` | 両側 新規=${pr.quotes} 置直し=${pr.requotes} 約定=${pr.fills} 規則で除外=${pr.blocked} そろった=${pr.hedged} 片側=${pr.oneSided} 上限超え=${pr.overLimit} 遅着=${pr.late}` : '') +
    ` | 警告: ${warn.length ? warn.join(' / ') : 'なし'}` + (notes.length ? ` | 所見: ${notes.join(' / ')}` : ''));
  auditWin = { chainFills: 0, ingestLagMax: 0, ingestLagSum: 0 };
  if (ENDGAME !== 'off') endgame.resetDiag();
  if (PAIR !== 'off') pair.resetDiag();
}

// 画面(/api/state)に渡す状態
function getState() {
  const now = Date.now();
  const active = [...markets.values()].filter((m) => !m.resolved && m.expiryTs).sort((a, b) => a.expiryTs - b.expiryTs).map((m) => {
    const ref = m.asset ? pickRef(m.asset, m.kind) : null;
    const tauSec = Math.max(0, Math.round((m.expiryTs - now) / 1000));
    const th = ref && m.openPrice !== null ? theoUp(ref.price, m.openPrice, sigmaFor(m.asset), tauSec) : null;
    const bs = bookSummary(m);
    return { slug: m.slug, kind: m.kind, minSize: m.minSize ?? null, K: m.openPrice, S: ref?.price ?? null, src: ref?.src ?? null, tauSec, pTheo: th?.p ?? null, z: th?.z ?? null, bid: bs?.bid ?? null, ask: bs?.ask ?? null,
      edgeBuyYes: th && bs?.ask !== null && bs?.ask !== undefined ? th.p - bs.ask : null, edgeSellYes: th && bs?.bid !== null && bs?.bid !== undefined ? bs.bid - th.p : null };
  });
  const todayKey = new Date().toISOString().slice(0, 10);
  const days = Object.keys(stats.days).sort().slice(-14).map((date) => ({ date, ...stats.days[date], addr: undefined }));
  const today = stats.days[todayKey] ?? { markets: {}, edge: new Array(EDGE_LABELS.length).fill(0), theoRows: 0, fills: 0 };
  return {
    now, startedAt: stats.startedAt, assets: ASSETS, counts,
    latency: latency.summary(), latencyHistory: stats.latency,
    markets: active, days, today: { markets: today.markets, edge: today.edge, theoRows: today.theoRows, fills: today.fills }, edgeLabels: EDGE_LABELS,
    lead24: ledger.report({ hours: 24, top: 15 }), lead7: stats.leaderboard(7, 15, ledger.names),
    recentSummaries: stats.recentSummaries, recentFills: ledger.recent(50),
    sigma: Object.fromEntries(ASSETS.map((a) => [a, refs[a].sigma.sigma1h()])),
    backtest: lastBacktest,
    endgame: ENDGAME !== 'off' ? endgame.summary() : null,
    pair: PAIR !== 'off' ? pair.summary() : null,
    audit: lastAudit,
    backtestRecent: lastBacktestRecent,
  };
}

// 直近24時間で「誰が勝っているか」。損益が確定した約定だけで集計する
function leaderReport() {
  const r = ledger.report({ hours: 24, top: 10 });
  writeRow('leaderboard', r);
  // Railway のログは同一ミリ秒の行の順番が崩れるので、1つの複数行メッセージにまとめる
  const lines = [`[勝者 24h] 確定約定=${r.resolvedFills}件 アドレス=${r.addresses} 合計損益=${r.totalPnl >= 0 ? '+' : ''}$${r.totalPnl.toFixed(2)} 未確定=${r.unresolved}件`];
  r.topByPnl.forEach((x, i) => lines.push('  ' + formatLeader(x, i)));
  if (r.topByVolume.length) lines.push(`[出来高上位 24h] ${r.topByVolume.slice(0, 5).map((x, i) => `#${i + 1} ${x.owner.slice(0, 6)}…${x.name ? `(${x.name})` : ''} $${x.notional.toFixed(0)} 損益${x.pnl >= 0 ? '+' : ''}$${x.pnl.toFixed(0)}`).join(' / ')}`);
  console.log(lines.join('\n'));
}

function finishMarket(m, winningIndex, via) {
  if (m.resolved) return;
  m.resolved = { winningIndex, via, t: Date.now() };
  const up = winningIndex === 0 ? 1 : winningIndex === 1 ? 0 : null; // YES(=0) が Up
  const settled = ledger.resolve(m.slug, up);
  for (const r of settled) stats.onResolvedFill(r);
  if (settled.length) console.log(`[台帳] ${m.slug} の約定${settled.length}件の損益を確定`);
  if (ENDGAME !== 'off') endgame.onResolve(m.slug, up);
  if (PAIR !== 'off') pair.onResolve(m.slug, up);
  // 予測市場は勝ち負けの差し引きがほぼゼロ(手数料分だけ負)。ずれた市場は約定の読み方か取りこぼしを疑う
  if (settled.length) {
    const gap = settled.reduce((a, r) => a + r.pnl + r.fee, 0);
    if (Math.abs(gap) > 0.5) {
      writeRow('zero_sum_gap', { slug: m.slug, gap: +gap.toFixed(4), n: settled.length, fills: settled.slice(0, 40) });
      if (Date.now() - zeroSumWarnedAt > 3600000) { zeroSumWarnedAt = Date.now(); console.log(`[点検] ${m.slug} の損益合計が ${gap.toFixed(2)} ドルずれている(約定${settled.length}件)。JSONL の zero_sum_gap 行に全件を残した`); }
    }
  }
  const s5 = m.snapshots[5] ?? null;
  const openGapBps = s5 && m.openPrice ? Math.log(s5.S / m.openPrice) * 1e4 : null;
  const summary = {
    slug: m.slug, asset: m.asset, kind: m.kind ?? null, resolutionSource: m.resolutionSource ?? null, K: m.openPrice, Ksrc: m.openPriceSrc ?? null, up, via,
    open5s: s5, open30s: m.snapshots[30] ?? null, open120s: m.snapshots[120] ?? null,
    openGapBps,
    // 寄り付き5秒時点の理論価格が正しい側を指していたか
    theo5sRight: s5?.pTheo !== null && s5?.pTheo !== undefined && up !== null ? ((s5.pTheo > 0.5) === (up === 1)) : null,
    mid5sRight: s5?.mid !== null && s5?.mid !== undefined && up !== null ? ((s5.mid > 0.5) === (up === 1)) : null,
    lastTheo: m.lastTheo,
  };
  writeRow('summary', summary);
  const f = (v, d = 3) => (v === null || v === undefined ? '-' : Number(v).toFixed(d));
  console.log(
    `[要約] ${m.slug} 結果=${up === 1 ? 'Up' : up === 0 ? 'Down' : '不明'} 始値=${f(m.openPrice, 2)}(${m.openPriceSrc ?? '-'}) ` +
    `寄付5s: 乖離=${f(openGapBps, 1)}bps z=${f(s5?.z, 2)} 理論=${f(s5?.pTheo)} 板中値=${f(s5?.mid)} ` +
    `| 30s 理論=${f(m.snapshots[30]?.pTheo)} 板=${f(m.snapshots[30]?.mid)} ` +
    `| 理論5sが正解側=${summary.theo5sRight ?? '-'} 板5sが正解側=${summary.mid5sRight ?? '-'}`
  );
}

// 満期を過ぎたのに決済イベントが来ない市場は REST で確認する
async function pollExpired() {
  const now = Date.now();
  for (const m of markets.values()) {
    if (m.resolved || !m.expiryTs || now < m.expiryTs + 120000) continue;
    if (now > m.expiryTs + 45 * 60000) { finishMarket(m, null, 'timeout'); continue; }
    await refreshMarket(m);
    if (m.winningIndex === 0 || m.winningIndex === 1) finishMarket(m, m.winningIndex, 'rest');
  }
  // 決済から1時間経った市場は忘れる
  for (const [slug, m] of markets) if (m.resolved && now - m.resolved.t > 3600000) {
    markets.delete(slug);
    for (const [k, v] of tokenIndex) if (v.slug === slug) tokenIndex.delete(k);
    if (m.conditionId) conditionIndex.delete(m.conditionId);
  }
}

function heartbeat() {
  const active = [...markets.values()].filter((m) => !m.resolved).map((m) => m.slug);
  const refLine = ASSETS.map((a) => {
    const r = pickRef(a);
    const s = refs[a].sigma.sigma1h();
    return `${a}: ${r ? `${r.price.toFixed(1)}(${r.src})` : '参照なし'} σ1h=${s === null ? `推定中(${refs[a].sigma.n}件)` : (s * 100).toFixed(3) + '%'}`;
  }).join(' / ');
  console.log(`[生存] 監視中=${active.length}件 ${active.join(',')} | ${refLine} | 記録=${JSON.stringify(counts)}`);
  console.log(`[遅延] ${latency.format()}`);
  writeRow('heartbeat', { active, counts: { ...counts }, latency: latency.summary() });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- 自己診断(ネットワーク不要)
async function selftest() {
  const near = (a, b, eps) => Math.abs(a - b) <= eps;
  const fails = [];
  if (!near(normCdf(0), 0.5, 1e-9)) fails.push('normCdf(0)');
  if (!near(normCdf(1.959964), 0.975, 1e-4)) fails.push('normCdf(1.96)');
  // docs/limitless-research.md の感度表(σ=40%/年, BTC=100k, 残り5分, Δ=+200 → 94.75%)
  const s1h = 0.40 / Math.sqrt(8760);
  const th = theoUp(100200, 100000, s1h, 300);
  if (!near(th.p, 0.9475, 0.001)) fails.push(`theoUp 5分 Δ200 = ${th.p}`);
  const th2 = theoUp(100000, 100000, s1h, 3600);
  if (!near(th2.p, 0.5, 1e-9)) fails.push('theoUp 始値=現在値');
  // σ推定: 1秒ごとに ±r を交互に入れたら σ1h ≒ |r|·60
  const est = new SigmaEstimator(600);
  let p = 100000;
  const r = 0.0001;
  for (let i = 0; i < 1000; i++) { p *= Math.exp(i % 2 ? r : -r); est.push(p, 1_700_000_000_000 + i * 1000); }
  const s = est.sigma1h();
  if (s === null || !near(s, r * 60, r * 60 * 0.05)) fails.push(`SigmaEstimator = ${s}`);
  if (new SigmaEstimator().sigma1h() !== null) fails.push('σ 初期値は null');
  // slug と時刻
  const m = SLUG_RE.exec('btc-up-or-down-hourly-1785049200');
  if (!m || m[1] !== 'btc' || m[2] !== 'hourly' || Number(m[3]) !== 1785049200) fails.push('SLUG_RE hourly');
  const mp = SLUG_RE.exec('btc-up-or-down-hourly-p-1790291103668');
  if (!mp || mp[2] !== 'hourly-p' || durationSecOf(mp[2]) !== 3600) fails.push('SLUG_RE hourly-p');
  const m5 = SLUG_RE.exec('eth-up-or-down-5-min-1790302500');
  if (!m5 || m5[1] !== 'eth' || m5[2] !== '5-min' || durationSecOf(m5[2]) !== 300) fails.push('SLUG_RE 5-min');
  if (SLUG_RE.test('btc-up-or-down-daily-p-1790255123524') || SLUG_RE.test('dogecoin-up-or-down-daily-p-1790255134152')) fails.push('SLUG_RE 除外');
  if (!SLUG_RE.test('doge-up-or-down-hourly-p-1790291108041') || !SLUG_RE.test('solana-up-or-down-hourly-p-1790291105743') || !SLUG_RE.test('xrp-up-or-down-hourly-p-1790291106736')) fails.push('SLUG_RE 追加資産');
  // -p- 市場: 開始時刻は満期−長さ(slugの数字は使わない)
  const pp = parseMarket('btc-up-or-down-hourly-p-1790291103668', { expirationTimestamp: 1790294400 });
  if (pp.kind !== 'hourly-p' || pp.expiryTs !== 1790294400000 || pp.openTs !== 1790290800000) fails.push(`parseMarket -p- ${JSON.stringify(pp)}`);
  // 5分市場: APIに満期が無くても slug の数字(開始秒)+300秒
  const p5 = parseMarket('eth-up-or-down-5-min-1790302500', {});
  if (p5.durationSec !== 300 || p5.expiryTs !== 1790302800000 || p5.openTs !== 1790302500000) fails.push(`parseMarket 5-min ${JSON.stringify(p5)}`);
  if (normTs(1785049200) !== 1785049200000 || normTs('2026-07-26T07:00:00.000Z') !== 1785049200000) fails.push('normTs');
  // 市場の解釈
  const pm = parseMarket('eth-up-or-down-hourly-1785049200', { openPrice: '3456.78', expirationTimestamp: 1785052800, priceOracleMetadata: { pythAddress: '0xFF61491A931112DDF1BD8147CD1B641375F79F5825126D665480874634FD0ACE' } });
  // 2026年9月25日の実データの形
  const real = parseMarket('btc-up-or-down-15-min-1790302500', { expirationTimestamp: 1790303400000, startAt: '2026-09-25T02:15:00.000Z', metadata: { chainlinkDataStream: { twapWindowSeconds: 60 }, openPrice: '84809.575903638396600320' } });
  if (real.openPrice !== 84809.5759036384 || real.openTs !== 1790302500000 || real.resolutionSource !== 'chainlink_twap60s') fails.push(`parseMarket 実データ ${JSON.stringify(real)}`);
  const realH = parseMarket('btc-up-or-down-hourly-p-1790291103668', { expirationTimestamp: 1790305200000, startAt: '2026-09-25T02:00:00.000Z', description: 'information from Binance, specifically the BTC/USDT pair', metadata: { openPrice: '84610.74' } });
  if (realH.openPrice !== 84610.74 || realH.openTs !== 1790301600000 || realH.resolutionSource !== 'binance_candle') fails.push(`parseMarket 実データ hourly ${JSON.stringify(realH)}`);
  if (pm.asset !== 'eth' || pm.openPrice !== 3456.78 || pm.expiryTs !== 1785052800000 || pm.openTs !== 1785049200000 || pm.pythId !== PYTH_FEED_IDS.eth) fails.push(`parseMarket ${JSON.stringify(pm)}`);
  // 記録: 一時ディレクトリに1行書いて読み戻す
  DATA_DIR = fs.mkdtempSync(path.join(process.env.TMPDIR ?? '/tmp', 'lmts-'));
  const row = writeRow('selftest', { ok: true });
  await new Promise((r) => ensureStream().end(r));
  const back = fs.readFileSync(path.join(DATA_DIR, `${new Date().toISOString().slice(0, 10)}.jsonl`), 'utf8').trim();
  if (JSON.parse(back).t !== row.t) fails.push('writeRow');
  // 遅延統計
  const ls = new LatencyStats();
  for (let i = 1; i <= 100; i++) ls.push('x', i);
  const sm = ls.summary().x;
  if (!sm || sm.n !== 100 || sm.p50 !== 50 || sm.p95 !== 95 || sm.max !== 100) fails.push(`LatencyStats ${JSON.stringify(sm)}`);
  // OrderFilled の decode(maker が USDC 12.5 を出して YES 25枚を買った = 価格 0.50)
  const { AbiCoder, zeroPadValue } = await import('ethers');
  const data = AbiCoder.defaultAbiCoder().encode(['uint256', 'uint256', 'uint256', 'uint256', 'uint256'], [0n, 123n, 12_500_000n, 25_000_000n, 50_000n]);
  const of = decodeOrderFilled({ topics: [TOPICS.OrderFilled, '0x' + '11'.repeat(32), zeroPadValue('0x' + 'ab'.repeat(20), 32), zeroPadValue('0x' + 'cd'.repeat(20), 32)], data });
  if (of.makerSide !== 'BUY' || of.tokenId !== '123' || of.price !== 0.5 || of.shares !== 25 || of.feeUsdc !== 0.05 || !/^0xAbAb/i.test(of.maker)) fails.push(`decodeOrderFilled ${JSON.stringify(of)}`);
  // 台帳: YES を 0.40 で 10枚買い(テイカー)、別人が NO を 0.60 で 10枚買い(メイカー)。Up なら前者 +6、後者 −6
  const lg = new FillLedger({ exchangeAddresses: ['0x05c748E2f4DcDe0ec9Fa8DDc40DE6b867f923fa5'] });
  lg.addFill({ maker: '0xAAAA000000000000000000000000000000000001', taker: '0x05c748E2f4DcDe0ec9Fa8DDc40DE6b867f923fa5', slug: 'm', outcome: 'YES', kind: '5-min', makerSide: 'BUY', price: 0.4, shares: 10, usdc: 4, feeUsdc: 0.02, secToExpiry: 30, blockTime: Date.now() });
  lg.addFill({ maker: '0xBBBB000000000000000000000000000000000002', taker: '0xAAAA000000000000000000000000000000000001', slug: 'm', outcome: 'NO', kind: '5-min', makerSide: 'BUY', price: 0.6, shares: 10, usdc: 6, feeUsdc: 0, secToExpiry: 30, blockTime: Date.now() });
  if (lg.resolve('m', 1).length !== 2) fails.push('ledger resolve');
  const lr = lg.report({ hours: 1, top: 2 });
  const a = lr.topByPnl[0], b = lr.topByPnl[1];
  if (!a || Math.abs(a.pnl - 5.98) > 1e-9 || a.takerRate !== 1 || !b || Math.abs(b.pnl + 6) > 1e-9 || b.takerRate !== 0) fails.push(`ledger report ${JSON.stringify(lr.topByPnl)}`);
  // 集計: 乖離のビン分け、的中率、7日の常連
  const st = new Stats({ dataDir: null });
  st.onRow('theo', { t: Date.now(), edgeBuyYes: 0.03, edgeSellYes: -0.5 });
  st.onRow('theo', { t: Date.now(), edgeBuyYes: -0.2, edgeSellYes: -0.5 });
  st.onRow('summary', { t: Date.now(), kind: '5-min', slug: 'x', up: 1, theo5sRight: true, mid5sRight: false, open5s: { pTheo: 0.6, mid: 0.5 } });
  for (const r of lg.fills) st.onResolvedFill(r);
  const td = st.days[new Date().toISOString().slice(0, 10)];
  if (!td || td.edge[3] !== 1 || td.edge[0] !== 1 || td.markets['5-min']?.theoRight !== 1 || td.markets['5-min']?.midRight !== 0) fails.push(`Stats ${JSON.stringify(td)}`);
  const lb = st.leaderboard(7, 5);
  if (lb.byConsistency[0]?.daysTop10 !== 1 || lb.addresses !== 2) fails.push(`Stats leaderboard ${JSON.stringify(lb)}`);
  // 検証: 5分市場1つ(Up で決済)。満期前30秒に板が 0.90 で、TWAPモデルは ≈1 を出すはず
  {
    const dir = fs.mkdtempSync(path.join(process.env.TMPDIR ?? '/tmp', 'lmts-bt-'));
    const T = 1790000000000; const K = 100000;
    const rowsOut = [];
    rowsOut.push({ t: T - 300000, type: 'market', slug: 'btc-up-or-down-5-min-x', kind: '5-min', asset: 'btc', expiryTs: T, openPrice: K });
    for (let sec = -300; sec <= 0; sec++) rowsOut.push({ t: T + sec * 1000, type: 'cex', asset: 'btc', price: K + 300, srcTs: T + sec * 1000 });
    for (let sec = -120; sec <= 0; sec += 1) rowsOut.push({ t: T + sec * 1000, type: 'oracle', slug: 'btc-up-or-down-5-min-x', asset: 'btc', price: K + 300, srcTs: T + sec * 1000 });
    for (let sec = -120; sec < 0; sec += 1) rowsOut.push({ t: T + sec * 1000, type: 'theo', slug: 'btc-up-or-down-5-min-x', tauSec: -sec, S: K + 300, K, sigma1h: 0.004, pTheo: 0.95, bid: 0.89, ask: 0.9, mid: 0.895 });
    rowsOut.push({ t: T - 20000, type: 'fill', slug: 'btc-up-or-down-5-min-x', outcome: 'YES', makerSide: 'SELL', price: 0.9, shares: 10, blockTime: T - 20000 });
    rowsOut.push({ t: T + 60000, type: 'summary', slug: 'btc-up-or-down-5-min-x', kind: '5-min', up: 1, K });
    fs.writeFileSync(path.join(dir, '2026-01-01.jsonl'), rowsOut.map((r) => JSON.stringify(r)).join('\n') + '\n');
    const rep = await runBacktest({ dataDir: dir, days: 3 });
    const b = rep.short.buckets['30〜10s'];
    if (rep.short.markets !== 1 || !b || b.brierTwap === null || b.brierTwap > 0.001 || b.brierMid < 0.01) fails.push(`backtest ${JSON.stringify(rep.short)}`);
    if (rep.short.taker.twap.n !== 1 || rep.short.taker.twap.pnl < 0.09) fails.push(`backtest taker ${JSON.stringify(rep.short.taker)}`);
    if (rep.short.maker.twap.signals < 1 || rep.short.maker.twap.filled !== rep.short.maker.twap.signals) fails.push(`backtest maker ${JSON.stringify(rep.short.maker)}`);
    formatBacktest(rep);
  }
  // 終盤メイカー(紙上): 5分市場、満期30秒前に Up がほぼ確定。上限 0.96/0.97/0.98 の3通り
  {
    const rowsW = [];
    const eg = new EndgameMaker({ writeRow: (t, o) => rowsW.push({ t, ...o }), exchangeAddresses: ['0x05c748E2f4DcDe0ec9Fa8DDc40DE6b867f923fa5'], opts: { settleDelayMs: 0, latencyMs: 0, sizeUsd: 20 } });
    const T0 = 1790000000; const secs = new Map(); for (let x = T0 - 150; x <= T0; x++) secs.set(x, 100300);
    const now = T0 * 1000;
    eg.onTick({ slug: 'm5', kind: '5-min', tauSec: 30, K: 100000, tw: 100300, secs, pNow: 100300, nowSec: T0, sigma1h: 0.004, bid: 0.95, ask: 0.99 }, now);
    const placed = rowsW.filter((r) => r.ev === 'place').map((r) => r.q).sort();
    if (JSON.stringify(placed) !== JSON.stringify([0.96, 0.97, 0.98])) fails.push(`endgame place ${JSON.stringify(placed)}`);
    // 他人のメイカー「YES 買い」が 0.975 で約定 → 0.98 の指値だけ価格優先で全量
    eg.onFill({ slug: 'm5', outcome: 'YES', makerSide: 'BUY', price: 0.975, shares: 10, maker: '0x1', taker: '0x2', tx: 'a', blockTime: now + 1000 });
    // テイカーが NO を 0.035 で買った(= YES の買い指値 0.965 以下を叩いた)→ 0.97 と 0.98 に待ち行列の半分
    eg.onFill({ slug: 'm5', outcome: 'NO', makerSide: 'BUY', price: 0.035, shares: 8, maker: '0x3', taker: '0x05c748E2f4DcDe0ec9Fa8DDc40DE6b867f923fa5', tx: 'b', blockTime: now + 2000 });
    eg.onResolve('m5', 1, now + 60000);
    await new Promise((r) => setTimeout(r, 10));
    const sm = eg.summary().variants;
    // 0.98: 10 + 4 = 14枚、損益 14×0.02 = 0.28 / 0.97: 4枚、0.12 / 0.96: 約定なし
    if (Math.abs(sm['0.98'].shares - 14) > 1e-9 || Math.abs(sm['0.98'].pnl - 0.28) > 1e-9 || Math.abs(sm['0.97'].shares - 4) > 1e-9 || Math.abs(sm['0.97'].pnl - 0.12) > 1e-9 || sm['0.96'].filledMarkets !== 0) fails.push(`endgame fills ${JSON.stringify(sm)}`);
    // 板が逆を向いていたら置かない
    const eg2 = new EndgameMaker({ writeRow: () => {}, opts: { latencyMs: 0 } });
    eg2.onTick({ slug: 'm6', kind: '5-min', tauSec: 30, K: 100000, tw: 100300, secs, pNow: 100300, nowSec: T0, sigma1h: 0.004, bid: 0.2, ask: 0.3 }, now);
    if (eg2.summary().variants['0.98'].placed !== 0) fails.push('endgame 板と不一致でも置いた');
  }
  // 1時間市場の終盤(point モデル): 満期60秒前、BTC が始値より $300 上、σ=0.3%/h → ほぼ確定なので置く
  {
    const rows = [];
    const eg3 = new EndgameMaker({ writeRow: (t, o) => rows.push(o), opts: { latencyMs: 0 } });
    eg3.onTick({ slug: 'h1', kind: 'hourly-p', model: 'point', tauSec: 60, K: 84000, pNow: 84300, sigma1h: 0.003, bid: 0.95, ask: 0.99 }, 1e12);
    if (rows.filter((r) => r.ev === 'place').length !== 3) fails.push(`endgame hourly ${JSON.stringify(rows)}`);
    const rows2 = [];
    const eg4 = new EndgameMaker({ writeRow: (t, o) => rows2.push(o), opts: { latencyMs: 0 } });
    eg4.onTick({ slug: 'h2', kind: 'hourly-p', model: 'point', tauSec: 60, K: 84000, pNow: 84030, sigma1h: 0.003, bid: 0.7, ask: 0.8 }, 1e12);
    if (rows2.some((r) => r.ev === 'place')) fails.push('endgame hourly 僅差でも置いた');
  }
  // 両側買い: 公正 0.5 → 1本目は YES 0.46 / NO 0.46 に指値
  {
    const pm = new PairMaker({ exchangeAddresses: ['0xEX'], opts: { latencyMs: 0, settleDelayMs: 0 } });
    pm.onTick({ slug: 'p1', kind: '15-min', tauSec: 600, pUp: 0.5, bid: 0.49, ask: 0.51 }, 1000);
    const q0 = pm.mk.get('p1').quotes;
    if (q0.YES?.q !== 0.46 || q0.NO?.q !== 0.46) fails.push(`pair quote ${JSON.stringify(q0)}`);
    // 他人の YES 買い指値が 0.46 で約定 → 同値なので待ち行列の半分(5枚)、1ドル分(2.174枚)で頭打ち
    pm.onFill({ slug: 'p1', outcome: 'YES', makerSide: 'BUY', price: 0.46, shares: 10, taker: '0xT', tx: 'x1', blockTime: 2000 });
    // 価格が動いて公正 0.6 に。YES を持っているので NO は「そろえに行く」値: min(0.4 − 0.01, 1 − 0.02 − 0.46) = 0.39
    pm.onTick({ slug: 'p1', kind: '15-min', tauSec: 500, pUp: 0.6, bid: 0.59, ask: 0.61 }, 3000);
    if (pm.mk.get('p1').quotes.NO?.q !== 0.39) fails.push(`pair requote ${JSON.stringify(pm.mk.get('p1').quotes.NO)}`);
    // YES はもう多いので置かない
    if (pm.mk.get('p1').quotes.YES) fails.push('pair 多い側をまだ買っている');
    // テイカーが NO を売った(0.36)→ NO 0.39 に待ち行列の半分
    pm.onFill({ slug: 'p1', outcome: 'NO', makerSide: 'SELL', price: 0.36, shares: 10, taker: '0xEX', tx: 'x2', blockTime: 4000 });
    pm.onResolve('p1', 0, 5000);
    await new Promise((r) => setTimeout(r, 10));
    const T = pm.summary().totals;
    const expect = (1 / 0.39) - (1 + 1); // NO 勝ち: NO 枚数 − 投入 $2
    if (T.marketsFilled !== 1 || Math.abs(T.pnl - expect) > 1e-6 || T.pairs !== 1) fails.push(`pair settle ${JSON.stringify(T)} expect ${expect}`);
  }
  // 両側買い: 約定が遅れて届いても、同じ側を $1 を超えて買わない(9/26 06:14 の NO $3 の再発防止)
  {
    const pm2 = new PairMaker({ exchangeAddresses: ['0xEX'], opts: { latencyMs: 0, settleDelayMs: 0 } });
    // 公正 0.5 → NO 0.46 に指値。約定が届かないまま公正が 0.45 に動き、NO を 0.51 に置き直し、さらに 0.56 へ
    pm2.onTick({ slug: 'p2', kind: '5-min', tauSec: 250, pUp: 0.5, bid: 0.4, ask: 0.6 }, 1000);
    pm2.onTick({ slug: 'p2', kind: '5-min', tauSec: 245, pUp: 0.45, bid: 0.4, ask: 0.6 }, 6000);
    pm2.onTick({ slug: 'p2', kind: '5-min', tauSec: 240, pUp: 0.4, bid: 0.3, ask: 0.5 }, 11000);
    // あとから3件の約定がまとめて届く(それぞれ別の指値の時間帯)
    pm2.onFill({ slug: 'p2', outcome: 'NO', makerSide: 'BUY', price: 0.40, shares: 10, taker: '0xT', tx: 'n1', blockTime: 2000 });
    pm2.onFill({ slug: 'p2', outcome: 'NO', makerSide: 'BUY', price: 0.45, shares: 10, taker: '0xT', tx: 'n2', blockTime: 7000 });
    pm2.onFill({ slug: 'p2', outcome: 'NO', makerSide: 'BUY', price: 0.50, shares: 10, taker: '0xT', tx: 'n3', blockTime: 12000 });
    const st2 = pm2.mk.get('p2');
    if (Math.abs(st2.pos.NO.cost - 1) > 1e-9 || st2.pos.YES.qty !== 0 || pm2.diag.blocked !== 2) fails.push(`pair 遅着で買い増し ${JSON.stringify(st2.pos)} ${JSON.stringify(pm2.diag)}`);
  }
  // 点検カウンタ: 値段は合うが有効時間外の約定を数える
  {
    const eg5 = new EndgameMaker({ writeRow: () => {}, exchangeAddresses: ['0xEX'], opts: { latencyMs: 5000 } });
    const T0 = 1790000000; const secs = new Map(); for (let x = T0 - 150; x <= T0; x++) secs.set(x, 100300);
    eg5.onTick({ slug: 'a1', kind: '5-min', model: 'twap', tauSec: 30, K: 100000, tw: 100300, secs, pNow: 100300, nowSec: T0, sigma1h: 0.004, bid: 0.95, ask: 0.99 }, T0 * 1000);
    eg5.onFill({ slug: 'a1', outcome: 'YES', makerSide: 'BUY', price: 0.95, shares: 5, taker: '0xT', tx: 't1', blockTime: T0 * 1000 + 1000 }); // 有効になる前
    if (eg5.diag.priceOkOutside !== 3 || eg5.diag.credited !== 0 || eg5.diag.places !== 3) fails.push(`endgame diag ${JSON.stringify(eg5.diag)}`);
  }
  if (fails.length) { console.error('自己診断 失敗:', fails); process.exit(1); }
  console.log('自己診断 OK');
}

// ---------------------------------------------------------------- 起動
async function main() {
  if (process.argv.includes('--selftest')) { await selftest(); return; }
  console.log(`[起動] API=${API_URL} WS=${WS_URL} 保存先=${DATA_DIR} 対象=${ASSETS.join(',')} パターン=${SLUG_RE}`);
  writeRow('start', { apiUrl: API_URL, wsUrl: WS_URL, assets: ASSETS, pattern: String(SLUG_RE), node: process.version });
  if (stats.load()) console.log(`[集計] stats.json を読込(${Object.keys(stats.days).length}日分)`);
  const nLedger = ledger.load(LEDGER_FILE);
  if (nLedger) console.log(`[台帳] ledger.json を読込(約定${nLedger}件)`);
  if (ENDGAME !== 'off' && endgame.load()) console.log('[紙上] endgame.json を読込');
  if (PAIR !== 'off' && pair.load()) console.log('[両側] pair.json を読込');
  console.log(`[両側] 両側買い: ${PAIR === 'off' ? '停止' : '紙上で稼働(実際の注文は出さない)'} 公正−${pair.o.h} に指値 / 組原価 ≤ ${1 - pair.o.margin} / 1市場 $${pair.o.maxPerMarketUsd} まで`);
  console.log(`[紙上] 終盤メイカー: ${ENDGAME === 'off' ? '停止' : '紙上で稼働(実際の注文は出さない)'} 指値上限=${endgame.o.variants.join('/')} 満期 ${Object.entries(endgame.o.startSecByKind).map(([k, v]) => `${k}:${v}秒`).join(' ')} 前から 1市場$${endgame.o.sizeUsd} 確率≥${endgame.o.minP}`);
  setInterval(() => { stats.save(); ledger.save(LEDGER_FILE); if (ENDGAME !== 'off') endgame.save(); if (PAIR !== 'off') pair.save(); }, 60000);
  startServer({ port: PORT, getState, token: DASHBOARD_TOKEN });
  if (BACKTEST_INTERVAL_MS > 0) setTimeout(function bt() { backtestOnce().finally(() => setTimeout(bt, BACKTEST_INTERVAL_MS)); }, 60000);
  connectLimitlessWs();
  runHermes();
  runBinance();
  await discover();
  setInterval(() => discover().catch((e) => writeRow('error', { where: 'discover-loop', msg: e.message })), DISCOVER_INTERVAL_MS);
  setInterval(theoTick, THEO_INTERVAL_MS);
  setInterval(() => pollExpired().catch((e) => writeRow('error', { where: 'pollExpired', msg: e.message })), 60000);
  setInterval(heartbeat, 5 * 60000);
  if (AUDIT_INTERVAL_MS > 0) setInterval(audit, AUDIT_INTERVAL_MS);
  if (LATENCY_PROBE_MS > 0) setInterval(latencyProbe, LATENCY_PROBE_MS);
  if (EVENTS_INTERVAL_MS > 0) setInterval(() => pollMarketEvents().catch((e) => writeRow('error', { where: 'events-loop', msg: e.message })), EVENTS_INTERVAL_MS);
  if (BASE_RPC_URL) {
    console.log('[チェーン] Base の約定・払い戻しの監視を開始');
    startChainWatcher({
      rpcUrl: BASE_RPC_URL, logRawOnce, resolveToken, resolveCondition, onLatency: (k, ms) => latency.push(k, ms),
      writeRow: (type, obj) => { const row = writeRow(type, obj); if (type === 'fill') {
        if (row.blockTime) { const lag = Date.now() - row.blockTime; auditWin.chainFills++; auditWin.ingestLagSum += lag; auditWin.ingestLagMax = Math.max(auditWin.ingestLagMax, lag); } ledger.addFill(row); if (ENDGAME !== 'off') endgame.onFill(row); if (PAIR !== 'off') pair.onFill(row); } return row; },
    });
    setTimeout(function rep() { leaderReport(); setTimeout(rep, LEADER_REPORT_MS); }, 10 * 60000);
  } else {
    console.log('[チェーン] BASE_RPC_URL が未設定なのでオンチェーンの約定は読まない');
  }
  heartbeat();
}

process.on('unhandledRejection', (e) => writeRow('error', { where: 'unhandledRejection', msg: e?.message ?? String(e) }));
process.on('SIGTERM', () => { writeRow('stop', {}); stats.save(); ledger.save(LEDGER_FILE); endgame.save(); pair.save(); if (stream) stream.end(() => process.exit(0)); else process.exit(0); });

main().catch((e) => { console.error('[致命的]', e); process.exit(1); });
