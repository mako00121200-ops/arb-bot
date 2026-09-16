// scripts/opportunity-scanner.js
//
// メモリ上のプール地図から、裁定機会を探す。
// RPCへの問い合わせを一切行わず、全てメモリ上の計算で完結するため、
// イベントが届いた瞬間(ミリ秒単位)に判定できる。
//
// [フラッシュスワップ方式]
// 経路の最初のプール自身から借りるため、Aaveの手数料0.05%がかからなくなった。
// 判定でもこの手数料を差し引かない。
//
// [V2とV3の混在]
// 経路の各段はV2形式でもV3形式でも構わない。同じペアにV2とV3が共存している
// 場合が最も機会が生まれやすいため、それらを優先して組み合わせる。
//   V2 … 準備量(x·y=k)から計算する。
//   V3 … 現在価格と流動性から概算する(価格帯をまたぐと誤差が出るため、
//        送信直前に公式のQuoterで正確に確認する)。

import {
  getPoolsForPair, getPoolsForToken, getArbitragablePairs,
  getTokenDecimals, getTokenPriceUsd, getPool, hasUsableState,
  KIND_V2, KIND_V3,
} from "./pool-registry.js";
import { estimateV3AmountOut } from "./v3-pools.js";

const MIN_TRADE_USD = parseFloat(process.env.MIN_TRADE_USD || "0");
// 手数料が未実測のV2プールに当てる想定値。30bpsは楽観的すぎることが多い。
const UNPROBED_FEE_BPS = parseInt(process.env.UNPROBED_FEE_BPS || "45", 10);
// V3の概算は価格帯をまたぐと過大になるため、この割合だけ割り引いて見る。
const V3_ESTIMATE_DISCOUNT_BPS = parseInt(process.env.V3_ESTIMATE_DISCOUNT_BPS || "15", 10);

function effectiveFeeBps(pool) {
  if (pool.kind === KIND_V3) return pool.feeBps;
  return pool.feeProbed ? pool.feeBps : Math.max(pool.feeBps, UNPROBED_FEE_BPS);
}

function getAmountOutV2(amountIn, reserveIn, reserveOut, feeBps) {
  if (amountIn <= 0n || reserveIn <= 0n || reserveOut <= 0n) return 0n;
  const amountInWithFee = amountIn * (10000n - BigInt(feeBps));
  const denominator = reserveIn * 10000n + amountInWithFee;
  return denominator === 0n ? 0n : (amountInWithFee * reserveOut) / denominator;
}

function legAmountOut(leg, amountIn) {
  if (amountIn <= 0n) return 0n;
  if (leg.kind === KIND_V3) {
    const out = estimateV3AmountOut({
      amountIn,
      sqrtPriceX96: leg.sqrtPriceX96,
      liquidity: leg.liquidity,
      feeBps: leg.feeBps,
      zeroForOne: leg.zeroForOne,
    });
    return (out * (10000n - BigInt(V3_ESTIMATE_DISCOUNT_BPS))) / 10000n;
  }
  return getAmountOutV2(amountIn, leg.reserveIn, leg.reserveOut, leg.feeBps);
}

function orient(pool, tokenIn) {
  const inLower = tokenIn.toLowerCase();
  const isToken0In = pool.token0 === inLower;
  const tokenOut = isToken0In ? pool.token1 : pool.token0;
  const base = {
    kind: pool.kind,
    pool: pool.address,
    dexId: pool.dexId,
    tokenIn: inLower,
    tokenOut,
    feeBps: effectiveFeeBps(pool),
    feeTier: pool.feeTier,
  };
  if (pool.kind === KIND_V3) {
    return { ...base, sqrtPriceX96: pool.sqrtPriceX96, liquidity: pool.liquidity, zeroForOne: isToken0In };
  }
  return {
    ...base,
    reserveIn: isToken0In ? pool.raw0 : pool.raw1,
    reserveOut: isToken0In ? pool.raw1 : pool.raw0,
  };
}

function rateOf(leg) {
  if (leg.kind === KIND_V3) {
    if (leg.sqrtPriceX96 <= 0n) return 0;
    const r = Number(leg.sqrtPriceX96) / Number(2n ** 96n);
    const price = r * r;
    return leg.zeroForOne ? price : (price > 0 ? 1 / price : 0);
  }
  if (leg.reserveIn <= 0n) return 0;
  return Number(leg.reserveOut) / Number(leg.reserveIn);
}

