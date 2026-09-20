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
import { getProviderForChain, callWithRpc, poolHasAmountOut } from "./onchain-reserves.js";
import { getCurrentTradeCapUsd, recordExecutionSuccess } from "./trade-cap.js";
import { recordRealExecution } from "./real-execution-log.js";
import { estimateGasCostUsd, gasUnitsToUsd, weiToUsd, getEstimatedGasPriceWei, recordActualGasPrice } from "./gas-cost.js";
import { getTokenDecimals, getTokenPriceUsd, getPool, KIND_V3 } from "./pool-registry.js";
import { quoteV3ByPoolBatch, fetchReservesBatch } from "./multicall-reserves.js";
import { clearQuoteTable, quoteV3Exact, isForkFactory } from "./v3-pools.js";
import { markRouteRejected, markRouteConfirmed, notePoolBlame } from "./opportunity-scanner.js";
import { scheduleCompetitorCheck } from "./competitor-check.js";

// ===== 赤字と確定した経路の、段ごとの答え合わせ(2026年9月19日に追加) =====
//
// [なぜ要るか]
// 今までは「経路全体で何bpsずれたか」しか分からなかった。記録簿には
// -9.5bps から **-476.7bps** まで並んでいたが、どの段が嘘をついているのか
// 特定できず、原因を推測で決めるしかなかった。
//
// 段ごとの見込み(opp.legAmounts)は判定時に残してある。赤字と確定した時だけ、
// **同じ投入額で各段を単独に正確に見積もり直し**、見込みと突き合わせる。
// 犯人の段が名指しできる。
//
// [RPCはほぼ増えない]
// 赤字の確定は1日329件。1件につきV3用とV2用で最大2回の束ね呼び出し。
// 月に約2万回で、枠2,000万の0.1%。
const DIAGNOSE_MIN_BPS = parseFloat(process.env.DIAGNOSE_MIN_BPS || "5");

function bpsDiff(expected, actual) {
  if (expected <= 0n) return null;
  return Number(((actual - expected) * 10000n) / expected);
}

