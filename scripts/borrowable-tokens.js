// scripts/borrowable-tokens.js
//
// 経路の始点に使える通貨を判断する。
//
// [フラッシュスワップ方式への移行で変わったこと]
// 以前はAaveから借りていたため、Aaveが扱う十数種の通貨しか始点にできなかった。
// 今は経路の最初のプール自身から先に受け取るため、原理的には「プールにある
// 通貨なら何でも」始点にできる。
//
// [それでも条件が2つ残る]
//   ①桁数(decimals)が分かること … 量の計算に必要
//   ②USD換算の価格が分かること   … 投入額と利益の判定に必要
// このどちらかが欠けると判定できないため、始点から外す。
// 価格は「安定通貨と繋がるプールから逆算する」方式で求めるので、
// 安定通貨から辿れるトークンであれば自動的に始点として使えるようになる。
//
// 下の一覧は「価格の起点になる安定通貨」と「桁数が確実なよく使う通貨」で、
// これらは起動時に確実に使える状態にしておく。ここに無い通貨も、
// 価格と桁数が揃えば始点として扱われる。

const KNOWN_TOKENS = {
  base: {
    "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913": { symbol: "USDC", decimals: 6, stable: true },
    "0x4200000000000000000000000000000000000006": { symbol: "WETH", decimals: 18, priceHintUsd: 2600 },
    "0x50c5725949a6f0c72e6c4a641f24049a917db0cb": { symbol: "DAI", decimals: 18, stable: true },
    "0xcbb7c0000ab88b473b1f5afd9ef808440eed33bf": { symbol: "cbBTC", decimals: 8, priceHintUsd: 95000 },
  },
  polygon: {
    "0x3c499c542cef5e3811e1192ce70d8cc03d5c3359": { symbol: "USDC", decimals: 6, stable: true },
    "0x2791bca1f2de4661ed88a30c99a7a9449aa84174": { symbol: "USDC.e", decimals: 6, stable: true },
    "0xc2132d05d31c914a87c6611c10748aeb04b58e8f": { symbol: "USDT", decimals: 6, stable: true },
    "0x8f3cf7ad23cd3cadbd9735aff958023239c6a063": { symbol: "DAI", decimals: 18, stable: true },
    "0x0d500b1d8e8ef31e21c99d1db9a6444d3adf1270": { symbol: "WMATIC", decimals: 18, priceHintUsd: 0.5 },
    "0x7ceb23fd6bc0add59e62ac25578270cff1b9f619": { symbol: "WETH", decimals: 18, priceHintUsd: 2600 },
    "0x1bfd67037b42cf73acf2047067bd4f2c47d9bfd6": { symbol: "WBTC", decimals: 8, priceHintUsd: 95000 },
  },
  arbitrum: {
    "0xaf88d065e77c8cc2239327c5edb3a432268e5831": { symbol: "USDC", decimals: 6, stable: true },
    "0xff970a61a04b1ca14834a43f5de4533ebddb5cc8": { symbol: "USDC.e", decimals: 6, stable: true },
    "0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9": { symbol: "USDT", decimals: 6, stable: true },
    "0xda10009cbd5d07dd0cecc66161fc93d7c9000da1": { symbol: "DAI", decimals: 18, stable: true },
    "0x82af49447d8a07e3bd95bd0d56f35241523fbab1": { symbol: "WETH", decimals: 18, priceHintUsd: 2600 },
    "0x2f2a2543b76a4166549f7aab2e75bef0aefc5b0f": { symbol: "WBTC", decimals: 8, priceHintUsd: 95000 },
  },
  optimism: {
    "0x0b2c639c533813f4aa9d7837caf62653d097ff85": { symbol: "USDC", decimals: 6, stable: true },
    "0x7f5c764cbc14f9669b88837ca1490cca17c31607": { symbol: "USDC.e", decimals: 6, stable: true },
    "0x94b008aa00579c1307b0ef2c499ad98a8ce58e58": { symbol: "USDT", decimals: 6, stable: true },
    "0xda10009cbd5d07dd0cecc66161fc93d7c9000da1": { symbol: "DAI", decimals: 18, stable: true },
    "0x4200000000000000000000000000000000000006": { symbol: "WETH", decimals: 18, priceHintUsd: 2600 },
    // [2026年9月20日に追加]
    // 住所は推測ではなく、チェーン上のイベント調査(pool-scout.js)で実際に
    // 取引のあったプールから読み取ったもの。この2つを相手にするプールが
    // 未採用の上位を占めていた(USDC/WBTC 491回、wstETH/WETH 442回、
    // WETH/WBTC 351回・312回、USDC/wstETH 240回 / いずれも100分間)。
    // Optimism の最小の壁は既に1bpsまで下がっており、足りないのは
    // 「値動きのある深いペア」。この2つがまさにそれにあたる。
    // 桁数は起動時にチェーンと突き合わせる(loadTokenDecimals の桁数の照合)。
    // priceHintUsd は探索候補の深さを測る目安にしか使わず、判定に使う価格は
    // プールから導出する。
    "0x68f180fcce6836688e9084f035309e29bf0a2095": { symbol: "WBTC", decimals: 8, priceHintUsd: 95000 },
    "0x1f32b1c2345538c0c6f582fcb022739c4a194ebb": { symbol: "wstETH", decimals: 18, priceHintUsd: 3100 },
  },
  avalanche: {
    "0xb97ef9ef8734c71904d8002f8b6bc66dd9c48a6e": { symbol: "USDC", decimals: 6, stable: true },
    "0x9702230a8ea53601f5cd2dc00fdbc13d4df4a8c7": { symbol: "USDT", decimals: 6, stable: true },
    "0xd586e7f844cea2f87f50152665bcbc2c279d8d70": { symbol: "DAI.e", decimals: 18, stable: true },
    "0xb31f66aa3c1e785363f0875a1b74e27b85fd66c7": { symbol: "WAVAX", decimals: 18, priceHintUsd: 25 },
    "0x49d5c2bdffac6ce2bfdb6640f4f80f226bc10bab": { symbol: "WETH.e", decimals: 18, priceHintUsd: 2600 },
  },
};

