// scripts/compound-buy-monitor.js
//
// **Compound III の「割引で売り出された担保」を、送らずに測る。**
//
// [仕組み(オーナーの指示で調査 → 案1、2026年9月24日)]
// Compound III(Comet)は清算した担保を自分で抱え、準備金(reserves)が目標(targetReserves)を
// 下回っている間は、誰でも buyCollateral() でその担保を市場価格より安く買える。
// 借りた基軸通貨(USDC)で担保を買い、DEX で売って返せば、差額が利益になる。
// 担保は売れ残っている間ずっと買えるので、「価格更新の瞬間」の速さ勝負になりにくい。
//
// [ここでやること(送信はしない)]
//   1. 各 Comet の準備金・目標・担保ごとの在庫(getCollateralReserves)を読む
//   2. 在庫があり売り出し中なら、quoteCollateral で「いくら払えば何個もらえるか」を聞く
//   3. もらった担保を DEX で売ったらいくらになるかを、チェーンに直接試算させる(onchain-quote.js)
//   4. 差額 − ガス代 − 借りる費用 を「純利」として記録する
//
// [住所の出典] compound-finance/comet の deployments/<chain>/usdc/roots.json(2026年9月24日に確認)。
// 起動後の初回読み取りで baseToken() を読み、表と違えば測らない。
//
// [環境変数]
//   COMPOUND_MONITOR_ENABLED   … "false" で止める
//   COMPOUND_MONITOR_INTERVAL_MS … 読む間隔(既定5分)
import { ethers } from "ethers";
import { callWithRpc } from "./onchain-reserves.js";
import { MULTICALL3_ADDRESS } from "./multicall-reserves.js";
import { gasUnitsToUsd } from "./gas-cost.js";
import { getTokenPriceUsd } from "./pool-registry.js";
import { getKnownTokens } from "./borrowable-tokens.js";
import { bestSellQuote } from "./onchain-quote.js";
import { nowJst } from "./jst.js";

const ENABLED = process.env.COMPOUND_MONITOR_ENABLED !== "false";
const INTERVAL_MS = parseInt(process.env.COMPOUND_MONITOR_INTERVAL_MS || String(5 * 60 * 1000), 10);
/// 買い取り + 1〜2段のスワップのガス量の見込み
const GAS_UNITS = 450000n;
/// 元手を借りる費用の見込み(bps)。Morpho のフラッシュローンなら0だが、無いチェーンもあるので控えめに置く
const BORROW_COST_BPS = 5;
/// 試す買い取り額(基軸通貨の枚数)。全部買う場合も別に試す
const TRY_SIZES = [100, 1000, 10000];

/// Comet(USDC 市場)。出典は上のコメント
const COMETS = {
  base: [{ name: "usdc", address: "0xb125E6687d4313864e53df431d5425969c15Eb2F" }],
  arbitrum: [{ name: "usdc", address: "0x9c4ec768c28520B50860ea7a15bd7213a9fF58bf" }],
  optimism: [{ name: "usdc", address: "0x2e44e174f7D53F0212823acC11C01A11d58c5bCB" }],
  polygon: [{ name: "usdc", address: "0xF25212E676D1F7F89Cd72fFEe66158f541246445" }],
};

const COMET_IFACE = new ethers.Interface([
  "function baseToken() view returns (address)",
  "function baseScale() view returns (uint256)",
  "function targetReserves() view returns (uint256)",
  "function getReserves() view returns (int256)",
  "function numAssets() view returns (uint8)",
  "function getAssetInfo(uint8 i) view returns ((uint8 offset, address asset, address priceFeed, uint64 scale, uint64 borrowCollateralFactor, uint64 liquidateCollateralFactor, uint64 liquidationFactor, uint128 supplyCap))",
  "function getCollateralReserves(address asset) view returns (uint256)",
  "function quoteCollateral(address asset, uint256 baseAmount) view returns (uint256)",
]);
const ERC20_IFACE = new ethers.Interface(["function symbol() view returns (string)"]);
const MC_ABI = ["function aggregate3((address target,bool allowFailure,bytes callData)[] calls) view returns ((bool success,bytes returnData)[])"];

const markets = new Map(); // `${chain}:${name}` -> { base, baseScale, target, assets: [{ asset, symbol, scale }] , bad }
const stats = new Map();   // key -> { reads, forSale, stock: [..], best, positives, maxNetUsd, last }

async function aggregate(chain, calls) {
  return callWithRpc(chain, (p) => new ethers.Contract(MULTICALL3_ADDRESS, MC_ABI, p).aggregate3(calls), false);
}
const dec = (fn, r) => (r?.success && r.returnData !== "0x" ? COMET_IFACE.decodeFunctionResult(fn, r.returnData) : null);

