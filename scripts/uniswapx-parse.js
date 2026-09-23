// scripts/uniswapx-parse.js
//
// **UniswapX の注文JSONを読む部分だけを切り出したもの。**
//
// [なぜ別ファイルにしたか(2026年9月22日)]
// ここは**外部のAPIが返す、我々が形を決めていないデータ**を扱う。いちばん間違えやすく、
// 間違えると「勝てていないのに勝てたと出る」という最悪の壊れ方をする。
// 一方 uniswapx-probe.js は ethers を辿る重い依存を持ち、手元では import できない。
// **試せない場所に、いちばん試すべきものを置かない。** ここは依存ゼロにして、
// 実際のJSONの形で単体テストできるようにする。

/// 金額を拾う。**実際に約定した値を優先**し、無ければ提示額へ落ちる。
/// どれも数にならなければ null(**推測で埋めない**)。
///
/// [順番に意味がある]
/// settled/filled … 実際に決済された量。答え合わせにはこれが正しい
/// amount         … 単一値で来る版
/// startAmount    … ダッチオークションの開始値。約定額の上限であって実額ではないが、
///                  他に何も無いよりはまし。**我々に不利な側**(ユーザーへの支払いを
///                  多めに見る)なので、勝ちを水増ししない
export const AMOUNT_KEYS = ["settledAmount", "filledAmount", "amount", "startAmount"];

export function pickAmount(side) {
  for (const key of AMOUNT_KEYS) {
    const v = side?.[key];
    if (v == null) continue;
    try {
      const b = BigInt(String(v));
      if (b > 0n) return b;
    } catch (e) { /* 数にならない値は飛ばす */ }
  }
  return null;
}

/// **pickAmount がどの項目で額を読んだか**を返す。読めなければ null。
///
/// [なぜ要るか(2026年9月23日)]
/// base の Priority 注文は、**優先手数料に比例してユーザーの受取が増える**
/// (`PriorityOrderReactor.sol` の `outputs.scale(priorityFee)`)。
/// 注文の `amount` は**最低額**で、実際の受取はそれより多い。
/// `amount` で比べていると、**競争相手が入札で上乗せした分をまるごと我々の取り分に数える**
/// = 水増しになる。どの項目で読めているかを数えて、これを確かめる。
export function amountKeyOf(side) {
  for (const key of AMOUNT_KEYS) {
    const v = side?.[key];
    if (v == null) continue;
    try {
      if (BigInt(String(v)) > 0n) return key;
    } catch (e) { /* 数にならない値は飛ばす */ }
  }
  return null;
}

/// 注文の種類(Priority / Dutch_V3 など)。**名前を決め打ちしない**ので、
/// 候補の項目を順に見て、どれも無ければ「不明」。
export const ORDER_TYPE_KEYS = ["orderType", "type"];
export function orderTypeOf(order) {
  for (const key of ORDER_TYPE_KEYS) {
    const v = order?.[key];
    if (v != null && String(v).trim() !== "") return String(v).slice(0, 24);
  }
  return "不明";
}

/// **実際に決済された額**を `settledAmounts` から読む。読めなければ null。
///
/// - 出力:通貨が一致する要素の `amountOut` を**全部足す**(手数料の出力も届ける義務がある)
/// - 入力:要素ごとに同じ `amountIn` が繰り返されている前提なので、**全部同じ時だけ**使う。
///   違っていたら形が想定と違うので使わない(推測で足さない)
export function readSettled(order, tokenIn, tokenOut) {
  const arr = Array.isArray(order?.settledAmounts) ? order.settledAmounts : null;
  if (!arr || arr.length === 0) return null;
  let out = 0n, outSeen = false;
  const ins = new Set();
  for (const e of arr) {
    try {
      if (e?.tokenOut && String(e.tokenOut).toLowerCase() === tokenOut && e.amountOut != null) {
        out += BigInt(String(e.amountOut)); outSeen = true;
      }
      if (e?.tokenIn && String(e.tokenIn).toLowerCase() === tokenIn && e.amountIn != null) {
        ins.add(BigInt(String(e.amountIn)).toString());
      }
    } catch (err) { return null; }   // 数にならない値があれば形が違う。丸ごと使わない
  }
  const amountIn = ins.size === 1 ? BigInt([...ins][0]) : null;
  return {
    amountOut: outSeen && out > 0n ? out : null,
    amountIn: amountIn != null && amountIn > 0n ? amountIn : null,
  };
}

