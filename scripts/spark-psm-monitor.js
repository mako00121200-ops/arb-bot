// scripts/spark-psm-monitor.js
//
// **固定レートの交換所と DEX の価格のずれを、送らずに測る。**(案2とその仲間)
//
// [仕組み(オーナーの指示で調査 → 案2、2026年9月24日)]
// 「いつでも決まった値段で交換してくれる場所」と、値段が動く DEX の間にずれがあれば、
//   A: USDC → (交換所) → X → (DEX) → USDC
//   B: USDC → (DEX) → X → (交換所) → USDC
// のどちらかで差額が取れる。片側の価格が確定しているので、見積もりの外れが起きにくい。
//
// 対象(オーナーの指示「同じようなものが無いかリサーチ」で広げた):
//   1. Spark PSM3(base / arbitrum / optimism): USDC↔USDS は 1:1、sUSDS は公式レート。滑り・手数料なし
//      住所: sparkdotfi/spark-address-registry の src/Base.sol・Arbitrum.sol・Optimism.sol
//   2. Aave GHO の GSM(arbitrum): USDC→GHO は 1:1(手数料0)、GHO→USDC は 1:1 − 手数料(0.10%)
//      住所: aave-dao/aave-address-book の src/GhoArbitrum.sol(GSM_USDC)。関数は aave/gho-core の IGsm.sol
//
// [測ること(送信はしない)]
// 額($100 / $1,000 / $10,000)ごとに、交換所側は交換所自身の見積もり関数、DEX 側はチェーンに直接
// 試算させて(onchain-quote.js)、A と B の差額 − ガス代 を記録する。在庫不足も数える。
//
// **速さの実測**(オーナーの指示「実際どれぐらいの速さが必要か実測で」):
// 黒字のずれを見つけたら、その経路だけを2秒ごとに測り直し、**ずれが何秒続いたか**を記録する。
// 続いた時間が長ければ速さの勝負ではない。短ければ、その秒数が要る速さの上限になる。
//
// [環境変数]
//   SPARK_MONITOR_ENABLED     … "false" で止める
//   SPARK_MONITOR_INTERVAL_MS … 読む間隔(既定2分)
import { ethers } from "ethers";
import { callWithRpc } from "./onchain-reserves.js";
import { gasUnitsToUsd } from "./gas-cost.js";
import { getKnownTokens } from "./borrowable-tokens.js";
import { bestSellQuote } from "./onchain-quote.js";
import { nowJst } from "./jst.js";

const ENABLED = process.env.SPARK_MONITOR_ENABLED !== "false";
const INTERVAL_MS = parseInt(process.env.SPARK_MONITOR_INTERVAL_MS || String(2 * 60 * 1000), 10);
/// 交換所 + DEX 1〜2段のガス量の見込み
const GAS_UNITS = 350000n;
const SIZES_USD = [100, 1000, 10000];
/// ずれが続く時間の追跡: 何ミリ秒ごとに測り直し、最長で何ミリ秒追うか
const TRACK_EVERY_MS = 2000;
const TRACK_MAX_MS = 10 * 60 * 1000;

const PSMS = {
  base: { psm: "0x1601843c5E9bC251A3272907010AFa41Fa18347E", usdc: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    usds: "0x820C137fa70C8691f0e44Dc420a5e53c168921Dc", susds: "0x5875eEE11Cf8398102FdAd704C9E96607675467a" },
  arbitrum: { psm: "0x2B05F8e1cACC6974fD79A673a341Fe1f58d27266", usdc: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831",
    usds: "0x6491c05A82219b8D1479057361ff1654749b876b", susds: "0xdDb46999F8891663a8F2828d25298f70416d7610" },
  optimism: { psm: "0xe0F9978b907853F354d79188A3dEfbD41978af62", usdc: "0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85",
    usds: "0x4F13a96EC5C4Cf34e442b46Bbd98a0791F20edC3", susds: "0xb5B2dc7fd34C249F4be7fB1fCea07950784229e0" },
};
const GSMS = {
  arbitrum: { gsm: "0x53E0cE250d06043414070100458546AaF4e284eD", gho: "0x7dfF72693f6A4149b17e7C6314655f6A9F7c8B33" },
};

