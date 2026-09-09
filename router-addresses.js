// router-addresses.js
//
// 実際に調査・確認済みのDEXルーターアドレス一覧。
// チェーン名・dexId(小文字)をキーに、実行時にexecuteArbへ渡すルーター
// アドレスを引くために使う。ここに無い組み合わせは、まだ実行対象に
// できないという意味(観測は続けるが、実行はまだしない)。
//
// 各アドレスの確認方法(2026年9月時点):
// - Base/Aerodrome: 実際のトランザクション例付きの技術記事で確認
// - Base・Arbitrum・Avalanche/Uniswap V2: Uniswap公式ドキュメントの
//   複数チェーン対応表で確認(3チェーンとも同一アドレス)
// - Optimism/Uniswap V2、Polygon/Uniswap V2: 同じくUniswap公式
//   ドキュメントの複数チェーン対応表で確認(チェーンごとに別アドレス)
// - Polygon/QuickSwap: QuickSwap公式GitHubリポジトリ + 実際の取引データで確認
// - Optimism/Velodrome: Velodrome公式GitHubリポジトリ(Optimistic Etherscan
//   リンク付き)で確認
// - Avalanche/TraderJoe: Snowtrace上で「Trader Joe: Router」とラベル付けされた
//   実際のトランザクション履歴で確認(V1・旧式のみ。V2のLiquidity Bookは
//   計算式が異なるため非対応)
export const ROUTER_ADDRESSES = {
  base: {
    aerodrome: "0xcF77a3Ba9A5CA399B7c97c74d54e5b1Beb874E43",
    uniswap: "0x4752ba5dbc23f44d87826276bf6fd6b1c372ad24",
  },
  polygon: {
    quickswap: "0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff",
    uniswap: "0xedf6066a2b290C185783862C7F4776A2C8077AD1",
  },
  optimism: {
    velodrome: "0xa062aE8A9c5e11aaA026fc2670B0D65cCc8B2858",
    uniswap: "0x4A7b5Da61326A6379179b40d00F57E5bbDC962c2",
  },
  avalanche: {
    traderjoe: "0x60ae616a2155ee3d9a68541ba4544862310933d4",
    uniswap: "0x4752ba5dbc23f44d87826276bf6fd6b1c372ad24",
  },
  arbitrum: {
    uniswap: "0x4752ba5dbc23f44d87826276bf6fd6b1c372ad24",
  },
};

export function getRouterAddress(chain, dexId) {
  const chainKey = (chain || "").toLowerCase();
  const dexKey = (dexId || "").toLowerCase();
  return ROUTER_ADDRESSES[chainKey]?.[dexKey] ?? null;
}
