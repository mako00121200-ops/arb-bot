// scripts/onchain-reserves.js
//
// チェーンから直接データを読むための共通処理。
//
// [修正: 待ち行列の凍結]
// 全RPC呼び出しを1本の待ち行列で順番に流していたが、タイムアウトが無かった
// ため、応答の返らない呼び出しが1件あると後ろ全てが永遠に止まった。
// 実際に14時間の凍結が起き、検出した機会の実行も凍結に巻き込まれた。
//   → 全ての呼び出しに8秒のタイムアウトを付ける
//   → 待ち行列をチェーンごとに分け、1チェーンの障害が他に波及しないようにする
//
// [RPCの自動切り替え]
// 公開RPCは利用上限・障害で突然使えなくなるため、チェーンごとに候補を
// 順に持ち、一定回数連続で失敗したら次の候補へ自動的に切り替える。
// "missing revert data" 等のコントラクト側の正当な応答は障害ではない。
//
// [手数料の実測]
// Solidly系プールは手数料がプールごとに違う。プール自身の getAmountOut に
// 極小額を問い合わせ、実際の手数料を逆算する。

import { ethers } from "ethers";
import { getChainConfig, CHAIN_CONFIG } from "../chain-config.js";

const PAIR_ABI = [
  "function getReserves() view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast)",
  "function token0() view returns (address)",
  "function getAmountOut(uint256 amountIn, address tokenIn) view returns (uint256)",
];
const ERC20_DECIMALS_ABI = ["function decimals() view returns (uint8)"];

const MIN_REQUEST_INTERVAL_MS = 60;
const FAILURES_BEFORE_ROTATE = 3;
// 1回の呼び出しがこれ以上かかったら諦める。凍結防止の要。
const RPC_CALL_TIMEOUT_MS = parseInt(process.env.RPC_CALL_TIMEOUT_MS || "8000", 10);

// チェーンごとの待ち行列。RPCはチェーンごとに別なので、直列化する理由が無い。
const requestChains = new Map();
const queueDepth = new Map();

function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`RPC timeout after ${ms}ms (${label})`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function scheduleRpcCall(chain, fn) {
  const key = (chain || "").toLowerCase();
  const prev = requestChains.get(key) ?? Promise.resolve();
  queueDepth.set(key, (queueDepth.get(key) || 0) + 1);

  const result = prev.then(() => withTimeout(Promise.resolve().then(fn), RPC_CALL_TIMEOUT_MS, key));
  // 成功・失敗・タイムアウトのいずれでも、必ず次へ進む。
  requestChains.set(key, result
    .catch(() => {})
    .then(() => new Promise((r) => setTimeout(r, MIN_REQUEST_INTERVAL_MS)))
    .finally(() => queueDepth.set(key, Math.max(0, (queueDepth.get(key) || 1) - 1))));
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
    const network = ethers.Network.from(config.chainId);
    providerCache.set(cacheKey, new ethers.JsonRpcProvider(url, network, { staticNetwork: network }));
  }
  return providerCache.get(cacheKey);
}

function recordRpcFailure(chain, message) {
  const config = getChainConfig(chain);
  if (!config || config.rpcUrls.length < 2) return;
  const state = getState(chain);
  state.failures++;
  if (state.failures < FAILURES_BEFORE_ROTATE) return;
  const oldUrl = config.rpcUrls[state.index % config.rpcUrls.length];
  state.index = (state.index + 1) % config.rpcUrls.length;
  state.failures = 0;
  console.log(`[RPC切替] ${chain}: 続けて失敗したため次の候補に切り替えます(${oldUrl.slice(0, 40)} → ${config.rpcUrls[state.index].slice(0, 40)} / 理由: ${(message || "").slice(0, 70)})`);
}

export async function callWithRpc(chain, fn) {
  try {
    const result = await scheduleRpcCall(chain, () => fn(getProviderForChain(chain)));
    getState(chain).failures = 0;
    return result;
  } catch (e) {
    const msg = e.message || "";
    const isContractLevel = msg.includes("execution reverted")
      || msg.includes("could not decode result data")
      || msg.includes("missing revert data")
      || msg.includes("CALL_EXCEPTION");
    if (!isContractLevel) recordRpcFailure(chain, msg);
    throw e;
  }
}

export async function fetchOnchainReserves({ chain, pairAddress, tokenXAddress, decimalsX, decimalsY }) {
  if (!ethers.isAddress(pairAddress)) throw new Error(`プールアドレスの形式が不正: ${pairAddress}`);
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

/// プール自身の getAmountOut に極小額を問い合わせ、実際の手数料(bps)を逆算する。
/// getAmountOut を持たないプール(Uniswap V2等)は null を返す。
export async function probePoolFeeBps({ chain, pairAddress, tokenInAddress, reserveIn, reserveOut }) {
  if (reserveIn <= 0n || reserveOut <= 0n) return null;
  const addr = ethers.getAddress(pairAddress);
  const amountIn = reserveIn / 1_000_000n;
  if (amountIn <= 0n) return null;
  let amountOut;
  try {
    amountOut = await callWithRpc(chain, (p) =>
      new ethers.Contract(addr, PAIR_ABI, p).getAmountOut(amountIn, ethers.getAddress(tokenInAddress)));
  } catch (e) { return null; }
  if (amountOut <= 0n) return null;
  const ideal = (amountIn * reserveOut) / (reserveIn + amountIn);
  if (ideal <= 0n) return null;
  const feeBps = Number(((ideal - amountOut) * 10000n) / ideal);
  if (feeBps < 0 || feeBps > 1000) return null;
  return feeBps;
}

const decimalsCache = new Map();
export async function fetchTokenDecimals(chain, tokenAddress) {
  const normalized = ethers.getAddress(tokenAddress);
  const key = `${chain}:${normalized.toLowerCase()}`;
  if (decimalsCache.has(key)) return decimalsCache.get(key);
  const decimals = Number(await callWithRpc(chain, (p) => new ethers.Contract(normalized, ERC20_DECIMALS_ABI, p).decimals()));
  decimalsCache.set(key, decimals);
  return decimals;
}

export function isOnchainReadAvailable(chain) {
  return getChainConfig(chain) !== null;
}

/// ダッシュボード表示用: 各チェーンのRPC状態と待ち行列の深さ。
export function getRpcStatus() {
  const out = {};
  for (const [chain, config] of Object.entries(CHAIN_CONFIG)) {
    const state = getState(chain);
    out[chain] = {
      url: config.rpcUrls[state.index % config.rpcUrls.length].replace(/\/[a-f0-9]{20,}/i, "/***"),
      index: state.index + 1, total: config.rpcUrls.length,
      failures: state.failures, queued: queueDepth.get(chain) || 0,
    };
  }
  return out;
}

export { scheduleRpcCall };
