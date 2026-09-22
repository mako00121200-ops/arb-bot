// scripts/wick-backtest.js
//
// **「ロスカットの急落を買って、戻ったら売る」は本当に儲かるのかを、無料のデータで検証する。**
//
// [オーナーの案(2026年9月22日)]
// 「ロスカットが起きたことを検知して、その板情報からどれぐらいまで価格が下がるかを予測して
//  そこに指し値を置く。約定されたら価格が戻り、ヒゲが出たところの次の足で決済する」
//
// 理屈は本物。**強制決済は価格を見ない売り手**で、「いくらでもいいから今すぐ売れ」と
// 機械が投げるため価格が一時的に本来の水準を割り込む。そこへ買い向かうのは
// **流動性が枯れた瞬間に流動性を供給する対価**で、正当なリスクプレミアム。
//
// [調べて分かった制約と、その回避]
// ① Binance の清算ストリームは**リアルタイム配信をやめ、最大で毎秒1件のスナップショット**に
//    なった。しかも「その1000msの**最新の1件**」で、合計でも最大でもない。
//    カスケード中は毎秒何百件も起きるので、**いちばん情報が欲しい瞬間に一番落ちる**。
//    全市場の履歴 `allForceOrders` は**廃止済み**。
// ② 学術研究は「endogenous-buildup 型と exogenous-shock 型の2類型があり、
//    早期警戒シグナルは**イベントごとに異なる**」としている。前者は戻り、**後者は戻らない**。
//
// **→ しかし清算データは検証に要らない。** 核心の仮説は「急落後に戻るか」で、
// これは**ローソク足だけで検証できる**。清算データは引き金の精度を上げるものにすぎない。
// そして kline は data.binance.vision に**何年分も無料**で置いてある。
//
// [ここで測るもの]
// 「N分間でX%以上下げた」直後に買い、M本後に決済したら、損益はどう分布するか。
//   ・勝率だけでなく**分布の左の尾**を見る。ここがこの戦略の生死を分ける
//   ・手数料を引く
//   ・**中央値ではなく合計と最悪値**を見る(小さく何度も勝って稀に全部失う形なので)
//
// [これは取引しない]
// 過去のデータを読んで計算するだけ。**注文も送金も一切しない。**
//
// [動かし方]
//   RUN_WICK_BACKTEST=BTCUSDT,ETHUSDT  … 起動時に1回だけ走る(普段は動かない)
//   WICK_BACKTEST_DAYS=180             … 遡る日数
//   WICK_DROP_PCT=2                    … 「急落」とみなす下落率(%)
//   WICK_WINDOW=5                      … 何本で下げたら急落とみなすか
//   WICK_HOLD=3                        … 何本後に決済するか
//   WICK_FEE_BPS=10                    … 往復の手数料(bps)。既定10bps=0.1%

import zlib from "zlib";

const BASE = process.env.BINANCE_DATA_BASE || "https://data.binance.vision";
/// 1分足を使う。ヒゲは秒単位で終わることがあるので1分でも粗いが、
/// **無料で何年分も取れる**のはこの粒度。まず大づかみに当たりを付ける。
const INTERVAL = process.env.WICK_INTERVAL || "1m";

export function wickBacktestSymbols() {
  return (process.env.RUN_WICK_BACKTEST || "").split(",").map((s) => s.trim().toUpperCase()).filter(Boolean);
}

/// 1日ぶんの1分足を取る。**futures(um)の公開ダンプ**を使う。
/// 無ければ null(その日は飛ばす)。**推測で埋めない。**
async function fetchDay(symbol, dateStr) {
  const url = `${BASE}/data/futures/um/daily/klines/${symbol}/${INTERVAL}/${symbol}-${INTERVAL}-${dateStr}.zip`;
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    return unzipFirstEntry(buf);
  } catch (e) {
    return null;
  }
}

/// ZIP の最初のファイルを取り出す。
///
/// [なぜ自前で解くか]
/// 解凍ライブラリを足すと依存が増える。ZIPの中身は1つだけで、
/// **格納方式は deflate(8)か無圧縮(0)**しかないので、局所ヘッダだけ読めば足りる。
/// 想定外の方式なら null を返して**その日を飛ばす**(黙って壊れた値を使わない)。
function unzipFirstEntry(buf) {
  if (buf.length < 30 || buf.readUInt32LE(0) !== 0x04034b50) return null;
  const method = buf.readUInt16LE(8);
  const nameLen = buf.readUInt16LE(26);
  const extraLen = buf.readUInt16LE(28);
  const start = 30 + nameLen + extraLen;
  const body = buf.subarray(start);
  try {
    if (method === 0) return body.toString("utf8");
    if (method === 8) return zlib.inflateRawSync(body).toString("utf8");
  } catch (e) { return null; }
  return null;
}

/// CSV から終値だけ取り出す(open time, open, high, low, close, ...)。
/// 数にならない行は飛ばす。
export function parseCloses(csv) {
  const out = [];
  for (const line of csv.split("\n")) {
    if (!line) continue;
    const c = line.split(",");
    if (c.length < 5) continue;
    const close = parseFloat(c[4]);
    const low = parseFloat(c[3]);
    const openTime = parseInt(c[0], 10);
    if (!Number.isFinite(close) || !Number.isFinite(low) || !Number.isFinite(openTime)) continue;
    out.push({ t: openTime, low, close });
  }
  return out;
}

