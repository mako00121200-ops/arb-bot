// scripts/real-execution-log.js
//
// 実際にオンチェーンへ送信され、成功した実行だけを記録する専用ログ。
// ダッシュボードの紙上シミュレーション統計とは完全に別物として扱う。
// 利益額は、コントラクトが発する RouteExecuted イベントから直接読み取った
// 「本当に確定した金額」を使う(事前予測ではない)。
//
// [ガス代を引いた利益を記録する(2026年9月17日)]
// これまで記録・表示していた actualProfitUsd は、コントラクトが返す
// 「戻ってきた量 - 返済額」= ガス代を引く前の粗利だった。手元に残る額は
// ここからガス代を引いた分なので、実際のガス代(receipt の gasUsed ×
// 実効単価)と、それを引いた純利益もあわせて記録する。
//
// [実測ガス使用量を次の判定に使う]
// 事前判定のガス代は想定値で計算していたが、実測があるならそちらが確か。
// チェーンと段数(2step/3step)ごとに直近の平均を返し、gas-cost.js が
// 事前判定に使う。想定値のずれが機会の取りこぼしに直結するため。

import fs from "fs";
import path from "path";

/// 保存先。**/tmp は再デプロイのたびに消える。**
/// 専用の環境変数が設定されていなければ、プール地図と同じ場所(ボリューム)に置く。
/// (2026年9月21日: 取引上限の成功回数が /tmp にあり、上限が$500から
///  一度も上がっていなかった。同じ形の場所を全部探して揃えた)
const REAL_EXECUTION_LOG_FILE = process.env.REAL_EXECUTION_LOG_FILE
  || (process.env.POOL_MAP_FILE
      ? path.join(path.dirname(process.env.POOL_MAP_FILE), "real-executions.json")
      : "/tmp/real-executions.json");
/// **累計は別の保存先に持つ(2026年9月23日、オーナーの指摘「利益の総額が変わっている」)。**
///
/// [何が起きていたか]
/// 記録は直近500件だけ残して古いものを捨てていた。画面の「累積利益」はその残った500件を
/// 毎回足し直していたので、500件を超えてからは**1件増えるたびに一番古い1件が累計から消え**、
/// 総額が勝手に変わっていた(減ることもある)。
/// 累計は捨てない別の保存先で足し上げ、記録の一覧(表示用)とは切り離す。
const REAL_TOTALS_FILE = path.join(path.dirname(REAL_EXECUTION_LOG_FILE), "real-executions-totals.json");
/// 一覧として残す件数(ガスの中央値・画面の最近の取引に使う)。累計には関係しない。
const LOG_KEEP = 5000;
/// 平均を取る対象の件数(直近から数える)。
const GAS_AVERAGE_SAMPLES = 20;

export function loadRealExecutions() {
  try {
    if (fs.existsSync(REAL_EXECUTION_LOG_FILE)) {
      return JSON.parse(fs.readFileSync(REAL_EXECUTION_LOG_FILE, "utf8"));
    }
  } catch (e) {}
  return [];
}

function netOf(e) {
  if (e.actualNetProfitUsd != null) return e.actualNetProfitUsd;
  return (e.actualProfitUsd || 0) - (e.actualGasCostUsd ?? e.gasCostUsd ?? 0);
}
function grossOf(e) { return e.actualProfitUsd || 0; }
function gasOf(e) { return e.actualGasCostUsd ?? e.gasCostUsd ?? 0; }

/// 一覧を足し上げた値(累計の保存が無い時の予備、再構成の突き合わせ用)。
export function sumOfLog(log) {
  return {
    count: log.length,
    grossUsd: log.reduce((a, e) => a + grossOf(e), 0),
    gasUsd: log.reduce((a, e) => a + gasOf(e), 0),
    netUsd: log.reduce((a, e) => a + netOf(e), 0),
  };
}

export function loadRealTotals() {
  try {
    if (fs.existsSync(REAL_TOTALS_FILE)) return JSON.parse(fs.readFileSync(REAL_TOTALS_FILE, "utf8"));
  } catch (e) {}
  return null;
}

function saveRealTotals(t) {
  try {
    fs.writeFileSync(REAL_TOTALS_FILE, JSON.stringify({ ...t, updatedAt: new Date().toISOString() }));
  } catch (e) {
    console.warn("[実際の実行記録] 累計の保存に失敗:", e.message);
  }
}

