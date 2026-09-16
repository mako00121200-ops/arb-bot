// scripts/multicall-reserves.js
//
// Multicall3(対応チェーン全てに同一アドレスで存在する標準コントラクト)を
// 使い、多数のプールやトークンのデータを「1回のRPC呼び出し」でまとめて読む。
//
// [なぜ束ねるか(2026年9月16日)]
// Chainstackは問い合わせ1回=1リクエスト単位で課金され、中身の大きさは問わない。
// V3の価格表(1プールあたりQuoter12回)やV3の状態(1プールあたり2回)を個別に
// 呼んでいたため、Polygonだけで月約1,100万単位に達し、2,000万の枠を圧迫していた。
// 100件を1回に束ねれば、単位の消費は1/100になる。
//
// [束ねる大きさ]
// Quoterは1件あたり数十万ガスを使うため、1回に詰めすぎるとノード側の
// ガス上限に当たる。Quoterは24件、状態読みは60件、準備量は100件を上限にし、
// 1回の呼び出しが失敗したら半分に割って再試行する。
//
// RPCへの接続は onchain-reserves.js の callWithRpc を経由するので、
// タイムアウト・待ち行列・RPC自動切り替えがそのまま適用される。

import { ethers } from "ethers";
import { callWithRpc } from "./onchain-reserves.js";

export const MULTICALL3_ADDRESS = "0xcA11bde05977b3631167028862bE2a173976CA11";

const MULTICALL3_ABI = [
  "function aggregate3((address target, bool allowFailure, bytes callData)[] calls) view returns ((bool success, bytes returnData)[] returnData)",
];
const PAIR_IFACE = new ethers.Interface([
  "function getReserves() view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast)",
  "function token0() view returns (address)",
  "function token1() view returns (address)",
  "function stable() view returns (bool)",
]);
const ERC20_IFACE = new ethers.Interface([
  "function decimals() view returns (uint8)",
]);
const V3_IFACE = new ethers.Interface([
  "function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)",
  "function liquidity() view returns (uint128)",
]);
const QUOTER_IFACE = new ethers.Interface([
  "function quoteExactInputSingle((address tokenIn, address tokenOut, uint256 amountIn, uint24 fee, uint160 sqrtPriceLimitX96)) returns (uint256 amountOut, uint160 sqrtPriceX96After, uint32 initializedTicksCrossed, uint256 gasEstimate)",
]);

const MAX_POOLS_PER_CALL = parseInt(process.env.MULTICALL_POOLS_PER_CALL || "100", 10);
const MAX_TOKENS_PER_CALL = 120;
const MAX_V3_POOLS_PER_CALL = parseInt(process.env.MULTICALL_V3_PER_CALL || "60", 10);
const MAX_QUOTES_PER_CALL = parseInt(process.env.MULTICALL_QUOTES_PER_CALL || "24", 10);

const multicallStats = { calls: 0, subcalls: 0, splits: 0 };
export function getMulticallStats() { return { ...multicallStats }; }

async function multicall(chain, calls, priority = false) {
  multicallStats.calls++;
  multicallStats.subcalls += calls.length;
  return callWithRpc(chain, (provider) =>
    new ethers.Contract(MULTICALL3_ADDRESS, MULTICALL3_ABI, provider).aggregate3(calls), priority);
}

/// 失敗したら半分に割って再試行する。1件まで割っても失敗した分は null。
async function multicallSplitting(chain, calls, priority = false, minChunk = 4) {
  try {
    return await multicall(chain, calls, priority);
  } catch (e) {
    if (calls.length <= minChunk) return calls.map(() => null);
    multicallStats.splits++;
    const half = Math.ceil(calls.length / 2);
    const [a, b] = await Promise.all([
      multicallSplitting(chain, calls.slice(0, half), priority, minChunk),
      multicallSplitting(chain, calls.slice(half), priority, minChunk),
    ]);
    return [...a, ...b];
  }
}

