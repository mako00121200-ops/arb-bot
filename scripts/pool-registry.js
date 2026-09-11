// scripts/pool-registry.js
//
// 全プールの準備量をメモリ上に保持する「プール地図」。
//
// [なぜ必要か]
// 判定のたびにRPCへ問い合わせると1ペアあたり数百ミリ秒〜1秒かかる。
// メモリ上に持ち、Syncイベントで差分更新すれば、判定はミリ秒で完了する。
//
// [永続化]
// 地図の構築(ファクトリーからの全列挙)には約50分かかる。再デプロイのたびに
// やり直すのは非現実的なので、「アドレス・トークン・実測手数料」だけを
// ファイルに保存し、次回起動時はそれを読み込んで準備量だけ再取得する。
// 準備量は保存しない(古い値で判定しないため)。
//
// [構造]
//   pools:   "chain::address" → { token0, token1, raw0, raw1, feeBps, dexId, ... }
//   byPair:  "chain::tokenA|tokenB" → そのペアを扱うプールの一覧
//   byToken: "chain::token" → そのトークンを含むプールの一覧(三角裁定用)

import fs from "fs";

const POOL_MAP_FILE = process.env.POOL_MAP_FILE || "/tmp/pool-map.json";

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

export function registerPool({ chain, address, dexId, factory, token0, token1, raw0 = 0n, raw1 = 0n, feeBps = 30, feeProbed = false }) {
  const key = poolKey(chain, address);
  const existing = pools.get(key);
  pools.set(key, {
    chain, address, dexId, factory,
    token0: token0.toLowerCase(), token1: token1.toLowerCase(),
    raw0, raw1,
    feeBps: existing?.feeBps ?? feeBps,
    feeProbed: existing?.feeProbed || feeProbed,
    updatedAt: Date.now(),
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

export function updateReservesFromSync(chain, address, raw0, raw1) {
  const pool = pools.get(poolKey(chain, address));
  if (!pool) return null;
  pool.raw0 = raw0;
  pool.raw1 = raw1;
  pool.updatedAt = Date.now();
  return pool;
}

export function setPoolFee(chain, address, feeBps) {
  const pool = pools.get(poolKey(chain, address));
  if (pool && feeBps != null) pool.feeBps = feeBps;
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

export function getAllPoolAddressesByChain() {
  const byChain = {};
  for (const pool of pools.values()) (byChain[pool.chain] ||= []).push(pool.address);
  return byChain;
}

export function getStats() {
  const byChain = {};
  let arbitragable = 0, feeProbed = 0;
  for (const pool of pools.values()) {
    byChain[pool.chain] = (byChain[pool.chain] || 0) + 1;
    if (pool.feeProbed) feeProbed++;
  }
  for (const set of byPair.values()) if (set.size >= 2) arbitragable++;
  return { totalPools: pools.size, totalPairs: byPair.size, arbitragablePairs: arbitragable, totalTokens: byToken.size, feeProbed, byChain };
}

export function getStalePools(chain, olderThanMs) {
  const cutoff = Date.now() - olderThanMs;
  const out = [];
  for (const pool of pools.values()) {
    if (pool.chain === chain && pool.updatedAt < cutoff) out.push(pool);
  }
  return out;
}

// ===== 永続化 =====

/// 地図をファイルに保存する(準備量は含めない)。
export function savePoolMap() {
  const entries = [];
  for (const p of pools.values()) {
    entries.push({ chain: p.chain, address: p.address, dexId: p.dexId, factory: p.factory, token0: p.token0, token1: p.token1, feeBps: p.feeBps, feeProbed: !!p.feeProbed });
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

/// ファイルから地図を読み込む。準備量は0のまま登録されるため、
/// 呼び出し側で必ず全件の再取得を行うこと。
export function loadPoolMap() {
  try {
    if (!fs.existsSync(POOL_MAP_FILE)) return { count: 0, savedAt: null };
    const data = JSON.parse(fs.readFileSync(POOL_MAP_FILE, "utf8"));
    for (const e of data.pools || []) {
      registerPool({ ...e, raw0: 0n, raw1: 0n });
    }
    return { count: (data.pools || []).length, savedAt: data.savedAt || null };
  } catch (e) {
    console.warn(`[プール地図] 読み込みに失敗: ${e.message}`);
    return { count: 0, savedAt: null };
  }
}
