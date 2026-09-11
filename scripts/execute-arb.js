// scripts/execute-arb.js
//
// 観測システムが黒字と判定した案件を、実際にコントラクトのexecuteArbへ
// 送信する(またはDRY_RUNならログに記録するだけの)ロジック。
//
// 最低受取量(minAmountOut)は、プール自身の getAmountOut に問い合わせて求める。
//
// [修正] 実行直前の利益判定に、Aaveのフラッシュローン手数料(0.05%)と
// 最低利益しきい値を加えた。粗利が僅かにプラスでも、返済時に手数料分が
// 足りずrevertし、ガス代だけを失うのを防ぐ。
// あわせて、見送り時に「いくら入れて、いくら戻る見込みか」を必ず記録する。

import { ethers } from "ethers";
import { getRouterInfo, ROUTER_KIND_ENUM } from "../router-addresses.js";
import { getChainConfig } from "../chain-config.js";
import { getCurrentTradeCapUsd, recordExecutionSuccess } from "./trade-cap.js";
import { recordRealExecution } from "./real-execution-log.js";
import { isKnownIncompatiblePool, recordIncompatiblePool } from "./incompatible-pools.js";
import { getProviderForChain, fetchOnchainReserves, fetchTokenDecimals, callWithRpc } from "./onchain-reserves.js";

const CONTRACT_ABI = [
  "function executeArb(address asset, uint256 amount, (address routerCheap, address routerExpensive, address tokenX, address tokenY, uint256 minAmountOutStep1, uint256 minAmountOutStep2, uint8 kindCheap, uint8 kindExpensive) params) external",
  "event ArbExecuted(address indexed tokenY, uint256 amountBorrowed, uint256 profit)",
];
const POOL_QUOTE_ABI = ["function getAmountOut(uint256 amountIn, address tokenIn) view returns (uint256)"];

// Aave V3のフラッシュローン手数料(0.05% = 5bps)。返済額は amount + premium。
const AAVE_PREMIUM_BPS = 5n;
// この金額(USD)未満の利益は送信しない。失敗時のガス代損失に見合わないため。
const MIN_PROFIT_USD = parseFloat(process.env.MIN_PROFIT_USD || "0.10");
const SLIPPAGE_TOLERANCE_BPS = 100n;

function getAmountOutFallback(amountIn, reserveIn, reserveOut, feeBps) {
  const amountInWithFee = amountIn * (10000n - BigInt(feeBps));
  const denominator = reserveIn * 10000n + amountInWithFee;
  return denominator === 0n ? 0n : (amountInWithFee * reserveOut) / denominator;
}

