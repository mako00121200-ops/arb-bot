// scripts/pool-registry.js
//
// 全プールの状態をメモリ上に保持する「プール地図」。V2形式とV3形式の両方を
// 同じ索引で扱い、経路の探索では区別なく組み合わせられるようにする。
//
// [V2とV3の違い]
//   V2: 準備量が2つ(raw0/raw1)だけで価格が決まる。
//   V3: 価格(sqrtPriceX96)と現在の価格帯の流動性(liquidity)を持つ。
//       手数料は生成時に区分で決まっている(100/500/3000/10000)。
// どちらも kind で区別し、更新はそれぞれのイベント(Sync / Swap)で行う。
//
// [永続化]
// 地図の構築には時間がかかるため、「アドレス・トークン・種別・手数料」だけを
// ファイルに保存し、次回起動時は状態(準備量・価格)だけ取り直す。
// 状態は保存しない(古い値で判定しないため)。

import fs from "fs";

const POOL_MAP_FILE = process.env.POOL_MAP_FILE || "/tmp/pool-map.json";

export const KIND_V2 = "v2";
export const KIND_V3 = "v3";

const pools = new Map();
const byPair = new Map();
const byToken = new Map();
const tokenDecimals = new Map();
const tokenPriceUsd = new Map();

function pairKey(chain, tokenA, tokenB) {
  const [a, b] = [tokenA.toLowerCase(), tokenB.toLowerCase()].sort();
  return `${chain}::${a}|${b}`;
}
function tokenKey(chain, token) { return `${chain}::${token.toLowerCase()}`; }
function poolKey(chain, address) { return `${chain}::${address.toLowerCase()}`; }

/// プールを登録する。kind省略時はV2として扱う(従来の呼び出しと互換)。
export function registerPool({
  chain, address, dexId, factory, token0, token1,
  raw0 = 0n, raw1 = 0n, feeBps = 30, feeProbed = false,
  kind = KIND_V2, feeTier = null, sqrtPriceX96 = 0n, liquidity = 0n,
}) {
  const key = poolKey(chain, address);
  const existing = pools.get(key);
  pools.set(key, {
    chain, address, dexId, factory, kind,
    token0: token0.toLowerCase(), token1: token1.toLowerCase(),
    // V2の状態
    raw0, raw1,
    // V3の状態
    sqrtPriceX96: sqrtPriceX96 || existing?.sqrtPriceX96 || 0n,
    liquidity: liquidity || existing?.liquidity || 0n,
    feeTier: feeTier ?? existing?.feeTier ?? null,
    // 手数料。V3は区分から確定しているので実測不要。
    feeBps: existing?.feeBps ?? feeBps,
    feeProbed: kind === KIND_V3 ? true : (existing?.feeProbed || feeProbed),
    updatedAt: Date.now(),
    lastMovePct: existing?.lastMovePct ?? 0,
  });
  if (!existing) {
    const pk = pairKey(chain, token0, token1);
    if (!byPair.has(pk)) byPair.set(pk, new Set());
    byPair.get(pk).add(key);
    for (const t of [token0, token1]) {
      const tk = tokenKey(chain, t);
      if (!byToken.has(tk)) byToken.set(tk, new Set());
      byToken.get(tk).add(key);
    }
  }
}

/// V2: Syncで届いた準備量を反映し、価格がどれだけ動いたか(%)も記録する。
export function updateReservesFromSync(chain, address, raw0, raw1) {
  const pool = pools.get(poolKey(chain, address));
  if (!pool || pool.kind !== KIND_V2) return null;

  let movePct = 0;
  if (pool.raw0 > 0n && pool.raw1 > 0n && raw0 > 0n && raw1 > 0n) {
    const before = Number(pool.raw1) / Number(pool.raw0);
    const after = Number(raw1) / Number(raw0);
    if (isFinite(before) && before > 0 && isFinite(after)) {
      movePct = Math.abs((after - before) / before) * 100;
    }
  }

  pool.raw0 = raw0;
  pool.raw1 = raw1;
  pool.updatedAt = Date.now();
  pool.lastMovePct = movePct;
  return pool;
}

/// V3: Swapで届いた価格と流動性を反映する。
export function updateV3FromSwap(chain, address, sqrtPriceX96, liquidity) {
  const pool = pools.get(poolKey(chain, address));
  if (!pool || pool.kind !== KIND_V3) return null;

  let movePct = 0;
  if (pool.sqrtPriceX96 > 0n && sqrtPriceX96 > 0n) {
    const before = Number(pool.sqrtPriceX96);
    const after = Number(sqrtPriceX96);
    if (isFinite(before) && before > 0 && isFinite(after)) {
      // 価格は平方根なので、変化率はおよそ2倍になる。
      movePct = Math.abs((after - before) / before) * 200;
    }
  }

  pool.sqrtPriceX96 = sqrtPriceX96;
  if (liquidity > 0n) pool.liquidity = liquidity;
  pool.updatedAt = Date.now();
  pool.lastMovePct = movePct;
  return pool;
}

export function setPoolFee(chain, address, feeBps) {
  const pool = pools.get(poolKey(chain, address));
  if (pool && feeBps != null && pool.kind === KIND_V2) pool.feeBps = feeBps;
}

export function getPool(chain, address) { return pools.get(poolKey(chain, address)) ?? null; }

