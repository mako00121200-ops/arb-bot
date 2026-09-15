// scripts/execute-opportunity.js
//
// 検出した機会を実際に送信する。V2形式とV3形式が混在する経路に対応する。
//
// [送信直前の確定]
// メモリ上の値は概算なので、送信前に各段の受取量を確定させる。
//   V3 … Uniswap公式の QuoterV2 に問い合わせる(ティック計算を自前でやらない)
//   V2 … プール自身の getAmountOut、無ければ準備量から計算
// 前の段で「実際に要求する量」を次の段の入力にして、余裕を正しく連鎖させる。
//
// [V2の手数料の実測と学習]
// Uniswap V2形式のプールには手数料を問い合わせる関数が無いため、
// コントラクトの拒否理由から実測する:
//   "UniswapV2: K"   … 要求量が多すぎる → 想定を上げて再挑戦
//   "not profitable" … スワップは通った = 想定が正しい → 記録
// ガス見積もりは無料なので、何度試してもガス代はかからない。
// V3は手数料が区分で確定しているため、この学習は不要。
//
// [優先処理]
// ここから出すRPC呼び出しは全て優先列で発行し、背景作業に待たされないようにする。

import { ethers } from "ethers";
import { getChainConfig } from "../chain-config.js";
import { getProviderForChain, callWithRpc } from "./onchain-reserves.js";
import { getCurrentTradeCapUsd, recordExecutionSuccess } from "./trade-cap.js";
import { recordRealExecution } from "./real-execution-log.js";
import { estimateGasCostUsd, gasUnitsToUsd } from "./gas-cost.js";
import { getTokenDecimals, getTokenPriceUsd, setPoolFee, getPool, KIND_V2, KIND_V3 } from "./pool-registry.js";
import { quoteV3Exact } from "./v3-pools.js";

const CONTRACT_ABI = [
  "function executeRoute(address asset, uint256 amount, (address pool, address tokenIn, address tokenOut, uint8 kind, uint256 minOut)[] legs) external",
  "event RouteExecuted(address indexed asset, uint256 amountBorrowed, uint256 profit, uint8 legCount)",
];
const POOL_QUOTE_ABI = ["function getAmountOut(uint256 amountIn, address tokenIn) view returns (uint256)"];
const PAIR_RESERVES_ABI = [
  "function getReserves() view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast)",
  "function token0() view returns (address)",
];
const V3_STATE_ABI = [
  "function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)",
  "function liquidity() view returns (uint128)",
];

const AAVE_PREMIUM_BPS = 5n;
const MIN_PROFIT_USD = parseFloat(process.env.MIN_PROFIT_USD || "0.01");
const SAFETY_MARGIN_BPS = 5n;
const FEE_LADDER = [30, 35, 40, 45, 50, 60, 70, 80, 90, 100];
export const TAX_TOKEN_FEE_BPS = parseInt(process.env.TAX_TOKEN_FEE_BPS || "100", 10);

// コントラクト側の種別コード
const CONTRACT_KIND_V2 = 0;
const CONTRACT_KIND_V3 = 1;

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

function buildTokenPath(opp) {
  const path = [opp.tokenA];
  for (const leg of opp.legs) path.push(leg.tokenOut);
  return path;
}

/// 経路上の全プールの状態を、送信直前に取り直す。
/// V2は準備量、V3は価格と流動性。ここで機会が消えていれば、
/// メモリ上の値が古かったということ。
async function refreshLegState(chain, opp, tokenPath) {
  const legs = [];
  for (let i = 0; i < opp.legs.length; i++) {
    const src = opp.legs[i];
    const addr = ethers.getAddress(opp.poolAddresses[i]);
    const tokenIn = tokenPath[i].toLowerCase();

    if (src.kind === KIND_V3) {
      try {
        const slot0 = await callWithRpc(chain, (p) => new ethers.Contract(addr, V3_STATE_ABI, p).slot0(), true);
        const liquidity = await callWithRpc(chain, (p) => new ethers.Contract(addr, V3_STATE_ABI, p).liquidity(), true);
        if (slot0[0] <= 0n || liquidity <= 0n) return null;
        legs.push({ ...src, tokenIn, sqrtPriceX96: slot0[0], liquidity });
      } catch (e) {
        return null;
      }
    } else {
      try {
        const reserves = await callWithRpc(chain, (p) => new ethers.Contract(addr, PAIR_RESERVES_ABI, p).getReserves(), true);
        const token0 = await callWithRpc(chain, (p) => new ethers.Contract(addr, PAIR_RESERVES_ABI, p).token0(), true);
        const isToken0In = token0.toLowerCase() === tokenIn;
        const reserveIn = isToken0In ? reserves[0] : reserves[1];
        const reserveOut = isToken0In ? reserves[1] : reserves[0];
        if (reserveIn <= 0n || reserveOut <= 0n) return null;
        legs.push({ ...src, tokenIn, reserveIn, reserveOut });
      } catch (e) {
        return null;
      }
    }
  }
  return legs;
}