async function loadMarket(chain, c) {
  const key = `${chain}:${c.name}`;
  if (markets.has(key)) return markets.get(key);
  const t = c.address;
  const r = await aggregate(chain, ["baseToken", "baseScale", "targetReserves", "numAssets"].map((fn) =>
    ({ target: t, allowFailure: true, callData: COMET_IFACE.encodeFunctionData(fn) })));
  const base = dec("baseToken", r[0])?.[0], baseScale = dec("baseScale", r[1])?.[0];
  const target = dec("targetReserves", r[2])?.[0], n = Number(dec("numAssets", r[3])?.[0] ?? 0);
  if (!base || !baseScale || target == null) return null;
  // USDC 市場のはず(polygon は旧 USDC.e の場合がある)。基軸通貨が手書きのステーブルでなければ、
  // 住所の取り違えを疑って測らない
  const known = getKnownTokens(chain)[String(base).toLowerCase()];
  if (!known?.stable) {
    console.warn(`[Compound計測] ${chain}:${c.name} の基軸通貨 ${base} が手書きのステーブルに無いので測りません`);
    markets.set(key, { bad: true });
    return markets.get(key);
  }
  const ai = await aggregate(chain, [...Array(n).keys()].map((i) =>
    ({ target: t, allowFailure: true, callData: COMET_IFACE.encodeFunctionData("getAssetInfo", [i]) })));
  const assets = ai.map((x) => dec("getAssetInfo", x)?.[0]).filter(Boolean)
    .map((a) => ({ asset: String(a.asset).toLowerCase(), scale: BigInt(a.scale) }));
  const sy = await aggregate(chain, assets.map((a) => ({ target: a.asset, allowFailure: true, callData: ERC20_IFACE.encodeFunctionData("symbol") })));
  sy.forEach((x, i) => { try { assets[i].symbol = ERC20_IFACE.decodeFunctionResult("symbol", x.returnData)[0]; } catch (e) { assets[i].symbol = assets[i].asset.slice(0, 8); } });
  const m = { base: String(base).toLowerCase(), baseScale: BigInt(baseScale), target: BigInt(target), assets };
  markets.set(key, m);
  console.log(`[Compound計測] ${chain}:${c.name} 担保${assets.length}種(${assets.map((a) => a.symbol).join(",")}) 準備金の目標 ${(Number(m.target) / Number(m.baseScale)).toFixed(0)} ${known.symbol}`);
  return m;
}

