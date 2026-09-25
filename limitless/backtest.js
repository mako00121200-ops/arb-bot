// たまった JSONL から、案1(TWAP残差)と案2(1時間市場の理論価格)が「板より当たるか」「取れたか」を検証する。
//
// [評価の考え方]
//   当たるか  … Brier スコア = 平均((確率 − 結果)²)。小さいほど良い。板の中値・1点モデル・TWAPモデルを同じ行で比べる
//   取れたか  … テイカー: 「確率 − 売値 ≥ 2¢」の最初の瞬間に買っていたら(手数料0.5%を引く)
//               メイカー: 「確率 − 3¢」に指値していたら。約定は、チェーン上でその価格以下で YES が売られた
//               (または NO が 1−価格 以上で買われた)事実があれば埋まったとみなす近似
//
// [TWAPモデル]
//   決済 = 満期直前60秒の平均。残り τ 秒の時点で、
//     予測決済値 P̂ = 現在のTWAP + (τ/60) × (現在値 − 「今のTWAP窓の最も古い τ 秒」の平均)
//     (基差は Binance 同士の差なので打ち消し合う)
//     不確実性 σ = 価格 × σ秒 × sqrt(τ³/3)/60   (τ ≤ 60)
//                = 価格 × σ秒 × sqrt(τ − 40)     (τ > 60、窓がまだ始まっていない)
//     確率 = Φ((P̂ − K)/σ)。同値は Up なので P̂ ≥ K を Up とする
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import readline from 'node:readline';
import { normCdf } from './math.js';

const TAKER_FEE = 0.005;
const TAKER_EDGE = 0.02;
const MAKER_OFFSET = 0.03;
// 板の枚数がこれ未満の気配は「見せ板」として無いものとみなす(枚数は 1e6 = 1株)
const MIN_SIZE_SHARES = 5;
const FILL_BINS = [Infinity, 300, 120, 60, 30, 10, 0];

async function* readRows(dataDir, days) {
  const files = fs.readdirSync(dataDir).filter((f) => /^\d{4}-\d{2}-\d{2}\.jsonl(\.gz)?$/.test(f)).sort().slice(-days);
  for (const f of files) {
    const p = path.join(dataDir, f);
    const input = f.endsWith('.gz') ? fs.createReadStream(p).pipe(zlib.createGunzip()) : fs.createReadStream(p);
    const rl = readline.createInterface({ input, crlfDelay: Infinity });
    for await (const line of rl) {
      if (!line) continue;
      try { yield JSON.parse(line); } catch {}
    }
  }
}

const bucketOf = (tau, edges) => { for (let i = 0; i < edges.length - 1; i++) if (tau <= edges[i] && tau > edges[i + 1]) return `${edges[i]}〜${edges[i + 1]}s`; return null; };

class Acc {
  constructor() { this.n = 0; this.nMid = 0; this.nTwap = 0; this.bMid = 0; this.bPoint = 0; this.bTwap = 0; this.opp = 0; this.twoSided = 0; this.oneSided = 0; this.empty = 0; this.extreme = 0; this.midRight = 0; this.ageSum = 0; this.ageN = 0; }
  // Brier は「その確率が存在する行」だけで平均する(無い行を0として混ぜない)
  add(y, r, pTwap, opp) {
    this.n++;
    const two = r.bid !== null && r.ask !== null, one = !two && (r.bid !== null || r.ask !== null);
    if (two) this.twoSided++; else if (one) this.oneSided++; else this.empty++;
    if (two) { this.nMid++; this.bMid += (r.mid - y) ** 2; if ((r.mid > 0.5) === (y === 1)) this.midRight++; if (Math.max(r.bid, 1 - r.ask) >= 0.98) this.extreme++; }
    this.bPoint += (r.p - y) ** 2;
    if (pTwap !== null && Number.isFinite(pTwap)) { this.nTwap++; this.bTwap += (pTwap - y) ** 2; }
    if (opp) this.opp++;
    if (r.bookAgeMs !== null && r.bookAgeMs !== undefined) {
      this.ageSum += r.bookAgeMs; this.ageN++; if (r.bookAgeMs > 30000) this.stale = (this.stale || 0) + 1;
      // 直近1時間だけの鮮度(購読の修正が効いているかを見る)
      if (r.t >= Date.now() - 3600000) { this.recentN = (this.recentN || 0) + 1; if (r.bookAgeMs > 30000) this.recentStale = (this.recentStale || 0) + 1; }
    }
  }
  out() {
    const d = (a, b) => (b ? +(a / b).toFixed(4) : null);
    return { n: this.n, brierMid: d(this.bMid, this.nMid), brierPoint: d(this.bPoint, this.n), brierTwap: d(this.bTwap, this.nTwap), oppRate: d(this.opp, this.n),
      twoSided: d(this.twoSided, this.n), oneSided: d(this.oneSided, this.n), empty: d(this.empty, this.n), extreme: d(this.extreme, this.nMid), midRight: d(this.midRight, this.nMid), bookAgeMs: this.ageN ? Math.round(this.ageSum / this.ageN) : null, stale: d(this.stale || 0, this.ageN), recentStale: this.recentN ? d(this.recentStale || 0, this.recentN) : null, recentN: this.recentN || 0 };
  }
}

