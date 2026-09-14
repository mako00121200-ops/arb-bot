// scripts/execute-opportunity.js
//
// 検出した機会(2ステップ・三角の両方)を実際に送信する。
//
// [手数料の実測と学習]
// Uniswap V2形式のプールには手数料を問い合わせる関数が無いため、
// コントラクトの拒否理由を使って実測する:
//   "UniswapV2: K"   … 要求量が多すぎる → 想定を上げて再挑戦
//   "not profitable" … スワップは通った = 想定が正しい → 記録
// ガス見積もりは無料なので、何度試してもガス代はかからない。
//
// [脚ごとに学習する]
// 以前は全ての脚に同じ想定値を当てていたため、正常なプール(0.3%)が
// 税トークンのプールと組んだだけで「1.5%」と誤記録され、そのプールの
// 本物の機会まで見逃すようになっていた。脚を1つずつ上げて、どの脚が
// 原因かを切り分ける。
//
// [税トークンの判定]
// 正常なDEXの手数料は最大でも1%(Aerodrome等)。実測が1%を超えるのは
// 手数料ではなく「送金時に税を取るトークン」であり、構造上裁定できない。
// TAX_TOKEN_FEE_BPS を超えた時点で、そのプールを恒久的に除外する。

import { ethers } from "ethers";
import { getChainConfig } from "../chain-config.js";
import { getProviderForChain, callWithRpc } from "./onchain-reserves.js";
import { getCurrentTradeCapUsd, recordExecutionSuccess } from "./trade-cap.js";
import { recordRealExecution } from "./real-execution-log.js";
import { estimateGasCostUsd, gasUnitsToUsd } from "./gas-cost.js";
import { getTokenDecimals, getTokenPriceUsd, setPoolFee, getPool } from "./pool-registry.js";

const CONTRACT_ABI = [
  "function executeArb(address asset, uint256 amount, (address poolCheap, address poolExpensive, address tokenX, address tokenY, uint256 amountOutStep1, uint256 amountOutStep2) params) external",
  "function executeTriArb(address asset, uint256 amount, (address pool1, address pool2, address pool3, address tokenA, address tokenB, address tokenC, uint256 amountOut1, uint256 amountOut2, uint256 amountOut3) params) external",
  "event ArbExecuted(address indexed tokenY, uint256 amountBorrowed, uint256 profit)",
  "event TriArbExecuted(address indexed tokenA, uint256 amountBorrowed, uint256 profit)",
];
const POOL_QUOTE_ABI = ["function getAmountOut(uint256 amountIn, address tokenIn) view returns (uint256)"];

const AAVE_PREMIUM_BPS = 5n;
const MIN_PROFIT_USD = parseFloat(process.env.MIN_PROFIT_USD || "0.01");
const SAFETY_MARGIN_BPS = 5n;
// 「K」で拒否されたときに試す手数料(bps)。低い順に試す。
const FEE_LADDER = [30, 35, 40, 45, 50, 60, 70, 80, 90, 100];
// これを超える実測値は手数料ではなく「税トークン」。裁定に使えない。
export const TAX_TOKEN_FEE_BPS = parseInt(process.env.TAX_TOKEN_FEE_BPS || "100", 10);

export class ExecutionError extends Error {
  constructor(message, { reverted = false, taxToken = false, taxPools = [] } = {}) {
    super(message);
    this.reverted = reverted;
    this.taxToken = taxToken;
    this.taxPools = taxPools;
  }
}

function isKRevert(message) { return /UniswapV2: K/.test(message || ""); }
function isNotProfitableRevert(message) { return /not profitable/i.test(message || ""); }

function getAmountOutCalc(amountIn, reserveIn, reserveOut, feeBps) {
  const amountInWithFee = amountIn * (10000n - BigInt(feeBps));
  const denominator = reserveIn * 10000n + amountInWithFee;
  return denominator === 0n ? 0n : (amountInWithFee * reserveOut) / denominator;
}

async function quoteOut({ chain, pool, amountIn, tokenIn, reserveIn, reserveOut, feeBps }) {
  try {
    const out = await callWithRpc(chain, (p) =>
      new ethers.Contract(ethers.getAddress(pool), POOL_QUOTE_ABI, p)
        .getAmountOut(amountIn, ethers.getAddress(tokenIn)));
    if (out > 0n) return { amountOut: out, fromPool: true };
  } catch (e) { /* この形式のプールではない */ }
  return { amountOut: getAmountOutCalc(amountIn, reserveIn, reserveOut, feeBps), fromPool: false };
}

function buildTokenPath(opp) {
  const path = [opp.tokenA];
  for (const leg of opp.legs) path.push(leg.tokenOut);
  return path;
}

