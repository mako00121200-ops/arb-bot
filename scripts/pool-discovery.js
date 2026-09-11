// scripts/pool-discovery.js
//
// DEXのファクトリーコントラクトから、全プールを直接列挙する。
//
// [なぜ必要か]
// 従来はDeFiLlama→DexScreener経由で候補を集めていたが、API制限のため
// 150ペアを22分周期でしか見られなかった。専業botは数千プールを常時
// 監視しており、この差が「機会が見つからない」根本原因だった。
// ファクトリーから直接列挙すれば、API制限なしで全プールを把握できる。
//
// [ファクトリーアドレスの求め方]
// 推測はしない。既に実在が確認できているプールに対して factory() を呼び、
// そのDEXのファクトリーアドレスを逆算する。実在するプールから導くので
// 間違いようがない(過去、推測したアドレスで何度も失敗したため)。

import { ethers } from "ethers";
import { callWithRpc } from "./onchain-reserves.js";
import { fetchReservesBatch, MULTICALL3_ADDRESS } from "./multicall-reserves.js";

const POOL_ABI = ["function factory() view returns (address)"];
const FACTORY_ABI = [
  "function allPairsLength() view returns (uint256)",
  "function allPairs(uint256) view returns (address)",
];
const MULTICALL3_ABI = [
  "function aggregate3((address target, bool allowFailure, bytes callData)[] calls) view returns ((bool success, bytes returnData)[] returnData)",
];
const FACTORY_IFACE = new ethers.Interface(FACTORY_ABI);
const PAIR_META_IFACE = new ethers.Interface([
  "function token0() view returns (address)",
  "function token1() view returns (address)",
]);

// 1回のMulticallに詰める呼び出し数。多すぎると応答サイズ制限に当たる。
const BATCH_SIZE = 300;
// 1つのファクトリーから取り込むプール数の上限(巨大なファクトリー対策)。
const MAX_POOLS_PER_FACTORY = 3000;

/// 実在するプールのアドレスから、そのDEXのファクトリーアドレスを逆算する。
export async function discoverFactory(chain, poolAddress) {
  try {
    return await callWithRpc(chain, (p) =>
      new ethers.Contract(ethers.getAddress(poolAddress), POOL_ABI, p).factory());
  } catch (e) {
    return null;
  }
}

/// ファクトリーが管理するプールの総数を取得する。
async function getPairsLength(chain, factory) {
  try {
    const n = await callWithRpc(chain, (p) =>
      new ethers.Contract(ethers.getAddress(factory), FACTORY_ABI, p).allPairsLength());
    return Number(n);
  } catch (e) {
    return 0;
  }
}

/// allPairs(i) をMulticallで一括呼び出しし、プールアドレスの一覧を得る。
async function listPoolAddresses(chain, factory, total) {
  const limit = Math.min(total, MAX_POOLS_PER_FACTORY);
  // 新しいプールほど活発なことが多いため、末尾(新しい方)から取る。
  const startIndex = Math.max(0, total - limit);
  const addresses = [];

  for (let offset = 0; offset < limit; offset += BATCH_SIZE) {
    const calls = [];
    for (let i = offset; i < Math.min(offset + BATCH_SIZE, limit); i++) {
      calls.push({
        target: ethers.getAddress(factory),
        allowFailure: true,
        callData: FACTORY_IFACE.encodeFunctionData("allPairs", [startIndex + i]),
      });
    }
    try {
      const returned = await callWithRpc(chain, (p) =>
        new ethers.Contract(MULTICALL3_ADDRESS, MULTICALL3_ABI, p).aggregate3(calls));
      for (const r of returned) {
        if (!r.success || r.returnData === "0x") continue;
        try {
          const addr = FACTORY_IFACE.decodeFunctionResult("allPairs", r.returnData)[0];
          if (addr && addr !== ethers.ZeroAddress) addresses.push(addr);
        } catch (inner) {}
      }
    } catch (e) {
      break; // このファクトリーはここまで
    }
  }
  return addresses;
}

/// プール一覧に対して token0/token1 を一括取得する。
async function fetchPoolTokens(chain, addresses) {
  const result = new Map();
  for (let i = 0; i < addresses.length; i += Math.floor(BATCH_SIZE / 2)) {
    const chunk = addresses.slice(i, i + Math.floor(BATCH_SIZE / 2));
    const calls = [];
    for (const addr of chunk) {
      const target = ethers.getAddress(addr);
      calls.push({ target, allowFailure: true, callData: PAIR_META_IFACE.encodeFunctionData("token0") });
      calls.push({ target, allowFailure: true, callData: PAIR_META_IFACE.encodeFunctionData("token1") });
    }
    try {
      const returned = await callWithRpc(chain, (p) =>
        new ethers.Contract(MULTICALL3_ADDRESS, MULTICALL3_ABI, p).aggregate3(calls));
      for (let j = 0; j < chunk.length; j++) {
        const r0 = returned[j * 2], r1 = returned[j * 2 + 1];
        if (!r0?.success || !r1?.success) continue;
        try {
          const token0 = PAIR_META_IFACE.decodeFunctionResult("token0", r0.returnData)[0];
          const token1 = PAIR_META_IFACE.decodeFunctionResult("token1", r1.returnData)[0];
          result.set(chunk[j].toLowerCase(), { token0: token0.toLowerCase(), token1: token1.toLowerCase() });
        } catch (inner) {}
      }
    } catch (e) { /* このかたまりは諦めて次へ */ }
  }
  return result;
}

/// 1つのファクトリーから、プールの一覧(アドレス・トークン・準備量)を取得する。
export async function discoverPoolsFromFactory(chain, factory, dexId) {
  const total = await getPairsLength(chain, factory);
  if (total === 0) return [];

  const addresses = await listPoolAddresses(chain, factory, total);
  if (addresses.length === 0) return [];

  const tokens = await fetchPoolTokens(chain, addresses);
  const reserves = await fetchReservesBatch(chain, addresses.map((a) => ({ address: a })));

  const pools = [];
  for (const addr of addresses) {
    const key = addr.toLowerCase();
    const t = tokens.get(key);
    const r = reserves.get(key);
    if (!t || !r) continue;
    if (r.raw0 <= 0n || r.raw1 <= 0n) continue; // 空のプールは除外
    pools.push({
      address: addr, chain, dexId, factory,
      token0: t.token0, token1: t.token1,
      raw0: r.raw0, raw1: r.raw1,
    });
  }

  console.log(`[プール発見] ${dexId} on ${chain}: ファクトリー全${total}件中${pools.length}件を取り込み`);
  return pools;
}

export { MAX_POOLS_PER_FACTORY };
