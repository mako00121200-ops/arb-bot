// scripts/liquidation-executor.js
//
// 清算の候補(liquidation-monitor.js が組んだもの)を受け取り、
//   1. 担保を借金の通貨に売る経路を探す(Uniswap V3 → 無ければ Pharaoh / LFJ)
//   2. コントラクトの simulateLiquidation(eth_call)で「返済後に残る利益」を確かめる
//   3. LIQUIDATION_DRY_RUN=false の時だけ送信する
// 送信の流儀(記録簿・成功ログ・画面)は execute-opportunity.js と同じ。
//
// [経路の探し方]
// 裁定のプール地図は「同じペアに2つ以上のプールがあるペア」に絞られているので、
// 担保→借金のプールが地図に無いことがある。そこで V3 のファクトリー(Uniswap / Pharaoh 等)と
// V2 のファクトリー(LFJ V1)に「このペアのプールはあるか」を聞き、結果を覚えておく。
// 中継(そのチェーンの基軸とステーブル。HUB_SYMBOLS 参照)を挟む2段の経路も候補にする。
//
// [順位づけと確認]
// 候補の経路は、まず見積もり(V3 は裁定コントラクトの quoteV3、V2 は準備量の式)で並べ、
// 上位だけをコントラクトの simulateLiquidation で確かめる。**送る前の答えは必ず eth_call の結果。**
// 見積もりは順位を決めるためだけに使う。

import { ethers } from "ethers";
import { getChainConfig } from "../chain-config.js";
import { callWithRpc, poolHasAmountOut } from "./onchain-reserves.js";
import { getSigner, resetNonce } from "./execute-opportunity.js";
import { getPoolsForPair, KIND_V3 } from "./pool-registry.js";
import { MULTICALL3_ADDRESS, quoteV3ByPoolBatch, findV3PoolsBatch, fetchReservesBatch } from "./multicall-reserves.js";
import { V3_FACTORIES } from "./v3-pools.js";
import { gasUnitsToUsd, weiToUsd, getEstimatedGasPriceWei, recordActualGasPrice } from "./gas-cost.js";
import { recordRealExecution } from "./real-execution-log.js";
import { alertOwner } from "./owner-alert.js";
import { CHAIN, TAG, BOOK, DRY_RUN, MIN_PROFIT_USD, MAX_SLIPPAGE_BPS, getReserveInfo, noteSimulation } from "./liquidation-monitor.js";
import { liquidatorAddressEnvVar } from "./liquidator-deploy.js";
// お金に関わる行は、Railway の UTC ではなく**日本時間**で読めるようにする。
import { nowJst } from "./jst.js";

// ===== 設定 =====
/// ガス量は固定値 + 余裕(オーナーの指示)。費用の見積もりには GAS_UNITS、送信の上限には GAS_LIMIT。
const GAS_UNITS = BigInt(process.env.LIQUIDATION_GAS_UNITS || "1200000");
const GAS_LIMIT = BigInt(process.env.LIQUIDATION_GAS_LIMIT || "2000000");
/// 鎖上に要求する最低利益の、**取り消しが得になる境目**(裁定側と同じ考え方)。
/// 取り消しても実行してもガス代はほぼ同じなので、少しでも利益が残るなら実行した方が損が小さい。
/// 境目はガス代の約10%。詳しくは scripts/execute-opportunity.js の REVERT_GAS_SHARE。
const REVERT_GAS_SHARE = parseFloat(process.env.REVERT_GAS_SHARE || "0.10");
/// ガス代か利益が分からない時の割合(bps)。
const MIN_PROFIT_SHARE_BPS = BigInt(process.env.LIQUIDATION_MIN_PROFIT_SHARE_BPS || "500");
/// 見積もりで並べた経路のうち、eth_call で確かめる本数。
const SIMULATE_TOP_N = parseInt(process.env.LIQUIDATION_SIMULATE_TOP_N || "3", 10);
/// V3 のファクトリーに聞く手数料帯。
const FEE_TIERS = [100, 500, 3000, 10000];
/// V2 のファクトリー(住所:名前:手数料bps)。応答しなければ無視される。
///
/// **既定の LFJ(Trader Joe)V1 は avalanche の住所**なので、他のチェーンでは付けない。
/// 他チェーンの住所をここに書くと、**存在しない契約に毎回問い合わせて枠を捨てる**。
/// 必要なら `LIQUIDATION_V2_FACTORIES` で明示する。
const V2_FACTORY_DEFAULTS = {
  avalanche: "0x9Ad6C38BE94206cA50bb0d90783181662f0Cfa10:lfj-v1:30",
};
const V2_FACTORIES = (process.env.LIQUIDATION_V2_FACTORIES || V2_FACTORY_DEFAULTS[CHAIN] || "")
  .split(",").map((v) => v.trim()).filter(Boolean).map((v) => {
    const [address, dexId, fee] = v.split(":");
    if (!/^0x[0-9a-fA-F]{40}$/.test(address || "")) return null;
    return { address, dexId: dexId || "v2", feeBps: parseInt(fee || "30", 10) };
  }).filter(Boolean);
