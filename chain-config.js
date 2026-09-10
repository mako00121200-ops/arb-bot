// chain-config.js
//
// 対応チェーンごとの設定を一元管理する。
//
// rpcUrls は候補の配列。公開RPCは予告なく利用上限・403・障害に当たるため
// (polygon-rpc.com・llamarpc・ankr・1rpc.io が順に使えなくなった実績あり)、
// 1つに依存しない。切り替えは scripts/onchain-reserves.js が行い、
// エラーが続いたRPCを自動的に次の候補へ回す。
//
// 注意: 未確認のURLを候補に入れると、存在しないホストへの接続リトライで
// ログが埋まる。ここには実在を確認できたものだけを置く。

import { AaveV3Base, AaveV3Polygon, AaveV3Optimism, AaveV3Avalanche } from "@aave-dao/aave-address-book";

export const CHAIN_CONFIG = {
  base: {
    chainId: 8453,
    rpcUrls: [
      "https://base-mainnet.core.chainstack.com/cbbd2d6beeb51cd356d3f2b3d13ccbd4",
      "https://mainnet.base.org",
    ],
    aavePoolAddressesProvider: AaveV3Base.POOL_ADDRESSES_PROVIDER,
    contractAddressEnvVar: "MAINNET_CONTRACT_ADDRESS_BASE",
    explorerTxUrl: (hash) => `https://basescan.org/tx/${hash}`,
  },
  polygon: {
    chainId: 137,
    // 1rpc.ioは無料枠の上限に達したため後方へ。公式RPCを先に試す。
    rpcUrls: [
      "https://polygon-rpc.com",
      "https://1rpc.io/matic",
    ],
    aavePoolAddressesProvider: AaveV3Polygon.POOL_ADDRESSES_PROVIDER,
    contractAddressEnvVar: "MAINNET_CONTRACT_ADDRESS_POLYGON",
    explorerTxUrl: (hash) => `https://polygonscan.com/tx/${hash}`,
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
