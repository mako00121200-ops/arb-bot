// scripts/chain-throttle.js
//
// チェーンごとに「読み取りエラーが続いたら、そのチェーンだけ観測間隔を
// 自動的に空ける」仕組み。
//
// RPCの事情はチェーンごとに違う:
//   Base       … Chainstackの自前ノード(安定)
//   Polygon    … 公開RPC(1rpc.io。過去に403を返した実績あり)
//   Optimism   … 公式の公開RPC
//   Avalanche  … 公式の公開RPC
// 公開RPCが制限に当たっても、Baseの速度を巻き添えで落とさないよう、
// チェーン単位で独立に判断する。
//
// 連続失敗で待ち時間を倍にしていき(最大2分)、成功したら即座に元へ戻す。

const BASE_BACKOFF_MS = 10_000;
const MAX_BACKOFF_MS = 120_000;
const FAILURES_BEFORE_BACKOFF = 3;

const state = new Map(); // chain -> { failures, skipUntil }

function get(chain) {
  const key = (chain || "").toLowerCase();
  if (!state.has(key)) state.set(key, { failures: 0, skipUntil: 0 });
  return state.get(key);
}

/// このチェーンを今回はスキップすべきか(直前の失敗で待機中か)。
export function shouldSkipChain(chain) {
  return Date.now() < get(chain).skipUntil;
}

export function recordChainSuccess(chain) {
  const s = get(chain);
  if (s.failures > 0) {
    console.log(`[観測調整] ${chain}: 復帰しました(通常間隔に戻します)`);
  }
  s.failures = 0;
  s.skipUntil = 0;
}

export function recordChainFailure(chain, reason) {
  const s = get(chain);
  s.failures++;
  if (s.failures < FAILURES_BEFORE_BACKOFF) return;

  const extraSteps = s.failures - FAILURES_BEFORE_BACKOFF;
  const waitMs = Math.min(BASE_BACKOFF_MS * Math.pow(2, extraSteps), MAX_BACKOFF_MS);
  s.skipUntil = Date.now() + waitMs;
  console.log(`[観測調整] ${chain}: ${s.failures}回連続で読み取り失敗のため、${Math.round(waitMs / 1000)}秒間このチェーンの高速観測を休みます(${(reason || "").slice(0, 60)})`);
}

export function getThrottleStatus() {
  const now = Date.now();
  const out = {};
  for (const [chain, s] of state.entries()) {
    out[chain] = {
      failures: s.failures,
      pausedForSec: s.skipUntil > now ? Math.ceil((s.skipUntil - now) / 1000) : 0,
    };
  }
  return out;
}
