// 両側買い(紙上)。Polymarket で公開されている「gabagool」型を Limitless 向けにしたもの。
//
// [考え方]
//   同じ市場で YES と NO を別々の時刻に安く買い、「YES 1枚 + NO 1枚」の平均原価を $1 未満にそろえる。
//   両方そろえば、結果がどちらでも $1 が戻るので利益が確定する(公開例: 原価 $0.966/組、15分で +約5%)。
//   終盤メイカーと違い「1回の負けが勝ち数十回分」にはならない。代わりに、片側だけ買って
//   相手側がそろわないまま決済を迎えると、その片側の分だけ負ける(これが唯一の主なリスク)。
//
// [ルール(紙上)]
//   1. 公正価格(YES の確率)は Binance + Chainlink 基差の TWAP モデル(毎秒更新)。
//      1本目: YES = 公正 − h、NO = (1 − 公正) − h
//   2. 片側を持ったら、多い側はそろうまで買い増さない。反対側は「公正 − hComplete」まで寄せて早くそろえる
//      (ただし組の原価 ≤ 1 − margin を超えない)
//   3. 1本目は満期 firstStopSec 秒前まで(そろえる時間を残す)
//   [2026年9月26日の紙上結果] 旧版は14市場中11市場が片側のみで −$6.44。指値の更新が5秒ごと・公正価格が
//   Chainlink(約1.3秒遅れ)だったため古い指値が拾われた。更新を毎秒・Binance基準に、2本目を寄せる形に直した
//   4. 1市場の投入は maxPerMarketUsd まで、1回の指値は clipUsd
//   5. 満期 stopSec 秒前からは新しく置かない(勝敗がほぼ決まり、安い側は外れ側になるため)
//   6. すべて postOnly(メイカー)。Limitless のメイカー手数料は0
//   約定判定は終盤メイカーと同じ(Base 上の実際の約定から、価格優先・同値は待ち行列の半分)
import fs from 'node:fs';
import path from 'node:path';

export const PAIR_DEFAULTS = {
  kinds: ['5-min', '15-min'],
  h: 0.04,               // 1本目(まだ何も持っていない時)を公正価格から何¢下に置くか
  hComplete: 0.01,       // 2本目(反対側をそろえる時)は公正価格の何¢下まで寄せるか
  margin: 0.02,          // 組の原価の上限 = 1 − margin
  clipUsd: 1,            // 1回の指値
  maxPerMarketUsd: 6,    // 1市場の投入上限
  maxImbalanceUsd: 1.5,  // 片寄りの上限(ドル換算)
  stopSec: 60,           // 満期の何秒前から新しく置かないか
  firstStopSec: 180,     // 1本目はこれより満期に近いと置かない(そろえる時間が足りない)
  requoteCents: 0.005,   // 望む価格がこれ以上動いたら置き直す(9/26: 1¢では古い指値が拾われた)
  queueShare: 0.5,
  latencyMs: 400,
  settleDelayMs: 180000,
  tick: 0.001,
  minPrice: 0.05,        // これより安い側(ほぼ外れ)は買わない
};

const floorTick = (x, tick) => Math.floor(x / tick + 1e-9) * tick;
const OTHER = { YES: 'NO', NO: 'YES' };

export class PairMaker {
  constructor({ dataDir = null, writeRow = () => {}, exchangeAddresses = [], opts = {} } = {}) {
    this.o = { ...PAIR_DEFAULTS, ...opts };
    this.file = dataDir ? path.join(dataDir, 'pair.json') : null;
    this.writeRow = writeRow;
    this.exchanges = new Set(exchangeAddresses.map((a) => a.toLowerCase()));
    this.mk = new Map(); // slug -> 状態
    this.totals = { markets: 0, quotes: 0, marketsFilled: 0, pairs: 0, cost: 0, pnl: 0, wins: 0, losses: 0, worst: 0, hedgedShares: 0, unhedgedShares: 0 };
    this.byDay = {};
    this.recent = [];
    this.startedAt = Date.now();
  }
  state(slug, kind) {
    let st = this.mk.get(slug);
    if (!st) { st = { slug, kind, pos: { YES: { qty: 0, cost: 0 }, NO: { qty: 0, cost: 0 } }, quotes: { YES: null, NO: null }, segments: [], credited: {}, up: null }; this.mk.set(slug, st); this.totals.markets++; }
    return st;
  }
  avg(p) { return p.qty > 0 ? p.cost / p.qty : null; }