// since を渡すと、それ以降の理論行・約定・決済だけで集計する(購読修正後だけを見る等)
export async function runBacktest({ dataDir, days = 3, since = 0 }) {
  const markets = new Map(); // slug -> { kind, asset, expiryTs, K, up, theo: [], fills: [] }
  const cex = { btc: new Map(), eth: new Map() }; // asset -> sec -> price
  const oracle = new Map(); // slug -> [{sec, v}]
  let rows = 0;
  for await (const r of readRows(dataDir, days)) {
    rows++;
    if (r.type === 'market') {
      const m = markets.get(r.slug) ?? { slug: r.slug, theo: [], fills: [], up: null };
      Object.assign(m, { kind: r.kind ?? m.kind, asset: r.asset ?? m.asset, expiryTs: r.expiryTs ?? m.expiryTs, K: r.openPrice ?? m.K });
      markets.set(r.slug, m);
    } else if (r.type === 'summary') {
      const m = markets.get(r.slug); if (m) { m.up = r.up; if (r.K) m.K = r.K; }
    } else if (r.type === 'open_price') {
      const m = markets.get(r.slug); if (m && m.K === null) m.K = r.K;
    } else if (r.type === 'theo') {
      const m = markets.get(r.slug);
      if (m && r.t >= since) {
        // 見せ板(極小枚数)は無いものとして扱う。枚数が記録されていない古い行はそのまま
        const bid = r.bidSize !== null && r.bidSize !== undefined && r.bidSize / 1e6 < MIN_SIZE_SHARES ? null : r.bid;
        const ask = r.askSize !== null && r.askSize !== undefined && r.askSize / 1e6 < MIN_SIZE_SHARES ? null : r.ask;
        const mid = bid !== null && ask !== null ? (bid + ask) / 2 : null;
        m.theo.push({ t: r.t, tau: r.tauSec, S: r.S, K: r.K, sigma1h: r.sigma1h, p: r.pTheo, bid, ask, mid, bookAgeMs: r.bookAgeMs ?? null });
      }
    } else if (r.type === 'cex') {
      if (cex[r.asset]) cex[r.asset].set(Math.floor((r.srcTs ?? r.t) / 1000), r.price);
    } else if (r.type === 'oracle') {
      if (!r.slug) continue;
      const a = oracle.get(r.slug) ?? []; a.push({ sec: Math.floor((r.srcTs ?? r.t) / 1000), v: r.price }); oracle.set(r.slug, a);
    } else if (r.type === 'fill') {
      const m = markets.get(r.slug); if (m && r.price !== null && (r.blockTime ?? r.t) >= since) m.fills.push({ t: r.blockTime ?? r.t, outcome: r.outcome, side: r.makerSide, price: r.price, shares: r.shares, usdc: r.usdc ?? 0, secToExpiry: r.secToExpiry ?? null, kind: r.kind ?? null });
    }
  }

  const meanCex = (asset, from, to) => { let s = 0, n = 0; for (let x = from; x < to; x++) { const v = cex[asset].get(x); if (v !== undefined) { s += v; n++; } } return n >= (to - from) * 0.5 ? s / n : null; };
  const oracleAt = (slug, sec) => { const a = oracle.get(slug); if (!a) return null; let best = null; for (const o of a) { if (o.sec <= sec && o.sec >= sec - 3) best = o.v; if (o.sec > sec) break; } return best; };

  // 「YES を q 以下で買えたか」: q 以下で YES が売られた、または NO が 1−q 以上で買われた約定が、signal 以降・満期前にあるか
  const makerFilled = (m, wantYes, q, sinceT) => m.fills.some((f) => f.t >= sinceT && f.t < m.expiryTs && (wantYes
    ? ((f.outcome === 'YES' && f.side === 'SELL' && f.price <= q) || (f.outcome === 'NO' && f.side === 'BUY' && 1 - f.price <= q))
    : ((f.outcome === 'NO' && f.side === 'SELL' && f.price <= q) || (f.outcome === 'YES' && f.side === 'BUY' && 1 - f.price <= q))));

  // 約定が満期の何秒前に集中しているか(種別ごと)。板が「いつ存在するか」を知る
  const fillDist = {};
  for (const m of markets.values()) for (const f of m.fills) {
    if (f.secToExpiry === null) continue;
    const k = /min/.test(m.kind ?? '') ? 'short' : 'hourly';
    const d = fillDist[k] ?? (fillDist[k] = {});
    let label = null; for (let i = 0; i < FILL_BINS.length - 1; i++) if (f.secToExpiry <= FILL_BINS[i] && f.secToExpiry > FILL_BINS[i + 1]) { label = `${FILL_BINS[i] === Infinity ? '300+' : FILL_BINS[i] + '〜' + FILL_BINS[i + 1]}s`; break; }
    if (!label) continue;
    const b = d[label] ?? (d[label] = { n: 0, usdc: 0 }); b.n++; b.usdc += f.usdc;
  }
  const report = { rows, days, since, generatedAt: Date.now(), samples: [], fillDist, makerByBucket: {}, short: { markets: 0, buckets: {}, taker: { twap: { n: 0, pnl: 0, wins: 0 }, point: { n: 0, pnl: 0, wins: 0 } }, maker: { twap: { signals: 0, filled: 0, pnl: 0, wins: 0 } } },
    hourly: { markets: 0, buckets: {}, taker: { point: { n: 0, pnl: 0, wins: 0 } }, maker: { point: { signals: 0, filled: 0, pnl: 0, wins: 0 } } } };

  for (const m of markets.values()) {
    if (m.up === null || m.up === undefined || !m.K || !m.expiryTs || m.theo.length === 0) continue;
    const y = m.up;
    const isShort = /min/.test(m.kind ?? '');
    const R = isShort ? report.short : report.hourly;
    R.markets++;
    m.theo.sort((a, b) => a.t - b.t);
    let takerDone = { twap: false, point: false }, makerDone = {};
    for (const r of m.theo) {
      const tau = (m.expiryTs - r.t) / 1000;
      if (tau <= 0 || r.p === null) continue;
      let pTwap = null;
      if (isShort && tau <= 120) {
        const sec = Math.floor(r.t / 1000);
        const tw = oracleAt(m.slug, sec);
        const pNow = cex[m.asset]?.get(sec) ?? cex[m.asset]?.get(sec - 1) ?? null;
        const sigSec = (r.sigma1h ?? 0.0045) / 60;
        if (tw !== null && pNow !== null) {
          let Phat, sig;
          if (tau < 1) {
            Phat = tw; sig = pNow * sigSec * 0.1; // ほぼ確定。同値は Up
          } else if (tau <= 60) {
            const old = meanCex(m.asset, sec - 60, sec - 60 + Math.round(tau));
            if (old !== null) { Phat = tw + (tau / 60) * (pNow - old); sig = pNow * sigSec * Math.sqrt(tau ** 3 / 3) / 60; }
          } else {
            const b = tw - (meanCex(m.asset, sec - 60, sec) ?? pNow);
            Phat = pNow + b; sig = pNow * sigSec * Math.sqrt(tau - 40);
          }
          if (Phat !== undefined && sig > 0) pTwap = normCdf((Phat - m.K) / sig);
        }
      }
      const edges = isShort ? [120, 60, 30, 10, 0] : [3600, 1800, 600, 120, 0];
      const b = bucketOf(tau, edges);
      if (b) {
        const acc = R.buckets[b] ?? (R.buckets[b] = new Acc());
        const pRef = isShort ? (pTwap ?? r.p) : r.p;
        const opp = (r.ask !== null && pRef - r.ask >= TAKER_EDGE) || (r.bid !== null && r.bid - pRef >= TAKER_EDGE);
        acc.add(y, r, pTwap, opp);
        // 見本: 板の中値が大きく外れている行を数件残す(何が起きているかを目で確かめる)
        if (isShort && tau <= 60 && r.bid !== null && r.ask !== null && Math.abs(r.mid - y) > 0.4 && report.samples.length < 12) report.samples.push({ slug: m.slug, tau: Math.round(tau), bid: r.bid, ask: r.ask, mid: r.mid, pPoint: +r.p.toFixed(3), pTwap: pTwap === null ? null : +pTwap.toFixed(3), S: r.S, K: r.K, up: y, bookAgeMs: r.bookAgeMs });
      }
      // テイカー: 最初の合図で1回だけ
      for (const [name, pp] of [['twap', pTwap], ['point', r.p]]) {
        if (pp === null || takerDone[name] || !R.taker[name]) continue;
        if (isShort ? tau > 120 : tau <= 120) continue;
        if (r.ask !== null && pp - r.ask >= TAKER_EDGE) { const pnl = y - r.ask - r.ask * TAKER_FEE; R.taker[name].n++; R.taker[name].pnl += pnl; if (pnl > 0) R.taker[name].wins++; takerDone[name] = true; }
        else if (r.bid !== null && r.bid - pp >= TAKER_EDGE) { const cost = 1 - r.bid; const pnl = (1 - y) - cost - cost * TAKER_FEE; R.taker[name].n++; R.taker[name].pnl += pnl; if (pnl > 0) R.taker[name].wins++; takerDone[name] = true; }
      }
      // メイカー: 確率 ≥ 0.9 の側に「確率 − 3¢」で指値(市場ごとに1回)
      // メイカー模擬: 帯ごとに「確率 ≥ 0.9 の側へ確率−3¢で指値」を最初の合図で1回。約定は逆側約定で近似
      const pm = isShort ? (pTwap ?? r.p) : r.p; const M = isShort ? R.maker.twap : R.maker.point;
      const mbEdges = isShort ? [300, 120, 60, 30, 0] : [3600, 1800, 600, 120, 0];
      const mb = bucketOf(tau, mbEdges);
      if (pm !== null && Number.isFinite(pm) && mb && !makerDone[mb] && (isShort || tau > 120)) {
        const key = `${isShort ? '案1' : '案2'} ${mb}`;
        const B = report.makerByBucket[key] ?? (report.makerByBucket[key] = { signals: 0, filled: 0, pnl: 0, wins: 0 });
        const want = pm >= 0.9 ? true : pm <= 0.1 ? false : null;
        if (want !== null) {
          const q = +((want ? pm : 1 - pm) - MAKER_OFFSET).toFixed(2);
          makerDone[mb] = true; B.signals++; M.signals++;
          if (makerFilled(m, want, q, r.t)) { const pnl = (want ? y : 1 - y) - q; B.filled++; B.pnl += pnl; if (pnl > 0) B.wins++; M.filled++; M.pnl += pnl; if (pnl > 0) M.wins++; }
        }
      }
    }
  }
  for (const R of [report.short, report.hourly]) for (const k of Object.keys(R.buckets)) R.buckets[k] = R.buckets[k].out();
  return report;
}