/// **本体の計算。** 急落を見つけ、買って、M本後に決済したらどうなったかを全部数える。
///
/// @param bars [{t, low, close}] 時系列順
/// @returns 損益の一覧(bps)と要約
export function simulateWicks(bars, { dropPct, window, hold, feeBps }) {
  const results = [];
  for (let i = window; i + hold < bars.length; i++) {
    const before = bars[i - window].close;
    const now = bars[i].close;
    if (!(before > 0)) continue;
    const changePct = ((now - before) / before) * 100;
    if (changePct > -dropPct) continue; // 急落していない

    // その足の終値で買ったことにする。**安値で拾えたことにはしない**
    // (指値が都合よく最安値で約定する前提は、後から見た人の錯覚)。
    const entry = now;
    const exit = bars[i + hold].close;
    const grossBps = ((exit - entry) / entry) * 10000;
    results.push({ t: bars[i].t, dropPct: changePct, bps: grossBps - feeBps });
    i += hold; // 同じ急落を重複して数えない
  }

  if (results.length === 0) return { count: 0, results };
  const sorted = [...results].map((r) => r.bps).sort((a, b) => a - b);
  const sum = sorted.reduce((a, b) => a + b, 0);
  const pick = (q) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor(sorted.length * q)))];
  const wins = sorted.filter((b) => b > 0).length;
  return {
    count: results.length,
    winRate: wins / sorted.length,
    meanBps: sum / sorted.length,
    medianBps: pick(0.5),
    // **左の尾がこの戦略の生死。** 小さく何度も勝って稀に全部失う形なので、
    // 平均や中央値だけ見ると必ず判断を誤る。
    p05Bps: pick(0.05),
    p01Bps: pick(0.01),
    worstBps: sorted[0],
    bestBps: sorted[sorted.length - 1],
    totalBps: sum,
    results,
  };
}

function ymd(d) {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}

/// 1銘柄ぶん走らせて結果をログに出す。
export async function runWickBacktest(symbol) {
  const days = parseInt(process.env.WICK_BACKTEST_DAYS || "180", 10);
  const dropPct = parseFloat(process.env.WICK_DROP_PCT || "2");
  const window = parseInt(process.env.WICK_WINDOW || "5", 10);
  const hold = parseInt(process.env.WICK_HOLD || "3", 10);
  const feeBps = parseFloat(process.env.WICK_FEE_BPS || "10");

  console.log(`[ヒゲ検証] ${symbol}: ${days}日ぶんの${INTERVAL}足を取ります(${window}本で-${dropPct}%以上 → ${hold}本後に決済、手数料${feeBps}bps)。**取引はしません**`);

  const bars = [];
  let got = 0, missed = 0;
  // 前日まで(当日ぶんはまだ置かれていないことがある)。
  for (let k = days; k >= 1; k--) {
    const d = new Date(Date.now() - k * 86400000);
    const csv = await fetchDay(symbol, ymd(d));
    if (!csv) { missed++; continue; }
    const part = parseCloses(csv);
    if (part.length === 0) { missed++; continue; }
    bars.push(...part);
    got++;
  }
  if (bars.length === 0) {
    console.warn(`[ヒゲ検証] ${symbol}: データを1日ぶんも取れませんでした(取得失敗${missed}日)`);
    return null;
  }
  bars.sort((a, b) => a.t - b.t);

  const r = simulateWicks(bars, { dropPct, window, hold, feeBps });
  if (r.count === 0) {
    console.log(`[ヒゲ検証] ${symbol}: ${got}日/${bars.length.toLocaleString()}本を見たが、条件に合う急落が**0件**でした`);
    return r;
  }

  const pct = (b) => `${(b / 100).toFixed(2)}%`;
  console.log(`[ヒゲ検証] ${symbol}: ${got}日(欠${missed})/${bars.length.toLocaleString()}本 → 急落**${r.count}件**`);
  console.log(`[ヒゲ検証] ${symbol}: 勝率${(r.winRate * 100).toFixed(1)}% 平均${r.meanBps.toFixed(1)}bps 中央${r.medianBps.toFixed(1)}bps **合計${r.totalBps.toFixed(0)}bps(${pct(r.totalBps)})**`);
  console.log(`[ヒゲ検証] ${symbol}: **左の尾** 下位5%=${r.p05Bps.toFixed(1)}bps(${pct(r.p05Bps)}) 下位1%=${r.p01Bps.toFixed(1)}bps(${pct(r.p01Bps)}) **最悪=${r.worstBps.toFixed(1)}bps(${pct(r.worstBps)})** / 最良=${r.bestBps.toFixed(1)}bps`);

  // **1回の最悪が、それまでの合計を飲み込むか。** これがこの戦略の核心の問い。
  const eaten = Math.abs(r.worstBps) >= r.totalBps;
  console.log(`[ヒゲ検証] ${symbol}: 判定 → 合計${r.totalBps.toFixed(0)}bps に対し最悪の1回が${r.worstBps.toFixed(0)}bps。`
    + (eaten
      ? `**1回の事故で全部飲まれる。この条件では成立しない。**`
      : `1回の事故では飲まれない(ただし事故が重なる可能性は別に考える)。`));
  return r;
}

/// 設定された銘柄を順に走らせる。
export async function runWickBacktestAll() {
  const symbols = wickBacktestSymbols();
  for (const s of symbols) {
    try {
      await runWickBacktest(s);
    } catch (e) {
      console.warn(`[ヒゲ検証] ${s}: 失敗 ${(e.message || "").slice(0, 100)}`);
    }
  }
}