  // 毎秒。ctx = { slug, kind, tauSec, pUp, bid, ask }(bid/ask は YES の板)
  onTick(ctx, now = Date.now()) {
    if (!this.o.kinds.includes(ctx.kind) || ctx.pUp === null || ctx.pUp === undefined || !Number.isFinite(ctx.pUp)) return;
    const st = this.state(ctx.slug, ctx.kind);
    if (st.up !== null) return;
    const spent = st.pos.YES.cost + st.pos.NO.cost;
    for (const side of ['YES', 'NO']) {
      const fair = side === 'YES' ? ctx.pUp : 1 - ctx.pUp;
      const mine = st.pos[side], other = st.pos[OTHER[side]];
      const oAvg = this.avg(other);
      // 反対側の方が多い = この側は「そろえる側」。公正価格の近くまで寄せて早くそろえる(ただし組の原価 ≤ 1 − margin)
      const completing = oAvg !== null && other.qty > mine.qty + 1e-9;
      let want = completing
        ? Math.min(floorTick(fair - this.o.hComplete, this.o.tick), floorTick(1 - this.o.margin - oAvg, this.o.tick))
        : floorTick(fair - this.o.h, this.o.tick);
      // 片寄り: この側がすでに多いなら、もう買わない
      const imbalanceUsd = (mine.qty - other.qty) * Math.max(want, 0.01);
      const tooMuch = mine.qty > other.qty + 1e-9 && imbalanceUsd >= this.o.maxImbalanceUsd;
      const startingNew = !completing && mine.qty <= other.qty + 1e-9; // 組がそろっている状態から1本目を足す
      let ok = ctx.tauSec > this.o.stopSec && spent < this.o.maxPerMarketUsd && want >= this.o.minPrice && !tooMuch
        && !(mine.qty > other.qty + 1e-9) // 多い側はそろうまで買い増さない
        && !(startingNew && ctx.tauSec <= this.o.firstStopSec);
      // postOnly: この側の最良売り値より下
      const bestAskSide = side === 'YES' ? ctx.ask : (ctx.bid !== null && ctx.bid !== undefined ? 1 - ctx.bid : null);
      if (ok && bestAskSide !== null && bestAskSide !== undefined && want >= bestAskSide) want = floorTick(bestAskSide - this.o.tick, this.o.tick);
      if (want < this.o.minPrice) ok = false;
      want = +want.toFixed(3);
      const cur = st.quotes[side];
      if (!ok) { if (cur) this.close(st, side, now, 'stop'); continue; }
      if (cur && Math.abs(cur.q - want) < this.o.requoteCents - 1e-9) continue;
      if (cur) this.close(st, side, now, 'requote');
      const seg = { side, q: want, from: now + this.o.latencyMs, to: null, shares: this.o.clipUsd / want, filled: 0 };
      st.quotes[side] = seg; st.segments.push(seg);
      this.totals.quotes++;
    }
  }
  close(st, side, now, why) {
    const seg = st.quotes[side];
    if (!seg) return;
    seg.to = now; st.quotes[side] = null;
  }

  onFill(f) {
    if (!f?.slug || !f.outcome || !(f.shares > 0) || f.price === null || f.price === undefined) return;
    const st = this.mk.get(f.slug);
    if (!st || st.up !== null) return;
    const t = f.blockTime ?? f.t;
    const isTaker = this.exchanges.has(String(f.taker ?? '').toLowerCase());
    for (const seg of st.segments) {
      if (t < seg.from || (seg.to !== null && t > seg.to) || seg.filled >= seg.shares - 1e-9) continue;
      const W = seg.side, q = seg.q;
      let avail = 0;
      if (!isTaker) {
        if (f.outcome === W && f.makerSide === 'BUY') avail = f.price < q - 1e-9 ? f.shares : Math.abs(f.price - q) < 1e-9 ? f.shares * this.o.queueShare : 0;
      } else {
        const soldW = f.outcome === W && f.makerSide === 'SELL' && f.price <= q + 1e-9;
        const boughtOpp = f.outcome !== W && f.makerSide === 'BUY' && f.price >= 1 - q - 1e-9;
        if (soldW || boughtOpp) avail = f.shares * this.o.queueShare;
      }
      if (avail <= 0) continue;
      const key = `${f.tx ?? t}|${W}|${q}`;
      const prev = st.credited[key] ?? 0;
      const add = Math.min(Math.max(prev, avail) - prev, seg.shares - seg.filled);
      if (add <= 0) continue;
      st.credited[key] = prev + add;
      seg.filled += add; st.pos[W].qty += add; st.pos[W].cost += add * q;
      this.writeRow('pair', { ev: 'fill', slug: st.slug, side: W, q, shares: +add.toFixed(3), yes: +st.pos.YES.qty.toFixed(3), no: +st.pos.NO.qty.toFixed(3), secToExpiry: f.secToExpiry ?? null });
    }
  }

