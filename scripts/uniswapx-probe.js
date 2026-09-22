// scripts/uniswapx-probe.js
//
// **UniswapX の「勝てたか」を、1円も賭けずに測る。**
//
// [なぜ要るか(2026年9月22日、オーナーと方針を見直して)]
// 原子的DEX裁定は実測で 1日$0.156 が天井だった。理由は構造的で、
//   ・深いプール … 価格差は同一ブロックで消えている(メインネット30件中30件が赤字)
//   ・浅いプール … 価格差は残るが$1しか入らない
// `深さ × 価格差` がほぼ一定で小さい。**裁定の利幅は競争でゼロに削られる。**
//
// 一方 **注文フローの利幅は削られない**。ユーザーは「すぐ約定すること」に対価を払うため。
// UniswapX はその注文フローに、**審査も担保も無しで**参加できる:
//   ・quoter(RFQで値段を聞かれる役) … Uniswap Labs の審査が要る
//   ・filler(注文を約定させる役)     … **permissionless。最低ステークは無い**
// しかも UniswapX の展開チェーンには polygon / avalanche / base / optimism / arbitrum が
// 含まれており、**我々が既にプール地図を持っているチェーンそのもの**。
//
// [ここで測るもの]
// 「すでに約定した注文」を公開APIから取り、**我々の経路なら同じ注文をいくらで
// 埋められたか**を計算して、実際の約定額と比べる。
//
//   我々の受取 > ユーザーへの支払い  → その差が我々の取り分。**勝てた**
//   我々の受取 < ユーザーへの支払い  → 勝てなかった
//
// **送信しない。約定もしない。ガスも元手も要らない。** 読んで計算するだけ。
// これで「作る価値があるか」が、作る前に分かる。
//
// [なぜ「約定済み」を見るのか]
// 未約定の注文を見ても、勝者がいくらで埋めたかが分からない。約定済みなら
// **答え合わせができる**。相手は実在の競争相手で、我々の実力がそのまま出る。
//
// [環境変数]
//   UNISWAPX_PROBE_CHAINS … 測るチェーン(既定は稼働中のうち UniswapX 対応のもの)
//   UNISWAPX_PROBE_INTERVAL_MS … 取りに行く間隔(既定5分)
//   UNISWAPX_PROBE_LIMIT  … 1回に取る注文数(既定20、APIの上限は50)

import { bestOutputFor } from "./opportunity-scanner.js";
import { extractSwap, readFilledAt, FILLED_AT_KEYS, splitByAge, resolveOpenOrder } from "./uniswapx-parse.js";
import { getTokenDecimals, getTokenPriceUsd, KIND_V3 } from "./pool-registry.js";
import { getKnownTokens, toWrappedToken, isNativeToken } from "./borrowable-tokens.js";
import { quoteV3ByPoolBatch } from "./multicall-reserves.js";
import { getAnyChainConfig } from "../chain-config.js";
import { loadState, saveState } from "./state-file.js";
import { getProviderForChain } from "./onchain-reserves.js";
import { estimateGasCostUsd } from "./gas-cost.js";

/// UniswapX の公開API。**鍵は要らない**(注文の取得は誰でもできる)。
const API_BASE = process.env.UNISWAPX_API_BASE || "https://api.uniswap.org/v2";

/// chainId は UniswapX 側の指定。我々のチェーン名と対応づける。
const CHAIN_IDS = {
  ethereum: 1, optimism: 10, bnb: 56, polygon: 137, base: 8453,
  arbitrum: 42161, avalanche: 43114, celo: 42220, unichain: 130,
};

const PROBE_CHAINS = (process.env.UNISWAPX_PROBE_CHAINS || "polygon,base,arbitrum,optimism,avalanche")
  .split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
export const PROBE_INTERVAL_MS = parseInt(process.env.UNISWAPX_PROBE_INTERVAL_MS || String(5 * 60 * 1000), 10);
const PROBE_LIMIT = Math.min(parseInt(process.env.UNISWAPX_PROBE_LIMIT || "20", 10), 50);
/// 1回の取得にかける時間の上限。ここで詰まると裁定側の処理が遅れるため。
const FETCH_TIMEOUT_MS = parseInt(process.env.UNISWAPX_FETCH_TIMEOUT_MS || "8000", 10);
/// **約定してからこの秒数より古い注文は数えない。**
///
/// [なぜ(2026年9月22日の見回り)]
/// 「過去の約定」と「今の我々の経路」を比べているので、その間の値動きが差に混ざる。
/// base で **模型$2.397 → チェーンで確認$2.7926** と、模型より確認の方が大きくなった。
/// 模型は V3 を x·y=k で近似する = **過大に出る側**なので、これは起こらないはず。
/// 差の出どころが実力ではなく値動きだという証拠。
///
/// 短くするほど汚染は減るが、数えられる注文も減る。まず180秒から始めて、
/// ログに出る `齢中央値` と `古すぎ` の件数を見て詰める。
const MAX_AGE_SEC = parseInt(process.env.UNISWAPX_MAX_AGE_SEC || "180", 10);
/// 同じ注文を二度数えないための記憶。
const seenOrders = new Set();
const SEEN_LIMIT = 5000;

