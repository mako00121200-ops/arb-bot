// scripts/pool-registry.js
//
// 全プールの準備量をメモリ上に保持する「プール地図」。
//
// [なぜ必要か]
// 従来は判定のたびにRPCへ問い合わせていたため、1ペアあたり数百ミリ秒〜
// 1秒かかり、150ペアを22分周期でしか見られなかった。
// 起動時に一括で読み込み、以降はSyncイベント(取引が起きた瞬間に届く)で
// 差分更新すれば、判定はメモリ上の計算だけで済み、ミリ秒で完了する。
//
// [構造]
//   pools:  アドレス → { token0, token1, raw0, raw1, feeBps, dexId, chain }
//   byPair: "chain::tokenA|tokenB" → そのペアを扱うプールのアドレス一覧
//   byToken: "chain::token" → そのトークンを含むプールのアドレス一覧(三角裁定用)
//
// トークンの並びは常に辞書順に正規化して保持する(A-BとB-Aを同一視するため)。

const pools = new Map();
const byPair = new Map();
const byToken = new Map();
const tokenDecimals = new Map(); // "chain::token" -> decimals
const tokenPriceUsd = new Map(); // "chain::token" -> USD価格

function pairKey(chain, tokenA, tokenB) {
  const [a, b] = [tokenA.toLowerCase(), tokenB.toLowerCase()].sort();
  return `${chain}::${a}|${b}`;
}
function tokenKey(chain, token) {
  return `${chain}::${token.toLowerCase()}`;
}
function poolKey(chain, address) {
  return `${chain}::${address.toLowerCase()}`;
}

/// プールを地図に登録する(起動時の一括取り込み、および新規発見時)。
export function registerPool({ chain, address, dexId, token0, token1, raw0, raw1, feeBps = 30 }) {
  const key = poolKey(chain, address);
  const existing = pools.get(key);
  pools.set(key, {
    chain, address, dexId,
    token0: token0.toLowerCase(), token1: token1.toLowerCase(),
    raw0, raw1,
    feeBps: existing?.feeBps ?? feeBps,
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

/// Syncイベントで届いた最新の準備量をメモリ上に反映する(RPC不要)。
/// 戻り値: 更新できたプール情報(登録外なら null)。
export function updateReservesFromSync(chain, address, raw0, raw1) {
  const key = poolKey(chain, address);
  const pool = pools.get(key);
  if (!pool) return null;
  pool.raw0 = raw0;
  pool.raw1 = raw1;
  pool.updatedAt = Date.now();
  return pool;
}

/// 実測した手数料を記録する(プール自身のgetAmountOutから逆算した値)。
export function setPoolFee(chain, address, feeBps) {
  const pool = pools.get(poolKey(chain, address));
  if (pool && feeBps != null) pool.feeBps = feeBps;
}

export function getPool(chain, address) {
  return pools.get(poolKey(chain, address)) ?? null;
}

/// 指定ペアを扱う全プールを返す(2ステップ裁定用)。
export function getPoolsForPair(chain, tokenA, tokenB) {
  const set = byPair.get(pairKey(chain, tokenA, tokenB));
  if (!set) return [];
  return [...set].map((k) => pools.get(k)).filter(Boolean);
}

/// 指定トークンを含む全プールを返す(三角裁定の経路探索用)。
export function getPoolsForToken(chain, token) {
  const set = byToken.get(tokenKey(chain, token));
  if (!set) return [];
  return [...set].map((k) => pools.get(k)).filter(Boolean);
}

/// 同じペアを2つ以上のプールが扱っている組み合わせを列挙する。
/// これが2ステップ裁定の候補そのものになる。
export function getArbitragablePairs(chain = null) {
  const out = [];
  for (const [pk, set] of byPair.entries()) {
    if (set.size < 2) continue;
    const [chainPart] = pk.split("::");
    if (chain && chainPart !== chain) continue;
    const list = [...set].map((k) => pools.get(k)).filter(Boolean);
    if (list.length < 2) continue;
    // 同じDEXの同じプールだけの場合は除外(異なるプールが2つ以上必要)。
    const uniqueAddresses = new Set(list.map((p) => p.address.toLowerCase()));
    if (uniqueAddresses.size < 2) continue;
    out.push({ chain: chainPart, token0: list[0].token0, token1: list[0].token1, pools: list });
  }
  return out;
}

export function setTokenDecimals(chain, token, decimals) {
  tokenDecimals.set(tokenKey(chain, token), decimals);
}
export function getTokenDecimals(chain, token) {
  return tokenDecimals.get(tokenKey(chain, token)) ?? null;
}
export function setTokenPriceUsd(chain, token, price) {
  if (price > 0 && isFinite(price)) tokenPriceUsd.set(tokenKey(chain, token), price);
}
export function getTokenPriceUsd(chain, token) {
  return tokenPriceUsd.get(tokenKey(chain, token)) ?? null;
}

/// 監視対象の全プールアドレスを、チェーンごとに返す(Sync購読の登録用)。
export function getAllPoolAddressesByChain() {
  const byChain = {};
  for (const pool of pools.values()) {
    (byChain[pool.chain] ||= []).push(pool.address);
  }
  return byChain;
}

export function getStats() {
  const byChain = {};
  let arbitragable = 0;
  for (const pool of pools.values()) {
    byChain[pool.chain] = (byChain[pool.chain] || 0) + 1;
  }
  for (const set of byPair.values()) if (set.size >= 2) arbitragable++;
  return {
    totalPools: pools.size,
    totalPairs: byPair.size,
    arbitragablePairs: arbitragable,
    totalTokens: byToken.size,
    byChain,
  };
}

/// 準備量が長時間更新されていないプールを返す(定期的な読み直し用)。
export function getStalePools(chain, olderThanMs) {
  const cutoff = Date.now() - olderThanMs;
  const out = [];
  for (const pool of pools.values()) {
    if (pool.chain !== chain) continue;
    if (pool.updatedAt < cutoff) out.push(pool);
  }
  return out;
}