/// 中継に使う通貨(**住所は address-book から**。記号だけをここに書く)。
///
/// 記号はチェーンごとに違う(avalanche は WETHe / USDt、base は WETH / USDbC)。
/// **無い記号は静かに落ちる**ので、address-book に実在する綴りを使うこと
/// (2026年9月22日に各チェーンの一覧を実際に出して確かめた)。
const HUB_SYMBOLS = {
  avalanche: ["WAVAX", "USDC", "USDt", "WETHe", "BTCb"],
  base:      ["WETH", "USDC", "cbBTC", "wstETH", "USDbC"],
  optimism:  ["WETH", "USDC", "USDT", "WBTC", "USDCn"],
  arbitrum:  ["WETH", "USDC", "USDT", "WBTC", "USDCn"],
  polygon:   ["WPOL", "USDC", "USDT0", "WETH", "WBTC", "USDCn"],
};
const HUBS = (HUB_SYMBOLS[CHAIN] || [])
  .map((k) => BOOK?.ASSETS?.[k]?.UNDERLYING).filter(Boolean).map((a) => a.toLowerCase());
if (BOOK && HUBS.length === 0) {
  console.warn(`[${TAG}] 中継通貨が1つも見つかりません(記号の綴り違い?)。経路探しが弱くなります`);
}
/// 清算の売却経路だけに使う追加の工場(裁定側のプール探索には入れない)。
///
/// [なぜ(2026年9月23日の Morpho 経路点検)]
/// base の Morpho で借り手の多い12市場を $1,000 売ってみると、cbDOGE −43%・cbADA −60%・cbLTC −6.5% と
/// 大きく目減りした(algebra-b→WETH→uniswap-v3 の遠回り)。これらは base で最大の Aerodrome の
/// 集中流動性(Slipstream)で主に取引されており、今の探索に入っていなかった。
/// 住所は aerodrome-finance/slipstream の README / script/constants/output/DeployCL-Base.json(工場は2つ)。
/// スワップの呼び返しは uniswapV3SwapCallback なので、コントラクトはそのまま使える。
export const EXTRA_V3_FACTORIES = {
  base: [
    { address: "0x5e7BB104d84c7CB9B682AaC2F3d509f5F406809A", dexId: "aerodrome-cl", style: "slipstream" },
    { address: "0xaDe65c38CD4849aDBA595a4323a8C7DdfE89716a", dexId: "aerodrome-cl2", style: "slipstream" },
  ],
};
/// Slipstream の刻み幅(工場の tickSpacings() の既定の組)。無い組は住所0が返るだけ。
export const SLIPSTREAM_TICK_SPACINGS = [1, 10, 50, 100, 200, 2000];
/// プールの探索結果を覚えておく時間。
const POOL_CACHE_MS = 6 * 60 * 60 * 1000;

const CONTRACT_FLAG_V3 = 1;
const CONTRACT_FLAG_IN_IS_TOKEN0 = 2;
const CONTRACT_FLAG_HAS_QUOTE = 4;