/// チェーンごとの集計。**これが判断材料。**
const stats = new Map(); // chain -> { seen, quotable, won, lost, marginUsd, bestUsd, best }

function statFor(chain) {
  if (!stats.has(chain)) {
    stats.set(chain, { seen: 0, quotable: 0, won: 0, lost: 0, marginUsd: 0, bestUsd: 0, best: null,
      noRoute: 0, noDecimals: 0,
      // **チェーンに聞いて確かめた分。** 上の won は模型の答えでしかない。
      hadV2: 0, verifyTried: 0, verifyFailed: 0, verifiedWon: 0, verifiedLost: 0, verifiedUsd: 0,
      // **時刻でふるった分。** tooOld は値動きに汚染されるので捨てた数、
      // noTime は時刻そのものが読めなかった数(= 測れない。0でない間は結論を出さない)。
      tooOld: 0, noTime: 0, ages: [], timeKey: null,
      /// **経路が無かった通貨の組。** `${tokenIn}|${tokenOut}` -> { n, usd, tokenIn, tokenOut }
      ///
      /// [なぜ記録するか(2026年9月22日)]
      /// base は新しい注文81件のうち**68件(84%)が「経路なし」**で落ちていた。
      /// 我々のプール地図にその組が無いだけで、**UniswapX で起きていることの
      /// 16%しか見ていなかった**。だが「経路なし」と数えるだけでは
      /// **どの組を足せばよいか分からない**。組そのものを控える。
      missing: {},
      /// **別通貨の出力を含む注文**(正しく比べられないので捨てた数)。
      otherTokenOut: 0,
      /// **出力が2つ以上あった注文の数**と、見落としていた額の合計。
      /// これが大きいほど、直す前の数字は水増しされていた。
      multiOut: 0, ignoredOutUsd: 0,
      /// **ネイティブ通貨(ゼロ住所)を含んでいた注文。** 包んだ版に読み替えて扱う。
      nativeSwapped: 0,
      /// 読み替えられなかった(包んだ版が分からない)数。
      nativeUnknown: 0,
      // **約定時刻が無く、注文が作られた時刻しか無いもの。** 齢が測れないので数えない。
      createdOnly: 0,
      // **確認できた勝ちを「齢つき」で持つ。** 値動きの残りかすかどうかを、
      // これで判定する(§下の formatUniswapXReport)。
      verifiedWins: [] });
  }
  return stats.get(chain);
}

/// API から約定済みの注文を取る。失敗しても例外は投げない(裁定側を止めない)。
async function fetchFilledOrders(chain) {
  return (await fetchOrders(chain, "filled", PROBE_LIMIT)) || [];
}