/// 注文から「入る通貨と量」「ユーザーへ出す通貨と量」を取り出す。
/// 取れなければ null を返し、呼ぶ側は**数えない**。
///
/// 出力は複数あり得る(プロトコル手数料の取り分など)。
/// **ユーザー宛の本体は最大のもの**とみなす。
export function extractSwap(order) {
  const input = order?.input;
  const outputs = Array.isArray(order?.outputs) ? order.outputs : [];
  if (!input?.token || outputs.length === 0) return null;

  // **いちばん大きい出力を「ユーザーの取り分」とする。**
  let main = null;
  for (const o of outputs) {
    if (!o?.token) continue;
    const amt = pickAmount(o);
    if (amt == null) continue;
    if (main == null || amt > main.amount) main = { token: String(o.token).toLowerCase(), amount: amt };
  }
  const inAmount = pickAmount(input);
  if (main == null || inAmount == null || !(inAmount > 0n) || !(main.amount > 0n)) return null;

  // **払う義務があるのは「いちばん大きい1つ」ではなく、出力の全部。**
  //
  // [なぜ直したか(2026年9月22日、オーナーの指摘で発覚)]
  // UniswapX の注文は「ユーザーへの出力」に加えて**手数料の出力**を持つことがある。
  // 約定させる側はその**全部**を届ける義務がある。
  // 最大の1つだけを見ていると、残りを**タダでもらえる前提**になり、
  // その分そのまま**我々の取り分が水増しされる**。
  // $1,900 の注文で 0.25% の手数料出力を見落とせば $4.75 — 記録した最良の利益
  // $3.40 より大きい。**これだけで幻を作れる。**
  let owedOut = 0n;
  let otherTokens = 0;
  for (const o of outputs) {
    if (!o?.token) continue;
    const amt = pickAmount(o);
    if (amt == null) continue;
    if (String(o.token).toLowerCase() === main.token) owedOut += amt;
    else otherTokens++;   // **別の通貨での出力は値段を付けられない**(下で捨てる)
  }

  const tokenIn = String(input.token).toLowerCase();
  // 同じ通貨どうしは扱わない(ラップの出入りなど。裁定の対象ではない)。
  if (tokenIn === main.token) return null;

  // **実際に決済された額があれば、そちらで比べる。**
  //
  // [なぜ(2026年9月23日の見回りで判明)]
  // API の出力には `startAmount`(競売の開始額)と `minAmount` しか無く、pickAmount は
  // `startAmount` を拾っていた(base 71件中71件)。実際の受取は注文の外側の
  // `settledAmounts`(配列。1件 = {tokenOut, amountOut, tokenIn, amountIn}、
  // uniswapx-service の SettledAmount 型)にある。V3 Dutch では値が下がるうえ、
  // **cosigner が開始額を上書きできる**ので、`startAmount` との差は
  // 我々の実力より大きくも小さくもなりうる。**実額で比べるのが正しい。**
  const settled = readSettled(order, tokenIn, main.token);
  const amountOut = settled?.amountOut ?? owedOut;
  const amountIn = settled?.amountIn ?? inAmount;

  return {
    tokenIn, amountIn, tokenOut: main.token,
    // **比べる相手はこれ。** 実額があれば実額、無ければ全部の出力の合計(開始額)。
    amountOut,
    // どちらで比べたか。"settled" / "startAmount" 等(pickAmount が拾った項目)
    amountSource: settled?.amountOut != null ? "settledAmounts" : "order",
    // 参考:開始額の合計(実額との差を測るため)
    orderOut: owedOut,
    // 参考:いちばん大きい1つだけの額(水増しがどれだけあったかを測るため)
    mainOnlyOut: main.amount,
    outputCount: outputs.length,
    // **別通貨の出力があるものは、正しく比べられない。** 呼ぶ側が捨てる。
    otherTokenOutputs: otherTokens,
  };
}


