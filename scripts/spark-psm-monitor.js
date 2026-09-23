// scripts/spark-psm-monitor.js
//
// **Spark PSM(固定レートの交換所)と DEX の価格のずれを、送らずに測る。**
//
// [仕組み(オーナーの指示で調査 → 案2、2026年9月24日)]
// Spark PSM3 は base / arbitrum / optimism で USDC・USDS・sUSDS を交換する。
// USDC↔USDS は 1:1、sUSDS は公式レート(rateProvider)で、**滑りも手数料もない**。
// DEX の sUSDS(や USDS)の価格がこのレートからずれた時、
//   A: USDC → (PSM) → sUSDS → (DEX) → USDC
//   B: USDC → (DEX) → sUSDS → (PSM) → USDC
// のどちらかで差額が取れる。片側の価格が確定しているので、見積もりの外れが起きにくい。
//
// [ここでやること(送信はしない)]
// 額($100 / $1,000 / $10,000)ごとに、PSM 側は previewSwapExactIn(PSM 自身の見積もり)、
// DEX 側はチェーンに直接試算させて(onchain-quote.js)、A と B の差額 − ガス代 を記録する。
// PSM の在庫(受け取る側の通貨の残高)が足りない額は「在庫不足」として別に数える。
//
// [住所の出典] sparkdotfi/spark-address-registry の src/Base.sol・Arbitrum.sol・Optimism.sol
// (2026年9月24日に確認)。初回に PSM の usdc()/usds()/susds() を読み、表と違えば測らない。
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
/// PSM の交換 + DEX 1〜2段のガス量の見込み
const GAS_UNITS = 350000n;
const SIZES_USD = [100, 1000, 10000];

const PSMS = {
  base: { psm: "0x1601843c5E9bC251A3272907010AFa41Fa18347E", usdc: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    usds: "0x820C137fa70C8691f0e44Dc420a5e53c168921Dc", susds: "0x5875eEE11Cf8398102FdAd704C9E96607675467a" },
  arbitrum: { psm: "0x2B05F8e1cACC6974fD79A673a341Fe1f58d27266", usdc: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831",
    usds: "0x6491c05A82219b8D1479057361ff1654749b876b", susds: "0xdDb46999F8891663a8F2828d25298f70416d7610" },
  optimism: { psm: "0xe0F9978b907853F354d79188A3dEfbD41978af62", usdc: "0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85",
    usds: "0x4F13a96EC5C4Cf34e442b46Bbd98a0791F20edC3", susds: "0xb5B2dc7fd34C249F4be7fB1fCea07950784229e0" },
};

const PSM_IFACE = new ethers.Interface([
  "function usdc() view returns (address)",
  "function usds() view returns (address)",
  "function susds() view returns (address)",
  "function pocket() view returns (address)",
  "function previewSwapExactIn(address assetIn, address assetOut, uint256 amountIn) view returns (uint256)",
]);
const ERC20_IFACE = new ethers.Interface(["function balanceOf(address) view returns (uint256)"]);

const verified = new Map(); // chain -> true / false
const stats = new Map();    // chain -> { reads, byRoute: { key -> { bestBps, bestNetUsd, positives } }, shortStock, noDex, maxNetUsd, last }

async function view(chain, to, iface, fn, args = []) {
  const raw = await callWithRpc(chain, (p) => p.call({ to, data: iface.encodeFunctionData(fn, args) }), false);
  return iface.decodeFunctionResult(fn, raw)[0];
}

async function verify(chain, a) {
  if (verified.has(chain)) return verified.get(chain);
  try {
    const [u, s, ss] = await Promise.all(["usdc", "usds", "susds"].map((fn) => view(chain, a.psm, PSM_IFACE, fn)));
    const ok = [[u, a.usdc], [s, a.usds], [ss, a.susds]].every(([x, y]) => String(x).toLowerCase() === y.toLowerCase());
    if (!ok) console.warn(`[Spark計測] ${chain}: PSM の通貨が表と違うので測りません(usdc ${u} / usds ${s} / susds ${ss})`);
    verified.set(chain, ok);
    return ok;
  } catch (e) {
    return false; // 次回また確かめる
  }
}

