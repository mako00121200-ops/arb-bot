// chain-config.js
//
// 対応チェーンごとの設定(RPC URL・AaveのPoolAddressesProvider・
// デプロイ済みコントラクトアドレスを保存する環境変数名)を一元管理する。
// ここに無いチェーンは、まだコントラクト未対応という意味になる。

import { AaveV3Base, AaveV3Polygon, AaveV3Optimism, AaveV3Avalanche } from "@aave-dao/aave-address-book";

export const CHAIN_CONFIG = {
  base: {
    rpcUrl: "https://mainnet.base.org",
    aavePoolAddressesProvider: AaveV3Base.POOL_ADDRESSES_PROVIDER,
    contractAddressEnvVar: "MAINNET_CONTRACT_ADDRESS_BASE",
    explorerTxUrl: (hash) => `https://basescan.org/tx/${hash}`,
  },
  polygon: {
    rpcUrl: "https://polygon.llamarpc.com",
    aavePoolAddressesProvider: AaveV3Polygon.POOL_ADDRESSES_PROVIDER,
    contractAddressEnvVar: "MAINNET_CONTRACT_ADDRESS_POLYGON",
    explorerTxUrl: (hash) => `https://polygonscan.com/tx/${hash}`,
  },
  optimism: {
    rpcUrl: "https://mainnet.optimism.io",
    aavePoolAddressesProvider: AaveV3Optimism.POOL_ADDRESSES_PROVIDER,
    contractAddressEnvVar: "MAINNET_CONTRACT_ADDRESS_OPTIMISM",
    explorerTxUrl: (hash) => `https://optimistic.etherscan.io/tx/${hash}`,
  },
  avalanche: {
    rpcUrl: "https://api.avax.network/ext/bc/C/rpc",
    aavePoolAddressesProvider: AaveV3Avalanche.POOL_ADDRESSES_PROVIDER,
    contractAddressEnvVar: "MAINNET_CONTRACT_ADDRESS_AVALANCHE",
    explorerTxUrl: (hash) => `https://snowtrace.io/tx/${hash}`,
  },
};

export function getChainConfig(chain) {
  return CHAIN_CONFIG[(chain || "").toLowerCase()] ?? null;
}
