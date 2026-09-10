// scripts/verified-pairs.js
//
// 「実行可能」と確認できたペアの一覧を永続的に保持する。
// 確認条件: プールの準備量をチェーンから直接読めた かつ ルーター確認済み
// のプールが同一ペアに2つ以上ある。
//
// この一覧に載ったペアは、DexScreenerを経由せず、プールアドレスから
// 直接(Multicallで一括)読めるため、観測頻度を3分→十数秒に上げられる。
// DexScreenerは「新しいペアの発掘」専用になり、呼び出し頻度を下げられる。

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

/// 観測で「読めた・ルーター確認済み」のプールが2つ以上揃ったペアを登録・更新する。
/// pools: [{ address, dexId }] … 読み取り成功かつルーター確認済みのものだけ渡す
export function recordVerifiedPair({ chain, symbol, tokenA, tokenB, decimalsX, decimalsY, priceUsdPerY, pools }) {
  if (!pools || pools.length < 2) return false;
  const map = load();
  const key = keyOf(chain, tokenA, tokenB);
  const existing = map[key];

  // 既存のプール一覧と統合(同じアドレスは1つに)。
  const merged = new Map();
  for (const p of (existing?.pools || [])) merged.set(p.address.toLowerCase(), p);
  for (const p of pools) merged.set(p.address.toLowerCase(), { address: p.address, dexId: p.dexId });

  const isNew = !existing;
  map[key] = {
    chain: chain.toLowerCase(),
    symbol,
    tokenA, tokenB, decimalsX, decimalsY,
    priceUsdPerY: priceUsdPerY ?? existing?.priceUsdPerY ?? null,
    pools: [...merged.values()],
    lastVerifiedAt: new Date().toISOString(),
    firstVerifiedAt: existing?.firstVerifiedAt || new Date().toISOString(),
  };
  save(map);
  if (isNew) console.log(`[実行可能ペア] 新規登録: ${symbol} on ${chain}(プール${map[key].pools.length}件)`);
  return isNew;
}

/// 実行時に「読めない」と判明したプールを一覧から外す。
export function removePoolFromVerifiedPairs(chain, poolAddress) {
  const map = load();
  let changed = false;
  for (const [key, pair] of Object.entries(map)) {
    if (pair.chain !== chain.toLowerCase()) continue;
    const before = pair.pools.length;
    pair.pools = pair.pools.filter((p) => p.address.toLowerCase() !== poolAddress.toLowerCase());
    if (pair.pools.length !== before) changed = true;
    if (pair.pools.length < 2) delete map[key];
  }
  if (changed) save(map);
}

export function getVerifiedPairs() {
  return Object.values(load());
}

export function getVerifiedPairsByChain() {
  const grouped = {};
  for (const pair of getVerifiedPairs()) {
    (grouped[pair.chain] ||= []).push(pair);
  }
  return grouped;
}

/// Syncイベントで届いたプールアドレスから、該当するペアを探す。
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
