// scripts/incompatible-pools.js
//
// 実行時に「getReserves呼び出しに応答しない」「アドレス形式が不正
// (V4のPoolId等)」と判明したプールアドレスを記録しておく仕組み。
// 一度判明したプールは、次回以降すぐにスキップできるようにすることで、
// 同じ失敗を繰り返さないようにする。

import fs from "fs";

const INCOMPATIBLE_POOLS_FILE = process.env.INCOMPATIBLE_POOLS_FILE || "/tmp/incompatible-pools.json";

function loadIncompatiblePools() {
  try {
    if (fs.existsSync(INCOMPATIBLE_POOLS_FILE)) {
      return JSON.parse(fs.readFileSync(INCOMPATIBLE_POOLS_FILE, "utf8"));
    }
  } catch (e) {}
  return {};
}

function saveIncompatiblePools(map) {
  try {
    fs.writeFileSync(INCOMPATIBLE_POOLS_FILE, JSON.stringify(map));
  } catch (e) {
    console.warn("[非対応プール記録] 保存に失敗:", e.message);
  }
}

export function isKnownIncompatiblePool(chain, poolAddress) {
  const map = loadIncompatiblePools();
  const key = `${chain}::${(poolAddress || "").toLowerCase()}`;
  return map[key] || null;
}

export function recordIncompatiblePool(chain, poolAddress, reason) {
  const map = loadIncompatiblePools();
  const key = `${chain}::${(poolAddress || "").toLowerCase()}`;
  if (map[key]) return;
  map[key] = { reason, firstSeenAt: new Date().toISOString() };
  saveIncompatiblePools(map);
  console.log(`[非対応プール記録] 新規登録: ${poolAddress} on ${chain}(理由: ${reason})— 以降は自動的に見送ります`);
}
