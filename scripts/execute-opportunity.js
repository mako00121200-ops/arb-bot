// scripts/execute-opportunity.js
//
// 検出した機会(2ステップ・三角の両方)を実際に送信する。
//
// [優先処理]
// ここから出すRPC呼び出しは全て「優先」で発行する。手数料実測やプール取込の
// 背景作業より先に処理されるため、待ち行列が混んでいても実行が制限時間切れに
// ならない(以前はBaseで87,000件の滞留に巻き込まれ、実行が全滅した)。
//
// [手数料の実測と学習]
// Uniswap V2形式のプールには手数料を問い合わせる関数が無いため、
// コントラクトの拒否理由を使って実測する:
//   "UniswapV2: K"   … 要求量が多すぎる → 想定を上げて再挑戦
//   "not profitable" … スワップは通った = 想定が正しい → 記録
// ガス見積もりは無料なので、何度試してもガス代はかからない。
// 脚を1つずつ上げることで、正常なプールに誤った手数料を記録しない。
//
// [税トークンの判定]
// 正常なDEXの手数料は最大でも1%。実測がそれを超えるのは「送金時に税を取る
// トークン」であり、構造上裁定できないため恒久的に除外する。

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
const PAIR_RESERVES_ABI = [
  "function getReserves() view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast)",
  "function token0() view returns (address)",
];

const AAVE_PREMIUM_BPS = 5n;
const MIN_PROFIT_USD = parseFloat(process.env.MIN_PROFIT_USD || "0.01");
const SAFETY_MARGIN_BPS = 5n;
const FEE_LADDER = [30, 35, 40, 45, 50, 60, 70, 80, 90, 100];
export const TAX_TOKEN_FEE_BPS = parseInt(process.env.TAX_TOKEN_FEE_BPS || "100", 10);

export class ExecutionError extends Error {
  constructor(message, { reverted = false, taxToken = false, taxPools = [], staleReserves = false } = {}) {
    super(message);
    this.reverted = reverted;
    this.taxToken = taxToken;
    this.taxPools = taxPools;
    this.staleReserves = staleReserves;
  }
}

function isKRevert(message) { return /UniswapV2: K/.test(message || ""); }
function isNotProfitableRevert(message) { return /not profitable/i.test(message || ""); }

function getAmountOutCalc(amountIn, reserveIn, reserveOut, feeBps) {
  const amountInWithFee = amountIn * (10000n - BigInt(feeBps));
  const denominator = reserveIn * 10000n + amountInWithFee;
  return denominator === 0n ? 0n : (amountInWithFee * reserveOut) / denominator;
}

/// 経路上の全プールの準備量を、送信直前に取り直す。
/// Syncが無いチェーンではメモリ上の値が最大60秒古く、消えた機会を
/// 追いかけてしまうため。
async function refreshLegReserves(chain, opp, tokenPath) {
  const legs = [];
  for (let i = 0; i < opp.poolAddresses.length; i++) {
    const addr = ethers.getAddress(opp.poolAddresses[i]);
    let reserves, token0;
    try {
      reserves = await callWithRpc(chain, (p) => new ethers.Contract(addr, PAIR_RESERVES_ABI, p).getReserves(), true);
      token0 = await callWithRpc(chain, (p) => new ethers.Contract(addr, PAIR_RESERVES_ABI, p).token0(), true);
    } catch (e) {
      return null;
    }
    const tokenIn = tokenPath[i].toLowerCase();
    const isToken0In = token0.toLowerCase() === tokenIn;
    const reserveIn = isToken0In ? reserves[0] : reserves[1];
    const reserveOut = isToken0In ? reserves[1] : reserves[0];
    if (reserveIn <= 0n || reserveOut <= 0n) return null;
    legs.push({ reserveIn, reserveOut, tokenOut: opp.legs[i].tokenOut, feeBps: opp.legs[i].feeBps });
  }
  return legs;
}

async function quoteOut({ chain, pool, amountIn, tokenIn, reserveIn, reserveOut, feeBps }) {
  try {
    const out = await callWithRpc(chain, (p) =>
      new ethers.Contract(ethers.getAddress(pool), POOL_QUOTE_ABI, p)
        .getAmountOut(amountIn, ethers.getAddress(tokenIn)), true);
    if (out > 0n) return { amountOut: out, fromPool: true };
  } catch (e) { /* この形式のプールではない */ }
  return { amountOut: getAmountOutCalc(amountIn, reserveIn, reserveOut, feeBps), fromPool: false };
}

function buildTokenPath(opp) {
  const path = [opp.tokenA];
  for (const leg of opp.legs) path.push(leg.tokenOut);
  return path;
}

async function buildRequestedAmounts({ chain, opp, legs, tokenPath, amountIn, feeBpsList }) {
  const requested = [], fromPool = [];
  let amount = amountIn;
  for (let i = 0; i < legs.length; i++) {
    const leg = legs[i];
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

  // 送信直前に準備量を取り直す。ここで機会が消えていれば、そもそも
  // メモリ上の値が古かったということ。
  const legs = await refreshLegReserves(chain, opp, tokenPath);
  if (!legs) {
    throw new ExecutionError("送信直前の準備量取得に失敗", { staleReserves: true });
  }

  const wallet = new ethers.Wallet(privateKey, getProviderForChain(chain));
  const contract = new ethers.Contract(contractAddress, CONTRACT_ABI, wallet);
  const amountOwed = amountIn + (amountIn * AAVE_PREMIUM_BPS) / 10000n;

  // 脚ごとに手数料の想定を上げていく。
  const legCount = legs.length;
  const feeIndex = legs.map(() => 0);
  let feeBpsList = legs.map((l) => Math.max(l.feeBps, FEE_LADDER[0]));
  let success = null, lastError = "", lastFromPool = null;
  let cursor = 0;

  const MAX_ATTEMPTS = FEE_LADDER.length * legCount + 2;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const built = await buildRequestedAmounts({ chain, opp, legs, tokenPath, amountIn, feeBpsList });
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
        recordLearnedFees(chain, opp, feeBpsList, built.fromPool);
        console.log(`[実行] ${opp.label}: 実測手数料${feeBpsList.join("/")}bpsでは利益が出ないため見送り`);
        return false;
      }
      if (!isKRevert(lastError)) {
        throw new ExecutionError(lastError.slice(0, 160), { reverted: true });
      }

      let advanced = false;
      for (let tried = 0; tried < legCount; tried++) {
        const i = (cursor + tried) % legCount;
        if (built.fromPool[i]) continue;
        if (feeIndex[i] >= FEE_LADDER.length - 1) continue;
        feeIndex[i]++;
        feeBpsList[i] = FEE_LADDER[feeIndex[i]];
        cursor = (i + 1) % legCount;
        advanced = true;
        break;
      }
      if (!advanced) break;
    }
  }

  if (!success) {
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
