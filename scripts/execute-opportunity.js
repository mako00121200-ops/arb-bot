// scripts/execute-opportunity.js
//
// 検出した機会を実際に送信する。V2形式とV3形式が混在する経路に対応する。
//
// [受取量はコントラクトがチェーン上で計算する(2026年9月17日に作り直し)]
// 以前はbotが送信直前に各段の状態を取り直し、段ごとにQuoterで受取量を見積もり、
// 各段に5bpsの安全余裕を引き、手数料を段階的に上げながらガス見積もりを
// 何度も繰り返していた。往復は10回を超え、推測の積み重ねの誤差が
// 薄い機会(利益0.1〜0.3%)を赤字と判定していた。6時間で送信直前に
// 進んだ10件は全て赤字判定になり、うち1件はその5秒後に他者が取っていた。
//
// 今は次の2回だけで送信まで進む:
//   1. simulateRoute(eth_call)… コントラクトが実行の瞬間の準備量で経路を
//      最後まで回し、「戻ってきた量」と「返済額」を返す。正確な利益が1回で分かる
//   2. executeRoute … 利益が出るなら送信。受取量はチェーン上で計算されるので、
//      botが要求量を渡す必要がない
// V2の手数料は実測値をコントラクトに渡し、プール自身が受取量を計算できる
// 形式(Solidly系・Camelot等)はプールの計算を優先する。
//
// [送信直前に赤字と分かった時]
// ・その経路は、経路上のプールの状態が変わるまで判定から外す
// ・V3を含む経路なら、その段の価格表を破棄して作り直しに回す
// ・赤字の幅(bps)を記録する(どれだけ惜しかったかを後で集計するため)
//
// [誰が取ったか]
// 送信判定に入った全ての機会について、30秒後に経路上のプールで他者の裁定が
// あったかを確認する(scripts/competitor-check.js)。

import { ethers } from "ethers";
import { getChainConfig } from "../chain-config.js";
import { getProviderForChain, callWithRpc } from "./onchain-reserves.js";
import { getCurrentTradeCapUsd, recordExecutionSuccess } from "./trade-cap.js";
import { recordRealExecution } from "./real-execution-log.js";
import { estimateGasCostUsd, gasUnitsToUsd, weiToUsd } from "./gas-cost.js";
import { getTokenDecimals, getTokenPriceUsd, getPool, KIND_V3 } from "./pool-registry.js";
import { clearQuoteTable } from "./v3-pools.js";
import { markRouteRejected, markRouteConfirmed } from "./opportunity-scanner.js";
import { scheduleCompetitorCheck } from "./competitor-check.js";

const LEG_TUPLE = "(address pool, address tokenIn, address tokenOut, uint8 kind, uint16 feeBps)[]";
const CONTRACT_ABI = [
  `function executeRoute(address asset, uint256 amount, ${LEG_TUPLE} legs, uint256 minProfit) external`,
  `function simulateRoute(address asset, uint256 amount, ${LEG_TUPLE} legs) external`,
  "error SimulationResult(uint256 returned, uint256 owed)",
  "event RouteExecuted(address indexed asset, uint256 amountIn, uint256 profit, uint8 legCount)",
];
const CONTRACT_IFACE = new ethers.Interface(CONTRACT_ABI);

const MIN_PROFIT_USD = parseFloat(process.env.MIN_PROFIT_USD || "0.01");
export const TAX_TOKEN_FEE_BPS = parseInt(process.env.TAX_TOKEN_FEE_BPS || "100", 10);
// 送信から確定までに価格が少し動いても取り消されないよう、コントラクトに渡す
// 最低利益は「確認した利益」のこの割合にする(残りは値動きの余裕)。
const MIN_PROFIT_SHARE_BPS = BigInt(parseInt(process.env.MIN_PROFIT_SHARE_BPS || "5000", 10));

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

