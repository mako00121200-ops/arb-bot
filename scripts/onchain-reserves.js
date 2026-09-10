// scripts/onchain-reserves.js
//
// プールの準備量(reserve)を、DexScreenerのAPIではなくチェーンから
// 直接読み取るための共通処理。
//
// DexScreenerのliquidity情報は不正確なことが多く、自己整合性チェック
// (逆算価格と公表価格の比較)で7〜172%もの乖離が頻発していた。
// チェーンから直接読めば、その時点の正確な値が必ず得られる。
//
// getReservesに応答しないプール(Uniswap V3/V4、Balancer等)は、ここで
// 自然にエラーになるため、V3判定の取りこぼしも同時に防げる。
//
// 公開RPCは予告なく403/410を返すため(polygon-rpc.com・llamarpc・ankr・
// 1rpc.ioが順に使えなくなった実績あり)、ethersのFallbackProviderで
// 複数のRPCを束ね、生きているものを自動的に使う。

import { ethers } from "ethers";
import { getChainConfig } from "../chain-config.js";

const PAIR_ABI = [
  "function getReserves() view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast)",
  "function token0() view returns (address)",
];
const ERC20_DECIMALS_ABI = ["function decimals() view returns (uint8)"];

const providerCache = new Map();

export function getProviderForChain(chain) {
  const config = getChainConfig(chain);
  if (!config) throw new Error(`未対応チェーン: ${chain}`);

  const key = (chain || "").toLowerCase();
  if (providerCache.has(key)) return providerCache.get(key);

  const urls = config.rpcUrls || [config.rpcUrl];
  let provider;
  if (urls.length === 1) {
    provider = new ethers.JsonRpcProvider(urls[0]);
  } else {
    // 先頭のURLほど優先度を高くする(自前のChainstack等を先に使う)。
    // quorum:1 で「1つでも答えが返ればそれを採用」する設定。
    const configs = urls.map((url, i) => ({
      provider: new ethers.JsonRpcProvider(url),
      priority: i + 1,
      stallTimeout: 3000,
      weight: 1,
    }));
    provider = new ethers.FallbackProvider(configs, undefined, { quorum: 1 });
  }

  providerCache.set(key, provider);
  return provider;
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
  const pair = new ethers.Contract(ethers.getAddress(pairAddress), PAIR_ABI, provider);
  const [reserves, token0] = await Promise.all([pair.getReserves(), pair.token0()]);

  const isToken0X = token0.toLowerCase() === ethers.getAddress(tokenXAddress).toLowerCase();
  const rawX = isToken0X ? reserves[0] : reserves[1];
  const rawY = isToken0X ? reserves[1] : reserves[0];

  return {
    reserveX: parseFloat(ethers.formatUnits(rawX, decimalsX)),
    reserveY: parseFloat(ethers.formatUnits(rawY, decimalsY)),
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

/// このチェーンでオンチェーン読み取りが使えるか(RPC設定済みか)。
export function isOnchainReadAvailable(chain) {
  return getChainConfig(chain) !== null;
}
