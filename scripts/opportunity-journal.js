// scripts/opportunity-journal.js
//
// 機会の記録簿。「検出 → 判定 → 送信/見送り → 結果」を1件ずつ構造化して
// ファイルに残す。
//
// [なぜ必要か]
// 「本来ならいくら取れたか」「なぜ取れなかったか」に根拠を持って答えるため。
// ログだけでは流れてしまい、後から集計できなかった。
//
// [profitableUsd の読み方(誤解しやすい)]
// 黒字と判定された記録の netProfitUsd を全部足しただけの値。同じ経路が
// 再検知されるたびに加算されるので、同じ機会が何十回も計上される。
// さらに、送信直前の実測では赤字になる「幻の黒字」も含む(2026年9月17日の
// 実測で判定の精度は44%だった)。
// 「取り逃した金額」ではないので、そのまま損失として読んではいけない。
// 実際に何が起きたかは byOutcome と topMissed を見る。
//
// 1行1件のJSON(JSON Lines形式)で追記する。ファイルが大きくなったら
// 古い行から切り捨てる。

import fs from "fs";
import path from "path";

/// 保存先。**/tmp は再デプロイのたびに消える。**
/// 専用の環境変数が設定されていなければ、プール地図と同じ場所(ボリューム)に置く。
/// (2026年9月21日: 取引上限の成功回数が /tmp にあり、上限が$500から
///  一度も上がっていなかった。同じ形の場所を全部探して揃えた)
const JOURNAL_FILE = process.env.OPPORTUNITY_JOURNAL_FILE
  || (process.env.POOL_MAP_FILE
      ? path.join(path.dirname(process.env.POOL_MAP_FILE), "opportunity-journal.jsonl")
      : "/tmp/opportunity-journal.jsonl");
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

/// この利回りを超える判定は「計算が壊れている」とみなす。
/// index.js の罠判定(MAX_SANE_RETURN_RATIO)と同じ値を使う。
const SANE_RETURN_RATIO = parseFloat(process.env.MAX_SANE_RETURN_RATIO || "0.20");

/// その記録が「幻」か。**投入額に対して有り得ない利回り**のもの。
///
/// [なぜ分けるか(2026年9月21日、オーナーの指摘)]
/// 記録簿の見出しは「黒字判定の合計 +$32.979」だった。しかし内訳を見ると、
/// 上位4件が **投入$0.59 → 判定+$18.76 / +$4.29 / +$1.49 / +$1.47**。
/// 利回り **3,180%**。有り得ない。この4件だけで **$26.02(全体の79%)**。
///
/// **見出しの8割が幻だった。** これでは「$33を取り逃している」と読めてしまい、
/// 実際に直すべきもの($0.84の simulate 失敗など)が埋もれる。
///
/// 幻は「取り逃した金額」ではなく、**計算が壊れている経路の一覧**として出す。
/// そちらの方が直す手掛かりになる。
/// 送信直前の実測が「これだけ足りなかった」なら、その判定は**取れるはずが無かった**。
///
/// [なぜ要るか(2026年9月21日、オーナーの指摘)]
/// 画面の「取れた可能性 +$77.89」の上位2件が
///   uniswap-v3(1.00%)→sync発見 実測**-632.9bps** 判定+$24.97
///   同じ経路           実測**-192.0bps** 判定+$3.58
/// だった。合わせて**$28.5(全体の37%)**。
/// -632.9bps は「6.3%足りない」という意味で、**そんな機会は最初から無かった**
/// (送金時に税を取るトークンの形。2段で3%×2に一致する)。
/// 利回りは$24.97/$276 = 9%で、利回りの罠判定(20%)には引っかからない。
///
/// **不足の実測は、利回りより直接的な「幻」の証拠**なので、こちらでも判定する。
/// こちらの模型の誤差は普通10〜30bps、価格の動きでも50〜100bps。
/// 150bpsを超える不足は、どちらでも説明がつかない。
const PHANTOM_SHORTFALL_BPS = parseFloat(process.env.PHANTOM_SHORTFALL_BPS || "-150");

function isPhantom(r) {
  if (r.outcome === "trap" || r.outcome === "tax_token") return true;
  const shortfall = Number(r.shortfallBps);
  if (Number.isFinite(shortfall) && shortfall <= PHANTOM_SHORTFALL_BPS) return true;
  const trade = Number(r.tradeAmountUsd) || 0;
  const net = Number(r.netProfitUsd) || 0;
  if (trade <= 0) return false;
  return net / trade > SANE_RETURN_RATIO;
}

/// 直近N時間の集計。ダッシュボード用。
export function summarize(hours = 24) {
  const since = Date.now() - hours * 3600 * 1000;
  const byOutcome = {};
  const byChain = {};
  let profitableUsd = 0, sentUsd = 0, realizedUsd = 0, count = 0;
  // **取れた可能性がある額**(幻を除いた取り逃し)と、その原因ごとの内訳。
  let missedUsd = 0;
  const missedByOutcome = {};
  // 計算が壊れている経路(直す手掛かり。金額としては数えない)。
  let phantomUsd = 0, phantomCount = 0;
  const topPhantom = [];
  const topMissed = [];

  for (const r of recent) {
    if (new Date(r.ts).getTime() < since) continue;
    count++;
    byOutcome[r.outcome] = (byOutcome[r.outcome] || 0) + 1;
    byChain[r.chain] = (byChain[r.chain] || 0) + 1;
    if (r.netProfitUsd > 0) profitableUsd += r.netProfitUsd;
    if (r.outcome === "sent" || r.outcome === "success") sentUsd += r.netProfitUsd || 0;
    // 実際に手元に残った額。ガス代を引いた純利益があればそれを使い、
    // 無ければ粗利からガス代を引いて補う(古い記録のため)。
    if (r.outcome === "success") {
      if (r.actualNetProfitUsd != null) realizedUsd += r.actualNetProfitUsd;
      else if (r.actualProfitUsd != null) realizedUsd += r.actualProfitUsd - (r.actualGasCostUsd ?? 0);
    }
    // 「黒字だったのに取れなかった」を、**幻と取れたはずのものに分ける**。
    if (r.netProfitUsd > 0 && r.outcome !== "success") {
      if (isPhantom(r)) {
        phantomCount++;
        phantomUsd += r.netProfitUsd;
        topPhantom.push(r);
      } else {
        missedUsd += r.netProfitUsd;
        const e = missedByOutcome[r.outcome] || { count: 0, usd: 0 };
        e.count++; e.usd += r.netProfitUsd;
        missedByOutcome[r.outcome] = e;
        topMissed.push(r);
      }
    }
  }
  const byUsd = (a, b) => (b.netProfitUsd || 0) - (a.netProfitUsd || 0);
  topMissed.sort(byUsd);
  topPhantom.sort(byUsd);

  return {
    hours, count, byOutcome, byChain,
    profitableUsd, sentUsd, realizedUsd,
    missedUsd, missedByOutcome, phantomUsd, phantomCount,
    topMissed: topMissed.slice(0, 10),
    topPhantom: topPhantom.slice(0, 5),
  };
}