/// 赤字だった経路について、段ごとの誤差をログに出す。失敗しても判定は止めない。
async function diagnoseRejectedRoute(chain, contractAddress, opp) {
  const legs = opp.legs || [];
  const expected = opp.legAmounts || [];
  if (legs.length === 0 || expected.length !== legs.length) return;

  // ① V3の段: 自前コントラクトの quoteV3 に、見込みと同じ投入額で聞き直す。
  const v3Jobs = [], v3Index = [];
  for (let i = 0; i < legs.length; i++) {
    if (legs[i].kind !== KIND_V3 || expected[i].in <= 0n) continue;
    v3Jobs.push({ pool: legs[i].pool, tokenIn: legs[i].tokenIn, amountIn: expected[i].in });
    v3Index.push(i);
  }
  // ② V2の段: 今の準備量を読み直して、同じ式で計算し直す。
  const v2Addrs = [], v2Index = [];
  for (let i = 0; i < legs.length; i++) {
    if (legs[i].kind === KIND_V3) continue;
    v2Addrs.push(legs[i].pool);
    v2Index.push(i);
  }

  const actual = new Array(legs.length).fill(null);
  const [v3Outs, v2States] = await Promise.all([
    v3Jobs.length ? quoteV3ByPoolBatch(chain, contractAddress, v3Jobs, true).catch(() => []) : [],
    v2Addrs.length ? fetchReservesBatch(chain, v2Addrs.map((a) => ({ address: a })), true).catch(() => new Map()) : new Map(),
  ]);
  for (let k = 0; k < v3Index.length; k++) {
    const out = v3Outs[k];
    if (out != null && out > 0n) actual[v3Index[k]] = out;
  }

  // 自前の quoteV3 が使えないチェーンへの備え(2026年9月19日)。
  //
  // [実測で判明]
  // Arbitrum の答え合わせが「1段目 読めず / 2段目 読めず」になった。
  // Arbitrum と Avalanche のコントラクトは quoteV3 の無い旧版のままなので
  // (再デプロイ未実施)、自前の見積もりが1件も返らない。
  // 公式の QuoterV2 は**公式ファクトリーのプールなら**引けるので、
  // 読めなかった段だけそちらで埋める。フォークは公式では引けない
  // (別のプールの価格が返る)ので対象外。
  for (let k = 0; k < v3Index.length; k++) {
    const i = v3Index[k];
    if (actual[i] != null) continue;
    const leg = legs[i];
    const pool = getPool(chain, leg.pool);
    if (!pool || leg.feeTier == null) continue;
    if (isForkFactory(chain, pool.factory)) continue;
    try {
      const out = await quoteV3Exact({
        chain, tokenIn: leg.tokenIn, tokenOut: leg.tokenOut,
        amountIn: expected[i].in, feeTier: leg.feeTier, priority: true,
      });
      if (out != null && out > 0n) actual[i] = out;
    } catch (e) {}
  }
  for (let k = 0; k < v2Index.length; k++) {
    const i = v2Index[k];
    const st = v2States.get(legs[i].pool.toLowerCase());
    if (!st || st.raw0 <= 0n || st.raw1 <= 0n) continue;
    const isToken0In = (st.token0 || "").toLowerCase() === legs[i].tokenIn.toLowerCase();
    const rIn = isToken0In ? st.raw0 : st.raw1;
    const rOut = isToken0In ? st.raw1 : st.raw0;
    const withFee = expected[i].in * (10000n - BigInt(legs[i].feeBps));
    const denom = rIn * 10000n + withFee;
    if (denom > 0n) actual[i] = (withFee * rOut) / denom;
  }

  const parts = [];
  let worst = null;
  for (let i = 0; i < legs.length; i++) {
    if (actual[i] == null) { parts.push(`${i + 1}段目 ${legs[i].dexId}:読めず`); continue; }
    const diff = bpsDiff(expected[i].out, actual[i]);
    if (diff == null) { parts.push(`${i + 1}段目 ${legs[i].dexId}:比較不能`); continue; }
    parts.push(`${i + 1}段目 ${legs[i].dexId}(${legs[i].kind}) ${diff >= 0 ? "+" : ""}${diff.toFixed(1)}bps`);
    if (worst == null || diff < worst.diff) worst = { i, diff, leg: legs[i] };
  }
  if (parts.length === 0) return;
  const blame = worst && worst.diff <= -DIAGNOSE_MIN_BPS
    ? ` ← ${worst.i + 1}段目 ${worst.leg.dexId}:${worst.leg.pool.slice(0, 10)}… が原因`
    : "";
  console.log(`[段ごとの答え合わせ] ${chain} ${opp.label} 投入${opp.amountIn}: ${parts.join(" / ")}${blame}`);
  // 犯人が名指しできた時だけ記録する。繰り返せば一時除外される。
  if (blame) {
    try { notePoolBlame(chain, worst.leg.pool, worst.diff); } catch (e) {}
  }
}

// ===== 送信用の署名者(チェーンごとに1つ、nonceを手元で管理)=====
//
// [なぜ要るか(2026年9月19日)]
// 同じチェーンで送信が重なると、両方が pending の nonce を取って同じ番号に
// なり、片方が "replacement fee too low" で失われていた(実測: 粗利$0.4155を
// 丸ごと失った)。その対策で「同じチェーンでは一度に1件」にしていたが、
// 24時間で **26件** が「送信中」で見送りになっていた。成功は40件なので、
// 見送った分は成功の6割に相当する。機会は数分間に集中して来る
// (6件が3分間に来た実測がある)ので、直列だとその山を取りこぼす。
//
// ethers の NonceManager は nonce を手元で数えるので、同時に送っても
// 番号が重ならない。送信に失敗したら reset() で鎖上の値に合わせ直す
// (送れなかった番号が残ると、以降の送信が詰まるため)。
const signers = new Map(); // chain -> { wallet, signer }

function getSigner(chain, privateKey) {
  const key = (chain || "").toLowerCase();
  let entry = signers.get(key);
  if (!entry) {
    const wallet = new ethers.Wallet(privateKey, getProviderForChain(chain));
    entry = { wallet, signer: new ethers.NonceManager(wallet) };
    signers.set(key, entry);
  }
  return entry;
}