const PSM_IFACE = new ethers.Interface([
  "function usdc() view returns (address)",
  "function usds() view returns (address)",
  "function susds() view returns (address)",
  "function pocket() view returns (address)",
  "function previewSwapExactIn(address assetIn, address assetOut, uint256 amountIn) view returns (uint256)",
]);
const GSM_IFACE = new ethers.Interface([
  "function GHO_TOKEN() view returns (address)",
  "function UNDERLYING_ASSET() view returns (address)",
  "function getIsFrozen() view returns (bool)",
  "function getIsSeized() view returns (bool)",
  "function getAvailableLiquidity() view returns (uint256)",
  "function getAvailableUnderlyingExposure() view returns (uint256)",
  // 返り値: 実際に使う資産の量, 受け取る GHO(手数料後), 総額, 手数料
  "function getGhoAmountForSellAsset(uint256 maxAssetAmount) view returns (uint256, uint256, uint256, uint256)",
  // 返り値: 受け取る資産の量, 実際に払う GHO, 総額, 手数料
  "function getAssetAmountForBuyAsset(uint256 maxGhoAmount) view returns (uint256, uint256, uint256, uint256)",
]);
const ERC20_IFACE = new ethers.Interface(["function balanceOf(address) view returns (uint256)"]);
/// GSM の担保が素の USDC ではなく、USDC を預けた利息付きの包み(ERC-4626。Aave の stata トークン)の場合に使う。
/// 預け入れ・引き出しはその場で終わるので、USDC →(預ける)→ 包み →(GSM)→ GHO の形で1つの取引にできる
const ERC4626_IFACE = new ethers.Interface([
  "function asset() view returns (address)",
  "function previewDeposit(uint256 assets) view returns (uint256)",
  "function previewRedeem(uint256 shares) view returns (uint256)",
]);

const verified = new Map(); // `${venue}:${chain}` -> true / false
/// `${venue}:${chain}` -> { reads, byRoute: { key -> {...} }, shortStock, noDex, maxNetUsd, durations: [秒], tracking: Set }
const stats = new Map();

async function view(chain, to, iface, fn, args = []) {
  const raw = await callWithRpc(chain, (p) => p.call({ to, data: iface.encodeFunctionData(fn, args) }), false);
  const r = iface.decodeFunctionResult(fn, raw);
  return r.length === 1 ? r[0] : r;
}
const same = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();

async function verifyPsm(chain, a) {
  const k = `Spark:${chain}`;
  if (verified.has(k)) return verified.get(k);
  try {
    const [u, s, ss] = await Promise.all(["usdc", "usds", "susds"].map((fn) => view(chain, a.psm, PSM_IFACE, fn)));
    const ok = same(u, a.usdc) && same(s, a.usds) && same(ss, a.susds);
    if (!ok) console.warn(`[Spark計測] ${chain}: PSM の通貨が表と違うので測りません(usdc ${u} / usds ${s} / susds ${ss})`);
    verified.set(k, ok);
    return ok;
  } catch (e) { return false; }
}