export function recordRealExecution(entry) {
  const log = loadRealExecutions();
  // 累計が無ければ、今ある一覧から始める(既に捨てた分は再構成で埋める)
  const totals = loadRealTotals() ?? { ...sumOfLog(log), source: "log" };
  log.push(entry);
  totals.count += 1;
  totals.grossUsd += grossOf(entry);
  totals.gasUsd += gasOf(entry);
  totals.netUsd += netOf(entry);
  saveRealTotals(totals);
  const trimmed = log.length > LOG_KEEP ? log.slice(-LOG_KEEP) : log;
  try {
    fs.writeFileSync(REAL_EXECUTION_LOG_FILE, JSON.stringify(trimmed));
  } catch (e) {
    console.warn("[実際の実行記録] 保存に失敗:", e.message);
  }
}

/// チェーン上の記録から再構成した累計を採用する。
/// cutoffIso より後に記録された分(再構成の最中に成立した取引)は一覧から足す。
export function adoptRebuiltTotals(rebuilt, cutoffIso) {
  const after = loadRealExecutions().filter((e) => (e.timestamp || "") > cutoffIso);
  const add = sumOfLog(after);
  const totals = {
    count: rebuilt.count + add.count,
    grossUsd: rebuilt.grossUsd + add.grossUsd,
    gasUsd: rebuilt.gasUsd + add.gasUsd,
    netUsd: rebuilt.netUsd + add.netUsd,
    source: "chain",
    rebuiltAt: cutoffIso,
  };
  saveRealTotals(totals);
  return totals;
}

/// 記録から段数を取り出す。古い記録は kind を持たないので、
/// pairLabel の先頭("2step polygon …")から読む。
function kindOf(entry) {
  if (entry.kind) return entry.kind;
  const head = (entry.pairLabel || "").split(" ")[0];
  return head === "2step" || head === "3step" ? head : null;
}

/// そのチェーン・段数で実際に使われたガス量の代表値(直近分)。
/// 実測が無ければ null を返し、呼び出し側は想定値に戻る。
///
/// [平均から中央値へ(2026年9月20日、実測で判明)]
/// Polygon の同じ経路(sync発見→algebra-a)を2回実行し、545,203 と 258,117 と
/// **2.1倍の開き**が出た(V3の価格帯をまたぐ回数で変わる)。平均だと1件の外れ値で
/// 401,660 まで上がり、事前判定のハードルが約$0.005 上がる。これは最低利益
/// ($0.005)と同じ大きさで、**本物の機会を丸ごと1段分捨てる**ことになる。
/// 同じ30分で「下限未満」で見送った Polygon の106件は、粗利の中央値$0.0121 に対し
/// ガスの中央値$0.0107 で、この差がそのまま効いていた。
/// 中央値は外れ値に引きずられないので、ハードルが実態に合う。
/// 余裕の1割は、外れ値に備えてそのまま残す。
export function getAverageGasUnits(chain, kind) {
  const target = (chain || "").toLowerCase();
  const samples = [];
  const log = loadRealExecutions();
  for (let i = log.length - 1; i >= 0 && samples.length < GAS_AVERAGE_SAMPLES; i--) {
    const e = log[i];
    if ((e.chain || "").toLowerCase() !== target) continue;
    if (kindOf(e) !== kind) continue;
    try {
      const used = BigInt(e.gasUsed);
      if (used > 0n) samples.push(used);
    } catch (inner) {}
  }
  if (samples.length === 0) return null;
  // 実行ごとの差(経路のプールの種類、価格帯をまたぐ回数)を吸収するため、
  // 中央値に1割の余裕を足す。
  samples.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const mid = samples.length >> 1;
  const median = samples.length % 2 === 1 ? samples[mid] : (samples[mid - 1] + samples[mid]) / 2n;
  return (median * 110n) / 100n;
}

export function getRealExecutionStats() {
  const log = loadRealExecutions();
  // 累計は捨てない保存先から読む。無ければ一覧を足す(古い記録には純利益が無いので粗利−ガスで補う)。
  const t = loadRealTotals() ?? { ...sumOfLog(log), source: "log" };
  return {
    count: t.count,
    totalProfitUsd: t.netUsd, // 表示の主役はガス代を引いた後の額
    totalGrossProfitUsd: t.grossUsd,
    totalGasCostUsd: t.gasUsd,
    totalsSource: t.source,
    rebuiltAt: t.rebuiltAt ?? null,
    recent: [...log].reverse().slice(0, 15),
  };
}