/// 送信に失敗した後に呼ぶ。手元の nonce を鎖上の値に合わせ直す。
/// [制限時間超過にも要る(2026年9月20日の実測)]
/// 20秒の制限時間は index.js 側の Promise.race で発生するため、ここの
/// send / wait の catch を通らず、reset() が走らなかった。手元の nonce が
/// 1つ進んだままになり、その送信が未確定のまま消えると、以降の送信が
/// 全部その番号待ちで詰まる。旧コードは送信のたびに nonce を読み直して
/// いたので自然に直っていた。index.js の失敗処理からも呼べるように公開する。
export function resetNonce(chain) {
  const entry = signers.get((chain || "").toLowerCase());
  if (entry) { try { entry.signer.reset(); } catch (e) {} }
}

// ===== コントラクトの ABI(新旧2種、2026年9月20日) =====
//
// ガス削減版で Leg の形が (pool, tokenIn, tokenOut, kind, feeBps) から
// (pool, tokenOut, flags, feeBps) に変わった。再デプロイはチェーンごとに順番に
// 行うので両方の形を持ち、各チェーンのコントラクトへ FLAG_V3() を1回だけ
// 問い合わせて判別する(新版は 1 を返し、旧版には無いので失敗する)。
const LEG_TUPLE_V1 = "(address pool, address tokenIn, address tokenOut, uint8 kind, uint16 feeBps)[]";
const LEG_TUPLE_V2 = "(address pool, address tokenOut, uint8 flags, uint16 feeBps)[]";
function makeContractAbi(legTuple) {
  return [
    `function executeRoute(address asset, uint256 amount, ${legTuple} legs, uint256 minProfit) external`,
    `function simulateRoute(address asset, uint256 amount, ${legTuple} legs) external`,
    "error SimulationResult(uint256 returned, uint256 owed)",
    "event RouteExecuted(address indexed asset, uint256 amountIn, uint256 profit, uint8 legCount)",
  ];
}
const CONTRACT_VERSIONS = {
  1: { version: 1, abi: makeContractAbi(LEG_TUPLE_V1) },
  2: { version: 2, abi: makeContractAbi(LEG_TUPLE_V2) },
};
for (const v of Object.values(CONTRACT_VERSIONS)) v.iface = new ethers.Interface(v.abi);
const FLAG_IFACE = new ethers.Interface(["function FLAG_V3() view returns (uint8)"]);
const contractVersionCache = new Map(); // chain:address -> 1 | 2

/// そのチェーンのコントラクトが新版(flags)か旧版かを判別する。結果は覚える。
/// RPC の失敗(取り消し以外)は覚えない。新版に旧版の形で送ると fallback が
/// "unknown call" で拒否するだけで資産は動かないが、判別を誤ったまま固定すると
/// そのチェーンで一切送れなくなるため。
async function detectContractVersion(chain, address) {
  const key = `${chain}:${address.toLowerCase()}`;
  const cached = contractVersionCache.get(key);
  if (cached) return CONTRACT_VERSIONS[cached];
  let version;
  try {
    const ret = await callWithRpc(chain, (p) => p.call({ to: address, data: FLAG_IFACE.encodeFunctionData("FLAG_V3", []) }), true);
    version = ret && ret !== "0x" && FLAG_IFACE.decodeFunctionResult("FLAG_V3", ret)[0] === 1n ? 2 : 1;
  } catch (e) {
    if (e?.code !== "CALL_EXCEPTION") {
      throw new ExecutionError(`コントラクトの版を判別できず(RPC失敗): ${(e?.shortMessage || e?.message || "").slice(0, 100)}`, { stage: "version" });
    }
    version = 1; // 旧版には FLAG_V3 が無く、fallback が "unknown call" で取り消す
  }
  contractVersionCache.set(key, version);
  console.log(`[コントラクト] ${chain} ${address}: ${version === 2 ? "ガス削減版(flags)" : "旧版(tokenIn/kind)"} と判別しました`);
  return CONTRACT_VERSIONS[version];
}