const LIQ_TUPLE = "(address collateralAsset, address debtAsset, address user, uint256 debtToCover, uint256 minProfit)";
const LEG_TUPLE = "(address pool, address tokenOut, uint8 flags, uint16 feeBps)[]";
const LIQUIDATOR_ABI = [
  `function liquidate(${LIQ_TUPLE} liq, ${LEG_TUPLE} legs)`,
  `function simulateLiquidation(${LIQ_TUPLE} liq, ${LEG_TUPLE} legs)`,
  "function POOL() view returns (address)",
  "function owner() view returns (address)",
  "error SimulationResult(uint256 returned, uint256 owed)",
  "event Liquidated(address indexed user, address indexed debtAsset, address indexed collateralAsset, uint256 debtCovered, uint256 seized, uint256 profit)",
];
const LIQUIDATOR_IFACE = new ethers.Interface(LIQUIDATOR_ABI);
const V2_FACTORY_IFACE = new ethers.Interface(["function getPair(address tokenA, address tokenB) view returns (address)"]);
const MULTICALL3_ABI = ["function aggregate3((address target, bool allowFailure, bytes callData)[] calls) view returns ((bool success, bytes returnData)[] returnData)"];

/// Aave の取り消し理由(文字列の番号)。Errors.sol より。
const AAVE_ERRORS = {
  "26": "INVALID_AMOUNT", "27": "RESERVE_INACTIVE", "28": "RESERVE_FROZEN", "29": "RESERVE_PAUSED",
  "32": "COLLATERAL_BALANCE_IS_ZERO", "34": "COLLATERAL_CANNOT_COVER_NEW_BORROW",
  "45": "HEALTH_FACTOR_NOT_BELOW_THRESHOLD(もう清算できない)", "46": "COLLATERAL_CANNOT_BE_LIQUIDATED",
  "47": "SPECIFIED_CURRENCY_NOT_BORROWED_BY_USER", "90": "INVALID_FLASHLOAN_EXECUTOR_RETURN", "91": "FLASHLOAN_DISABLED",
  "97": "INVALID_FLASHLOAN_CALLER", "103": "MUST_NOT_LEAVE_DUST(残りが$1,000未満になる)",
};

const stats = { noContract: false, ownerChecked: false, ownerAddress: null, routesFound: 0, simulations: 0, sends: 0 };

function short(a) { return (a || "").slice(0, 10) + "…"; }
function sym(asset) { return getReserveInfo(asset)?.symbol || short(asset); }
function contractAddress() { return process.env[liquidatorAddressEnvVar(CHAIN)] || ""; }

async function multicall(calls) {
  return callWithRpc(CHAIN, (p) => new ethers.Contract(MULTICALL3_ADDRESS, MULTICALL3_ABI, p).aggregate3(calls), true);
}

// ===== 売る経路のプール探し =====

/// ペア -> { at, pools: [{ address, kind, token0, token1, dexId, feeBps }] }
const pairPools = new Map();
function pairKey(a, b) { return [a.toLowerCase(), b.toLowerCase()].sort().join("|"); }

/// このペアのプールを集める(地図 + V3 ファクトリー + V2 ファクトリー)。結果は6時間覚える。
async function findPools(tokenA, tokenB) {
  const key = pairKey(tokenA, tokenB);
  const cached = pairPools.get(key);
  if (cached && Date.now() - cached.at < POOL_CACHE_MS) return cached.pools;
  const found = new Map();
  const add = (p) => { const k = p.address.toLowerCase(); if (!found.has(k)) found.set(k, { ...p, address: k }); };

  // ① 裁定のプール地図(token0 が分かっている)。
  for (const p of getPoolsForPair(CHAIN, tokenA, tokenB)) {
    add({ address: p.address, kind: p.kind, token0: p.token0, token1: p.token1, dexId: p.dexId, feeBps: p.feeBps ?? 30 });
  }
  // ② V3 のファクトリー。Uniswap 系は token0 = 住所の小さい方(計算で分かる)。
  const [t0, t1] = [tokenA.toLowerCase(), tokenB.toLowerCase()].sort();
  for (const f of [...(V3_FACTORIES[CHAIN] || []), ...(EXTRA_V3_FACTORIES[CHAIN] || [])]) {
    try {
      const reqs = f.style === "algebra" ? [{ tokenA: t0, tokenB: t1 }]
        : f.style === "slipstream" ? SLIPSTREAM_TICK_SPACINGS.map((tickSpacing) => ({ tokenA: t0, tokenB: t1, tickSpacing }))
        : FEE_TIERS.map((feeTier) => ({ tokenA: t0, tokenB: t1, feeTier }));
      const addrs = await findV3PoolsBatch(CHAIN, f.address, f.style, reqs);
      addrs.forEach((a, i) => { if (a) add({ address: a, kind: KIND_V3, token0: t0, token1: t1, dexId: f.dexId, feeTier: reqs[i].feeTier ?? null, feeBps: 0 }); });
    } catch (e) {}
  }
  // ③ V2 のファクトリー(LFJ V1 等)。
  if (V2_FACTORIES.length > 0) {
    try {
      const calls = V2_FACTORIES.map((f) => ({ target: ethers.getAddress(f.address), allowFailure: true, callData: V2_FACTORY_IFACE.encodeFunctionData("getPair", [ethers.getAddress(t0), ethers.getAddress(t1)]) }));
      const returned = await multicall(calls);
      V2_FACTORIES.forEach((f, i) => {
        const r = returned[i];
        if (!r?.success || r.returnData === "0x") return;
        try {
          const addr = V2_FACTORY_IFACE.decodeFunctionResult("getPair", r.returnData)[0];
          if (addr && addr !== ethers.ZeroAddress) add({ address: addr, kind: "v2", token0: t0, token1: t1, dexId: f.dexId, feeBps: f.feeBps });
        } catch (e) {}
      });
    } catch (e) {}
  }
  const pools = [...found.values()];
  pairPools.set(key, { at: Date.now(), pools });
  return pools;
}