export function formatBacktest(rep) {
  const f = (v) => (v === null || v === undefined ? '-' : v);
  const lines = [`[検証] 対象=${rep.days}日分 行数=${rep.rows.toLocaleString()} 5分/15分市場=${rep.short.markets}件 1時間市場=${rep.hourly.markets}件 (Brier: 小さいほど当たる。板=中値、1点=今の理論、TWAP=案1)`];
  lines.push('  案1 5分/15分 満期前(残り秒) | 行数 | 板 | 1点 | TWAP | 2¢超 | 両側板 | 片側 | 空 | 板が0.98超 | 板の正解率 | 板の鮮度ms | 30秒超の古さ | 直近1hの古さ(行数)');
  for (const [k, v] of Object.entries(rep.short.buckets)) lines.push(`    ${k.padEnd(10)} | ${String(v.n).padStart(6)} | ${f(v.brierMid)} | ${f(v.brierPoint)} | ${f(v.brierTwap)} | ${f(v.oppRate)} | ${f(v.twoSided)} | ${f(v.oneSided)} | ${f(v.empty)} | ${f(v.extreme)} | ${f(v.midRight)} | ${f(v.bookAgeMs)} | ${f(v.stale)} | ${f(v.recentStale)}(${v.recentN})`);
  for (const x of rep.samples) lines.push(`    見本: ${x.slug} 残り${x.tau}s 買${x.bid}/売${x.ask} 中値${x.mid} 1点${x.pPoint} TWAP${x.pTwap} S=${x.S} K=${x.K} 結果=${x.up ? 'Up' : 'Down'} 鮮度=${x.bookAgeMs}ms`);
  for (const [k, d] of Object.entries(rep.fillDist)) lines.push(`    約定の満期前分布(${k === 'short' ? '5分/15分' : '1時間'}): ` + Object.entries(d).map(([b, v]) => `${b}=${v.n}件/$${Math.round(v.usdc)}`).join(' '));
  for (const [k, v] of Object.entries(rep.makerByBucket)) lines.push(`    メイカー模擬 ${k}: 合図=${v.signals} 約定近似=${v.filled} 損益=${v.pnl.toFixed(3)}/株 勝率=${v.filled ? Math.round(v.wins / v.filled * 100) : '-'}%`);
  const t = rep.short.taker, mk = rep.short.maker.twap;
  lines.push(`    テイカー(2¢超で1回): TWAP n=${t.twap.n} 損益=${t.twap.pnl.toFixed(3)}/株 勝率=${t.twap.n ? Math.round(t.twap.wins / t.twap.n * 100) : '-'}% | 1点 n=${t.point.n} 損益=${t.point.pnl.toFixed(3)}/株 勝率=${t.point.n ? Math.round(t.point.wins / t.point.n * 100) : '-'}%`);
  lines.push(`    メイカー(確率−3¢に指値): 合図=${mk.signals} 約定近似=${mk.filled} 損益=${mk.pnl.toFixed(3)}/株 勝率=${mk.filled ? Math.round(mk.wins / mk.filled * 100) : '-'}%`);
  lines.push('  案2 1時間 満期前(残り秒) | 行数 | 板 | 1点 | 2¢超 | 両側板 | 片側 | 空 | 板の正解率 | 板の鮮度ms | 30秒超の古さ | 直近1hの古さ(行数)');
  for (const [k, v] of Object.entries(rep.hourly.buckets)) lines.push(`    ${k.padEnd(10)} | ${String(v.n).padStart(6)} | ${f(v.brierMid)} | ${f(v.brierPoint)} | ${f(v.oppRate)} | ${f(v.twoSided)} | ${f(v.oneSided)} | ${f(v.empty)} | ${f(v.midRight)} | ${f(v.bookAgeMs)} | ${f(v.stale)} | ${f(v.recentStale)}(${v.recentN})`);
  const h = rep.hourly.taker.point, hm = rep.hourly.maker.point;
  lines.push(`    テイカー(2¢超で1回): n=${h.n} 損益=${h.pnl.toFixed(3)}/株 勝率=${h.n ? Math.round(h.wins / h.n * 100) : '-'}%`);
  lines.push(`    メイカー(確率−3¢に指値): 合図=${hm.signals} 約定近似=${hm.filled} 損益=${hm.pnl.toFixed(3)}/株 勝率=${hm.filled ? Math.round(hm.wins / hm.filled * 100) : '-'}%`);
  return lines.join('\n');
}
