// chain-config.js
//
// 対応チェーンごとの設定を一元管理する。
//
// [RPCの割り当て方針]
// Chainstackの無料枠はノード1つ。そこで「無料の代替が存在しないチェーン」に
// 優先して割り当てる:
//   Base    … 公式 mainnet.base.org が安定稼働。無料で十分。
//   Polygon … 公式は401、1rpc.ioは利用上限。無料の選択肢が尽きたため
//             Chainstackを割り当てる(POLYGON_RPC_URL 環境変数で指定)。
//
// rpcUrls は候補の配列。一定回数連続で失敗したら次の候補へ自動切替する
// (scripts/onchain-reserves.js)。未確認のURLは入れない(存在しない
// ホストへのリトライでログが埋まるため)。

import { AaveV3Base, AaveV3Polygon, AaveV3Optimism, AaveV3Avalanche } from "@aave-dao/aave-address-book";

// Chainstackの新しいPolygonノードは環境変数で渡す。
// 未設定の間は公開RPCのみで動作する(設定後に自動的に最優先で使われる)。
const POLYGON_RPCS = [
  process.env.POLYGON_RPC_URL,
  "https://polygon-rpc.com",
  "https://1rpc.io/matic",
].filter(Boolean);

export const CHAIN_CONFIG = {
  base: {
    chainId: 8453,
    rpcUrls: [
      "https://mainnet.base.org",
      "https://base.llamarpc.com",
    ],
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