  onResolve(slug, up, now = Date.now()) {
    const st = this.mk.get(slug);
    if (!st || (up !== 0 && up !== 1)) return;
    st.up = up;
    for (const s of ['YES', 'NO']) this.close(st, s, now, 'expiry');
    setTimeout(() => this.settle(slug), this.o.settleDelayMs);
  }
  settle(slug) {
    const st = this.mk.get(slug);
    if (!st) return;
    this.mk.delete(slug);
    const Y = st.pos.YES, N = st.pos.NO;
    const cost = Y.cost + N.cost;
    if (cost <= 0) return;
    const payout = st.up === 1 ? Y.qty : N.qty;
    const pnl = payout - cost;
    const hedged = Math.min(Y.qty, N.qty);
    const pairCost = hedged > 0 ? (this.avg(Y) + this.avg(N)) : null;
    const T = this.totals;
    T.marketsFilled++; T.cost += cost; T.pnl += pnl; if (pnl >= 0) T.wins++; else T.losses++; T.worst = Math.min(T.worst, pnl);
    T.hedgedShares += hedged; T.unhedgedShares += Math.abs(Y.qty - N.qty); if (hedged > 0) T.pairs++;
    const day = new Date().toISOString().slice(0, 10);
    const D = (this.byDay[day] ??= { markets: 0, pnl: 0, cost: 0, wins: 0, losses: 0 });
    D.markets++; D.pnl += pnl; D.cost += cost; if (pnl >= 0) D.wins++; else D.losses++;
    const days = Object.keys(this.byDay).sort(); while (days.length > 30) delete this.byDay[days.shift()];
    const rec = { t: Date.now(), slug, kind: st.kind, up: st.up, yes: +Y.qty.toFixed(3), no: +N.qty.toFixed(3), avgYes: this.avg(Y), avgNo: this.avg(N), pairCost, cost: +cost.toFixed(4), pnl: +pnl.toFixed(4) };
    this.recent.unshift(rec); if (this.recent.length > 100) this.recent.length = 100;
    this.writeRow('pair', { ev: 'settle', ...rec });
    console.log(`[両側] ${slug} YES ${rec.yes}枚@${rec.avgYes?.toFixed(3) ?? '-'} / NO ${rec.no}枚@${rec.avgNo?.toFixed(3) ?? '-'} 組原価=${pairCost?.toFixed(3) ?? '-'} → ${pnl >= 0 ? '+' : ''}$${pnl.toFixed(3)} (累計 ${T.pnl >= 0 ? '+' : ''}$${T.pnl.toFixed(2)} / ${T.marketsFilled}市場)`);
  }
  summary() {
    const T = this.totals;
    const today = this.byDay[new Date().toISOString().slice(0, 10)] ?? null;
    return { mode: 'paper', startedAt: this.startedAt, opts: { ...this.o }, totals: { ...T, roi: T.cost ? T.pnl / T.cost : null, hedgeRatio: T.hedgedShares + T.unhedgedShares ? T.hedgedShares / (T.hedgedShares + T.unhedgedShares) : null }, today, byDay: this.byDay, recent: this.recent.slice(0, 40) };
  }
  save() {
    if (!this.file) return;
    try { fs.writeFileSync(this.file + '.tmp', JSON.stringify({ totals: this.totals, byDay: this.byDay, recent: this.recent, startedAt: this.startedAt })); fs.renameSync(this.file + '.tmp', this.file); } catch (e) { console.error('[両側の保存失敗]', e.message); }
  }
  load() {
    if (!this.file || !fs.existsSync(this.file)) return false;
    try { const j = JSON.parse(fs.readFileSync(this.file, 'utf8')); this.totals = { ...this.totals, ...(j.totals ?? {}) }; this.byDay = j.byDay ?? {}; this.recent = j.recent ?? []; this.startedAt = j.startedAt ?? this.startedAt; return true; } catch (e) { console.error('[両側の読込失敗]', e.message); return false; }
  }
}
