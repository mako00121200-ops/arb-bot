// scripts/execute-opportunity.js
//
// 検出した機会(2ステップ・三角の両方)を実際に送信する。
//
// [流れ]
//   ①送信直前に、各段の受取量をプール自身へ問い合わせて確定させる
//   ②Aave手数料込みの返済額を上回り、実測ガス代を引いても最低利益を
//     超える場合のみ送信する
//   ③受取量は計算値より僅かに低い値を要求する(過大ならプール側が拒否)
//
// [修正] 送信失敗をここで握りつぶしていたため、呼び出し側が失敗を知れず
// 同じ組み合わせを1.5秒ごとに無限に再試行していた。失敗は必ず投げ直す。

import { ethers } from "ethers";
import { getChainConfig } from "../chain-config.js";
import { getProviderForChain, callWithRpc } from "./onchain-reserves.js";
import { getCurrentTradeCapUsd, recordExecutionSuccess } from "./trade-cap.js";
import { recordRealExecution } from "./real-execution-log.js";
import { estimateGasCostUsd } from "./gas-cost.js";
import { getTokenDecimals, getTokenPriceUsd } from "./pool-registry.js";

const CONTRACT_ABI = [
  "function executeArb(address asset, uint256 amount, (address poolCheap, address poolExpensive, address tokenX, address tokenY, uint256 amountOutStep1, uint256 amountOutStep2) params) external",
  "function executeTriArb(address asset, uint256 amount, (address pool1, address pool2, address pool3, address tokenA, address tokenB, address tokenC, uint256 amountOut1, uint256 amountOut2, uint256 amountOut3) params) external",
  "event ArbExecuted(address indexed tokenY, uint256 amountBorrowed, uint256 profit)",
  "event TriArbExecuted(address indexed tokenA, uint256 amountBorrowed, uint256 profit)",
];
const POOL_QUOTE_ABI = ["function getAmountOut(uint256 amountIn, address tokenIn) view returns (uint256)"];

const AAVE_PREMIUM_BPS = 5n;
const MIN_PROFIT_USD = parseFloat(process.env.MIN_PROFIT_USD || "0.05");
// 受取量に持たせる余裕。準備量の僅かなズレでプールに拒否されないようにする。
const SAFETY_MARGIN_BPS = 10n;
const GAS_MULTIPLIER = { "2step": 1.0, "3step": 1.35 };

/// 送信失敗を表す。呼び出し側がプールの無効化や再試行の抑制に使う。
export class ExecutionError extends Error {
  constructor(message, { reverted = false } = {}) {
    super(message);
    this.reverted = reverted;
  }
}

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
    if (out > 0n) return out;
  } catch (e) { /* この形式のプールではない */ }
  return getAmountOutCalc(amountIn, reserveIn, reserveOut, feeBps);
}

function buildTokenPath(opp) {
  const path = [opp.tokenA];
  for (const leg of opp.legs) path.push(leg.tokenOut);
  return path;
}

/// 戻り値: 送信して成功したら true、条件を満たさず見送ったら false。
/// 送信を試みて失敗した場合は ExecutionError を投げる。
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
  const amountOuts = [];
  let amount = amountIn;
  for (let i = 0; i < opp.legs.length; i++) {
    const leg = opp.legs[i];
    const out = await quoteOut({
      chain, pool: opp.poolAddresses[i], amountIn: amount, tokenIn: tokenPath[i],
      reserveIn: leg.reserveIn, reserveOut: leg.reserveOut, feeBps: leg.feeBps,
    });
    if (out <= 0n) return false;
    amountOuts.push(out);
    amount = out;
  }

  const finalOut = amountOuts[amountOuts.length - 1];
  const amountOwed = amountIn + (amountIn * AAVE_PREMIUM_BPS) / 10000n;
  if (finalOut <= amountOwed) {
    console.log(`[実行] ${opp.label}: 送信直前の再計算で返済額に届かず見送り`);
    return false;
  }

  let gasCostUsd = 0.02;
  try { gasCostUsd = (await estimateGasCostUsd(chain)) * (GAS_MULTIPLIER[opp.kind] ?? 1.0); } catch (e) {}

  const netTokens = Number(finalOut - amountOwed) / Math.pow(10, decimals);
  const finalProfitUsd = netTokens * priceUsd - gasCostUsd;
  if (finalProfitUsd < MIN_PROFIT_USD) {
    console.log(`[実行] ${opp.label}: ガス代差引後$${finalProfitUsd.toFixed(4)}が下限未満のため見送り`);
    return false;
  }

  const requested = amountOuts.map((v) => (v * (10000n - SAFETY_MARGIN_BPS)) / 10000n);
  if (requested[requested.length - 1] <= amountOwed) {
    console.log(`[実行] ${opp.label}: 余裕分を引くと返済額を下回るため見送り`);
    return false;
  }

  const dryRun = process.env.DRY_RUN !== "false";
  const tradeUsd = (Number(amountIn) / Math.pow(10, decimals)) * priceUsd;
  console.log(`[実行] ${opp.kind} ${chain} ${opp.label}: 送信条件を満たしました(投入$${tradeUsd.toFixed(2)} 純利益$${finalProfitUsd.toFixed(4)} ガス$${gasCostUsd.toFixed(4)}) DRY_RUN=${dryRun}`);
  if (dryRun) return false;

  const privateKey = process.env.MAINNET_BOT_PRIVATE_KEY;
  if (!privateKey) return false;

  const wallet = new ethers.Wallet(privateKey, getProviderForChain(chain));
  const contract = new ethers.Contract(contractAddress, CONTRACT_ABI, wallet);

  let tx;
  try {
    if (opp.kind === "3step") {
      tx = await contract.executeTriArb(opp.tokenA, amountIn, {
        pool1: opp.poolAddresses[0], pool2: opp.poolAddresses[1], pool3: opp.poolAddresses[2],
        tokenA: tokenPath[0], tokenB: tokenPath[1], tokenC: tokenPath[2],
        amountOut1: requested[0], amountOut2: requested[1], amountOut3: requested[2],
      });
    } else {
      tx = await contract.executeArb(opp.tokenA, amountIn, {
        poolCheap: opp.poolAddresses[0], poolExpensive: opp.poolAddresses[1],
        tokenX: tokenPath[1], tokenY: tokenPath[0],
        amountOutStep1: requested[0], amountOutStep2: requested[1],
      });
    }
  } catch (e) {
    const msg = e.message || "";
    const reverted = msg.includes("execution reverted") || msg.includes("CALL_EXCEPTION");
    throw new ExecutionError(msg.slice(0, 160), { reverted });
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
