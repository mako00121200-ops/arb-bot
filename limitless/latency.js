// 遅延の統計。直近 windowMs のサンプルから p50 / p95 / 最大 を出す。
// 「注文を送れる速さ」を実弾なしで見積もるための材料(HTTPの往復、WSの受信遅れ)。
export class LatencyStats {
  constructor(windowMs = 5 * 60000) {
    this.windowMs = windowMs;
    this.samples = new Map(); // key -> [{t, ms}]
  }
  push(key, ms) {
    if (!Number.isFinite(ms)) return;
    const arr = this.samples.get(key) ?? [];
    arr.push({ t: Date.now(), ms });
    // 古いものを落とす(先頭から)
    const cutoff = Date.now() - this.windowMs;
    let i = 0;
    while (i < arr.length && arr[i].t < cutoff) i++;
    if (i > 0) arr.splice(0, i);
    this.samples.set(key, arr);
  }
  summary() {
    const out = {};
    for (const [key, arr] of this.samples) {
      if (arr.length === 0) continue;
      const v = arr.map((x) => x.ms).sort((a, b) => a - b);
      const q = (p) => v[Math.min(v.length - 1, Math.floor(p * (v.length - 1)))];
      out[key] = { n: v.length, p50: Math.round(q(0.5)), p95: Math.round(q(0.95)), max: Math.round(v[v.length - 1]) };
    }
    return out;
  }
  format() {
    return Object.entries(this.summary()).map(([k, s]) => `${k} p50=${s.p50}ms p95=${s.p95}ms (n=${s.n})`).join(' / ') || 'なし';
  }
}
