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

const events = [];
const totals = { seen: 0, captured: 0, capturedUsd: 0, missedUsd: 0 };

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
    `逃した${list.length - captured.length}件(見込み$${lostUsd.toFixed(4)})[${why}]`;
}

/// 生存ログに入れる短い1行。まだ1件も見ていなければ空。
export function formatBigLine() {
  if (totals.seen === 0) return "";
  return ` 大物[検知${totals.seen} 成立${totals.captured} 得た$${totals.capturedUsd.toFixed(3)} 逃した見込み$${totals.missedUsd.toFixed(3)}]`;
}
