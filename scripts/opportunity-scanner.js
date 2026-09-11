// scripts/opportunity-scanner.js
//
// メモリ上のプール地図から、裁定機会を探す。
//
// [設計の要点]
// RPCへの問い合わせを一切行わない。全てメモリ上の計算で完結するため、
// Syncイベントが届いた瞬間(ミリ秒単位)に判定できる。
// 送信直前の最終確認だけは、実行側(execute-arb.js)がRPCで行う。
//
// [2種類の機会]
//   2ステップ … 同じペアを扱う2つのプール間の価格差
//   三角     … A→B→C→Aと巡回したときの相対価格の歪み

import {
  getPoolsForPair, getPoolsForToken, getArbitragablePairs,
  getTokenDecimals, getTokenPriceUsd, getPool,
} from "./pool-registry.js";

const AAVE_PREMIUM_BPS = 5n;

/// Uniswap V2形式の定数積AMM。Solidly系のvolatileプールも同じ式。
function getAmountOut(amountIn, reserveIn, reserveOut, feeBps) {
  if (amountIn <= 0n || reserveIn <= 0n || reserveOut <= 0n) return 0n;
  const amountInWithFee = amountIn * (10000n - BigInt(feeBps));
  const denominator = reserveIn * 10000n + amountInWithFee;
  return denominator === 0n ? 0n : (amountInWithFee * reserveOut) / denominator;
}

/// プールを「入力トークン側・出力トークン側」に向き付けする。
function orient(pool, tokenIn) {
  const isToken0In = pool.token0 === tokenIn.toLowerCase();
  return {
    reserveIn: isToken0In ? pool.raw0 : pool.raw1,
    reserveOut: isToken0In ? pool.raw1 : pool.raw0,
    tokenOut: isToken0In ? pool.token1 : pool.token0,
  };
}

/// 巡回経路(legs)を1周したときの受取量を試算する。
function simulateRoute(amountIn, legs) {
  let amount = amountIn;
  for (const leg of legs) {
    amount = getAmountOut(amount, leg.reserveIn, leg.reserveOut, leg.feeBps);
    if (amount <= 0n) return 0n;
  }
  return amount;
}

/// 利益が最大になる投入額を探す。
/// 閉じた解の公式は2プールの場合しか無いため、倍率を変えて実測する。
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
  // 最良点の周辺をさらに細かく探る。
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

/// 借りる通貨の投入上限を、USD上限から逆算する。
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

/// 共通の利益判定。legs を1周した結果から、USD建ての純利益を求める。
function finalize({ chain, tokenA, legs, maxAmountIn, gasCostUsd, label, kind, poolAddresses }) {
  const best = findBestAmount(maxAmountIn, legs);
  if (best.profit <= 0n) return null;

  const amountOwed = best.amountIn + (best.amountIn * AAVE_PREMIUM_BPS) / 10000n;
  if (best.amountOut <= amountOwed) return null;

  const decimals = getTokenDecimals(chain, tokenA);
  const priceUsd = getTokenPriceUsd(chain, tokenA);
  if (decimals == null || !priceUsd) return null;

  const toNumber = (v) => Number(v) / Math.pow(10, decimals);
  const grossProfitUsd = toNumber(best.amountOut - amountOwed) * priceUsd;
  const netProfitUsd = grossProfitUsd - gasCostUsd;

  // 手数料の壁: 往復の手数料合計 + Aave手数料。
  const feeWallBps = legs.reduce((s, l) => s + l.feeBps, 0) + 5;

  return {
    kind, chain, tokenA, label, poolAddresses, legs,
    amountIn: best.amountIn,
    amountOutEstimated: best.amountOut,
    amountOwed,
    tradeAmountUsd: toNumber(best.amountIn) * priceUsd,
    grossProfitUsd, netProfitUsd,
    feeWallPercent: feeWallBps / 100,
    profitable: netProfitUsd > 0,
  };
}

