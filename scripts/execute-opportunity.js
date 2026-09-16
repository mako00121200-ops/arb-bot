// scripts/execute-opportunity.js
//
// 検出した機会を実際に送信する。V2形式とV3形式が混在する経路に対応する。
//
// [フラッシュスワップ方式]
// 経路の最初のプールから「出力通貨(tokenB)」を先に受け取り、2段目以降を
// 回って投入通貨(asset)に戻し、それを最初のプールへ払う。
// 返済額は「元々の投入額(amountIn)」そのもの。受取量が多すぎればプール側の
// 検算で拒否されるため、こちらで手数料を計算する必要がない。
// Aaveから借りないため手数料0.05%がかからない。
//
// [各段の要求量]
//   1段目 … 最初のプールから先に受け取る量(経路の入力)
//   2段目〜… 前の段で実際に要求する量を入力として、受取量を確定させる
//     V3はUniswap公式のQuoterV2、V2はプール自身のgetAmountOutか計算式。
//
// [V2の手数料の実測と学習]
// コントラクトの拒否理由から実測する:
//   「量が足りない」系 … 要求量が多すぎる → 想定を上げて再挑戦
//     ・"UniswapV2: K" / "Pancake: K" / "K"(Solidly)などのK検算
//     ・"insufficient output"(コントラクトの受取量確認。税トークン等)
//     ・"transfer amount exceeds balance"(送る量が手元に無い)
//   "not profitable" … スワップは通った = 想定が正しい → 記録
// ガス見積もりは無料なので、何度試してもガス代はかからない。
// 以前は "UniswapV2: K" だけを見ていたため、フォーク独自の文言や
// フラッシュスワップ方式で出る文言では段階確認が働かず、即座に失敗扱いに
// なっていた(2026年9月16日に修正)。
//
// [送信直前に赤字と分かった時(2026年9月16日追加)]
// ・その経路は、経路上のプールの状態が変わるまで判定から外す
//   (opportunity-scanner.js の markRouteRejected)。同じ経路を毎分判定して
//   毎分見送る繰り返しを止め、「本物の黒字判定」の件数を正しく数える。
// ・V3の段で、価格表の値が公式Quoterより高く出ていたら、その表は古いと
//   みなして破棄し、作り直しに回す。幻の黒字の発生源を元から断つ。
// ・送信直前でも黒字だった経路は markRouteConfirmed で数え、判定の精度
//   (黒字判定のうち本物だった割合)を5分ごとにログに出す。
//
// [誰が取ったか(2026年9月16日追加)]
// 送信判定に入った全ての機会について、30秒後に経路上のプールで他者の裁定が
// あったかを確認する(scripts/competitor-check.js)。送信直前の結果
// (confirmed / rejected / failed_段階)を opp.sendResult に残し、確認結果と
// 組み合わせて記録する。
//
// [手数料の初期値]
// 取引記録などで実測済みのプールは、その値から段階確認を始める。
// 以前は一律で30bps以上から始めていたため、20bpsのプールでも30bpsとして
// 計算し、利益を過小に見積もっていた。

import { ethers } from "ethers";
import { getChainConfig } from "../chain-config.js";
import { getProviderForChain, callWithRpc } from "./onchain-reserves.js";
import { getCurrentTradeCapUsd, recordExecutionSuccess } from "./trade-cap.js";
import { recordRealExecution } from "./real-execution-log.js";
import { estimateGasCostUsd, gasUnitsToUsd } from "./gas-cost.js";
import { getTokenDecimals, getTokenPriceUsd, setPoolFee, getPool, KIND_V2, KIND_V3 } from "./pool-registry.js";
import { quoteV3Exact, quoteFromTable, clearQuoteTable } from "./v3-pools.js";
import { markRouteRejected, markRouteConfirmed } from "./opportunity-scanner.js";
import { scheduleCompetitorCheck } from "./competitor-check.js";

