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
import { getProviderForChain, callWithRpc, poolHasAmountOut, readBlockTag, isPendingReadChain } from "./onchain-reserves.js";
import { getCurrentTradeCapUsd, recordExecutionSuccess } from "./trade-cap.js";
import { recordRealExecution } from "./real-execution-log.js";
import { estimateGasCostUsd, gasUnitsToUsd, weiToUsd, getEstimatedGasPriceWei, recordActualGasPrice, isOpStackChain, readL1FeeFromReceipt, recordActualL1Fee } from "./gas-cost.js";
import { getTokenDecimals, getTokenPriceUsd, getPool, KIND_V3 } from "./pool-registry.js";
import { quoteV3ByPoolBatch, fetchReservesBatch } from "./multicall-reserves.js";
import { clearQuoteTable, quoteV3Exact, isForkFactory, setTableTrustedMax, getTableTrustedMax, getTableRange } from "./v3-pools.js";
import { markRouteRejected, markRouteConfirmed, notePoolBlame, revalueRouteFromMap, forceFeeReprobe } from "./opportunity-scanner.js";
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
// 「判定からの動き」を記録する下限(bps)。小さな揺れは出さない。
const DRIFT_MIN_BPS = parseFloat(process.env.DRIFT_MIN_BPS || "5");

function bpsDiff(expected, actual) {
  if (expected <= 0n) return null;
  return Number(((actual - expected) * 10000n) / expected);
}

/// 答え合わせで「表が過大」と分かった時に、投入量の上限を下げる閾値(bps)。
/// 狙う利幅が5〜50bpsなので、それと同じ尺度にする。
const LEARN_CAP_BPS = parseFloat(process.env.LEARN_CAP_BPS || "20");

