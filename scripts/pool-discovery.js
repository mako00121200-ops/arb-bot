// scripts/pool-discovery.js
//
// DEXのファクトリーコントラクトから、全プールを直接列挙する。
//
// [ファクトリーアドレスの求め方]
// 推測はしない。既に実在が確認できているプールに対して factory() を呼び、
// そのDEXのファクトリーアドレスを逆算する。
//
// [2つの形式に対応]
//   Uniswap V2形式: allPairsLength() / allPairs(i)
//   Solidly形式:    allPoolsLength() / allPools(i)  (Aerodrome, Velodrome等)
// 関数名が違うだけで役割は同じ。両方を試す。
//
// [stableプールの除外]
// Solidly系にはstableプール(x³y+y³x曲線)があり、通常のx*y=k計算式が
// 通用しない。stable() が true を返すプールは取り込まない。

import { ethers } from "ethers";
import { callWithRpc } from "./onchain-reserves.js";
import { fetchReservesBatch, MULTICALL3_ADDRESS } from "./multicall-reserves.js";

const POOL_ABI = ["function factory() view returns (address)"];
const FACTORY_V2_IFACE = new ethers.Interface([
  "function allPairsLength() view returns (uint256)",
  "function allPairs(uint256) view returns (address)",
]);
const FACTORY_SOLIDLY_IFACE = new ethers.Interface([
  "function allPoolsLength() view returns (uint256)",
  "function allPools(uint256) view returns (address)",
]);
const MULTICALL3_ABI = [
  "function aggregate3((address target, bool allowFailure, bytes callData)[] calls) view returns ((bool success, bytes returnData)[] returnData)",
];
const PAIR_META_IFACE = new ethers.Interface([
  "function token0() view returns (address)",
  "function token1() view returns (address)",
  "function stable() view returns (bool)",
]);

const BATCH_SIZE = 300;
const MAX_POOLS_PER_FACTORY = 3000;

export async function discoverFactory(chain, poolAddress) {
  try {
    return await callWithRpc(chain, (p) =>
      new ethers.Contract(ethers.getAddress(poolAddress), POOL_ABI, p).factory());
  } catch (e) {
    return null;
  }
}

/// ファクトリーの形式(V2 / Solidly)とプール総数を判定する。
async function detectFactoryKind(chain, factory) {
  const addr = ethers.getAddress(factory);
  try {
    const n = await callWithRpc(chain, (p) => new ethers.Contract(addr, FACTORY_V2_IFACE, p).allPairsLength());
    if (Number(n) > 0) return { kind: "v2", total: Number(n) };
  } catch (e) {}
  try {
    const n = await callWithRpc(chain, (p) => new ethers.Contract(addr, FACTORY_SOLIDLY_IFACE, p).allPoolsLength());
    if (Number(n) > 0) return { kind: "solidly", total: Number(n) };
  } catch (e) {}
  return null;
}

async function multicall(chain, calls) {
  return callWithRpc(chain, (p) =>
    new ethers.Contract(MULTICALL3_ADDRESS, MULTICALL3_ABI, p).aggregate3(calls));
}

async function listPoolAddresses(chain, factory, kind, total) {
  const iface = kind === "solidly" ? FACTORY_SOLIDLY_IFACE : FACTORY_V2_IFACE;
  const fn = kind === "solidly" ? "allPools" : "allPairs";
  const limit = Math.min(total, MAX_POOLS_PER_FACTORY);
  const startIndex = Math.max(0, total - limit);
  const addresses = [];

  for (let offset = 0; offset < limit; offset += BATCH_SIZE) {
    const calls = [];
    for (let i = offset; i < Math.min(offset + BATCH_SIZE, limit); i++) {
      calls.push({ target: ethers.getAddress(factory), allowFailure: true, callData: iface.encodeFunctionData(fn, [startIndex + i]) });
    }
    try {
      const returned = await multicall(chain, calls);
      for (const r of returned) {
        if (!r.success || r.returnData === "0x") continue;
        try {
          const addr = iface.decodeFunctionResult(fn, r.returnData)[0];
          if (addr && addr !== ethers.ZeroAddress) addresses.push(addr);
        } catch (inner) {}
      }
    } catch (e) { break; }
  }
  return addresses;
}

/// token0 / token1 / stable を一括取得する。stable() が無いプール(V2)は volatile 扱い。
async function fetchPoolMeta(chain, addresses) {
  const result = new Map();
  const perChunk = Math.floor(BATCH_SIZE / 3);
  for (let i = 0; i < addresses.length; i += perChunk) {
    const chunk = addresses.slice(i, i + perChunk);
    const calls = [];
    for (const addr of chunk) {
      const target = ethers.getAddress(addr);
      calls.push({ target, allowFailure: true, callData: PAIR_META_IFACE.encodeFunctionData("token0") });
      calls.push({ target, allowFailure: true, callData: PAIR_META_IFACE.encodeFunctionData("token1") });
      calls.push({ target, allowFailure: true, callData: PAIR_META_IFACE.encodeFunctionData("stable") });
    }
    try {
      const returned = await multicall(chain, calls);
      for (let j = 0; j < chunk.length; j++) {
        const r0 = returned[j * 3], r1 = returned[j * 3 + 1], rs = returned[j * 3 + 2];
        if (!r0?.success || !r1?.success) continue;
        try {
          const token0 = PAIR_META_IFACE.decodeFunctionResult("token0", r0.returnData)[0];
          const token1 = PAIR_META_IFACE.decodeFunctionResult("token1", r1.returnData)[0];
          let stable = false;
          if (rs?.success && rs.returnData !== "0x") {
            try { stable = PAIR_META_IFACE.decodeFunctionResult("stable", rs.returnData)[0]; } catch (e) {}
          }
          result.set(chunk[j].toLowerCase(), { token0: token0.toLowerCase(), token1: token1.toLowerCase(), stable });
        } catch (inner) {}
      }
    } catch (e) {}
  }
  return result;
}

export async function discoverPoolsFromFactory(chain, factory, dexId) {
  const detected = await detectFactoryKind(chain, factory);
  if (!detected) {
    console.log(`[プール発見] ${dexId} on ${chain}: ファクトリー形式を判定できず(${factory.slice(0, 10)}…)`);
    return [];
  }
  const { kind, total } = detected;

  const addresses = await listPoolAddresses(chain, factory, kind, total);
  if (addresses.length === 0) return [];

  const meta = await fetchPoolMeta(chain, addresses);
  const reserves = await fetchReservesBatch(chain, addresses.map((a) => ({ address: a })));

  const pools = [];
  let skippedStable = 0;
  for (const addr of addresses) {
    const key = addr.toLowerCase();
    const m = meta.get(key), r = reserves.get(key);
    if (!m || !r) continue;
    if (m.stable) { skippedStable++; continue; }
    if (r.raw0 <= 0n || r.raw1 <= 0n) continue;
    pools.push({ address: addr, chain, dexId, factory, token0: m.token0, token1: m.token1, raw0: r.raw0, raw1: r.raw1 });
  }

  console.log(`[プール発見] ${dexId} on ${chain}: ${kind}形式・全${total}件中${pools.length}件を取り込み(stable除外${skippedStable}件)`);
  return pools;
}

export { MAX_POOLS_PER_FACTORY };
