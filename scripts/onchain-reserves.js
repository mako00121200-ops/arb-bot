// scripts/onchain-reserves.js
//
// プールの準備量(reserve)を、DexScreenerのAPIではなくチェーンから
// 直接読み取るための共通処理。
//
// [RPCの自動切り替え]
// 公開RPCは利用上限・403・障害で突然使えなくなるため、チェーンごとに
// 候補URLを順に持ち、一定回数連続で失敗したら次の候補へ自動的に切り替える。
// ただし "missing revert data" 等のコントラクト側の正当な応答(V3型プールを
// 読んだ時に必ず出る)はRPC障害ではないため、切り替えの材料にしない。
//
// [手数料の実測]
// Aerodrome等のSolidly系プールは、手数料がプールごとに違う。0.3%と決め打ち
// すると観測と実行の判定がズレる(観測は黒字、実行直前は赤字、という現象が
// 実際に起きた)。そこでプール自身の getAmountOut に極小額を問い合わせ、
// 実際の手数料を逆算して記録する。

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
    const result = await scheduleRpcCall(() => fn(getProviderForChain(chain)));
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

/// プール自身の getAmountOut に「準備量の100万分の1」という極小額を問い合わせ、
/// 手数料なしの理論値との差から実際の手数料(bps)を逆算する。
/// 極小額なら価格への影響は無視できるため、差はほぼ手数料そのもの。
/// getAmountOut を持たないプール(Uniswap V2等)は null を返し、既定値を使う。
export async function probePoolFeeBps({ chain, pairAddress, tokenInAddress, reserveIn, reserveOut }) {
  if (reserveIn <= 0n || reserveOut <= 0n) return null;
  const addr = ethers.getAddress(pairAddress);
  const amountIn = reserveIn / 1_000_000n;
  if (amountIn <= 0n) return null;

  let amountOut;
  try {
    amountOut = await callWithRpc(chain, (p) =>
      new ethers.Contract(addr, PAIR_ABI, p).getAmountOut(amountIn, ethers.getAddress(tokenInAddress))
    );
  } catch (e) {
    return null;
  }
  if (amountOut <= 0n) return null;

  // 手数料なしの理論値(x*y=k)。
  const ideal = (amountIn * reserveOut) / (reserveIn + amountIn);
  if (ideal <= 0n) return null;
  const feeBps = Number(((ideal - amountOut) * 10000n) / ideal);

  // 逆算結果が不自然(負・10%超)なら信用しない。
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

export function getRpcStatus() {
  const out = {};
  for (const [chain, config] of Object.entries(CHAIN_CONFIG)) {
    const state = getState(chain);
    out[chain] = {
      url: config.rpcUrls[state.index % config.rpcUrls.length].replace(/\/[a-f0-9]{20,}/i, "/***"),
      index: state.index + 1, total: config.rpcUrls.length, failures: state.failures,
    };
  }
  return out;
}

export { scheduleRpcCall };
