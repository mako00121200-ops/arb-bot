// アドレス別の約定台帳。「誰が、どちら側を、満期の何秒前に、いくらで取って、結局いくら勝ったか」を集計する。
//
// [OrderFilled の読み方(Polymarket 系 CTF Exchange)]
// 1回のマッチで、テイカー注文について1件(taker = 取引所自身のアドレス)、
// 相手になったメイカー注文ごとに1件(taker = テイカーのアドレス)の OrderFilled が出る。
// どちらの記録でも maker がその注文の持ち主なので、集計の主体は maker。
// taker が取引所アドレスなら、その記録はテイカー注文(=成行で取った側)。
//
// [損益の確定]
// 市場が決済されたら、その市場の約定に結果を当てて損益を出す。
//   YES を価格 p で s 枚買った: YES勝ち → +s(1−p) / 負け → −sp
//   YES を価格 p で s 枚売った: YES勝ち → −s(1−p) / 負け → +sp
// NO トークンも同じ(NO勝ち = Down)。手数料はその注文の持ち主が払ったものを引く。

import fs from 'node:fs';

export class FillLedger {
  constructor({ keepMs = 48 * 3600000, exchangeAddresses = [] } = {}) {
    this.keepMs = keepMs;
    this.exchanges = new Set(exchangeAddresses.map((a) => a.toLowerCase()));
    this.fills = []; // { t, slug, outcome, kind, owner, role, side, price, shares, usdc, fee, secToExpiry, up: null|0|1, pnl: null }
    this.names = new Map(); // address(lower) -> username
  }
  setName(address, name) {
    if (address && name) this.names.set(String(address).toLowerCase(), name);
  }
  addFill(f) {
    if (!f?.maker || !f.slug || !f.outcome || !(f.shares > 0) || f.price === null) return null;
    const rec = {
      t: f.blockTime ?? Date.now(),
      slug: f.slug, outcome: f.outcome, kind: f.kind ?? null,
      owner: f.maker.toLowerCase(),
      role: this.exchanges.has(String(f.taker).toLowerCase()) ? 'taker' : 'maker',
      side: f.makerSide, price: f.price, shares: f.shares, usdc: f.usdc, fee: f.feeUsdc ?? 0,
      secToExpiry: f.secToExpiry ?? null,
      up: null, pnl: null,
    };
    this.fills.push(rec);
    this.prune();
    return rec;
  }
  // 市場の結果を当てて損益を確定する。up=1 なら YES 勝ち
  resolve(slug, up) {
    if (up !== 0 && up !== 1) return [];
    const done = [];
    for (const r of this.fills) {
      if (r.slug !== slug || r.up !== null) continue;
      const win = (r.outcome === 'YES') === (up === 1);
      const gross = r.side === 'BUY' ? (win ? r.shares * (1 - r.price) : -r.shares * r.price) : (win ? -r.shares * (1 - r.price) : r.shares * r.price);
      r.up = up;
      r.pnl = gross - r.fee;
      done.push(r);
    }
    return done;
  }
  // 再起動で台帳が消えないようにファイルへ保存する(2026年9月26日: 再デプロイのたびに24h集計が消えていた)
  save(file) {
    if (!file) return;
    try {
      this.prune();
      fs.writeFileSync(file + '.tmp', JSON.stringify({ fills: this.fills, names: [...this.names] }));
      fs.renameSync(file + '.tmp', file);
    } catch (e) { console.error('[台帳の保存失敗]', e.message); }
  }
  load(file) {
    if (!file || !fs.existsSync(file)) return 0;
    try {
      const j = JSON.parse(fs.readFileSync(file, 'utf8'));
      this.fills = Array.isArray(j.fills) ? j.fills : [];
      this.names = new Map(j.names ?? []);
      this.prune();
      return this.fills.length;
    } catch (e) { console.error('[台帳の読込失敗]', e.message); return 0; }
  }
  // 最近の約定(新しい順)
  recent(n = 50) {
    return this.fills.slice(-n).reverse().map((r) => ({ ...r, name: this.names.get(r.owner) ?? null }));
  }
  prune() {
    const cutoff = Date.now() - this.keepMs;
    if (this.fills.length && this.fills[0].t < cutoff) this.fills = this.fills.filter((r) => r.t >= cutoff);
  }
  // 直近 hours 時間の、結果が確定した約定だけでアドレス別に集計
  report({ hours = 24, top = 10 } = {}) {
    const since = Date.now() - hours * 3600000;
    const by = new Map();
    for (const r of this.fills) {
      if (r.t < since || r.pnl === null) continue;
      const a = by.get(r.owner) ?? { owner: r.owner, n: 0, wins: 0, pnl: 0, notional: 0, taker: 0, buyYes: 0, buyNo: 0, sell: 0, secSum: 0, secN: 0, kinds: {} };
      a.n++; a.pnl += r.pnl; a.notional += r.usdc; if (r.pnl > 0) a.wins++;
      if (r.role === 'taker') a.taker++;
      if (r.side === 'BUY') { if (r.outcome === 'YES') a.buyYes++; else a.buyNo++; } else a.sell++;
      if (r.secToExpiry !== null) { a.secSum += r.secToExpiry; a.secN++; }
      a.kinds[r.kind ?? '?'] = (a.kinds[r.kind ?? '?'] || 0) + 1;
      by.set(r.owner, a);
    }
    const rows = [...by.values()].map((a) => ({
      owner: a.owner, name: this.names.get(a.owner) ?? null, n: a.n, pnl: a.pnl, notional: a.notional,
      winRate: a.n ? a.wins / a.n : null, takerRate: a.n ? a.taker / a.n : null,
      buyYesRate: a.n ? a.buyYes / a.n : null, buyNoRate: a.n ? a.buyNo / a.n : null, sellRate: a.n ? a.sell / a.n : null,
      avgSecToExpiry: a.secN ? a.secSum / a.secN : null, kinds: a.kinds,
    }));
    const total = rows.reduce((s, r) => s + r.pnl, 0);
    return {
      hours, addresses: rows.length, resolvedFills: rows.reduce((s, r) => s + r.n, 0), totalPnl: total,
      topByPnl: [...rows].sort((a, b) => b.pnl - a.pnl).slice(0, top),
      topByVolume: [...rows].sort((a, b) => b.notional - a.notional).slice(0, top),
      unresolved: this.fills.filter((r) => r.pnl === null).length,
    };
  }
}

export function formatLeader(r, i) {
  const pct = (v) => (v === null ? '-' : Math.round(v * 100) + '%');
  const who = `${r.owner.slice(0, 6)}…${r.owner.slice(-4)}${r.name ? `(${r.name})` : ''}`;
  return `#${i + 1} ${who} 損益=${r.pnl >= 0 ? '+' : ''}$${r.pnl.toFixed(2)} 約定=${r.n}件 勝率=${pct(r.winRate)} 名目=$${r.notional.toFixed(0)} テイカー=${pct(r.takerRate)} 買YES=${pct(r.buyYesRate)} 買NO=${pct(r.buyNoRate)} 売=${pct(r.sellRate)} 平均満期前=${r.avgSecToExpiry === null ? '-' : Math.round(r.avgSecToExpiry) + 's'} 種別=${JSON.stringify(r.kinds)}`;
}