const MIN_PROFIT_USD = parseFloat(process.env.MIN_PROFIT_USD || "0.01");
export const TAX_TOKEN_FEE_BPS = parseInt(process.env.TAX_TOKEN_FEE_BPS || "100", 10);
// 送信から確定までに価格が少し動いても取り消されないよう、コントラクトに渡す
// 最低利益は「確認した利益」のこの割合にする(残りは値動きの余裕)。
const MIN_PROFIT_SHARE_BPS = BigInt(parseInt(process.env.MIN_PROFIT_SHARE_BPS || "5000", 10));

// 旧版の kind。
const CONTRACT_KIND_V2 = 0;
const CONTRACT_KIND_V3 = 1;
// 新版の flags(contracts/DexArbFlashLoan.sol の FLAG_* と同じ値)。
const CONTRACT_FLAG_V3 = 1;
const CONTRACT_FLAG_IN_IS_TOKEN0 = 2;
const CONTRACT_FLAG_HAS_QUOTE = 4;

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

/// コントラクトに渡す経路。version はコントラクトの版(1: 旧版、2: ガス削減版)。
///
/// [新版の flags]
/// 「投入通貨が token0 か」は地図で分かるので鎖上で問い直さない(token0() の呼び出しが
/// 消える)。「getAmountOut を持つか」は手数料の実測で判明したプールだけ立てる
/// (Uniswap系で失敗する試し呼びが消える)。間違えた flags を渡しても、V2 なら
/// 出力の差分が0で、V3 ならプールの支払い確認で取り消されるだけで資産は動かない。
function buildLegArgs(chain, opp, version) {
  return opp.legs.map((leg, i) => {
    const isV3 = leg.kind === KIND_V3;
    const address = opp.poolAddresses[i];
    const pool = getPool(chain, address);
    let feeBps = 0;
    if (!isV3) feeBps = Math.max(0, Math.min(9999, Math.round(pool?.feeBps ?? leg.feeBps ?? 30)));
    if (version === 1) {
      return {
        pool: ethers.getAddress(address),
        tokenIn: ethers.getAddress(leg.tokenIn),
        tokenOut: ethers.getAddress(leg.tokenOut),
        kind: isV3 ? CONTRACT_KIND_V3 : CONTRACT_KIND_V2,
        feeBps,
      };
    }
    if (!pool?.token0) {
      throw new ExecutionError(`プール ${address} の token0 が地図に無く、flags を作れません`, { stage: "legs" });
    }
    let flags = 0;
    if (isV3) flags |= CONTRACT_FLAG_V3;
    if (pool.token0.toLowerCase() === (leg.tokenIn || "").toLowerCase()) flags |= CONTRACT_FLAG_IN_IS_TOKEN0;
    if (!isV3 && poolHasAmountOut(chain, address)) flags |= CONTRACT_FLAG_HAS_QUOTE;
    return {
      pool: ethers.getAddress(address),
      tokenOut: ethers.getAddress(leg.tokenOut),
      flags,
      feeBps,
    };
  });
}

