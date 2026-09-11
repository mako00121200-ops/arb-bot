// scripts/triangular-arb.js
//
// 三角裁定(A → B → C → A)の探索と実行。
//
// [なぜ有効か]
// 2ステップ裁定は「同じペアが2つのDEXにある」ことが前提で、大手botが
// 常時監視しているため価格差が残らない。一方、三角裁定は同じDEX内の
// 3つのトークンの相対価格の歪みを取るため、組み合わせの数が桁違いに多く、
// 監視が行き届いていない組み合わせが残りやすい。
//
// [仕組み]
// 借りる通貨Aから出発し、A→B→C→Aと巡回して、戻ってきた量が借りた量
// (+Aave手数料)を上回れば利益。x*y=kの積が3つのプールで整合していない
// ときに発生する。
//
// [安全性]
// 既存の2ステップと同じくフラッシュローンを使うため、利益が出なければ
// 取引全体が無効化される(実害はガス代のみ)。

import { ethers } from "ethers";
import { getChainConfig } from "../chain-config.js";
import { callWithRpc } from "./onchain-reserves.js";
import { fetchReservesBatch } from "./multicall-reserves.js";
import { getCurrentTradeCapUsd, recordExecutionSuccess } from "./trade-cap.js";
import { recordRealExecution } from "./real-execution-log.js";
import { estimateGasCostUsd } from "./gas-cost.js";

const CONTRACT_ABI = [
  "function executeTriArb(address asset, uint256 amount, (address pool1, address pool2, address pool3, address tokenA, address tokenB, address tokenC, uint256 amountOut1, uint256 amountOut2, uint256 amountOut3) params) external",
  "event TriArbExecuted(address indexed tokenA, uint256 amountBorrowed, uint256 profit)",
];
const POOL_QUOTE_ABI = ["function getAmountOut(uint256 amountIn, address tokenIn) view returns (uint256)"];

const AAVE_PREMIUM_BPS = 5n;
const MIN_PROFIT_USD = parseFloat(process.env.MIN_PROFIT_USD || "0.05");
const SAFETY_MARGIN_BPS = 5n;
// 3ステップはガス使用量が2ステップより多い(おおよそ1.3倍)。
const TRI_GAS_MULTIPLIER = 1.3;

function getAmountOutCalc(amountIn, reserveIn, reserveOut, feeBps) {
  const amountInWithFee = amountIn * (10000n - BigInt(feeBps));
  const denominator = reserveIn * 10000n + amountInWithFee;
  return denominator === 0n ? 0n : (amountInWithFee * reserveOut) / denominator;
}

/// プール自身に聞き、答えられなければ準備量から自前計算する。
async function quoteOut({ chain, pool, amountIn, tokenIn, reserveIn, reserveOut, feeBps }) {
  try {
    const out = await callWithRpc(chain, (p) =>
      new ethers.Contract(ethers.getAddress(pool), POOL_QUOTE_ABI, p).getAmountOut(amountIn, ethers.getAddress(tokenIn)));
    if (out > 0n) return out;
  } catch (e) { /* この形式のプールではない */ }
  return getAmountOutCalc(amountIn, reserveIn, reserveOut, feeBps);
}

/// プールの準備量から、tokenIn側・tokenOut側を取り出す。
function orient(poolData, tokenIn) {
  const isToken0In = poolData.token0.toLowerCase() === tokenIn.toLowerCase();
  return {
    reserveIn: isToken0In ? poolData.raw0 : poolData.raw1,
    reserveOut: isToken0In ? poolData.raw1 : poolData.raw0,
  };
}

/// 巡回1周の結果を、準備量から高速に試算する(RPCを使わない)。
function simulateLoop(amountIn, legs) {
  let amount = amountIn;
  for (const leg of legs) {
    amount = getAmountOutCalc(amount, leg.reserveIn, leg.reserveOut, leg.feeBps);
    if (amount <= 0n) return 0n;
  }
  return amount;
}