export function getPoolsForPair(chain, tokenA, tokenB) {
  const set = byPair.get(pairKey(chain, tokenA, tokenB));
  if (!set) return [];
  return [...set].map((k) => pools.get(k)).filter(Boolean);
}

export function getPoolsForToken(chain, token) {
  const set = byToken.get(tokenKey(chain, token));
  if (!set) return [];
  return [...set].map((k) => pools.get(k)).filter(Boolean);
}

export function getArbitragablePairs(chain = null) {
  const out = [];
  for (const [pk, set] of byPair.entries()) {
    if (set.size < 2) continue;
    const [chainPart] = pk.split("::");
    if (chain && chainPart !== chain) continue;
    const list = [...set].map((k) => pools.get(k)).filter(Boolean);
    if (list.length < 2) continue;
    out.push({ chain: chainPart, token0: list[0].token0, token1: list[0].token1, pools: list });
  }
  return out;
}

export function setTokenDecimals(chain, token, decimals) { tokenDecimals.set(tokenKey(chain, token), decimals); }
export function getTokenDecimals(chain, token) { return tokenDecimals.get(tokenKey(chain, token)) ?? null; }
export function setTokenPriceUsd(chain, token, price) { if (price > 0 && isFinite(price)) tokenPriceUsd.set(tokenKey(chain, token), price); }
export function getTokenPriceUsd(chain, token) { return tokenPriceUsd.get(tokenKey(chain, token)) ?? null; }

export function getAllPoolAddressesByChain(kind = null) {
  const byChain = {};
  for (const pool of pools.values()) {
    if (kind && pool.kind !== kind) continue;
    (byChain[pool.chain] ||= []).push(pool.address);
  }
  return byChain;
}

/// 種別を指定してプールの一覧を得る(V3の状態を一括更新する時などに使う)。
export function getPoolsByKind(chain, kind) {
  const out = [];
  for (const pool of pools.values()) {
    if (pool.chain === chain && pool.kind === kind) out.push(pool);
  }
  return out;
}

export function getStats() {
  const byChain = {};
  const byKind = { v2: 0, v3: 0 };
  let arbitragable = 0, feeProbed = 0, mixedPairs = 0;
  for (const pool of pools.values()) {
    byChain[pool.chain] = (byChain[pool.chain] || 0) + 1;
    byKind[pool.kind] = (byKind[pool.kind] || 0) + 1;
    if (pool.feeProbed) feeProbed++;
  }
  for (const set of byPair.values()) {
    if (set.size < 2) continue;
    arbitragable++;
    // V2とV3が同じペアに共存しているか(最も機会が生まれやすい組み合わせ)。
    const kinds = new Set([...set].map((k) => pools.get(k)?.kind).filter(Boolean));
    if (kinds.size > 1) mixedPairs++;
  }
  return {
    totalPools: pools.size, totalPairs: byPair.size,
    arbitragablePairs: arbitragable, mixedPairs,
    totalTokens: byToken.size, feeProbed, byChain, byKind,
  };
}

export function getStalePools(chain, olderThanMs, kind = null) {
  const cutoff = Date.now() - olderThanMs;
  const out = [];
  for (const pool of pools.values()) {
    if (pool.chain !== chain) continue;
    if (kind && pool.kind !== kind) continue;
    if (pool.updatedAt < cutoff) out.push(pool);
  }
  return out;
}

/// そのプールが「判定に使える状態か」。V2は準備量、V3は価格と流動性を見る。
export function hasUsableState(pool) {
  if (!pool) return false;
  if (pool.kind === KIND_V3) return pool.sqrtPriceX96 > 0n && pool.liquidity > 0n;
  return pool.raw0 > 0n && pool.raw1 > 0n;
}

/// プールを判定対象から外す(無効化)。種別ごとに状態を消す。
export function clearPoolState(pool) {
  if (!pool) return;
  pool.raw0 = 0n;
  pool.raw1 = 0n;
  pool.sqrtPriceX96 = 0n;
  pool.liquidity = 0n;
}

// ===== 永続化 =====

export function savePoolMap() {
  const entries = [];
  for (const p of pools.values()) {
    entries.push({
      chain: p.chain, address: p.address, dexId: p.dexId, factory: p.factory,
      token0: p.token0, token1: p.token1, feeBps: p.feeBps, feeProbed: !!p.feeProbed,
      kind: p.kind, feeTier: p.feeTier,
    });
  }
  try {
    const tmp = POOL_MAP_FILE + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify({ savedAt: new Date().toISOString(), count: entries.length, pools: entries }));
    fs.renameSync(tmp, POOL_MAP_FILE);
    return entries.length;
  } catch (e) {
    console.warn(`[プール地図] 保存に失敗: ${e.message}`);
    return 0;
  }
}

export function loadPoolMap() {
  try {
    if (!fs.existsSync(POOL_MAP_FILE)) return { count: 0, savedAt: null };
    const data = JSON.parse(fs.readFileSync(POOL_MAP_FILE, "utf8"));
    for (const e of data.pools || []) {
      registerPool({ ...e, kind: e.kind || KIND_V2, raw0: 0n, raw1: 0n, sqrtPriceX96: 0n, liquidity: 0n });
    }
    return { count: (data.pools || []).length, savedAt: data.savedAt || null };
  } catch (e) {
    console.warn(`[プール地図] 読み込みに失敗: ${e.message}`);
    return { count: 0, savedAt: null };
  }
}
