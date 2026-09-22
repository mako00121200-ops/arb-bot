// scripts/big-opportunities.js
//
// **大きな機会(既定$0.10以上)が、どこへ消えたかを1件ずつ記録する。**
//
// [なぜ要るか(2026年9月21日、オーナーの指摘から)]
// 「動き始めた初日は $0.3 ぐらいの利益が3〜4回見えていたのに、実際に
// 自動売買が成功するようになったら、桁の小さい利益しか出なくなった」
//
// 調べたところ、**確かめる手段が無かった**。index.js の handleOpportunity には
// 機会を捨てる道が7つあるが、そのうち**4つは何の記録も残していなかった**。
//
//   hasDisabledPool → 記録なし
//   冷却中          → 記録なし
//   送信が進行中    → 記録なし
//   同じプールが使用中/同時送信の上限 → 記録なし
//
// コードの注釈にはこう書いてある:
//   「粗利$0.4155の機会を丸ごと失っている」
// つまり**大きな機会が消えていたことは分かっていたのに、何件消えたかを
// 数えていなかった**。数えていない以上、「初日より悪くなった」も
// 「気のせい」も、どちらも証明できない。
//
// ここで数える。1件ずつ名前と金額と消えた理由を出し、30分ごとに合計を出す。
// **RPCは一切使わない**(すでに手元にある値を数えるだけ)。

/// これ以上を「大物」として1件ずつ追う。今の平均は$0.005なので、
/// $0.10 は**20倍以上**の機会だけを拾うことになる。
const BIG_OPP_USD = parseFloat(process.env.BIG_OPP_USD || "0.10");
/// まとめを出す間隔と、覚えておく件数の上限。
import { loadState, saveState } from "./state-file.js";

const WINDOW_MS = parseInt(process.env.BIG_OPP_WINDOW_MS || String(30 * 60 * 1000), 10);
const MAX_KEPT = 500;

/// 消えた理由の日本語。生存ログの内訳と言葉を揃える。
const OUTCOME_LABEL = {
  success: "成立",
  sent: "送信した",
  disabled: "無効なプール",
  tax_token: "税トークン",
  cooldown: "冷却中",
  trap: "罠",
  below_min: "下限を下回った",
  executing: "同じ経路を送信中",
  send_busy: "同じプールが使用中",
  not_sent: "送信直前で見送り",
  failed: "送信して失敗",
};
/// これ以外は「逃した」として数える。
const CAPTURED = new Set(["success"]);

/// **チェーンに実際に聞いたところまで行った結末。**
/// ここまで来たものだけが「本物だったかどうか」を知っている。
/// 手前で捨てた(冷却・同プール・同経路など)ものは、**本物だったかどうか誰も知らない**。
const TESTED = new Set(["success", "not_sent", "failed"]);
/// 本物率を言うのに最低限要る件数。これ未満では率を出さない
/// (標本19件で決着と書いた失敗の再発防止)。
const MIN_TESTED = parseInt(process.env.BIG_OPP_MIN_TESTED || "10", 10);

const events = [];
const totals = { seen: 0, captured: 0, capturedUsd: 0, missedUsd: 0 };

/// 保存の形。**中身の意味を変えたら上げる。**
const STATE_NAME = "big-opportunities.json";
const STATE_VERSION = 1;
/// 書きすぎないための間引き。
const SAVE_MIN_MS = 30 * 1000;
let lastSavedAt = 0;
/// 間引きで見送った書き込みを、あとで必ず1回やるための予約。
/// **これが無いと、間引かれた直後に再デプロイされた分が消える**
/// (2026年9月22日、単体テストで発見。3件記録して1件しか残らなかった)。
let pendingSave = null;

/// 再デプロイで台帳が消えないように読み戻す(2026年9月22日、オーナーの提案)。
/// **30分の窓の外は読み戻さない。** 古い件を今の30分に混ぜると数字が狂う。
(function restore() {
  const d = loadState(STATE_NAME, STATE_VERSION);
  if (!d) return;
  const since = Date.now() - WINDOW_MS;
  for (const e of Array.isArray(d.events) ? d.events : []) {
    if (Number(e?.at) >= since) events.push(e);
  }
  for (const k of Object.keys(totals)) {
    const n = Number(d.totals?.[k]);
    if (Number.isFinite(n)) totals[k] = n;
  }
  if (totals.seen > 0) console.log(`[大物] 前回までの ${totals.seen}件 を読み戻しました(30分の窓に${events.length}件)`);
})();

function persist() {
  if (Date.now() - lastSavedAt < SAVE_MIN_MS) {
    // まだ書かない。**ただし「あとで書く」予約だけは必ず入れる。**
    if (!pendingSave) {
      pendingSave = setTimeout(() => { pendingSave = null; persist(); }, SAVE_MIN_MS);
      if (typeof pendingSave.unref === "function") pendingSave.unref(); // 本体の終了を邪魔しない
    }
    return;
  }
  if (pendingSave) { clearTimeout(pendingSave); pendingSave = null; }
  lastSavedAt = Date.now();
  saveState(STATE_NAME, STATE_VERSION, { events, totals });
}

/// **今すぐ書く。** 終了の合図を受けた時など、間引きを待てない場面で使う。
export function flushBigOpportunities() {
  if (pendingSave) { clearTimeout(pendingSave); pendingSave = null; }
  lastSavedAt = Date.now();
  return saveState(STATE_NAME, STATE_VERSION, { events, totals });
}

/// その機会が「大物」か。
export function isBigOpportunity(opp) {
  return Number(opp?.netProfitUsd) >= BIG_OPP_USD;
}

