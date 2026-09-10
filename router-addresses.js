// router-addresses.js
//
// 実際に調査・確認済みのDEXルーターアドレスと、その呼び出し形式・手数料。
// チェーン名・dexId(小文字)をキーに引く。ここに無い組み合わせは、
// まだ実行対象にできないという意味(観測は続けるが、実行はまだしない)。
//
// kind は呼び出し形式:
//   "uniswapV2" … 経路を address[] で渡す従来型(uniswap, quickswap 等)
//   "solidly"   … 経路を Route構造体(from,to,stable,factory)で渡す型
//                 (Aerodrome on Base, Velodrome on Optimism)
// この2つは互換性が無く、形式を間違えると呼び出しが必ず失敗する。
//
// feeBps は手数料(1bps = 0.01%)。Solidly系は volatile プール(x*y=k)が
// 0.3%、stable プールが 0.05% で、本システムは volatile のみを対象と
// しているため 30bps を使う。
//
// 各アドレスの確認方法(2026年9月時点):
// - Base/Aerodrome: 実際のトランザクション例付きの技術記事で確認
// - Base・Arbitrum・Avalanche/Uniswap V2: Uniswap公式ドキュメントの
//   複数チェーン対応表で確認(3チェーンとも同一アドレス)
// - Optimism/Uniswap V2、Polygon/Uniswap V2: 同じくUniswap公式
//   ドキュメントの複数チェーン対応表で確認(チェーンごとに別アドレス)
// - Polygon/QuickSwap: QuickSwap公式GitHubリポジトリ + 実際の取引データで確認
// - Optimism/Velodrome: Velodrome公式GitHubリポジトリで確認
// - Avalanche/TraderJoe: Snowtrace上のラベル付きトランザクション履歴で確認
//   (V1・旧式のみ。V2のLiquidity Bookは計算式が異なるため非対応)
export const ROUTER_ADDRESSES = {
  base: {
    aerodrome: { address: "0xcF77a3Ba9A5CA399B7c97c74d54e5b1Beb874E43", kind: "solidly", feeBps: 30 },
    uniswap: { address: "0x4752ba5dbc23f44d87826276bf6fd6b1c372ad24", kind: "uniswapV2", feeBps: 30 },
  },
  polygon: {
    quickswap: { address: "0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff", kind: "uniswapV2", feeBps: 30 },
    uniswap: { address: "0xedf6066a2b290C185783862C7F4776A2C8077AD1", kind: "uniswapV2", feeBps: 30 },
  },
  optimism: {
    velodrome: { address: "0xa062aE8A9c5e11aaA026fc2670B0D65cCc8B2858", kind: "solidly", feeBps: 30 },
    uniswap: { address: "0x4A7b5Da61326A6379179b40d00F57E5bbDC962c2", kind: "uniswapV2", feeBps: 30 },
  },
  avalanche: {
    traderjoe: { address: "0x60ae616a2155ee3d9a68541ba4544862310933d4", kind: "uniswapV2", feeBps: 30 },
    uniswap: { address: "0x4752ba5dbc23f44d87826276bf6fd6b1c372ad24", kind: "uniswapV2", feeBps: 30 },
  },
  arbitrum: {
    uniswap: { address: "0x4752ba5dbc23f44d87826276bf6fd6b1c372ad24", kind: "uniswapV2", feeBps: 30 },
  },
};

// コントラクトのenum RouterKind と対応させる(0 = UniswapV2, 1 = Solidly)。
export const ROUTER_KIND_ENUM = { uniswapV2: 0, solidly: 1 };

export function getRouterInfo(chain, dexId) {
  const chainKey = (chain || "").toLowerCase();
  const dexKey = (dexId || "").toLowerCase();
  return ROUTER_ADDRESSES[chainKey]?.[dexKey] ?? null;
}

// 互換用: アドレスだけを返す旧来の呼び出し。
export function getRouterAddress(chain, dexId) {
  return getRouterInfo(chain, dexId)?.address ?? null;
}