/// 1段ぶんの受取量を見積もる(順位づけ用)。V3 は裁定コントラクトの quoteV3、V2 は準備量の式。
async function quoteHop(pools, tokenIn, amountIn) {
  const out = new Array(pools.length).fill(null);
  if (amountIn <= 0n || pools.length === 0) return out;
  const v3Idx = pools.map((p, i) => (p.kind === KIND_V3 ? i : -1)).filter((i) => i >= 0);
  const v2Idx = pools.map((p, i) => (p.kind !== KIND_V3 ? i : -1)).filter((i) => i >= 0);
  const arbContract = process.env[getChainConfig(CHAIN)?.contractAddressEnvVar || ""];
  if (v3Idx.length > 0 && arbContract) {
    try {
      const quotes = await quoteV3ByPoolBatch(CHAIN, arbContract, v3Idx.map((i) => ({ pool: pools[i].address, tokenIn, amountIn })), true);
      v3Idx.forEach((i, j) => { out[i] = quotes[j]; });
    } catch (e) {}
  }
  if (v2Idx.length > 0) {
    try {
      const reserves = await fetchReservesBatch(CHAIN, v2Idx.map((i) => ({ address: pools[i].address })), true);
      for (const i of v2Idx) {
        const r = reserves.get(pools[i].address);
        if (!r) continue;
        const inIs0 = pools[i].token0 === tokenIn.toLowerCase();
        const rIn = inIs0 ? r.raw0 : r.raw1, rOut = inIs0 ? r.raw1 : r.raw0;
        if (rIn <= 0n || rOut <= 0n) continue;
        const withFee = amountIn * (10000n - BigInt(pools[i].feeBps || 30));
        out[i] = (withFee * rOut) / (rIn * 10000n + withFee);
      }
    } catch (e) {}
  }
  return out;
}

function legOf(pool, tokenIn, tokenOut) {
  let flags = 0;
  if (pool.kind === KIND_V3) flags |= CONTRACT_FLAG_V3;
  if (pool.token0 === tokenIn.toLowerCase()) flags |= CONTRACT_FLAG_IN_IS_TOKEN0;
  if (pool.kind !== KIND_V3 && poolHasAmountOut(CHAIN, pool.address)) flags |= CONTRACT_FLAG_HAS_QUOTE;
  return { pool: ethers.getAddress(pool.address), tokenOut: ethers.getAddress(tokenOut), flags, feeBps: pool.kind === KIND_V3 ? 0 : Math.max(0, Math.min(9999, pool.feeBps || 30)), dexId: pool.dexId };
}

