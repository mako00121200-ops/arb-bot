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
export function pickAmount(side) {
  for (const key of ["settledAmount", "filledAmount", "amount", "startAmount"]) {
    const v = side?.[key];
    if (v == null) continue;
    try {
      const b = BigInt(String(v));
      if (b > 0n) return b;
    } catch (e) { /* 数にならない値は飛ばす */ }
  }
  return null;
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

  return {
    tokenIn, amountIn: inAmount, tokenOut: main.token,
    // **比べる相手はこれ。** 全部の出力の合計。
    amountOut: owedOut,
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

// ---------------------------------------------------------------------------
// **募集中の注文を「今この瞬間」の条件に直す。**(2026年9月23日)
//
// [なぜ要るか]
// 約定済みの注文を今の価格で比べると、約定から今までの値動きが「取り分」に混ざる。
// 若い注文と古い注文に割って見る仕組みも入れたが、若い注文が2時間で1件しか増えず、
// 結論まで何日もかかる。しかも polygon は約定時刻が無く、avalanche は全部古すぎて、
// そもそも測れていなかった。
//
// 募集中の注文なら、**今の注文と今の価格**を比べられる。値動きは原理的に混ざらない。
// そのためには「今この瞬間、埋める側が受け取る量と届ける義務のある量」が要る。
// 注文の型ごとに決まり方が違うので、公式SDK(@uniswap/uniswapx-sdk)の resolve を
// そのまま写した。**式は推測で書いていない**(下の各関数に写し元を記す)。
//
//   Dutch / Dutch_V2 … 時刻で直線的に減る(utils/dutchDecay.ts getDecayedAmount)
//   Dutch_V3         … ブロックで折れ線状に減る(utils/dutchBlockDecay.ts)
//   Priority         … 優先手数料の入札で出力が増える(order/PriorityOrder.ts scaleOutputs)。
//                      入札ゼロの時の額で比べるので、**取り分の上限**にしかならない
//
// 形は uniswapx-service の GET /orders の応答(lib/handlers/get-orders/schema/)で確認した。

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

function toBig(v) {
  if (v == null) return null;
  try { return BigInt(String(v)); } catch (e) { return null; }
}

/// 0 なら元の値を使う(SDK の originalIfZero と同じ)。
function originalIfZero(override, original) {
  const o = toBig(override);
  return o != null && o !== 0n ? o : toBig(original);
}

/// 時刻での直線減衰。SDK の getDecayedAmount を BigInt で写したもの。
export function decayByTime(startAmount, endAmount, decayStartTime, decayEndTime, atTime) {
  if (decayEndTime <= atTime) return endAmount;
  if (decayStartTime >= atTime) return startAmount;
  if (startAmount === endAmount) return startAmount;
  const duration = BigInt(decayEndTime - decayStartTime);
  const elapsed = BigInt(Math.floor(atTime - decayStartTime));
  if (startAmount > endAmount) return startAmount - ((startAmount - endAmount) * elapsed) / duration;
  return startAmount + ((endAmount - startAmount) * elapsed) / duration;
}

/// ブロックでの折れ線減衰。SDK の NonLinearDutchDecayLib.decay を BigInt で写したもの
/// (SDK の注記では、コントラクトの式をそのまま写してある)。
export function decayByBlock(startAmount, relativeBlocks, relativeAmounts, decayStartBlock, currentBlock) {
  if (relativeAmounts.length > 16) return null;
  if (decayStartBlock >= currentBlock || relativeAmounts.length === 0) return startAmount;
  const blockDelta = currentBlock - decayStartBlock;
  const linear = (sp, ep, cp, sa, ea) => {
    if (cp >= ep) return ea;
    const elapsed = BigInt(cp - sp), duration = BigInt(ep - sp);
    if (ea < sa) return sa - ((sa - ea) * elapsed) / duration;
    return sa + ((ea - sa) * elapsed) / duration;
  };
  if (relativeBlocks[0] > blockDelta) {
    return linear(0, relativeBlocks[0], blockDelta, startAmount, startAmount - relativeAmounts[0]);
  }
  let prev = 0, next = 0;
  let found = false;
  for (; next < relativeBlocks.length; next++) {
    if (relativeBlocks[next] >= blockDelta) { found = true; break; }
    prev = next;
  }
  if (!found) { prev = next - 1; next = next - 1; }
  return linear(relativeBlocks[prev], relativeBlocks[next], blockDelta,
    startAmount - relativeAmounts[prev], startAmount - relativeAmounts[next]);
}

/// 解決済みの入出力を、比べられる形にまとめる。extractSwap と同じ考え方:
/// **届ける義務は出力の全部**(最大の1つだけを見ると手数料の出力をタダ扱いして水増しになる)。
function summarize(inputToken, inputAmount, outputs) {
  if (!inputToken || !(inputAmount > 0n) || outputs.length === 0) return null;
  let main = null;
  for (const o of outputs) {
    if (!o.token || !(o.amount > 0n)) continue;
    if (main == null || o.amount > main.amount) main = o;
  }
  if (main == null) return null;
  let owed = 0n, other = 0;
  for (const o of outputs) {
    if (!o.token || !(o.amount > 0n)) continue;
    if (o.token === main.token) owed += o.amount; else other++;
  }
  const tokenIn = String(inputToken).toLowerCase();
  if (tokenIn === main.token) return null;
  return { tokenIn, amountIn: inputAmount, tokenOut: main.token, amountOut: owed,
    outputCount: outputs.length, otherTokenOutputs: other };
}

/// 募集中の注文を、`nowSec`(秒)と `block`(ブロック番号、分からなければ null)の時点に解決する。
///
/// @returns { ok: false, reason } … 比べられない(reason は数えるための短い日本語)
///   (`block` は Dutch_V3 でだけ使う。Priority の開始ブロックは判定に使わない)
///          { ok: true, type, exclusive, upperBound, ...summarize の結果 }
///   exclusive  … 独占期間中(独占者以外は上乗せを払わないと埋められない。上乗せ率は応答に無い)
///   upperBound … Priority 型。入札ゼロの時の額なので、実際の取り分はこれより小さい
export function resolveOpenOrder(order, { nowSec, block = null } = {}) {
  const type = order?.type;
  const deadline = Number(order?.deadline);
  if (Number.isFinite(deadline) && deadline > 0 && nowSec > deadline) return { ok: false, reason: "期限切れ" };
  const outs = Array.isArray(order?.outputs) ? order.outputs : [];
  const input = order?.input;
  if (!input?.token || outs.length === 0) return { ok: false, reason: "形が違う" };
  const lower = (t) => String(t || "").toLowerCase();

  let inAmount = null, outputs = null, exclusive = false, upperBound = false;

  if (type === "Dutch_V2" || type === "Dutch") {
    // V1 は減衰の時刻と独占者が注文の直下、V2 は cosignerData の中にある。
    const cd = type === "Dutch_V2" ? order.cosignerData : order;
    const ds = Number(cd?.decayStartTime), de = Number(cd?.decayEndTime);
    if (!Number.isFinite(ds) || !Number.isFinite(de)) return { ok: false, reason: "形が違う" };
    const inStart = type === "Dutch_V2" ? originalIfZero(cd?.inputOverride, input.startAmount) : toBig(input.startAmount);
    const inEnd = toBig(input.endAmount);
    if (inStart == null || inEnd == null) return { ok: false, reason: "形が違う" };
    inAmount = decayByTime(inStart, inEnd, ds, de, nowSec);
    const overrides = Array.isArray(cd?.outputOverrides) ? cd.outputOverrides : [];
    outputs = [];
    for (let i = 0; i < outs.length; i++) {
      const s = type === "Dutch_V2" ? originalIfZero(overrides[i], outs[i].startAmount) : toBig(outs[i].startAmount);
      const e = toBig(outs[i].endAmount);
      if (s == null || e == null) return { ok: false, reason: "形が違う" };
      outputs.push({ token: lower(outs[i].token), amount: decayByTime(s, e, ds, de, nowSec) });
    }
    // 独占期間は decayStartTime まで(ExclusivityLib: block.timestamp <= exclusivityEnd)。
    const ex = lower(cd?.exclusiveFiller);
    exclusive = ex !== "" && ex !== ZERO_ADDRESS && nowSec <= ds;
  } else if (type === "Dutch_V3") {
    if (block == null) return { ok: false, reason: "ブロック不明" };
    const cd = order.cosignerData;
    const dsb = Number(cd?.decayStartBlock);
    if (!Number.isFinite(dsb)) return { ok: false, reason: "形が違う" };
    const curveOf = (c) => {
      const rb = Array.isArray(c?.relativeBlocks) ? c.relativeBlocks.map(Number) : null;
      const ra = Array.isArray(c?.relativeAmounts) ? c.relativeAmounts.map(toBig) : null;
      if (!rb || !ra || rb.length !== ra.length || rb.some((x) => !Number.isFinite(x)) || ra.some((x) => x == null)) return null;
      return { rb, ra };
    };
    const inCurve = curveOf(input.curve);
    const inStart = originalIfZero(cd?.inputOverride, input.startAmount);
    if (!inCurve || inStart == null) return { ok: false, reason: "形が違う" };
    inAmount = decayByBlock(inStart, inCurve.rb, inCurve.ra, dsb, block);
    const overrides = Array.isArray(cd?.outputOverrides) ? cd.outputOverrides : [];
    outputs = [];
    for (let i = 0; i < outs.length; i++) {
      const c = curveOf(outs[i].curve);
      const s = originalIfZero(overrides[i], outs[i].startAmount);
      if (!c || s == null) return { ok: false, reason: "形が違う" };
      let amt = decayByBlock(s, c.rb, c.ra, dsb, block);
      // 下限(minAmount)より下には減らない。
      const min = toBig(outs[i].minAmount);
      if (amt != null && min != null && amt < min) amt = min;
      outputs.push({ token: lower(outs[i].token), amount: amt });
    }
    if (inAmount == null || outputs.some((o) => o.amount == null)) return { ok: false, reason: "形が違う" };
    const ex = lower(cd?.exclusiveFiller);
    exclusive = ex !== "" && ex !== ZERO_ADDRESS && block <= dsb;
  } else if (type === "Priority") {
    // 入札の開始前でも値付けする。この型の額はブロックに依存しない(入札額だけで決まる)ので、
    // 開始前に見た値がそのまま開始後の値になる。開始前を捨てると、募集が数ブロックで
    // 終わる base では、ほとんどの注文を「値付けできず」にしてしまう。
    // **入札ゼロの時の額。** 出力は amount × (MPS + 優先手数料×mps) / MPS で増えるので、
    // 競争相手が入札すれば我々の取り分は減る。ここで出るのは上限。
    inAmount = toBig(input.amount);
    outputs = outs.map((o) => ({ token: lower(o.token), amount: toBig(o.amount) }));
    if (inAmount == null || outputs.some((o) => o.amount == null)) return { ok: false, reason: "形が違う" };
    upperBound = true;
  } else {
    return { ok: false, reason: "対象外の型" };
  }

  const s = summarize(input.token, inAmount, outputs);
  if (!s) return { ok: false, reason: "形が違う" };
  return { ok: true, type, exclusive, upperBound, ...s };
}

