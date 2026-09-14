// scripts/opportunity-journal.js
//
// 機会の記録簿。「検出 → 判定 → 送信/見送り → 結果」を1件ずつ構造化して
// ファイルに残す。
//
// [なぜ必要か]
// 「本来ならいくら取れたか」「なぜ取れなかったか」に根拠を持って答えるため。
// ログだけでは流れてしまい、後から集計できなかった。
//
// 1行1件のJSON(JSON Lines形式)で追記する。ファイルが大きくなったら
// 古い行から切り捨てる。

import fs from "fs";

const JOURNAL_FILE = process.env.OPPORTUNITY_JOURNAL_FILE || "/tmp/opportunity-journal.jsonl";
const MAX_BYTES = 8 * 1024 * 1024; // 8MB
const KEEP_LINES_ON_TRIM = 20000;

// 直近の件数を素早く集計するため、メモリにも保持する。
const recent = [];
const RECENT_MAX = 5000;

/// 1件記録する。
/// outcome の例:
///   "skipped_cooldown" 冷却中 / "trap" 罠 / "tax_token" 税トークン
///   "unprofitable" 赤字 / "below_min" 最低利益未満 / "sent" 送信
///   "success" 成功 / "failed" 送信失敗 / "not_profitable_onchain" 実測で赤字
export function journal(entry) {
  const record = { ts: new Date().toISOString(), ...entry };
  recent.push(record);
  if (recent.length > RECENT_MAX) recent.shift();
  try {
    fs.appendFileSync(JOURNAL_FILE, JSON.stringify(record, (k, v) => typeof v === "bigint" ? v.toString() : v) + "\n");
  } catch (e) {}
}

/// 起動時にファイルから直近分を読み込む(ダッシュボードの集計用)。
export function loadJournal() {
  try {
    if (!fs.existsSync(JOURNAL_FILE)) return 0;
    const lines = fs.readFileSync(JOURNAL_FILE, "utf8").split("\n").filter(Boolean);
    const tail = lines.slice(-RECENT_MAX);
    for (const line of tail) {
      try { recent.push(JSON.parse(line)); } catch (e) {}
    }
    return recent.length;
  } catch (e) {
    return 0;
  }
}

/// ファイルが大きすぎれば古い行を切り捨てる。
export function trimJournalIfNeeded() {
  try {
    if (!fs.existsSync(JOURNAL_FILE)) return;
    const size = fs.statSync(JOURNAL_FILE).size;
    if (size < MAX_BYTES) return;
    const lines = fs.readFileSync(JOURNAL_FILE, "utf8").split("\n").filter(Boolean);
    const tmp = JOURNAL_FILE + ".tmp";
    fs.writeFileSync(tmp, lines.slice(-KEEP_LINES_ON_TRIM).join("\n") + "\n");
    fs.renameSync(tmp, JOURNAL_FILE);
  } catch (e) {}
}

/// 直近N時間の集計。ダッシュボード用。
export function summarize(hours = 24) {
  const since = Date.now() - hours * 3600 * 1000;
  const byOutcome = {};
  const byChain = {};
  let profitableUsd = 0, sentUsd = 0, realizedUsd = 0, count = 0;
  const topMissed = [];

  for (const r of recent) {
    if (new Date(r.ts).getTime() < since) continue;
    count++;
    byOutcome[r.outcome] = (byOutcome[r.outcome] || 0) + 1;
    byChain[r.chain] = (byChain[r.chain] || 0) + 1;
    if (r.netProfitUsd > 0) profitableUsd += r.netProfitUsd;
    if (r.outcome === "sent" || r.outcome === "success") sentUsd += r.netProfitUsd || 0;
    if (r.outcome === "success" && r.actualProfitUsd != null) realizedUsd += r.actualProfitUsd;
    // 「黒字だったのに取れなかった」上位を控える。
    if (r.netProfitUsd > 0 && r.outcome !== "success") topMissed.push(r);
  }
  topMissed.sort((a, b) => (b.netProfitUsd || 0) - (a.netProfitUsd || 0));

  return {
    hours, count, byOutcome, byChain,
    profitableUsd, sentUsd, realizedUsd,
    topMissed: topMissed.slice(0, 10),
  };
}
