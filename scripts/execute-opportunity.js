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
import { loadState, saveState } from "./state-file.js";
import { minProfitUsd, breakEvenPriorityShare } from "./min-profit.js";
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

/// プールの責任を問う(一時除外につながる)閾値。**ログに出す閾値とは別にする。**
///
/// [なぜ分けたか(2026年9月21日の実測)]
///   一時除外[のべ1 今1 **飛ばした経路699**]   (549 → 603 → 699 と増加中)
/// **たった1つのプールのせいで699本の経路が判定を飛ばされていた。**
///
/// 責任を問う条件が `-5bps` と緩すぎた。うちの模型の誤差は普通に10〜30bps出るので、
/// **ほぼ全ての赤字経路で誰かが犯人にされていた**。しかも経路に多く現れる
/// 主要プール(WETH/USDC 等)ほど犯人になりやすい。
/// **取引が多い = 機会が多いプールから順に外していた**ことになる。
const BLAME_MIN_BPS = parseFloat(process.env.BLAME_MIN_BPS || "30");
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
function learnTrustedMaxFromDiff(chain, leg, amountIn, offDiffBps, why = "公式との差") {
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
    `投入${amountIn} で表が**${Math.abs(offDiffBps).toFixed(1)}bps 過大**(${why})。` +
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
  let worst = null;       // 表示用: いちばん差の大きかった段
  let blameWorst = null;  // 責任用: **こちらの模型が間違っていると示せた**段だけ
  // **模型の誤りの合計**(2026年9月21日、オーナーの指摘で追加)。
  //
  // [なぜ合計が要るか]
  // 記録簿の「送信直前に見送り」の上位に、base の3段V3が
  // **投入$1600 で 実測 -26.1 / -21.4 / -18.8bps** と並んでいた。
  // 別々のプールなのに同じ額で同じ幅ずれている = 価格の動きではなく**模型の誤り**。
  // ところが段ごとに割れば1段あたり6〜9bpsで、段ごとの閾値(20bps)には
  // **一度も届かない**。だから上限が一度も下がらず、同じ額で落ち続けていた。
  // **合計して初めて見える誤りがある。**
  let modelSum = 0;       // 測れた段の模型誤差の合計(bps)
  let modelKnown = 0;     // 模型誤差を測れた段の数
  let learnedAny = false; // 段ごとの学習が発動したか
  const v3Model = [];     // 合計から学ぶ時の対象(V3で公式と比べられた段)
  for (let i = 0; i < legs.length; i++) {
    if (actual[i] == null) { parts.push(`${i + 1}段目 ${legs[i].dexId}:読めず`); continue; }
    const diff = bpsDiff(expected[i].out, actual[i]);
    if (diff == null) { parts.push(`${i + 1}段目 ${legs[i].dexId}:比較不能`); continue; }
    // 自前と公式の両方が取れた段は、公式との差も並べる(一致なら価格表の古さが原因)。
    const offDiff = ownQuoted[i] && official[i] != null ? bpsDiff(expected[i].out, official[i]) : null;
    const offNote = offDiff != null ? `(公式${offDiff >= 0 ? "+" : ""}${offDiff.toFixed(1)}bps)` : "";
    // **測った誤差を、その場で表の上限に反映する。**
    try { if (learnTrustedMaxFromDiff(chain, legs[i], expected[i].in, offDiff)) learnedAny = true; } catch (e) {}
    if (offDiff != null && legs[i].kind === KIND_V3) v3Model.push({ i, leg: legs[i], bps: offDiff });
    // V2の段は、差を「判定してから地図が動いた分」と「地図とチェーンの差」に分ける。
    let splitNote = "";
    let gapBps = null;
    if (storedOut[i] != null) {
      const moved = bpsDiff(expected[i].out, storedOut[i]); // ①判定時 → ②今の地図
      const gap = bpsDiff(storedOut[i], actual[i]);         // ②今の地図 → ③チェーン
      if (moved != null && gap != null) {
        gapBps = gap;
        splitNote = `(判定後に地図が${moved >= 0 ? "+" : ""}${moved.toFixed(1)}bps / 地図とチェーンの差${gap >= 0 ? "+" : ""}${gap.toFixed(1)}bps 手数料${legs[i].feeBps}bps)`;
      }
    }
    parts.push(`${i + 1}段目 ${legs[i].dexId}(${legs[i].kind}) ${diff >= 0 ? "+" : ""}${diff.toFixed(1)}bps${offNote}${splitNote}`);
    if (worst == null || diff < worst.diff) worst = { i, diff, leg: legs[i] };

    // **責任を問うのは「こちらの模型が間違っている」と示せた段だけ。**
    //
    //   判定してから価格が動いた   → **他人が先に取った**。プールのせいではない
    //   地図とチェーンの差(gap)   → こちらの地図が古い/間違っている
    //   公式Quoterとの差(offDiff) → こちらの価格表が間違っている
    //
    // 全体の差(diff)には「価格が動いた分」が混ざるので、**責任には使わない**。
    // 「失敗」と「負け」を同じ箱に入れない(9月21日に同じ型の欠陥を1件直した)。
    const modelBps = gapBps != null ? gapBps : offDiff;
    if (modelBps != null && (blameWorst == null || modelBps < blameWorst.bps)) {
      blameWorst = { i, bps: modelBps, leg: legs[i] };
    }
    if (modelBps != null) { modelSum += modelBps; modelKnown++; }
  }
  // **合計を呼び出し側へ返す。** 記録簿が「模型の誤り」と「価格が動いた」を
  // 分けて数えられるようにする(今までどちらも「送信直前に見送り」だった)。
  opp.modelBps = modelKnown > 0 ? modelSum : null;
  if (parts.length === 0) return;
  // 表示は今までどおり「いちばん差の大きかった段」を出す(原因を探す手掛かり)。
  const note = worst && worst.diff <= -DIAGNOSE_MIN_BPS
    ? ` ← ${worst.i + 1}段目 ${worst.leg.dexId}:${worst.leg.pool.slice(0, 10)}… が最大のずれ`
    : "";
  const sumNote = modelKnown > 0
    ? ` / **模型の誤りの合計${modelSum >= 0 ? "+" : ""}${modelSum.toFixed(1)}bps**(${modelKnown}段で測定)`
    : "";
  console.log(`[段ごとの答え合わせ] ${chain} ${opp.label} 投入${opp.amountIn}: ${parts.join(" / ")}${sumNote}${note}`);

  // **段ごとでは届かない誤りを、合計で捕まえる。**
  // 段ごとの学習が一度も発動せず、合計では閾値を超えている時だけ、
  // いちばんずれていたV3の段の上限を下げる(半分にする)。
  // 誤差の原因が何であれ「その額では表を信用できない」ことは測れているので、
  // 額を抑えるのが正しい対処。定期検証が通れば上限は戻る。
  if (!learnedAny && modelKnown > 0 && modelSum <= -LEARN_CAP_BPS && v3Model.length > 0) {
    const worstV3 = v3Model.reduce((a, b) => (b.bps < a.bps ? b : a));
    try {
      learnTrustedMaxFromDiff(chain, worstV3.leg, expected[worstV3.i].in, modelSum,
        `経路全体の合計。この段は${worstV3.bps.toFixed(1)}bps`);
    } catch (e) {}
  }

  // **責任を問うのは、模型の誤りが大きいと示せた時だけ。**
  if (blameWorst && blameWorst.bps <= -BLAME_MIN_BPS) {
    console.log(`[答え合わせ/責任] ${chain} ${blameWorst.i + 1}段目 ${blameWorst.leg.dexId}:${blameWorst.leg.pool.slice(0, 10)}…: 地図が**${Math.abs(blameWorst.bps).toFixed(1)}bps**ずれている(価格の動きではない)`);
    try { notePoolBlame(chain, blameWorst.leg.pool, blameWorst.bps); } catch (e) {}
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

export function getSigner(chain, privateKey) {
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

/// 手数料の上限に取る「基準手数料の何倍」。払うのは(基準+優先)だけなので、上限を上げても
/// 支払いは増えない。上げるのは**基準手数料が急に上がった時に詰まらない**ため。
///
/// [なぜ(2026年9月23日 21:03 JST、avalanche で実測)]
/// 機会が一気に増えた(黒字263件/数分)瞬間に、nonce 0x209 の取引が上限0.295gwei のまま
/// 未確定で詰まった。ethers の既定は「基準×2 + 優先」で、基準がそれ以上に跳ねると入らない。
/// 以後の送信はすべて同じ番号で「replacement fee too low」になり、**avalanche の送信が全部止まった**。
const FEE_CAP_BASE_MULTIPLIER = BigInt(parseInt(process.env.FEE_CAP_BASE_MULTIPLIER || "4", 10));

/// 送信に使う手数料(入札しない時)。基準に余裕を持たせた上限を付ける。
/// 直近のブロックで**実際に払われた優先手数料**(中央値)。混んでいる時の下限に使う。
///
/// [なぜ(2026年9月23日 21:18 JST の実測)]
/// 詰まり解消の上書き(優先0.1gwei)は4〜6秒で確定したのに、裁定の取引(優先150wei = RPC の提案値)は
/// 20秒の制限時間内に入らず、avalanche の送信が成功0件のまま続いた。混雑時はブロックが高い入札から
/// 埋まるので、提案値のままでは入らない。直近の実績に合わせれば、空いている時は小さいままで済む。
const priorityFloorCache = new Map(); // chain -> { at, wei }
async function recentPriorityFloor(chain) {
  const c = priorityFloorCache.get(chain);
  if (c && Date.now() - c.at < 3000) return c.wei;
  let wei = 0n;
  try {
    const h = await getProviderForChain(chain).send("eth_feeHistory", ["0x5", "latest", [50]]);
    const rewards = (h?.reward || []).map((r) => BigInt(r?.[0] ?? "0x0")).filter((v) => v > 0n).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    if (rewards.length > 0) wei = rewards[Math.floor(rewards.length / 2)];
  } catch (e) {}
  priorityFloorCache.set(chain, { at: Date.now(), wei });
  return wei;
}

const feeDataCache = new Map(); // chain -> { at, fee } 送信の速さを落とさないよう2秒だけ使い回す
async function defaultFeeOverrides(chain) {
  try {
    const c = feeDataCache.get(chain);
    const fee = c && Date.now() - c.at < 2000 ? c.fee : await getProviderForChain(chain).getFeeData();
    if (!c || c.fee !== fee) feeDataCache.set(chain, { at: Date.now(), fee });
    if (fee.maxFeePerGas == null || fee.maxPriorityFeePerGas == null) return {};
    const suggested = fee.maxPriorityFeePerGas;
    const baseFee = fee.maxFeePerGas > suggested ? (fee.maxFeePerGas - suggested) / 2n : 0n;
    const floor = await recentPriorityFloor(chain);
    const priority = floor > suggested ? floor : suggested;
    const maxFee = baseFee * FEE_CAP_BASE_MULTIPLIER + priority;
    // extraPerGas は判定用(送信には渡さない)。提案値より上げた分 = ガス代の見積もりに入っていない分
    return { maxPriorityFeePerGas: priority, maxFeePerGas: maxFee > fee.maxFeePerGas ? maxFee : fee.maxFeePerGas, extraPerGas: priority - suggested };
  } catch (e) {
    return {};
  }
}

// ===== 詰まった nonce の解消 =====
/// 同じ番号の取引が未確定のまま残っていると、以後の送信は全部「replacement fee too low」で断られる。
/// その番号に**自分宛ての0円送金**を、手数料を上げて上書きし、詰まりを抜く(avalanche で1回 約$0.001)。
/// 断られるたびに優先手数料を倍にしていく(置き換えは前の取引より十分高くないと受け付けられない)。
const unstickState = new Map(); // chain -> { at, nonce, priority }
const UNSTICK_MIN_INTERVAL_MS = 15000;
const UNSTICK_MAX_PRIORITY_GWEI = parseFloat(process.env.UNSTICK_MAX_PRIORITY_GWEI || "50");

export function isStuckNonceError(message) {
  const m = String(message || "").toLowerCase();
  return m.includes("replacement fee too low") || m.includes("replacement transaction underpriced");
}

export async function unstickNonce(chain) {
  const key = (chain || "").toLowerCase();
  const entry = signers.get(key);
  if (!entry) return;
  const prev = unstickState.get(key);
  if (prev && Date.now() - prev.at < UNSTICK_MIN_INTERVAL_MS) return;
  const st = { at: Date.now(), nonce: null, priority: 0n };
  unstickState.set(key, st);
  try {
    const provider = getProviderForChain(key);
    const wallet = entry.wallet;
    const [mined, pending, fee] = await Promise.all([
      provider.getTransactionCount(wallet.address, "latest"),
      provider.getTransactionCount(wallet.address, "pending"),
      provider.getFeeData(),
    ]);
    // 「未確定の取引は無い」と返っても上書きする。
    // [なぜ(2026年9月23日 21:09 JST の実測)] avalanche の公開 RPC は裏に複数のノードがあり、
    // 数を聞いたノードは「確定521 / 未確定込み521」(=詰まり無し)と答えたが、送信を受けたノードは
    // nonce 521(0x209)の古い取引を抱えていて「replacement fee too low」で断り続けた。
    // 断られたこと自体が「どこかに同じ番号の取引がある」証拠なので、数の答えより断られた事実を信じる。
    const basePriority = fee.maxPriorityFeePerGas ?? 0n;
    const baseFee = fee.maxFeePerGas != null && fee.maxFeePerGas > basePriority ? (fee.maxFeePerGas - basePriority) / 2n : 0n;
    const floor = 100_000_000n; // 0.1 gwei
    let priority = basePriority * 3n > floor ? basePriority * 3n : floor;
    // 同じ番号で前回も上書きを試していたら、その倍から始める
    if (prev && prev.nonce === mined && prev.priority > 0n) priority = prev.priority * 2n > priority ? prev.priority * 2n : priority;
    const cap = BigInt(Math.floor(UNSTICK_MAX_PRIORITY_GWEI * 1e9));
    if (priority > cap) priority = cap;
    const maxFee = baseFee * FEE_CAP_BASE_MULTIPLIER + priority;
    st.nonce = mined;
    st.priority = priority;
    console.warn(`[詰まり解消] ${key}: nonce ${mined} が同じ番号の古い取引に阻まれています(RPC の答え: 確定${mined} / 未確定込み${pending})。自分宛て0円で上書きします(優先${(Number(priority) / 1e9).toFixed(3)}gwei 上限${(Number(maxFee) / 1e9).toFixed(3)}gwei)`);
    const tx = await wallet.sendTransaction({ to: wallet.address, value: 0n, nonce: mined, gasLimit: 21000n, maxPriorityFeePerGas: priority, maxFeePerGas: maxFee });
    console.warn(`[詰まり解消] ${key}: 上書きを送信 ${tx.hash}`);
    const rc = await tx.wait(1, 60_000).catch(() => null);
    resetNonce(key);
    console.warn(`[詰まり解消] ${key}: ${rc ? `確定(ブロック${rc.blockNumber})。送信を再開できます` : "60秒以内に確定せず。次に断られた時にもう一段上げて試します"}`);
  } catch (e) {
    resetNonce(key);
    console.warn(`[詰まり解消] ${key}: 失敗 ${(e.message || "").slice(0, 120)}`);
  }
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

// 最低利益は**チェーンごと**(ガス代が25倍違うため。scripts/min-profit.js)。
export const TAX_TOKEN_FEE_BPS = parseInt(process.env.TAX_TOKEN_FEE_BPS || "100", 10);
/// コントラクトに渡す最低利益の、**取り消しが得になる境目**。
///
/// [「確認した利益の50%」をやめた(2026年9月21日、polygon の赤字の本当の原因)]
/// 今までは `minProfit = 確認した利益 × 50%` だった。つまり送信から確定までに
/// 利益が半分以上削られた瞬間に**取り消し**になり、**ガス代を満額失う**。
///
/// ところが、**取り消しても実行してもガス代はほぼ同じ**。
/// コントラクトの取り消しは**全部の段を回した後**(`returned >= owed + minProfit`)に
/// 起きるので、swap のガスは全部払い済み。実行の方が最後の送金と記録のぶんだけ
/// 約9%高いだけ。
///
///   実行した方が得 ⟺ 残った利益 > ガス代 × (1 − 取り消し時のガス比率)
///                  ≒ 残った利益 > ガス代 × 10%
///
/// polygon(ガス$0.0123)なら境目は**$0.0012**。それ以上の利益が残るなら、
/// 半分削られていようが**実行した方が損が小さい**。
/// 50%という余裕は、**守っているつもりで損を増やしていた**。
///
/// この値より小さい利益しか残らない時だけ、取り消す(その時は取り消しの方が安い)。
const REVERT_GAS_SHARE = parseFloat(process.env.REVERT_GAS_SHARE || "0.10");
/// ガス代か粗利が分からない時に使う割合(bps)。**昔の50%ではなく小さめ。**
const MIN_PROFIT_SHARE_BPS = BigInt(parseInt(process.env.MIN_PROFIT_SHARE_BPS || "500", 10));

/// 送信時にコントラクトへ渡す最低利益を決める。
/// **通貨の桁数で割らずに、粗利に対する比で出す**(18桁の割り算で精度を失わないため)。
function decideMinProfit(profitRaw, grossProfitUsd, gasCostUsd) {
  if (!(profitRaw > 0n)) return 0n;
  const gas = Number(gasCostUsd), gross = Number(grossProfitUsd);
  if (!Number.isFinite(gas) || !Number.isFinite(gross) || gas <= 0 || gross <= 0) {
    return (profitRaw * MIN_PROFIT_SHARE_BPS) / 10000n;
  }
  const floorUsd = gas * REVERT_GAS_SHARE;
  // 粗利に対する比(bps)。0〜10000 に収める(粗利を超える要求はしない)。
  const bps = Math.min(10000, Math.max(0, Math.round((floorUsd / gross) * 10000)));
  return (profitRaw * BigInt(bps)) / 10000n;
}

// ===== 優先手数料の入札(2026年9月22日、オーナーの承認を得て追加)=====
//
// [なぜ要るか]
// このボットは今まで `maxPriorityFeePerGas` を**一度も指定していなかった**。
// ethers が RPC に聞いた既定値をそのまま使っていたので、**入札に参加せず
// 定価で並んでいた**ことになる。
//
// Base と Optimism のシーケンサーは**優先手数料の高い順**に並べる(公式文書)。
// Polygon と Avalanche も単価の高い順。つまり、先を越されて取り消された
// `wait` の負け(avalanche 24 / base 6 / polygon 2 / arbitrum 1)のうち、
// いくらかは**こちらが定価で並んでいたせい**である可能性が高い。
//
// [arbitrum を外す理由(2026年9月22日に公式文書で確認し、根拠を訂正)]
// 最初に「arbitrum は到着順(FCFS)だから」と書いたが、**これは現状と違っていた**。
// arbitrum では既に **Timeboost** が動いており、順序は素のFCFSではない:
//   ・60秒ごとに**封印入札(2位価格)**で「即時レーン」の権利を1者だけが落札する
//   ・落札者の取引は即座に順序付けされ、**それ以外の取引は既定で200ms遅らされる**
// つまり我々は毎回**200msの固定ハンデ**を背負って並んでおり、
// **優先手数料をいくら積んでも順番は1つも変わらない**(順番は競売でしか買えない)。
// 結論は同じ(積まない)だが、理由は「FCFSだから速さ勝負」ではなく
// **「競売に参加しない限り構造的に勝てない」**。速さへの投資では解決しない。
//
// [上振れしない作り]
// 入札の原資は**その取引で残る純利益の一部だけ**。積んだ後にもう一度
// 「手数料負けしないか」を確かめ、割れるなら積むのをやめる。
// 赤字の取引はそもそもここまで来ないので、入札で赤字にはならない。
/// 入札に使う純利益の割合。
const PRIORITY_FEE_SHARE = parseFloat(process.env.PRIORITY_FEE_SHARE || "0.30");
/// 優先手数料を積むチェーン。**順番が手数料で決まるチェーンだけ。**
const PRIORITY_FEE_CHAINS = new Set(
  (process.env.PRIORITY_FEE_CHAINS || "base,optimism,polygon,avalanche")
    .split(",").map((c) => c.trim().toLowerCase()).filter(Boolean)
);
/// 積む単価の上限(gwei)。桁を間違えた時の歯止め。
const PRIORITY_FEE_MAX_GWEI = parseFloat(process.env.PRIORITY_FEE_MAX_GWEI || "50");

// ===== 実測の損益分岐で頭を押さえる(2026年9月22日 12:40 JST)=====
//
// [なぜ要るか(実測)]
// 一律 0.30 で1時間10分回した結果:
//   負け率      23.5% → 5.3%        (先を越される回数は狙い通り激減した)
//   1回の収支   $0.00115 → $0.00036 (**利益が69%落ちた**)
//
// 入札で取り返せるのは「今負けている分」だけで、それを超えて払うと
// **勝率が100%になっても差し引きで損**をする。その天井が損益分岐:
//
//   損益分岐 share = (1 − 勝率) × (平均利益 + 平均ガス代) ÷ 平均利益
//
// 実測(12:29 JST)は **avalanche 0.26 / polygon 0.25** で、**どちらも 0.30 未満**。
// つまり 0.30 は天井を超えて払っていた。avalanche は全勝ちの86%を稼ぐ主エンジンなので、
// ここを取りすぎるのがいちばん高くつく。
//
// [なぜ「半分」か]
// 損益分岐ちょうどに払うと、**儲けは定義上ゼロ**になる。取り分を残すため半分にする。
//
// [暴れない作り]
// ・既定(0.30)を**超えることは無い**。下げる方向にしか効かない
// ・標本が少ないうちは信用しない(勝ち10件・負け3件を下回れば既定のまま)。
//   base と optimism はまだ1勝もしていないので、ここは既定のまま残る
// ・勝率が上がると share は下がり、下がると share は戻る。累計の計数なので動きは鈍く、
//   振動しても常に「損益分岐の半分以下」に留まる
/// **元に戻すスイッチ。** `PRIORITY_FEE_AUTO_CAP=false` で頭押さえを切り、
/// 従来どおり全チェーン一律 `PRIORITY_FEE_SHARE` に戻る(再デプロイ不要)。
const PRIORITY_FEE_AUTO_CAP = (process.env.PRIORITY_FEE_AUTO_CAP || "true").toLowerCase() !== "false";
/// 損益分岐に対して実際に使う割合。
const PRIORITY_FEE_SAFETY = parseFloat(process.env.PRIORITY_FEE_SAFETY || "0.5");
/// この件数に満たないチェーンでは損益分岐を信用せず、既定の share を使う。
const PRIORITY_FEE_MIN_WINS = parseInt(process.env.PRIORITY_FEE_MIN_WINS || "10", 10);
// 負けの件数は2件で足りることにする。**間違える向きが安いため。**
// 平均ガス代を低く見誤れば share は下がり、失うのは「取れたかもしれないレース」だけ
// (負けても失うのはガス代)。高く見誤っても既定の0.30で頭が止まる。
// 3件にすると polygon(18勝2負)が長く既定のまま取られ過ぎる。
const PRIORITY_FEE_MIN_LOSSES = parseInt(process.env.PRIORITY_FEE_MIN_LOSSES || "2", 10);

/// そのチェーンで実際に使う share。実測が足りなければ既定のまま。
/// **既定より大きくなることは無い。**
function priorityShareFor(chain) {
  if (!PRIORITY_FEE_AUTO_CAP) return PRIORITY_FEE_SHARE;
  const be = breakEvenPriorityShare(chain);
  if (!be) return PRIORITY_FEE_SHARE;
  if (be.wins < PRIORITY_FEE_MIN_WINS || be.losses < PRIORITY_FEE_MIN_LOSSES) return PRIORITY_FEE_SHARE;
  const capped = be.share * PRIORITY_FEE_SAFETY;
  if (!(capped > 0)) return 0;
  return capped < PRIORITY_FEE_SHARE ? capped : PRIORITY_FEE_SHARE;
}

/// その取引で積む優先手数料を決める。
/// @param availableUsd ガス代を引いた後に残る純利益(USD)
/// @param gasUnits     見積もったガス量
/// 戻り値: { maxPriorityFeePerGas, maxFeePerGas, bidUsd } / 積まないなら null
async function decidePriorityFee(chain, availableUsd, gasUnits) {
  const key = (chain || "").toLowerCase();
  if (!PRIORITY_FEE_CHAINS.has(key)) return null;
  if (!(availableUsd > 0) || !(gasUnits > 0n)) return null;
  try {
    const provider = getProviderForChain(key);
    if (!provider) return null;
    const fee = await provider.getFeeData();
    const suggestedPriority = fee.maxPriorityFeePerGas ?? 0n;
    // ethers は maxFeePerGas = baseFee×2 + priority で作る。そこから baseFee を戻す。
    const baseFee = (fee.maxFeePerGas != null && fee.maxFeePerGas > suggestedPriority)
      ? (fee.maxFeePerGas - suggestedPriority) / 2n
      : 0n;
    // 入札の土台は「提案値」と「直近のブロックで実際に払われた中央値」の大きい方
    const recentFloor = await recentPriorityFloor(key);
    const basePriority = recentFloor > suggestedPriority ? recentFloor : suggestedPriority;

    // 1トークンのUSD価格(weiToUsd に 1e18 を渡すとそのまま出る)。
    const oneTokenUsd = await weiToUsd(key, 10n ** 18n);
    if (!(oneTokenUsd > 0)) return null;

    const share = priorityShareFor(key);
    if (!(share > 0)) return null;
    const budgetUsd = availableUsd * share;
    const budgetWei = BigInt(Math.floor((budgetUsd / oneTokenUsd) * 1e18));
    if (budgetWei <= 0n) return null;
    let extraPerGas = budgetWei / gasUnits;
    const capWei = BigInt(Math.floor(PRIORITY_FEE_MAX_GWEI * 1e9));
    if (extraPerGas > capWei) extraPerGas = capWei;
    if (extraPerGas <= 0n) return null;

    const priority = basePriority + extraPerGas;
    // 上限は「baseFee×FEE_CAP_BASE_MULTIPLIER + 優先」。ただし baseFee を戻せなかった時に
    // **基準額を下回って拒否される**ので、ethers が出した上限に積んだ分を
    // 足した値とを比べて、**大きい方**を使う。
    const fromBase = baseFee * FEE_CAP_BASE_MULTIPLIER + priority;
    const fromEthers = (fee.maxFeePerGas ?? 0n) + extraPerGas;
    const maxFee = fromBase > fromEthers ? fromBase : fromEthers;
    if (maxFee < priority) return null; // 念のため(上限が優先より低いと送れない)
    const bidUsd = (await weiToUsd(key, extraPerGas * gasUnits)) ?? 0;
    return { maxPriorityFeePerGas: priority, maxFeePerGas: maxFee, bidUsd, extraPerGas, share };
  } catch (e) {
    return null;
  }
}

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
/// **実際に送ってよいチェーン。** 空なら全チェーン(既定=今までどおり)。
///
/// [なぜ要るか(2026年9月22日、オーナーの指摘)]
/// 実測で**一度も勝っていないのに送り続けているチェーン**があった:
///   base     0勝6負 −$0.0300
///   arbitrum 0勝1負 −$0.0157
/// 合計 −$0.0457。同じ期間の粗利が +$0.2827 なので、**稼ぎの16%をここで捨てていた**。
/// 「まだ標本が少ない」と言って放置したのは私の判断ミス。0勝7負は
/// 「勝てるかどうか分からない」ではなく、**勝っていないという実測**。
///
/// 止めるのは**送信だけ**。監視は続けるので、勝てるようになったかは
/// `[実行] 送信しない` の行で分かる(そこが黒字続きなら再開を検討する)。
const SEND_CHAINS = (process.env.SEND_CHAINS || "")
  .split(",").map((c) => c.trim().toLowerCase()).filter(Boolean);

/// チェーンごとの「送らなかった回数」。判断材料として残す。
///
/// **これは再デプロイをまたいで残す。** 止めた判断が正しかったかは
/// 「止めた先でいくら見込みが出続けたか」でしか分からず、
/// 毎回ゼロに戻ると永遠に判断できない(2026年9月22日、オーナーの提案)。
const skippedByChain = new Map();

/// **送らなかった機会が「本物だったか」を、チェーンに聞いて数える(影の確認)。**
///
/// [なぜ要るか(2026年9月23日、オーナーの承認)]
/// 送信停止中の見込みは base 216回 $8.88 / optimism 239回 $4.78 まで積み上がったが、
/// これは**模型の値だけ**。大物の実測では模型の見込みは「試した10件中 本物0件」だった。
/// チェーンに聞かない限り、**送信を再開すべきかが永久に分からない**。
///
/// 本番と同じ `simulateRoute`(eth_call)を当てるだけで、**送信しない・ガスを払わない**。
/// 赤字・拒否の時は**本番と同じ手当て**(経路の再判定停止・手数料の読み直し・段ごとの診断)をする
/// (下の shadowCheck の注記を参照。当初は何もしなかったが、それでは模型が直らなかった)。
///
///   本物   … チェーン上で黒字、かつガス代を引いても下限以上 = 送っていれば取れた見込み
///   ガス負け … チェーン上で黒字だがガス代を引くと下限未満
///   赤字   … チェーン上の計算で赤字(模型の幻)
///   拒否   … 確認そのものが revert(K検算・税・状態の変化など)
///
/// ただし「本物」でも**競争に勝てたかは別**(先越されは送らないと分からない)。上限の目安。
const SHADOW_KEYS = ["tried", "real", "realUsd", "gasLoss", "loss", "rejected", "errors"];
function newSkipEntry() {
  return { n: 0, usd: 0, tried: 0, real: 0, realUsd: 0, gasLoss: 0, loss: 0, rejected: 0, errors: 0 };
}
/// RPC の枠を守るため、チェーンごとにこの間隔より詰めて聞かない。
const SHADOW_MIN_INTERVAL_MS = parseInt(process.env.SEND_SHADOW_MIN_INTERVAL_MS || "15000", 10);
const SHADOW_ENABLED = process.env.SEND_SHADOW !== "false";
const shadowLastAt = new Map();
const shadowInFlight = new Set();

async function shadowCheck(opp) {
  const chain = opp.chain;
  const entry = skippedByChain.get(chain);
  if (!entry) return;
  const chainConfig = getChainConfig(chain);
  const contractAddress = chainConfig && process.env[chainConfig.contractAddressEnvVar];
  const privateKey = process.env.MAINNET_BOT_PRIVATE_KEY;
  // simulateRoute は onlyOwner なので、所有者の住所で聞く(署名も送信もしない)。
  if (!contractAddress || !privateKey) return;
  const decimals = getTokenDecimals(chain, opp.tokenA);
  const priceUsd = getTokenPriceUsd(chain, opp.tokenA);
  if (decimals == null || !priceUsd) return;

  // 投入額は本番と同じ扱い(上限で頭を押さえる)。
  const capUsd = getCurrentTradeCapUsd();
  let amountIn = opp.amountIn;
  if (opp.tradeAmountUsd > capUsd) {
    amountIn = (amountIn * BigInt(Math.round((capUsd / opp.tradeAmountUsd) * 10000))) / 10000n;
  }
  if (!(amountIn > 0n)) return;

  entry.tried++;
  try {
    const { wallet } = getSigner(chain, privateKey);
    const version = await detectContractVersion(chain, contractAddress);
    const legArgs = buildLegArgs(chain, opp, version.version);
    const sim = await simulate(chain, contractAddress, wallet.address,
      ethers.getAddress(opp.tokenA), amountIn, legArgs, version.iface);
    // **赤字・拒否は、本番と同じ手当てをする**(2026年9月23日に変更)。
    //
    // [なぜ(オーナーの指示で base の模型のずれを調べて判明)]
    // 模型を直す仕組み — K検算の拒否で手数料を読み直す / 赤字なら段ごとに診断して
    // 価格表の信用上限を下げ、プールに責任を付ける / 経路を「プールが動くまで再判定しない」 —
    // は**全部、送信した時にしか動かない**。送信を止めた base では模型が
    // **間違ったまま固まり**、同じ幻の経路が何百回も「黒字」と出続けていた
    // (`uniswap-v3(0.30%)→aerodrome→uniswap-v3(0.05%)` が15分で $0.0001→$0.0387 と育つ等)。
    // 当初は「本番の状態を変えない」としたが、それでは**直らないまま数え続ける**だけだった。
    // 手当ての対象はこの経路とそのプールだけで、送ってよいチェーンには影響しない。
    if (sim.error) {
      entry.rejected++;
      if (isKRevert(sim.error)) forceFeeReprobe(opp, "影の確認でK検算に拒否(受取量が多すぎる)");
      markRouteRejected(opp);
      return;
    }
    const profitRaw = sim.returned - sim.owed;
    if (profitRaw <= 0n) {
      entry.loss++;
      markRouteRejected(opp);
      if (opp.hasV3) clearV3TablesOfRoute(chain, opp);
      // **どの段が嘘をついていたかを名指しする**(本番と同じ `[段ごとの答え合わせ]` の行が出る)。
      try { await diagnoseRejectedRoute(chain, contractAddress, opp); } catch (e) {}
      return;
    }
    const grossUsd = (Number(profitRaw) / Math.pow(10, decimals)) * priceUsd;
    const gasUsd = await estimateGasCostUsd(chain, opp.kind);
    const netUsd = grossUsd - gasUsd;
    if (netUsd < minProfitUsd()) { entry.gasLoss++; return; }
    entry.real++;
    entry.realUsd += netUsd;
    console.log(`[影の確認] ${chain} ${opp.label}: **本物** 純利$${netUsd.toFixed(4)}`
      + `(模型の見込み$${(Number(opp.netProfitUsd) || 0).toFixed(4)} / ガス$${gasUsd.toFixed(4)})。送信停止中なので送らない`);
  } catch (e) {
    entry.errors++;
  } finally {
    persistSkips();
  }
}

const SKIP_STATE_NAME = "send-skips.json";
const SKIP_STATE_VERSION = 1;
const SKIP_SAVE_MIN_MS = 60 * 1000;
let skipLastSavedAt = 0;
let skipPendingSave = null;

(function restoreSkips() {
  const d = loadState(SKIP_STATE_NAME, SKIP_STATE_VERSION);
  if (!d) return;
  for (const [chain, v] of Object.entries(d)) {
    const n = Number(v?.n), usd = Number(v?.usd);
    if (!Number.isFinite(n) || !Number.isFinite(usd)) continue;
    const e = newSkipEntry();
    e.n = n; e.usd = usd;
    // 影の確認の集計(2026年9月23日に追加)。無い古い記録は0から。
    for (const k of SHADOW_KEYS) if (Number.isFinite(Number(v?.[k]))) e[k] = Number(v[k]);
    skippedByChain.set(chain, e);
  }
  if (skippedByChain.size > 0) {
    const total = [...skippedByChain.values()].reduce((a, v) => a + v.n, 0);
    console.log(`[実行] 送信停止の記録 ${total}件 を読み戻しました`);
  }
})();

function persistSkips() {
  if (Date.now() - skipLastSavedAt < SKIP_SAVE_MIN_MS) {
    if (!skipPendingSave) {
      skipPendingSave = setTimeout(() => { skipPendingSave = null; persistSkips(); }, SKIP_SAVE_MIN_MS);
      if (typeof skipPendingSave.unref === "function") skipPendingSave.unref();
    }
    return;
  }
  if (skipPendingSave) { clearTimeout(skipPendingSave); skipPendingSave = null; }
  skipLastSavedAt = Date.now();
  saveState(SKIP_STATE_NAME, SKIP_STATE_VERSION, Object.fromEntries(skippedByChain));
}

/// **今すぐ書く。** 終了の合図を受けた時に使う。
export function flushSendSkips() {
  if (skipPendingSave) { clearTimeout(skipPendingSave); skipPendingSave = null; }
  skipLastSavedAt = Date.now();
  return saveState(SKIP_STATE_NAME, SKIP_STATE_VERSION, Object.fromEntries(skippedByChain));
}

/// **連敗したら、そのチェーンの送信を自動で止める**(2026年9月23日、optimism の送信再開の準備)。
///
/// 今までは負けが続いても送り続けた(base は 0勝6負 で −$0.03 を出すまで人が止めるのを待った)。
/// 再開したチェーンで N 回続けて負けるか、このデプロイ以降の損が上限を超えたら、送信だけ止める。
/// 止めた後も**影の確認は続く**ので、本物が出続けるかは見える。再デプロイで解ける(メモリのみ)。
///
/// 既定は送信を再開したばかりのチェーンだけが対象(avalanche は負け率2〜3割が平常なので含めない)。
const AUTO_STOP_CHAINS = new Set((process.env.SEND_AUTO_STOP_CHAINS ?? "optimism,base,arbitrum")
  .split(",").map((c) => c.trim().toLowerCase()).filter(Boolean));
const AUTO_STOP_LOSSES = parseInt(process.env.SEND_AUTO_STOP_LOSSES || "5", 10);
const AUTO_STOP_USD = parseFloat(process.env.SEND_AUTO_STOP_USD || "0.10");
const chainRun = new Map(); // chain -> { streak, netUsd, wins, losses }
const autoStopped = new Map(); // chain -> 理由

export function noteChainSendResult(chain, won, usd = 0) {
  const key = String(chain || "").toLowerCase();
  if (!AUTO_STOP_CHAINS.has(key)) return;
  const r = chainRun.get(key) || { streak: 0, netUsd: 0, wins: 0, losses: 0 };
  const amount = Math.abs(Number(usd) || 0);
  if (won) { r.streak = 0; r.netUsd += amount; r.wins++; }
  else { r.streak++; r.netUsd -= amount; r.losses++; }
  chainRun.set(key, r);
  if (autoStopped.has(key)) return;
  let why = null;
  if (r.streak >= AUTO_STOP_LOSSES) why = `${r.streak}連敗`;
  else if (r.netUsd <= -AUTO_STOP_USD) why = `損が$${(-r.netUsd).toFixed(4)}に達した(上限$${AUTO_STOP_USD})`;
  if (why) {
    autoStopped.set(key, why);
    console.warn(`[送信の自動停止] **${key} の送信を止めました**: ${why}(このデプロイで ${r.wins}勝${r.losses}負 ${r.netUsd >= 0 ? "+" : ""}$${r.netUsd.toFixed(4)})。`
      + `影の確認は続けます。再開は再デプロイで`);
  }
}

export function isSendAllowed(chain) {
  if (autoStopped.has(String(chain || "").toLowerCase())) return false;
  if (SEND_CHAINS.length === 0) return true; // 未設定なら今までどおり全部送る
  return SEND_CHAINS.includes(String(chain || "").toLowerCase());
}

export function getSendSkips() { return Object.fromEntries(skippedByChain); }

export function formatSendSkipLine() {
  if (skippedByChain.size === 0 && autoStopped.size === 0) return "";
  const parts = [...skippedByChain].map(([c, v]) =>
    `${c}:${v.n}回(見込み計$${v.usd.toFixed(4)})`
    // **チェーンに聞いた結果。** 本物が出続けるなら、送信の再開を検討する材料になる。
    + (v.tried > 0
      ? `[確認${v.tried} 本物${v.real}($${v.realUsd.toFixed(4)}) ガス負け${v.gasLoss} 赤字${v.loss} 拒否${v.rejected}${v.errors ? ` 失敗${v.errors}` : ""}]`
      : ""));
  const auto = [...autoStopped].map(([c, why]) => `${c}:${why}`);
  return ` 送信停止[${parts.join(" ")}]${auto.length ? ` **自動停止[${auto.join(" ")}]**` : ""}`;
}

export async function executeOpportunity(opp) {
  // **止めているチェーンなら、ここで終わり。** 送信の手前の唯一の関所。
  if (!isSendAllowed(opp.chain)) {
    const v = skippedByChain.get(opp.chain) || newSkipEntry();
    v.n++; v.usd += Number(opp.netProfitUsd) || 0;
    skippedByChain.set(opp.chain, v);
    persistSkips();
    // **送らずに、チェーンに聞くだけ。** 待たない(判定の流れを止めない)。
    const last = shadowLastAt.get(opp.chain) || 0;
    if (SHADOW_ENABLED && !shadowInFlight.has(opp.chain) && Date.now() - last >= SHADOW_MIN_INTERVAL_MS) {
      shadowLastAt.set(opp.chain, Date.now());
      shadowInFlight.add(opp.chain);
      shadowCheck(opp).catch(() => {}).finally(() => shadowInFlight.delete(opp.chain));
    }
    opp.sendResult = "skipped_chain";
    console.log(`[実行] ${opp.chain} ${opp.label}: **送信しない**(SEND_CHAINS で停止中)`
      + ` 見込み$${(Number(opp.netProfitUsd) || 0).toFixed(4)}`);
    return false;
  }
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
  if (expectedNetUsd < minProfitUsd()) {
    markRouteRejected(opp);
    opp.sendResult = "below_gas";
    console.log(`[実行] ${opp.label}: 粗利$${grossProfitUsd.toFixed(4)}(+${profitBps.toFixed(1)}bps)がガス代$${gasCostUsd.toFixed(4)}を引くと下限未満のため見送り`);
    return false;
  }

  // 2. 送信。**取り消しの方が安くなる線**だけを最低利益にする(上の decideMinProfit)。
  const minProfit = decideMinProfit(profitRaw, grossProfitUsd, gasCostUsd);
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
    if (netAfterMeasured < minProfitUsd()) {
      markRouteRejected(opp);
      opp.sendResult = "below_gas";
      console.log(`[実行] ${opp.label}: 実測のガス代$${gasCostUsd.toFixed(4)}(典型値の見積もりより高い)を引くと純利$${netAfterMeasured.toFixed(4)}で下限未満のため見送り(粗利$${grossProfitUsd.toFixed(4)})`);
      return false;
    }
  }
  // 単価の学習に使うため、この時点の見積もり単価を控えておく。
  const estimatedGasPriceWei = await getEstimatedGasPriceWei(chain);

  // **順番を買う。** 残る純利益の一部だけを優先手数料に積む。
  // 積んだ後にもう一度「手数料負けしないか」を確かめ、割れるなら積まない。
  const { extraPerGas: floorExtraPerGas = 0n, ...feeOverrides } = await defaultFeeOverrides(chain);
  const overrides = { gasLimit: gasWithBuffer, ...feeOverrides };
  let bidNote = "";
  // 混雑で優先手数料を上げた分は、ガス代の見積もりに入っていない。上げた後も黒字かを確かめる。
  if (floorExtraPerGas > 0n) {
    const floorUsd = (await weiToUsd(chain, floorExtraPerGas * gasUnits)) ?? 0;
    if (grossProfitUsd - gasCostUsd - floorUsd < minProfitUsd()) {
      markRouteRejected(opp);
      opp.sendResult = "below_gas";
      console.log(`[実行] ${opp.label}: 混雑で優先手数料を上げると+$${floorUsd.toFixed(4)}、純利が下限未満のため見送り(粗利$${grossProfitUsd.toFixed(4)} ガス$${gasCostUsd.toFixed(4)})`);
      return false;
    }
    gasCostUsd += floorUsd;
    bidNote = ` 混雑加算+$${floorUsd.toFixed(4)}`;
  }
  {
    const availableUsd = grossProfitUsd - gasCostUsd;
    const bid = await decidePriorityFee(chain, availableUsd, gasUnits);
    // (入札は「直近の実績」を土台に積むので、上の混雑加算と二重にはならない)
    if (bid && grossProfitUsd - gasCostUsd - bid.bidUsd >= minProfitUsd()) {
      overrides.maxPriorityFeePerGas = bid.maxPriorityFeePerGas;
      overrides.maxFeePerGas = bid.maxFeePerGas;
      // share も出す。**実測の損益分岐で頭を押さえているかを目で確認できるようにする。**
      bidNote = ` 優先+${(Number(bid.extraPerGas) / 1e9).toFixed(3)}gwei($${bid.bidUsd.toFixed(4)} share${(bid.share ?? 0).toFixed(2)})`;
    } else if (bid) {
      bidNote = " 優先なし(積むと下限割れ)";
    }
  }

  markRouteConfirmed(opp);
  opp.sendResult = "confirmed";
  const readyMs = Date.now() - startedAt;
  console.log(`[実行] ${opp.kind} ${chain} ${opp.label}: 送信します(投入$${tradeUsd.toFixed(2)} 粗利$${grossProfitUsd.toFixed(4)}/+${profitBps.toFixed(1)}bps ガス$${gasCostUsd.toFixed(4)}${bidNote} 確認${simMs}ms 準備${readyMs}ms)`);

  let tx;
  try {
    tx = await contract.executeRoute(asset, amountIn, legArgs, minProfit, overrides);
  } catch (e) {
    const msg = e.message || "";
    // 送れなかった番号が手元に残ると以降の送信が詰まるので、鎖上の値に戻す。
    resetNonce(chain);
    // 同じ番号の未確定の取引に阻まれている → 上書きして詰まりを抜く(裏で。この送信は失敗扱い)
    if (isStuckNonceError(msg)) unstickNonce(chain).catch(() => {});
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
