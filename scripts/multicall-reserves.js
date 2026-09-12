// scripts/multicall-reserves.js
//
// Multicall3(対応チェーン全てに同一アドレスで存在する標準コントラクト)を
// 使い、多数のプールのデータを「1回のRPC呼び出し」でまとめて読む。
//
// RPCへの接続は onchain-reserves.js の callWithRpc を経由する。
// これにより8秒のタイムアウトとチェーンごとの待ち行列、失敗時の
// RPC自動切り替えがそのまま適用される。

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

const MAX_POOLS_PER_CALL = 40;

async function multicall(chain, calls) {
  return callWithRpc(chain, (provider) =>
    new ethers.Contract(MULTICALL3_ADDRESS, MULTICALL3_ABI, provider).aggregate3(calls));
}

/// 複数プールの準備量とtoken0を一括で読む。
/// 戻り値: Map<小文字アドレス, { raw0, raw1, token0 } | null(読めない)>
export async function fetchReservesBatch(chain, pools) {
  const result = new Map();
  for (let i = 0; i < pools.length; i += MAX_POOLS_PER_CALL) {
    const chunk = pools.slice(i, i + MAX_POOLS_PER_CALL);
    const calls = [];
    for (const p of chunk) {
      const target = ethers.getAddress(p.address);
      calls.push({ target, allowFailure: true, callData: PAIR_IFACE.encodeFunctionData("getReserves") });
      calls.push({ target, allowFailure: true, callData: PAIR_IFACE.encodeFunctionData("token0") });
    }
    let returned;
    try {
      returned = await multicall(chain, calls);
    } catch (e) {
      for (const p of chunk) result.set(p.address.toLowerCase(), null);
      continue;
    }
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

/// 複数プールの token0 / token1 / stable を一括で読む。
/// Syncイベントで見つかった未知のプールを地図へ取り込む際に使う。
/// stable型(x³y+y³x曲線)は計算式が違い、取り込むと送信が「K」で
/// 拒否されるため、結果から除外する(戻り値に含めない)。
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
    let returned;
    try {
      returned = await multicall(chain, calls);
    } catch (e) {
      continue;
    }
    for (let j = 0; j < chunk.length; j++) {
      const r0 = returned[j * 3], r1 = returned[j * 3 + 1], rs = returned[j * 3 + 2];
      if (!r0?.success || !r1?.success || r0.returnData === "0x" || r1.returnData === "0x") continue;
      try {
        const token0 = PAIR_IFACE.decodeFunctionResult("token0", r0.returnData)[0];
        const token1 = PAIR_IFACE.decodeFunctionResult("token1", r1.returnData)[0];
        if (token0.toLowerCase() === token1.toLowerCase()) continue;
        // stable() を持ち、かつ true を返すプールは除外する。
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