/// API から注文を取る。**失敗なら null**(空の配列と区別する。
/// 募集中の注文では「一覧から消えた = 終わった」と読むので、取れなかった回に
/// 全部を「終わった」と誤判定しないため)。
async function fetchOrders(chain, status, limit) {
  const chainId = CHAIN_IDS[chain];
  if (!chainId) return null;
  const url = `${API_BASE}/orders?chainId=${chainId}&orderStatus=${status}&limit=${limit}`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: ctrl.signal, headers: { accept: "application/json" } });
    if (!res.ok) {
      console.warn(`[UniswapX計測] ${chain}: APIが${res.status}を返しました(${status})`);
      return null;
    }
    const body = await res.json();
    return Array.isArray(body?.orders) ? body.orders : null;
  } catch (e) {
    console.warn(`[UniswapX計測] ${chain}: 取得に失敗(${status}) ${(e.message || "").slice(0, 60)}`);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/// **チェーンに聞いて、その経路で本当にいくら返るかを確かめる。**
///
/// [なぜ要るか(2026年9月22日、初回計測で判明)]
/// 初回の結果で `polygon: 注文$20 に対して取り分$6.76`(= 34%)が出た。
/// **競争市場でこれはあり得ない。** 最良経路が `sync発見`(探索で見つけたV2プール)から
/// 始まっており、**準備量が古い**か**税トークン**なら我々の計算だけが大きな出力を出す。
/// 今朝の「判定+$2.65 / 実測−26bps」と同じ型で、模型を信じた結果。
///
/// [なぜ V3 だけか]
/// 自前コントラクトの `quoteV3` は**プール住所を直接渡して実際に試算させる**ので、
/// チェーン上の真実が返る(裁定側の送信直前の確認と同じ仕組み)。
/// 一方 V2 は準備量を読み直しても**税トークンを見抜けない**。
/// **見抜けないものを「確かめた」と呼ばない。** V2を含む経路は検証対象から外し、
/// 別に数える(hadV2)。
///
/// 段は順番に依存する(2段目の入力は1段目の出力)ので、まとめて1回では聞けない。
/// 2段なら2回。候補は毎回ごく少数なので費用は無視できる。
///
/// @returns 最終的な受取量 / 確かめられなければ null
async function verifyOnChain(chain, legs, amountIn) {
  const cfg = getAnyChainConfig(chain);
  const contractAddress = cfg && process.env[cfg.contractAddressEnvVar];
  if (!contractAddress) return null;
  let amount = amountIn;
  for (const leg of legs) {
    if (leg.kind !== KIND_V3) return null; // V2 を含む経路は「確かめた」と言えない
    const [out] = await quoteV3ByPoolBatch(
      chain, contractAddress, [{ pool: leg.pool, tokenIn: leg.tokenIn, amountIn: amount }], false);
    if (out == null || !(out > 0n)) return null;
    amount = out;
  }
  return amount;
}

function toUsd(chain, token, raw) {
  const dec = getTokenDecimals(chain, token);
  const price = getTokenPriceUsd(chain, token);
  if (dec == null || !(price > 0)) return null;
  return (Number(raw) / Math.pow(10, dec)) * price;
}

/// 1チェーンぶん測る。
async function probeChain(chain) {
  const orders = await fetchFilledOrders(chain);
  if (orders.length === 0) return;
  const s = statFor(chain);
  const hubs = Object.keys(getKnownTokens(chain));

  for (const order of orders) {
    const hash = order?.orderHash;
    if (!hash || seenOrders.has(hash)) continue;
    seenOrders.add(hash);
    if (seenOrders.size > SEEN_LIMIT) {
      let n = 0;
      for (const k of seenOrders) { seenOrders.delete(k); if (++n >= SEEN_LIMIT / 2) break; }
    }
    s.seen++;

    // **古い約定は捨てる。** 値動きが差に混ざって、我々の実力ではなくなるため。
    const filled = readFilledAt(order);
    if (!filled) {
      s.noTime++;
      // 一度だけ、実際のキー名をログに出す。**推測で名前を決めない**ため(§9)。
      if (s.noTime === 1) {
        console.warn(`[UniswapX計測] ${chain}: 約定時刻が読めません`
          + ` 候補[${FILLED_AT_KEYS.join(",")}] 実際のキー[${Object.keys(order || {}).join(",").slice(0, 200)}]`);
      }
      continue;
    }
    s.timeKey = filled.key;
    // **注文が作られた時刻しか無いものは、齢が測れない。**
    // 約定はそれより後なので「古すぎ」と同じ箱に入れると、本当は新しいものまで捨てたことになる。
    // 分けて数え、判断からは外す(polygon が該当。2026年9月22日)。
    if (!filled.isFillTime) { s.createdOnly++; continue; }
    const ageSec = Date.now() / 1000 - filled.sec;
    if (!(ageSec >= 0) || ageSec > MAX_AGE_SEC) { s.tooOld++; continue; }
    s.ages.push(ageSec);
    if (s.ages.length > 200) s.ages.shift();

    const swap = extractSwap(order);
    if (!swap) continue;
    // **別の通貨での出力があるものは、値段を付けられないので比べない。**
    // 無理に比べると、その出力を**タダでもらえる前提**になって水増しになる。
    if (swap.otherTokenOutputs > 0) { s.otherTokenOut++; continue; }
    if (swap.outputCount > 1) {
      s.multiOut++;
      // 直す前はここを見落としていた。どれだけ水増しされていたかを控える。
      const missed = toUsd(chain, toWrappedToken(chain, swap.tokenOut) || swap.tokenOut, swap.amountOut - swap.mainOnlyOut);
      if (missed != null) s.ignoredOutUsd += missed;
    }

    // **ネイティブ通貨(ゼロ住所)は、包んだ版に読み替える。**
    //
    // [2026年9月22日] UniswapX は出力にネイティブ ETH を指定できる。その時の住所は
    // ゼロ住所で、我々の地図には WETH しか無い。読み替えないと
    // **`USDC → ETH`(base でいちばん多い取引)を1件も見られない**。
    // 経路なしの筆頭が $25,266ぶん(6件)の `USDC → 0x0000…` だった。
    //
    // 桁は同じ(ETH も WETH も18桁)なので、金額はそのまま比べられる。
    // **ただし実際に約定させる時は WETH を ETH に戻す手間がかかる**(ガスが少し増える)。
    const hadNative = isNativeToken(swap.tokenIn) || isNativeToken(swap.tokenOut);
    const tokenIn = toWrappedToken(chain, swap.tokenIn);
    const tokenOut = toWrappedToken(chain, swap.tokenOut);
    if (tokenIn == null || tokenOut == null) { s.nativeUnknown++; continue; }
    // 読み替えた結果、同じ通貨どうしになったら扱わない(ETH↔WETH のラップ)。
    if (tokenIn === tokenOut) continue;
    if (hadNative) s.nativeSwapped++;

    // 我々の経路なら、同じ投入額で何が返るか。
    const mine = bestOutputFor({
      chain, tokenIn, tokenOut, amountIn: swap.amountIn, hubTokens: hubs,
    });
    if (!mine) {
      s.noRoute++;
      // **足りない組を控える。** 件数と注文額の両方を持つ
      //(1件$5,000の組と、100件$1の組は、足す価値が違う)。
      // **控えるのは読み替え後の住所。** ゼロ住所のまま控えると、
      // ファクトリーに「存在しないプール」を聞きに行き続けることになる。
      const k = `${tokenIn}|${tokenOut}`;
      const m = s.missing[k] || { n: 0, usd: 0, tokenIn, tokenOut };
      m.n++;
      const inUsd = toUsd(chain, tokenIn, swap.amountIn);
      if (inUsd != null) m.usd += inUsd;
      s.missing[k] = m;
      continue;
    }

    // 差額をUSDにする。出力通貨の桁数と価格が無ければ数えない。
    const diffUsd = toUsd(chain, tokenOut, mine.amountOut - swap.amountOut);
    if (diffUsd == null) { s.noDecimals++; continue; }
    s.quotable++;

    if (diffUsd <= 0) { s.lost++; continue; }

    // ここまでは**模型の答え**。初回計測で34%という有り得ない値が出たので、
    // これだけでは「勝てた」と数えない。
    s.won++;
    s.marginUsd += diffUsd;

    // **チェーンに聞いて確かめる。** V2 を含む経路は確かめようがないので別に数える。
    if (mine.legs.some((l) => l.kind !== KIND_V3)) { s.hadV2++; continue; }
    s.verifyTried++;
    let trueOut = null;
    try {
      trueOut = await verifyOnChain(chain, mine.legs, swap.amountIn);
    } catch (e) { /* 確かめられなければ数えないだけ */ }
    if (trueOut == null) { s.verifyFailed++; continue; }

    const trueDiffUsd = toUsd(chain, tokenOut, trueOut - swap.amountOut);
    if (trueDiffUsd == null) { s.verifyFailed++; continue; }
    if (trueDiffUsd > 0) {
      s.verifiedWon++;
      s.verifiedUsd += trueDiffUsd;
      // **齢と一緒に残す。** 「取り分」が値動きの残りかすなら、
      // 齢が0に近づくほど取り分も0に近づくはず。それを後で見る。
      s.verifiedWins.push({ ageSec, usd: trueDiffUsd,
        sizeUsd: toUsd(chain, tokenIn, swap.amountIn) });
      if (s.verifiedWins.length > 500) s.verifiedWins.shift();
      if (trueDiffUsd > s.bestUsd) {
        s.bestUsd = trueDiffUsd;
        s.best = { hash, label: mine.label, sizeUsd: toUsd(chain, tokenIn, swap.amountIn),
          modelUsd: diffUsd };
      }
    } else {
      s.verifiedLost++;
    }
  }
}

// ===========================================================================
// **募集中の注文を、今の価格で値付けする。**(2026年9月23日、オーナー了承)
//
// [なぜ(約定済みの計測の弱点)]
// 約定済みの注文と「今の経路」を比べると、約定から今までの値動きが取り分に混ざる。
// 齢で割って見分ける仕組みも入れたが、若い注文は2時間で1件ほどしか増えず、結論まで
// 何日もかかる。polygon(約定時刻が無い)と avalanche(全部古すぎる)は測れてすらいない。
//
// 募集中の注文なら**今の注文と今の価格**を比べるので、値動きは原理的に混ざらない。
// 埋める側が見る条件そのもの。**注文は出さない。約定もしない。**
//
// [数え方]
// 同じ注文を、一覧から消えるまで毎回値付けし直す(ダッチオークションは時間とともに
// 埋める側に有利になるので、最初に見た時だけでは「待てば黒字になった」を取りこぼす)。
// 一覧から消えた時点で、1件につき1回だけ結末を数える:
//   勝ち        … 募集中のうちに、**チェーンで確かめて**ガス代の概算を引いても黒字になった
//   負け        … 値付けはできたが、消えるまで一度も黒字にならなかった(= 他の誰かの方が安く埋めた)
//   値付けできず … 経路なし・独占中のまま終わった、など(理由ごとに数える)
// 勝ちについては「黒字を見てから一覧から消えるまで何秒あったか」も控える。
// これが短いほど、速さの勝負になる。
//
// [注意]
//   ・Priority 型(base)は入札ゼロの時の額で比べるので**取り分の上限**。別に数える
//   ・Dutch_V3 のガス単価による補正(adjustmentPerGweiBaseFee)は公式SDKの resolve も
//     入れていないので入れていない
//   ・ガス代は裁定の2段/3段の概算を流用している(Reactor の分は含まない)。**概算**

export const OPEN_INTERVAL_MS = parseInt(process.env.UNISWAPX_OPEN_INTERVAL_MS || "20000", 10);
/// 1回に取る募集中の注文の数(APIの上限は50)。
const OPEN_LIMIT = 50;
/// 一覧が上限いっぱいで返ってきた時は「消えた = 終わった」と言えないので、
/// この時間見えなければ終わったとみなす。
const OPEN_FORGET_MS = 10 * 60 * 1000;
const OPEN_TRACK_LIMIT = 5000;

/// 募集中の注文ごとの状態。hash -> { chain, firstSeen, lastSeen, priced, reason, win }
const tracked = new Map();
/// チェーンごとの集計。
const openStats = new Map();

function openStatFor(chain) {
  if (!openStats.has(chain)) {
    openStats.set(chain, {
      polls: 0, pollFailed: 0, seen: 0,
      won: 0, lost: 0,
      /// 値付けできずに終わった理由ごとの件数
      unpriced: {},
      /// 勝ちの取り分(チェーンで確認、ガス代の概算を引く前 / 引いた後)
      grossUsd: 0, netUsd: 0,
      /// Priority 型の勝ち(上限)の件数
      upperWins: 0,
      /// 勝ちの記録 { usd, net, bps, sizeUsd, heldSec, upper }
      wins: [],
      bestNet: 0, best: null,
    });
  }
  return openStats.get(chain);
}

function median(list) {
  if (list.length === 0) return null;
  const a = [...list].sort((x, y) => x - y);
  return a[Math.floor(a.length / 2)];
}

/// 一覧から消えた注文の結末を数える。
function finalizeOpen(hash, t) {
  tracked.delete(hash);
  const s = openStatFor(t.chain);
  if (t.win) {
    s.won++;
    s.grossUsd += t.win.usd;
    if (t.win.net != null) s.netUsd += t.win.net;
    if (t.win.upper) s.upperWins++;
    s.wins.push({ ...t.win, heldSec: Math.max(0, (t.lastSeen - t.win.at) / 1000) });
    if (s.wins.length > 500) s.wins.shift();
    const net = t.win.net ?? t.win.usd;
    if (net > s.bestNet) {
      s.bestNet = net;
      s.best = { hash, label: t.win.label, usd: t.win.usd, net: t.win.net, sizeUsd: t.win.sizeUsd,
        bps: t.win.bps, type: t.win.type, upper: t.win.upper };
    }
  } else if (t.priced) {
    s.lost++;
  } else {
    const r = t.reason || "不明";
    s.unpriced[r] = (s.unpriced[r] || 0) + 1;
  }
}

/// 1件の募集中の注文を、今の条件で値付けする。結果は t に書き込む。
async function priceOpenOrder(chain, order, t, nowSec, block, hubs) {
  const r = resolveOpenOrder(order, { nowSec, block });
  if (!r.ok) { t.reason = r.reason; return; }
  t.type = r.type;
  // 独占期間中は、独占者以外は上乗せを払わないと埋められない(上乗せ率は応答に無い)。
  // 次の回に期間が明けていれば値付けする。
  if (r.exclusive) { t.reason = "独占中"; return; }
  if (r.otherTokenOutputs > 0) { t.reason = "別通貨の出力"; return; }
  const tokenIn = toWrappedToken(chain, r.tokenIn);
  const tokenOut = toWrappedToken(chain, r.tokenOut);
  if (tokenIn == null || tokenOut == null) { t.reason = "読替不可"; return; }
  if (tokenIn === tokenOut) { t.reason = "ラップのみ"; return; }

  const mine = bestOutputFor({ chain, tokenIn, tokenOut, amountIn: r.amountIn, hubTokens: hubs });
  if (!mine) {
    t.reason = "経路なし";
    // 約定済みの計測と同じ控えに載せ、地図に足す候補にする(1件につき1回だけ)。
    if (!t.missingNoted) {
      t.missingNoted = true;
      const ms = statFor(chain);
      const k = `${tokenIn}|${tokenOut}`;
      const m = ms.missing[k] || { n: 0, usd: 0, tokenIn, tokenOut };
      m.n++;
      const inUsd = toUsd(chain, tokenIn, r.amountIn);
      if (inUsd != null) m.usd += inUsd;
      ms.missing[k] = m;
    }
    return;
  }
  const diffUsd = toUsd(chain, tokenOut, mine.amountOut - r.amountOut);
  if (diffUsd == null) { t.reason = "価格不明"; return; }
  t.priced = true;
  // 模型(V3 も x·y=k で近似 = 過大に出る側)で赤字なら、チェーンに聞くまでもない。
  if (diffUsd <= 0) { t.reason = "赤字"; return; }
  // V2 を含む経路は税トークンを見抜けないので「確かめた」と言えない。勝ちに数えない。
  if (mine.legs.some((l) => l.kind !== KIND_V3)) { t.reason = "V2で確認不可"; return; }
  let trueOut = null;
  try { trueOut = await verifyOnChain(chain, mine.legs, r.amountIn); } catch (e) { /* 数えないだけ */ }
  if (trueOut == null) { t.reason = "確認失敗"; return; }
  const usd = toUsd(chain, tokenOut, trueOut - r.amountOut);
  if (usd == null || usd <= 0) { t.reason = "赤字(確認)"; return; }
  let gas = null;
  try { gas = await estimateGasCostUsd(chain, mine.legs.length >= 2 ? "3step" : "2step"); } catch (e) { /* 概算なしで残す */ }
  const net = gas != null ? usd - gas : null;
  if (net != null && net <= 0) { t.reason = "ガス負け"; return; }
  const sizeUsd = toUsd(chain, tokenIn, r.amountIn);
  t.win = { at: Date.now(), usd, net, sizeUsd, bps: sizeUsd > 0 ? (usd / sizeUsd) * 10000 : null,
    label: mine.label, type: r.type, upper: r.upperBound };
}

async function probeOpenChain(chain) {
  const s = openStatFor(chain);
  const orders = await fetchOrders(chain, "open", OPEN_LIMIT);
  if (orders == null) { s.pollFailed++; return; }
  s.polls++;
  const now = Date.now();
  const nowSec = Math.floor(now / 1000);
  // Dutch_V3 はブロック番号で額が決まる。要る時だけ1回聞く。
  let block = null;
  if (orders.some((o) => o?.type === "Dutch_V3")) {
    try { block = await getProviderForChain(chain).getBlockNumber(); } catch (e) { /* 分からなければ null */ }
  }
  const hubs = Object.keys(getKnownTokens(chain));
  const present = new Set();
  for (const order of orders) {
    const hash = order?.orderHash;
    if (!hash) continue;
    present.add(hash);
    let t = tracked.get(hash);
    if (!t) {
      if (tracked.size >= OPEN_TRACK_LIMIT) continue;
      t = { chain, firstSeen: now, lastSeen: now, priced: false, reason: null, win: null };
      tracked.set(hash, t);
      s.seen++;
    }
    t.lastSeen = now;
    if (t.win) continue; // 一度勝てた注文は、それ以上値付けしない
    try {
      await priceOpenOrder(chain, order, t, nowSec, block, hubs);
    } catch (e) { t.reason = "失敗"; }
  }
  // **一覧から消えた注文の結末を数える。** 一覧が上限いっぱいなら、
  // 見えていないだけの可能性があるので、しばらく見えない時だけ終わりとみなす。
  const complete = orders.length < OPEN_LIMIT;
  for (const [hash, t] of tracked) {
    if (t.chain !== chain || present.has(hash)) continue;
    if (complete || now - t.lastSeen > OPEN_FORGET_MS) finalizeOpen(hash, t);
  }
}

let openRunning = false;
let openRuns = 0;
/// 募集中の注文を全チェーンぶん値付けする。**注文は出さない。**
export async function probeUniswapXOpenOnce(activeChains) {
  if (openRunning) return; // 前の回が終わっていなければ飛ばす(重ならないように)
  openRunning = true;
  try {
    for (const chain of PROBE_CHAINS) {
      if (!activeChains.includes(chain) || !CHAIN_IDS[chain]) continue;
      try {
        await probeOpenChain(chain);
      } catch (e) {
        console.warn(`[UniswapX募集中] ${chain}: 失敗 ${(e.message || "").slice(0, 60)}`);
      }
    }
    // 保存は約定済みの計測と同じファイル。20秒ごとに書くと多いので、15回に1回。
    if (++openRuns % 15 === 0) persist();
  } finally {
    openRunning = false;
  }
}

/// 生存ログ用の1行。
export function formatUniswapXOpenLine() {
  const parts = [];
  for (const [chain, s] of openStats) {
    if (s.polls === 0 && s.seen === 0) continue;
    const ended = s.won + s.lost + Object.values(s.unpriced).reduce((a, n) => a + n, 0);
    const why = Object.entries(s.unpriced).sort((a, b) => b[1] - a[1]).slice(0, 3)
      .map(([r, n]) => `${r}${n}`).join(" ");
    const priced = s.won + s.lost;
    const rate = priced > 0 ? `${((s.won / priced) * 100).toFixed(0)}%` : "-";
    const bps = median(s.wins.map((w) => w.bps).filter((x) => x != null));
    const held = median(s.wins.map((w) => w.heldSec));
    let open = 0;
    for (const t of tracked.values()) if (t.chain === chain) open++;
    parts.push(`${chain} 取得${s.polls}回${s.pollFailed ? `(失敗${s.pollFailed})` : ""} 見${s.seen} 募集中${open}`
      + ` 終了${ended}(**勝${s.won}/負${s.lost} 勝率${rate}**${why ? ` 値付けできず[${why}]` : ""})`
      + ` 取り分 計$${s.grossUsd.toFixed(4)}(ガス概算後$${s.netUsd.toFixed(4)})`
      + (bps != null ? ` 中央${bps.toFixed(1)}bps` : "")
      + (held != null ? ` 黒字の持続 中央${held.toFixed(0)}s` : "")
      + (s.upperWins > 0 ? ` うち上限扱い${s.upperWins}件` : ""));
  }
  return parts.length > 0 ? ` UniswapX募集中[${parts.join(" / ")}]` : "";
}

/// 詳しい報告(30分ごと)。勝てた最良の1本。
export function formatUniswapXOpenReport() {
  const lines = [];
  for (const [chain, s] of openStats) {
    if (!s.best) continue;
    const b = s.best;
    lines.push(`[UniswapX募集中] ${chain}: 最良 ${b.label} で $${b.usd.toFixed(4)}`
      + `${b.net != null ? `(ガス概算後$${b.net.toFixed(4)})` : ""}`
      + `(注文$${b.sizeUsd != null ? b.sizeUsd.toFixed(0) : "?"} ${b.bps != null ? `${b.bps.toFixed(1)}bps ` : ""}${b.type}`
      + `${b.upper ? " **入札ゼロ時の上限**" : ""} / ${b.hash.slice(0, 10)}…)`);
  }
  return lines;
}

/// 保存の形。**中身の意味を変えたら上げる**(古い形を読んで静かに壊れないように)。
const STATE_NAME = "uniswapx-probe.json";
/// **3 に上げた(2026年9月22日、2度目)。**
///
/// 版2の `missing`(経路なしの組の控え)には、**ゼロ住所のままの組**が入っている。
/// 読み替えを入れた今、それは**永久に解決しない幽霊の組**として残り続け、
/// 「経路なしの上位」を占めてしまう。読み戻さずに捨てる。
///
/// --- 版2にした理由(下は当時の記録) ---
///
/// 版1までの数字は、**出力が複数ある注文で最大の1つしか見ていなかった**ため、
/// 手数料の出力を「タダでもらえる」前提で計算されている = **利益が水増しされている**。
/// 読み戻すと汚染が残るので、**版番号を上げて捨てる**。
/// (これが版番号を持たせた理由そのもの。9勝$18.5477 は信用しない)
const STATE_VERSION = 3;

/// 再デプロイで計測が消えないように読み戻す。
/// (2026年9月22日:1日4回のデプロイで毎回ゼロに戻っていた)
function restore() {
  const d = loadState(STATE_NAME, STATE_VERSION);
  if (!d) return;
  for (const h of d.seen || []) seenOrders.add(h);
  for (const [chain, v] of Object.entries(d.stats || {})) {
    const s = statFor(chain);
    for (const k of Object.keys(s)) {
      if (Array.isArray(s[k])) { if (Array.isArray(v[k])) s[k] = v[k].slice(-500); continue; }
      // **足りない組は数ではなく表。** 上の「数なら数」の枝に落とさない。
      if (k === "missing") { if (v[k] && typeof v[k] === "object") s[k] = v[k]; continue; }
      if (typeof s[k] === "number" && Number.isFinite(Number(v[k]))) s[k] = Number(v[k]);
      else if (v[k] != null && typeof s[k] !== "number") s[k] = v[k];
    }
  }
  const n = [...stats.values()].reduce((a, v) => a + v.seen, 0);
  if (n > 0) console.log(`[UniswapX計測] 前回までの ${n}件 を読み戻しました(記憶${seenOrders.size}件)`);
  // 募集中の注文の集計(2026年9月23日に追加。古い保存には無い)。
  for (const [chain, v] of Object.entries(d.open || {})) {
    const s = openStatFor(chain);
    for (const k of Object.keys(s)) {
      if (Array.isArray(s[k])) { if (Array.isArray(v?.[k])) s[k] = v[k].slice(-500); continue; }
      if (typeof s[k] === "number") { if (Number.isFinite(Number(v?.[k]))) s[k] = Number(v[k]); continue; }
      if (k === "unpriced" && v?.[k] && typeof v[k] === "object") { s[k] = v[k]; continue; }
      if (v?.[k] != null) s[k] = v[k];
    }
  }
}
restore();

function persist() {
  saveState(STATE_NAME, STATE_VERSION, {
    seen: [...seenOrders],
    stats: Object.fromEntries([...stats].map(([c, v]) => [c, v])),
    open: Object.fromEntries([...openStats].map(([c, v]) => [c, v])),
  });
}

/// 全チェーンを測る。**注文は取るが、約定は一切しない。**
export async function probeUniswapXOnce(activeChains) {
  for (const chain of PROBE_CHAINS) {
    if (!activeChains.includes(chain)) continue;
    try {
      await probeChain(chain);
    } catch (e) {
      console.warn(`[UniswapX計測] ${chain}: 失敗 ${(e.message || "").slice(0, 60)}`);
    }
  }
  persist(); // **1周ごとに保存。** 次のデプロイで消えないように
}

/// 生存ログ用の1行。まだ1件も見ていなければ空。
export function formatUniswapXLine() {
  if (stats.size === 0) return "";
  const parts = [];
  for (const [chain, s] of stats) {
    if (s.seen === 0) continue;
    // **模型の答えと、チェーンに聞いて確かめた答えを分けて出す。**
    // 初回計測で模型が34%という有り得ない値を出したので、混ぜて出すと判断を誤る。
    const rate = s.quotable > 0 ? ((s.won / s.quotable) * 100).toFixed(0) : "-";
    const vTotal = s.verifiedWon + s.verifiedLost;
    const vRate = vTotal > 0 ? ((s.verifiedWon / vTotal) * 100).toFixed(0) : "-";
    // **測れているのかどうかを先に出す。** noTime が残っている間は数字を信じない。
    const med = s.ages.length > 0
      ? [...s.ages].sort((a, b) => a - b)[Math.floor(s.ages.length / 2)].toFixed(0) : "-";
    parts.push(`${chain} 見${s.seen}(古すぎ${s.tooOld} 約定時刻なし${s.createdOnly} 時刻読めず${s.noTime} 齢中央${med}s`
      + `${s.timeKey ? ` key=${s.timeKey}` : ""})/値付け${s.quotable}(経路なし${s.noRoute})`
      + ` 模型勝${s.won}($${s.marginUsd.toFixed(3)})`
      + ` → **確認済 ${s.verifiedWon}勝/${s.verifiedLost}敗(${vRate}%) $${s.verifiedUsd.toFixed(4)}**`
      + `(V2で確認不可${s.hadV2} 確認失敗${s.verifyFailed})`
      // **出力が複数ある注文。** 直す前はここを見落として利益を水増ししていた。
      + (s.multiOut > 0 ? ` **出力複数${s.multiOut}件(見落としていた額 計$${s.ignoredOutUsd.toFixed(4)})**` : "")
      + (s.otherTokenOut > 0 ? ` 別通貨の出力${s.otherTokenOut}件は除外` : "")
      + (s.nativeSwapped > 0 ? ` ネイティブ${s.nativeSwapped}件を包んだ版に読替` : "")
      + (s.nativeUnknown > 0 ? ` 読替不可${s.nativeUnknown}` : ""));
  }
  return parts.length > 0 ? ` UniswapX計測[${parts.join(" / ")}]` : "";
}

/// 詳しい報告(30分ごと)。勝てた最良の1本を出す。
export function formatUniswapXReport() {
  const lines = [];
  for (const [chain, s] of stats) {
    if (!s.best) continue;
    lines.push(`[UniswapX計測] ${chain}: **チェーンで確認した**最良 ${s.best.label} で $${s.bestUsd.toFixed(4)} の取り分`
      + `(注文$${s.best.sizeUsd != null ? s.best.sizeUsd.toFixed(0) : "?"}`
      + `${s.best.modelUsd != null ? ` / 模型は$${s.best.modelUsd.toFixed(4)}と言っていた` : ""}`
      + ` / ${s.best.hash.slice(0, 10)}…)`);

    // **その取り分が値動きの残りかすでないかを、齢で割って見る。**
    const sp = splitByAge(s.verifiedWins);
    if (sp.enough) {
      const y = sp.young.bps.toFixed(1), o = sp.old.bps.toFixed(1);
      // 若い側が古い側の半分未満なら、**残っているのは値動き**と読む。
      const verdict = sp.young.bps < sp.old.bps * 0.5
        ? "**まだ値動きが混ざっている**(齢の上限をさらに下げる)"
        : "齢で変わらない = **値動きでは説明できない**";
      lines.push(`[UniswapX計測] ${chain}: 齢${sp.cutSec}秒未満 ${sp.young.n}件 ${y}bps`
        + ` / ${sp.cutSec}秒以上 ${sp.old.n}件 ${o}bps → ${verdict}`);
    } else {
      lines.push(`[UniswapX計測] ${chain}: 齢で割るには足りない`
        + `(若${sp.young.n}件/古${sp.old.n}件、各5件必要)。**まだ結論を出さない**`);
    }
  }
  return lines;
}

export function getUniswapXStats() {
  const out = {};
  for (const [chain, s] of stats) out[chain] = { ...s };
  return out;
}

export function getProbeChains() { return PROBE_CHAINS.filter((c) => CHAIN_IDS[c]); }

/// **地図に足すべき通貨の組**を、価値の高い順に返す。
///
/// 並べ方は「注文額の合計」。件数が多くても1件$1なら足す価値は薄く、
/// 1件$5,000が数回ある組の方が効く(最良の勝ちは $1,901 の注文だった)。
///
/// @returns [{ chain, tokenIn, tokenOut, n, usd }]
export function getMissingPairs(limit = 20) {
  const out = [];
  for (const [chain, s] of stats) {
    for (const m of Object.values(s.missing || {})) {
      if (!m?.tokenIn || !m?.tokenOut) continue;
      out.push({ chain, tokenIn: m.tokenIn, tokenOut: m.tokenOut, n: m.n, usd: m.usd });
    }
  }
  out.sort((a, b) => b.usd - a.usd || b.n - a.n);
  return out.slice(0, limit);
}

/// 足りない組の要約(生存ログ用)。
export function formatMissingPairsLine() {
  const top = getMissingPairs(3);
  if (top.length === 0) return "";
  let total = 0, kinds = 0;
  for (const [, s] of stats) {
    for (const m of Object.values(s.missing || {})) { total += m.n; kinds++; }
  }
  const head = top.map((p) => `${p.chain}:${p.tokenIn.slice(0, 6)}→${p.tokenOut.slice(0, 6)}($${p.usd.toFixed(0)}/${p.n}件)`);
  return ` 経路なしの組[${kinds}組 計${total}件 上位 ${head.join(" ")}]`;
}

/// 地図に載った組を控えから消す(同じ組を何度も探しに行かないため)。
export function forgetMissingPair(chain, tokenIn, tokenOut) {
  const s = stats.get(chain);
  if (!s?.missing) return false;
  const k = `${tokenIn}|${tokenOut}`;
  if (!s.missing[k]) return false;
  delete s.missing[k];
  return true;
}
