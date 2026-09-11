// chain-config.js
//
// 対応チェーンごとの設定を一元管理する。
//
// [RPCの割り当て方針]
// Chainstackの無料枠はノード1つ。無料の代替が存在しないPolygonに割り当て、
// Baseは公式の公開RPCで十分安定して動いている。
//
// rpcUrls は候補の配列。一定回数連続で失敗したら次の候補へ自動切替する
// (scripts/onchain-reserves.js)。未確認のURLは入れない。
//
// [Arbitrum追加] 候補の19%(13件)がArbitrumだったが、ここに未登録だった
// ため実行判定が何のログも残さず終了し、+$2.46の機会を取り逃していた。

import { AaveV3Base, AaveV3Polygon, AaveV3Optimism, AaveV3Avalanche, AaveV3Arbitrum } from "@aave-dao/aave-address-book";

const POLYGON_RPCS = [
  process.env.POLYGON_RPC_URL,
  "https://polygon-rpc.com",
  "https://1rpc.io/matic",
].filter(Boolean);

export const CHAIN_CONFIG = {
  base: {
    chainId: 8453,
    rpcUrls: ["https://mainnet.base.org"],
    aavePoolAddressesProvider: AaveV3Base.POOL_ADDRESSES_PROVIDER,
    contractAddressEnvVar: "MAINNET_CONTRACT_ADDRESS_BASE",
    explorerTxUrl: (hash) => `https://basescan.org/tx/${hash}`,
  },
  polygon: {
    chainId: 137,
    rpcUrls: POLYGON_RPCS,
    aavePoolAddressesProvider: AaveV3Polygon.POOL_ADDRESSES_PROVIDER,
    contractAddressEnvVar: "MAINNET_CONTRACT_ADDRESS_POLYGON",
    explorerTxUrl: (hash) => `https://polygonscan.com/tx/${hash}`,
  },
  arbitrum: {
    chainId: 42161,
    rpcUrls: ["https://arb1.arbitrum.io/rpc"],
    aavePoolAddressesProvider: AaveV3Arbitrum.POOL_ADDRESSES_PROVIDER,
    contractAddressEnvVar: "MAINNET_CONTRACT_ADDRESS_ARBITRUM",
    explorerTxUrl: (hash) => `https://arbiscan.io/tx/${hash}`,
  },
  optimism: {
    chainId: 10,
    rpcUrls: ["https://mainnet.optimism.io"],
    aavePoolAddressesProvider: AaveV3Optimism.POOL_ADDRESSES_PROVIDER,
    contractAddressEnvVar: "MAINNET_CONTRACT_ADDRESS_OPTIMISM",
    explorerTxUrl: (hash) => `https://optimistic.etherscan.io/tx/${hash}`,
  },
  avalanche: {
    chainId: 43114,
    rpcUrls: ["https://api.avax.network/ext/bc/C/rpc"],
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
