// 終盤メイカー(紙上)。5分/15分市場の満期直前、TWAPモデルでほぼ確定した側に買い指値を置く。
//
// [なぜこの戦略か(2026年9月25〜26日の実測)]
//   - TWAPモデルの Brier は満期30〜10秒前で 0.001(ほぼ外さない)
//   - Polymarket でも同じ型(98%前後の確定側を満期直前に買う)が公開されている代表的な手法
//   - 勝っていた大口 0x6731…19c5 が、5分市場の平均満期21秒前にメイカーで確定側を買い、名目$1,409で+$34
//   - 相手は満期直前に外れ側を2¢で買う人(大穴好き)。その注文が確定側の買い指値と突き合わされる
//
// [紙上の約定判定(Base 上の実際の約定から)]
//   自分の指値 = 「勝つ側 W を価格 q で買う」。次のどちらかがあれば、その時刻に指値が有効だった場合に約定したとみなす
//   (a) 他人のメイカー「W を買う」が価格 < q で約定 → 価格優先で自分が先。その枚数を全部もらえる
//       価格 = q なら同値の待ち行列なので QUEUE_SHARE だけ
//   (b) テイカー注文(taker = 取引所)が「W を q 以下で売った」または「W の反対側を 1−q 以上で買った」→ QUEUE_SHARE だけ
//   同じ取引(tx)で (a)(b) が両方出るので、tx ごとに大きい方だけを数える
//   指値の有効時刻は「置いた時刻 + 遅延(LATENCY_MS)」から「取り消した時刻」まで
//
// [出さないもの]
//   実際の注文は一切出さない。mode は 'paper' 固定。
import fs from 'node:fs';
import path from 'node:path';
import { normCdf, theoUp } from './math.js';

export const ENDGAME_DEFAULTS = {
  kinds: ['5-min', '15-min', 'hourly-p'],
  // 満期の何秒前から指値を置くか(種別ごと)。1時間市場は終値1点で決まるので少し早めから見る
  startSecByKind: { '5-min': 120, '15-min': 120, 'hourly-p': 150 }, // 9/26: 約定が少ないので早めから(90→120)
  minP: 0.99,          // TWAPモデルの確率がこれ以上の側だけ(9/26: 0.995→0.99。σは2倍で見ているので実質はより厳しい)
  cancelBelowP: 0.99,  // 置いた後、これを割ったら取り消す
  margin: 0.005,       // 指値 = min(上限, 確率 − margin)
  sizeUsd: 1,          // 1市場あたりの上限(紙上)。オーナー方針「1回1ドル前後で数を打つ」
  sigmaMult: 2,        // 検証で自信過剰だったので σ を2倍にして使う
  queueShare: 0.5,
  latencyMs: 400,      // 実測: 板取得の往復 p50 約290ms + 署名
  settleDelayMs: 180000, // 決済後、遅れて届く約定を待つ時間
  // 指値の上限を3通り同時に試す。9/26: 10時間で 0.96/0.97 は約定0、0.98 は3勝0敗だったので上に寄せる
  variants: [0.98, 0.985, 0.99],
  tick: 0.001,
};

const floorTick = (x, tick) => Math.floor(x / tick + 1e-9) * tick;

