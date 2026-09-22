// scripts/opportunity-tiers.js
//
// **機会を「利益の段」と「引き金の大きさ」で数える。** 送信には一切関わらない。
//
// [なぜ要るか(2026年9月22日、新戦術の調査を受けて)]
// これから4つの戦術(Oracle / ペグ・LST / v4 / Backrun)を横並びで比べる。
// 比べるには**同じ物差し**が要る。それがこのファイル。
//
// [2つの物差し]
//   ① 利益の段 … $0.01未満 / 〜$0.10 / 〜$0.50 / 〜$1.00 / 〜$2.00 / $2.00超
//      「$0.5超が1日に何件あるか」が、戦術に投資する価値があるかの答えになる。
//   ② 引き金の大きさ(movePct)… そのプールの価格が**1回の取引でどれだけ動いたか**
//      これが **Backrun の信号そのもの**。
//
// [なぜ movePct を今ごろ数えるのか]
// `pool-registry.js` は前から `lastMovePct` を計算していて、`index.js` はそれを
// `handleOpportunity` に渡していた。**だが誰も読んでいなかった**
//(「測っているのに使っていない」の7件目)。大口スワップを別に検知する仕組みを
// 作る必要はなく、**既にある値を読むだけ**でよかった。
//
// [記録の置き場所]
//   shadow-tiers.json … 段 × 引き金帯 の集計(比較表の元。再デプロイで消えない)
//   shadow-YYYY-MM-DD.jsonl … 1件1行の明細(日ごとに切る。上限つき)
//
// **推測で埋めない。** 取れない項目は書かない(空欄にする)。

import fs from "fs";
import { loadState, saveState, stateFilePath } from "./state-file.js";
import { nowJst } from "./jst.js";

/// 利益の段の**下限**(依頼どおり6段)。単位はUSD。
export const PROFIT_TIERS = [0.01, 0.10, 0.50, 1.00, 2.00];
export const TIER_LABELS = ["<$0.01", "$0.01-0.10", "$0.10-0.50", "$0.50-1.00", "$1.00-2.00", "$2.00+"];

/// 引き金の大きさの帯(%)。**1回の取引でプール価格が何%動いたか。**
/// 0.5%以上を「大口」と見なす(まず全部数えてから、後で線を引き直せるようにする)。
export const MOVE_BANDS = [0.01, 0.05, 0.2, 0.5, 2.0];
export const MOVE_LABELS = ["~0.01%", "0.01-0.05%", "0.05-0.2%", "0.2-0.5%", "0.5-2%", "2%+"];

/// 明細を1日に何行まで書くか(ディスクの歯止め)。
const MAX_LINES_PER_DAY = parseInt(process.env.SHADOW_MAX_LINES_PER_DAY || "50000", 10);
/// 明細を書くか。集計だけでよければ false。
const WRITE_DETAIL = process.env.SHADOW_WRITE_DETAIL !== "false";

const STATE_NAME = "shadow-tiers.json";
const STATE_VERSION = 1;
const SAVE_MIN_MS = 60 * 1000;
let lastSavedAt = 0;
let pendingSave = null;

/// 段の番号を返す(0〜5)。**null や NaN は数えない**(0扱いにすると最下段が膨らむ)。
export function tierIndex(usd) {
  // **`Number(null)` は 0。** これを通すと「利益が分からない件」が最下段に化ける
  // (2026年9月22日、単体テストで発見)。null / undefined / "" は先に弾く。
  if (usd == null || usd === "") return null;
  const n = Number(usd);
  if (!Number.isFinite(n)) return null;
  for (let i = 0; i < PROFIT_TIERS.length; i++) if (n < PROFIT_TIERS[i]) return i;
  return PROFIT_TIERS.length;
}

/// 引き金帯の番号を返す(0〜5)。**分からなければ null**(0%と「不明」を混ぜない)。
export function moveIndex(pct) {
  // **`Number(null)` は 0。** ここを通すと、全経路スキャン由来(引き金の無い機会)が
  // 全部「~0.01%」に積まれ、**小さい引き金ばかりに見える**。
  // 「0%動いた」と「どれだけ動いたか分からない」は**別物**として数える。
  if (pct == null || pct === "") return null;
  const n = Number(pct);
  if (!Number.isFinite(n) || n < 0) return null;
  for (let i = 0; i < MOVE_BANDS.length; i++) if (n < MOVE_BANDS[i]) return i;
  return MOVE_BANDS.length;
}

