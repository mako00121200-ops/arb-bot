// scripts/storm-mode.js
//
// **嵐モード(第1段: 記録だけ)。** 値動きの嵐を見つけ、嵐の間に見送った機会を
// 少し後にチェーンへ聞き直して「撃ち直していれば取れたか」を数える。
// **送信しない・ガスを払わない・お金は動かない。**
//
// [なぜ(2026年9月25日、オーナーの承認「両方始めてください」)]
// avalanche の嵐(9/25 06:29〜07:59 JST)で裁定は1.5時間 +$4.00(普段の20日分)を取ったが、
// 大物197件のうち実際に取れたのは約3%。逃した理由は
//   無効なプール92 / 同じ経路を送信中33 / 同じプールが使用中29 / 送信直前で見送り27。
// 嵐の時だけ「1本ずつ・同じプールは1本だけ」という平時の安全策が取り逃がしの原因なら、
// 嵐の時だけ緩める価値がある。だが**実測なしに緩めると損をする**ので、まず数える。
//
// [嵐の判定] チェーンごとに、下限以上の黒字の機会が直近 STORM_WINDOW_MS(既定10分)に
// STORM_MIN_HITS(既定20)件以上あれば嵐。平時の件数は分からないので、
// 生存ログに「直近の件数 / これまでの最多」を出して、しきい値を実測で合わせる。
//
// [聞き直し] 嵐の間だけ、見送った機会を STORM_RECHECK_DELAY_MS(既定1.5秒)後に
// 本番と同じ simulateRoute(eth_call)で確認する。RPC の枠を守るため、
// チェーンごとに同時1本・STORM_MIN_INTERVAL_MS(既定2秒)間隔・同じ経路は30秒に1回まで。
//
// 使い方: 既定で有効。止めるなら STORM_SHADOW=false

import { loadState, saveState } from "./state-file.js";
import { stormShadowSimulate } from "./execute-opportunity.js";
import { nowJst } from "./jst.js";

const ENABLED = process.env.STORM_SHADOW !== "false";
const WINDOW_MS = parseInt(process.env.STORM_WINDOW_MS || String(10 * 60 * 1000), 10);
const MIN_HITS = parseInt(process.env.STORM_MIN_HITS || "20", 10);
const RECHECK_DELAY_MS = parseInt(process.env.STORM_RECHECK_DELAY_MS || "1500", 10);
const MIN_INTERVAL_MS = parseInt(process.env.STORM_MIN_INTERVAL_MS || "2000", 10);
const SAME_ROUTE_MS = 30 * 1000;

/// 聞き直す見送りの理由(big-opportunities の OUTCOME_LABEL と同じ言葉)。
export const STORM_REASONS = {
  disabled: "無効",
  cooldown: "冷却",
  executing: "同経路",
  send_busy: "同プール/上限",
  not_sent: "見送",
};

const STATE_NAME = "storm-mode.json";
const STATE_VERSION = 1;

/// チェーンごとの状態。hits は直近の黒字の時刻の列。
const chains = new Map();
function entry(chain) {
  let e = chains.get(chain);
  if (!e) {
    e = { hits: [], peak: 0, storms: 0, inStorm: false, stormFrom: 0, lastAt: 0, busy: false, byReason: {} };
    chains.set(chain, e);
  }
  return e;
}
function reasonEntry(e, reason) {
  if (!e.byReason[reason]) e.byReason[reason] = { tried: 0, real: 0, realUsd: 0, gasLoss: 0, loss: 0, rejected: 0, errors: 0 };
  return e.byReason[reason];
}
const recentRoutes = new Map();

(function restore() {
  const d = loadState(STATE_NAME, STATE_VERSION);
  if (!d) return;
  for (const [chain, v] of Object.entries(d)) {
    const e = entry(chain);
    e.peak = Number(v?.peak) || 0;
    e.storms = Number(v?.storms) || 0;
    for (const [r, x] of Object.entries(v?.byReason || {})) {
      const re = reasonEntry(e, r);
      for (const k of Object.keys(re)) if (Number.isFinite(Number(x?.[k]))) re[k] = Number(x[k]);
    }
  }
})();

let lastSavedAt = 0;
function persist(force = false) {
  if (!force && Date.now() - lastSavedAt < 60 * 1000) return;
  lastSavedAt = Date.now();
  const out = {};
  for (const [chain, e] of chains) out[chain] = { peak: e.peak, storms: e.storms, byReason: e.byReason };
  try { saveState(STATE_NAME, STATE_VERSION, out); } catch (e) {}
}
export function flushStormMode() { persist(true); }

function prune(e, now) {
  while (e.hits.length && now - e.hits[0] > WINDOW_MS) e.hits.shift();
}

