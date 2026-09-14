// scripts/opportunity-scanner.js
//
// メモリ上のプール地図から、裁定機会を探す。
// RPCへの問い合わせを一切行わず、全てメモリ上の計算で完結するため、
// Syncイベントが届いた瞬間(ミリ秒単位)に判定できる。
//
// [修正1] 全件スキャンが2ステップしか見ていなかった。Syncが届かない
// チェーン(Base・Arbitrum・Avalanche)では三角裁定が一度も評価されず、
// 機会の大半を見逃していた。全件スキャンでも三角を評価する。
//
// [修正2] 三角裁定は2段よりガス使用量が多いため、経路の種類に応じた
// ガス代を使う(以前は2段用を流用し、ガス代を過小に見ていた)。
//
// [修正3] 手数料が未実測のプールは既定30bpsとして扱われるが、実測すると
// それより高いことが多く、幻の黒字が生まれていた。未実測のプールには
// 保守的な値(UNPROBED_FEE_BPS)を当て、実測済みになってから本来の値で
// 判定する。

import {
  getPoolsForPair, getPoolsForToken, getArbitragablePairs,
  getTokenDecimals, getTokenPriceUsd, getPool,
} from "./pool-registry.js";

const AAVE_PREMIUM_BPS = 5n;
const MIN_TRADE_USD = parseFloat(process.env.MIN_TRADE_USD || "0");
// 手数料が未実測のプールに当てる想定値。実測すると30bpsより高いことが
// 多いため、楽観的な30bpsではなく少し高めに見る。
const UNPROBED_FEE_BPS = parseInt(process.env.UNPROBED_FEE_BPS || "45", 10);

function effectiveFeeBps(pool) {
  return pool.feeProbed ? pool.feeBps : Math.max(pool.feeBps, UNPROBED_FEE_BPS);
}

function getAmountOut(amountIn, reserveIn, reserveOut, feeBps) {
  if (amountIn <= 0n || reserveIn <= 0n || reserveOut <= 0n) return 0n;
  const amountInWithFee = amountIn * (10000n - BigInt(feeBps));
  const denominator = reserveIn * 10000n + amountInWithFee;
  return denominator === 0n ? 0n : (amountInWithFee * reserveOut) / denominator;
}

function orient(pool, tokenIn) {
  const isToken0In = pool.token0 === tokenIn.toLowerCase();
  return {
    reserveIn: isToken0In ? pool.raw0 : pool.raw1,
    reserveOut: isToken0In ? pool.raw1 : pool.raw0,
    tokenOut: isToken0In ? pool.token1 : pool.token0,
  };
}

function simulateRoute(amountIn, legs) {
  let amount = amountIn;
  for (const leg of legs) {
    amount = getAmountOut(amount, leg.reserveIn, leg.reserveOut, leg.feeBps);
    if (amount <= 0n) return 0n;
  }
  return amount;
}

function findBestAmount(maxAmountIn, legs) {
  let best = { amountIn: 0n, amountOut: 0n, profit: 0n };
  const ratios = [0.005, 0.01, 0.02, 0.04, 0.07, 0.12, 0.2, 0.3, 0.45, 0.6, 0.8, 1.0];
  for (const r of ratios) {
    const amountIn = (maxAmountIn * BigInt(Math.round(r * 100000))) / 100000n;
    if (amountIn <= 0n) continue;
    const amountOut = simulateRoute(amountIn, legs);
    const profit = amountOut - amountIn;
    if (profit > best.profit) best = { amountIn, amountOut, profit };
  }
  if (best.amountIn > 0n) {
    for (const r of [0.7, 0.85, 1.15, 1.3]) {
      const amountIn = (best.amountIn * BigInt(Math.round(r * 1000))) / 1000n;
      if (amountIn <= 0n || amountIn > maxAmountIn) continue;
      const amountOut = simulateRoute(amountIn, legs);
      const profit = amountOut - amountIn;
      if (profit > best.profit) best = { amountIn, amountOut, profit };
    }
  }
  return best;
}

function maxAmountFromUsd(chain, token, capUsd) {
  const decimals = getTokenDecimals(chain, token);
  const priceUsd = getTokenPriceUsd(chain, token);
  if (decimals == null || !priceUsd) return null;
  const amount = capUsd / priceUsd;
  try {
    const [intPart, fracPart = ""] = amount.toFixed(Math.min(decimals, 18)).split(".");
    return BigInt(intPart + fracPart.padEnd(decimals, "0").slice(0, decimals));
  } catch (e) { return null; }
}

