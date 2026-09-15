// chain-config.js
//
// 対応チェーンごとの設定を一元管理する。
//
// [RPCの割り当て]
// 環境変数 <CHAIN>_RPC_URL があればそれを最優先で使い、無ければ公開RPCへ。
// 公開RPCは遅く、Syncで発見される大量のプールの取込・手数料実測に追いつけず
// 待ち行列が87,000件まで膨らんだ(2026年9月15日)。速いRPCを使えるチェーンは
// 必ず環境変数で指定する。
//
// rpcUrls は候補の配列。一定回数連続で失敗したら次の候補へ自動切替する
// (scripts/onchain-reserves.js)。未確認のURLは入れない。

import { AaveV3Base, AaveV3Polygon, AaveV3Optimism, AaveV3Avalanche, AaveV3Arbitrum } from "@aave-dao/aave-address-book";

function withEnvFirst(envName, publicUrls) {
  const custom = process.env[envName];
  return custom ? [custom, ...publicUrls] : publicUrls;
}

export const CHAIN_CONFIG = {
  base: {
    chainId: 8453,
    rpcUrls: withEnvFirst("BASE_RPC_URL", ["https://mainnet.base.org"]),
    aavePoolAddressesProvider: AaveV3Base.POOL_ADDRESSES_PROVIDER,
    contractAddressEnvVar: "MAINNET_CONTRACT_ADDRESS_BASE",
    explorerTxUrl: (hash) => `https://basescan.org/tx/${hash}`,
  },
  polygon: {
    chainId: 137,
    rpcUrls: withEnvFirst("POLYGON_RPC_URL", ["https://polygon-rpc.com", "https://1rpc.io/matic"]),
    aavePoolAddressesProvider: AaveV3Polygon.POOL_ADDRESSES_PROVIDER,
    contractAddressEnvVar: "MAINNET_CONTRACT_ADDRESS_POLYGON",
    explorerTxUrl: (hash) => `https://polygonscan.com/tx/${hash}`,
  },
  arbitrum: {
    chainId: 42161,
    rpcUrls: withEnvFirst("ARBITRUM_RPC_URL", ["https://arb1.arbitrum.io/rpc"]),
    aavePoolAddressesProvider: AaveV3Arbitrum.POOL_ADDRESSES_PROVIDER,
    contractAddressEnvVar: "MAINNET_CONTRACT_ADDRESS_ARBITRUM",
    explorerTxUrl: (hash) => `https://arbiscan.io/tx/${hash}`,
  },
  optimism: {
    chainId: 10,
    rpcUrls: withEnvFirst("OPTIMISM_RPC_URL", ["https://mainnet.optimism.io"]),
    aavePoolAddressesProvider: AaveV3Optimism.POOL_ADDRESSES_PROVIDER,
    contractAddressEnvVar: "MAINNET_CONTRACT_ADDRESS_OPTIMISM",
    explorerTxUrl: (hash) => `https://optimistic.etherscan.io/tx/${hash}`,
  },
  avalanche: {
    chainId: 43114,
    rpcUrls: withEnvFirst("AVALANCHE_RPC_URL", ["https://api.avax.network/ext/bc/C/rpc"]),
    aavePoolAddressesProvider: AaveV3Avalanche.POOL_ADDRESSES_PROVIDER,
    contractAddressEnvVar: "MAINNET_CONTRACT_ADDRESS_AVALANCHE",
    explorerTxUrl: (hash) => `https://snowtrace.io/tx/${hash}`,
  },
};

export function getChainConfig(chain) {
  const config = CHAIN_CONFIG[(chain || "").toLowerCase()];
  if (!config) return null;
  return { ...config, rpcUrl: config.rpcUrls[0] };
}