/// 利益が最大になる投入額を、倍率を変えながら探す。
/// 三角裁定には2ステップのような閉じた解の公式が無いため、実測で探す。
function findBestAmount(maxAmountIn, legs) {
  let best = { amountIn: 0n, amountOut: 0n, profit: 0n };
  // 上限の1%から100%まで、対数的に刻んで試す。
  const ratios = [0.01, 0.02, 0.05, 0.1, 0.15, 0.2, 0.3, 0.4, 0.5, 0.65, 0.8, 1.0];
  for (const r of ratios) {
    const amountIn = (maxAmountIn * BigInt(Math.round(r * 10000))) / 10000n;
    if (amountIn <= 0n) continue;
    const amountOut = simulateLoop(amountIn, legs);
    const profit = amountOut - amountIn;
    if (profit > best.profit) best = { amountIn, amountOut, profit };
  }
  return best;
}

/// 1つの三角経路を評価する。
/// route: { chain, symbolA/B/C, tokenA/B/C, decimalsA, priceUsdPerA,
///          pools: [{address, feeBps}, ...3つ] }
export async function evaluateTriangle(route, gasCostUsd) {
  const poolAddresses = route.pools.map((p) => ({ address: p.address }));
  const batch = await fetchReservesBatch(route.chain, poolAddresses);

  const tokens = [route.tokenA, route.tokenB, route.tokenC, route.tokenA];
  const legs = [];
  for (let i = 0; i < 3; i++) {
    const data = batch.get(route.pools[i].address.toLowerCase());
    if (!data) return null;
    const { reserveIn, reserveOut } = orient(data, tokens[i]);
    if (reserveIn <= 0n || reserveOut <= 0n) return null;
    legs.push({ reserveIn, reserveOut, feeBps: route.pools[i].feeBps ?? 30 });
  }

  const capUsd = Math.min(getCurrentTradeCapUsd(), 2000);
  const maxAmountIn = ethers.parseUnits(
    (capUsd / route.priceUsdPerA).toFixed(Math.min(route.decimalsA, 18)),
    route.decimalsA
  );
  if (maxAmountIn <= 0n) return null;

  const best = findBestAmount(maxAmountIn, legs);
  if (best.profit <= 0n) return null;

  const amountOwed = best.amountIn + (best.amountIn * AAVE_PREMIUM_BPS) / 10000n;
  if (best.amountOut <= amountOwed) return null;

  const netTokens = parseFloat(ethers.formatUnits(best.amountOut - amountOwed, route.decimalsA));
  const grossProfitUsd = netTokens * route.priceUsdPerA;
  const netProfitUsd = grossProfitUsd - gasCostUsd * TRI_GAS_MULTIPLIER;

  return {
    route, legs,
    amountIn: best.amountIn,
    amountOutEstimated: best.amountOut,
    amountOwed,
    tradeAmountUsd: parseFloat(ethers.formatUnits(best.amountIn, route.decimalsA)) * route.priceUsdPerA,
    grossProfitUsd,
    netProfitUsd,
    profitable: netProfitUsd > 0,
    pairLabel: `${route.symbolA}→${route.symbolB}→${route.symbolC}→${route.symbolA} on ${route.chain}`,
  };
}