// 決済値(満期直前60秒の平均)の予測と、その不確実性から「Up になる確率」を出す
// tw = いまの Chainlink 60秒TWAP、secs = 資産の秒ごとの Binance 終値(Map)、pNow = いまの Binance、sigma1h = 1時間σ
export function twapProb({ tw, secs, pNow, nowSec, tauSec, K, sigma1h, sigmaMult = 1 }) {
  if (!(tw > 0) || !(pNow > 0) || !(K > 0) || !(sigma1h > 0) || !(tauSec > 0)) return null;
  const sigSec = (sigma1h * sigmaMult) / 60;
  const mean = (from, to) => { let s = 0, n = 0; for (let x = from; x < to; x++) { const v = secs.get(x); if (v !== undefined) { s += v; n++; } } return n >= Math.max(1, (to - from) * 0.5) ? s / n : null; };
  let Phat, sig;
  if (tauSec < 1) {
    Phat = tw; sig = pNow * sigSec * 0.1;
  } else if (tauSec <= 60) {
    const old = mean(nowSec - 60, nowSec - 60 + Math.round(tauSec));
    if (old === null) return null;
    Phat = tw + (tauSec / 60) * (pNow - old);
    sig = pNow * sigSec * Math.sqrt(tauSec ** 3 / 3) / 60;
  } else {
    const w = mean(nowSec - 60, nowSec);
    if (w === null) return null;
    Phat = pNow + (tw - w);
    sig = pNow * sigSec * Math.sqrt(tauSec - 40);
  }
  if (!(sig > 0)) return null;
  // 同値は Up。Phat ≥ K を Up とする
  return { p: normCdf((Phat - K) / sig), Phat, sig };
}

export class EndgameMaker {
  constructor({ dataDir = null, writeRow = () => {}, exchangeAddresses = [], opts = {} } = {}) {
    this.o = { ...ENDGAME_DEFAULTS, ...opts };
    this.file = dataDir ? path.join(dataDir, 'endgame.json') : null;
    this.writeRow = writeRow;
    this.exchanges = new Set(exchangeAddresses.map((a) => a.toLowerCase()));
    this.book = new Map(); // `${variant}|${slug}` -> 市場ごとの紙上注文
    this.totals = Object.fromEntries(this.o.variants.map((v) => [String(v), this.emptyTotals()]));
    this.byDay = {}; // 'YYYY-MM-DD' -> { variant -> { filled, pnl, wins, losses, cost } }
    this.recent = []; // 決済済み(新しい順、最大100)
    this.settledSlugs = new Map(); // slug -> 決済確定時刻(遅れて届いた約定の検出用)
    this.resetDiag();
    this.startedAt = Date.now();
  }
  // 測り方の点検(30分ごとに collector が読み出してリセット)
  //   tracked      … 紙上注文のある市場に届いた約定行
  //   priceOk      … そのうち「値段の条件は満たす」もの(時刻は問わない)
  //   priceOkOutside … 値段は満たすのに、指値の有効時間の外だったもの(多ければ有効時間の決め方を疑う)
  //   credited     … 実際に紙上約定として数えたもの
  //   late         … 損益確定の後に届いた約定(多ければ待ち時間 settleDelayMs が短すぎる)
  //   outsideBefore  … 置く前(条件を満たす前)に起きた約定。多ければ「置き始めが遅い(minP/startSec)」の所見
  //   outsideLatency … 置いてから有効になるまでの 400ms の間の約定。実弾でも取れないので正しく除外
  //   outsideAfter   … 取消の後(置き直す前)の約定。多ければ取消の条件が厳しすぎる
  resetDiag() { this.diag = { tracked: 0, priceOk: 0, priceOkOutside: 0, outsideBefore: 0, outsideLatency: 0, outsideAfter: 0, credited: 0, late: 0, places: 0, cancels: 0, replaces: 0 }; this.outsideLogged = 0; }
  emptyTotals() { return { markets: 0, placed: 0, filledMarkets: 0, shares: 0, cost: 0, pnl: 0, wins: 0, losses: 0, byKind: {} }; }
  key(v, slug) { return `${v}|${slug}`; }