/// 担保 → 借金の通貨の経路を集め、見積もりで並べる。
/// 戻り値: [{ legs, label, estimatedOut }](受取量の多い順)
export async function buildRoutes(collateral, debt, seized) {
  const routes = [];
  const c = collateral.toLowerCase(), d = debt.toLowerCase();
  // 1段目の相手: 借金の通貨そのもの + 中継。
  const firstTargets = [d, ...HUBS.filter((h) => h !== c && h !== d)];
  const firstPools = [];
  for (const t of firstTargets) {
    for (const p of await findPools(c, t)) firstPools.push({ pool: p, tokenOut: t });
  }
  if (firstPools.length === 0) return routes;
  const firstOut = await quoteHop(firstPools.map((x) => x.pool), c, seized);
  // 直接。
  firstPools.forEach((x, i) => {
    if (x.tokenOut === d && firstOut[i] && firstOut[i] > 0n) {
      routes.push({ legs: [legOf(x.pool, c, d)], label: `${x.pool.dexId}`, estimatedOut: firstOut[i] });
    }
  });
  // 中継を挟む2段: 中継ごとに1段目の最良を取り、2段目を見積もる。
  for (const hub of firstTargets.filter((t) => t !== d)) {
    let best = null;
    firstPools.forEach((x, i) => { if (x.tokenOut === hub && firstOut[i] && firstOut[i] > 0n && (!best || firstOut[i] > best.out)) best = { pool: x.pool, out: firstOut[i] }; });
    if (!best) continue;
    const second = await findPools(hub, d);
    if (second.length === 0) continue;
    const secondOut = await quoteHop(second, hub, best.out);
    second.forEach((p, i) => {
      if (secondOut[i] && secondOut[i] > 0n) {
        routes.push({ legs: [legOf(best.pool, c, hub), legOf(p, hub, d)], label: `${best.pool.dexId}→${sym(hub)}→${p.dexId}`, estimatedOut: secondOut[i] });
      }
    });
  }
  routes.sort((a, b) => (a.estimatedOut < b.estimatedOut ? 1 : a.estimatedOut > b.estimatedOut ? -1 : 0));
  return routes;
}

// ===== 確認(eth_call)=====

function describeAaveRevert(e) {
  const data = e?.data ?? e?.info?.error?.data ?? e?.error?.data ?? null;
  let reason = e?.reason || null;
  if (!reason && typeof data === "string" && data.startsWith("0x08c379a0")) {
    try { reason = ethers.AbiCoder.defaultAbiCoder().decode(["string"], "0x" + data.slice(10))[0]; } catch (inner) {}
  }
  if (reason && AAVE_ERRORS[reason]) return `Aave ${reason} ${AAVE_ERRORS[reason]}`;
  if (reason) return `理由: ${String(reason).slice(0, 100)}`;
  if (typeof data === "string" && data.length >= 10) return `取り消しの中身: ${data.slice(0, 10)}(データ${data.length - 2}文字)`;
  return (e?.shortMessage || e?.message || "").slice(0, 120);
}

async function ensureOwner(address) {
  if (stats.ownerChecked) return stats.ownerAddress;
  const raw = await callWithRpc(CHAIN, (p) => p.call({ to: address, data: LIQUIDATOR_IFACE.encodeFunctionData("owner", []) }), true);
  stats.ownerAddress = LIQUIDATOR_IFACE.decodeFunctionResult("owner", raw)[0];
  stats.ownerChecked = true;
  console.log(`[${TAG}/契約] ${address} の所有者 ${stats.ownerAddress}`);
  return stats.ownerAddress;
}

/// 戻り値: { returned, owed } または { error }
async function simulate(address, from, liq, legs) {
  stats.simulations++;
  noteSimulation();
  const data = LIQUIDATOR_IFACE.encodeFunctionData("simulateLiquidation", [liq, legs.map(({ pool, tokenOut, flags, feeBps }) => ({ pool, tokenOut, flags, feeBps }))]);
  try {
    await callWithRpc(CHAIN, (p) => p.call({ to: address, from, data }), true);
    return { error: "結果が返りませんでした" };
  } catch (e) {
    const revertData = e?.data ?? e?.info?.error?.data ?? e?.error?.data ?? null;
    if (typeof revertData === "string" && revertData.startsWith("0x")) {
      try {
        const parsed = LIQUIDATOR_IFACE.parseError(revertData);
        if (parsed && parsed.name === "SimulationResult") return { returned: parsed.args.returned, owed: parsed.args.owed };
      } catch (inner) {}
    }
    return { error: describeAaveRevert(e) };
  }
}

// ===== 入口 =====