async function buildRequestedAmounts({ chain, opp, tokenPath, amountIn, feeBpsList }) {
  const requested = [], fromPool = [];
  let amount = amountIn;
  for (let i = 0; i < opp.legs.length; i++) {
    const leg = opp.legs[i];
    const q = await quoteOut({
      chain, pool: opp.poolAddresses[i], amountIn: amount, tokenIn: tokenPath[i],
      reserveIn: leg.reserveIn, reserveOut: leg.reserveOut, feeBps: feeBpsList[i],
    });
    if (q.amountOut <= 0n) return null;
    const req = (q.amountOut * (10000n - SAFETY_MARGIN_BPS)) / 10000n;
    if (req <= 0n) return null;
    requested.push(req);
    fromPool.push(q.fromPool);
    amount = req;
  }
  return { requested, fromPool };
}

function recordLearnedFees(chain, opp, feeBpsList, fromPool) {
  const learned = [];
  for (let i = 0; i < opp.poolAddresses.length; i++) {
    if (fromPool[i]) continue;
    const pool = getPool(chain, opp.poolAddresses[i]);
    if (!pool || pool.feeBps === feeBpsList[i]) continue;
    setPoolFee(chain, opp.poolAddresses[i], feeBpsList[i]);
    pool.feeProbed = true;
    learned.push(`${opp.poolAddresses[i].slice(0, 10)}…=${feeBpsList[i]}bps`);
  }
  if (learned.length > 0) console.log(`[手数料実測] ${chain}: ${learned.join(" ")}`);
}

function buildCallArgs(opp, tokenPath, amountIn, requested) {
  return opp.kind === "3step"
    ? ["executeTriArb", opp.tokenA, amountIn, {
        pool1: opp.poolAddresses[0], pool2: opp.poolAddresses[1], pool3: opp.poolAddresses[2],
        tokenA: tokenPath[0], tokenB: tokenPath[1], tokenC: tokenPath[2],
        amountOut1: requested[0], amountOut2: requested[1], amountOut3: requested[2],
      }]
    : ["executeArb", opp.tokenA, amountIn, {
        poolCheap: opp.poolAddresses[0], poolExpensive: opp.poolAddresses[1],
        tokenX: tokenPath[1], tokenY: tokenPath[0],
        amountOutStep1: requested[0], amountOutStep2: requested[1],
      }];
}

