// chain-config.js
//
// 対応チェーンごとの設定を一元管理する。
//
// [稼働させるチェーンの選択(2026年9月16日)]
// 環境変数 ACTIVE_CHAINS に、稼働させるチェーンをカンマ区切りで指定する
// (例: polygon,arbitrum,avalanche)。未指定なら全チェーン。
// Base/Optimismは、2社がMEV抽出の8〜9割を占める最激戦区で、Aerodrome/
// Velodromeの手数料1%も壁になるため停止した。設定を残しておけば、
// 環境変数を変えるだけで再開できる。
//
// [チェーン選定の経緯]
// 当初の5チェーンは「Aave V3がある・ガスが安い」という初期設計(Aaveの
// フラッシュローン)の制約で選ばれた。現在はフラッシュスワップ方式なので
// Aaveは不要になり、V2/V3形式のプールがあるチェーンなら追加できる。
// aavePoolAddressesProvider は旧設計との互換のために残している。
//
// [RPCの割り当て]
// 環境変数 <CHAIN>_RPC_URL があればそれを最優先で使い、無ければ公開RPCへ。
// 空文字を設定すると公開RPCに戻る。速いRPCを使えるチェーンは必ず環境変数で
// 指定する(公開RPCでは待ち行列が87,000件まで膨らんだ)。
//
// rpcUrls は候補の配列。一定回数連続で失敗したら次の候補へ自動切替する
// (scripts/onchain-reserves.js)。未確認のURLは入れない。

import { AaveV3Base, AaveV3Polygon, AaveV3Optimism, AaveV3Avalanche, AaveV3Arbitrum } from "@aave-dao/aave-address-book";

function withEnvFirst(envName, publicUrls) {
  const custom = (process.env[envName] || "").trim();
  return custom ? [custom, ...publicUrls] : publicUrls;
}

export const ALL_CHAIN_CONFIG = {
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
  // [2026年9月25日に追加、オーナーの指示「HyperEVM も取り入れたい」]
  // 一晩の値動き調査(STRATEGY-RESEARCH §19)で、WHYPE/USDC が8つの DEX に分かれている
  // = avalanche の夜と同じ形だったチェーン。**HYPEREVM_RPC_URL が設定されている時だけ載せる**
  // (公開 RPC は1分100回までで WebSocket も無く、常時の監視には足りないため)。
  // chain id 999(mds1/multicall3 の deployments.json でも HyperEVM = 999)。
  ...((process.env.HYPEREVM_RPC_URL || "").trim() ? {
    hyperevm: {
      chainId: 999,
      rpcUrls: withEnvFirst("HYPEREVM_RPC_URL", ["https://rpc.hyperliquid.xyz/evm"]),
      aavePoolAddressesProvider: null,
      contractAddressEnvVar: "MAINNET_CONTRACT_ADDRESS_HYPEREVM",
      explorerTxUrl: (hash) => `https://hyperevmscan.io/tx/${hash}`,
    },
  } : {}),
};

function selectActiveChains() {
  const raw = (process.env.ACTIVE_CHAINS || "").trim();
  if (!raw) return ALL_CHAIN_CONFIG;
  const wanted = raw.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  const out = {};
  for (const name of wanted) {
    if (ALL_CHAIN_CONFIG[name]) out[name] = ALL_CHAIN_CONFIG[name];
    else console.warn(`[チェーン設定] ACTIVE_CHAINS に未対応のチェーン名: ${name}(無視します)`);
  }
  if (Object.keys(out).length === 0) {
    console.warn("[チェーン設定] ACTIVE_CHAINS に有効なチェーンが無いため、全チェーンで稼働します");
    return ALL_CHAIN_CONFIG;
  }
  const stopped = Object.keys(ALL_CHAIN_CONFIG).filter((c) => !out[c]);
  console.log(`[チェーン設定] 稼働: ${Object.keys(out).join(", ")} / 停止: ${stopped.join(", ") || "なし"}`);
  return out;
}

/// 稼働中のチェーンだけ。全ての監視・判定・実行はここを基準に回る。
export const CHAIN_CONFIG = selectActiveChains();

export function getChainConfig(chain) {
  const config = CHAIN_CONFIG[(chain || "").toLowerCase()];
  if (!config) return null;
  return { ...config, rpcUrl: config.rpcUrls[0] };
}

/// 停止中のチェーンも含めて設定を返す(デプロイ用)。
export function getAnyChainConfig(chain) {
  const config = ALL_CHAIN_CONFIG[(chain || "").toLowerCase()];
  if (!config) return null;
  return { ...config, rpcUrl: config.rpcUrls[0] };
}
