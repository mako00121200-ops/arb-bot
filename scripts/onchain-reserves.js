// scripts/onchain-reserves.js
//
// プールの準備量(reserve)を、DexScreenerのAPIではなくチェーンから
// 直接読み取るための共通処理。
//
// DexScreenerのliquidity情報は不正確なことが多く、自己整合性チェック
// (逆算価格と公表価格の比較)で7〜146%もの乖離が頻発していた。
// チェーンから直接読めば、その時点の正確な値が必ず得られる。
//
// getReservesに応答しないプール(Uniswap V3/V4等)は、ここで自然に
// エラーになるため、V3判定の取りこぼしも同時に防げる。

import { ethers } from "ethers";
import { getChainConfig } from "../chain-config.js";

const PAIR_ABI = [
  "function getReserves() view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast)",
  "function token0() view returns (address)",
];

const providerCache = new Map();
function getProviderForChain(rpcUrl) {
  if (!providerCache.has(rpcUrl)) {
    providerCache.set(rpcUrl, new ethers.JsonRpcProvider(rpcUrl));
  }
  return providerCache.get(rpcUrl);
}

/// チェーンから直接、指定プールの準備量を読む。
/// 戻り値はトークンの最小単位(生の整数)ではなく、人間が読める小数に直したもの。
/// decimalsX / decimalsY は呼び出し側で確定させてから渡す。
export async function fetchOnchainReserves({
  chain, pairAddress, tokenXAddress, decimalsX, decimalsY,
}) {
  const config = getChainConfig(chain);
  if (!config) throw new Error(`未対応チェーン: ${chain}`);
  if (!ethers.isAddress(pairAddress)) {
    throw new Error(`プールアドレスの形式が不正: ${pairAddress}`);
  }

  const provider = getProviderForChain(config.rpcUrl);
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
const ERC20_DECIMALS_ABI = ["function decimals() view returns (uint8)"];

export async function fetchTokenDecimals(chain, tokenAddress) {
  const config = getChainConfig(chain);
  if (!config) throw new Error(`未対応チェーン: ${chain}`);
  const normalized = ethers.getAddress(tokenAddress);
  const key = `${chain}:${normalized.toLowerCase()}`;
  if (decimalsCache.has(key)) return decimalsCache.get(key);

  const provider = getProviderForChain(config.rpcUrl);
  const contract = new ethers.Contract(normalized, ERC20_DECIMALS_ABI, provider);
  const decimals = Number(await contract.decimals());
  decimalsCache.set(key, decimals);
  return decimals;
}

/// このチェーンでオンチェーン読み取りが使えるか(RPC設定済みか)。
export function isOnchainReadAvailable(chain) {
  return getChainConfig(chain) !== null;
}
