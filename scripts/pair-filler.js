// scripts/pair-filler.js
//
// **「経路が無い」と落ちた通貨の組を、ファクトリーに聞いて地図に足す。**
//
// [なぜ要るか(2026年9月22日、オーナーの指示)]
// UniswapX の計測で、base は新しい注文81件のうち **68件(84%)が「経路なし」**
// で落ちていた。我々のプール地図にその組が無いだけで、
// **UniswapX で起きていることの16%しか見ていなかった。**
// $10.56 という数字は、その16%の中の話でしかない。
//
// [やり方]
// プールを探し回るのではなく、**足りないと分かっている組だけ**をファクトリーに聞く。
// 総当たりの発見(pool-scout.js)とは逆向きで、はるかに安い。
//
//   足りない組(注文額の大きい順)
//     → そのチェーンの V3 ファクトリー全部に getPool(tokenA, tokenB, 手数料帯)
//     → 見つかったものを地図に登録(source="scout")
//     → 準備量と桁数は既存の定期処理が読む(updatedAt=0 がその合図)
//
// [歯止め]
//   ・1回に扱う組の数に上限(PAIR_FILL_MAX_PER_RUN)
//   ・一度扱った組は覚えておき、**見つからなくても再訪しない**(無駄な問い合わせの防止)
//   ・枠が苦しい時は動かさない(呼ぶ側が判断)
//   ・**静かなプールは既存の evictQuietScoutPools が24時間で外す**ので、
//     ゴミを足しても溜まり続けない
//
// [環境変数]
//   PAIR_FILL_ENABLED       … "false" で止める
//   PAIR_FILL_MAX_PER_RUN   … 1回に扱う組の数(既定3)
//   PAIR_FILL_MIN_USD       … これ未満の組は足さない(既定$100)

import { ethers } from "ethers";
import { V3_FACTORIES } from "./v3-pools.js";
import { findV3PoolsBatch } from "./multicall-reserves.js";
import { registerPool, getPoolsForPair, KIND_V3 } from "./pool-registry.js";
import { getMissingPairs, forgetMissingPair } from "./uniswapx-probe.js";
import { loadState, saveState } from "./state-file.js";
import { getLastRpcUsage } from "./rpc-usage.js";

const ENABLED = process.env.PAIR_FILL_ENABLED !== "false";
const MAX_PER_RUN = parseInt(process.env.PAIR_FILL_MAX_PER_RUN || "3", 10);
/// これ未満の注文額しか無い組は足さない(ガス代に対して小さすぎる)。
const MIN_USD = Number(process.env.PAIR_FILL_MIN_USD || "100");
/// V3 の手数料帯。ファクトリーに聞く時の候補。
const FEE_TIERS = [100, 500, 3000, 10000];
/// 枠の月末見込がこれを超えたら、この回は1組も足さない
/// (`pool-scout.js` の SCOUT_QUOTA_STOP_PCT と同じ考え方)。
const QUOTA_STOP_PCT = parseFloat(process.env.PAIR_FILL_QUOTA_STOP_PCT || "70");

/// 枠が危ないか。**発見と同じ歯止めをここにも置く。**
function quotaTooTight() {
  const u = getLastRpcUsage();
  return Boolean(u && Number.isFinite(u.projectedPercent) && u.projectedPercent >= QUOTA_STOP_PCT);
}

const STATE_NAME = "pair-filler.json";
const STATE_VERSION = 1;

/// 一度扱った組(見つかった / 見つからなかった の両方)。**再訪しない。**
const tried = new Map(); // `${chain}|${t0}|${t1}` -> { at, found }
const stats = { runs: 0, pairsTried: 0, poolsAdded: 0, notFound: 0, errors: 0 };

function key(chain, a, b) {
  const [t0, t1] = [a.toLowerCase(), b.toLowerCase()].sort();
  return `${chain}|${t0}|${t1}`;
}

(function restore() {
  const d = loadState(STATE_NAME, STATE_VERSION);
  if (!d) return;
  for (const [k, v] of Object.entries(d.tried || {})) {
    if (v && Number.isFinite(Number(v.at))) tried.set(k, { at: Number(v.at), found: Number(v.found) || 0 });
  }
  for (const k of Object.keys(stats)) {
    const n = Number(d.stats?.[k]);
    if (Number.isFinite(n)) stats[k] = n;
  }
  if (tried.size > 0) console.log(`[組を足す] 前回までに調べた ${tried.size}組 を読み戻しました`);
})();

