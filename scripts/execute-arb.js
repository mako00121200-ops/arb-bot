// scripts/execute-arb.js
//
// 観測システムが黒字と判定した案件を、実際にコントラクトのexecuteArbへ送信する。
//
// [スリッページ許容の動的調整]
// 以前は一律1%だったが、利益率0.3%の案件に1%の許容幅を与えると
// 「1%悪化しても実行する」= 確実に赤字、という意味になっていた。
// 許容幅は利益率の半分を上限とし、利益がスリッページに食われないようにする。

import { ethers } from "ethers";
import { getRouterInfo, ROUTER_KIND_ENUM } from "../router-addresses.js";
import { getChainConfig } from "../chain-config.js";
import { getCurrentTradeCapUsd, recordExecutionSuccess } from "./trade-cap.js";
import { recordRealExecution } from "./real-execution-log.js";
import { isKnownIncompatiblePool, recordIncompatiblePool } from "./incompatible-pools.js";
import { getProviderForChain, fetchOnchainReserves, fetchTokenDecimals, callWithRpc } from "./onchain-reserves.js";
import { estimateGasCostUsd } from "./gas-cost.js";

const CONTRACT_ABI = [
  "function executeArb(address asset, uint256 amount, (address routerCheap, address routerExpensive, address tokenX, address tokenY, uint256 minAmountOutStep1, uint256 minAmountOutStep2, uint8 kindCheap, uint8 kindExpensive) params) external",
  "event ArbExecuted(address indexed tokenY, uint256 amountBorrowed, uint256 profit)",
];
const POOL_QUOTE_ABI = ["function getAmountOut(uint256 amountIn, address tokenIn) view returns (uint256)"];

const AAVE_PREMIUM_BPS = 5n;
const MIN_PROFIT_USD = parseFloat(process.env.MIN_PROFIT_USD || "0.05");
// 許容幅の上下限。狭すぎると正常な変動でも失敗し、広すぎると赤字を許す。
const MIN_SLIPPAGE_BPS = 10n;   // 0.1%
const MAX_SLIPPAGE_BPS = 100n;  // 1%

function getAmountOutFallback(amountIn, reserveIn, reserveOut, feeBps) {
  const amountInWithFee = amountIn * (10000n - BigInt(feeBps));
  const denominator = reserveIn * 10000n + amountInWithFee;
  return denominator === 0n ? 0n : (amountInWithFee * reserveOut) / denominator;
}

async function quoteAmountOut({ chain, poolAddress, amountIn, tokenInAddress, reserveIn, reserveOut, feeBps }) {
  try {
    const out = await callWithRpc(chain, (p) =>
      new ethers.Contract(ethers.getAddress(poolAddress), POOL_QUOTE_ABI, p).getAmountOut(amountIn, ethers.getAddress(tokenInAddress)));
    if (out > 0n) return { amountOut: out, source: "pool" };
  } catch (e) { /* この形式のプールではない */ }
  return { amountOut: getAmountOutFallback(amountIn, reserveIn, reserveOut, feeBps), source: "calc" };
}

function normalizeChain(chain) {
  const map = { base: "base", arbitrum: "arbitrum", optimism: "optimism", "op mainnet": "optimism", ethereum: "ethereum" };
  return map[(chain || "").toLowerCase()] || (chain || "").toLowerCase();
}

