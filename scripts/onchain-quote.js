// scripts/onchain-quote.js
//
// **価格表や地図に頼らず、チェーンに直接「いくらで売れるか」を聞く。**
//
// [なぜ(2026年9月24日)]
// UniswapX の比べ方を見直した時、我々の模型の経路(価格表のある V3 だけを使う)は、
// $1,000 を超える額では深い V3 プールを候補から落とし、薄い V2 を選んでいたことが分かった。
// Compound の割引担保・Spark の交換所との比較は「数千ドルを DEX で売ったらいくらか」が肝なので、
// 模型ではなく**チェーンの答え**で測る。
//
// やること:
//   1. その組の V3 プールを、そのチェーンの V3 ファクトリー全部に聞いて見つける(6時間覚える)
//   2. 見つけたプール全部に、自前コントラクトの quoteV3 で実際の受取量を試算させる(1段)
//   3. 中継通貨(手書きの主要通貨)を挟んだ2段も試す
//
// 送信は一切しない。読むだけ。
import { ethers } from "ethers";
import { getAnyChainConfig } from "../chain-config.js";
import { V3_FACTORIES } from "./v3-pools.js";
import { findV3PoolsBatch, quoteV3ByPoolBatch } from "./multicall-reserves.js";
import { callWithRpc } from "./onchain-reserves.js";
// base の Aerodrome Slipstream(清算の売却経路と同じ工場。住所の出典はそちらのコメント)
import { EXTRA_V3_FACTORIES, SLIPSTREAM_TICK_SPACINGS } from "./liquidation-executor.js";

const FEE_TIERS = [100, 500, 3000, 10000];

/// Solidly 型(Aerodrome / Velodrome の旧来型)のプール工場。安定型(stable)と変動型の2種類がある。
/// ステーブル同士(sUSDS・USDS など)は V3 ではなくこちらにあることが多い(2026年9月24日の Spark 計測で、
/// V3 の工場だけでは sUSDS の取引所が1つも見つからなかった)。
/// 住所の出典: aerodrome-finance/contracts と velodrome-finance/contracts の README の配備表。
const SOLIDLY_FACTORIES = {
  base: [{ address: "0x420DD381b31aEf6683db6B902084cB0FFECe40Da", dexId: "aerodrome" }],
  optimism: [{ address: "0xF1046053aa5682b4F9a81b5481394DA16BE5FF5a", dexId: "velodrome" }],
};
const SOLIDLY_FACTORY_IFACE = new ethers.Interface(["function getPool(address tokenA, address tokenB, bool stable) view returns (address)"]);
const SOLIDLY_POOL_IFACE = new ethers.Interface(["function getAmountOut(uint256 amountIn, address tokenIn) view returns (uint256)"]);
const solidlyCache = new Map();

async function findSolidlyPools(chain, tokenA, tokenB) {
  const [t0, t1] = [tokenA.toLowerCase(), tokenB.toLowerCase()].sort();
  const k = `${chain}|${t0}|${t1}`;
  const c = solidlyCache.get(k);
  if (c && Date.now() - c.at < POOL_CACHE_MS) return c.pools;
  const pools = [];
  for (const f of SOLIDLY_FACTORIES[chain] || []) {
    for (const stable of [true, false]) {
      try {
        const raw = await callWithRpc(chain, (p) => p.call({ to: f.address, data: SOLIDLY_FACTORY_IFACE.encodeFunctionData("getPool", [t0, t1, stable]) }), false);
        const a = SOLIDLY_FACTORY_IFACE.decodeFunctionResult("getPool", raw)[0];
        if (a && a !== ethers.ZeroAddress) pools.push({ address: a.toLowerCase(), dexId: `${f.dexId}(${stable ? "安定" : "変動"})` });
      } catch (e) {}
    }
  }
  solidlyCache.set(k, { at: Date.now(), pools });
  return pools;
}

/// Solidly 型のプールに、その場の受取量を聞く(プール自身の getAmountOut。手数料込み)
async function solidlyQuotes(chain, pools, tokenIn, amountIn, blockTag) {
  const out = [];
  for (const p of pools) {
    try {
      const raw = await callWithRpc(chain, (pr) => pr.call({ to: p.address, data: SOLIDLY_POOL_IFACE.encodeFunctionData("getAmountOut", [amountIn, tokenIn]), blockTag: blockTag ?? "latest" }), false);
      out.push(BigInt(SOLIDLY_POOL_IFACE.decodeFunctionResult("getAmountOut", raw)[0]));
    } catch (e) { out.push(null); }
  }
  return out;
}
const POOL_CACHE_MS = 6 * 60 * 60 * 1000;
const poolCache = new Map(); // `${chain}|${t0}|${t1}` -> { at, pools: [{ address, dexId }] }