/// liquidation-monitor.js の候補の処理。戻り値は { summary, sent?, ok? }。
export async function handleLiquidationCandidate(plan) {
  const address = contractAddress();
  if (!address) {
    if (!stats.noContract) {
      stats.noContract = true;
      console.log(`[${TAG}/契約] ${liquidatorAddressEnvVar(CHAIN)} が未設定です。候補はログに出すだけで、確認も送信もしません`);
    }
    return { summary: "契約なし" };
  }
  const rc = getReserveInfo(plan.collateralAsset), rd = getReserveInfo(plan.debtAsset);
  if (!rc || !rd || rc.price === 0n || rd.price === 0n) return { summary: "価格なし" };

  // 受け取る担保の見込み: 肩代わり額 × (1 + ボーナス × (1 − プロトコルの取り分))。
  const bonusKept = 10000n + (BigInt(rc.bonusBps) * BigInt(10000 - rc.protocolFeeBps)) / 10000n;
  const seized = (plan.debtToCover * rd.price * (10n ** BigInt(rc.decimals)) * bonusKept) / (rc.price * (10n ** BigInt(rd.decimals)) * 10000n);
  // 滑りの基準: 担保をオラクル価格で借金の通貨に直した量。
  const seizedInDebt = (seized * rc.price * (10n ** BigInt(rd.decimals))) / (rd.price * (10n ** BigInt(rc.decimals)));

  const routes = await buildRoutes(plan.collateralAsset, plan.debtAsset, seized);
  stats.routesFound += routes.length;
  if (routes.length === 0) {
    console.log(`[${TAG}/経路] ${short(plan.user)}: ${sym(plan.collateralAsset)}→${sym(plan.debtAsset)} を売る経路が見つかりません`);
    return { summary: "経路なし" };
  }
  const withSlip = routes.map((r) => ({ ...r, slippageBps: seizedInDebt > 0n ? Number(((seizedInDebt - r.estimatedOut) * 10000n) / seizedInDebt) : null }));
  const okRoutes = withSlip.filter((r) => r.slippageBps == null || r.slippageBps <= MAX_SLIPPAGE_BPS);
  console.log(`[${TAG}/経路] ${short(plan.user)}: ${sym(plan.collateralAsset)}→${sym(plan.debtAsset)} 候補${routes.length}本(滑り${MAX_SLIPPAGE_BPS}bps以内${okRoutes.length}本): ` +
    withSlip.slice(0, 5).map((r) => `${r.label} 滑り${r.slippageBps == null ? "?" : r.slippageBps.toFixed(0)}bps`).join(" / "));
  if (okRoutes.length === 0) return { summary: "滑り超過" };

  const from = await ensureOwner(address);
  const liq = {
    collateralAsset: ethers.getAddress(plan.collateralAsset), debtAsset: ethers.getAddress(plan.debtAsset),
    user: ethers.getAddress(plan.user), debtToCover: plan.debtToCover, minProfit: 0n,
  };
  let best = null;
  for (const r of okRoutes.slice(0, SIMULATE_TOP_N)) {
    const sim = await simulate(address, from, liq, r.legs);
    if (sim.error) { console.log(`[${TAG}/確認 ${nowJst()}] ${short(plan.user)} ${r.label}: 取り消し(${sim.error})`); continue; }
    const profitRaw = sim.returned - sim.owed;
    const profitUsd = (Number(profitRaw) / Math.pow(10, rd.decimals)) * (Number(rd.price) / 1e8);
    console.log(`[${TAG}/確認 ${nowJst()}] ${short(plan.user)} ${r.label}: 戻り${ethers.formatUnits(sim.returned, rd.decimals)} 返済${ethers.formatUnits(sim.owed, rd.decimals)} ${sym(plan.debtAsset)} → 返済後の利益$${profitUsd.toFixed(4)}`);
    if (!best || profitRaw > best.profitRaw) best = { route: r, sim, profitRaw, profitUsd };
  }
  if (!best) return { summary: "確認で全て取り消し" };

  const gasUsd = (await gasUnitsToUsd(CHAIN, GAS_UNITS)) ?? 0.03;
  const netUsd = best.profitUsd - gasUsd;
  const verdict = netUsd >= MIN_PROFIT_USD ? "送る" : `下限$${MIN_PROFIT_USD}未満`;
  console.log(`[${TAG}/判断 ${nowJst()}] ${short(plan.user)} ${best.route.label}: 利益$${best.profitUsd.toFixed(4)} − ガス$${gasUsd.toFixed(4)} = 純利$${netUsd.toFixed(4)} → ${verdict}${DRY_RUN ? "(DRY_RUN なので送りません)" : ""}`);
  if (netUsd < MIN_PROFIT_USD) return { summary: `純利$${netUsd.toFixed(2)} 下限未満` };
  if (DRY_RUN) return { summary: `DRY_RUN 純利$${netUsd.toFixed(2)}` };

  // ===== 送信 =====
  const privateKey = process.env.MAINNET_BOT_PRIVATE_KEY;
  if (!privateKey) return { summary: "鍵なし" };
  const { signer } = getSigner(CHAIN, privateKey);
  const contract = new ethers.Contract(address, LIQUIDATOR_ABI, signer);
  const minProfit = (() => {
    if (!(best.profitRaw > 0n)) return 0n;
    if (!Number.isFinite(gasUsd) || gasUsd <= 0 || !(best.profitUsd > 0)) {
      return (best.profitRaw * MIN_PROFIT_SHARE_BPS) / 10000n;
    }
    const bps = Math.min(10000, Math.max(0, Math.round(((gasUsd * REVERT_GAS_SHARE) / best.profitUsd) * 10000)));
    return (best.profitRaw * BigInt(bps)) / 10000n;
  })();
  const estimatedGasPriceWei = await getEstimatedGasPriceWei(CHAIN);
  const legs = best.route.legs.map(({ pool, tokenOut, flags, feeBps }) => ({ pool, tokenOut, flags, feeBps }));
  const startedAt = Date.now();
  stats.sends++;
  console.log(`[${TAG}/送信 ${nowJst()}] ${short(plan.user)} ${best.route.label}: 肩代わり$${plan.coverUsd.toFixed(2)} 最低利益${ethers.formatUnits(minProfit, rd.decimals)} ${sym(plan.debtAsset)} 送信します`);
  let tx;
  try {
    tx = await contract.liquidate({ ...liq, minProfit }, legs, { gasLimit: GAS_LIMIT });
  } catch (e) {
    resetNonce(CHAIN);
    const msg = describeAaveRevert(e);
    console.warn(`[${TAG}/送信] 送れませんでした: ${msg}`);
    return { summary: `送信失敗: ${msg.slice(0, 40)}`, sent: false };
  }
  console.log(`[${TAG}/送信] ${tx.hash}`);
  let receipt;
  try {
    receipt = await tx.wait();
  } catch (e) {
    resetNonce(CHAIN);
    console.warn(`[${TAG}/送信] 確定待ちで失敗(取り消された可能性): ${(e.message || "").slice(0, 120)}`);
    return { summary: "確定で取り消し", sent: true, ok: false };
  }
  let profitTokens = null, seizedTokens = null, coveredTokens = null;
  for (const log of receipt.logs) {
    try {
      const parsed = contract.interface.parseLog({ topics: log.topics, data: log.data });
      if (parsed && parsed.name === "Liquidated") {
        profitTokens = Number(parsed.args.profit) / Math.pow(10, rd.decimals);
        seizedTokens = Number(parsed.args.seized) / Math.pow(10, rc.decimals);
        coveredTokens = Number(parsed.args.debtCovered) / Math.pow(10, rd.decimals);
      }
    } catch (e) {}
  }
  const priceDebt = Number(rd.price) / 1e8;
  const actualProfitUsd = profitTokens != null ? profitTokens * priceDebt : null;
  let actualGasCostUsd = null;
  try { actualGasCostUsd = await weiToUsd(CHAIN, receipt.gasUsed * receipt.gasPrice); } catch (e) {}
  const actualNetProfitUsd = actualProfitUsd != null && actualGasCostUsd != null ? actualProfitUsd - actualGasCostUsd : null;
  try { recordActualGasPrice(CHAIN, estimatedGasPriceWei, receipt.gasPrice); } catch (e) {}
  console.log(`[${TAG}/確定 ${nowJst()}] ブロック${receipt.blockNumber} ガス${receipt.gasUsed} 肩代わり${coveredTokens ?? "?"} ${sym(plan.debtAsset)} 受取${seizedTokens ?? "?"} ${sym(plan.collateralAsset)} 粗利+$${(actualProfitUsd ?? 0).toFixed(4)} − ガス$${(actualGasCostUsd ?? 0).toFixed(4)} = 純利益+$${(actualNetProfitUsd ?? 0).toFixed(4)}(${Date.now() - startedAt}ms)`);
  recordRealExecution({
    timestamp: new Date().toISOString(),
    pairLabel: `liquidation ${CHAIN} ${sym(plan.collateralAsset)}→${sym(plan.debtAsset)} ${short(plan.user)}`,
    kind: "liquidation",
    chain: CHAIN, txHash: tx.hash, explorerUrl: getChainConfig(CHAIN).explorerTxUrl(tx.hash),
    tradeAmountUsd: plan.coverUsd,
    predictedProfitUsd: netUsd,
    actualProfitUsd, actualGasCostUsd, actualL1FeeUsd: null, actualNetProfitUsd,
    gasUsed: receipt.gasUsed.toString(), gasCostUsd: gasUsd,
  });
  alertOwner("liquidation-success", "清算が成立しました",
    `${sym(plan.collateralAsset)}→${sym(plan.debtAsset)} 肩代わり$${plan.coverUsd.toFixed(2)} 純利益+$${(actualNetProfitUsd ?? 0).toFixed(2)}`, { quiet: true }).catch(() => {});
  return { summary: `成立 +$${(actualNetProfitUsd ?? 0).toFixed(2)}`, sent: true, ok: true };
}