function persist() {
  saveState(STATE_NAME, STATE_VERSION, { tried: Object.fromEntries(tried), stats });
}

/// 1つの組について、そのチェーンの V3 ファクトリー全部に聞く。
/// @returns 地図に足したプールの数
async function fillPair(chain, tokenA, tokenB) {
  const factories = V3_FACTORIES[chain] || [];
  if (factories.length === 0) return 0;
  // **token0 は住所の小さい方**(Uniswap 系の規則。計算で分かるので問い合わせない)。
  const [t0, t1] = [tokenA.toLowerCase(), tokenB.toLowerCase()].sort();
  let added = 0;

  for (const f of factories) {
    // Algebra は手数料帯を持たない(プールは組につき1つ)。
    const reqs = f.style === "algebra"
      ? [{ tokenA: t0, tokenB: t1 }]
      : FEE_TIERS.map((feeTier) => ({ tokenA: t0, tokenB: t1, feeTier }));
    let addrs;
    try {
      addrs = await findV3PoolsBatch(chain, f.address, f.style, reqs);
    } catch (e) { stats.errors++; continue; }
    addrs.forEach((a, i) => {
      if (!a || a === ethers.ZeroAddress) return;
      const addr = a.toLowerCase();
      // 既に地図にあるものは触らない(手書き由来を "scout" で上書きしない)。
      if (getPoolsForPair(chain, t0, t1).some((p) => p.address.toLowerCase() === addr)) return;
      const feeTier = reqs[i].feeTier ?? null;
      registerPool({
        chain, address: addr, dexId: f.dexId, factory: f.address, kind: KIND_V3,
        token0: t0, token1: t1,
        feeTier,
        // V3 は手数料帯がそのまま手数料。100 = 0.01% = 1bps。
        feeBps: feeTier != null ? feeTier / 100 : 30,
        // 探索由来の印。**静かなら24時間で自動的に外れる。**
        source: "scout",
        // 準備量・桁数・V3の状態は、この後の定期処理がまとめて読む。
        updatedAt: 0,
      });
      added++;
    });
  }
  return added;
}

/// 1周ぶん。**足りないと分かっている組だけを、価値の高い順に埋める。**
export async function fillMissingPairsOnce(activeChains = []) {
  if (!ENABLED) return;
  if (quotaTooTight()) {
    const u = getLastRpcUsage();
    console.warn(`[組を足す] 枠の月末見込が${u.projectedPercent.toFixed(0)}%(上限${QUOTA_STOP_PCT}%)のため、今回は足しません`);
    return;
  }
  stats.runs++;
  const wanted = getMissingPairs(50).filter((p) =>
    activeChains.includes(p.chain) && p.usd >= MIN_USD && !tried.has(key(p.chain, p.tokenIn, p.tokenOut)));
  if (wanted.length === 0) return;

  let done = 0;
  for (const p of wanted) {
    if (done >= MAX_PER_RUN) break;
    const k = key(p.chain, p.tokenIn, p.tokenOut);
    let found = 0;
    try {
      found = await fillPair(p.chain, p.tokenIn, p.tokenOut);
    } catch (e) { stats.errors++; }
    // **見つからなくても覚える。** 無いものを何度も聞きに行かない。
    tried.set(k, { at: Date.now(), found });
    stats.pairsTried++;
    done++;
    if (found > 0) {
      stats.poolsAdded += found;
      // 地図に載ったので控えから消す(同じ組で何度も数えない)。
      forgetMissingPair(p.chain, p.tokenIn, p.tokenOut);
      console.log(`[組を足す] ${p.chain} ${p.tokenIn.slice(0, 10)}…→${p.tokenOut.slice(0, 10)}…`
        + `(注文$${p.usd.toFixed(0)}/${p.n}件): **V3プール${found}本を地図に追加**`);
    } else {
      stats.notFound++;
      console.log(`[組を足す] ${p.chain} ${p.tokenIn.slice(0, 10)}…→${p.tokenOut.slice(0, 10)}…`
        + `(注文$${p.usd.toFixed(0)}/${p.n}件): ファクトリーに**プールなし**。以後は聞かない`);
    }
  }
  persist();
}

export function formatPairFillLine() {
  if (stats.pairsTried === 0) return "";
  return ` 組を足す[調べた${stats.pairsTried}組 追加${stats.poolsAdded}本 無し${stats.notFound}${stats.errors ? ` 失敗${stats.errors}` : ""}]`;
}

export function flushPairFiller() { persist(); return true; }
export function getPairFillStats() { return { ...stats, tried: tried.size }; }