function simulateRoute(amountIn, legs) {
  let amount = amountIn;
  for (const leg of legs) {
    amount = legAmountOut(leg, amount);
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

  const decimals = getTokenDecimals(chain, tokenA);
  const priceUsd = getTokenPriceUsd(chain, tokenA);
  if (decimals == null || !priceUsd) return null;

  const toNumber = (v) => Number(v) / Math.pow(10, decimals);
  const tradeAmountUsd = toNumber(best.amountIn) * priceUsd;
  if (MIN_TRADE_USD > 0 && tradeAmountUsd < MIN_TRADE_USD) return null;

  // フラッシュスワップ方式のため、借入手数料は差し引かない。
  const grossProfitUsd = toNumber(best.profit) * priceUsd;
  const netProfitUsd = grossProfitUsd - gasCostUsd;
  const feeWallBps = legs.reduce((s, l) => s + l.feeBps, 0);
  const hasV3 = legs.some((l) => l.kind === KIND_V3);

  return {
    kind, chain, tokenA, label, poolAddresses, legs, hasV3,
    amountIn: best.amountIn,
    amountOutEstimated: best.amountOut,
    amountOwed: best.amountIn,
    tradeAmountUsd, grossProfitUsd, netProfitUsd,
    feeWallPercent: feeWallBps / 100,
    profitable: netProfitUsd > 0,
  };
}

function labelOf(legs) {
  return legs.map((l) => `${l.dexId}${l.kind === KIND_V3 ? `(${(l.feeBps / 100).toFixed(2)}%)` : ""}`).join("→");
}

export function scanTwoStep({ chain, tokenA, tokenB, pools, capUsd, gasCostUsd, isBorrowable }) {
  const usable = pools.filter(hasUsableState);
  if (usable.length < 2) return null;

  const candidates = [];
  for (const [borrow, other] of [[tokenA, tokenB], [tokenB, tokenA]]) {
    if (!isBorrowable(chain, borrow)) continue;
    const maxAmountIn = maxAmountFromUsd(chain, borrow, capUsd);
    if (!maxAmountIn) continue;

    const priced = [];
    for (const p of usable) {
      const leg = orient(p, borrow);
      if (leg.tokenOut !== other.toLowerCase()) continue;
      const rate = rateOf(leg);
      if (!isFinite(rate) || rate <= 0) continue;
      priced.push({ pool: p, leg, rate });
    }
    if (priced.length < 2) continue;
    priced.sort((a, b) => b.rate - a.rate);

    const buySide = priced[0], sellSide = priced[priced.length - 1];
    if (buySide.pool.address.toLowerCase() === sellSide.pool.address.toLowerCase()) continue;
    const leg2 = orient(sellSide.pool, other);
    if (leg2.tokenOut !== borrow.toLowerCase()) continue;

    const legs = [buySide.leg, leg2];
    const result = finalize({
      chain, tokenA: borrow, legs, maxAmountIn, gasCostUsd, kind: "2step",
      label: labelOf(legs),
      poolAddresses: [buySide.pool.address, sellSide.pool.address],
    });
    if (result) candidates.push(result);
  }
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => b.netProfitUsd - a.netProfitUsd);
  return candidates[0];
}

export function scanTrianglesForPool({ chain, pool, capUsd, gasCostUsd, isBorrowable, maxRoutes = 60 }) {
  if (!hasUsableState(pool)) return null;
  const results = [];
  let examined = 0;

  for (const [tokenA, tokenB] of [[pool.token0, pool.token1], [pool.token1, pool.token0]]) {
    if (!isBorrowable(chain, tokenA)) continue;
    const maxAmountIn = maxAmountFromUsd(chain, tokenA, capUsd);
    if (!maxAmountIn) continue;
    const leg1 = orient(pool, tokenA);
    if (leg1.tokenOut !== tokenB) continue;

    for (const pool2 of getPoolsForToken(chain, tokenB)) {
      if (examined > maxRoutes) break;
      if (pool2.address.toLowerCase() === pool.address.toLowerCase()) continue;
      if (!hasUsableState(pool2)) continue;
      const leg2 = orient(pool2, tokenB);
      const tokenC = leg2.tokenOut;
      if (tokenC === tokenA) continue;

      for (const pool3 of getPoolsForPair(chain, tokenC, tokenA)) {
        const addr3 = pool3.address.toLowerCase();
        if (addr3 === pool.address.toLowerCase() || addr3 === pool2.address.toLowerCase()) continue;
        if (!hasUsableState(pool3)) continue;
        const leg3 = orient(pool3, tokenC);
        if (leg3.tokenOut !== tokenA) continue;
        examined++;
        if (examined > maxRoutes) break;

        const legs = [leg1, leg2, leg3];
        const result = finalize({
          chain, tokenA, legs, maxAmountIn, gasCostUsd, kind: "3step",
          label: labelOf(legs),
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

export function scanAllPairs({ chain, capUsd, gasCostUsd, gasCostUsd3, isBorrowable, maxTrianglePools = 400 }) {
  const results = [];
  const entries = getArbitragablePairs(chain);

  entries.sort((a, b) => {
    const mixA = new Set(a.pools.map((p) => p.kind)).size > 1 ? 1 : 0;
    const mixB = new Set(b.pools.map((p) => p.kind)).size > 1 ? 1 : 0;
    return mixB - mixA;
  });

  for (const entry of entries) {
    const r = scanTwoStep({
      chain: entry.chain, tokenA: entry.token0, tokenB: entry.token1,
      pools: entry.pools, capUsd, gasCostUsd, isBorrowable,
    });
    if (r) results.push(r);
  }

  const triGas = gasCostUsd3 ?? gasCostUsd * 1.35;
  let count = 0;
  for (const entry of entries) {
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