/// 複数プールの準備量とtoken0を一括で読む。
/// 戻り値: Map<小文字アドレス, { raw0, raw1, token0 } | null(読めない)>
export async function fetchReservesBatch(chain, pools, priority = false) {
  const result = new Map();
  for (let i = 0; i < pools.length; i += MAX_POOLS_PER_CALL) {
    const chunk = pools.slice(i, i + MAX_POOLS_PER_CALL);
    const calls = [];
    for (const p of chunk) {
      const target = ethers.getAddress(p.address);
      calls.push({ target, allowFailure: true, callData: PAIR_IFACE.encodeFunctionData("getReserves") });
      calls.push({ target, allowFailure: true, callData: PAIR_IFACE.encodeFunctionData("token0") });
    }
    const returned = await multicallSplitting(chain, calls, priority);
    for (let j = 0; j < chunk.length; j++) {
      const key = chunk[j].address.toLowerCase();
      const r1 = returned[j * 2], r2 = returned[j * 2 + 1];
      if (!r1?.success || !r2?.success || r1.returnData === "0x" || r2.returnData === "0x") {
        result.set(key, null);
        continue;
      }
      try {
        const reserves = PAIR_IFACE.decodeFunctionResult("getReserves", r1.returnData);
        const token0 = PAIR_IFACE.decodeFunctionResult("token0", r2.returnData)[0];
        result.set(key, { raw0: reserves[0], raw1: reserves[1], token0 });
      } catch (e) {
        result.set(key, null);
      }
    }
  }
  return result;
}

/// 複数のV3プールの価格(slot0)と流動性を一括で読む。
/// 戻り値: Map<小文字アドレス, { sqrtPriceX96, tick, liquidity } | null>
export async function fetchV3StatesBatch(chain, addresses, priority = false) {
  const result = new Map();
  for (let i = 0; i < addresses.length; i += MAX_V3_POOLS_PER_CALL) {
    const chunk = addresses.slice(i, i + MAX_V3_POOLS_PER_CALL);
    const calls = [];
    for (const addr of chunk) {
      const target = ethers.getAddress(addr);
      calls.push({ target, allowFailure: true, callData: V3_IFACE.encodeFunctionData("slot0") });
      calls.push({ target, allowFailure: true, callData: V3_IFACE.encodeFunctionData("liquidity") });
    }
    const returned = await multicallSplitting(chain, calls, priority);
    for (let j = 0; j < chunk.length; j++) {
      const key = chunk[j].toLowerCase();
      const r1 = returned[j * 2], r2 = returned[j * 2 + 1];
      if (!r1?.success || !r2?.success || r1.returnData === "0x" || r2.returnData === "0x") {
        result.set(key, null);
        continue;
      }
      try {
        const slot0 = V3_IFACE.decodeFunctionResult("slot0", r1.returnData);
        const liquidity = V3_IFACE.decodeFunctionResult("liquidity", r2.returnData)[0];
        if (slot0[0] <= 0n) { result.set(key, null); continue; }
        result.set(key, { sqrtPriceX96: slot0[0], tick: Number(slot0[1]), liquidity });
      } catch (e) {
        result.set(key, null);
      }
    }
  }
  return result;
}

/// 公式QuoterV2への見積もりを一括で行う。
/// @param requests [{ tokenIn, tokenOut, amountIn, feeTier }] の配列
/// 戻り値: 同じ順番の配列。見積もれなかったものは null。
export async function quoteV3Batch(chain, quoterAddress, requests, priority = false) {
  const out = new Array(requests.length).fill(null);
  if (!quoterAddress || requests.length === 0) return out;
  const target = ethers.getAddress(quoterAddress);
  for (let i = 0; i < requests.length; i += MAX_QUOTES_PER_CALL) {
    const chunk = requests.slice(i, i + MAX_QUOTES_PER_CALL);
    const calls = chunk.map((q) => ({
      target, allowFailure: true,
      callData: QUOTER_IFACE.encodeFunctionData("quoteExactInputSingle", [{
        tokenIn: ethers.getAddress(q.tokenIn),
        tokenOut: ethers.getAddress(q.tokenOut),
        amountIn: q.amountIn,
        fee: q.feeTier,
        sqrtPriceLimitX96: 0,
      }]),
    }));
    const returned = await multicallSplitting(chain, calls, priority);
    for (let j = 0; j < chunk.length; j++) {
      const r = returned[j];
      if (!r?.success || r.returnData === "0x") continue;
      try {
        const amountOut = QUOTER_IFACE.decodeFunctionResult("quoteExactInputSingle", r.returnData)[0];
        if (amountOut > 0n) out[i + j] = amountOut;
      } catch (e) {}
    }
  }
  return out;
}