export function getKnownTokens(chain) {
  return KNOWN_TOKENS[(chain || "").toLowerCase()] || {};
}

// 起点として使えると確認できたトークン(桁数と価格が揃ったもの)。
// index.js が起動時と実行中に登録する。
const usableStarts = new Map(); // "chain::token" -> true

export function markUsableStart(chain, address) {
  usableStarts.set(`${chain}::${(address || "").toLowerCase()}`, true);
}

export function clearUsableStarts() {
  usableStarts.clear();
}

/// 経路の始点に使えるか。桁数と価格が揃っているものだけ true。
/// フラッシュスワップ方式では「借りられるか」ではなく「判定できるか」が基準。
export function isBorrowable(chain, address) {
  return usableStarts.has(`${chain}::${(address || "").toLowerCase()}`);
}

export function countUsableStarts(chain = null) {
  if (!chain) return usableStarts.size;
  let n = 0;
  for (const key of usableStarts.keys()) if (key.startsWith(`${chain}::`)) n++;
  return n;
}

/// チェーンごとの「包んだ基軸通貨」の記号。**住所は上の表から引く**(二重に書かない)。
const WRAPPED_NATIVE_SYMBOL = {
  base: "WETH", optimism: "WETH", arbitrum: "WETH",
  polygon: "WMATIC", avalanche: "WAVAX", ethereum: "WETH",
};

/// **ネイティブ通貨を表す住所。**
///
/// [なぜ要るか(2026年9月22日、UniswapX の計測で判明)]
/// UniswapX は出力に**ネイティブ ETH** を指定できる。その時トークンの住所は
/// **ゼロ住所**になる。我々の地図には WETH しか無いので、
/// `USDC → ETH`(base でいちばん多い取引)を**1件も見られていなかった**。
/// 経路なしで落ちた組の筆頭が **$25,266ぶん(6件)** の `USDC → 0x0000…` だった。
///
/// `0xEeee…` を使う実装もあるので両方見る。
const NATIVE_SENTINELS = new Set([
  "0x0000000000000000000000000000000000000000",
  "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
]);

/// そのチェーンの「包んだ基軸通貨」の住所。分からなければ null。
export function getWrappedNative(chain) {
  const sym = WRAPPED_NATIVE_SYMBOL[(chain || "").toLowerCase()];
  if (!sym) return null;
  for (const [address, meta] of Object.entries(getKnownTokens(chain))) {
    if (meta?.symbol === sym) return address.toLowerCase();
  }
  return null;
}

/// ネイティブ通貨の住所か。
export function isNativeToken(address) {
  return NATIVE_SENTINELS.has(String(address || "").toLowerCase());
}

/// **ネイティブ通貨の住所を、そのチェーンの包んだ版に読み替える。**
/// それ以外はそのまま返す(小文字にするだけ)。
///
/// 読み替えられない時(知らないチェーン等)は **null を返す**。
/// 元の住所をそのまま返すと、**存在しないプールを探し続ける**ことになる。
export function toWrappedToken(chain, address) {
  const a = String(address || "").toLowerCase();
  if (!a) return null;
  if (!isNativeToken(a)) return a;
  return getWrappedNative(chain);
}
