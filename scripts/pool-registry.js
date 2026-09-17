// scripts/pool-registry.js
//
// 全プールの状態をメモリ上に保持する「プール地図」。V2形式とV3形式の両方を
// 同じ索引で扱う。
//
// [監視対象の絞り込み(2026年9月17日に変更)]
// 以前は「同じペアに2つ以上のプールがある」V2プールを全て残していた
// (Polygonだけで3,065件)。実測では、V2だけで組んだ経路の黒字は全て
// 税トークンか$2〜10の極小で、送信直前まで進んだ機会は全てV3を含む経路
// だった。V2だけの経路は判定しない(opportunity-scanner.js)ことにしたので、
// V2プールは「V3を含む経路の片脚になれるもの」だけを残す。
//   残す条件: V2プールの2つのトークンが、両方ともいずれかのV3プールに
//            含まれている(=V3プールと同じペア、またはV3プールと三角形を作れる)
// V3プールは主要な通貨の組で作られているため、この条件で長い尾の銘柄
// (税トークンの温床)が外れ、イベント受信と判定の無駄が大きく減る。
//
// [永続化]
// 地図の全体像はファイルに残し、次回の絞り込みの材料にする。
// 状態(準備量・価格)は保存しない(古い値で判定しないため)。

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
    raw0, raw1,
    sqrtPriceX96: sqrtPriceX96 || existing?.sqrtPriceX96 || 0n,
    liquidity: liquidity || existing?.liquidity || 0n,
    feeTier: feeTier ?? existing?.feeTier ?? null,
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

/// プールを地図から完全に外す(索引からも消す)。
export function removePool(chain, address) {
  const key = poolKey(chain, address);
  const pool = pools.get(key);
  if (!pool) return false;
  pools.delete(key);
  const pk = pairKey(chain, pool.token0, pool.token1);
  byPair.get(pk)?.delete(key);
  if (byPair.get(pk)?.size === 0) byPair.delete(pk);
  for (const t of [pool.token0, pool.token1]) {
    const tk = tokenKey(chain, t);
    byToken.get(tk)?.delete(key);
    if (byToken.get(tk)?.size === 0) byToken.delete(tk);
  }
  return true;
}

/// V3を含む経路の材料になるプールだけを残し、それ以外を地図から外す。
/// V3プールは全て残す。V2プールは、2つのトークンが両方とも同じチェーンの
/// いずれかのV3プールに含まれるものだけを残す。
export function pruneToCandidates() {
  const v3Tokens = new Set(); // "chain::token"
  const chainsWithV3 = new Set();
  for (const p of pools.values()) {
    if (p.kind !== KIND_V3) continue;
    chainsWithV3.add(p.chain);
    v3Tokens.add(tokenKey(p.chain, p.token0));
    v3Tokens.add(tokenKey(p.chain, p.token1));
  }

  const keep = new Set();
  let keptV2 = 0, removedV2 = 0, removedOther = 0;
  for (const [k, p] of pools.entries()) {
    if (p.kind === KIND_V3) { keep.add(k); continue; }
    if (!chainsWithV3.has(p.chain)) {
      // 保存済みの地図にV3がまだ無いチェーン(地図を作り直した直後など)は、
      // V2を全て外してしまわないよう、従来の条件(同じペアに2つ以上)で残す。
      if ((byPair.get(pairKey(p.chain, p.token0, p.token1))?.size || 0) >= 2) {
        keep.add(k);
        keptV2++;
      }
      continue;
    }
    if (v3Tokens.has(tokenKey(p.chain, p.token0)) && v3Tokens.has(tokenKey(p.chain, p.token1))) {
      keep.add(k);
      keptV2++;
    }
  }
  for (const k of [...pools.keys()]) {
    if (keep.has(k)) continue;
    const p = pools.get(k);
    if (p.kind === KIND_V2) removedV2++; else removedOther++;
    removePool(p.chain, p.address);
  }
  console.log(`[絞り込み] V2はV3と経路を組めるものだけ残します: V2 ${keptV2}件を残し、${removedV2}件を外しました`);
  return { kept: pools.size, removed: removedV2 + removedOther };
}

/// 購読すべきプールのアドレス一覧(チェーン別)。
export function getSubscribedAddresses(chain) {
  const out = [];
  for (const p of pools.values()) {
    if (p.chain === chain) out.push(p.address);
  }
  return out;
}

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

