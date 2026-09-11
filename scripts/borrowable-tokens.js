// scripts/borrowable-tokens.js
//
// フラッシュローンで借りられるトークンの一覧。
//
// Aave V3が各チェーンで扱う主要通貨に限られる。裁定の起点(借りて返す通貨)は
// 必ずこの中から選ぶ必要がある。アドレスは各チェーンの公式トークンアドレス。
//
// stable: 価格が$1に連動する通貨。USD換算価格を1として扱える。
// priceHintUsd: 非安定通貨の初期値。起動時に実際のプールから実測して上書きする。

const BORROWABLE = {
  base: {
    "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913": { symbol: "USDC", decimals: 6, stable: true },
    "0x4200000000000000000000000000000000000006": { symbol: "WETH", decimals: 18, stable: false, priceHintUsd: 2500 },
    "0x50c5725949a6f0c72e6c4a641f24049a917db0cb": { symbol: "DAI", decimals: 18, stable: true },
    "0xcbb7c0000ab88b473b1f5afd9ef808440eed33bf": { symbol: "cbBTC", decimals: 8, stable: false, priceHintUsd: 95000 },
  },
  polygon: {
    "0x3c499c542cef5e3811e1192ce70d8cc03d5c3359": { symbol: "USDC", decimals: 6, stable: true },
    "0x2791bca1f2de4661ed88a30c99a7a9449aa84174": { symbol: "USDC.e", decimals: 6, stable: true },
    "0xc2132d05d31c914a87c6611c10748aeb04b58e8f": { symbol: "USDT", decimals: 6, stable: true },
    "0x8f3cf7ad23cd3cadbd9735aff958023239c6a063": { symbol: "DAI", decimals: 18, stable: true },
    "0x7ceb23fd6bc0add59e62ac25578270cff1b9f619": { symbol: "WETH", decimals: 18, stable: false, priceHintUsd: 2500 },
    "0x0d500b1d8e8ef31e21c99d1db9a6444d3adf1270": { symbol: "WMATIC", decimals: 18, stable: false, priceHintUsd: 0.25 },
    "0x1bfd67037b42cf73acf2047067bd4f2c47d9bfd6": { symbol: "WBTC", decimals: 8, stable: false, priceHintUsd: 95000 },
  },
  arbitrum: {
    "0xaf88d065e77c8cc2239327c5edb3a432268e5831": { symbol: "USDC", decimals: 6, stable: true },
    "0xff970a61a04b1ca14834a43f5de4533ebddb5cc8": { symbol: "USDC.e", decimals: 6, stable: true },
    "0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9": { symbol: "USDT", decimals: 6, stable: true },
    "0xda10009cbd5d07dd0cecc66161fc93d7c9000da1": { symbol: "DAI", decimals: 18, stable: true },
    "0x82af49447d8a07e3bd95bd0d56f35241523fbab1": { symbol: "WETH", decimals: 18, stable: false, priceHintUsd: 2500 },
    "0x2f2a2543b76a4166549f7aab2e75bef0aefc5b0f": { symbol: "WBTC", decimals: 8, stable: false, priceHintUsd: 95000 },
  },
  optimism: {
    "0x0b2c639c533813f4aa9d7837caf62653d097ff85": { symbol: "USDC", decimals: 6, stable: true },
    "0x7f5c764cbc14f9669b88837ca1490cca17c31607": { symbol: "USDC.e", decimals: 6, stable: true },
    "0x94b008aa00579c1307b0ef2c499ad98a8ce58e58": { symbol: "USDT", decimals: 6, stable: true },
    "0xda10009cbd5d07dd0cecc66161fc93d7c9000da1": { symbol: "DAI", decimals: 18, stable: true },
    "0x4200000000000000000000000000000000000006": { symbol: "WETH", decimals: 18, stable: false, priceHintUsd: 2500 },
  },
  avalanche: {
    "0xb97ef9ef8734c71904d8002f8b6bc66dd9c48a6e": { symbol: "USDC", decimals: 6, stable: true },
    "0x9702230a8ea53601f5cd2dc00fdbc13d4df4a8c7": { symbol: "USDT", decimals: 6, stable: true },
    "0xd586e7f844cea2f87f50152665bcbc2c279d8d70": { symbol: "DAI.e", decimals: 18, stable: true },
    "0xb31f66aa3c1e785363f0875a1b74e27b85fd66c7": { symbol: "WAVAX", decimals: 18, stable: false, priceHintUsd: 20 },
  },
};

export function getBorrowableTokens(chain) {
  return BORROWABLE[(chain || "").toLowerCase()] ?? {};
}

export function isBorrowable(chain, token) {
  return Boolean(BORROWABLE[(chain || "").toLowerCase()]?.[(token || "").toLowerCase()]);
}

export function getTokenInfo(chain, token) {
  return BORROWABLE[(chain || "").toLowerCase()]?.[(token || "").toLowerCase()] ?? null;
}