/// 大物の行く先を1件記録する。大物でなければ何もしない。
/// @returns 記録したら true
export function noteBigOutcome(opp, outcome, detail = "") {
  if (!isBigOpportunity(opp)) return false;
  const netUsd = Number(opp.netProfitUsd) || 0;
  const at = Date.now();
  events.push({
    at, chain: opp.chain, label: opp.label || "", outcome, detail,
    netUsd, tradeUsd: Number(opp.tradeAmountUsd) || 0,
    actualUsd: opp.actualNetProfitUsd != null ? Number(opp.actualNetProfitUsd) : null,
  });
  if (events.length > MAX_KEPT) events.splice(0, events.length - MAX_KEPT);

  totals.seen++;
  if (CAPTURED.has(outcome)) {
    totals.captured++;
    totals.capturedUsd += opp.actualNetProfitUsd != null ? Number(opp.actualNetProfitUsd) : netUsd;
  } else if (outcome !== "sent") {
    totals.missedUsd += netUsd;
    // **1件ずつ出す。** 合計だけだと「どの経路が、なぜ」が分からない。
    const why = OUTCOME_LABEL[outcome] || outcome;
    console.log(
      `[大物/逃した] ${opp.chain} ${opp.label}: 見込み$${netUsd.toFixed(4)}` +
      `(投入$${(Number(opp.tradeAmountUsd) || 0).toFixed(2)}) → **${why}**${detail ? `(${detail})` : ""}`
    );
  }
  persist();
  return true;
}

function recent() {
  const since = Date.now() - WINDOW_MS;
  return events.filter((e) => e.at >= since);
}

/// 30分ぶんのまとめ。何も無ければ空を返す(静かな時にログを汚さない)。
export function formatBigSummary() {
  const list = recent();
  if (list.length === 0) return "";
  const captured = list.filter((e) => CAPTURED.has(e.outcome));
  const gotUsd = captured.reduce((s, e) => s + (e.actualUsd != null ? e.actualUsd : e.netUsd), 0);
  const lostUsd = list.filter((e) => !CAPTURED.has(e.outcome) && e.outcome !== "sent")
    .reduce((s, e) => s + e.netUsd, 0);

  const by = {};
  for (const e of list) {
    if (CAPTURED.has(e.outcome) || e.outcome === "sent") continue;
    by[e.outcome] = (by[e.outcome] || 0) + 1;
  }
  const why = Object.entries(by).sort((a, b) => b[1] - a[1])
    .map(([k, n]) => `${OUTCOME_LABEL[k] || k}:${n}`).join(" ") || "なし";

  return `[大物] 30分: $${BIG_OPP_USD.toFixed(2)}以上を ${list.length}件検知 → ` +
    `**成立${captured.length}件(実際に$${gotUsd.toFixed(4)})** / ` +
    `逃した${list.length - captured.length}件(見込み$${lostUsd.toFixed(4)})[${why}]` +
    formatRealRate(list);
}

/// 生存ログに入れる短い1行。まだ1件も見ていなければ空。
export function formatBigLine() {
  if (totals.seen === 0) return "";
  return ` 大物[検知${totals.seen} 成立${totals.captured} 得た$${totals.capturedUsd.toFixed(3)} 逃した見込み$${totals.missedUsd.toFixed(3)}]`;
}

/// **「見込み$XX」のうち、本当に取れたはずの分はいくらか。**
///
/// [なぜ要るか(2026年9月22日の見回りで判明)]
/// `逃した見込み$68.24` が出た。だが `見込み` は機会を見つけた時点の計算で、
/// **V3の段も x·y=k で近似している**(§8-1)。過大に出る側の数字。
///
/// 本物かどうかを知っているのは、**チェーンに実際に聞いたところまで行った件**だけ:
///   成立           … 本物だった
///   送信直前で見送り … 実測ガスを入れたら下限を割った = **その分は無かった**
///   送信して失敗   … simulate が拒否した = **その分は無かった**
/// 手前で捨てた件(冷却・同プール・同経路)は、**本物だったか誰も知らない**。
///
/// そこで「試した件の本物率」を出し、見込みにそれを掛けて**正直な期待値**を添える。
/// 実際、最初に出た1件は `送信して失敗(simulate)` で、見込み$1.48 は幻だった。
///
/// @returns 付け足す文字列(件数が足りなければ「まだ言えない」)
export function formatRealRate(list) {
  const tested = list.filter((e) => TESTED.has(e.outcome));
  const real = tested.filter((e) => CAPTURED.has(e.outcome));
  const missedUsd = list.filter((e) => !CAPTURED.has(e.outcome) && e.outcome !== "sent")
    .reduce((s, e) => s + e.netUsd, 0);
  if (tested.length < MIN_TESTED) {
    return ` / **本物率はまだ言えない**(チェーンに聞けたのは${tested.length}件、${MIN_TESTED}件必要)`;
  }
  const rate = real.length / tested.length;
  return ` / **試した${tested.length}件のうち本物は${real.length}件(${(rate * 100).toFixed(0)}%)**`
    + ` → 見込み$${missedUsd.toFixed(2)}の期待値は**$${(missedUsd * rate).toFixed(4)}**`;
}

/// 試した件だけの内訳(判断用)。読む側が居なければ消してよい。
export function getBigTestedStats() {
  const list = recent();
  const tested = list.filter((e) => TESTED.has(e.outcome));
  return { tested: tested.length, real: tested.filter((e) => CAPTURED.has(e.outcome)).length };
}
