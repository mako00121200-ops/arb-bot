// scripts/trade-cap.js
//
// 実際に成功した実行回数に応じて、段階的に上限を引き上げる。
//
// フラッシュローンなので「借りる金額自体」にリスクは無い(返せなければ
// 自動的に無かったことになり、実害はガス代のみ)。一方でアービトラージの
// 利益は投入額にほぼ比例するため、上限を小さくしすぎると利益が手数料に
// 埋もれ、「実績を作るための実行」自体が起きなくなる。
// 初期上限$50でこれが実際に起きたため、$500から始める。

import fs from "fs";

const SUCCESS_COUNT_FILE = process.env.SUCCESS_COUNT_FILE || "/tmp/execution-success-count.json";

const CAP_STAGES = [
  { minSuccesses: 0, maxTradeUsd: 500 },
  { minSuccesses: 3, maxTradeUsd: 1000 },
  { minSuccesses: 8, maxTradeUsd: 2000 },
];

function loadSuccessCount() {
  try {
    if (fs.existsSync(SUCCESS_COUNT_FILE)) {
      return JSON.parse(fs.readFileSync(SUCCESS_COUNT_FILE, "utf8")).count || 0;
    }
  } catch (e) {}
  return 0;
}

export function recordExecutionSuccess() {
  const count = loadSuccessCount() + 1;
  try {
    fs.writeFileSync(SUCCESS_COUNT_FILE, JSON.stringify({ count }));
  } catch (e) {
    console.warn("[取引上限] 成功回数の保存に失敗:", e.message);
  }
  console.log(`[取引上限] 実行成功を記録(累計${count}回)。新しい上限: $${getCurrentTradeCapUsd()}`);
  return count;
}

export function getCurrentTradeCapUsd() {
  const count = loadSuccessCount();
  let cap = CAP_STAGES[0].maxTradeUsd;
  for (const stage of CAP_STAGES) {
    if (count >= stage.minSuccesses) cap = stage.maxTradeUsd;
  }
  return cap;
}

export function getSuccessCount() {
  return loadSuccessCount();
}