export async function maybeExecuteArb(observed) {
  const chain = normalizeChain(observed.chain);
  const chainConfig = getChainConfig(chain);
  if (!chainConfig) return;

  const infoCheap = getRouterInfo(chain, observed.cheapDex);
  const infoExpensive = getRouterInfo(chain, observed.expensiveDex);
  if (!infoCheap || !infoExpensive) {
    console.log(`[実行判定] ${observed.pairLabel}: ルーター未確認のため見送り`);
    return;
  }
  if (isKnownIncompatiblePool(chain, observed.cheapPoolAddress) || isKnownIncompatiblePool(chain, observed.expensivePoolAddress)) return;

  const contractAddress = process.env[chainConfig.contractAddressEnvVar];
  if (!contractAddress) {
    console.warn(`[実行判定] ${chainConfig.contractAddressEnvVar}が未設定のため見送り`);
    return;
  }

  let decimalsX, decimalsY;
  try {
    decimalsX = await fetchTokenDecimals(chain, observed.tokenA);
    decimalsY = await fetchTokenDecimals(chain, observed.tokenB);
  } catch (e) {
    console.warn(`[実行判定] ${observed.pairLabel}: decimals取得に失敗、見送り:`, e.message.slice(0, 100));
    return;
  }

  const tradeCapUsd = getCurrentTradeCapUsd();
  const priceUsdPerUnit = observed.tradeAmountUsd / observed.tradeAmountIn;
  let effectiveTradeAmountIn = observed.tradeAmountIn;
  if (observed.tradeAmountUsd > tradeCapUsd) effectiveTradeAmountIn = tradeCapUsd / priceUsdPerUnit;

  let amountIn;
  const amountInStr = effectiveTradeAmountIn.toFixed(Math.min(decimalsY, 18));
  try { amountIn = ethers.parseUnits(amountInStr, decimalsY); }
  catch (e) { console.warn(`[実行判定] ${observed.pairLabel}: 投入額の変換に失敗、見送り`); return; }

  let cheapReserves, expensiveReserves;
  try {
    cheapReserves = await fetchOnchainReserves({ chain, pairAddress: observed.cheapPoolAddress, tokenXAddress: observed.tokenA, decimalsX, decimalsY });
  } catch (e) {
    if (e.message.includes("execution reverted") || e.message.includes("形式が不正")) recordIncompatiblePool(chain, observed.cheapPoolAddress, e.message);
    console.warn(`[実行判定] ${observed.pairLabel}: 安い方のプール再確認に失敗:`, e.message.slice(0, 90));
    return;
  }
  try {
    expensiveReserves = await fetchOnchainReserves({ chain, pairAddress: observed.expensivePoolAddress, tokenXAddress: observed.tokenA, decimalsX, decimalsY });
  } catch (e) {
    if (e.message.includes("execution reverted") || e.message.includes("形式が不正")) recordIncompatiblePool(chain, observed.expensivePoolAddress, e.message);
    console.warn(`[実行判定] ${observed.pairLabel}: 高い方のプール再確認に失敗:`, e.message.slice(0, 90));
    return;
  }

  const feeCheap = observed.cheapFeeBps ?? infoCheap.feeBps;
  const feeExpensive = observed.expensiveFeeBps ?? infoExpensive.feeBps;

  const step1 = await quoteAmountOut({
    chain, poolAddress: observed.cheapPoolAddress, amountIn, tokenInAddress: observed.tokenB,
    reserveIn: cheapReserves.rawY, reserveOut: cheapReserves.rawX, feeBps: feeCheap,
  });
  const step2 = step1.amountOut > 0n ? await quoteAmountOut({
    chain, poolAddress: observed.expensivePoolAddress, amountIn: step1.amountOut, tokenInAddress: observed.tokenA,
    reserveIn: expensiveReserves.rawX, reserveOut: expensiveReserves.rawY, feeBps: feeExpensive,
  }) : { amountOut: 0n, source: "-" };

  const amountOwed = amountIn + (amountIn * AAVE_PREMIUM_BPS) / 10000n;
  const netRaw = step2.amountOut - amountOwed;
  const netTokens = parseFloat(ethers.formatUnits(netRaw < 0n ? -netRaw : netRaw, decimalsY)) * (netRaw < 0n ? -1 : 1);
  const netProfitUsd = netTokens * priceUsdPerUnit;

  // 実測ガス代を差し引く。これを下回るならガス代の方が高い。
  let gasCostUsd = 0.01;
  try { gasCostUsd = await estimateGasCostUsd(chain); } catch (e) {}
  const finalProfitUsd = netProfitUsd - gasCostUsd;

  const fmt = (v) => ethers.formatUnits(v, decimalsY);
  const detail = `投入=${fmt(amountIn)} 戻り=${fmt(step2.amountOut)} 返済=${fmt(amountOwed)} 粗利=$${netProfitUsd.toFixed(4)} ガス=$${gasCostUsd.toFixed(4)} 純利益=$${finalProfitUsd.toFixed(4)} 見積元=${step1.source}/${step2.source} 手数料=${feeCheap}/${feeExpensive}bps`;

  if (netRaw <= 0n) {
    console.log(`[実行判定] ${observed.pairLabel}: 返済額に届かず見送り(${detail})`);
    return;
  }
  if (finalProfitUsd < MIN_PROFIT_USD) {
    console.log(`[実行判定] ${observed.pairLabel}: ガス代差引後$${finalProfitUsd.toFixed(4)}が下限$${MIN_PROFIT_USD}未満のため見送り(${detail})`);
    return;
  }

  // 利益率(bps)を求め、その半分までを許容幅とする。
  // 例: 利益率0.4%なら許容0.2%。利益がスリッページに食われないようにする。
  const profitBps = (netRaw * 10000n) / amountIn;
  let slippageBps = profitBps / 2n;
  if (slippageBps < MIN_SLIPPAGE_BPS) slippageBps = MIN_SLIPPAGE_BPS;
  if (slippageBps > MAX_SLIPPAGE_BPS) slippageBps = MAX_SLIPPAGE_BPS;

  const minAmountOutStep1 = (step1.amountOut * (10000n - slippageBps)) / 10000n;
  // ステップ2は、少なくとも返済額を必ず上回るようにする。
  let minAmountOutStep2 = (step2.amountOut * (10000n - slippageBps)) / 10000n;
  if (minAmountOutStep2 < amountOwed) minAmountOutStep2 = amountOwed;

  const dryRun = process.env.DRY_RUN !== "false";
  console.log(`[実行判定] ${observed.pairLabel}: 送信条件を満たしました(上限$${tradeCapUsd} 許容${slippageBps}bps / ${detail}) DRY_RUN=${dryRun}`);
  if (dryRun) return;

  const privateKey = process.env.MAINNET_BOT_PRIVATE_KEY;
  if (!privateKey) { console.warn("[実行判定] MAINNET_BOT_PRIVATE_KEYが未設定のため見送り"); return; }

  const provider = getProviderForChain(chain);
  const wallet = new ethers.Wallet(privateKey, provider);
  const contract = new ethers.Contract(contractAddress, CONTRACT_ABI, wallet);

  try {
    const tx = await contract.executeArb(observed.tokenB, amountIn, {
      routerCheap: infoCheap.address, routerExpensive: infoExpensive.address,
      tokenX: observed.tokenA, tokenY: observed.tokenB,
      minAmountOutStep1, minAmountOutStep2,
      kindCheap: ROUTER_KIND_ENUM[infoCheap.kind], kindExpensive: ROUTER_KIND_ENUM[infoExpensive.kind],
    });
    console.log(`[実行] トランザクション送信: ${tx.hash}`);
    const receipt = await tx.wait();
    console.log(`[実行] 完了: ブロック${receipt.blockNumber}, ガス使用量=${receipt.gasUsed.toString()}`);

    let actualProfitTokens = null;
    for (const log of receipt.logs) {
      try {
        const parsed = contract.interface.parseLog({ topics: log.topics, data: log.data });
        if (parsed && parsed.name === "ArbExecuted") { actualProfitTokens = parseFloat(ethers.formatUnits(parsed.args.profit, decimalsY)); break; }
      } catch (inner) {}
    }
    const actualProfitUsd = actualProfitTokens !== null ? actualProfitTokens * priceUsdPerUnit : null;
    if (actualProfitUsd !== null) console.log(`[実行] 実際に確定した利益: +$${actualProfitUsd.toFixed(4)}`);

    recordRealExecution({
      timestamp: new Date().toISOString(), pairLabel: observed.pairLabel, chain,
      txHash: tx.hash, explorerUrl: chainConfig.explorerTxUrl(tx.hash),
      tradeAmountUsd: Math.min(observed.tradeAmountUsd, tradeCapUsd),
      predictedProfitUsd: finalProfitUsd, actualProfitUsd,
      gasUsed: receipt.gasUsed.toString(), gasCostUsd,
    });
    recordExecutionSuccess();
  } catch (e) {
    console.error(`[実行] 失敗: ${e.message.slice(0, 200)}`);
  }
}