/// 約定した時刻を読む。**秒**で返す。読めなければ null。
///
/// [なぜ要るか(2026年9月22日の見回りで判明)]
/// 計測は「**過去に約定した注文**」と「**今の我々の経路**」を比べている。
/// 約定した時から今までに価格が動いていれば、その差は**単なる値動きであって
/// 我々の実力ではない**。
///
/// 実際にそれが出た。base で **模型$2.397 に対しチェーンで確認したら $2.7926**。
/// 我々の見積もりより**チェーンの答えの方が大きい**のは、模型が正しければ起こらない
/// (模型は V3 を x·y=k で近似する = **過大**に出る側)。
/// つまり差の出どころは経路の優劣ではなく、**その間の値動き**。
///
/// [キーを決め打ちしない理由]
/// この API の応答を手元から見られない(社内プロキシが 403 を返す)。
/// **実物を読まずに名前を書く**のは §9 で一度やった失敗なので、
/// 候補を順に見て、**どれが使えたかをログに出す**。どれも無ければ「測れない」と言う。
/// 単位も秒とミリ秒の両方を受ける(桁で見分ける)。
/// **約定そのものの時刻。** これがあれば齢は正しく測れる。
export const FILL_TIME_KEYS = ["fillTimestamp", "settledAt", "filledAt", "txTimestamp"];
/// 注文が**作られた**時刻。約定はこれより後なので、齢の上限にしかならない。
/// (2026年9月22日: polygon はこれしか返さず、20件中20件が「古すぎ」になっていた。
///  だが本当は古いのではなく**約定時刻が分からない**だけ。**違うものを同じ箱に入れない**)
export const CREATED_AT_KEYS = ["createdAt"];
export const FILLED_AT_KEYS = [...FILL_TIME_KEYS, ...CREATED_AT_KEYS];

export function readFilledAt(order) {
  for (const key of FILLED_AT_KEYS) {
    const raw = order?.[key];
    if (raw == null) continue;
    const n = typeof raw === "number" ? raw : parseFloat(String(raw));
    if (!Number.isFinite(n) || n <= 0) continue;
    // 秒なら 1e9〜1e10 の桁、ミリ秒なら 1e12〜1e13 の桁。
    // **どちらとも言えない値は使わない**(桁を取り違えると「全部古い」か「全部新しい」になる)。
    let sec = null;
    if (n >= 1e9 && n < 1e11) sec = n;
    else if (n >= 1e12 && n < 1e14) sec = n / 1000;
    if (sec == null) continue;
    return { sec, key, isFillTime: FILL_TIME_KEYS.includes(key) };
  }
  return null;
}

/// 勝ちを「齢」で二つに割って、取り分の大きさを比べる。
///
/// [これで何が分かるか(2026年9月22日)]
/// 齢の上限を180秒にしたあとも、base で **$1,903 の注文に $9.23(48bps)** が残った。
/// これが本物の実力なのか、**まだ残っている値動き**なのかを見分けたい。
///
///   値動きの残りかすなら … 齢が短いほど取り分は小さくなる(若い側 ≪ 古い側)
///   本物の実力なら       … 齢に関係なく同じくらい出る(若い側 ≈ 古い側)
///
/// **どちらとも言えない件数では判定しない。** 呼ぶ側が enough を見て決める。
export function splitByAge(wins, cutSec = 60, minEach = 5) {
  const side = (list) => {
    let usd = 0, size = 0, n = 0;
    for (const w of list) {
      if (!(w?.sizeUsd > 0) || !(w?.usd > 0)) continue; // 大きさが分からないものは bps にできない
      usd += w.usd; size += w.sizeUsd; n++;
    }
    return { n, usd, sizeUsd: size, bps: size > 0 ? (usd / size) * 10000 : null };
  };
  const young = side(wins.filter((w) => w?.ageSec != null && w.ageSec < cutSec));
  const old = side(wins.filter((w) => w?.ageSec != null && w.ageSec >= cutSec));
  return { cutSec, young, old, enough: young.n >= minEach && old.n >= minEach };
}

// ===== V3 Dutch の「値の下がり方」を再現する(2026年9月23日、オーナーの指示) =====
//
// [なぜ要るか]
// 「どれだけ速ければ勝てるか」「ガス代込みでいくら残るか」を**測って**答えるため。
// 実際の約定額(settledAmounts)は1点しか教えてくれない。曲線を再現すれば
// 「その注文が各ブロックでいくら要求していたか」が分かり、
// **我々が黒字になる最初のブロック**と、勝者が埋めたブロックを比べられる。
//
// [一次情報]
// UniswapX の `NonlinearDutchDecayLib.sol`:
//   ・decayStartBlock 以前(または曲線が空)… startAmount(下限 minAmount)
//   ・経過ブロック = block − decayStartBlock
//   ・曲線の点は (relativeBlocks[i], relativeAmounts[i])。最初の点の前は (0, 0) から補間
//   ・点と点の間は**直線補間**、最後の点より後は最後の値のまま
//   ・出力 = startAmount − 補間した差分(下限 minAmount)
// 開始額は cosigner の `outputOverrides[i]` が 0 でなければそれで上書き(uniswapx-sdk の V3DutchOrder)。
// relativeBlocks は SDK では数の配列、コントラクトでは 16bit ずつ詰めた数。**両方受ける。**