async function verifyGsm(chain, g) {
  const k = `GHO:${chain}`;
  if (verified.has(k)) return verified.get(k);
  try {
    const [gho, under] = await Promise.all([view(chain, g.gsm, GSM_IFACE, "GHO_TOKEN"), view(chain, g.gsm, GSM_IFACE, "UNDERLYING_ASSET")]);
    let known = getKnownTokens(chain)[String(under).toLowerCase()];
    let base = String(under);
    // 担保が利息付きの包み(ERC-4626)なら、中身の通貨を聞く(2026年9月24日の初回で、arbitrum の GSM の担保は
    // 素の USDC ではなく 0xE6D5…d5C1 だった)。中身が手書きのステーブルなら「預けて → GSM」で測る
    if (!known?.stable) {
      const inner = await view(chain, under, ERC4626_IFACE, "asset").catch(() => null);
      const innerKnown = inner ? getKnownTokens(chain)[String(inner).toLowerCase()] : null;
      if (innerKnown?.stable) { g.wrapper = String(under); base = String(inner); known = innerKnown; }
    }
    const ok = same(gho, g.gho) && !!known?.stable;
    console.log(`[Spark計測] ${chain}: GHO の GSM 照合 ${ok ? "OK" : "不一致のため測らない"}(GHO ${gho} / 担保 ${under}`
      + `${g.wrapper ? `(${known.symbol} を預けた包み)` : known ? ` ${known.symbol}` : " 手書きに無い通貨"})`);
    if (ok) g.usdc = base;
    verified.set(k, ok);
    return ok;
  } catch (e) {
    // 黙って失敗し続けないよう、理由を一度だけ出す(2026年9月24日、GHO の行が一度も出なかった)
    if (!g.errLogged) { g.errLogged = true; console.warn(`[GHO計測] ${chain}: GSM の照合に失敗 ${(e.shortMessage || e.message || "").slice(0, 120)}`); }
    return false;
  }
}

/// 1本の経路を評価する関数を作る。戻り値の関数は { out, x, label, short } を返す(out=null は経路なし)
function routes(chain, venue, ctx) {
  const list = [];
  const hubs = [...Object.keys(getKnownTokens(chain))];
  for (const usd of SIZES_USD) {
    const x = BigInt(usd) * 1000000n; // USDC は6桁
    if (venue === "Spark") {
      const a = ctx;
      for (const [name, tok] of [["sUSDS", a.susds], ["USDS", a.usds]]) {
        list.push({ key: `${name} 交換所→DEX $${usd}`, usd, eval: async () => {
          const got = await view(chain, a.psm, PSM_IFACE, "previewSwapExactIn", [a.usdc, tok, x]);
          const s = await bestSellQuote(chain, tok, a.usdc, BigInt(got), [...hubs, a.usds]);
          return { out: s ? s.out : null, x, label: s?.label || "", need: { token: tok, amount: BigInt(got) } };
        } });
        list.push({ key: `${name} DEX→交換所 $${usd}`, usd, eval: async () => {
          const b = await bestSellQuote(chain, a.usdc, tok, x, [...hubs, a.usds]);
          if (!b) return { out: null, x };
          const out = await view(chain, a.psm, PSM_IFACE, "previewSwapExactIn", [tok, a.usdc, b.out]);
          return { out: BigInt(out), x, label: b.label, need: { token: a.usdc, amount: BigInt(out) } };
        } });
      }
    } else {
      const g = ctx;
      list.push({ key: `GHO 交換所→DEX $${usd}`, usd, eval: async () => {
        // 包みなら先に預ける(USDC → 包み)。GSM に入れるのは包みの枚数
        const shares = g.wrapper ? BigInt(await view(chain, g.wrapper, ERC4626_IFACE, "previewDeposit", [x])) : x;
        const r = await view(chain, g.gsm, GSM_IFACE, "getGhoAmountForSellAsset", [shares]);
        const used = BigInt(r[0]), gho = BigInt(r[1]);
        // 実際に使った USDC(GSM が端数を残した分は使っていない)
        const usedUsdc = g.wrapper ? (used === shares ? x : (x * used) / shares) : used;
        const s = await bestSellQuote(chain, g.gho, g.usdc, gho, hubs);
        return { out: s ? s.out : null, x: usedUsdc, label: s?.label || "", needExposure: used };
      } });
      list.push({ key: `GHO DEX→交換所 $${usd}`, usd, eval: async () => {
        const b = await bestSellQuote(chain, g.usdc, g.gho, x, hubs);
        if (!b) return { out: null, x };
        const r = await view(chain, g.gsm, GSM_IFACE, "getAssetAmountForBuyAsset", [b.out]);
        const got = BigInt(r[0]);
        // 包みなら引き出す(包み → USDC)
        const out = g.wrapper ? BigInt(await view(chain, g.wrapper, ERC4626_IFACE, "previewRedeem", [got])) : got;
        return { out, x, label: b.label, needLiquidity: got };
      } });
    }
  }
  return list;
}

