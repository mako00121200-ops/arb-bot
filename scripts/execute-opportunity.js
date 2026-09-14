// scripts/execute-opportunity.js
//
// 検出した機会(2ステップ・三角の両方)を実際に送信する。
//
// [手数料の自己学習]
// Uniswap V2形式のプールには手数料を問い合わせる関数が無い。しかしPolygonの
// DEXは手数料がバラバラで(ApeSwap 0.2%、JetSwap 0.1%等)、既定の0.3%で
// 計算すると実際より多くを要求してしまい、プールに "UniswapV2: K" で
// 拒否される。
// そこで、ガス見積もり(無料)が「K」で失敗したら手数料の想定を上げて
// 再挑戦し、成功した値をそのプールの手数料として記録する。
// 見積もり段階なのでガス代は一切かからず、未知のDEXにも自動で対応できる。
//
// [その他の要点]
//   ・各段の入力には「前の段で実際に要求する量」を使う(余裕を正しく連鎖)
//   ・ガス代は送信直前の estimateGas 実測値で計算する
//   ・失敗は必ず ExecutionError として投げ直す(握りつぶすと無限再試行になる)

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
// 「K」で拒否されたときに試す手数料(bps)。低い順に試し、成功した値を記録する。
const FEE_LADDER = [30, 40, 50, 60, 80, 100, 150, 200, 300];

export class ExecutionError extends Error {
  constructor(message, { reverted = false } = {}) {
    super(message);
    this.reverted = reverted;
  }
}

function isKRevert(message) {
  return /UniswapV2: K|\bK\b/.test(message || "");
}

function getAmountOutCalc(amountIn, reserveIn, reserveOut, feeBps) {
  const amountInWithFee = amountIn * (10000n - BigInt(feeBps));
  const denominator = reserveIn * 10000n + amountInWithFee;
  return denominator === 0n ? 0n : (amountInWithFee * reserveOut) / denominator;
}

/// プール自身に聞ける形式(Solidly系)ならその値を、無ければ指定の手数料で計算する。
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

/// 指定した手数料の想定で、各段の要求量を組み立てる。
async function buildRequestedAmounts({ chain, opp, tokenPath, amountIn, feeBpsList }) {
  const requested = [];
  const fromPool = [];
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

  // 手数料の想定を段階的に上げながら、ガス見積もりが通る組み合わせを探す。
  // 見積もりは無料なので、失敗してもガス代はかからない。
  let feeBpsList = opp.legs.map((l) => l.feeBps);
  let requested = null, gasUnits = null, lastError = "";
  let ladderIndex = 0;

  for (let attempt = 0; attempt < FEE_LADDER.length; attempt++) {
    const built = await buildRequestedAmounts({ chain, opp, tokenPath, amountIn, feeBpsList });
    if (!built) return false;

    const finalOut = built.requested[built.requested.length - 1];
    const amountOwed = amountIn + (amountIn * AAVE_PREMIUM_BPS) / 10000n;
    if (finalOut <= amountOwed) {
      console.log(`[実行] ${opp.label}: 手数料${feeBpsList.join("/")}bpsでは返済額に届かず見送り`);
      return false;
    }

    const callArgs = opp.kind === "3step"
      ? ["executeTriArb", opp.tokenA, amountIn, {
          pool1: opp.poolAddresses[0], pool2: opp.poolAddresses[1], pool3: opp.poolAddresses[2],
          tokenA: tokenPath[0], tokenB: tokenPath[1], tokenC: tokenPath[2],
          amountOut1: built.requested[0], amountOut2: built.requested[1], amountOut3: built.requested[2],
        }]
      : ["executeArb", opp.tokenA, amountIn, {
          poolCheap: opp.poolAddresses[0], poolExpensive: opp.poolAddresses[1],
          tokenX: tokenPath[1], tokenY: tokenPath[0],
          amountOutStep1: built.requested[0], amountOutStep2: built.requested[1],
        }];

    try {
      gasUnits = await contract[callArgs[0]].estimateGas(callArgs[1], callArgs[2], callArgs[3]);
      requested = { ...built, callArgs, amountOwed, finalOut };
      // 成功した手数料を、プール自身に聞けなかったプールだけ記録する。
      for (let i = 0; i < opp.poolAddresses.length; i++) {
        if (built.fromPool[i]) continue;
        const pool = getPool(chain, opp.poolAddresses[i]);
        if (pool && pool.feeBps !== feeBpsList[i]) {
          setPoolFee(chain, opp.poolAddresses[i], feeBpsList[i]);
          pool.feeProbed = true;
          console.log(`[手数料学習] ${chain} ${opp.poolAddresses[i].slice(0, 10)}…: ${feeBpsList[i]}bpsと判明`);
        }
      }
      break;
    } catch (e) {
      lastError = e.message || "";
      if (!isKRevert(lastError)) {
        // 「K」以外の拒否(詐欺トークン等)は、手数料を変えても解決しない。
        throw new ExecutionError(lastError.slice(0, 160), { reverted: true });
      }
      // 手数料の想定を1段上げて再挑戦する。
      ladderIndex++;
      if (ladderIndex >= FEE_LADDER.length) break;
      const nextFee = FEE_LADDER[ladderIndex];
      feeBpsList = opp.legs.map((l, i) => (built.fromPool[i] ? l.feeBps : Math.max(l.feeBps, nextFee)));
    }
  }

  if (!requested || gasUnits == null) {
    throw new ExecutionError(`手数料を${FEE_LADDER[FEE_LADDER.length - 1]}bpsまで上げても拒否: ${lastError.slice(0, 100)}`, { reverted: true });
  }

  // 実際のガス使用量から、ガス代を計算する。
  const gasWithBuffer = (gasUnits * 120n) / 100n;
  let gasCostUsd = await gasUnitsToUsd(chain, gasWithBuffer);
  if (gasCostUsd == null) gasCostUsd = await estimateGasCostUsd(chain, opp.kind);

  const grossTokens = Number(requested.finalOut - requested.amountOwed) / Math.pow(10, decimals);
  const grossProfitUsd = grossTokens * priceUsd;
  const finalProfitUsd = grossProfitUsd - gasCostUsd;

  if (finalProfitUsd < MIN_PROFIT_USD) {
    console.log(`[実行] ${opp.label}: ガス代差引後$${finalProfitUsd.toFixed(4)}が下限$${MIN_PROFIT_USD}未満のため見送り(粗利$${grossProfitUsd.toFixed(4)} ガス$${gasCostUsd.toFixed(4)}/${gasUnits} 手数料${feeBpsList.join("/")}bps)`);
    return false;
  }

  console.log(`[実行] ${opp.kind} ${chain} ${opp.label}: 送信します(投入$${tradeUsd.toFixed(2)} 純利益$${finalProfitUsd.toFixed(4)} ガス$${gasCostUsd.toFixed(4)}/${gasUnits} 手数料${feeBpsList.join("/")}bps)`);

  const { callArgs } = requested;
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