  // 毎秒呼ぶ。ctx = { slug, kind, model, tauSec, K, tw, secs, pNow, nowSec, sigma1h, bid, ask }(bid/ask は YES の板)
  //   model = 'twap'  … 5分/15分市場(Chainlink 60秒平均で決済)
  //   model = 'point' … 1時間市場(Binance 1時間足の終値1点で決済)。pNow を現在値として使う
  onTick(ctx, now = Date.now()) {
    if (!this.o.kinds.includes(ctx.kind)) return;
    const startSec = this.o.startSecByKind[ctx.kind] ?? 90;
    if (ctx.tauSec > startSec || ctx.tauSec <= 0) return;
    const pr = ctx.model === 'point'
      ? theoUp(ctx.pNow, ctx.K, ctx.sigma1h * this.o.sigmaMult, ctx.tauSec)
      : twapProb({ ...ctx, sigmaMult: this.o.sigmaMult });
    for (const v of this.o.variants) {
      const k = this.key(v, ctx.slug);
      let st = this.book.get(k);
      if (!st) { st = { variant: v, slug: ctx.slug, kind: ctx.kind, side: null, segments: [], filled: 0, cost: 0, credited: {}, target: 0, pAtPlace: null, up: null }; this.book.set(k, st); this.totals[String(v)].markets++; }
      const open = st.segments.find((s) => s.to === null);
      if (!pr) { if (open) this.cancel(st, open, now, 'モデル不能'); continue; }
      const pUp = pr.p;
      const side = pUp >= 0.5 ? 'YES' : 'NO';
      const pSide = side === 'YES' ? pUp : 1 - pUp;
      // 板も同じ側を向いているか(モデルが板と食い違う場面では板の方が正しかった)
      const agree = side === 'YES'
        ? (ctx.bid ?? 0) >= 0.8 || (ctx.bid === null && (ctx.ask ?? 0) >= 0.9)
        : (ctx.ask ?? 1) <= 0.2 || (ctx.ask === null && (ctx.bid ?? 1) <= 0.1);
      if (open) {
        if (open.side !== side || pSide < this.o.cancelBelowP || !agree) this.cancel(st, open, now, open.side !== side ? '向きが反転' : !agree ? '板と不一致' : '確率低下');
        continue;
      }
      // 取消の後、条件が戻れば置き直す(9/26: 置き直さない設計だと、実弾のボットより約定を少なく数えてしまう)
      if (st.target > 0 && st.filled >= st.target - 1e-9) continue; // 目標枚数まで埋まった
      if (st.side && st.side !== side && st.filled > 0) continue; // 持っている側と逆には置かない
      if (pSide < this.o.minP || !agree || ctx.tauSec < 2) continue;
      // 指値: 上限と「確率 − margin」の小さい方。postOnly なので相手の最良売り値より下に置く
      let q = Math.min(v, floorTick(pSide - this.o.margin, this.o.tick));
      const bestOpp = side === 'YES' ? ctx.ask : (ctx.bid !== null ? 1 - ctx.bid : null); // 自分の側の最良売り値
      if (bestOpp !== null && q >= bestOpp) q = floorTick(bestOpp - this.o.tick, this.o.tick);
      if (q < 0.9) continue;
      q = +q.toFixed(3);
      st.side = side; if (!st.target) { st.target = this.o.sizeUsd / q; st.pAtPlace = pSide; }
      const seg = { side, q, placedAt: now, from: now + this.o.latencyMs, to: null, tau: Math.round(ctx.tauSec) };
      const isReplace = st.segments.length > 0;
      st.segments.push(seg);
      if (!isReplace) this.totals[String(v)].placed++;
      if (isReplace) this.diag.replaces++; else this.diag.places++;
      this.writeRow('paper', { ev: 'place', variant: v, slug: st.slug, kind: st.kind, side, q, pSide: +pSide.toFixed(5), tauSec: seg.tau, bid: ctx.bid, ask: ctx.ask });
    }
  }
  cancel(st, seg, now, reason) {
    seg.to = now;
    this.diag.cancels++;
    this.writeRow('paper', { ev: 'cancel', variant: st.variant, slug: st.slug, side: seg.side, q: seg.q, reason, filled: +st.filled.toFixed(3) });
  }