/// 黒字のずれが**何秒続いたか**を測る。2秒ごとに同じ経路を測り直し、赤字に戻った時点で終える。
async function track(st, chain, venue, route, gasUsd, firstNet) {
  const id = route.key;
  if (st.tracking.has(id)) return;
  st.tracking.add(id);
  const started = Date.now();
  let maxNet = firstNet, reads = 1;
  try {
    while (Date.now() - started < TRACK_MAX_MS) {
      await new Promise((r) => setTimeout(r, TRACK_EVERY_MS));
      let net = null;
      try {
        const r = await route.eval();
        if (r.out != null) net = Number(r.out - r.x) / 1e6 - gasUsd;
      } catch (e) {}
      reads++;
      if (net == null || net <= 0) break;
      if (net > maxNet) maxNet = net;
    }
  } finally {
    st.tracking.delete(id);
  }
  const sec = (Date.now() - started) / 1000;
  const capped = Date.now() - started >= TRACK_MAX_MS;
  st.durations.push({ sec, capped, maxNet });
  if (st.durations.length > 500) st.durations.shift();
  console.log(`[${venue}計測/持続 ${nowJst()}] ${chain} ${id}: 黒字のずれが${capped ? `${Math.round(sec)}秒以上(追跡の上限)` : `約${Math.round(sec)}秒`}続いた`
    + `(${reads}回測定、最大純利$${maxNet.toFixed(3)})。**これより速く送れば取れた**`);
}

async function measureVenue(chain, venue, ctx) {
  const k = `${venue}:${chain}`;
  const st = stats.get(k) || { reads: 0, byRoute: {}, shortStock: 0, noDex: 0, maxNetUsd: null, durations: [], tracking: new Set() };
  stats.set(k, st);
  st.reads++;
  const gasUsd = (await gasUnitsToUsd(chain, GAS_UNITS).catch(() => null)) ?? 0.05;
  // 在庫: Spark は USDC を pocket、USDS / sUSDS を PSM 自身が持つ。GHO の GSM は関数で聞く
  let stock = {}, gsmLiq = null, gsmExp = null, frozen = false;
  if (venue === "Spark") {
    const pocket = await view(chain, ctx.psm, PSM_IFACE, "pocket").catch(() => ctx.psm);
    for (const [t, holder] of [[ctx.usdc, pocket], [ctx.usds, ctx.psm], [ctx.susds, ctx.psm]]) {
      stock[t.toLowerCase()] = await view(chain, t, ERC20_IFACE, "balanceOf", [holder]).catch(() => null);
    }
  } else {
    frozen = (await view(chain, ctx.gsm, GSM_IFACE, "getIsFrozen").catch(() => false))
      || (await view(chain, ctx.gsm, GSM_IFACE, "getIsSeized").catch(() => false));
    gsmLiq = await view(chain, ctx.gsm, GSM_IFACE, "getAvailableLiquidity").catch(() => null);
    gsmExp = await view(chain, ctx.gsm, GSM_IFACE, "getAvailableUnderlyingExposure").catch(() => null);
    st.frozen = frozen;
    if (frozen) return;
  }
  for (const route of routes(chain, venue, ctx)) {
    let r;
    try { r = await route.eval(); } catch (e) { r = { out: null }; }
    if (r.out == null) { st.noDex++; continue; }
    if (r.need && stock[r.need.token.toLowerCase()] != null && BigInt(stock[r.need.token.toLowerCase()]) < r.need.amount) st.shortStock++;
    if (r.needLiquidity != null && gsmLiq != null && BigInt(gsmLiq) < r.needLiquidity) st.shortStock++;
    if (r.needExposure != null && gsmExp != null && BigInt(gsmExp) < r.needExposure) st.shortStock++;
    const bps = Number(((r.out - r.x) * 100000n) / r.x) / 10;
    const netUsd = Number(r.out - r.x) / 1e6 - gasUsd;
    const rr = st.byRoute[route.key] || { bestBps: null, positives: 0, lastBps: null };
    rr.lastBps = bps;
    if (rr.bestBps == null || bps > rr.bestBps) rr.bestBps = bps;
    st.byRoute[route.key] = rr;
    if (netUsd > 0) {
      rr.positives++;
      if (st.maxNetUsd == null || netUsd > st.maxNetUsd) st.maxNetUsd = netUsd;
      console.log(`[${venue}計測/機会 ${nowJst()}] ${chain} ${route.key}: 差${bps.toFixed(1)}bps 純利$${netUsd.toFixed(3)}`
        + `(DEX ${r.label} / ガス$${gasUsd.toFixed(3)})。**送っていません**`);
      track(st, chain, venue, route, gasUsd, netUsd).catch(() => {}); // 待たない(他の経路の計測を止めない)
    }
  }
}