export function updateV3FromSwap(chain, address, sqrtPriceX96, liquidity) {
  const pool = pools.get(poolKey(chain, address));
  if (!pool || pool.kind !== KIND_V3) return null;
  let movePct = 0;
  if (pool.sqrtPriceX96 > 0n && sqrtPriceX96 > 0n) {
    const before = Number(pool.sqrtPriceX96);
    const after = Number(sqrtPriceX96);
    if (isFinite(before) && before > 0 && isFinite(after)) {
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

export function hasUsableState(pool) {
  if (!pool) return false;
  if (pool.kind === KIND_V3) return pool.sqrtPriceX96 > 0n && pool.liquidity > 0n;
  return pool.raw0 > 0n && pool.raw1 > 0n;
}

/// 判定の手前で何件が脱落しているかを数える(診断用)。
///
/// [なぜ要るか]
/// 2段経路を組むには「同じペアに、使える状態のプールが2つ以上」必要になる
/// (opportunity-scanner.js の scanTwoStep)。ところが実測では、スキャンは
/// 回っているのに経路が1本も評価されない時間帯が長く続いていた。
/// 「状態が無くて脱落している」のか「経路は組めていて評価側で落ちている」のかを
/// 区別できないと、当て推量で直すことになる。ここで手前の段階を数えて切り分ける。
///
/// V3は sqrtPriceX96 と liquidity の両方が正でないと使えない
/// (hasUsableState)。価格帯に流動性が無いと liquidity が0になるため、
/// 「価格はあるが流動性が0」を別に数えて、脱落の理由を見分けられるようにする。
///
/// 全てメモリ上の集計で、RPCは一切使わない。
export function getStateDiagnostics(chain) {
  let v2Total = 0, v2Usable = 0;
  let v3Total = 0, v3Usable = 0, v3NoLiquidity = 0, v3NoPrice = 0;

  for (const p of pools.values()) {
    if (p.chain !== chain) continue;
    if (p.kind === KIND_V3) {
      v3Total++;
      if (hasUsableState(p)) v3Usable++;
      else if (p.sqrtPriceX96 > 0n) v3NoLiquidity++;
      else v3NoPrice++;
    } else {
      v2Total++;
      if (hasUsableState(p)) v2Usable++;
    }
  }

  // 経路を組める見込みのあるペア数。プールが2つ以上あり、そのうち
  // 2つ以上が使える状態のもの。
  let pairsTotal = 0, pairsReady = 0;
  for (const [pk, set] of byPair.entries()) {
    if (!pk.startsWith(`${chain}::`)) continue;
    if (set.size < 2) continue;
    pairsTotal++;
    let usable = 0;
    for (const k of set) {
      if (hasUsableState(pools.get(k))) usable++;
      if (usable >= 2) break;
    }
    if (usable >= 2) pairsReady++;
  }

  return { v2Total, v2Usable, v3Total, v3Usable, v3NoLiquidity, v3NoPrice, pairsTotal, pairsReady };
}

/// 診断を1行にまとめる。
export function formatStateDiagnostics(chain) {
  const d = getStateDiagnostics(chain);
  return `[状態] ${chain}: 判定可能ペア ${d.pairsReady}/${d.pairsTotal}`
    + ` / 使えるプール V2 ${d.v2Usable}/${d.v2Total} V3 ${d.v3Usable}/${d.v3Total}`
    + ` / V3の脱落[流動性0 ${d.v3NoLiquidity} 価格なし ${d.v3NoPrice}]`;
}

export function clearPoolState(pool) {
  if (!pool) return;
  pool.raw0 = 0n;
  pool.raw1 = 0n;
  pool.sqrtPriceX96 = 0n;
  pool.liquidity = 0n;
}

// ===== 永続化 =====
// 保存は「地図の全体像」を対象にするため、絞り込む前に snapshotFullMap() を
// 呼んでおく。絞り込み後の状態だけを保存すると、次回の候補計算の材料が減る。

let fullMapSnapshot = null;

export function snapshotFullMap() {
  fullMapSnapshot = [];
  for (const p of pools.values()) {
    fullMapSnapshot.push({
      chain: p.chain, address: p.address, dexId: p.dexId, factory: p.factory,
      token0: p.token0, token1: p.token1, feeBps: p.feeBps, feeProbed: !!p.feeProbed,
      kind: p.kind, feeTier: p.feeTier,
    });
  }
  return fullMapSnapshot.length;
}

export function savePoolMap() {
  const current = new Map();
  for (const p of pools.values()) current.set(poolKey(p.chain, p.address), p);
  // 全体像に、メモリ上の最新値(手数料の学習結果など)を反映する。
  const entries = (fullMapSnapshot || []).map((e) => {
    const live = current.get(poolKey(e.chain, e.address));
    return live ? { ...e, feeBps: live.feeBps, feeProbed: !!live.feeProbed } : e;
  });
  // 絞り込み後に新しく登録されたプール(V3の再発見など)も加える。
  const known = new Set(entries.map((e) => poolKey(e.chain, e.address)));
  for (const p of pools.values()) {
    const k = poolKey(p.chain, p.address);
    if (known.has(k)) continue;
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