export async function executeOpportunity(opp) {
  const chain = opp.chain;
  const chainConfig = getChainConfig(chain);
  if (!chainConfig) return false;
  const contractAddress = process.env[chainConfig.contractAddressEnvVar];
  if (!contractAddress) return false;

  const decimals = getTokenDecimals(chain, opp.tokenA);
  const priceUsd = getTokenPriceUsd(chain, opp.tokenA);
  if (decimals == null || !priceUsd) return false;

  const capUsd = getCurrentTradeCapUsd();
  let amountIn = opp.amountIn;
  if (opp.tradeAmountUsd > capUsd) {
    const ratio = capUsd / opp.tradeAmountUsd;
    amountIn = (amountIn * BigInt(Math.round(ratio * 10000))) / 10000n;
  }
  if (amountIn <= 0n) return false;

  const tokenPath = buildTokenPath(opp);
  const tradeUsd = (Number(amountIn) / Math.pow(10, decimals)) * priceUsd;
  const privateKey = process.env.MAINNET_BOT_PRIVATE_KEY;
  const dryRun = process.env.DRY_RUN !== "false";

  if (dryRun || !privateKey) {
    console.log(`[実行] ${opp.kind} ${chain} ${opp.label}: 投入$${tradeUsd.toFixed(2)} DRY_RUN=${dryRun}`);
    return false;
  }

  const wallet = new ethers.Wallet(privateKey, getProviderForChain(chain));
  const contract = new ethers.Contract(contractAddress, CONTRACT_ABI, wallet);
  const amountOwed = amountIn + (amountIn * AAVE_PREMIUM_BPS) / 10000n;

  // 脚ごとに手数料の想定を上げていく。
  // 全ての脚を同時に上げると、正常なプールまで高い値で記録してしまうため、
  // 1脚ずつ順番に上げて、どの脚が原因かを切り分ける。
  const legCount = opp.legs.length;
  const feeIndex = opp.legs.map(() => 0);       // 各脚が今どの段にいるか
  let feeBpsList = opp.legs.map((l) => Math.max(l.feeBps, FEE_LADDER[0]));
  let success = null, lastError = "", lastFromPool = null;
  let cursor = 0; // 次に上げる脚

  const MAX_ATTEMPTS = FEE_LADDER.length * legCount + 2;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const built = await buildRequestedAmounts({ chain, opp, tokenPath, amountIn, feeBpsList });
    if (!built) return false;
    lastFromPool = built.fromPool;

    const callArgs = buildCallArgs(opp, tokenPath, amountIn, built.requested);
    try {
      const gasUnits = await contract[callArgs[0]].estimateGas(callArgs[1], callArgs[2], callArgs[3]);
      success = { built, callArgs, gasUnits };
      recordLearnedFees(chain, opp, feeBpsList, built.fromPool);
      break;
    } catch (e) {
      lastError = e.message || "";

      if (isNotProfitableRevert(lastError)) {
        // スワップは全段通った = 手数料の想定が正しい。記録して見送る。
        recordLearnedFees(chain, opp, feeBpsList, built.fromPool);
        console.log(`[実行] ${opp.label}: 実測手数料${feeBpsList.join("/")}bpsでは利益が出ないため見送り`);
        return false;
      }
      if (!isKRevert(lastError)) {
        throw new ExecutionError(lastError.slice(0, 160), { reverted: true });
      }

      // 「K」= どこかの脚の想定が低い。プール自身に聞けない脚を順に1段上げる。
      let advanced = false;
      for (let tried = 0; tried < legCount; tried++) {
        const i = (cursor + tried) % legCount;
        if (built.fromPool[i]) continue;                 // 正確な値が分かっている脚は触らない
        if (feeIndex[i] >= FEE_LADDER.length - 1) continue;
        feeIndex[i]++;
        feeBpsList[i] = FEE_LADDER[feeIndex[i]];
        cursor = (i + 1) % legCount;
        advanced = true;
        break;
      }
      if (!advanced) break; // 全ての脚が上限に達した
    }
  }

  if (!success) {
    // 上限(=正常なDEXの最大手数料)まで上げても通らない = 税トークン。
    const taxPools = [];
    for (let i = 0; i < opp.poolAddresses.length; i++) {
      if (lastFromPool && lastFromPool[i]) continue;
      if (feeIndex[i] >= FEE_LADDER.length - 1) taxPools.push(opp.poolAddresses[i]);
    }
    throw new ExecutionError(
      `手数料${TAX_TOKEN_FEE_BPS}bpsまで上げても拒否(送金時に税を取るトークンの可能性)`,
      { reverted: true, taxToken: true, taxPools }
    );
  }

  const { built, callArgs, gasUnits } = success;
  const finalOut = built.requested[built.requested.length - 1];
  if (finalOut <= amountOwed) {
    console.log(`[実行] ${opp.label}: 実測手数料${feeBpsList.join("/")}bpsでは返済額に届かず見送り`);
    return false;
  }

  const gasWithBuffer = (gasUnits * 120n) / 100n;
  let gasCostUsd = await gasUnitsToUsd(chain, gasWithBuffer);
  if (gasCostUsd == null) gasCostUsd = await estimateGasCostUsd(chain, opp.kind);

  const grossProfitUsd = (Number(finalOut - amountOwed) / Math.pow(10, decimals)) * priceUsd;
  const finalProfitUsd = grossProfitUsd - gasCostUsd;

  if (finalProfitUsd < MIN_PROFIT_USD) {
    console.log(`[実行] ${opp.label}: ガス代差引後$${finalProfitUsd.toFixed(4)}が下限$${MIN_PROFIT_USD}未満のため見送り(粗利$${grossProfitUsd.toFixed(4)} ガス$${gasCostUsd.toFixed(4)} 実測手数料${feeBpsList.join("/")}bps)`);
    return false;
  }

  console.log(`[実行] ${opp.kind} ${chain} ${opp.label}: 送信します(投入$${tradeUsd.toFixed(2)} 純利益$${finalProfitUsd.toFixed(4)} ガス$${gasCostUsd.toFixed(4)}/${gasUnits} 実測手数料${feeBpsList.join("/")}bps)`);

  let tx;
  try {
    tx = await contract[callArgs[0]](callArgs[1], callArgs[2], callArgs[3], { gasLimit: gasWithBuffer });
  } catch (e) {
    const msg = e.message || "";
    throw new ExecutionError(msg.slice(0, 160), { reverted: msg.includes("execution reverted") });
  }

  console.log(`[実行] 送信: ${tx.hash}`);
  let receipt;
  try {
    receipt = await tx.wait();
  } catch (e) {
    throw new ExecutionError(`確定待ちで失敗: ${(e.message || "").slice(0, 120)}`, { reverted: true });
  }
  console.log(`[実行] 完了: ブロック${receipt.blockNumber} ガス${receipt.gasUsed.toString()}`);

  let actualProfitTokens = null;
  for (const log of receipt.logs) {
    try {
      const parsed = contract.interface.parseLog({ topics: log.topics, data: log.data });
      if (parsed && (parsed.name === "ArbExecuted" || parsed.name === "TriArbExecuted")) {
        actualProfitTokens = Number(parsed.args.profit) / Math.pow(10, decimals);
        break;
      }
    } catch (inner) {}
  }
  const actualProfitUsd = actualProfitTokens != null ? actualProfitTokens * priceUsd : null;
  if (actualProfitUsd != null) console.log(`[実行] 確定利益: +$${actualProfitUsd.toFixed(4)}`);

  recordRealExecution({
    timestamp: new Date().toISOString(),
    pairLabel: `${opp.kind} ${chain} ${opp.label}`,
    chain, txHash: tx.hash, explorerUrl: chainConfig.explorerTxUrl(tx.hash),
    tradeAmountUsd: tradeUsd,
    predictedProfitUsd: finalProfitUsd, actualProfitUsd,
    gasUsed: receipt.gasUsed.toString(), gasCostUsd,
  });
  recordExecutionSuccess();
  return true;
}