/// 1段の受取量を確定させる。V3は公式のQuoter、V2はプール自身か計算式。
/// fromPool は「プール自身から正確な値を得られたか」。V2の手数料学習で使う。
async function quoteLeg({ chain, leg, amountIn, feeBpsOverride }) {
  if (leg.kind === KIND_V3) {
    const exact = await quoteV3Exact({
      chain, tokenIn: leg.tokenIn, tokenOut: leg.tokenOut,
      amountIn, feeTier: leg.feeTier,
    });
    // Quoterが答えれば正確。答えない場合はこの経路を諦める。
    return exact ? { amountOut: exact, fromPool: true } : null;
  }

  const feeBps = feeBpsOverride ?? leg.feeBps;
  try {
    const out = await callWithRpc(chain, (p) =>
      new ethers.Contract(ethers.getAddress(leg.pool), POOL_QUOTE_ABI, p)
        .getAmountOut(amountIn, ethers.getAddress(leg.tokenIn)), true);
    if (out > 0n) return { amountOut: out, fromPool: true };
  } catch (e) { /* この形式のプールではない */ }
  return { amountOut: getAmountOutCalc(amountIn, leg.reserveIn, leg.reserveOut, feeBps), fromPool: false };
}

async function buildRequestedAmounts({ chain, legs, amountIn, feeBpsList }) {
  const requested = [], fromPool = [];
  let amount = amountIn;
  for (let i = 0; i < legs.length; i++) {
    const q = await quoteLeg({ chain, leg: legs[i], amountIn: amount, feeBpsOverride: feeBpsList[i] });
    if (!q || q.amountOut <= 0n) return null;
    const req = (q.amountOut * (10000n - SAFETY_MARGIN_BPS)) / 10000n;
    if (req <= 0n) return null;
    requested.push(req);
    fromPool.push(q.fromPool);
    amount = req;
  }
  return { requested, fromPool };
}

function recordLearnedFees(chain, opp, legs, feeBpsList, fromPool) {
  const learned = [];
  for (let i = 0; i < opp.poolAddresses.length; i++) {
    if (legs[i].kind === KIND_V3) continue; // V3は区分で確定済み
    if (fromPool[i]) continue;              // プール自身から得られた分は正確
    const pool = getPool(chain, opp.poolAddresses[i]);
    if (!pool || pool.feeBps === feeBpsList[i]) continue;
    setPoolFee(chain, opp.poolAddresses[i], feeBpsList[i]);
    pool.feeProbed = true;
    learned.push(`${opp.poolAddresses[i].slice(0, 10)}…=${feeBpsList[i]}bps`);
  }
  if (learned.length > 0) console.log(`[手数料実測] ${chain}: ${learned.join(" ")}`);
}

