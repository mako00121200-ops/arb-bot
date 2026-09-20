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

const REAL_EXECUTION_LOG_FILE = process.env.REAL_EXECUTION_LOG_FILE || "/tmp/real-executions.json";
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

export function recordRealExecution(entry) {
  const log = loadRealExecutions();
  log.push(entry);
  const trimmed = log.length > 500 ? log.slice(-500) : log;
  try {
    fs.writeFileSync(REAL_EXECUTION_LOG_FILE, JSON.stringify(trimmed));
  } catch (e) {
    console.warn("[実際の実行記録] 保存に失敗:", e.message);
  }
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
  // 粗利(ガスを引く前)と、ガス代を引いた純利益の両方を出す。
  // 古い記録には純利益が無いので、その場合は粗利からガス代を引いて補う。
  const totalGrossProfitUsd = log.reduce((s, e) => s + (e.actualProfitUsd || 0), 0);
  const totalGasCostUsd = log.reduce((s, e) => s + (e.actualGasCostUsd ?? e.gasCostUsd ?? 0), 0);
  const totalNetProfitUsd = log.reduce((s, e) => {
    if (e.actualNetProfitUsd != null) return s + e.actualNetProfitUsd;
    return s + (e.actualProfitUsd || 0) - (e.actualGasCostUsd ?? e.gasCostUsd ?? 0);
  }, 0);
  return {
    count: log.length,
    totalProfitUsd: totalNetProfitUsd, // 表示の主役はガス代を引いた後の額
    totalGrossProfitUsd,
    totalGasCostUsd,
    recent: [...log].reverse().slice(0, 15),
  };
}