const CONTRACT_ABI = [
  "function executeRoute(address asset, uint256 amount, (address pool, address tokenIn, address tokenOut, uint8 kind, uint256 minOut)[] legs) external",
  "event RouteExecuted(address indexed asset, uint256 amountIn, uint256 profit, uint8 legCount)",
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

const MIN_PROFIT_USD = parseFloat(process.env.MIN_PROFIT_USD || "0.01");
const SAFETY_MARGIN_BPS = 5n;
const FEE_LADDER = [30, 35, 40, 45, 50, 60, 70, 80, 90, 100];
export const TAX_TOKEN_FEE_BPS = parseInt(process.env.TAX_TOKEN_FEE_BPS || "100", 10);
// V3の価格表が公式Quoterよりこれ以上高く出ていたら、表を破棄して作り直す。
const V3_TABLE_DRIFT_BPS = BigInt(parseInt(process.env.V3_TABLE_DRIFT_BPS || "10", 10));

const CONTRACT_KIND_V2 = 0;
const CONTRACT_KIND_V3 = 1;

export class ExecutionError extends Error {
  constructor(message, { reverted = false, taxToken = false, taxPools = [], staleReserves = false, stage = "unknown" } = {}) {
    super(message);
    this.reverted = reverted;
    this.taxToken = taxToken;
    this.taxPools = taxPools;
    this.staleReserves = staleReserves;
    this.stage = stage;
  }
}

/// K検算による拒否。フォークごとに文言が違う("UniswapV2: K", "Pancake: K",
/// Solidly系は "K" のみ)。": Kyber" 等を誤検出しないよう単語の境界で見る。
function isKRevert(message) {
  const m = message || "";
  return /: K\b/.test(m) || /["']K["']/.test(m);
}
/// 受取量や手元の量が足りないことによる拒否。要求量が多すぎた(手数料の
/// 過小見積もり、または税トークン)ことを示すので、K検算と同じく扱う。
function isShortfallRevert(message) {
  return /insufficient output|transfer amount exceeds balance|TRANSFER_FAILED|INSUFFICIENT_OUTPUT_AMOUNT|INSUFFICIENT_INPUT_AMOUNT/i.test(message || "");
}
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

async function fetchLegState(chain, src, poolAddress, tokenIn) {
  const addr = ethers.getAddress(poolAddress);
  if (src.kind === KIND_V3) {
    const c = (p) => new ethers.Contract(addr, V3_STATE_ABI, p);
    const [slot0, liquidity] = await Promise.all([
      callWithRpc(chain, (p) => c(p).slot0(), true),
      callWithRpc(chain, (p) => c(p).liquidity(), true),
    ]);
    if (slot0[0] <= 0n || liquidity <= 0n) return null;
    return { ...src, tokenIn, sqrtPriceX96: slot0[0], liquidity };
  }
  const c = (p) => new ethers.Contract(addr, PAIR_RESERVES_ABI, p);
  const [reserves, token0] = await Promise.all([
    callWithRpc(chain, (p) => c(p).getReserves(), true),
    callWithRpc(chain, (p) => c(p).token0(), true),
  ]);
  const isToken0In = token0.toLowerCase() === tokenIn;
  const reserveIn = isToken0In ? reserves[0] : reserves[1];
  const reserveOut = isToken0In ? reserves[1] : reserves[0];
  if (reserveIn <= 0n || reserveOut <= 0n) return null;
  return { ...src, tokenIn, reserveIn, reserveOut };
}

/// 経路上の全段の状態を、送信直前に同時に取り直す。
async function refreshLegState(chain, opp, tokenPath) {
  try {
    const legs = await Promise.all(
      opp.legs.map((src, i) => fetchLegState(chain, src, opp.poolAddresses[i], tokenPath[i].toLowerCase()))
    );
    return legs.every(Boolean) ? legs : null;
  } catch (e) {
    return null;
  }
}

async function quoteLeg({ chain, leg, amountIn, feeBpsOverride }) {
  if (leg.kind === KIND_V3) {
    const exact = await quoteV3Exact({
      chain, tokenIn: leg.tokenIn, tokenOut: leg.tokenOut,
      amountIn, feeTier: leg.feeTier,
    });
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

/// 各段の要求量を確定させる。
/// 1段目は「最初のプールから先に受け取る量」で、これが経路の入力になる。
/// 最後の段で得た量が amountIn(返済額)を上回れば利益が出る。
async function buildRequestedAmounts({ chain, legs, amountIn, feeBpsList }) {
  const requested = [], fromPool = [], inputs = [], quoted = [];
  let amount = amountIn;
  for (let i = 0; i < legs.length; i++) {
    const q = await quoteLeg({ chain, leg: legs[i], amountIn: amount, feeBpsOverride: feeBpsList[i] });
    if (!q || q.amountOut <= 0n) return null;
    const req = (q.amountOut * (10000n - SAFETY_MARGIN_BPS)) / 10000n;
    if (req <= 0n) return null;
    inputs.push(amount);
    quoted.push(q.amountOut);
    requested.push(req);
    fromPool.push(q.fromPool);
    amount = req;
  }
  return { requested, fromPool, inputs, quoted, finalOut: amount };
}

/// V3の段で、判定に使った価格表が公式Quoterより高く出ていたら表を破棄する。
/// 破棄した表は作り直しの対象になり、それまでそのプールは判定に使われない。
function discardStaleV3Tables(chain, legs, built) {
  const discarded = [];
  for (let i = 0; i < legs.length; i++) {
    const leg = legs[i];
    if (leg.kind !== KIND_V3) continue;
    const input = built.inputs[i];
    const exact = built.quoted[i];
    if (!input || !exact || exact <= 0n) continue;
    const estimated = quoteFromTable({ chain, pool: leg.pool, zeroForOne: leg.zeroForOne, amountIn: input });
    if (estimated <= 0n) continue;
    if (estimated * 10000n > exact * (10000n + V3_TABLE_DRIFT_BPS)) {
      clearQuoteTable(chain, leg.pool);
      const diffPercent = Number(((estimated - exact) * 100000n) / exact) / 1000;
      discarded.push(`${leg.pool.slice(0, 10)}…(表が公式より+${diffPercent.toFixed(3)}%)`);
    }
  }
  if (discarded.length > 0) {
    console.log(`[V3価格表] ${chain}: 公式Quoterより高く出ていた表を破棄しました ${discarded.join(" ")}`);
  }
}

function recordLearnedFees(chain, opp, legs, feeBpsList, fromPool) {
  const learned = [];
  for (let i = 0; i < opp.poolAddresses.length; i++) {
    if (legs[i].kind === KIND_V3) continue;
    if (fromPool[i]) continue;
    const pool = getPool(chain, opp.poolAddresses[i]);
    if (!pool || pool.feeBps === feeBpsList[i]) continue;
    setPoolFee(chain, opp.poolAddresses[i], feeBpsList[i]);
    pool.feeProbed = true;
    learned.push(`${opp.poolAddresses[i].slice(0, 10)}…=${feeBpsList[i]}bps`);
  }
  if (learned.length > 0) console.log(`[手数料実測] ${chain}: ${learned.join(" ")}`);
}

function buildLegArgs(legs, requested) {
  return legs.map((leg, i) => ({
    pool: ethers.getAddress(leg.pool),
    tokenIn: ethers.getAddress(leg.tokenIn),
    tokenOut: ethers.getAddress(leg.tokenOut),
    kind: leg.kind === KIND_V3 ? CONTRACT_KIND_V3 : CONTRACT_KIND_V2,
    minOut: requested[i],
  }));
}

/// V2の脚の手数料の初期値と、段階確認の現在位置を決める。
/// 実測済みならその値から、未実測なら30bps以上から始める。
function initialFees(chain, opp, legs) {
  const feeBpsList = [], feeIndex = [];
  for (let i = 0; i < legs.length; i++) {
    const leg = legs[i];
    if (leg.kind === KIND_V3) {
      feeBpsList.push(leg.feeBps);
      feeIndex.push(FEE_LADDER.length - 1);
      continue;
    }
    const pool = getPool(chain, opp.poolAddresses[i]);
    const start = pool && pool.feeProbed && Number.isFinite(pool.feeBps)
      ? pool.feeBps
      : Math.max(leg.feeBps ?? FEE_LADDER[0], FEE_LADDER[0]);
    feeBpsList.push(start);
    // 次に上げる時は「初期値より大きい最初の段」になるよう位置を合わせる
    const next = FEE_LADDER.findIndex((v) => v > start);
    feeIndex.push(next === -1 ? FEE_LADDER.length - 1 : next - 1);
  }
  return { feeBpsList, feeIndex };
}

/// 送信判定の入口。「誰が取ったか」の確認を予約してから本体を実行し、
/// 送信直前の結果を opp.sendResult に残す。
export async function executeOpportunity(opp) {
  scheduleCompetitorCheck(opp);
  try {
    const ok = await executeOpportunityInner(opp);
    if (ok) opp.sendResult = "sent_success";
    else if (!opp.sendResult) opp.sendResult = "skipped";
    return ok;
  } catch (e) {
    opp.sendResult = `failed_${e instanceof ExecutionError ? e.stage : "unknown"}`;
    throw e;
  }
}

async function executeOpportunityInner(opp) {
  const startedAt = Date.now();
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
  const stateMs = Date.now() - startedAt;
  if (!legs) {
    throw new ExecutionError(`送信直前の状態取得に失敗(${stateMs}ms)`, { staleReserves: true, stage: "state" });
  }

  const wallet = new ethers.Wallet(privateKey, getProviderForChain(chain));
  const contract = new ethers.Contract(contractAddress, CONTRACT_ABI, wallet);

  const legCount = legs.length;
  const { feeBpsList, feeIndex } = initialFees(chain, opp, legs);
  let success = null, lastError = "", lastFromPool = null;
  let cursor = 0;

  const MAX_ATTEMPTS = FEE_LADDER.length * legCount + 2;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const built = await buildRequestedAmounts({ chain, legs, amountIn, feeBpsList });
    if (!built) {
      throw new ExecutionError("受取量の確定に失敗(Quoterまたはプールが応答せず)", { staleReserves: true, stage: "quote" });
    }
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
        discardStaleV3Tables(chain, legs, built);
        markRouteRejected(opp);
        opp.sendResult = "rejected";
        console.log(`[実行] ${opp.label}: 送信直前の正確な見積もりでは赤字(手数料${feeBpsList.join("/")}bps)。プールが動くまで再判定しません`);
        return false;
      }
      if (!isKRevert(lastError) && !isShortfallRevert(lastError)) {
        throw new ExecutionError(lastError.slice(0, 160), { reverted: true, stage: "estimateGas" });
      }

      // 量が足りない。手数料を計算式で決めているV2の脚を1つずつ上げる。
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
    if (taxPools.length === 0) {
      // 上げられるV2の脚が無い(V3やプール自身が受取量を返す形式だけ)のに
      // 量が足りない。価格が動いたか、税トークンが経路にある。
      throw new ExecutionError(
        `量が足りず拒否(手数料を上げられる脚なし): ${lastError.slice(0, 120)}`,
        { reverted: true, staleReserves: true, stage: "shortfall" }
      );
    }
    throw new ExecutionError(
      `手数料${TAX_TOKEN_FEE_BPS}bpsまで上げても拒否(送金時に税を取るトークンの可能性)`,
      { reverted: true, taxToken: true, taxPools, stage: "feeLadder" }
    );
  }

  const { built, legArgs, gasUnits } = success;
  // 返済額は投入額そのもの。一周して得た量がこれを上回れば利益。
  if (built.finalOut <= amountIn) {
    discardStaleV3Tables(chain, legs, built);
    markRouteRejected(opp);
    opp.sendResult = "rejected";
    console.log(`[実行] ${opp.label}: 一周して得た量が返済額に届かず見送り。プールが動くまで再判定しません`);
    return false;
  }

  const gasWithBuffer = (gasUnits * 120n) / 100n;
  let gasCostUsd = await gasUnitsToUsd(chain, gasWithBuffer);
  if (gasCostUsd == null) gasCostUsd = await estimateGasCostUsd(chain, opp.kind);

  const grossProfitUsd = (Number(built.finalOut - amountIn) / Math.pow(10, decimals)) * priceUsd;
  const finalProfitUsd = grossProfitUsd - gasCostUsd;

  if (finalProfitUsd < MIN_PROFIT_USD) {
    markRouteRejected(opp);
    opp.sendResult = "below_gas";
    console.log(`[実行] ${opp.label}: ガス代差引後$${finalProfitUsd.toFixed(4)}が下限$${MIN_PROFIT_USD}未満のため見送り(粗利$${grossProfitUsd.toFixed(4)} ガス$${gasCostUsd.toFixed(4)})`);
    return false;
  }

  markRouteConfirmed(opp);
  opp.sendResult = "confirmed";
  const readyMs = Date.now() - startedAt;
  console.log(`[実行] ${opp.kind} ${chain} ${opp.label}: 送信します(投入$${tradeUsd.toFixed(2)} 純利益$${finalProfitUsd.toFixed(4)} ガス$${gasCostUsd.toFixed(4)}/${gasUnits} 準備${readyMs}ms)`);

  let tx;
  try {
    tx = await contract.executeRoute(opp.tokenA, amountIn, legArgs, { gasLimit: gasWithBuffer });
  } catch (e) {
    const msg = e.message || "";
    throw new ExecutionError(msg.slice(0, 160), { reverted: msg.includes("execution reverted"), stage: "send" });
  }

  console.log(`[実行] 送信: ${tx.hash}`);
  let receipt;
  try {
    receipt = await tx.wait();
  } catch (e) {
    throw new ExecutionError(`確定待ちで失敗: ${(e.message || "").slice(0, 120)}`, { reverted: true, stage: "wait" });
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