/// 2ステップ裁定: 同じペアの2プール間の価格差。
/// borrowableTokens には、そのチェーンでフラッシュローンできるトークンを渡す。
export function scanTwoStep({ chain, tokenA, tokenB, pools, capUsd, gasCostUsd, isBorrowable }) {
  if (pools.length < 2) return null;

  // 借りられる側を起点にする。両方借りられるなら利益の大きい方を後で選ぶ。
  const candidates = [];
  for (const [borrow, other] of [[tokenA, tokenB], [tokenB, tokenA]]) {
    if (!isBorrowable(chain, borrow)) continue;
    const maxAmountIn = maxAmountFromUsd(chain, borrow, capUsd);
    if (!maxAmountIn) continue;

    // 全プールの組み合わせを試す(3つ以上ある場合、最良の組を選ぶため)。
    for (const poolBuy of pools) {
      for (const poolSell of pools) {
        if (poolBuy.address.toLowerCase() === poolSell.address.toLowerCase()) continue;
        const leg1 = orient(poolBuy, borrow);
        const leg2 = orient(poolSell, other);
        if (leg1.tokenOut !== other.toLowerCase()) continue;
        if (leg2.tokenOut !== borrow.toLowerCase()) continue;

        const legs = [
          { ...leg1, feeBps: poolBuy.feeBps },
          { ...leg2, feeBps: poolSell.feeBps },
        ];
        const result = finalize({
          chain, tokenA: borrow, legs, maxAmountIn, gasCostUsd,
          kind: "2step",
          label: `${poolBuy.dexId}→${poolSell.dexId}`,
          poolAddresses: [poolBuy.address, poolSell.address],
        });
        if (result) candidates.push(result);
      }
    }
  }
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => b.netProfitUsd - a.netProfitUsd);
  return candidates[0];
}

/// 三角裁定: A→B→C→A。
/// changedPool を起点に、それを含む経路だけを探す(高速化のため)。
export function scanTrianglesForPool({ chain, pool, capUsd, gasCostUsd, isBorrowable, maxRoutes = 60 }) {
  const results = [];
  let examined = 0;

  // このプールが繋ぐ2トークンのうち、借りられる方を起点にする。
  for (const [tokenA, tokenB] of [[pool.token0, pool.token1], [pool.token1, pool.token0]]) {
    if (!isBorrowable(chain, tokenA)) continue;
    const maxAmountIn = maxAmountFromUsd(chain, tokenA, capUsd);
    if (!maxAmountIn) continue;

    // A→B は changedPool を使う(この経路を再計算したいのが目的のため)。
    const leg1 = orient(pool, tokenA);
    if (leg1.tokenOut !== tokenB) continue;

    // B→C を探す。
    for (const pool2 of getPoolsForToken(chain, tokenB)) {
      if (pool2.address.toLowerCase() === pool.address.toLowerCase()) continue;
      const leg2 = orient(pool2, tokenB);
      const tokenC = leg2.tokenOut;
      if (tokenC === tokenA) continue;

      // C→A を探す。
      for (const pool3 of getPoolsForPair(chain, tokenC, tokenA)) {
        const addr3 = pool3.address.toLowerCase();
        if (addr3 === pool.address.toLowerCase() || addr3 === pool2.address.toLowerCase()) continue;
        const leg3 = orient(pool3, tokenC);
        if (leg3.tokenOut !== tokenA) continue;

        examined++;
        if (examined > maxRoutes) break;

        const legs = [
          { ...leg1, feeBps: pool.feeBps },
          { ...leg2, feeBps: pool2.feeBps },
          { ...leg3, feeBps: pool3.feeBps },
        ];
        const result = finalize({
          chain, tokenA, legs, maxAmountIn, gasCostUsd,
          kind: "3step",
          label: `${pool.dexId}→${pool2.dexId}→${pool3.dexId}`,
          poolAddresses: [pool.address, pool2.address, pool3.address],
        });
        if (result) results.push(result);
      }
      if (examined > maxRoutes) break;
    }
  }

  if (results.length === 0) return null;
  results.sort((a, b) => b.netProfitUsd - a.netProfitUsd);
  return results[0];
}

/// 変化したプールを起点に、2ステップと三角の両方を調べて最良のものを返す。
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

/// 全ペアを一巡して調べる(起動直後や、Sync購読が無いチェーン用)。
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
