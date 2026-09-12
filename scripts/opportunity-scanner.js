// scripts/opportunity-scanner.js
//
// メモリ上のプール地図から、裁定機会を探す。
//
// [設計の要点]
// RPCへの問い合わせを一切行わない。全てメモリ上の計算で完結するため、
// Syncイベントが届いた瞬間(ミリ秒単位)に判定できる。
//
// [最低投入額]
// 投入$5〜17の極小プールで検出した機会は、送信すると「K」や理由なしの
// revertで拒否された。極小プールは送金に税がかかるトークンや非標準の
// 挙動が多く、成功率が低い。一定額未満の案件は最初から除外する。

import {
  getPoolsForPair, getPoolsForToken, getArbitragablePairs,
  getTokenDecimals, getTokenPriceUsd, getPool,
} from "./pool-registry.js";

const AAVE_PREMIUM_BPS = 5n;
// この額未満の投入にしかならない案件は、極小プールとみなして除外する。
const MIN_TRADE_USD = parseFloat(process.env.MIN_TRADE_USD || "50");

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
  // 極小プールの案件は除外する(成功率が低く、利益も僅か)。
  if (tradeAmountUsd < MIN_TRADE_USD) return null;

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
      { ...buySide.orientation, feeBps: buySide.pool.feeBps },
      { ...leg2, feeBps: sellSide.pool.feeBps },
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
          { ...leg1, feeBps: pool.feeBps },
          { ...leg2, feeBps: pool2.feeBps },
          { ...leg3, feeBps: pool3.feeBps },
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

export function scanForChangedPool({ chain, poolAddress, capUsd, gasCostUsd, isBorrowable }) {
  const pool = getPool(chain, poolAddress);
  if (!pool) return null;
  const found = [];
  const twoStep = scanTwoStep({
    chain, tokenA: pool.token0, tokenB: pool.token1,
    pools: getPoolsForPair(chain, pool.token0, pool.token1),
    capUsd, gasCostUsd, isBorrowable,
  });
  if (twoStep) found.push(twoStep);
  const three = scanTrianglesForPool({ chain, pool, capUsd, gasCostUsd, isBorrowable });
  if (three) found.push(three);
  if (found.length === 0) return null;
  found.sort((a, b) => b.netProfitUsd - a.netProfitUsd);
  return found[0];
}

export function scanAllPairs({ chain, capUsd, gasCostUsd, isBorrowable }) {
  const results = [];
  for (const entry of getArbitragablePairs(chain)) {
    const r = scanTwoStep({
      chain: entry.chain, tokenA: entry.token0, tokenB: entry.token1,
      pools: entry.pools, capUsd, gasCostUsd, isBorrowable,
    });
    if (r) results.push(r);
  }
  results.sort((a, b) => b.netProfitUsd - a.netProfitUsd);
  return results;
}