/// 評価結果が黒字なら、実際に送信する(DRY_RUNならログのみ)。
export async function maybeExecuteTriangle(evaluated) {
  const { route, legs } = evaluated;
  const chain = route.chain;
  const chainConfig = getChainConfig(chain);
  if (!chainConfig) return;

  const contractAddress = process.env[chainConfig.contractAddressEnvVar];
  if (!contractAddress) return;

  // 送信直前に、各段の受取量をプール自身へ問い合わせて確定させる。
  const tokens = [route.tokenA, route.tokenB, route.tokenC];
  let amount = evaluated.amountIn;
  const amountOuts = [];
  for (let i = 0; i < 3; i++) {
    const out = await quoteOut({
      chain, pool: route.pools[i].address, amountIn: amount, tokenIn: tokens[i],
      reserveIn: legs[i].reserveIn, reserveOut: legs[i].reserveOut, feeBps: legs[i].feeBps,
    });
    if (out <= 0n) return;
    amountOuts.push(out);
    amount = out;
  }

  const finalOut = amountOuts[2];
  if (finalOut <= evaluated.amountOwed) {
    console.log(`[三角裁定] ${evaluated.pairLabel}: 送信直前の再計算で返済額に届かず見送り`);
    return;
  }

  let gasCostUsd = 0.02;
  try { gasCostUsd = (await estimateGasCostUsd(chain)) * TRI_GAS_MULTIPLIER; } catch (e) {}
  const netTokens = parseFloat(ethers.formatUnits(finalOut - evaluated.amountOwed, route.decimalsA));
  const finalProfitUsd = netTokens * route.priceUsdPerA - gasCostUsd;

  if (finalProfitUsd < MIN_PROFIT_USD) {
    console.log(`[三角裁定] ${evaluated.pairLabel}: ガス代差引後$${finalProfitUsd.toFixed(4)}が下限未満のため見送り`);
    return;
  }

  const requested = amountOuts.map((v) => (v * (10000n - SAFETY_MARGIN_BPS)) / 10000n);
  if (requested[2] <= evaluated.amountOwed) {
    console.log(`[三角裁定] ${evaluated.pairLabel}: 余裕分を引くと返済額を下回るため見送り`);
    return;
  }

  const dryRun = process.env.DRY_RUN !== "false";
  console.log(`[三角裁定] ${evaluated.pairLabel}: 送信条件を満たしました(投入$${evaluated.tradeAmountUsd.toFixed(2)} 純利益$${finalProfitUsd.toFixed(4)} ガス$${gasCostUsd.toFixed(4)}) DRY_RUN=${dryRun}`);
  if (dryRun) return;

  const privateKey = process.env.MAINNET_BOT_PRIVATE_KEY;
  if (!privateKey) return;

  const { getProviderForChain } = await import("./onchain-reserves.js");
  const wallet = new ethers.Wallet(privateKey, getProviderForChain(chain));
  const contract = new ethers.Contract(contractAddress, CONTRACT_ABI, wallet);

  try {
    const tx = await contract.executeTriArb(route.tokenA, evaluated.amountIn, {
      pool1: route.pools[0].address, pool2: route.pools[1].address, pool3: route.pools[2].address,
      tokenA: route.tokenA, tokenB: route.tokenB, tokenC: route.tokenC,
      amountOut1: requested[0], amountOut2: requested[1], amountOut3: requested[2],
    });
    console.log(`[三角裁定/実行] トランザクション送信: ${tx.hash}`);
    const receipt = await tx.wait();
    console.log(`[三角裁定/実行] 完了: ブロック${receipt.blockNumber}, ガス使用量=${receipt.gasUsed.toString()}`);

    let actualProfitTokens = null;
    for (const log of receipt.logs) {
      try {
        const parsed = contract.interface.parseLog({ topics: log.topics, data: log.data });
        if (parsed && parsed.name === "TriArbExecuted") {
          actualProfitTokens = parseFloat(ethers.formatUnits(parsed.args.profit, route.decimalsA));
          break;
        }
      } catch (inner) {}
    }
    const actualProfitUsd = actualProfitTokens !== null ? actualProfitTokens * route.priceUsdPerA : null;
    if (actualProfitUsd !== null) console.log(`[三角裁定/実行] 実際に確定した利益: +$${actualProfitUsd.toFixed(4)}`);

    recordRealExecution({
      timestamp: new Date().toISOString(),
      pairLabel: evaluated.pairLabel, chain,
      txHash: tx.hash, explorerUrl: chainConfig.explorerTxUrl(tx.hash),
      tradeAmountUsd: evaluated.tradeAmountUsd,
      predictedProfitUsd: finalProfitUsd, actualProfitUsd,
      gasUsed: receipt.gasUsed.toString(), gasCostUsd,
    });
    recordExecutionSuccess();
  } catch (e) {
    console.error(`[三角裁定/実行] 失敗: ${e.message.slice(0, 180)}`);
  }
}
