// scripts/pool-fee-onchain.js
//
// **V2系プールの手数料を、チェーンから直接読む。**
//
// [なぜ要るか(2026年9月21日、実測で判明)]
// Base の `uniswap-v3(X%)→aerodrome→sync発見` が、見込み $0.12〜$0.49
// (今の平均の20〜50倍)で何度も `K()` で拒否されていた。
// K() は「その受取量では不変量を割る」= **こちらの手数料の前提が低すぎる**。
//
// 手数料を直す仕組みは既にあった(`clearFeeProbed` → 実測し直し)。
// しかしそれは **「実測済み」の印を外す**関数で、このプールは
// **一度も実測されていなかった**(生存ログ `手数料1(残0)`)。
// 外す印が無いので、何も起きなかった。
//
// 既存の実測は**スワップのログから逆算**する方式で、Aerodrome のような
// Solidly系では当たらないことがある。ログが無い・形が違えば測れない。
//
// **プール自身と工場に聞けば、推測も逆算も要らない。**
// Solidly系(Aerodrome / Velodrome / Ramses 等)は工場が手数料を持っている。
// 呼び名はフォークごとに違うので、**全部まとめて投げて、返ったものを使う**。
//
// RPC は**1プールにつき1回の束ね**だけ。

import { ethers } from "ethers";
import { callWithRpc } from "./onchain-reserves.js";

const MULTICALL3_ADDRESS = "0xcA11bde05977b3631167028862bE2a173976CA11";
const MULTICALL3_ABI = [
  "function aggregate3((address target, bool allowFailure, bytes callData)[] calls) view returns ((bool success, bytes returnData)[] returnData)",
];

const POOL_IFACE = new ethers.Interface([
  "function stable() view returns (bool)",
  "function factory() view returns (address)",
  "function fee() view returns (uint256)",
]);
/// 工場側の呼び名はフォークごとに違う。**全部試す。**
const FACTORY_IFACE = new ethers.Interface([
  "function getFee(address pool, bool stable) view returns (uint256)", // Aerodrome / Velodrome V2
  "function getFee(bool stable) view returns (uint256)",               // 旧 Solidly / Velodrome V1
  "function stableFee() view returns (uint256)",
  "function volatileFee() view returns (uint256)",
]);

/// 手数料として受け入れてよい範囲(bps)。
/// これを外れた値は「別の意味の数」なので使わない(呼び名が同じでも中身が違う)。
const MIN_FEE_BPS = 1;
const MAX_FEE_BPS = 1000; // 10%

function decodeUint(iface, name, ret) {
  try {
    if (!ret?.success || ret.returnData === "0x") return null;
    const v = iface.decodeFunctionResult(name, ret.returnData)[0];
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  } catch (e) { return null; }
}

/// プールの手数料(bps)と stable かどうかを、チェーンから読む。
/// 戻り値: { feeBps, stable, source } / 読めなければ null
export async function readPoolFeeOnchain(chain, poolAddress, factoryAddress) {
  const pool = ethers.getAddress(poolAddress);

  // ① まずプール自身に聞く(stable / factory / fee)。
  let stable = null, factory = factoryAddress || null, selfFee = null;
  try {
    const calls = [
      { target: pool, allowFailure: true, callData: POOL_IFACE.encodeFunctionData("stable") },
      { target: pool, allowFailure: true, callData: POOL_IFACE.encodeFunctionData("factory") },
      { target: pool, allowFailure: true, callData: POOL_IFACE.encodeFunctionData("fee") },
    ];
    const ret = await callWithRpc(chain, (p) =>
      new ethers.Contract(MULTICALL3_ADDRESS, MULTICALL3_ABI, p).aggregate3(calls));
    try { if (ret[0]?.success) stable = POOL_IFACE.decodeFunctionResult("stable", ret[0].returnData)[0]; } catch (e) {}
    try { if (ret[1]?.success) factory = POOL_IFACE.decodeFunctionResult("factory", ret[1].returnData)[0]; } catch (e) {}
    selfFee = decodeUint(POOL_IFACE, "fee", ret[2]);
  } catch (e) {
    return null;
  }

  // プール自身が手数料を持っていれば、それが一番確か。
  if (selfFee != null && selfFee >= MIN_FEE_BPS && selfFee <= MAX_FEE_BPS) {
    return { feeBps: selfFee, stable: stable === true, source: "pool.fee()" };
  }

  if (!factory || factory === ethers.ZeroAddress) {
    return stable == null ? null : { feeBps: null, stable: stable === true, source: "stable()のみ" };
  }

  // ② 工場に聞く。**呼び名は分からないので全部投げる。**
  const isStable = stable === true;
  const attempts = [
    ["getFee(address,bool)", FACTORY_IFACE.encodeFunctionData("getFee(address,bool)", [pool, isStable])],
    ["getFee(bool)", FACTORY_IFACE.encodeFunctionData("getFee(bool)", [isStable])],
    [isStable ? "stableFee()" : "volatileFee()",
     FACTORY_IFACE.encodeFunctionData(isStable ? "stableFee" : "volatileFee")],
  ];
  try {
    const calls = attempts.map(([, data]) => ({ target: factory, allowFailure: true, callData: data }));
    const ret = await callWithRpc(chain, (p) =>
      new ethers.Contract(MULTICALL3_ADDRESS, MULTICALL3_ABI, p).aggregate3(calls));
    for (let i = 0; i < attempts.length; i++) {
      const [name] = attempts[i];
      const v = decodeUint(FACTORY_IFACE, name.replace(/\(.*/, ""), ret[i]);
      if (v != null && v >= MIN_FEE_BPS && v <= MAX_FEE_BPS) {
        return { feeBps: v, stable: isStable, source: `factory.${name}` };
      }
    }
  } catch (e) {}

  return stable == null ? null : { feeBps: null, stable: isStable, source: "stable()のみ" };
}
