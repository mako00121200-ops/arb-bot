// scripts/onchain-reserves.js
//
// プールの準備量(reserve)を、DexScreenerのAPIではなくチェーンから
// 直接読み取るための共通処理。
//
// [RPCの自動切り替え]
// 公開RPCは利用上限・403・障害で突然使えなくなる(1rpc.ioが実際に
// 「usage limit」で停止し、Polygonの黒字案件を取り逃した)。
// そこでチェーンごとに候補URLを順に持ち、一定回数連続で失敗したら
// 次の候補へ自動的に切り替える。全て失敗したら先頭に戻って再試行する。
//
// ただし「そのプールにgetReservesが無い」等のコントラクト側の正当な
// 応答は、RPCの障害ではない。特に "missing revert data" はV3型プールを
// 読んだ時に必ず出るため、これをRPC障害と誤認すると、正常なRPCから
// 不要に切り替わってしまう(実際に発生させてしまった)。
//
// [レート制限対策]
// RPCへの呼び出しは1本の待ち行列に通し、一定間隔を空けて順番に送る。
// 同時並行で一斉に送ると "missing revert data (data=null)" という
// 紛らわしいエラーになり、コントラクト側の問題と誤認しやすい。

import { ethers } from "ethers";
import { getChainConfig, CHAIN_CONFIG } from "../chain-config.js";

const PAIR_ABI = [
  "function getReserves() view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast)",
  "function token0() view returns (address)",
];
const ERC20_DECIMALS_ABI = ["function decimals() view returns (uint8)"];

const MIN_REQUEST_INTERVAL_MS = 60;
const FAILURES_BEFORE_ROTATE = 3;

let requestChain = Promise.resolve();

function scheduleRpcCall(fn) {
  const result = requestChain.then(() => fn());
  requestChain = result.catch(() => {}).then(() => new Promise((r) => setTimeout(r, MIN_REQUEST_INTERVAL_MS)));
  return result;
}

const rpcState = new Map();
const providerCache = new Map();

function getState(chain) {
  const key = (chain || "").toLowerCase();
  if (!rpcState.has(key)) rpcState.set(key, { index: 0, failures: 0 });
  return rpcState.get(key);
}

export function getProviderForChain(chain) {
  const config = getChainConfig(chain);
  if (!config) throw new Error(`未対応チェーン: ${chain}`);

  const key = (chain || "").toLowerCase();
  const state = getState(key);
  const url = config.rpcUrls[state.index % config.rpcUrls.length];
  const cacheKey = `${key}::${url}`;

  if (!providerCache.has(cacheKey)) {
    // チェーンIDを明示して、ethersによるネットワーク自動判定
    // (失敗するとリトライを繰り返す)を回避する。
    const network = ethers.Network.from(config.chainId);
    providerCache.set(cacheKey, new ethers.JsonRpcProvider(url, network, { staticNetwork: network }));
  }
  return providerCache.get(cacheKey);
}

function recordRpcFailure(chain, message) {
  const config = getChainConfig(chain);
  if (!config || config.rpcUrls.length < 2) return;

  const key = (chain || "").toLowerCase();
  const state = getState(key);
  state.failures++;
  if (state.failures < FAILURES_BEFORE_ROTATE) return;

  const oldUrl = config.rpcUrls[state.index % config.rpcUrls.length];
  state.index = (state.index + 1) % config.rpcUrls.length;
  state.failures = 0;
  const newUrl = config.rpcUrls[state.index];
  console.log(`[RPC切替] ${key}: 続けて失敗したため次の候補に切り替えます(${oldUrl.slice(0, 40)} → ${newUrl.slice(0, 40)} / 理由: ${(message || "").slice(0, 70)})`);
}

function recordRpcSuccess(chain) {
  getState(chain).failures = 0;
}

/// 呼び出しを待ち行列に通しつつ、失敗時はRPC切り替えの判断材料にする。
export async function callWithRpc(chain, fn) {
  try {
    const result = await scheduleRpcCall(() => fn(getProviderForChain(chain)));
    recordRpcSuccess(chain);
    return result;
  } catch (e) {
    const msg = e.message || "";
    // コントラクト側の正当な応答は、RPCの障害ではないため切り替えない。
    const isContractLevel = msg.includes("execution reverted")
      || msg.includes("could not decode result data")
      || msg.includes("missing revert data")
      || msg.includes("CALL_EXCEPTION");
    if (!isContractLevel) recordRpcFailure(chain, msg);
    throw e;
  }
}

export async function fetchOnchainReserves({ chain, pairAddress, tokenXAddress, decimalsX, decimalsY }) {
  if (!ethers.isAddress(pairAddress)) {
    throw new Error(`プールアドレスの形式が不正: ${pairAddress}`);
  }
  const addr = ethers.getAddress(pairAddress);

  const reserves = await callWithRpc(chain, (p) => new ethers.Contract(addr, PAIR_ABI, p).getReserves());
  const token0 = await callWithRpc(chain, (p) => new ethers.Contract(addr, PAIR_ABI, p).token0());

  const isToken0X = token0.toLowerCase() === ethers.getAddress(tokenXAddress).toLowerCase();
  const rawX = isToken0X ? reserves[0] : reserves[1];
  const rawY = isToken0X ? reserves[1] : reserves[0];

  return {
    reserveX: parseFloat(ethers.formatUnits(rawX, decimalsX)),
    reserveY: parseFloat(ethers.formatUnits(rawY, decimalsY)),
    rawX, rawY,
  };
}

const decimalsCache = new Map();

export async function fetchTokenDecimals(chain, tokenAddress) {
  const normalized = ethers.getAddress(tokenAddress);
  const key = `${chain}:${normalized.toLowerCase()}`;
  if (decimalsCache.has(key)) return decimalsCache.get(key);

  const decimals = Number(await callWithRpc(chain, (p) =>
    new ethers.Contract(normalized, ERC20_DECIMALS_ABI, p).decimals()
  ));
  decimalsCache.set(key, decimals);
  return decimals;
}

export function isOnchainReadAvailable(chain) {
  return getChainConfig(chain) !== null;
}

/// ダッシュボード表示用: 各チェーンが今どのRPCを使っているか。
export function getRpcStatus() {
  const out = {};
  for (const [chain, config] of Object.entries(CHAIN_CONFIG)) {
    const state = getState(chain);
    const url = config.rpcUrls[state.index % config.rpcUrls.length];
    out[chain] = {
      url: url.replace(/\/[a-f0-9]{20,}/i, "/***"),
      index: state.index + 1,
      total: config.rpcUrls.length,
      failures: state.failures,
    };
  }
  return out;
}

export { scheduleRpcCall };