async function measure(chain) {
  const a = PSMS[chain];
  if (!(await verify(chain, a))) return;
  const st = stats.get(chain) || { reads: 0, byRoute: {}, shortStock: 0, noDex: 0, maxNetUsd: null };
  stats.set(chain, st);
  st.reads++;
  const gasUsd = (await gasUnitsToUsd(chain, GAS_UNITS).catch(() => null)) ?? 0.05;
  const hubs = [...Object.keys(getKnownTokens(chain)), a.usds];
  // PSM の在庫: USDC は pocket、USDS / sUSDS は PSM 自身が持つ
  const pocket = await view(chain, a.psm, PSM_IFACE, "pocket").catch(() => a.psm);
  const stock = {
    [a.usdc.toLowerCase()]: await view(chain, a.usdc, ERC20_IFACE, "balanceOf", [pocket]).catch(() => null),
    [a.usds.toLowerCase()]: await view(chain, a.usds, ERC20_IFACE, "balanceOf", [a.psm]).catch(() => null),
    [a.susds.toLowerCase()]: await view(chain, a.susds, ERC20_IFACE, "balanceOf", [a.psm]).catch(() => null),
  };
  for (const [name, tok] of [["sUSDS", a.susds], ["USDS", a.usds]]) {
    for (const usd of SIZES_USD) {
      const x = BigInt(usd) * 1000000n; // USDC は6桁
      // A: PSM で買って DEX で売る
      const viaPsm = await view(chain, a.psm, PSM_IFACE, "previewSwapExactIn", [a.usdc, tok, x]).catch(() => null);
      let aOut = null, aLabel = "";
      if (viaPsm != null) {
        if (stock[tok.toLowerCase()] != null && BigInt(stock[tok.toLowerCase()]) < BigInt(viaPsm)) st.shortStock++;
        const s = await bestSellQuote(chain, tok, a.usdc, BigInt(viaPsm), hubs).catch(() => null);
        if (s) { aOut = s.out; aLabel = s.label; } else st.noDex++;
      }
      // B: DEX で買って PSM で売る
      const viaDex = await bestSellQuote(chain, a.usdc, tok, x, hubs).catch(() => null);
      let bOut = null;
      if (viaDex) {
        bOut = await view(chain, a.psm, PSM_IFACE, "previewSwapExactIn", [tok, a.usdc, viaDex.out]).catch(() => null);
        if (bOut != null && stock[a.usdc.toLowerCase()] != null && BigInt(stock[a.usdc.toLowerCase()]) < BigInt(bOut)) st.shortStock++;
      } else st.noDex++;
      for (const [dir, out, label] of [["PSM→DEX", aOut, aLabel], ["DEX→PSM", bOut != null ? BigInt(bOut) : null, viaDex?.label || ""]]) {
        if (out == null) continue;
        const bps = Number(((out - x) * 100000n) / x) / 10;
        const netUsd = Number(out - x) / 1e6 - gasUsd;
        const k = `${name}${dir}$${usd}`;
        const r = st.byRoute[k] || { bestBps: null, bestNetUsd: null, positives: 0, lastBps: null };
        r.lastBps = bps;
        if (r.bestBps == null || bps > r.bestBps) r.bestBps = bps;
        if (r.bestNetUsd == null || netUsd > r.bestNetUsd) r.bestNetUsd = netUsd;
        if (netUsd > 0) {
          r.positives++;
          if (st.maxNetUsd == null || netUsd > st.maxNetUsd) st.maxNetUsd = netUsd;
          console.log(`[Spark計測/機会 ${nowJst()}] ${chain} ${name} ${dir} $${usd}: 差${bps.toFixed(1)}bps 純利$${netUsd.toFixed(3)}`
            + `(DEX ${label} / ガス$${gasUsd.toFixed(3)})。**送っていません**`);
        }
        st.byRoute[k] = r;
      }
    }
  }
}

export function startSparkMonitor(activeChains) {
  if (!ENABLED || !(INTERVAL_MS > 0)) return;
  const chains = activeChains.filter((c) => PSMS[c]);
  if (chains.length === 0) return;
  console.log(`[Spark計測] ${INTERVAL_MS / 60000}分ごとに PSM と DEX のずれを読みます(${chains.join(",")})。**送信はしません**`);
  const run = async () => {
    for (const chain of chains) {
      await measure(chain).catch((e) => console.warn(`[Spark計測] ${chain} 失敗 ${(e.shortMessage || e.message || "").slice(0, 80)}`));
    }
  };
  setTimeout(() => { run(); setInterval(run, INTERVAL_MS); }, 4 * 60 * 1000);
}

/// 生存ログ用。額ごとに「今回の差」と「これまでの最良」
export function formatSparkLine() {
  if (stats.size === 0) return "";
  const parts = [];
  for (const [chain, st] of stats) {
    const routes = Object.entries(st.byRoute)
      .sort((x, y) => (y[1].bestBps ?? -1e9) - (x[1].bestBps ?? -1e9)).slice(0, 3)
      .map(([k, r]) => `${k} 今${r.lastBps?.toFixed(1)}bps/最良${r.bestBps?.toFixed(1)}bps 黒字${r.positives}回`).join(" ");
    parts.push(`${chain} 読み${st.reads}回 ${routes || "経路なし"}${st.shortStock ? ` 在庫不足${st.shortStock}` : ""}${st.noDex ? ` DEX経路なし${st.noDex}` : ""}${st.maxNetUsd != null ? ` 最大$${st.maxNetUsd.toFixed(3)}` : ""}`);
  }
  return ` Spark[${parts.join(" / ")}]`;
}
