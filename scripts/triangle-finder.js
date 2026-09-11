// scripts/triangle-finder.js
//
// 三角裁定の経路(A → B → C → A)を、既に登録済みの「実行可能ペア」から
// 自動的に組み立てる。
//
// [考え方]
// 実行可能ペアは「準備量を読めたプール」の集まりなので、そこに含まれる
// プールを辺、トークンを頂点とみなしてグラフを作り、長さ3の閉路を探す。
// 新たなAPI呼び出しは不要で、既存の資産をそのまま使える。
//
// [借りる通貨の選び方]
// フラッシュローンで借りられるのはAaveが扱う主要通貨に限られる。
// 閉路の中にその通貨が含まれる場合だけ、そこを起点(tokenA)として採用する。

import { getVerifiedPairs } from "./verified-pairs.js";

// Aave V3が各チェーンで扱う主要通貨(フラッシュローンで借りられるもの)。
// シンボルではなくアドレスで持つ。小文字で統一。
const BORROWABLE = {
  base: {
    "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913": { symbol: "USDC", decimals: 6 },
    "0x4200000000000000000000000000000000000006": { symbol: "WETH", decimals: 18 },
  },
  polygon: {
    "0x3c499c542cef5e3811e1192ce70d8cc03d5c3359": { symbol: "USDC", decimals: 6 },
    "0x2791bca1f2de4661ed88a30c99a7a9449aa84174": { symbol: "USDC.e", decimals: 6 },
    "0x7ceb23fd6bc0add59e62ac25578270cff1b9f619": { symbol: "WETH", decimals: 18 },
    "0xc2132d05d31c914a87c6611c10748aeb04b58e8f": { symbol: "USDT", decimals: 6 },
    "0x0d500b1d8e8ef31e21c99d1db9a6444d3adf1270": { symbol: "WMATIC", decimals: 18 },
  },
  arbitrum: {
    "0xaf88d065e77c8cc2239327c5edb3a432268e5831": { symbol: "USDC", decimals: 6 },
    "0x82af49447d8a07e3bd95bd0d56f35241523fbab1": { symbol: "WETH", decimals: 18 },
    "0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9": { symbol: "USDT", decimals: 6 },
  },
  optimism: {
    "0x0b2c639c533813f4aa9d7837caf62653d097ff85": { symbol: "USDC", decimals: 6 },
    "0x4200000000000000000000000000000000000006": { symbol: "WETH", decimals: 18 },
  },
  avalanche: {
    "0xb97ef9ef8734c71904d8002f8b6bc66dd9c48a6e": { symbol: "USDC", decimals: 6 },
    "0xb31f66aa3c1e785363f0875a1b74e27b85fd66c7": { symbol: "WAVAX", decimals: 18 },
  },
};

export function isBorrowable(chain, token) {
  return BORROWABLE[(chain || "").toLowerCase()]?.[(token || "").toLowerCase()] ?? null;
}

/// 登録済みの実行可能ペアから、三角経路の一覧を組み立てる。
/// 戻り値: evaluateTriangle に渡せる形の配列。
export function findTriangles() {
  const pairs = getVerifiedPairs();

  // チェーンごとに「トークン → 繋がっている相手と、そのプール」の対応表を作る。
  const graphByChain = new Map();
  const tokenMeta = new Map(); // "chain::token" -> { decimals, symbol, priceUsdPerY }

  for (const pair of pairs) {
    const chain = pair.chain;
    if (!graphByChain.has(chain)) graphByChain.set(chain, new Map());
    const graph = graphByChain.get(chain);

    const a = pair.tokenA.toLowerCase(), b = pair.tokenB.toLowerCase();
    // 同じペアに複数プールがある場合は、手数料が最も安いものを代表とする。
    const bestPool = [...pair.pools].sort((x, y) => (x.feeBps ?? 30) - (y.feeBps ?? 30))[0];
    if (!bestPool) continue;

    if (!graph.has(a)) graph.set(a, new Map());
    if (!graph.has(b)) graph.set(b, new Map());
    graph.get(a).set(b, bestPool);
    graph.get(b).set(a, bestPool);

    // トークンの桁数とUSD価格を控えておく(pairの記録から流用)。
    tokenMeta.set(`${chain}::${a}`, { decimals: pair.decimalsX, symbol: pair.symbol.split("-")[0] });
    tokenMeta.set(`${chain}::${b}`, { decimals: pair.decimalsY, symbol: pair.symbol.split("-")[1] || "?", priceUsd: pair.priceUsdPerY });
  }

  const triangles = [];
  const seen = new Set();

  for (const [chain, graph] of graphByChain.entries()) {
    for (const [tokenA, neighborsA] of graph.entries()) {
      // 起点は「フラッシュローンで借りられる通貨」に限る。
      const borrowInfo = isBorrowable(chain, tokenA);
      if (!borrowInfo) continue;

      for (const [tokenB, pool1] of neighborsA.entries()) {
        const neighborsB = graph.get(tokenB);
        if (!neighborsB) continue;

        for (const [tokenC, pool2] of neighborsB.entries()) {
          if (tokenC === tokenA || tokenC === tokenB) continue;
          const pool3 = graph.get(tokenC)?.get(tokenA);
          if (!pool3) continue;
          // 同じプールを2回以上使う経路は無効。
          const addrs = [pool1.address, pool2.address, pool3.address].map((x) => x.toLowerCase());
          if (new Set(addrs).size < 3) continue;

          // 向きの違う同じ経路は1つにまとめる。
          const key = `${chain}::${[tokenA, tokenB, tokenC].sort().join("|")}::${addrs.sort().join("|")}`;
          if (seen.has(key)) continue;
          seen.add(key);

          // 借りる通貨のUSD価格。安定通貨は1ドル、それ以外は記録から引く。
          const metaA = tokenMeta.get(`${chain}::${tokenA}`);
          let priceUsdPerA = null;
          if (/^USD/i.test(borrowInfo.symbol)) priceUsdPerA = 1;
          else if (metaA?.priceUsd) priceUsdPerA = metaA.priceUsd;
          if (!priceUsdPerA || !isFinite(priceUsdPerA) || priceUsdPerA <= 0) continue;

          triangles.push({
            chain,
            tokenA, tokenB, tokenC,
            symbolA: borrowInfo.symbol,
            symbolB: tokenMeta.get(`${chain}::${tokenB}`)?.symbol ?? "?",
            symbolC: tokenMeta.get(`${chain}::${tokenC}`)?.symbol ?? "?",
            decimalsA: borrowInfo.decimals,
            priceUsdPerA,
            pools: [
              { address: pool1.address, feeBps: pool1.feeBps ?? 30 },
              { address: pool2.address, feeBps: pool2.feeBps ?? 30 },
              { address: pool3.address, feeBps: pool3.feeBps ?? 30 },
            ],
          });
        }
      }
    }
  }

  return triangles;
}

export function getTriangleCount() {
  try { return findTriangles().length; } catch (e) { return 0; }
}