async function measure(chain, c) {
  const key = `${chain}:${c.name}`;
  const m = await loadMarket(chain, c);
  if (!m || m.bad) return;
  const st = stats.get(key) || { reads: 0, forSale: 0, positives: 0, maxNetUsd: null, best: null, stockUsd: 0, reserves: null };
  stats.set(key, st);
  const t = c.address;
  const r = await aggregate(chain, [
    { target: t, allowFailure: true, callData: COMET_IFACE.encodeFunctionData("getReserves") },
    ...m.assets.map((a) => ({ target: t, allowFailure: true, callData: COMET_IFACE.encodeFunctionData("getCollateralReserves", [a.asset]) })),
  ]);
  const reserves = dec("getReserves", r[0])?.[0];
  if (reserves == null) return;
  st.reads++;
  st.reserves = BigInt(reserves);
  const forSale = BigInt(reserves) < m.target; // buyCollateral は準備金が目標以上だと断られる
  if (forSale) st.forSale++;
  const baseUsd = getTokenPriceUsd(chain, m.base) ?? 1;
  const gasUsd = (await gasUnitsToUsd(chain, GAS_UNITS).catch(() => null)) ?? 0.05;
  const hubs = Object.keys(getKnownTokens(chain));
  let best = null, stockUsd = 0;
  for (let i = 0; i < m.assets.length; i++) {
    const a = m.assets[i];
    const stock = dec("getCollateralReserves", r[1 + i])?.[0];
    if (!stock || BigInt(stock) === 0n) continue;
    // 1 USDC で何個もらえるか → 在庫を全部買う額
    const perBase = await callWithRpc(chain, (p) => p.call({ to: t, data: COMET_IFACE.encodeFunctionData("quoteCollateral", [a.asset, m.baseScale]) }), false)
      .then((x) => COMET_IFACE.decodeFunctionResult("quoteCollateral", x)[0]).catch(() => null);
    if (!perBase || BigInt(perBase) === 0n) continue;
    const allBase = (BigInt(stock) * m.baseScale) / BigInt(perBase);
    // 1ドル未満の在庫は塵。四捨五入で差が何千bpsにも見えるので、機会にも在庫にも数えない
    //(2026年9月24日の初回で、在庫$0 の MaticX が「差1596bps」と出た)
    if (allBase < m.baseScale) continue;
    stockUsd += (Number(allBase) / Number(m.baseScale)) * baseUsd;
    if (!forSale) continue; // 在庫はあるが売っていない(準備金が目標以上)
    const sizes = [...new Set([...TRY_SIZES.map((s) => BigInt(s) * m.baseScale).filter((s) => s < allBase), allBase])];
    for (const baseAmt of sizes) {
      const coll = await callWithRpc(chain, (p) => p.call({ to: t, data: COMET_IFACE.encodeFunctionData("quoteCollateral", [a.asset, baseAmt]) }), false)
        .then((x) => COMET_IFACE.decodeFunctionResult("quoteCollateral", x)[0]).catch(() => null);
      if (!coll || BigInt(coll) === 0n) continue;
      const sell = await bestSellQuote(chain, a.asset, m.base, BigInt(coll), hubs).catch(() => null);
      if (!sell) { best = best || { symbol: a.symbol, noRoute: true }; continue; }
      const edgeBps = Number(((sell.out - baseAmt) * 100000n) / baseAmt) / 10;
      const grossUsd = (Number(sell.out - baseAmt) / Number(m.baseScale)) * baseUsd;
      const sizeUsd = (Number(baseAmt) / Number(m.baseScale)) * baseUsd;
      const netUsd = grossUsd - gasUsd - sizeUsd * BORROW_COST_BPS / 10000;
      if (!best || best.noRoute || netUsd > best.netUsd) best = { symbol: a.symbol, sizeUsd, edgeBps, netUsd, label: sell.label };
    }
  }
  st.stockUsd = stockUsd;
  st.best = best;
  if (best && !best.noRoute && best.netUsd > 0) {
    st.positives++;
    if (st.maxNetUsd == null || best.netUsd > st.maxNetUsd) st.maxNetUsd = best.netUsd;
    console.log(`[Compound計測/機会 ${nowJst()}] ${key} ${best.symbol} を $${best.sizeUsd.toFixed(0)} で買い ${best.label} で売ると`
      + ` 差${best.edgeBps.toFixed(1)}bps 純利$${best.netUsd.toFixed(2)}(ガス$${gasUsd.toFixed(3)}・借りる費用${BORROW_COST_BPS}bps込み)。**送っていません**`);
  }
}

export function startCompoundMonitor(activeChains) {
  if (!ENABLED || !(INTERVAL_MS > 0)) return;
  const chains = activeChains.filter((c) => COMETS[c]);
  if (chains.length === 0) return;
  console.log(`[Compound計測] ${INTERVAL_MS / 60000}分ごとに割引担保を読みます(${chains.join(",")})。**送信はしません**`);
  const run = async () => {
    for (const chain of chains) for (const c of COMETS[chain]) {
      await measure(chain, c).catch((e) => console.warn(`[Compound計測] ${chain}:${c.name} 失敗 ${(e.shortMessage || e.message || "").slice(0, 80)}`));
    }
  };
  setTimeout(() => { run(); setInterval(run, INTERVAL_MS); }, 3 * 60 * 1000);
}

/// 生存ログ用
export function formatCompoundLine() {
  if (stats.size === 0) return "";
  const parts = [];
  for (const [key, st] of stats) {
    const m = markets.get(key);
    if (!m || m.bad) continue;
    const res = st.reserves != null ? (Number(st.reserves) / Number(m.baseScale)).toFixed(0) : "?";
    const tgt = (Number(m.target) / Number(m.baseScale)).toFixed(0);
    const b = st.best;
    const bestTxt = !b ? "" : b.noRoute ? ` 最良:${b.symbol}売る経路なし`
      : ` 最良:${b.symbol} $${b.sizeUsd.toFixed(0)} 差${b.edgeBps.toFixed(1)}bps 純利$${b.netUsd.toFixed(2)}`;
    parts.push(`${key} 売出${st.forSale}/${st.reads}回(準備金${res}/目標${tgt}) 在庫$${st.stockUsd.toFixed(0)}${bestTxt} 黒字${st.positives}回${st.maxNetUsd != null ? ` 最大$${st.maxNetUsd.toFixed(2)}` : ""}`);
  }
  return parts.length ? ` Compound[${parts.join(" / ")}]` : "";
}
