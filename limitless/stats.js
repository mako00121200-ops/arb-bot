// ダッシュボード用の集計。JSONL は大きすぎて毎回読めないので、
// 記録と同時に日別・アドレス別の小さな集計を持ち、stats.json に保存する。
import fs from 'node:fs';
import path from 'node:path';

// 乖離(理論 − 板)のヒストグラムの境界。0.02 を超える秒数が「テイカーで取れる余地」の目安
export const EDGE_BINS = [-Infinity, 0, 0.01, 0.02, 0.05, 0.1, Infinity];
export const EDGE_LABELS = ['≤0', '0〜1¢', '1〜2¢', '2〜5¢', '5〜10¢', '>10¢'];

const dayOf = (t) => new Date(t).toISOString().slice(0, 10);

export class Stats {
  constructor({ dataDir, keepDays = 14 } = {}) {
    this.file = dataDir ? path.join(dataDir, 'stats.json') : null;
    this.keepDays = keepDays;
    this.days = {};        // date -> { markets: {kind: {n, theoRight, midRight}}, edge: number[], theoRows, fills, addr: {address: {...}} }
    this.latency = [];     // 5分ごとの遅延 p50(最大288件 = 24時間)
    this.recentSummaries = []; // 最近の決済(最大60件)
    this.startedAt = Date.now();
    this.dirty = false;
  }
  day(t) {
    const d = dayOf(t ?? Date.now());
    if (!this.days[d]) this.days[d] = { markets: {}, edge: new Array(EDGE_LABELS.length).fill(0), theoRows: 0, fills: 0, addr: {} };
    return this.days[d];
  }
  onRow(type, row) {
    if (type === 'summary') {
      const d = this.day(row.t);
      const k = row.kind ?? '?';
      const m = d.markets[k] ?? (d.markets[k] = { n: 0, theoRight: 0, midRight: 0, judged: 0 });
      m.n++;
      if (row.theo5sRight !== null && row.theo5sRight !== undefined && row.mid5sRight !== null && row.mid5sRight !== undefined) {
        m.judged++; if (row.theo5sRight) m.theoRight++; if (row.mid5sRight) m.midRight++;
      }
      this.recentSummaries.unshift({ t: row.t, slug: row.slug, kind: row.kind, up: row.up, K: row.K, gapBps: row.openGapBps, theo5: row.open5s?.pTheo ?? null, mid5: row.open5s?.mid ?? null, theoRight: row.theo5sRight ?? null, midRight: row.mid5sRight ?? null });
      if (this.recentSummaries.length > 60) this.recentSummaries.length = 60;
      this.dirty = true;
    } else if (type === 'theo') {
      const d = this.day(row.t);
      d.theoRows++;
      const e = Math.max(row.edgeBuyYes ?? -1, row.edgeSellYes ?? -1);
      let i = 0; while (i < EDGE_BINS.length - 2 && e > EDGE_BINS[i + 1]) i++;
      d.edge[i]++;
      this.dirty = true;
    } else if (type === 'fill') {
      this.day(row.t).fills++;
      this.dirty = true;
    } else if (type === 'heartbeat') {
      const l = row.latency ?? {};
      this.latency.push({ t: row.t, http: l.http_orderbook?.p50 ?? null, ws: l.ws_book_lag?.p50 ?? null, cex: l.binance_lag?.p50 ?? null, rpc: l.rpc_blockNumber?.p50 ?? null, oracle: l.ws_oracle_lag?.p50 ?? null });
      if (this.latency.length > 288) this.latency.shift();
      this.dirty = true;
    }
  }
  // 損益が確定した約定(ledger の record)を日別・アドレス別に足す
  onResolvedFill(r) {
    const d = this.day(r.t);
    const a = d.addr[r.owner] ?? (d.addr[r.owner] = { n: 0, wins: 0, pnl: 0, notional: 0, taker: 0, buyYes: 0, buyNo: 0, sell: 0, secSum: 0, secN: 0 });
    a.n++; a.pnl += r.pnl; a.notional += r.usdc; if (r.pnl > 0) a.wins++;
    if (r.role === 'taker') a.taker++;
    if (r.side === 'BUY') { if (r.outcome === 'YES') a.buyYes++; else a.buyNo++; } else a.sell++;
    if (r.secToExpiry !== null && r.secToExpiry !== undefined) { a.secSum += r.secToExpiry; a.secN++; }
    this.dirty = true;
  }
  // 直近 n 日をアドレス別に合算し、日別トップ10に入った日数も数える
  leaderboard(nDays = 7, top = 15, names = new Map()) {
    const dates = Object.keys(this.days).sort().slice(-nDays);
    const tot = new Map();
    for (const dt of dates) {
      const addrs = Object.entries(this.days[dt].addr);
      const top10 = new Set(addrs.sort((x, y) => y[1].pnl - x[1].pnl).slice(0, 10).map(([a]) => a));
      for (const [addr, a] of addrs) {
        const t = tot.get(addr) ?? { owner: addr, n: 0, wins: 0, pnl: 0, notional: 0, taker: 0, buyYes: 0, buyNo: 0, sell: 0, secSum: 0, secN: 0, days: 0, daysTop10: 0 };
        t.n += a.n; t.wins += a.wins; t.pnl += a.pnl; t.notional += a.notional; t.taker += a.taker; t.buyYes += a.buyYes; t.buyNo += a.buyNo; t.sell += a.sell; t.secSum += a.secSum; t.secN += a.secN; t.days++;
        if (top10.has(addr)) t.daysTop10++;
        tot.set(addr, t);
      }
    }
    const rows = [...tot.values()].map((t) => ({
      owner: t.owner, name: names.get(t.owner) ?? null, n: t.n, pnl: t.pnl, notional: t.notional,
      winRate: t.n ? t.wins / t.n : null, takerRate: t.n ? t.taker / t.n : null,
      buyYesRate: t.n ? t.buyYes / t.n : null, buyNoRate: t.n ? t.buyNo / t.n : null, sellRate: t.n ? t.sell / t.n : null,
      avgSecToExpiry: t.secN ? t.secSum / t.secN : null, days: t.days, daysTop10: t.daysTop10,
    }));
    return { dates, byPnl: [...rows].sort((a, b) => b.pnl - a.pnl).slice(0, top), byConsistency: [...rows].sort((a, b) => b.daysTop10 - a.daysTop10 || b.pnl - a.pnl).slice(0, top), addresses: rows.length };
  }
  prune() {
    const keys = Object.keys(this.days).sort();
    while (keys.length > this.keepDays) delete this.days[keys.shift()];
  }
  save() {
    if (!this.file || !this.dirty) return;
    try {
      this.prune();
      fs.writeFileSync(this.file + '.tmp', JSON.stringify({ days: this.days, latency: this.latency, recentSummaries: this.recentSummaries, startedAt: this.startedAt }));
      fs.renameSync(this.file + '.tmp', this.file);
      this.dirty = false;
    } catch (e) {
      console.error('[集計の保存失敗]', e.message);
    }
  }
  load() {
    if (!this.file || !fs.existsSync(this.file)) return false;
    try {
      const j = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      this.days = j.days ?? {}; this.latency = j.latency ?? []; this.recentSummaries = j.recentSummaries ?? []; this.startedAt = j.startedAt ?? this.startedAt;
      return true;
    } catch (e) {
      console.error('[集計の読込失敗]', e.message);
      return false;
    }
  }
}