  // Base 上の約定1件ごとに呼ぶ(ledger と同じ fill 行)
  onFill(f) {
    if (!f?.slug || !f.outcome || !(f.shares > 0) || f.price === null || f.price === undefined) return;
    const t = f.blockTime ?? f.t;
    const isTakerRecord = this.exchanges.has(String(f.taker ?? '').toLowerCase());
    if (this.settledSlugs.has(f.slug)) this.diag.late++;
    const priceOkFor = (W, q) => (!isTakerRecord
      ? f.outcome === W && f.makerSide === 'BUY' && f.price <= q + 1e-9
      : (f.outcome === W && f.makerSide === 'SELL' && f.price <= q + 1e-9) || (f.outcome !== W && f.makerSide === 'BUY' && f.price >= 1 - q - 1e-9));
    for (const v of this.o.variants) {
      const st = this.book.get(this.key(v, f.slug));
      if (!st || !st.side) continue;
      this.diag.tracked++;
      const anySeg = st.segments[0];
      const pOk = anySeg ? priceOkFor(anySeg.side, anySeg.q) : false;
      if (pOk) this.diag.priceOk++;
      if (st.filled >= st.target - 1e-9) continue;
      const seg = st.segments.find((s) => t >= s.from && (s.to === null || t <= s.to));
      if (!seg) {
        if (pOk) {
          this.diag.priceOkOutside++;
          const first = st.segments[0], last = st.segments[st.segments.length - 1];
          const reason = t < first.placedAt ? 'before' : t < first.from ? 'latency' : (last.to !== null && t > last.to) ? 'after' : 'gap';
          if (reason === 'before') this.diag.outsideBefore++; else if (reason === 'latency') this.diag.outsideLatency++; else this.diag.outsideAfter++;
          // 見本を残す(点検の窓ごとに最大20件)
          if (this.outsideLogged < 20) { this.outsideLogged++; this.writeRow('paper', { ev: 'outside', variant: v, slug: st.slug, reason, side: first.side, q: first.q, fillOutcome: f.outcome, fillSide: f.makerSide, fillPrice: f.price, fillShares: f.shares, secToExpiry: f.secToExpiry ?? null, placedTau: first.tau, via: isTakerRecord ? 'taker' : 'maker' }); }
        }
        continue;
      }
      const W = seg.side, q = seg.q;
      let avail = 0;
      if (!isTakerRecord) {
        // 他人のメイカー「W を買う」がどの値で約定したか
        if (f.outcome === W && f.makerSide === 'BUY') avail = f.price < q - 1e-9 ? f.shares : Math.abs(f.price - q) < 1e-9 ? f.shares * this.o.queueShare : 0;
      } else {
        // テイカーが W を q 以下で売った / 反対側を 1−q 以上で買った
        const soldW = f.outcome === W && f.makerSide === 'SELL' && f.price <= q + 1e-9;
        const boughtOpp = f.outcome !== W && f.makerSide === 'BUY' && f.price >= 1 - q - 1e-9;
        if (soldW || boughtOpp) avail = f.shares * this.o.queueShare;
      }
      if (avail <= 0) continue;
      const tx = f.tx ?? `${t}`;
      const prev = st.credited[tx] ?? 0;
      const want = Math.max(prev, avail);
      const add = Math.min(want - prev, st.target - st.filled);
      if (add <= 0) continue;
      st.credited[tx] = prev + add;
      st.filled += add; st.cost += add * q;
      this.diag.credited++;
      this.writeRow('paper', { ev: 'fill', variant: v, slug: st.slug, side: W, q, shares: +add.toFixed(3), total: +st.filled.toFixed(3), tx, via: isTakerRecord ? 'taker' : 'maker', secToExpiry: f.secToExpiry ?? null });
    }
  }