function blankStrategy() {
  return {
    seen: 0, captured: 0, capturedUsd: 0,
    tiers: new Array(TIER_LABELS.length).fill(0),
    /// 段ごとの「実際に成立した数」。**見えた数と取れた数は別物。**
    tiersCaptured: new Array(TIER_LABELS.length).fill(0),
    moves: new Array(MOVE_LABELS.length).fill(0),
    movesCaptured: new Array(MOVE_LABELS.length).fill(0),
    /// 引き金帯ごとの利益合計。**「大口ほど儲かるか」への答えはここ。**
    movesUsd: new Array(MOVE_LABELS.length).fill(0),
    moveUnknown: 0,
    startedAtMs: Date.now(), uptimeMs: 0,
  };
}

/// 戦術 -> 集計
const byStrategy = new Map();

function statFor(strategy) {
  if (!byStrategy.has(strategy)) byStrategy.set(strategy, blankStrategy());
  return byStrategy.get(strategy);
}

(function restore() {
  const d = loadState(STATE_NAME, STATE_VERSION);
  if (!d) return;
  for (const [name, v] of Object.entries(d)) {
    const s = blankStrategy();
    const num = (x) => (Number.isFinite(Number(x)) ? Number(x) : 0);
    const arr = (x, len) => (Array.isArray(x) && x.length === len ? x.map(num) : new Array(len).fill(0));
    s.seen = num(v.seen); s.captured = num(v.captured); s.capturedUsd = num(v.capturedUsd);
    s.tiers = arr(v.tiers, TIER_LABELS.length);
    s.tiersCaptured = arr(v.tiersCaptured, TIER_LABELS.length);
    s.moves = arr(v.moves, MOVE_LABELS.length);
    s.movesCaptured = arr(v.movesCaptured, MOVE_LABELS.length);
    s.movesUsd = arr(v.movesUsd, MOVE_LABELS.length);
    s.moveUnknown = num(v.moveUnknown);
    // **止まっていた時間は数えない**(「1日あたり何件」の分母が嘘になるため)。
    s.uptimeMs = num(v.uptimeMs);
    s.startedAtMs = Date.now();
    byStrategy.set(name, s);
  }
  const total = [...byStrategy.values()].reduce((a, v) => a + v.seen, 0);
  if (total > 0) console.log(`[段] 前回までの ${total.toLocaleString()}件 を読み戻しました`);
})();

function snapshot() {
  const out = {};
  for (const [name, s] of byStrategy) {
    out[name] = { ...s, uptimeMs: s.uptimeMs + (Date.now() - s.startedAtMs) };
    delete out[name].startedAtMs;
  }
  return out;
}

function persist() {
  if (Date.now() - lastSavedAt < SAVE_MIN_MS) {
    if (!pendingSave) {
      pendingSave = setTimeout(() => { pendingSave = null; persist(); }, SAVE_MIN_MS);
      if (typeof pendingSave.unref === "function") pendingSave.unref();
    }
    return;
  }
  if (pendingSave) { clearTimeout(pendingSave); pendingSave = null; }
  lastSavedAt = Date.now();
  saveState(STATE_NAME, STATE_VERSION, snapshot());
}

/// **今すぐ書く。** 終了の合図を受けた時に使う。
export function flushTiers() {
  if (pendingSave) { clearTimeout(pendingSave); pendingSave = null; }
  lastSavedAt = Date.now();
  return saveState(STATE_NAME, STATE_VERSION, snapshot());
}

// ===== 明細(1件1行) =====

let detailDay = "";
let detailLines = 0;
let detailWarned = false;

function detailPath() {
  const d = new Date();
  // 日付は**日本時間**で切る(報告と揃える)。
  const jst = new Date(d.getTime() + 9 * 3600 * 1000);
  const day = jst.toISOString().slice(0, 10);
  if (day !== detailDay) { detailDay = day; detailLines = 0; detailWarned = false; }
  return stateFilePath(`shadow-${day}.jsonl`);
}

function writeDetail(row) {
  if (!WRITE_DETAIL) return;
  const file = detailPath();
  if (detailLines >= MAX_LINES_PER_DAY) {
    if (!detailWarned) {
      detailWarned = true;
      console.log(`[段] 明細が1日の上限 ${MAX_LINES_PER_DAY.toLocaleString()}行に達しました(集計は続きます)`);
    }
    return;
  }
  try { fs.appendFileSync(file, JSON.stringify(row) + "\n"); detailLines++; } catch (e) {}
}

// ===== 入口 =====