/// 下限以上の黒字の機会を1件見つけたら呼ぶ(RPC は使わない)。
export function noteStormHit(opp) {
  if (!ENABLED || !opp?.chain) return;
  const now = Date.now();
  const e = entry(opp.chain);
  e.hits.push(now);
  prune(e, now);
  if (e.hits.length > e.peak) e.peak = e.hits.length;
  if (!e.inStorm && e.hits.length >= MIN_HITS) {
    e.inStorm = true; e.stormFrom = now; e.storms++;
    console.log(`[嵐] ${opp.chain}: **嵐に入った**(直近${Math.round(WINDOW_MS / 60000)}分で黒字${e.hits.length}件)。見送った機会を送らずに聞き直して数えます`);
    persist(true);
  }
}

export function isStorm(chain) {
  const e = chains.get(chain);
  if (!e) return false;
  prune(e, Date.now());
  if (e.inStorm && e.hits.length < Math.max(1, Math.floor(MIN_HITS / 2))) {
    e.inStorm = false;
    const min = Math.round((Date.now() - e.stormFrom) / 60000);
    console.log(`[嵐] ${chain}: 嵐が終わった(${min}分)。${formatReasons(e)}`);
    persist(true);
  }
  return e.inStorm;
}

/// 嵐の間に見送った機会を、少し後にチェーンへ聞き直す(待たない。送らない)。
export function noteStormSkip(opp, reason) {
  if (!ENABLED || !opp?.chain || !STORM_REASONS[reason]) return;
  if (!isStorm(opp.chain)) return;
  const e = entry(opp.chain);
  const now = Date.now();
  if (e.busy || now - e.lastAt < MIN_INTERVAL_MS) return;
  const routeKey = `${opp.chain}|${(opp.poolAddresses || []).join("|").toLowerCase()}`;
  const seen = recentRoutes.get(routeKey);
  if (seen && now - seen < SAME_ROUTE_MS) return;
  recentRoutes.set(routeKey, now);
  if (recentRoutes.size > 2000) {
    for (const [k, t] of recentRoutes) if (now - t > SAME_ROUTE_MS) recentRoutes.delete(k);
  }
  e.busy = true; e.lastAt = now;
  const t = setTimeout(async () => {
    const re = reasonEntry(e, reason);
    re.tried++;
    try {
      const r = await stormShadowSimulate(opp);
      if (r.status === "skip") { re.tried--; return; }
      if (r.status === "real") {
        re.real++; re.realUsd += r.netUsd;
        console.log(`[嵐/影の確認] ${opp.chain} ${opp.label}: 見送り(${STORM_REASONS[reason]})の${(RECHECK_DELAY_MS / 1000).toFixed(1)}秒後でも**本物** 純利$${r.netUsd.toFixed(4)}(模型$${(Number(opp.netProfitUsd) || 0).toFixed(4)})。送らない`);
      } else if (r.status === "gas_loss") re.gasLoss++;
      else if (r.status === "loss") re.loss++;
      else re.rejected++;
    } catch (err) {
      re.errors++;
    } finally {
      e.busy = false;
      persist();
    }
  }, RECHECK_DELAY_MS);
  if (typeof t.unref === "function") t.unref();
}

function formatReasons(e) {
  const parts = [];
  for (const [r, x] of Object.entries(e.byReason)) {
    if (!x.tried) continue;
    parts.push(`${STORM_REASONS[r] || r} 試${x.tried} 本物${x.real}($${x.realUsd.toFixed(2)}) ガス負${x.gasLoss} 赤${x.loss} 拒${x.rejected}${x.errors ? ` 誤${x.errors}` : ""}`);
  }
  return parts.length ? `見送り後の確認[${parts.join(" / ")}]` : "見送り後の確認なし";
}

/// 生存ログの1行。黒字の件数(しきい値合わせ用)と、見送り後の確認の結果。
export function formatStormLine() {
  if (!ENABLED || chains.size === 0) return "";
  const parts = [];
  for (const [chain, e] of chains) {
    prune(e, Date.now());
    const tried = Object.values(e.byReason).reduce((a, x) => a + x.tried, 0);
    if (!e.peak && !tried) continue;
    const real = Object.values(e.byReason).reduce((a, x) => a + x.real, 0);
    const usd = Object.values(e.byReason).reduce((a, x) => a + x.realUsd, 0);
    parts.push(`${chain}${e.inStorm ? "🌀" : ""} 今${e.hits.length}/最多${e.peak} 嵐${e.storms}回${tried ? ` 確認${tried}→本物${real}($${usd.toFixed(2)})` : ""}`);
  }
  return parts.length ? ` 嵐[${Math.round(WINDOW_MS / 60000)}分で${MIN_HITS}件〜: ${parts.join(" | ")}]` : "";
}

/// 30分ごとの詳しいまとめ用。
export function formatStormSummary() {
  const lines = [];
  for (const [chain, e] of chains) {
    if (!Object.keys(e.byReason).length) continue;
    lines.push(`[嵐のまとめ ${nowJst()}] ${chain}: 嵐${e.storms}回 最多${e.peak}件/${Math.round(WINDOW_MS / 60000)}分 ${formatReasons(e)}`);
  }
  return lines;
}
