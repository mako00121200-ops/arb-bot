// scripts/incompatible-pools.js
//
// 実行時に「getReserves呼び出しに応答しない」「アドレス形式が不正
// (V4のPoolId等)」と判明したプールアドレスを記録しておく仕組み。
// 一度判明したプールは、次回以降すぐにスキップできるようにすることで、
// 同じ失敗を繰り返さないようにする。

import fs from "fs";
import path from "path";

/// 保存先。**/tmp は再デプロイのたびに消える。**
/// 専用の環境変数が設定されていなければ、プール地図と同じ場所(ボリューム)に置く。
/// (2026年9月21日: 取引上限の成功回数が /tmp にあり、上限が$500から
///  一度も上がっていなかった。同じ形の場所を全部探して揃えた)
const INCOMPATIBLE_POOLS_FILE = process.env.INCOMPATIBLE_POOLS_FILE
  || (process.env.POOL_MAP_FILE
      ? path.join(path.dirname(process.env.POOL_MAP_FILE), "incompatible-pools.json")
      : "/tmp/incompatible-pools.json");

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

/// 古い規則で書かれた記録を落とす。
///
/// [なぜ要るか(2026年9月21日)]
/// 以前は「送信失敗3回」でも**永久に**この一覧へ登録していた。
/// しかし `wait` の失敗は他者に先を越された時に必ず起きるので、
/// **競争が激しい=機会が大きいプールから順に永久追放されていた**。
/// さらに同じ日にこのファイルを /tmp からボリュームへ移したため、
/// 再デプロイで消えていた誤判定が**本当に永久**になっていた。
///
/// 一度だけ掃除して、性質として変わらない理由だけを残す。
let purged = false;
function purgeTransientEntries(map) {
  if (purged) return map;
  purged = true;
  // 古い規則で書かれた一時的な理由は「送信失敗…」だけ。**それだけを落とす。**
  // 文面の一致で「残すもの」を選ぶと、書き換えた時に取りこぼす
  // (実際そのバグを検算で見つけた)。**落とすものを名指しする方が安全。**
  const keep = {};
  let dropped = 0;
  for (const [key, v] of Object.entries(map)) {
    if (/^送信失敗/.test(v?.reason || "")) dropped++;
    else keep[key] = v;
  }
  if (dropped > 0) {
    saveIncompatiblePools(keep);
    console.log(`[非対応プール記録] 古い規則で永久登録されていた ${dropped}件を解除しました(送信失敗は一時的な理由として扱います)`);
  }
  return keep;
}

export function isKnownIncompatiblePool(chain, poolAddress) {
  const map = purgeTransientEntries(loadIncompatiblePools());
  const key = `${chain}::${(poolAddress || "").toLowerCase()}`;
  return map[key] || null;
}

export function recordIncompatiblePool(chain, poolAddress, reason, { permanent = false } = {}) {
  // **移ろう理由をここに書かない。** 書けば永久追放になる。
  if (!permanent) return;
  const map = loadIncompatiblePools();
  const key = `${chain}::${(poolAddress || "").toLowerCase()}`;
  if (map[key]) return;
  map[key] = { reason, firstSeenAt: new Date().toISOString() };
  saveIncompatiblePools(map);
  console.log(`[非対応プール記録] 新規登録: ${poolAddress} on ${chain}(理由: ${reason})— 以降は自動的に見送ります`);
}