function finalize({ chain, tokenA, legs, maxAmountIn, gasCostUsd, label, kind, poolAddresses }) {
  const best = findBestAmount(maxAmountIn, legs);
  if (best.profit <= 0n) return null;

  const amountOwed = best.amountIn + (best.amountIn * AAVE_PREMIUM_BPS) / 10000n;
  if (best.amountOut <= amountOwed) return null;

  const decimals = getTokenDecimals(chain, tokenA);
  const priceUsd = getTokenPriceUsd(chain, tokenA);
  if (decimals == null || !priceUsd) return null;

  const toNumber = (v) => Number(v) / Math.pow(10, decimals);
  const tradeAmountUsd = toNumber(best.amountIn) * priceUsd;
  if (MIN_TRADE_USD > 0 && tradeAmountUsd < MIN_TRADE_USD) return null;

  const grossProfitUsd = toNumber(best.amountOut - amountOwed) * priceUsd;
  const netProfitUsd = grossProfitUsd - gasCostUsd;
  const feeWallBps = legs.reduce((s, l) => s + l.feeBps, 0) + 5;

  return {
    kind, chain, tokenA, label, poolAddresses, legs,
    amountIn: best.amountIn,
    amountOutEstimated: best.amountOut,
    amountOwed,
    tradeAmountUsd, grossProfitUsd, netProfitUsd,
    feeWallPercent: feeWallBps / 100,
    profitable: netProfitUsd > 0,
  };
}

export function scanTwoStep({ chain, tokenA, tokenB, pools, capUsd, gasCostUsd, isBorrowable }) {
  if (pools.length < 2) return null;
  const candidates = [];
  for (const [borrow, other] of [[tokenA, tokenB], [tokenB, tokenA]]) {
    if (!isBorrowable(chain, borrow)) continue;
    const maxAmountIn = maxAmountFromUsd(chain, borrow, capUsd);
    if (!maxAmountIn) continue;

    // 価格順に並べ、最も有利に買えるプールと売れるプールの組だけを見る。
    const priced = [];
    for (const p of pools) {
      const o = orient(p, borrow);
      if (o.tokenOut !== other.toLowerCase()) continue;
      if (o.reserveIn <= 0n || o.reserveOut <= 0n) continue;
      priced.push({ pool: p, orientation: o, rate: Number(o.reserveOut) / Number(o.reserveIn) });
    }
    if (priced.length < 2) continue;
    priced.sort((a, b) => b.rate - a.rate);

    const buySide = priced[0], sellSide = priced[priced.length - 1];
    if (buySide.pool.address.toLowerCase() === sellSide.pool.address.toLowerCase()) continue;
    const leg2 = orient(sellSide.pool, other);
    if (leg2.tokenOut !== borrow.toLowerCase()) continue;

    const legs = [
      { ...buySide.orientation, feeBps: effectiveFeeBps(buySide.pool) },
      { ...leg2, feeBps: effectiveFeeBps(sellSide.pool) },
    ];
    const result = finalize({
      chain, tokenA: borrow, legs, maxAmountIn, gasCostUsd, kind: "2step",
      label: `${buySide.pool.dexId}→${sellSide.pool.dexId}`,
      poolAddresses: [buySide.pool.address, sellSide.pool.address],
    });
    if (result) candidates.push(result);
  }
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => b.netProfitUsd - a.netProfitUsd);
  return candidates[0];
}

