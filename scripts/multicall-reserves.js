// scripts/multicall-reserves.js
//
// Multicall3(4チェーン全てに同一アドレスで存在する標準コントラクト)を
// 使い、多数のプールの準備量を「1回のRPC呼び出し」でまとめて読む。
//
// 従来はプール1つごとに2回(getReserves + token0)、順番に呼んでいたため、
// 60プールで120回のRPC呼び出しが必要だった。Multicall3なら1〜2回で済み、
// 観測間隔を3分→十数秒に縮めても、RPCのレート制限に当たらない。
//
// 読めないプール(V3/V4等、getReservesを持たない)は、Multicall3の
// allowFailure=true により、他のプールを巻き込まずに個別に失敗扱いになる。

import { ethers } from "ethers";
import { getProviderForChain } from "./onchain-reserves.js";

export const MULTICALL3_ADDRESS = "0xcA11bde05977b3631167028862bE2a173976CA11";

const MULTICALL3_ABI = [
  "function aggregate3((address target, bool allowFailure, bytes callData)[] calls) view returns ((bool success, bytes returnData)[] returnData)",
];
const PAIR_IFACE = new ethers.Interface([
  "function getReserves() view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast)",
  "function token0() view returns (address)",
]);

// 1回のMulticallに詰めるプール数の上限(1プール=2呼び出し)。
// 大きすぎるとRPC側の応答サイズ制限に当たるため、安全側に設定。
const MAX_POOLS_PER_CALL = 40;

/// 複数プールの準備量を一括で読む。
/// pools: [{ address }] の配列。
/// 戻り値: Map<小文字アドレス, { raw0, raw1, token0 } | null(読めない)>
export async function fetchReservesBatch(chain, pools) {
  const provider = getProviderForChain(chain);
  const multicall = new ethers.Contract(MULTICALL3_ADDRESS, MULTICALL3_ABI, provider);
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
      returned = await multicall.aggregate3(calls);
    } catch (e) {
      console.warn(`[Multicall] ${chain}: 一括読み取りに失敗:`, e.message.slice(0, 80));
      for (const p of chunk) result.set(p.address.toLowerCase(), null);
      continue;
    }

    for (let j = 0; j < chunk.length; j++) {
      const key = chunk[j].address.toLowerCase();
      const r1 = returned[j * 2];
      const r2 = returned[j * 2 + 1];
      if (!r1.success || !r2.success || r1.returnData === "0x" || r2.returnData === "0x") {
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

/// 1つの「実行可能ペア」について、全プールの準備量を一括で読み、
/// dexWatchOnePair と同じ形のプール一覧を返す。
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
