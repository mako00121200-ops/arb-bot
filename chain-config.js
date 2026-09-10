// chain-config.js
//
// 対応チェーンごとの設定(RPC URL・AaveのPoolAddressesProvider・
// デプロイ済みコントラクトアドレスを保存する環境変数名)を一元管理する。
//
// rpcUrls には「このシステムで実際に動作確認できたURLだけ」を入れる。
// 未確認のURLを候補に入れると、存在しないホストへの接続リトライが
// 大量に発生してログが埋まるため(実際に発生させてしまった)。
// 各チェーンの先頭が主に使われ、応答しない場合に次の候補へ切り替わる。

import { AaveV3Base, AaveV3Polygon, AaveV3Optimism, AaveV3Avalanche } from "@aave-dao/aave-address-book";

export const CHAIN_CONFIG = {
  base: {
    // Chainstackの自前ノード(WebSocket監視でも使用中、実績あり)を優先し、
    // 応答しない場合にBase公式の公開RPCへ切り替える。
    rpcUrls: [
      "https://base-mainnet.core.chainstack.com/cbbd2d6beeb51cd356d3f2b3d13ccbd4",
      "https://mainnet.base.org",
    ],
    aavePoolAddressesProvider: AaveV3Base.POOL_ADDRESSES_PROVIDER,
    contractAddressEnvVar: "MAINNET_CONTRACT_ADDRESS_BASE",
    explorerTxUrl: (hash) => `https://basescan.org/tx/${hash}`,
  },
  polygon: {
    // 1rpc.ioはコントラクトのデプロイに成功した実績があるが、
    // 読み取りで403を返すことがあるため、Polygon公式も候補に入れる。
    rpcUrls: [
      "https://1rpc.io/matic",
      "https://polygon-rpc.com",
    ],
    aavePoolAddressesProvider: AaveV3Polygon.POOL_ADDRESSES_PROVIDER,
    contractAddressEnvVar: "MAINNET_CONTRACT_ADDRESS_POLYGON",
    explorerTxUrl: (hash) => `https://polygonscan.com/tx/${hash}`,
  },
  optimism: {
    rpcUrls: ["https://mainnet.optimism.io"],
    aavePoolAddressesProvider: AaveV3Optimism.POOL_ADDRESSES_PROVIDER,
    contractAddressEnvVar: "MAINNET_CONTRACT_ADDRESS_OPTIMISM",
    explorerTxUrl: (hash) => `https://optimistic.etherscan.io/tx/${hash}`,
  },
  avalanche: {
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