/// コントラクトに渡す経路を組み立てる。
function buildLegArgs(legs, requested) {
  return legs.map((leg, i) => ({
    pool: ethers.getAddress(leg.pool),
    tokenIn: ethers.getAddress(leg.tokenIn),
    tokenOut: ethers.getAddress(leg.tokenOut),
    kind: leg.kind === KIND_V3 ? CONTRACT_KIND_V3 : CONTRACT_KIND_V2,
    minOut: requested[i],
  }));
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

  const legs = await refreshLegState(chain, opp, tokenPath);
  if (!legs) {
    throw new ExecutionError("送信直前の状態取得に失敗", { staleReserves: true });
  }

  const wallet = new ethers.Wallet(privateKey, getProviderForChain(chain));
  const contract = new ethers.Contract(contractAddress, CONTRACT_ABI, wallet);
  const amountOwed = amountIn + (amountIn * AAVE_PREMIUM_BPS) / 10000n;

  // V2の脚だけ、手数料の想定を1つずつ上げながら通る組み合わせを探す。
  const legCount = legs.length;
  const feeIndex = legs.map(() => 0);
  let feeBpsList = legs.map((l) => (l.kind === KIND_V3 ? l.feeBps : Math.max(l.feeBps, FEE_LADDER[0])));
  let success = null, lastError = "", lastFromPool = null;
  let cursor = 0;

  const MAX_ATTEMPTS = FEE_LADDER.length * legCount + 2;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const built = await buildRequestedAmounts({ chain, legs, amountIn, feeBpsList });
    if (!built) return false;
    lastFromPool = built.fromPool;

    const legArgs = buildLegArgs(legs, built.requested);
    try {
      const gasUnits = await contract.executeRoute.estimateGas(opp.tokenA, amountIn, legArgs);
      success = { built, legArgs, gasUnits };
      recordLearnedFees(chain, opp, legs, feeBpsList, built.fromPool);
      break;
    } catch (e) {
      lastError = e.message || "";

      if (isNotProfitableRevert(lastError)) {
        recordLearnedFees(chain, opp, legs, feeBpsList, built.fromPool);
        console.log(`[実行] ${opp.label}: 実測手数料${feeBpsList.join("/")}bpsでは利益が出ないため見送り`);
        return false;
      }
      if (!isKRevert(lastError)) {
        throw new ExecutionError(lastError.slice(0, 160), { reverted: true });
      }

      // 「K」はV2形式のプールでしか出ない。V2の脚を1つずつ上げる。
      let advanced = false;
      for (let tried = 0; tried < legCount; tried++) {
        const i = (cursor + tried) % legCount;
        if (legs[i].kind === KIND_V3) continue;
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
      if (legs[i].kind === KIND_V3) continue;
      if (lastFromPool && lastFromPool[i]) continue;
      if (feeIndex[i] >= FEE_LADDER.length - 1) taxPools.push(opp.poolAddresses[i]);
    }
    throw new ExecutionError(
      `手数料${TAX_TOKEN_FEE_BPS}bpsまで上げても拒否(送金時に税を取るトークンの可能性)`,
      { reverted: true, taxToken: true, taxPools }
    );
  }

  const { built, legArgs, gasUnits } = success;
  const finalOut = built.requested[built.requested.length - 1];
  if (finalOut <= amountOwed) {
    console.log(`[実行] ${opp.label}: 確定した受取量では返済額に届かず見送り`);
    return false;
  }

  const gasWithBuffer = (gasUnits * 120n) / 100n;
  let gasCostUsd = await gasUnitsToUsd(chain, gasWithBuffer);
  if (gasCostUsd == null) gasCostUsd = await estimateGasCostUsd(chain, opp.kind);

  const grossProfitUsd = (Number(finalOut - amountOwed) / Math.pow(10, decimals)) * priceUsd;
  const finalProfitUsd = grossProfitUsd - gasCostUsd;

  if (finalProfitUsd < MIN_PROFIT_USD) {
    console.log(`[実行] ${opp.label}: ガス代差引後$${finalProfitUsd.toFixed(4)}が下限$${MIN_PROFIT_USD}未満のため見送り(粗利$${grossProfitUsd.toFixed(4)} ガス$${gasCostUsd.toFixed(4)})`);
    return false;
  }

  console.log(`[実行] ${opp.kind} ${chain} ${opp.label}: 送信します(投入$${tradeUsd.toFixed(2)} 純利益$${finalProfitUsd.toFixed(4)} ガス$${gasCostUsd.toFixed(4)}/${gasUnits})`);

  let tx;
  try {
    tx = await contract.executeRoute(opp.tokenA, amountIn, legArgs, { gasLimit: gasWithBuffer });
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
      if (parsed && parsed.name === "RouteExecuted") {
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
