// 正規分布と1時間 Up/Down の理論価格。collector と backtest の両方から使う
function erf(x) {
  const sign = x < 0 ? -1 : 1;
  x = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * x);
  const y = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
  return sign * y;
}
export function normCdf(z) {
  return 0.5 * (1 + erf(z / Math.SQRT2));
}
// S=現在値, K=始値, sigma1h=1時間σ(対数), tauSec=残り秒
export function theoUp(S, K, sigma1h, tauSec) {
  if (!(S > 0) || !(K > 0) || !(sigma1h > 0)) return null;
  const tauH = Math.max(tauSec, 1) / 3600;
  const z = Math.log(S / K) / (sigma1h * Math.sqrt(tauH));
  return { p: normCdf(z), z };
}