/// 起動時の自己点検(読み取りのみ)。候補が出るまで実行の道筋が一度も通らないので、
/// コントラクトの住所・所有者・Pool と、典型的な組(基軸→USDC)の経路探しをここで確かめる。
/// 失敗しても起動は止めない。
export async function selfCheckLiquidationExecutor() {
  const address = contractAddress();
  if (!address) {
    console.log(`[${TAG}/契約] ${liquidatorAddressEnvVar(CHAIN)} が未設定です。候補はログに出すだけで、確認も送信もしません`);
    stats.noContract = true;
    return;
  }
  try {
    const owner = await ensureOwner(address);
    const raw = await callWithRpc(CHAIN, (p) => p.call({ to: address, data: LIQUIDATOR_IFACE.encodeFunctionData("POOL", []) }), true);
    const pool = LIQUIDATOR_IFACE.decodeFunctionResult("POOL", raw)[0];
    const wallet = process.env.MAINNET_BOT_PRIVATE_KEY ? new ethers.Wallet(process.env.MAINNET_BOT_PRIVATE_KEY).address : null;
    const ownerOk = wallet ? owner.toLowerCase() === wallet.toLowerCase() : null;
    console.log(`[${TAG}/契約] Pool ${pool} / 所有者は bot のウォレット${ownerOk === null ? "(鍵が無いので未確認)" : ownerOk ? "と一致" : "と**不一致**(送信は全て拒否されます)"}`);
  } catch (e) {
    console.warn(`[${TAG}/契約] ${address} を読めません: ${(e.message || "").slice(0, 100)}`);
    return;
  }
  // 典型的な組で経路探しを通す。清算する額の想定は $500 ぶんの基軸通貨。
  try {
    // そのチェーンの「包んだ基軸」と USDC で点検する(記号はチェーンごとに違う)。
    const nativeSym = (HUB_SYMBOLS[CHAIN] || [])[0];
    const native = BOOK?.ASSETS?.[nativeSym]?.UNDERLYING;
    const usdc = BOOK?.ASSETS?.USDC?.UNDERLYING;
    if (!native || !usdc) { console.log(`[${TAG}/自己点検] ${nativeSym || "?"}/USDC が住所帳に無いので省きます`); return; }
    const rc = getReserveInfo(native);
    if (!rc || rc.price === 0n) { console.log(`[${TAG}/自己点検] ${nativeSym} の価格がまだ無いので経路の点検は省きます`); return; }
    const seized = (500n * 10n ** 8n * 10n ** BigInt(rc.decimals)) / rc.price;
    const routes = await buildRoutes(native, usdc, seized);
    const line = routes.slice(0, 4).map((r) => `${r.label} → ${ethers.formatUnits(r.estimatedOut, 6)} USDC`).join(" / ");
    console.log(`[${TAG}/自己点検] ${nativeSym} $500ぶん → USDC の経路 ${routes.length}本${routes.length ? `: ${line}` : "(**見つからず**。ファクトリーの住所か地図を確かめること)"}`);
  } catch (e) {
    console.warn(`[${TAG}/自己点検] 経路探しに失敗: ${(e.message || "").slice(0, 120)}`);
  }
}

export function getLiquidationExecutorStats() { return { ...stats }; }