/// コントラクトに経路を最後まで回させて、戻ってきた量と返済額を受け取る。
/// 戻り値: { returned, owed } または { error: 拒否理由 }
async function simulate(chain, contractAddress, from, asset, amountIn, legArgs, iface) {
  const data = iface.encodeFunctionData("simulateRoute", [asset, amountIn, legArgs]);
  try {
    await callWithRpc(chain, (p) => p.call({ to: contractAddress, from, data }), true);
    return { error: "結果が返りませんでした" };
  } catch (e) {
    const revertData = e?.data ?? e?.info?.error?.data ?? e?.error?.data ?? null;
    if (typeof revertData === "string" && revertData.startsWith("0x")) {
      try {
        const parsed = iface.parseError(revertData);
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

  const { wallet, signer } = getSigner(chain, privateKey);
  const asset = ethers.getAddress(opp.tokenA);
  // コントラクトの版(新旧)は1回だけ判別して覚えるので、2回目以降は RPC を使わない。
  const contractVersion = await detectContractVersion(chain, contractAddress);
  const legArgs = buildLegArgs(chain, opp, contractVersion.version);

  // 1. 結果の問い合わせ(1回)
  const sim = await simulate(chain, contractAddress, wallet.address, asset, amountIn, legArgs, contractVersion.iface);
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
    // どの段が嘘をついていたのかを名指しする。失敗しても判定は止めない。
    try { await diagnoseRejectedRoute(chain, contractAddress, opp); } catch (e) {}
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
  const contract = new ethers.Contract(contractAddress, contractVersion.abi, signer);
  let gasUnits;
  try {
    gasUnits = await contract.executeRoute.estimateGas(asset, amountIn, legArgs, minProfit);
  } catch (e) {
    const msg = (e?.shortMessage || e?.message || "").slice(0, 160);
    markRouteRejected(opp);
    throw new ExecutionError(`確認後に状況が変わり拒否: ${msg}`, { reverted: true, staleReserves: true, stage: "estimateGas" });
  }
  // 上限(gasLimit)には余裕を持たせるが、**費用の見積もりには使わない**。
  // EVMは使わなかったガスを請求しないので、払うのは gasUnits の分だけ。
  // 余裕の20%をそのまま費用に足していたため、見積もりが2割過大になり、
  // その分ハードルが上がって本物の機会を捨てていた(2026年9月19日に修正)。
  const gasWithBuffer = (gasUnits * 120n) / 100n;
  const measuredGasUsd = await gasUnitsToUsd(chain, gasUnits);
  if (measuredGasUsd != null) gasCostUsd = measuredGasUsd;
  // 単価の学習に使うため、この時点の見積もり単価を控えておく。
  const estimatedGasPriceWei = await getEstimatedGasPriceWei(chain);

  markRouteConfirmed(opp);
  opp.sendResult = "confirmed";
  const readyMs = Date.now() - startedAt;
  console.log(`[実行] ${opp.kind} ${chain} ${opp.label}: 送信します(投入$${tradeUsd.toFixed(2)} 粗利$${grossProfitUsd.toFixed(4)}/+${profitBps.toFixed(1)}bps ガス$${gasCostUsd.toFixed(4)} 確認${simMs}ms 準備${readyMs}ms)`);

  let tx;
  try {
    tx = await contract.executeRoute(asset, amountIn, legArgs, minProfit, { gasLimit: gasWithBuffer });
  } catch (e) {
    const msg = e.message || "";
    // 送れなかった番号が手元に残ると以降の送信が詰まるので、鎖上の値に戻す。
    resetNonce(chain);
    throw new ExecutionError(msg.slice(0, 160), { reverted: msg.includes("execution reverted"), stage: "send" });
  }

  console.log(`[実行] 送信: ${tx.hash}`);
  let receipt;
  try {
    receipt = await tx.wait();
  } catch (e) {
    resetNonce(chain);
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

  // 見積もりの単価と実際の実効単価を突き合わせて学習する。
  // 次からの事前判定のハードルが、実態に合った高さになる。
  try {
    const learned = recordActualGasPrice(chain, estimatedGasPriceWei, receipt.gasPrice);
    if (learned) {
      console.log(`[ガス単価の学習] ${chain}: 今回 実際/見積もり=${learned.observed.toFixed(3)} → 補正${learned.ratio.toFixed(3)}(実測${learned.samples}件)`);
    }
  } catch (e) {}

  if (actualNetProfitUsd != null) {
    console.log(`[実行] 確定: 粗利+$${actualProfitUsd.toFixed(4)} − ガス$${actualGasCostUsd.toFixed(4)} = 純利益+$${actualNetProfitUsd.toFixed(4)}(見積もりガス$${gasCostUsd.toFixed(4)})`);
  } else if (actualProfitUsd != null) {
    console.log(`[実行] 確定: 粗利+$${actualProfitUsd.toFixed(4)}(ガス代を確定できず)`);
  }

  // 記録簿(opportunity-journal)にも確定値を載せるため opp に残す。
  // これが無いと「実際に得た利益」が常に0のままになる。
  opp.actualProfitUsd = actualProfitUsd;
  opp.actualGasCostUsd = actualGasCostUsd;
  opp.actualNetProfitUsd = actualNetProfitUsd;

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