export function scanTrianglesForPool({ chain, pool, capUsd, gasCostUsd, isBorrowable, maxRoutes = 60 }) {
  const results = [];
  let examined = 0;
  for (const [tokenA, tokenB] of [[pool.token0, pool.token1], [pool.token1, pool.token0]]) {
    if (!isBorrowable(chain, tokenA)) continue;
    const maxAmountIn = maxAmountFromUsd(chain, tokenA, capUsd);
    if (!maxAmountIn) continue;
    const leg1 = orient(pool, tokenA);
    if (leg1.tokenOut !== tokenB) continue;
    if (leg1.reserveIn <= 0n || leg1.reserveOut <= 0n) continue;

    for (const pool2 of getPoolsForToken(chain, tokenB)) {
      if (examined > maxRoutes) break;
      if (pool2.address.toLowerCase() === pool.address.toLowerCase()) continue;
      const leg2 = orient(pool2, tokenB);
      const tokenC = leg2.tokenOut;
      if (tokenC === tokenA) continue;
      if (leg2.reserveIn <= 0n || leg2.reserveOut <= 0n) continue;

      for (const pool3 of getPoolsForPair(chain, tokenC, tokenA)) {
        const addr3 = pool3.address.toLowerCase();
        if (addr3 === pool.address.toLowerCase() || addr3 === pool2.address.toLowerCase()) continue;
        const leg3 = orient(pool3, tokenC);
        if (leg3.tokenOut !== tokenA) continue;
        if (leg3.reserveIn <= 0n || leg3.reserveOut <= 0n) continue;
        examined++;
        if (examined > maxRoutes) break;

        const legs = [
          { ...leg1, feeBps: effectiveFeeBps(pool) },
          { ...leg2, feeBps: effectiveFeeBps(pool2) },
          { ...leg3, feeBps: effectiveFeeBps(pool3) },
        ];
        const result = finalize({
          chain, tokenA, legs, maxAmountIn, gasCostUsd, kind: "3step",
          label: `${pool.dexId}→${pool2.dexId}→${pool3.dexId}`,
          poolAddresses: [pool.address, pool2.address, pool3.address],
        });
        if (result) results.push(result);
      }
    }
  }
  if (results.length === 0) return null;
  results.sort((a, b) => b.netProfitUsd - a.netProfitUsd);
  return results[0];
}

/// 変化したプールを起点に、2ステップと三角の両方を調べて最良のものを返す。
export function scanForChangedPool({ chain, poolAddress, capUsd, gasCostUsd, gasCostUsd3, isBorrowable }) {
  const pool = getPool(chain, poolAddress);
  if (!pool) return null;
  const found = [];
  const twoStep = scanTwoStep({
    chain, tokenA: pool.token0, tokenB: pool.token1,
    pools: getPoolsForPair(chain, pool.token0, pool.token1),
    capUsd, gasCostUsd, isBorrowable,
  });
  if (twoStep) found.push(twoStep);
  const three = scanTrianglesForPool({
    chain, pool, capUsd,
    gasCostUsd: gasCostUsd3 ?? gasCostUsd * 1.35,
    isBorrowable,
  });
  if (three) found.push(three);
  if (found.length === 0) return null;
  found.sort((a, b) => b.netProfitUsd - a.netProfitUsd);
  return found[0];
}

/// 全件スキャン。2ステップに加えて三角も評価する。
/// Syncが届かないチェーンでは、これが唯一の判定機会になるため、
/// 三角を省くと機会の大半を見逃す。
/// maxTrianglePools は1回あたりに三角の起点として調べるプール数の上限
/// (全プールを起点にすると計算量が膨大になるため)。
export function scanAllPairs({ chain, capUsd, gasCostUsd, gasCostUsd3, isBorrowable, maxTrianglePools = 400 }) {
  const results = [];
  const seenPools = new Set();

  for (const entry of getArbitragablePairs(chain)) {
    const r = scanTwoStep({
      chain: entry.chain, tokenA: entry.token0, tokenB: entry.token1,
      pools: entry.pools, capUsd, gasCostUsd, isBorrowable,
    });
    if (r) results.push(r);
    for (const p of entry.pools) seenPools.add(p.address.toLowerCase());
  }

  // 三角の起点は「複数プールを持つペア」に含まれるプールから選ぶ。
  // 取引が活発で、裁定の対象になりやすいため。
  const triGas = gasCostUsd3 ?? gasCostUsd * 1.35;
  let count = 0;
  for (const entry of getArbitragablePairs(chain)) {
    for (const pool of entry.pools) {
      if (count >= maxTrianglePools) break;
      count++;
      const t = scanTrianglesForPool({ chain, pool, capUsd, gasCostUsd: triGas, isBorrowable, maxRoutes: 20 });
      if (t) results.push(t);
    }
    if (count >= maxTrianglePools) break;
  }

  results.sort((a, b) => b.netProfitUsd - a.netProfitUsd);
  return results;
}
