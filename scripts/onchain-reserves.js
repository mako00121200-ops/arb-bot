// scripts/onchain-reserves.js
//
// プールの準備量(reserve)を、DexScreenerのAPIではなくチェーンから
// 直接読み取るための共通処理。
//
// [重要] Uniswap V2形式とSolidly形式(Aerodrome/Velodrome)では、
// 同じ getReserves() でも返ってくるデータの型が違う:
//   Uniswap V2 … (uint112, uint112, uint32)  ※packed形式
//   Solidly    … (uint256, uint256)          ※独立した2スロット
// V2形式のまま読むと解釈に失敗し "missing revert data" になる。
// これが、Aerodromeのプールを一切読めていなかった原因。
//
// getReservesに応答しないプール(Uniswap V3/V4、Balancer等)は、
// 両方の形式を試しても失敗するため、自然に除外される。
//
// [注意] 一時期ethersのFallbackProviderで複数RPCを束ねたが、
// ネットワーク種別の自動判定に失敗して大量のリトライログを発生させた。
// 単一接続 + チェーンIDの明示指定が確実。

import { ethers } from "ethers";
import { getChainConfig } from "../chain-config.js";

const PAIR_ABI_V2 = [
  "function getReserves() view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast)",
  "function token0() view returns (address)",
];
const PAIR_ABI_SOLIDLY = [
  "function getReserves() view returns (uint256 reserve0, uint256 reserve1)",
  "function token0() view returns (address)",
];
const ERC20_DECIMALS_ABI = ["function decimals() view returns (uint8)"];

const CHAIN_IDS = {
  base: 8453,
  polygon: 137,
  optimism: 10,
  avalanche: 43114,
};

const providerCache = new Map();

export function getProviderForChain(chain) {
  const config = getChainConfig(chain);
  if (!config) throw new Error(`未対応チェーン: ${chain}`);

  const key = (chain || "").toLowerCase();
  if (providerCache.has(key)) return providerCache.get(key);

  const chainId = CHAIN_IDS[key];
  const network = chainId ? ethers.Network.from(chainId) : undefined;
  const provider = new ethers.JsonRpcProvider(config.rpcUrl, network, {
    staticNetwork: network,
  });

  providerCache.set(key, provider);
  return provider;
}

// どちらの形式で読めたかを覚えておき、次回は最初からその形式で読む。
const poolFormatCache = new Map();

async function readReservesRaw(pairAddress, provider, chain) {
  const key = `${chain}:${pairAddress.toLowerCase()}`;
  const known = poolFormatCache.get(key);

  const tryV2 = async () => {
    const c = new ethers.Contract(pairAddress, PAIR_ABI_V2, provider);
    const [r, t0] = await Promise.all([c.getReserves(), c.token0()]);
    return { raw0: r[0], raw1: r[1], token0: t0, format: "uniswapV2" };
  };
  const trySolidly = async () => {
    const c = new ethers.Contract(pairAddress, PAIR_ABI_SOLIDLY, provider);
    const [r, t0] = await Promise.all([c.getReserves(), c.token0()]);
    return { raw0: r[0], raw1: r[1], token0: t0, format: "solidly" };
  };

  if (known === "solidly") {
    return await trySolidly();
  }
  if (known === "uniswapV2") {
    return await tryV2();
  }

  // 初回はV2形式から試し、失敗したらSolidly形式で読み直す。
  try {
    const result = await tryV2();
    poolFormatCache.set(key, "uniswapV2");
    return result;
  } catch (e) {
    const result = await trySolidly();
    poolFormatCache.set(key, "solidly");
    return result;
  }
}

/// チェーンから直接、指定プールの準備量を読む。
/// 戻り値は人間が読める小数(トークンのdecimalsで割った後の値)。
export async function fetchOnchainReserves({
  chain, pairAddress, tokenXAddress, decimalsX, decimalsY,
}) {
  if (!ethers.isAddress(pairAddress)) {
    throw new Error(`プールアドレスの形式が不正: ${pairAddress}`);
  }

  const provider = getProviderForChain(chain);
  const normalized = ethers.getAddress(pairAddress);
  const { raw0, raw1, token0, format } = await readReservesRaw(normalized, provider, chain);

  const isToken0X = token0.toLowerCase() === ethers.getAddress(tokenXAddress).toLowerCase();
  const rawX = isToken0X ? raw0 : raw1;
  const rawY = isToken0X ? raw1 : raw0;

  return {
    reserveX: parseFloat(ethers.formatUnits(rawX, decimalsX)),
    reserveY: parseFloat(ethers.formatUnits(rawY, decimalsY)),
    rawX,
    rawY,
    poolFormat: format,
  };
}

const decimalsCache = new Map();

export async function fetchTokenDecimals(chain, tokenAddress) {
  const normalized = ethers.getAddress(tokenAddress);
  const key = `${chain}:${normalized.toLowerCase()}`;
  if (decimalsCache.has(key)) return decimalsCache.get(key);

  const provider = getProviderForChain(chain);
  const contract = new ethers.Contract(normalized, ERC20_DECIMALS_ABI, provider);
  const decimals = Number(await contract.decimals());
  decimalsCache.set(key, decimals);
  return decimals;
}

/// このチェーンでオンチェーン読み取りが使えるか。
export function isOnchainReadAvailable(chain) {
  return getChainConfig(chain) !== null;
}