/// 答え合わせで分かった誤差を、価格表の「信用できる上限」に反映する。
///
/// [なぜ要るか(2026年9月21日、オーナーの指摘)]
/// 「段ごとの答え合わせ」は**公式Quoterと突き合わせて**、その段の見込みが
/// 何bpsずれていたかを**実際に使った投入量で**測っている。
/// これは定期検証(2分に1プール)より、はるかに濃い情報:
///
///   ・**本当に取ろうとした経路**の、**本当に使った額**での誤差
///   ・定期検証は $5/$20/$200/$700 の固定点でしか測らない
///
/// なのに今まで**ログに出すだけで捨てていた**。
/// 「測っているのに使っていない値」の4件目。
///
/// `bpsDiff(expected, actual)` は (actual - expected) / expected なので、
/// **負 = 見込みの方が大きい = 表が過大**。これが危ない向き。
/// その額では信用できないので、**半分まで**上限を下げる。
/// (定期検証が通れば上限は外れるので、行き過ぎても戻れる)
function learnTrustedMaxFromDiff(chain, leg, amountIn, offDiffBps) {
  if (leg.kind !== KIND_V3 || offDiffBps == null) return false;
  if (offDiffBps > -LEARN_CAP_BPS) return false;   // 過小・軽微は触らない
  if (!(amountIn > 0n)) return false;

  const pool = getPool(chain, leg.pool);
  if (!pool || !pool.token0) return false;
  const zeroForOne = pool.token0.toLowerCase() === (leg.tokenIn || "").toLowerCase();

  const next = amountIn / 2n;
  if (!(next > 0n)) return false;
  const current = getTableTrustedMax(chain, leg.pool, zeroForOne);
  if (current != null && current <= next) return false; // すでにもっと厳しい

  setTableTrustedMax(chain, leg.pool, zeroForOne, next);
  const range = getTableRange(chain, leg.pool, zeroForOne);
  console.log(
    `[表の上限/学習] ${chain} ${leg.dexId}:${leg.pool.slice(0, 10)}…: ` +
    `投入${amountIn} で表が**${Math.abs(offDiffBps).toFixed(1)}bps 過大**(公式との差)。` +
    `信用できる上限を ${next} に下げました` +
    (range ? "" : "(最小点も下回ったため、このプールはこの向きでは判定しません)")
  );
  return true;
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
  const ownQuoted = new Array(legs.length).fill(false);
  for (let k = 0; k < v3Index.length; k++) {
    const out = v3Outs[k];
    if (out != null && out > 0n) { actual[v3Index[k]] = out; ownQuoted[v3Index[k]] = true; }
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
  // [公式 Quoter との突き合わせ(2026年9月20日)]
  // Optimism で送信直前の赤字が続き、答え合わせは毎回「0.30% の Uniswap プールが
  // −14〜−15bps」と同じ幅で名指しした。価格表(公式 QuoterV2 で作る)と自前の
  // quoteV3 のどちらがずれているのかを切り分けるため、公式で引けるプールは
  // 自前の値が取れていても公式の値を並べて出す。両者が一致すれば価格表の古さ、
  // 食い違えば見積もり側(コントラクトか手数料帯の取り違え)が原因と分かる。
  const official = new Array(legs.length).fill(null);
  for (let k = 0; k < v3Index.length; k++) {
    const i = v3Index[k];
    const leg = legs[i];
    const pool = getPool(chain, leg.pool);
    if (!pool || leg.feeTier == null) continue;
    if (isForkFactory(chain, pool.factory)) continue;
    try {
      const out = await quoteV3Exact({
        chain, tokenIn: leg.tokenIn, tokenOut: leg.tokenOut,
        amountIn: expected[i].in, feeTier: leg.feeTier, priority: true,
      });
      if (out != null && out > 0n) {
        official[i] = out;
        if (actual[i] == null) actual[i] = out;
      }
    } catch (e) {}
  }
  // V2の段のずれを、**2つの時点の差**に分解する(2026年9月20日に追加)。
  //
  // 準備量は3つの時点のものが存在する。
  //   ① 経路を作った時に leg に写し取った値(opportunity-scanner の orient)
  //   ② 今のプール地図が持っている値(Syncイベントで更新され続けている)
  //   ③ 今チェーンから読み直した値
  // 見込み(expected.out)は①、読み直し(actual)は③から計算される。
  // ②でも同じ式で計算して間に挟めば、
  //   ①→② = 判定してから今までに地図が動いた分(こちらの処理の遅れ)
  //   ②→③ = 地図とチェーンのずれ(取りこぼしたイベント)
  // に分けられる。原因が「先を越された」のか「地図が古い」のかが決まる。
  const storedOut = new Array(legs.length).fill(null);
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

    const held = getPool(chain, legs[i].pool);
    if (held && held.raw0 > 0n && held.raw1 > 0n) {
      const sIn = isToken0In ? held.raw0 : held.raw1;
      const sOut = isToken0In ? held.raw1 : held.raw0;
      const sDenom = sIn * 10000n + withFee;
      if (sDenom > 0n) storedOut[i] = (withFee * sOut) / sDenom;
    }
  }

  const parts = [];
  let worst = null;
  for (let i = 0; i < legs.length; i++) {
    if (actual[i] == null) { parts.push(`${i + 1}段目 ${legs[i].dexId}:読めず`); continue; }
    const diff = bpsDiff(expected[i].out, actual[i]);
    if (diff == null) { parts.push(`${i + 1}段目 ${legs[i].dexId}:比較不能`); continue; }
    // 自前と公式の両方が取れた段は、公式との差も並べる(一致なら価格表の古さが原因)。
    const offDiff = ownQuoted[i] && official[i] != null ? bpsDiff(expected[i].out, official[i]) : null;
    const offNote = offDiff != null ? `(公式${offDiff >= 0 ? "+" : ""}${offDiff.toFixed(1)}bps)` : "";
    // **測った誤差を、その場で表の上限に反映する。**
    try { learnTrustedMaxFromDiff(chain, legs[i], expected[i].in, offDiff); } catch (e) {}
    // V2の段は、差を「判定してから地図が動いた分」と「地図とチェーンの差」に分ける。
    let splitNote = "";
    if (storedOut[i] != null) {
      const moved = bpsDiff(expected[i].out, storedOut[i]); // ①判定時 → ②今の地図
      const gap = bpsDiff(storedOut[i], actual[i]);         // ②今の地図 → ③チェーン
      if (moved != null && gap != null) {
        splitNote = `(判定後に地図が${moved >= 0 ? "+" : ""}${moved.toFixed(1)}bps / 地図とチェーンの差${gap >= 0 ? "+" : ""}${gap.toFixed(1)}bps 手数料${legs[i].feeBps}bps)`;
      }
    }
    parts.push(`${i + 1}段目 ${legs[i].dexId}(${legs[i].kind}) ${diff >= 0 ? "+" : ""}${diff.toFixed(1)}bps${offNote}${splitNote}`);
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

/// ガス量だけを見積もる。**minProfit は 0 で聞く**。
///
/// minProfit は「受取がこれを下回ったら revert する」という最後の比較にしか
/// 使われないので、0 にしてもガス量はほとんど変わらない。0 で聞くことで、
/// 確認(eth_call)の結果を待たずに投げられるようになり、1往復ぶん速くなる。
/// 実際に送る時は、確認の結果から作った本物の minProfit を渡す。
async function estimateGasUnits(chain, contract, fromAddress, contractAddress, asset, amountIn, legArgs) {
  if (isPendingReadChain(chain)) {
    // ethers の estimateGas はブロックの指定を送らないので、pending を明示して生で呼ぶ。
    const callData = contract.interface.encodeFunctionData("executeRoute", [asset, amountIn, legArgs, 0n]);
    const hex = await callWithRpc(chain, (p) => p.send("eth_estimateGas", [{ from: fromAddress, to: contractAddress, data: callData }, "pending"]), true);
    return BigInt(hex);
  }
  return await contract.executeRoute.estimateGas(asset, amountIn, legArgs, 0n, { from: fromAddress });
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
    if (!ret || ret === "0x") {
      // 中身の無い住所への eth_call は "0x" を返す(取り消しではない)。住所の設定
      // 間違いか、展開の取引がまだ確定していない。覚えずに、この機会は見送る。
      throw new ExecutionError(`コントラクトの住所 ${address} に中身がありません(設定を確認してください)`, { stage: "version" });
    }
    version = FLAG_IFACE.decodeFunctionResult("FLAG_V3", ret)[0] === 1n ? 2 : 1;
  } catch (e) {
    if (e instanceof ExecutionError) throw e;
    if (e?.code !== "CALL_EXCEPTION") {
      throw new ExecutionError(`コントラクトの版を判別できず(RPC失敗): ${(e?.shortMessage || e?.message || "").slice(0, 100)}`, { stage: "version" });
    }
    version = 1; // 旧版には FLAG_V3 が無く、fallback が "unknown call" で取り消す
  }
  contractVersionCache.set(key, version);
  console.log(`[コントラクト] ${chain} ${address}: ${version === 2 ? "ガス削減版(flags)" : "旧版(tokenIn/kind)"} と判別しました`);
  return CONTRACT_VERSIONS[version];
}

/// 起動時に、稼働チェーン全部のコントラクトの版を確かめてログに出す。
/// 判別は送信時にも行うが、再デプロイ直後に「住所が正しく、中身がある」ことを
/// 最初の機会を待たずに確認できるようにする(2026年9月20日、Optimism の展開で
/// RPC が "already known" を返し、住所の裏付けが要った)。失敗しても起動は止めない。
/// 確認していない端点の挙動を、実測で切り分けた記録。
/// chain -> "pending" / "latest"(どちらで中身が返るか)
const simulateBlockTag = new Map();

/// 「わざと revert させた中身」が、その端点・そのブロック指定で返るかを確かめる。
///
/// [なぜ要るか(2026年9月21日)]
/// 確認(simulateRoute)は**わざと revert させて SimulationResult を受け取る**
/// 作りなので、revert の中身が返らない端点では一切機能しない。
/// Base を pending で読むようにした直後、確認が3件続けて
/// `missing revert data` になった(いずれも純利益 +$0.36〜+$0.49 の大きな機会)。
///
/// 機会が来るのを待って切り分けるのでは遅い。**起動時に自分で確かめる。**
/// simulateRoute には onlyOwner があり、所有者以外が呼べば必ず
/// `"DexArbFlashLoan: not owner"` で revert する。状態に一切依存しない、
/// 決まった答えが返る試験になる。
///
/// pending で中身が返らず latest で返るなら、そのチェーンは以降 latest で確認する。
async function probeRevertData(chain, contractAddress, iface) {
  const tag = readBlockTag(chain);
  if (tag !== "pending") return; // latest しか使わないチェーンは確かめる意味がない
  // 所有者ではない住所から呼ぶ(必ず onlyOwner で弾かれる)。
  const notOwner = "0x0000000000000000000000000000000000000001";
  const data = iface.encodeFunctionData("simulateRoute", [ethers.ZeroAddress, 0n, []]);

  // 「取り消されなかった」と「取り消されたが中身が無い」は原因が全く違う。
  //   取り消されない → その住所に中身が無いか、別のコントラクト
  //   中身が無い     → 端点が中身を落としているか、理由なしで取り消している
  // 分けて報せないと、次に何をすればいいか決められない。
  const probe = async (blockTag) => {
    try {
      const ret = await callWithRpc(chain, (p) => p.call({ to: contractAddress, from: notOwner, data, blockTag }), true);
      return { kind: "returned", detail: String(ret).slice(0, 20) };
    } catch (e) {
      const d = e?.data ?? e?.info?.error?.data ?? e?.error?.data ?? null;
      if (typeof d === "string" && d.startsWith("0x") && d.length > 2) {
        let reason = d.slice(0, 20);
        try { reason = ethers.toUtf8String("0x" + d.slice(138)).replace(/\0/g, "") || reason; } catch (inner) {}
        return { kind: "revertWithData", detail: reason };
      }
      return { kind: "revertNoData", detail: (e?.shortMessage || e?.message || "").slice(0, 80) };
    }
  };

  try {
    const atPending = await probe("pending");
    if (atPending.kind === "revertWithData") {
      console.log(`[確認の下調べ] ${chain}: pending でも revert の中身が返ります(「${atPending.detail}」)。このままで大丈夫`);
      return;
    }
    const atLatest = await probe("latest");
    if (atLatest.kind === "revertWithData") {
      simulateBlockTag.set(chain, "latest");
      console.warn(`[確認の下調べ] ${chain}: **pending では revert の中身が返りません**(${atPending.kind})。latest では返るので、以降このチェーンの確認は latest で行います`);
      return;
    }
    if (atPending.kind === "returned" || atLatest.kind === "returned") {
      console.warn(`[確認の下調べ] ${chain}: **所有者以外の呼び出しが取り消されませんでした**(返り値「${(atPending.detail || atLatest.detail)}」)。住所 ${contractAddress} に中身が無いか、別のコントラクトです。住所の設定を確認してください`);
      return;
    }
    console.warn(`[確認の下調べ] ${chain}: **取り消されたのに理由が返りません**(pending: ${atPending.detail} / latest: ${atLatest.detail})。bot が期待する版のコントラクトではありません。再デプロイが要ります`);
  } catch (e) {
    console.warn(`[確認の下調べ] ${chain}: 確かめられませんでした: ${(e.message || "").slice(0, 100)}`);
  }
}

export async function checkContractVersions(chains) {
  for (const chain of chains) {
    const chainConfig = getChainConfig(chain);
    const address = chainConfig ? process.env[chainConfig.contractAddressEnvVar] : null;
    if (!address) { console.log(`[コントラクト] ${chain}: 住所が未設定です`); continue; }
    try {
      const v = await detectContractVersion(chain, address);
      // 確認(eth_call)がそのチェーンで機能するかを、ここで確かめておく。
      await probeRevertData(chain, address, v.iface);
    } catch (e) {
      console.warn(`[コントラクト] ${chain} ${address}: 確認できず: ${(e.message || "").slice(0, 120)}`);
    }
  }
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
/// K検算での拒否か。**「受取量が多すぎる」= こちらの計算が物理的に不可能**。
///
/// [なぜ一度も発動していなかったか(2026年9月21日、実測で判明)]
/// この判定は文字列だけを見ていた。`require(..., 'K')` を使う
/// 古い Uniswap V2 フォークなら `reverted: K` という文字列が返るので引っかかる。
///
/// しかし **Aerodrome / Velodrome(Solidly系)は custom error `K()` を使う**。
/// これは文字列を一切返さず、`execution reverted (unknown custom error)` としか
/// 出ない。**だからこの判定は一度も true にならなかった。**
///
/// その結果、Base の `uniswap-v3(X%)→aerodrome→sync発見` が
/// 見込み $0.12〜$0.49(今の平均の20〜50倍)で**何度も落ち続けていた**のに、
/// 手数料の見直しに繋がらず、ただの「確認失敗」として捨てられていた。
///
/// **正しい処理は最初から書いてあった。見分けられなかっただけ。**
/// セレクタで見分ける(`ethers.id("K()").slice(0,10)` で確認済み)。
const K_REVERT_SELECTORS = [
  "0xa932492f", // K()          — Solidly系。受取量が多すぎる
  "0x438d3ade", // BelowMinimumK() — 同上
];

function isKRevert(message) {
  const m = (message || "").toLowerCase();
  if (K_REVERT_SELECTORS.some((sel) => m.includes(sel))) return true;
  return /: k\b/.test(m) || /["']k["']/.test(m) || /\bk\(\)/.test(m);
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

/// 取り消しの先頭4バイト(セレクタ)から、誰が何を言っているかを当てる表。
///
/// [なぜ要るか(2026年9月21日、大物の台帳で判明)]
/// Base の `uniswap-v3(X%)→aerodrome→sync発見` が3本とも
/// 「execution reverted (unknown custom error)」で確認に失敗していた。
/// 見込みは $0.12〜$0.26(今の平均の20〜50倍)。**同じ形の経路が繰り返し落ちている。**
///
/// ところが今までのコードは、**読めなかった取り消しの中身を捨てていた**。
/// 原因を突き止めるのに一番必要な情報(セレクタ)を、自分で消していた。
/// ethers の「unknown custom error」は「分からない」としか言わない。
///
/// セレクタは `ethers.id("K()").slice(0,10)` で計算して確かめた。
const REVERT_SELECTORS = {
  "0xebb6e92f": "SimulationResult(uint256,uint256) — うちの確認結果",
  "0x17080d7e": "QuoteResult(uint256) — うちの見積もり結果",
  "0x08c379a0": "Error(string) — 理由つきの取り消し",
  "0x4e487b71": "Panic(uint256) — 算術あふれ等",
  "0xa932492f": "K() — Solidly系(Aerodrome等)。**受取量が多すぎる**",
  "0x42301c23": "InsufficientOutputAmount() — 受取量が0または不足",
  "0x098fb561": "InsufficientInputAmount() — 投入量が届いていない",
  "0xbb55fd27": "InsufficientLiquidity() — 準備量より多く出そうとした",
  "0x290fa188": "InvalidTo() — 受取先が不正",
  "0x438d3ade": "BelowMinimumK() — Solidly系のK下限",
  "0x5945ea56": "InsufficientAmount()",
  "0xd226f9d4": "InsufficientLiquidityMinted()",
  "0x1309a563": "IsPaused() — プールが止まっている",
  "0x2bc80f3a": "T() — Uniswap V3 の tick 不正",
  "0xa1bf7886": "LOK() — Uniswap V3 が未初期化/ロック中",
  "0xfcdf4aa7": "SPL() — Uniswap V3 の価格制限に当たった",
};

/// 読めなかった取り消しの中身を、人が読める形にする。
/// **分からない時も、必ずセレクタを残す。** それが次の手掛かりになる。
function describeRevert(revertData) {
  if (typeof revertData !== "string" || !revertData.startsWith("0x") || revertData.length < 10) {
    return null;
  }
  const selector = revertData.slice(0, 10).toLowerCase();
  const known = REVERT_SELECTORS[selector];
  if (known) return `${selector} = ${known}`;
  return `${selector}(照合表に無い。データ${revertData.length - 2}文字)`;
}

/// コントラクトに経路を最後まで回させて、戻ってきた量と返済額を受け取る。
/// 戻り値: { returned, owed } または { error: 拒否理由 }
/// 確認の本体。blockTag を指定して1回だけ問い合わせる。
async function simulateAt(chain, contractAddress, from, data, iface, blockTag) {
  try {
    await callWithRpc(chain, (p) => p.call({ to: contractAddress, from, data, blockTag }), true);
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
    const described = describeRevert(revertData);
    const base = (e?.shortMessage || e?.reason || e?.message || "").slice(0, 160);
    // **読めなかった中身を捨てない。** セレクタが原因究明の唯一の手掛かり。
    return {
      error: described ? `${base} / 取り消しの中身: ${described}` : base,
      revertSelector: described,
      raw: e,
    };
  }
}

/// 「revert の中身が返ってこなかった」を表す誤り。
///
/// この確認は**わざと revert させて結果を受け取る**作りなので、revert の中身
/// (SimulationResult)が返らないと何も分からない。端点やブロックの指定によっては
/// 中身が落ちることがある。
/// **狭く判定する。** 本物の revert(理由つき)で聞き直すと、無駄な問い合わせが
/// 増えるだけで何も分からない。実際に見た症状だけを対象にする。
function isMissingRevertData(msg) {
  return (msg || "").toLowerCase().includes("missing revert data");
}

async function simulate(chain, contractAddress, from, asset, amountIn, legArgs, iface) {
  const data = iface.encodeFunctionData("simulateRoute", [asset, amountIn, legArgs]);
  const preferred = simulateBlockTag.get(chain) || readBlockTag(chain);
  const first = await simulateAt(chain, contractAddress, from, data, iface, preferred);
  if (!first.error) return first;

  // [2026年9月21日に追加]
  // Base を pending で読むようにした直後、確認が3件続けて
  // 「missing revert data」で失敗した(いずれも純利益 +$0.36〜+$0.49 という、
  // 今までの50倍の機会)。原因が「コントラクトが旧版だから」なのか
  // 「pending ブロックでは revert の中身が返らない端点だから」なのかを、
  // 推測ではなく**実測で切り分ける**。
  // pending で中身が返らなかった時だけ latest で聞き直し、返ればそのチェーンは
  // 以降 latest を使う(判定に使った状態とは少しずれるが、確認できない方が悪い)。
  if (preferred === "pending" && isMissingRevertData(first.error)) {
    const retry = await simulateAt(chain, contractAddress, from, data, iface, "latest");
    if (!retry.error) {
      simulateBlockTag.set(chain, "latest");
      console.log(`[実行] ${chain}: pending では revert の中身が返りませんでした。latest で確認できたので、以降このチェーンは latest で確認します`);
      return retry;
    }
    return { error: `${first.error}(latest でも同じ: ${retry.error})` };
  }
  return first;
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

  // 判定してから今までに、プール地図の上で経路がどれだけ動いたかを測る。
  //
  // [なぜ測るか(2026年9月20日)]
  // 答え合わせで avalanche の3段目が −190.0bps と出た時、内訳は
  // 「判定後に地図が −190.0bps / 地図とチェーンの差 0.0bps」だった。
  // 地図は正確で、古かったのは**経路が写し取った準備量の方**。つまり
  // 送信直前の確認(eth_call)を使わなくても、地図を見るだけで
  // 「もう消えている機会」が分かる可能性がある。まずRPCを一切使わずに
  // どれくらい動いているかを記録し、値が揃ってから足切りを入れるか決める。
  try {
    const revalued = revalueRouteFromMap(opp);
    if (revalued && opp.amountOutEstimated > 0n) {
      const driftBps = Number(((revalued.amountOut - opp.amountOutEstimated) * 10000n) / opp.amountOutEstimated);
      if (Math.abs(driftBps) >= DRIFT_MIN_BPS) {
        const owed = opp.amountOwed || opp.amountIn; // 見込みと同じ投入額で比べる
        const stillPlus = revalued.amountOut > owed;
        console.log(`[判定からの動き] ${chain} ${opp.label}: 地図の上で${driftBps >= 0 ? "+" : ""}${driftBps.toFixed(1)}bps 動いた(今の地図では${stillPlus ? "まだ黒字" : "もう赤字"}。RPCは使っていない)`);
      }
    }
  } catch (e) {}

  // 1. 結果の問い合わせと、ガス量の見積もりを**同時に**投げる。
  //
  // [なぜ同時にするか(2026年9月21日)]
  // 実測のループは Flashblocks の取得200ms + 確認85〜170ms + 準備177〜620ms で
  // 合計600〜800ms。Flashblock は200msごとに配られるので、**3〜4個ぶん遅れて**
  // 撃っていることになる。先読みで1秒早く見えている優位を、自分で食い潰していた。
  //
  // 確認(eth_call)とガス量の見積もり(eth_estimateGas)は、どちらも
  // 「今の状態でこの取引を実行したらどうなるか」を聞いている。順番に待つ
  // 理由は「見積もりに minProfit が要る」からだけで、その minProfit は
  // **ガス量をほとんど変えない**(比較が1回増えるだけ)。見積もりだけ
  // minProfit=0 で先に投げれば、1往復まるごと(85〜170ms)削れる。
  //
  // 安全性は落とさない。送信の可否は今までどおり確認(sim)の結果で決め、
  // 実際に送る時の minProfit も今までどおり確認の結果から作る。
  const simPromise = simulate(chain, contractAddress, wallet.address, asset, amountIn, legArgs, contractVersion.iface);
  const contract = new ethers.Contract(contractAddress, contractVersion.abi, signer);
  // 失敗しても Promise.all を倒さないように包む(確認の失敗の方を先に報せたい)。
  const gasPromise = estimateGasUnits(chain, contract, wallet.address, contractAddress, asset, amountIn, legArgs)
    .then((v) => ({ ok: true, value: v }))
    .catch((e) => ({ ok: false, error: e }));

  const [sim, gasResult] = await Promise.all([simPromise, gasPromise]);
  const simMs = Date.now() - startedAt;

  if (sim.error) {
    const msg = sim.error;
    if (isKRevert(msg)) {
      // **1回で手数料の前提を外す。** 赤字(利益が足りない)は「惜しかった」の
      // 可能性があるので2回待つが、K検算での拒否は**こちらの計算が
      // 物理的に不可能な量を出した証拠**なので、待つ理由が無い。
      forceFeeReprobe(opp, "K検算で拒否(受取量が多すぎる)");
      markRouteRejected(opp);
      throw new ExecutionError(`V2の手数料の前提が実際より低い(K検算で拒否): ${msg.slice(0, 120)}`, { reverted: true, stage: "feeMismatch" });
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
  // ガス量は上で確認と同時に投げてある。ここでは結果を受け取るだけ。
  if (!gasResult.ok) {
    const e = gasResult.error;
    const msg = (e?.shortMessage || e?.message || "").slice(0, 160);
    markRouteRejected(opp);
    throw new ExecutionError(`確認後に状況が変わり拒否: ${msg}`, { reverted: true, staleReserves: true, stage: "estimateGas" });
  }
  const gasUnits = gasResult.value;
  // 上限(gasLimit)には余裕を持たせるが、**費用の見積もりには使わない**。
  // EVMは使わなかったガスを請求しないので、払うのは gasUnits の分だけ。
  // 余裕の20%をそのまま費用に足していたため、見積もりが2割過大になり、
  // その分ハードルが上がって本物の機会を捨てていた(2026年9月19日に修正)。
  const gasWithBuffer = (gasUnits * 120n) / 100n;
  // OP Stack(Optimism / Base)の L1 データ手数料。
  //
  // [1件ごとに聞くのをやめた(2026年9月21日)]
  // 以前は送信のたびに GasPriceOracle に聞いていたが、**1往復(約100ms)かけて
  // 測っている額が $0.000003** だった(2026年9月20日の実測)。Optimism の
  // ガス代$0.005 に対して 0.06% で、判定には何の影響もない。
  // 一方その100msは、Flashblock の半個ぶんの遅れになる。
  // 代表値(受領証から学んだ実測の平均。recordActualL1Fee が更新している)で
  // 十分なので、そちらに任せて1往復まるごと削る。
  // gasUnitsToUsd は l1FeeWei に null を渡すと getTypicalL1FeeWei を使う。
  const l1FeeWei = null;
  const measuredGasUsd = await gasUnitsToUsd(chain, gasUnits, l1FeeWei);
  if (measuredGasUsd != null) gasCostUsd = measuredGasUsd;

  // 実測のガス代でもう一度、下限を確かめる(2026年9月21日に追加)。
  //
  // [なぜ要るか(本番で赤字を送った)]
  // 上の下限の確認は「そのチェーン・その段数の典型的なガス量」で行っている。
  // その後に eth_estimateGas でこの経路の実際のガス量が分かり、gasCostUsd を
  // 置き換えるが、**置き換えた後に確かめ直していなかった**。
  // 2026年9月21日 00:03 UTC、polygon の2件がこの隙間を通った:
  //   sync発見→algebra-a  粗利$0.0122 に対し実測ガス$0.0173 → 送信 → 純利 -$0.0065
  //   polyzap→algebra-a   粗利$0.0117 に対し実測ガス$0.0181 → 送信 → 純利 -$0.0064
  // ログの「送信します」の行には既に 粗利 < ガス が書かれていた。
  // 最低利益を $0.005 から $0.002 に下げたことで、典型値と実測値の差を
  // 吸収していた余裕が無くなり、隙間が表に出た。
  {
    const netAfterMeasured = grossProfitUsd - gasCostUsd;
    if (netAfterMeasured < MIN_PROFIT_USD) {
      markRouteRejected(opp);
      opp.sendResult = "below_gas";
      console.log(`[実行] ${opp.label}: 実測のガス代$${gasCostUsd.toFixed(4)}(典型値の見積もりより高い)を引くと純利$${netAfterMeasured.toFixed(4)}で下限未満のため見送り(粗利$${grossProfitUsd.toFixed(4)})`);
      return false;
    }
  }
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
  // OP Stack では receipt の l1Fee(L1 データ手数料)も払っているので足す。
  let actualGasCostUsd = null;
  let actualL1FeeUsd = null;
  try {
    let l1Wei = 0n;
    if (isOpStackChain(chain)) {
      l1Wei = await readL1FeeFromReceipt(chain, tx.hash);
      if (l1Wei > 0n) {
        recordActualL1Fee(chain, l1Wei);
        actualL1FeeUsd = await weiToUsd(chain, l1Wei);
      }
    }
    actualGasCostUsd = await weiToUsd(chain, receipt.gasUsed * receipt.gasPrice + l1Wei);
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
    const l1Note = actualL1FeeUsd != null ? `、うちL1データ$${actualL1FeeUsd.toFixed(4)}` : "";
    console.log(`[実行] 確定: 粗利+$${actualProfitUsd.toFixed(4)} − ガス$${actualGasCostUsd.toFixed(4)} = 純利益+$${actualNetProfitUsd.toFixed(4)}(見積もりガス$${gasCostUsd.toFixed(4)}${l1Note})`);
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
    actualL1FeeUsd,
    actualNetProfitUsd,
    gasUsed: receipt.gasUsed.toString(),
    gasCostUsd,
  });
  recordExecutionSuccess();
  return true;
}
