// scripts/onchain-reserves.js
//
// チェーンから直接データを読むための共通処理。
//
// [優先列と通常列を完全に分離する]
// 以前は優先列と通常列を1本の処理装置で順に見ていたため、通常列の1件を
// 処理している間は優先列が待たされ、さらに全ての呼び出しに送信間隔
// (Baseは75ミリ秒)が適用されていた。V3経路の状態取得は6〜8回の問い合わせを
// 要するため、これだけで8秒の上限を超えて実行が失敗した(2026年9月15日)。
//   → 優先列は専用の処理装置で、間隔を空けずに連続処理する
//   → 通常列(手数料実測・プール取込・定期読み直し)だけが間隔を守る
//   → 通常列には上限を設け、溢れたら古いものから捨てる
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

// 通常列(背景作業)の送信間隔。RPCの秒間上限に合わせる。
const MIN_INTERVAL_BY_CHAIN = {
  base: parseInt(process.env.BASE_MIN_INTERVAL_MS || "90", 10),
  polygon: parseInt(process.env.POLYGON_MIN_INTERVAL_MS || "45", 10),
};
const DEFAULT_MIN_INTERVAL_MS = parseInt(process.env.MIN_REQUEST_INTERVAL_MS || "60", 10);
function minIntervalFor(chain) {
  return MIN_INTERVAL_BY_CHAIN[chain] ?? DEFAULT_MIN_INTERVAL_MS;
}

// 優先列は間隔をほぼ空けない。実行は一瞬で終わらせる必要がある。
const PRIORITY_INTERVAL_MS = parseInt(process.env.PRIORITY_INTERVAL_MS || "5", 10);

const FAILURES_BEFORE_ROTATE = 3;
const RPC_CALL_TIMEOUT_MS = parseInt(process.env.RPC_CALL_TIMEOUT_MS || "8000", 10);
const NORMAL_QUEUE_LIMIT = parseInt(process.env.NORMAL_QUEUE_LIMIT || "300", 10);

// チェーンごとの待ち行列。優先と通常でそれぞれ独立した処理装置を持つ。
const queues = new Map();

function getQueue(chain) {
  const key = (chain || "").toLowerCase();
  if (!queues.has(key)) {
    queues.set(key, {
      priority: [], normal: [],
      priorityRunning: false, normalRunning: false,
      dropped: 0, priorityDone: 0, normalDone: 0,
    });
  }
  return queues.get(key);
}

function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`RPC timeout after ${ms}ms (${label})`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function runJob(chain, job) {
  try {
    const result = await withTimeout(Promise.resolve().then(job.fn), RPC_CALL_TIMEOUT_MS, chain);
    job.resolve(result);
  } catch (e) {
    job.reject(e);
  }
}

/// 優先列の処理装置。通常列とは独立して回り、間隔もほぼ空けない。
async function pumpPriority(chain) {
  const q = getQueue(chain);
  if (q.priorityRunning) return;
  q.priorityRunning = true;
  try {
    while (q.priority.length > 0) {
      const job = q.priority.shift();
      await runJob(chain, job);
      q.priorityDone++;
      if (q.priority.length > 0) await new Promise((r) => setTimeout(r, PRIORITY_INTERVAL_MS));
    }
  } finally {
    q.priorityRunning = false;
  }
}

/// 通常列の処理装置。背景作業なので間隔を守り、RPCの上限を超えないようにする。
async function pumpNormal(chain) {
  const q = getQueue(chain);
  if (q.normalRunning) return;
  q.normalRunning = true;
  try {
    while (q.normal.length > 0) {
      const job = q.normal.shift();
      await runJob(chain, job);
      q.normalDone++;
      await new Promise((r) => setTimeout(r, minIntervalFor(chain)));
    }
  } finally {
    q.normalRunning = false;
  }
}

function scheduleRpcCall(chain, fn, priority = false) {
  const q = getQueue(chain);
  return new Promise((resolve, reject) => {
    const job = { fn, resolve, reject };
    if (priority) {
      q.priority.push(job);
      pumpPriority(chain);
    } else {
      while (q.normal.length >= NORMAL_QUEUE_LIMIT) {
        const dropped = q.normal.shift();
        q.dropped++;
        dropped.reject(new Error("待ち行列が上限に達したため破棄"));
      }
      q.normal.push(job);
      pumpNormal(chain);
    }
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
/// priority=true は「実行に直結する問い合わせ」に使い、専用の処理装置で
/// 間隔を空けずに処理する。
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
  const contract = (p) => new ethers.Contract(addr, PAIR_ABI, p);
  const [reserves, token0] = await Promise.all([
    callWithRpc(chain, (p) => contract(p).getReserves(), priority),
    callWithRpc(chain, (p) => contract(p).token0(), priority),
  ]);
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

/// ダッシュボード表示用。
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
      normalQueued: q.normal.length,
      dropped: q.dropped,
      priorityDone: q.priorityDone,
      intervalMs: minIntervalFor(chain),
    };
  }
  return out;
}

export { scheduleRpcCall };
