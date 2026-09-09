// scripts/real-execution-log.js
//
// 実際にオンチェーンへ送信され、成功した実行だけを記録する専用ログ。
// ダッシュボードの紙上シミュレーション統計とは完全に別物として扱う。
// 利益額は、コントラクトが発するArbExecutedイベントから直接読み取った
// 「本当に確定した金額」を使う(事前予測ではない)。

import fs from "fs";

const REAL_EXECUTION_LOG_FILE = process.env.REAL_EXECUTION_LOG_FILE || "/tmp/real-executions.json";

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

export function getRealExecutionStats() {
  const log = loadRealExecutions();
  const totalProfitUsd = log.reduce((s, e) => s + (e.actualProfitUsd || 0), 0);
  const totalGasCostUsd = log.reduce((s, e) => s + (e.gasCostUsd || 0), 0);
  return {
    count: log.length,
    totalProfitUsd,
    totalGasCostUsd,
    recent: [...log].reverse().slice(0, 15),
  };
}
