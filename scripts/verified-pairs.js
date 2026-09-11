// scripts/verified-pairs.js
//
// 「実行可能」と確認できたペアの一覧を永続的に保持する。
// 確認条件: 準備量をチェーンから直接読めた かつ ルーター確認済み のプールが、
// 同一ペアに「異なるDEXで」2つ以上ある。
//
// [修正] 以前は同じDEX名のプール2つでも登録していたため、
// 「velodrome, velodrome」のような実行不可能なペアが混ざり、
// 5秒ごとに無駄な読み取りをしていた。異なるDEXが2つ以上を条件にする。
//
// 各プールには、プール自身から逆算した実際の手数料(feeBps)も記録する。
// 観測時にこの値を使うことで、実行直前の判定とのズレを無くす。

import fs from "fs";

const VERIFIED_PAIRS_FILE = process.env.VERIFIED_PAIRS_FILE || "/tmp/verified-pairs.json";

function load() {
  try {
    if (fs.existsSync(VERIFIED_PAIRS_FILE)) return JSON.parse(fs.readFileSync(VERIFIED_PAIRS_FILE, "utf8"));
  } catch (e) {}
  return {};
}

function save(map) {
  try { fs.writeFileSync(VERIFIED_PAIRS_FILE, JSON.stringify(map)); } catch (e) {
    console.warn("[実行可能ペア] 保存に失敗:", e.message);
  }
}

function keyOf(chain, tokenA, tokenB) {
  return `${chain.toLowerCase()}::${tokenA.toLowerCase()}::${tokenB.toLowerCase()}`;
}

function distinctDexCount(pools) {
  return new Set(pools.map((p) => (p.dexId || "").toLowerCase())).size;
}

/// pools: [{ address, dexId, feeBps }] … 読み取り成功かつルーター確認済みのものだけ渡す
export function recordVerifiedPair({ chain, symbol, tokenA, tokenB, decimalsX, decimalsY, priceUsdPerY, pools }) {
  if (!pools || distinctDexCount(pools) < 2) return false;
  const map = load();
  const key = keyOf(chain, tokenA, tokenB);
  const existing = map[key];

  const merged = new Map();
  for (const p of (existing?.pools || [])) merged.set(p.address.toLowerCase(), p);
  for (const p of pools) {
    const prev = merged.get(p.address.toLowerCase());
    merged.set(p.address.toLowerCase(), {
      address: p.address, dexId: p.dexId,
      feeBps: p.feeBps ?? prev?.feeBps ?? null,
    });
  }

  const isNew = !existing;
  map[key] = {
    chain: chain.toLowerCase(), symbol, tokenA, tokenB, decimalsX, decimalsY,
    priceUsdPerY: priceUsdPerY ?? existing?.priceUsdPerY ?? null,
    pools: [...merged.values()],
    lastVerifiedAt: new Date().toISOString(),
    firstVerifiedAt: existing?.firstVerifiedAt || new Date().toISOString(),
  };
  save(map);
  if (isNew) {
    const fees = map[key].pools.map((p) => `${p.dexId}:${p.feeBps ?? "既定"}bps`).join(", ");
    console.log(`[実行可能ペア] 新規登録: ${symbol} on ${chain}(${fees})`);
  }
  return isNew;
}

export function removePoolFromVerifiedPairs(chain, poolAddress) {
  const map = load();
  let changed = false;
  for (const [key, pair] of Object.entries(map)) {
    if (pair.chain !== chain.toLowerCase()) continue;
    const before = pair.pools.length;
    pair.pools = pair.pools.filter((p) => p.address.toLowerCase() !== poolAddress.toLowerCase());
    if (pair.pools.length !== before) changed = true;
    if (distinctDexCount(pair.pools) < 2) delete map[key];
  }
  if (changed) save(map);
}

/// 起動時に呼ぶ: 旧仕様で登録された「同一DEXのみ」のペアを掃除する。
export function pruneInvalidVerifiedPairs() {
  const map = load();
  let removed = 0;
  for (const [key, pair] of Object.entries(map)) {
    if (distinctDexCount(pair.pools) < 2) { delete map[key]; removed++; }
  }
  if (removed > 0) {
    save(map);
    console.log(`[実行可能ペア] 同一DEXのみのペア${removed}件を削除しました`);
  }
}

export function getVerifiedPairs() {
  return Object.values(load());
}

export function getVerifiedPairsByChain() {
  const grouped = {};
  for (const pair of getVerifiedPairs()) (grouped[pair.chain] ||= []).push(pair);
  return grouped;
}

export function findVerifiedPairByPool(chain, poolAddress) {
  const target = poolAddress.toLowerCase();
  for (const pair of getVerifiedPairs()) {
    if (pair.chain !== chain.toLowerCase()) continue;
    if (pair.pools.some((p) => p.address.toLowerCase() === target)) return pair;
  }
  return null;
}

export function getVerifiedPairCount() {
  return Object.keys(load()).length;
}