async function quoteAmountOut({ chain, poolAddress, amountIn, tokenInAddress, reserveIn, reserveOut, feeBps }) {
  try {
    const out = await callWithRpc(chain, (p) =>
      new ethers.Contract(ethers.getAddress(poolAddress), POOL_QUOTE_ABI, p)
        .getAmountOut(amountIn, ethers.getAddress(tokenInAddress))
    );
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
  if (isKnownIncompatiblePool(chain, observed.cheapPoolAddress) || isKnownIncompatiblePool(chain, observed.expensivePoolAddress)) {
    console.log(`[実行判定] ${observed.pairLabel}: 既知の非対応プールのため見送り`);
    return;
  }
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
  try {
    amountIn = ethers.parseUnits(amountInStr, decimalsY);
  } catch (e) {
    console.warn(`[実行判定] ${observed.pairLabel}: 投入額の変換に失敗、見送り:`, e.message);
    return;
  }

  let cheapReserves, expensiveReserves;
  try {
    cheapReserves = await fetchOnchainReserves({ chain, pairAddress: observed.cheapPoolAddress, tokenXAddress: observed.tokenA, decimalsX, decimalsY });
  } catch (e) {
    if (e.message.includes("execution reverted") || e.message.includes("形式が不正")) recordIncompatiblePool(chain, observed.cheapPoolAddress, e.message);
    console.warn(`[実行判定] ${observed.pairLabel}: 安い方のプール再確認に失敗、見送り:`, e.message.slice(0, 100));
    return;
  }
  try {
    expensiveReserves = await fetchOnchainReserves({ chain, pairAddress: observed.expensivePoolAddress, tokenXAddress: observed.tokenA, decimalsX, decimalsY });
  } catch (e) {
    if (e.message.includes("execution reverted") || e.message.includes("形式が不正")) recordIncompatiblePool(chain, observed.expensivePoolAddress, e.message);
    console.warn(`[実行判定] ${observed.pairLabel}: 高い方のプール再確認に失敗、見送り:`, e.message.slice(0, 100));
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

  // 返済に必要な額(元本 + Aave手数料)。これを下回れば必ずrevertする。
  const amountOwed = amountIn + (amountIn * AAVE_PREMIUM_BPS) / 10000n;
  const grossProfitRaw = step2.amountOut - amountOwed;
  const grossProfitUsd = parseFloat(ethers.formatUnits(grossProfitRaw > 0n ? grossProfitRaw : 0n, decimalsY)) * priceUsdPerUnit
    - (grossProfitRaw < 0n ? parseFloat(ethers.formatUnits(-grossProfitRaw, decimalsY)) * priceUsdPerUnit : 0);

  const fmt = (v) => ethers.formatUnits(v, decimalsY);
  const detail = `投入=${fmt(amountIn)} → X=${ethers.formatUnits(step1.amountOut, decimalsX)} → 戻り=${fmt(step2.amountOut)} / 返済必要額=${fmt(amountOwed)} / 実利益=${grossProfitUsd >= 0 ? "+" : ""}$${grossProfitUsd.toFixed(4)} / 見積元=${step1.source}/${step2.source} / 手数料=${feeCheap}bps/${feeExpensive}bps`;

  if (grossProfitRaw <= 0n) {
    console.log(`[実行判定] ${observed.pairLabel}: 実行直前の再計算で返済額に届かず見送り(${detail})`);
    return;
  }
  if (grossProfitUsd < MIN_PROFIT_USD) {
    console.log(`[実行判定] ${observed.pairLabel}: 利益$${grossProfitUsd.toFixed(4)}が下限$${MIN_PROFIT_USD}未満のため見送り(${detail})`);
    return;
  }

  const minAmountOutStep1 = (step1.amountOut * (10000n - SLIPPAGE_TOLERANCE_BPS)) / 10000n;
  // ステップ2の最低受取量は、少なくとも返済額を下回らないようにする。
  let minAmountOutStep2 = (step2.amountOut * (10000n - SLIPPAGE_TOLERANCE_BPS)) / 10000n;
  if (minAmountOutStep2 < amountOwed) minAmountOutStep2 = amountOwed;

  const dryRun = process.env.DRY_RUN !== "false";
  console.log(`[実行判定] ${observed.pairLabel}: 送信条件を満たしました(上限$${tradeCapUsd} / ${detail}) DRY_RUN=${dryRun}`);
  if (dryRun) return;

  const privateKey = process.env.MAINNET_BOT_PRIVATE_KEY;
  if (!privateKey) {
    console.warn("[実行判定] MAINNET_BOT_PRIVATE_KEYが未設定のため見送り");
    return;
  }

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
        if (parsed && parsed.name === "ArbExecuted") {
          actualProfitTokens = parseFloat(ethers.formatUnits(parsed.args.profit, decimalsY));
          break;
        }
      } catch (inner) {}
    }
    const actualProfitUsd = actualProfitTokens !== null ? actualProfitTokens * priceUsdPerUnit : null;
    if (actualProfitUsd !== null) console.log(`[実行] 実際に確定した利益: +$${actualProfitUsd.toFixed(4)}`);

    recordRealExecution({
      timestamp: new Date().toISOString(), pairLabel: observed.pairLabel, chain,
      txHash: tx.hash, explorerUrl: chainConfig.explorerTxUrl(tx.hash),
      tradeAmountUsd: Math.min(observed.tradeAmountUsd, tradeCapUsd),
      predictedProfitUsd: grossProfitUsd, actualProfitUsd,
      gasUsed: receipt.gasUsed.toString(), gasCostUsd: null,
    });
    recordExecutionSuccess();
  } catch (e) {
    console.error(`[実行] 失敗: ${e.message.slice(0, 200)}`);
  }
}