export function startSparkMonitor(activeChains) {
  if (!ENABLED || !(INTERVAL_MS > 0)) return;
  const sparkChains = activeChains.filter((c) => PSMS[c]);
  const ghoChains = activeChains.filter((c) => GSMS[c]);
  if (sparkChains.length + ghoChains.length === 0) return;
  console.log(`[Spark計測] ${INTERVAL_MS / 60000}分ごとに固定レートの交換所と DEX のずれを読みます`
    + `(Spark: ${sparkChains.join(",") || "なし"} / GHO: ${ghoChains.join(",") || "なし"})。黒字なら何秒続くかも測ります。**送信はしません**`);
  const run = async () => {
    for (const chain of sparkChains) {
      if (!(await verifyPsm(chain, PSMS[chain]))) continue;
      await measureVenue(chain, "Spark", PSMS[chain]).catch((e) => console.warn(`[Spark計測] ${chain} 失敗 ${(e.shortMessage || e.message || "").slice(0, 80)}`));
    }
    for (const chain of ghoChains) {
      if (!(await verifyGsm(chain, GSMS[chain]))) continue;
      await measureVenue(chain, "GHO", GSMS[chain]).catch((e) => console.warn(`[GHO計測] ${chain} 失敗 ${(e.shortMessage || e.message || "").slice(0, 80)}`));
    }
  };
  setTimeout(() => { run(); setInterval(run, INTERVAL_MS); }, 4 * 60 * 1000);
}

/// 生存ログ用。経路ごとに「今回の差」と「これまでの最良」、黒字のずれが続いた秒数
export function formatSparkLine() {
  if (stats.size === 0) return "";
  const parts = [];
  for (const [k, st] of stats) {
    const routesTxt = Object.entries(st.byRoute)
      .sort((x, y) => (y[1].bestBps ?? -1e9) - (x[1].bestBps ?? -1e9)).slice(0, 3)
      .map(([rk, r]) => `${rk} 今${r.lastBps?.toFixed(1)}bps/最良${r.bestBps?.toFixed(1)}bps 黒字${r.positives}回`).join(" ");
    const d = st.durations.map((x) => x.sec).sort((a, b) => a - b);
    const durTxt = d.length ? ` 続いた秒数[中央${Math.round(d[Math.floor(d.length / 2)])} 最短${Math.round(d[0])} ${d.length}件]` : "";
    parts.push(`${k} 読み${st.reads}回${st.frozen ? " **停止中**" : ""} ${routesTxt || "経路なし"}${st.shortStock ? ` 在庫不足${st.shortStock}` : ""}`
      + `${st.noDex ? ` DEX経路なし${st.noDex}` : ""}${st.maxNetUsd != null ? ` 最大$${st.maxNetUsd.toFixed(3)}` : ""}${durTxt}`);
  }
  return ` 固定レート[${parts.join(" / ")}]`;
}
