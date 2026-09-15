// scripts/onchain-reserves.js
//
// チェーンから直接データを読むための共通処理。
//
// [待ち行列の設計]
// 全ての呼び出しを1列に並べていたため、実行に必要な問い合わせが手数料実測や
// プール取込の後ろで待たされ、Baseでは87,000件が滞留して実行が制限時間切れに
// なった(2026年9月15日)。
//   → 優先列(実行用)と通常列(背景作業)の2段にし、優先列を常に先に処理する
//   → 通常列に上限を設け、溢れたら古いものから捨てる(自己回復させる)
//   → 呼び出しには8秒のタイムアウト(1件の無応答で全体が止まらないように)
//
// [RPCの自動切り替え]
// 一定回数連続で失敗したら次の候補URLへ切り替える。ただし
// "missing revert data" 等のコントラクト側の正当な応答は障害ではない。

import { ethers } from "ethers";
import { getChainConfig, CHAIN_CONFIG } from "../chain-config.js";

const PAIR_ABI = [
  "function getReserves() view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast)",
  "function token0() view returns (address)",
  "function getAmountOut(uint256 amountIn, address tokenIn) view returns (uint256)",
];
const ERC20_DECIMALS_ABI = ["function decimals() view returns (uint8)"];

const MIN_REQUEST_INTERVAL_MS = 40;
const FAILURES_BEFORE_ROTATE = 3;
const RPC_CALL_TIMEOUT_MS = parseInt(process.env.RPC_CALL_TIMEOUT_MS || "8000", 10);
// 通常列の上限。これを超えたら古い要求から捨てる。
const NORMAL_QUEUE_LIMIT = parseInt(process.env.NORMAL_QUEUE_LIMIT || "300", 10);

// チェーンごとの待ち行列。優先列と通常列を分ける。
const queues = new Map(); // chain -> { priority: [], normal: [], running: bool, dropped: number }

function getQueue(chain) {
  const key = (chain || "").toLowerCase();
  if (!queues.has(key)) queues.set(key, { priority: [], normal: [], running: false, dropped: 0 });
  return queues.get(key);
}

function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`RPC timeout after ${ms}ms (${label})`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/// 待ち行列を1件ずつ処理する。優先列が空になるまで通常列には進まない。
async function pump(chain) {
  const q = getQueue(chain);
  if (q.running) return;
  q.running = true;
  try {
    while (q.priority.length > 0 || q.normal.length > 0) {
      const job = q.priority.length > 0 ? q.priority.shift() : q.normal.shift();
      try {
        const result = await withTimeout(Promise.resolve().then(job.fn), RPC_CALL_TIMEOUT_MS, chain);
        job.resolve(result);
      } catch (e) {
        job.reject(e);
      }
      await new Promise((r) => setTimeout(r, MIN_REQUEST_INTERVAL_MS));
    }
  } finally {
    q.running = false;
  }
}

/// 呼び出しを待ち行列に登録する。priority=true なら優先列へ。
function scheduleRpcCall(chain, fn, priority = false) {
  const q = getQueue(chain);
  return new Promise((resolve, reject) => {
    const job = { fn, resolve, reject };
    if (priority) {
      q.priority.push(job);
    } else {
      // 通常列が溢れていたら、古い要求を捨てる(背景作業なので取りこぼしてよい)。
      while (q.normal.length >= NORMAL_QUEUE_LIMIT) {
        const dropped = q.normal.shift();
        q.dropped++;
        dropped.reject(new Error("待ち行列が上限に達したため破棄"));
      }
      q.normal.push(job);
    }
    pump(chain);
  });
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
  console.log(`[RPC切替] ${chain}: 続けて失敗したため次の候補へ(${oldUrl.slice(0, 40)} → ${config.rpcUrls[state.index].slice(0, 40)} / 理由: ${(message || "").slice(0, 70)})`);
}

/// RPC呼び出しの共通入口。
/// priority=true は「実行に直結する問い合わせ」に使い、背景作業より先に処理する。
export async function callWithRpc(chain, fn, priority = false) {
  try {
    const result = await scheduleRpcCall(chain, () => fn(getProviderForChain(chain)), priority);
    getState(chain).failures = 0;
    return result;
  } catch (e) {
    const msg = e.message || "";
    const isContractLevel = msg.includes("execution reverted")
      || msg.includes("could not decode result data")
      || msg.includes("missing revert data")
      || msg.includes("CALL_EXCEPTION")
      || msg.includes("待ち行列が上限");
    if (!isContractLevel) recordRpcFailure(chain, msg);
    throw e;
  }
}

export async function fetchOnchainReserves({ chain, pairAddress, tokenXAddress, decimalsX, decimalsY, priority = false }) {
  if (!ethers.isAddress(pairAddress)) throw new Error(`プールアドレスの形式が不正: ${pairAddress}`);
  const addr = ethers.getAddress(pairAddress);
  const reserves = await callWithRpc(chain, (p) => new ethers.Contract(addr, PAIR_ABI, p).getReserves(), priority);
  const token0 = await callWithRpc(chain, (p) => new ethers.Contract(addr, PAIR_ABI, p).token0(), priority);
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
    const q = getQueue(chain);
    out[chain] = {
      url: config.rpcUrls[state.index % config.rpcUrls.length].replace(/\/[a-f0-9]{20,}/i, "/***"),
      index: state.index + 1, total: config.rpcUrls.length,
      failures: state.failures,
      queued: q.priority.length + q.normal.length,
      priorityQueued: q.priority.length,
      dropped: q.dropped,
    };
  }
  return out;
}

export { scheduleRpcCall };
