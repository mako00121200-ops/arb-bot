// scripts/onchain-reserves.js
//
// プールの準備量(reserve)を、DexScreenerのAPIではなくチェーンから
// 直接読み取るための共通処理。
//
// [重要] RPCへのリクエストは、同時並行で一斉に送るとレート制限
// (Chainstack無料枠は毎秒25回)に当たり、応答が返ってこなくなる。
// その症状は "missing revert data (data=null)" というエラーとして現れ、
// あたかもコントラクト側の問題のように見えるため原因を見誤りやすい。
// ここでは全ての呼び出しを1本の待ち行列に通し、一定間隔を空けて
// 順番に送ることで、制限に当たらないようにしている。

import { ethers } from "ethers";
import { getChainConfig } from "../chain-config.js";

const PAIR_ABI = [
  "function getReserves() view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast)",
  "function token0() view returns (address)",
];
const ERC20_DECIMALS_ABI = ["function decimals() view returns (uint8)"];

const CHAIN_IDS = {
  base: 8453,
  polygon: 137,
  optimism: 10,
  avalanche: 43114,
};

// 呼び出し同士の最小間隔(ミリ秒)。毎秒25回の制限に対して十分な余裕を持たせる。
const MIN_REQUEST_INTERVAL_MS = 60;

let requestChain = Promise.resolve();

// 全てのRPC呼び出しをこの関数経由にして、順番に一定間隔で実行する。
function scheduleRpcCall(fn) {
  const result = requestChain.then(async () => {
    const value = await fn();
    return value;
  });
  // 次の呼び出しは、この呼び出しが終わってから一定時間後に始める。
  requestChain = result
    .catch(() => {})
    .then(() => new Promise((r) => setTimeout(r, MIN_REQUEST_INTERVAL_MS)));
  return result;
}

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

  // 2つの呼び出しも並行させず、順番に行う。
  const reserves = await scheduleRpcCall(() => pair.getReserves());
  const token0 = await scheduleRpcCall(() => pair.token0());

  const isToken0X = token0.toLowerCase() === ethers.getAddress(tokenXAddress).toLowerCase();
  const rawX = isToken0X ? reserves[0] : reserves[1];
  const rawY = isToken0X ? reserves[1] : reserves[0];

  return {
    reserveX: parseFloat(ethers.formatUnits(rawX, decimalsX)),
    reserveY: parseFloat(ethers.formatUnits(rawY, decimalsY)),
    rawX,
    rawY,
  };
}

const decimalsCache = new Map();

export async function fetchTokenDecimals(chain, tokenAddress) {
  const normalized = ethers.getAddress(tokenAddress);
  const key = `${chain}:${normalized.toLowerCase()}`;
  if (decimalsCache.has(key)) return decimalsCache.get(key);

  const provider = getProviderForChain(chain);
  const contract = new ethers.Contract(normalized, ERC20_DECIMALS_ABI, provider);
  const decimals = Number(await scheduleRpcCall(() => contract.decimals()));
  decimalsCache.set(key, decimals);
  return decimals;
}

/// 任意のRPC呼び出しを、この待ち行列に通して実行する(外部から使う用)。
export { scheduleRpcCall };

/// このチェーンでオンチェーン読み取りが使えるか。
export function isOnchainReadAvailable(chain) {
  return getChainConfig(chain) !== null;
}
