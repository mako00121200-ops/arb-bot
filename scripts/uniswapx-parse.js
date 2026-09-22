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

  let main = null;
  for (const o of outputs) {
    if (!o?.token) continue;
    const amt = pickAmount(o);
    if (amt == null) continue;
    if (main == null || amt > main.amount) main = { token: String(o.token).toLowerCase(), amount: amt };
  }
  const inAmount = pickAmount(input);
  if (main == null || inAmount == null || !(inAmount > 0n) || !(main.amount > 0n)) return null;

  const tokenIn = String(input.token).toLowerCase();
  // 同じ通貨どうしは扱わない(ラップの出入りなど。裁定の対象ではない)。
  if (tokenIn === main.token) return null;
  return { tokenIn, amountIn: inAmount, tokenOut: main.token, amountOut: main.amount };
}