/// 複数トークンの桁数(decimals)を一括で読む。
/// 経路の始点として使えるかの判断に必要。桁数が読めないトークンは
/// 量の計算ができないため、始点にしない。
/// 戻り値: Map<小文字アドレス, 数値>
export async function fetchTokenDecimalsBatch(chain, addresses) {
  const result = new Map();
  for (let i = 0; i < addresses.length; i += MAX_TOKENS_PER_CALL) {
    const chunk = addresses.slice(i, i + MAX_TOKENS_PER_CALL);
    const calls = chunk.map((addr) => ({
      target: ethers.getAddress(addr),
      allowFailure: true,
      callData: ERC20_IFACE.encodeFunctionData("decimals"),
    }));
    const returned = await multicallSplitting(chain, calls);
    for (let j = 0; j < chunk.length; j++) {
      const r = returned[j];
      if (!r?.success || r.returnData === "0x") continue;
      try {
        const decimals = Number(ERC20_IFACE.decodeFunctionResult("decimals", r.returnData)[0]);
        if (decimals >= 0 && decimals <= 36) result.set(chunk[j].toLowerCase(), decimals);
      } catch (e) {}
    }
  }
  return result;
}

/// 複数プールの token0 / token1 / stable を一括で読む。
/// stable型(x³y+y³x曲線)は計算式が違うため、結果から除外する。
/// 戻り値: Map<小文字アドレス, { token0, token1 }>
export async function fetchPoolTokensBatch(chain, addresses) {
  const result = new Map();
  const perChunk = Math.floor(MAX_POOLS_PER_CALL * 2 / 3);
  for (let i = 0; i < addresses.length; i += perChunk) {
    const chunk = addresses.slice(i, i + perChunk);
    const calls = [];
    for (const addr of chunk) {
      const target = ethers.getAddress(addr);
      calls.push({ target, allowFailure: true, callData: PAIR_IFACE.encodeFunctionData("token0") });
      calls.push({ target, allowFailure: true, callData: PAIR_IFACE.encodeFunctionData("token1") });
      calls.push({ target, allowFailure: true, callData: PAIR_IFACE.encodeFunctionData("stable") });
    }
    const returned = await multicallSplitting(chain, calls);
    for (let j = 0; j < chunk.length; j++) {
      const r0 = returned[j * 3], r1 = returned[j * 3 + 1], rs = returned[j * 3 + 2];
      if (!r0?.success || !r1?.success || r0.returnData === "0x" || r1.returnData === "0x") continue;
      try {
        const token0 = PAIR_IFACE.decodeFunctionResult("token0", r0.returnData)[0];
        const token1 = PAIR_IFACE.decodeFunctionResult("token1", r1.returnData)[0];
        if (token0.toLowerCase() === token1.toLowerCase()) continue;
        if (rs?.success && rs.returnData !== "0x") {
          try {
            if (PAIR_IFACE.decodeFunctionResult("stable", rs.returnData)[0]) continue;
          } catch (e) {}
        }
        result.set(chunk[j].toLowerCase(), { token0: token0.toLowerCase(), token1: token1.toLowerCase() });
      } catch (e) {}
    }
  }
  return result;
}

/// 1つの「実行可能ペア」について、全プールの準備量を一括で読む。
export async function readVerifiedPairPools(pair) {
  const batch = await fetchReservesBatch(pair.chain, pair.pools);
  const tokenX = pair.tokenA.toLowerCase();
  const out = [];
  for (const p of pair.pools) {
    const r = batch.get(p.address.toLowerCase());
    if (!r) continue;
    const isToken0X = r.token0.toLowerCase() === tokenX;
    const rawX = isToken0X ? r.raw0 : r.raw1;
    const rawY = isToken0X ? r.raw1 : r.raw0;
    const reserveX = parseFloat(ethers.formatUnits(rawX, pair.decimalsX));
    const reserveY = parseFloat(ethers.formatUnits(rawY, pair.decimalsY));
    if (!reserveX || !reserveY) continue;
    out.push({ dexId: p.dexId, pairAddress: p.address, reserveX, reserveY, rawX, rawY });
  }
  return out;
}