  // 市場の決済。遅れて届く約定を待ってから損益を確定する
  onResolve(slug, up, now = Date.now()) {
    if (up !== 0 && up !== 1) return;
    for (const v of this.o.variants) {
      const st = this.book.get(this.key(v, slug));
      if (!st) continue;
      st.up = up;
      for (const s of st.segments) if (s.to === null) s.to = now; // 満期で自動的に終わる
      setTimeout(() => this.settle(v, slug), this.o.settleDelayMs);
    }
  }
  settle(v, slug) {
    const k = this.key(v, slug);
    const st = this.book.get(k);
    if (!st) return;
    this.book.delete(k);
    this.settledSlugs.set(slug, Date.now());
    if (this.settledSlugs.size > 500) for (const key of this.settledSlugs.keys()) { this.settledSlugs.delete(key); if (this.settledSlugs.size <= 400) break; }
    const T = this.totals[String(v)];
    if (st.filled <= 0) return;
    const win = (st.side === 'YES') === (st.up === 1);
    const pnl = (win ? st.filled : 0) - st.cost;
    T.filledMarkets++; T.shares += st.filled; T.cost += st.cost; T.pnl += pnl; if (win) T.wins++; else T.losses++;
    const bk = T.byKind[st.kind] ?? (T.byKind[st.kind] = { filledMarkets: 0, pnl: 0, cost: 0, losses: 0 });
    bk.filledMarkets++; bk.pnl += pnl; bk.cost += st.cost; if (!win) bk.losses++;
    const day = new Date().toISOString().slice(0, 10);
    const D = (this.byDay[day] ??= {});
    const dv = (D[String(v)] ??= { filled: 0, pnl: 0, wins: 0, losses: 0, cost: 0 });
    dv.filled++; dv.pnl += pnl; dv.cost += st.cost; if (win) dv.wins++; else dv.losses++;
    const days = Object.keys(this.byDay).sort(); while (days.length > 30) delete this.byDay[days.shift()];
    const rec = { t: Date.now(), variant: v, slug, kind: st.kind, side: st.side, q: st.segments[0]?.q ?? null, tau: st.segments[0]?.tau ?? null, pAtPlace: st.pAtPlace, shares: +st.filled.toFixed(3), cost: +st.cost.toFixed(4), win, pnl: +pnl.toFixed(4) };
    this.recent.unshift(rec); if (this.recent.length > 100) this.recent.length = 100;
    this.writeRow('paper', { ev: 'settle', ...rec });
    console.log(`[紙上 ${v}] ${slug} ${st.side} ${rec.shares}枚 @${rec.q} → ${win ? '勝ち' : '負け'} ${pnl >= 0 ? '+' : ''}$${pnl.toFixed(3)} (累計 ${T.pnl >= 0 ? '+' : ''}$${T.pnl.toFixed(2)} / ${T.filledMarkets}市場)`);
  }

  summary() {
    const out = {};
    for (const [v, T] of Object.entries(this.totals)) out[v] = { ...T, fillRate: T.placed ? T.filledMarkets / T.placed : null, roi: T.cost ? T.pnl / T.cost : null, winRate: T.filledMarkets ? T.wins / T.filledMarkets : null };
    const open = [...this.book.values()].filter((s) => s.segments.some((x) => x.to === null)).map((s) => ({ variant: s.variant, slug: s.slug, side: s.side, q: s.segments[0]?.q, filled: +s.filled.toFixed(3) }));
    const today = this.byDay[new Date().toISOString().slice(0, 10)] ?? {};
    return { mode: 'paper', startedAt: this.startedAt, opts: { ...this.o }, variants: out, today, byDay: this.byDay, open, recent: this.recent.slice(0, 40) };
  }
  save() {
    if (!this.file) return;
    try { fs.writeFileSync(this.file + '.tmp', JSON.stringify({ totals: this.totals, recent: this.recent, byDay: this.byDay, startedAt: this.startedAt })); fs.renameSync(this.file + '.tmp', this.file); } catch (e) { console.error('[紙上の保存失敗]', e.message); }
  }
  load() {
    if (!this.file || !fs.existsSync(this.file)) return false;
    try {
      const j = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      for (const v of Object.keys(this.totals)) if (j.totals?.[v]) this.totals[v] = { ...this.emptyTotals(), ...j.totals[v] };
      this.recent = j.recent ?? []; this.byDay = j.byDay ?? {}; this.startedAt = j.startedAt ?? this.startedAt;
      return true;
    } catch (e) { console.error('[紙上の読込失敗]', e.message); return false; }
  }
}