/// その組の V3 プールをファクトリーに聞く(地図に無くても見つかる)。
export async function findV3Pools(chain, tokenA, tokenB) {
  const [t0, t1] = [tokenA.toLowerCase(), tokenB.toLowerCase()].sort();
  const k = `${chain}|${t0}|${t1}`;
  const c = poolCache.get(k);
  if (c && Date.now() - c.at < POOL_CACHE_MS) return c.pools;
  const pools = [];
  for (const f of [...(V3_FACTORIES[chain] || []), ...(EXTRA_V3_FACTORIES[chain] || [])]) {
    const reqs = f.style === "algebra"
      ? [{ tokenA: t0, tokenB: t1 }]
      : f.style === "slipstream" ? SLIPSTREAM_TICK_SPACINGS.map((tickSpacing) => ({ tokenA: t0, tokenB: t1, tickSpacing }))
        : FEE_TIERS.map((feeTier) => ({ tokenA: t0, tokenB: t1, feeTier }));
    if (reqs.length === 0) continue;
    let addrs = [];
    try { addrs = await findV3PoolsBatch(chain, f.address, f.style, reqs); } catch (e) { continue; }
    addrs.forEach((a, i) => {
      if (!a || a === ethers.ZeroAddress) return;
      const fee = reqs[i].feeTier != null ? `(${(reqs[i].feeTier / 10000).toFixed(2)}%)`
        : reqs[i].tickSpacing != null ? `(ts${reqs[i].tickSpacing})` : "";
      pools.push({ address: a.toLowerCase(), dexId: `${f.dexId}${fee}` });
    });
  }
  poolCache.set(k, { at: Date.now(), pools });
  return pools;
}

function quoterAddress(chain) {
  const cfg = getAnyChainConfig(chain);
  return cfg ? process.env[cfg.contractAddressEnvVar] || null : null;
}

/// tokenIn を amountIn だけ売った時の最良の受取量(1段と、中継通貨を挟んだ2段)。
/// @returns { out, label, path } / 売れる経路が無ければ null
///   path は通ったプールの列 [{ pool, tokenIn, tokenOut, kind: "v3" | "solidly" }](WOOFi の送信で段を組むのに使う)
export async function bestSellQuote(chain, tokenIn, tokenOut, amountIn, hubs = [], blockTag = null) {
  const quoter = quoterAddress(chain);
  if (!quoter || !(amountIn > 0n)) return null;
  const from = tokenIn.toLowerCase(), to = tokenOut.toLowerCase();
  let best = null;
  const direct = await findV3Pools(chain, from, to);
  if (direct.length > 0) {
    const outs = await quoteV3ByPoolBatch(chain, quoter,
      direct.map((p) => ({ pool: p.address, tokenIn: from, amountIn })), false, blockTag);
    outs.forEach((o, i) => {
      if (o != null && (!best || o > best.out)) best = { out: o, label: direct[i].dexId, path: [{ pool: direct[i].address, tokenIn: from, tokenOut: to, kind: "v3" }] };
    });
  }
  // Solidly 型(1段だけ)
  const sol = await findSolidlyPools(chain, from, to);
  if (sol.length > 0) {
    const outs = await solidlyQuotes(chain, sol, from, amountIn, blockTag);
    outs.forEach((o, i) => {
      if (o != null && o > 0n && (!best || o > best.out)) best = { out: o, label: sol[i].dexId, path: [{ pool: sol[i].address, tokenIn: from, tokenOut: to, kind: "solidly" }] };
    });
  }
  for (const hub of hubs) {
    const mid = String(hub).toLowerCase();
    if (mid === from || mid === to) continue;
    const firsts = await findV3Pools(chain, from, mid);
    if (firsts.length === 0) continue;
    const seconds = await findV3Pools(chain, mid, to);
    if (seconds.length === 0) continue;
    const o1 = await quoteV3ByPoolBatch(chain, quoter,
      firsts.map((p) => ({ pool: p.address, tokenIn: from, amountIn })), false, blockTag);
    let m = null, mLabel = "", mPool = null;
    o1.forEach((o, i) => { if (o != null && (m == null || o > m)) { m = o; mLabel = firsts[i].dexId; mPool = firsts[i].address; } });
    if (m == null) continue;
    const o2 = await quoteV3ByPoolBatch(chain, quoter,
      seconds.map((p) => ({ pool: p.address, tokenIn: mid, amountIn: m })), false, blockTag);
    o2.forEach((o, i) => {
      if (o != null && (!best || o > best.out)) {
        best = { out: o, label: `${mLabel}→${seconds[i].dexId}`, path: [
          { pool: mPool, tokenIn: from, tokenOut: mid, kind: "v3" },
          { pool: seconds[i].address, tokenIn: mid, tokenOut: to, kind: "v3" },
        ] };
      }
    });
  }
  return best;
}
