// chain-config.js
//
// 対応チェーンごとの設定(RPC URL・AaveのPoolAddressesProvider・
// デプロイ済みコントラクトアドレスを保存する環境変数名)を一元管理する。
// ここに無いチェーンは、まだコントラクト未対応という意味になる。
//
// rpcUrls は候補を複数持つ。公開RPCは予告なく403/410を返したり
// APIキー必須に変わったりするため(実際にpolygon-rpc.com・llamarpc・
// ankr・1rpc.ioが順に使えなくなった)、1つに依存しない構成にしている。
// ethersのFallbackProviderが、生きているものを自動的に使う。

import { AaveV3Base, AaveV3Polygon, AaveV3Optimism, AaveV3Avalanche } from "@aave-dao/aave-address-book";

export const CHAIN_CONFIG = {
  base: {
    rpcUrls: [
      "https://base-mainnet.core.chainstack.com/cbbd2d6beeb51cd356d3f2b3d13ccbd4",
      "https://mainnet.base.org",
      "https://base.publicnode.com",
    ],
    aavePoolAddressesProvider: AaveV3Base.POOL_ADDRESSES_PROVIDER,
    contractAddressEnvVar: "MAINNET_CONTRACT_ADDRESS_BASE",
    explorerTxUrl: (hash) => `https://basescan.org/tx/${hash}`,
  },
  polygon: {
    rpcUrls: [
      "https://polygon-bor-rpc.publicnode.com",
      "https://rpc.nodeflare.app/polygon/public",
      "https://polygon-rpc.com",
      "https://1rpc.io/matic",
    ],
    aavePoolAddressesProvider: AaveV3Polygon.POOL_ADDRESSES_PROVIDER,
    contractAddressEnvVar: "MAINNET_CONTRACT_ADDRESS_POLYGON",
    explorerTxUrl: (hash) => `https://polygonscan.com/tx/${hash}`,
  },
  optimism: {
    rpcUrls: [
      "https://mainnet.optimism.io",
      "https://optimism-rpc.publicnode.com",
    ],
    aavePoolAddressesProvider: AaveV3Optimism.POOL_ADDRESSES_PROVIDER,
    contractAddressEnvVar: "MAINNET_CONTRACT_ADDRESS_OPTIMISM",
    explorerTxUrl: (hash) => `https://optimistic.etherscan.io/tx/${hash}`,
  },
  avalanche: {
    rpcUrls: [
      "https://api.avax.network/ext/bc/C/rpc",
      "https://avalanche-c-chain-rpc.publicnode.com",
    ],
    aavePoolAddressesProvider: AaveV3Avalanche.POOL_ADDRESSES_PROVIDER,
    contractAddressEnvVar: "MAINNET_CONTRACT_ADDRESS_AVALANCHE",
    explorerTxUrl: (hash) => `https://snowtrace.io/tx/${hash}`,
  },
};

export function getChainConfig(chain) {
  const config = CHAIN_CONFIG[(chain || "").toLowerCase()];
  if (!config) return null;
  // 既存コードとの互換のため、rpcUrl(単数)も先頭のURLで提供する。
  return { ...config, rpcUrl: config.rpcUrls[0] };
}