/// K検算による拒否。V2の手数料の実測値が実際より低かったことを示す。
function isKRevert(message) {
  const m = message || "";
  return /: K\b/.test(m) || /["']K["']/.test(m);
}

function buildLegArgs(chain, opp) {
  return opp.legs.map((leg, i) => {
    const isV3 = leg.kind === KIND_V3;
    let feeBps = 0;
    if (!isV3) {
      const pool = getPool(chain, opp.poolAddresses[i]);
      feeBps = Math.max(0, Math.min(9999, Math.round(pool?.feeBps ?? leg.feeBps ?? 30)));
    }
    return {
      pool: ethers.getAddress(opp.poolAddresses[i]),
      tokenIn: ethers.getAddress(leg.tokenIn),
      tokenOut: ethers.getAddress(leg.tokenOut),
      kind: isV3 ? CONTRACT_KIND_V3 : CONTRACT_KIND_V2,
      feeBps,
    };
  });
}

/// コントラクトに経路を最後まで回させて、戻ってきた量と返済額を受け取る。
/// 戻り値: { returned, owed } または { error: 拒否理由 }
async function simulate(chain, contractAddress, from, asset, amountIn, legArgs) {
  const data = CONTRACT_IFACE.encodeFunctionData("simulateRoute", [asset, amountIn, legArgs]);
  try {
    await callWithRpc(chain, (p) => p.call({ to: contractAddress, from, data }), true);
    return { error: "結果が返りませんでした" };
  } catch (e) {
    const revertData = e?.data ?? e?.info?.error?.data ?? e?.error?.data ?? null;
    if (typeof revertData === "string" && revertData.startsWith("0x")) {
      try {
        const parsed = CONTRACT_IFACE.parseError(revertData);
        if (parsed && parsed.name === "SimulationResult") {
          return { returned: parsed.args.returned, owed: parsed.args.owed };
        }
      } catch (inner) {}
    }
    return { error: (e?.shortMessage || e?.reason || e?.message || "").slice(0, 160) };
  }
}

function clearV3TablesOfRoute(chain, opp) {
  opp.legs.forEach((leg, i) => {
    if (leg.kind === KIND_V3) clearQuoteTable(chain, opp.poolAddresses[i]);
  });
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

  const tradeUsd = (Number(amountIn) / Math.pow(10, decimals)) * priceUsd;
  const privateKey = process.env.MAINNET_BOT_PRIVATE_KEY;
  const dryRun = process.env.DRY_RUN !== "false";

  if (dryRun || !privateKey) {
    console.log(`[実行] ${opp.kind} ${chain} ${opp.label}: 投入$${tradeUsd.toFixed(2)} DRY_RUN=${dryRun}`);
    return false;
  }

  const wallet = new ethers.Wallet(privateKey, getProviderForChain(chain));
  const asset = ethers.getAddress(opp.tokenA);
  const legArgs = buildLegArgs(chain, opp);

  // 1. 結果の問い合わせ(1回)
  const sim = await simulate(chain, contractAddress, wallet.address, asset, amountIn, legArgs);
  const simMs = Date.now() - startedAt;

  if (sim.error) {
    const msg = sim.error;
    if (isKRevert(msg)) {
      markRouteRejected(opp);
      throw new ExecutionError(`V2の手数料の実測値が実際より低い(K検算で拒否): ${msg.slice(0, 100)}`, { reverted: true, stage: "feeMismatch" });
    }
    throw new ExecutionError(msg, { reverted: true, stage: "simulate" });
  }

  const profitRaw = sim.returned - sim.owed; // 負になり得る
  const profitBps = sim.owed > 0n ? Number((profitRaw * 100000n) / sim.owed) / 10 : 0;

  if (profitRaw <= 0n) {
    markRouteRejected(opp);
    if (opp.hasV3) clearV3TablesOfRoute(chain, opp);
    opp.sendResult = "rejected";
    opp.shortfallBps = profitBps;
    console.log(`[実行] ${opp.label}: チェーン上の計算では赤字(${profitBps.toFixed(1)}bps、判定時の見込み$${opp.netProfitUsd.toFixed(4)}、確認${simMs}ms)。プールが動くまで再判定しません`);
    return false;
  }

  const grossProfitUsd = (Number(profitRaw) / Math.pow(10, decimals)) * priceUsd;
  let gasCostUsd = await estimateGasCostUsd(chain, opp.kind);
  const expectedNetUsd = grossProfitUsd - gasCostUsd;
  if (expectedNetUsd < MIN_PROFIT_USD) {
    markRouteRejected(opp);
    opp.sendResult = "below_gas";
    console.log(`[実行] ${opp.label}: 粗利$${grossProfitUsd.toFixed(4)}(+${profitBps.toFixed(1)}bps)がガス代$${gasCostUsd.toFixed(4)}を引くと下限未満のため見送り`);
    return false;
  }

  // 2. 送信。値動きの余裕として、確認した利益の一部だけを最低利益にする。
  const minProfit = (profitRaw * MIN_PROFIT_SHARE_BPS) / 10000n;
  const contract = new ethers.Contract(contractAddress, CONTRACT_ABI, wallet);
  let gasUnits;
  try {
    gasUnits = await contract.executeRoute.estimateGas(asset, amountIn, legArgs, minProfit);
  } catch (e) {
    const msg = (e?.shortMessage || e?.message || "").slice(0, 160);
    markRouteRejected(opp);
    throw new ExecutionError(`確認後に状況が変わり拒否: ${msg}`, { reverted: true, staleReserves: true, stage: "estimateGas" });
  }
  const gasWithBuffer = (gasUnits * 120n) / 100n;
  const measuredGasUsd = await gasUnitsToUsd(chain, gasWithBuffer);
  if (measuredGasUsd != null) gasCostUsd = measuredGasUsd;

  markRouteConfirmed(opp);
  opp.sendResult = "confirmed";
  const readyMs = Date.now() - startedAt;
  console.log(`[実行] ${opp.kind} ${chain} ${opp.label}: 送信します(投入$${tradeUsd.toFixed(2)} 粗利$${grossProfitUsd.toFixed(4)}/+${profitBps.toFixed(1)}bps ガス$${gasCostUsd.toFixed(4)} 確認${simMs}ms 準備${readyMs}ms)`);

  let tx;
  try {
    tx = await contract.executeRoute(asset, amountIn, legArgs, minProfit, { gasLimit: gasWithBuffer });
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

  // 実際に払ったガス代。receipt.gasPrice は実効単価(ethers v6)。
  // 事前の見積もりではなく、この確定値で手元に残る額を出す。
  let actualGasCostUsd = null;
  try {
    actualGasCostUsd = await weiToUsd(chain, receipt.gasUsed * receipt.gasPrice);
  } catch (e) {}
  const actualNetProfitUsd = actualProfitUsd != null && actualGasCostUsd != null
    ? actualProfitUsd - actualGasCostUsd
    : null;

  if (actualNetProfitUsd != null) {
    console.log(`[実行] 確定: 粗利+$${actualProfitUsd.toFixed(4)} − ガス$${actualGasCostUsd.toFixed(4)} = 純利益+$${actualNetProfitUsd.toFixed(4)}(見積もりガス$${gasCostUsd.toFixed(4)})`);
  } else if (actualProfitUsd != null) {
    console.log(`[実行] 確定: 粗利+$${actualProfitUsd.toFixed(4)}(ガス代を確定できず)`);
  }

  recordRealExecution({
    timestamp: new Date().toISOString(),
    pairLabel: `${opp.kind} ${chain} ${opp.label}`,
    kind: opp.kind,
    chain, txHash: tx.hash, explorerUrl: chainConfig.explorerTxUrl(tx.hash),
    tradeAmountUsd: tradeUsd,
    predictedProfitUsd: grossProfitUsd - gasCostUsd,
    actualProfitUsd,
    actualGasCostUsd,
    actualNetProfitUsd,
    gasUsed: receipt.gasUsed.toString(),
    gasCostUsd,
  });
  recordExecutionSuccess();
  return true;
}