/// relativeBlocks を数の配列にする。配列ならそのまま、数(文字列)なら 16bit ずつほどく。
export function unpackRelativeBlocks(raw, n) {
  if (Array.isArray(raw)) return raw.map((v) => Number(v));
  if (raw == null) return null;
  let x;
  try { x = BigInt(String(raw)); } catch (e) { return null; }
  const out = [];
  for (let i = 0; i < n; i++) out.push(Number((x >> BigInt(16 * i)) & 0xffffn));
  return out;
}

/// 1つの出力が、あるブロックで要求する額。オンチェーンの decay と同じ手順。
export function decayedAmount({ start, min, relBlocks, relAmounts, decayStartBlock, block }) {
  const lo = min != null ? min : 0n;
  const bound = (v) => (v < lo ? lo : v);
  if (!relAmounts || relAmounts.length === 0 || decayStartBlock >= block) return bound(start);
  const elapsed = block - decayStartBlock;
  let b0 = 0, a0 = 0n, b1, a1;
  const n = relAmounts.length;
  if (elapsed <= relBlocks[0]) {
    b1 = relBlocks[0]; a1 = relAmounts[0];
  } else if (elapsed >= relBlocks[n - 1]) {
    b0 = b1 = relBlocks[n - 1]; a0 = a1 = relAmounts[n - 1];
  } else {
    let i = 1;
    while (i < n && relBlocks[i] < elapsed) i++;
    b0 = relBlocks[i - 1]; a0 = relAmounts[i - 1];
    b1 = relBlocks[i]; a1 = relAmounts[i];
  }
  let delta;
  if (b1 === b0) delta = a1;
  else delta = a0 + ((a1 - a0) * BigInt(elapsed - b0)) / BigInt(b1 - b0);
  return bound(start - delta);
}

/// 注文から「tokenOut で、各ブロックに合計いくら要求されるか」を返す関数を作る。
/// 読めなければ null(**推測で埋めない**)。
export function readV3Requirement(order, tokenOut) {
  const cd = order?.cosignerData;
  const decayStartBlock = Number(cd?.decayStartBlock);
  if (!Number.isFinite(decayStartBlock) || decayStartBlock <= 0) return null;
  const outs = Array.isArray(order?.outputs) ? order.outputs : [];
  const overrides = Array.isArray(cd?.outputOverrides) ? cd.outputOverrides : [];
  const parts = [];
  try {
    outs.forEach((o, idx) => {
      if (!o?.token || String(o.token).toLowerCase() !== tokenOut) return;
      const ov = overrides[idx] != null ? BigInt(String(overrides[idx])) : 0n;
      const start = ov > 0n ? ov : BigInt(String(o.startAmount));
      const min = o.minAmount != null ? BigInt(String(o.minAmount)) : 0n;
      const relAmounts = Array.isArray(o.curve?.relativeAmounts)
        ? o.curve.relativeAmounts.map((v) => BigInt(String(v))) : [];
      const relBlocks = relAmounts.length > 0
        ? unpackRelativeBlocks(o.curve?.relativeBlocks, relAmounts.length) : [];
      if (relAmounts.length > 0 && (!relBlocks || relBlocks.length < relAmounts.length)) throw new Error("curve");
      parts.push({ start, min, relBlocks, relAmounts });
    });
  } catch (e) { return null; }
  if (parts.length === 0) return null;
  const lastRel = Math.max(0, ...parts.map((p) => (p.relBlocks.length ? p.relBlocks[p.relBlocks.length - 1] : 0)));
  return {
    decayStartBlock,
    endBlock: decayStartBlock + lastRel,
    at: (block) => parts.reduce((sum, p) => sum + decayedAmount({ ...p, decayStartBlock, block }), 0n),
  };
}

/// **我々が黒字になる最初のブロック**を探す。
/// ours … 我々の経路が出せる額 / need(b) … そのブロックで要求される額 / cost … ガス代(tokenOut 建て)
/// 見つからなければ null(曲線の終わりまで待っても黒字にならない)。
export function firstProfitableBlock(req, ours, cost, offset = 0n) {
  for (let b = req.decayStartBlock; b <= req.endBlock + 1; b++) {
    if (ours >= req.at(b) + offset + cost) return b;
  }
  return null;
}