/// 機会を1件数える。**送信の判断には一切影響しない。**
///
/// @param opp 機会(netProfitUsd / chain / label / movePct などを見る)
/// @param outcome どこで消えたか(`big-opportunities.js` と同じ言葉)
/// @param strategy 戦術の名前。既定は既存の V2/V3 裁定
export function noteOpportunityTier(opp, outcome, strategy = "v2v3_arb") {
  try {
    const s = statFor(strategy);
    const usd = Number(opp?.netProfitUsd);
    const ti = tierIndex(usd);
    if (ti == null) return; // 利益が読めないものは数えない
    const mi = moveIndex(opp?.movePct);
    const captured = outcome === "success";
    const gotUsd = captured
      ? (opp?.actualNetProfitUsd != null ? Number(opp.actualNetProfitUsd) : usd)
      : 0;

    s.seen++;
    s.tiers[ti]++;
    if (captured) { s.captured++; s.capturedUsd += gotUsd; s.tiersCaptured[ti]++; }
    if (mi == null) s.moveUnknown++;
    else {
      s.moves[mi]++;
      if (captured) { s.movesCaptured[mi]++; s.movesUsd[mi] += gotUsd; }
    }

    writeDetail({
      timestamp: nowJst(), chain: opp?.chain ?? null, strategy,
      triggerType: opp?.triggerType ?? "pool_change",
      triggerAsset: opp?.triggerAsset ?? null,
      pool: opp?.poolAddresses?.[0] ?? null, route: opp?.label ?? null,
      hopCount: Array.isArray(opp?.poolAddresses) ? opp.poolAddresses.length : null,
      movePct: Number.isFinite(Number(opp?.movePct)) ? Number(opp.movePct) : null,
      inputAmountUsd: Number.isFinite(Number(opp?.tradeAmountUsd)) ? Number(opp.tradeAmountUsd) : null,
      grossProfitUsd: Number.isFinite(Number(opp?.grossProfitUsd)) ? Number(opp.grossProfitUsd) : null,
      gasCostUsd: Number.isFinite(Number(opp?.gasCostUsd)) ? Number(opp.gasCostUsd) : null,
      expectedNetProfitUsd: usd,
      tier: TIER_LABELS[ti], moveBand: mi == null ? null : MOVE_LABELS[mi],
      outcome, captured, actualNetProfitUsd: captured ? gotUsd : null,
      // **推測で埋めない。** 送っていないものは「送ったらどうなったか」を知らない。
      source: opp?.source ?? null,
    });
    persist();
  } catch (e) { /* 数えられなくても本体は止めない */ }
}

// ===== 出力 =====

/// 生存ログ用の1行。**$0.5超が1日に何件あるか**を出す(これが投資判断の数字)。
export function formatTierLine(strategy = "v2v3_arb") {
  const s = byStrategy.get(strategy);
  if (!s || s.seen === 0) return "";
  const hours = (s.uptimeMs + (Date.now() - s.startedAtMs)) / 3600000;
  const perDay = (n) => (hours > 0.1 ? (n / hours) * 24 : null);
  const big = s.tiers[3] + s.tiers[4] + s.tiers[5];   // $0.50 以上
  const v1 = s.tiers[4] + s.tiers[5];                  // $1.00 以上
  const v2 = s.tiers[5];                               // $2.00 以上
  const fmt = (n) => { const d = perDay(n); return d == null ? "?" : d.toFixed(1); };
  return ` 段[見${s.seen.toLocaleString()} 成立${s.captured}`
    + ` 1日あたり $0.5+${fmt(big)}件 $1+${fmt(v1)}件 $2+${fmt(v2)}件`
    + ` 観測${hours.toFixed(1)}h]`;
}

/// 引き金の大きさ別の成績。**「大口ほど儲かるか」への答え。**
/// 30分ごとの詳しい報告に出す。
export function formatMoveBreakdown(strategy = "v2v3_arb") {
  const s = byStrategy.get(strategy);
  if (!s || s.seen === 0) return "";
  const parts = [];
  for (let i = 0; i < MOVE_LABELS.length; i++) {
    if (s.moves[i] === 0) continue;
    const rate = ((s.movesCaptured[i] / s.moves[i]) * 100).toFixed(0);
    const per = s.movesCaptured[i] > 0 ? (s.movesUsd[i] / s.movesCaptured[i]) : 0;
    parts.push(`${MOVE_LABELS[i]}:見${s.moves[i]}/成立${s.movesCaptured[i]}(${rate}%)`
      + ` 計$${s.movesUsd[i].toFixed(4)}${s.movesCaptured[i] > 0 ? ` 1回$${per.toFixed(5)}` : ""}`);
  }
  if (parts.length === 0) return "";
  return `[段/引き金 ${strategy}] ${parts.join(" / ")}`
    + (s.moveUnknown > 0 ? ` (大きさ不明${s.moveUnknown}件)` : "");
}

/// 段ごとの内訳(30分ごと)。
export function formatTierBreakdown(strategy = "v2v3_arb") {
  const s = byStrategy.get(strategy);
  if (!s || s.seen === 0) return "";
  const parts = TIER_LABELS.map((label, i) =>
    s.tiers[i] > 0 ? `${label}:${s.tiers[i]}(成立${s.tiersCaptured[i]})` : null).filter(Boolean);
  return `[段/利益 ${strategy}] ${parts.join(" / ")}`;
}

export function getTierStats() { return snapshot(); }
