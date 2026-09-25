// scripts/woofi-watch.js
//
// **WOOFi(値段を外の相場から写す取引所)と DEX のずれを、送らずに測る。**(案2)
//
// [なぜ(2026年9月25日、オーナーの承認「両方始めてください」)]
// avalanche の嵐(9/25 06:29〜07:59 JST)では、DEX 同士の差だけで1.5時間 +$4.00 取れた。
// WOOFi は普通の AMM と違い、**値段を運営の価格係(Wooracle)が外の相場から書き込む**。
// 書き込みは数秒おきなので、相場が急に動く嵐の時には **WOOFi の値段が DEX より遅れる** 可能性がある。
// 遅れた値段で WOOFi と取引し、DEX で戻せば差額が取れる(案2「WOOFi の価格係の遅れ」)。
// ただし遅れがどれだけ・何秒続くかは分からないので、**まず送らずに測る**。
// 黒字なら取引用コントラクトに WOOFi の段を足す必要がある(コントラクトの変更 = オーナーに相談)。
//
// [住所の出どころ(推測ではない)]
// WOOFi 公式の文書リポジトリ woonetwork/docs の references/readme/<チェーン>.md(2026年9月25日に取得)。
//   WooRouterV2 0x4c4AF8DBc524681930a27b2F1Af5bcC8062E6fB7(5チェーン共通)
//   WooPPV2.2   0x5520385bFcf07Ec87C4c53A7d8d65595Dff69FA4(5チェーン共通)
//   IntegrationHelper(扱うトークンの一覧)はチェーンごと(下の表)
// 起動時に **ルーターの wooPool() と突き合わせ**、違えばルーターが指す方を使う(ログに出す)。
// 関数は woonetwork/WooPoolV2 の contracts/WooPPV2.sol・IntegrationHelper.sol から写した。
//
// [測ること(送信はしない)]
// $1,000 分の見積もり通貨(USDC 等)で、
//   A: 見積もり通貨 →(WOOFi)→ X →(DEX)→ 見積もり通貨
//   B: 見積もり通貨 →(DEX)→ X →(WOOFi)→ 見積もり通貨
// の差額 − ガス代。WOOFi 側は WooPPV2.tryQuery(手数料・スプレッド込みの約定見込み)、
// DEX 側は onchain-quote.js の bestSellQuote(チェーンに直接試算させる)。
// 平時は1分ごと、**嵐の間(storm-mode.js の判定)は10秒ごと**。黒字なら何秒続くかも2秒ごとに追う。
// 平時と嵐で「最良の差」を分けて出す(遅れが嵐の時だけ開くのかを見るため)。
//
// 止めるなら WOOFI_WATCH=false

import { ethers } from "ethers";
import { callWithRpc } from "./onchain-reserves.js";
import { gasUnitsToUsd } from "./gas-cost.js";
import { getKnownTokens } from "./borrowable-tokens.js";
import { bestSellQuote } from "./onchain-quote.js";
import { isStorm } from "./storm-mode.js";
import { getPoolsForPair, getTokenDecimals, KIND_V3 } from "./pool-registry.js";
import { nowJst } from "./jst.js";

const ENABLED = process.env.WOOFI_WATCH !== "false";
const CALM_INTERVAL_MS = parseInt(process.env.WOOFI_INTERVAL_MS || String(60 * 1000), 10);
const STORM_INTERVAL_MS = parseInt(process.env.WOOFI_STORM_INTERVAL_MS || String(10 * 1000), 10);
const SIZE_USD = parseInt(process.env.WOOFI_SIZE_USD || "1000", 10);
/// 借りる + WOOFi + DEX 1〜2段のガス量の見込み
const GAS_UNITS = 450000n;
const MAX_BASES = 5;
const TRACK_EVERY_MS = 2000;
const TRACK_MAX_MS = 5 * 60 * 1000;

const ROUTER = "0x4c4AF8DBc524681930a27b2F1Af5bcC8062E6fB7";
const POOL_DOC = "0x5520385bFcf07Ec87C4c53A7d8d65595Dff69FA4";
const HELPERS = {
  avalanche: "0x020630613E296c3E9b06186f630D1bF97A2B6Ad1",
  arbitrum: "0x28D2B949024FE50627f1EbC5f0Ca3Ca721148E40",
  polygon: "0x7Ba560eB735AbDCf9a3a5692272652A0cc81850d",
  optimism: "0x96329d66074EB8386Ae8bFD6698B2E3FDA87e15E",
  base: "0xC4E9B633685461E7B7A807D12a246C81f96F31B8",
  // woonetwork/docs の references/readme/hyperevm.md(Router・WooPPV2 は他チェーンと同じ住所)
  hyperevm: "0xEe8318E9d597Bf9DF6148E86D4e35a8Bc14EEA88",
};

const ROUTER_IFACE = new ethers.Interface(["function wooPool() view returns (address)"]);
const POOL_IFACE = new ethers.Interface([
  "function quoteToken() view returns (address)",
  "function paused() view returns (bool)",
  "function tryQuery(address fromToken, address toToken, uint256 fromAmount) view returns (uint256)",
]);
const HELPER_IFACE = new ethers.Interface(["function getSupportTokens() view returns (address, address[])"]);

async function view(chain, to, iface, fn, args = []) {
  const raw = await callWithRpc(chain, (p) => p.call({ to, data: iface.encodeFunctionData(fn, args) }), false);
  const r = iface.decodeFunctionResult(fn, raw);
  return r.length === 1 ? r[0] : r;
}
const same = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();

/// chain -> { pool, quote, qDec, bases: [{ addr, symbol }] } または null(測らない)
const setup = new Map();
/// chain -> { reads, stormReads, byRoute: { key -> { calmBest, stormBest, last, positives } }, noDex, maxNetUsd, durations, tracking }
const stats = new Map();

async function prepare(chain) {
  if (setup.has(chain)) return setup.get(chain);
  let ctx = null;
  try {
    const pool = String(await view(chain, ROUTER, ROUTER_IFACE, "wooPool"));
    if (!same(pool, POOL_DOC)) console.warn(`[WOOFi計測] ${chain}: ルーターの指すプール ${pool} が文書(${POOL_DOC})と違います。ルーターの方を使います`);
    const quote = String(await view(chain, pool, POOL_IFACE, "quoteToken"));
    const known = getKnownTokens(chain);
    const qk = known[quote.toLowerCase()];
    if (!qk?.stable) {
      console.warn(`[WOOFi計測] ${chain}: 見積もり通貨 ${quote} が手書きのステーブルに無いので測りません`);
    } else {
      const [, bases] = await view(chain, HELPERS[chain], HELPER_IFACE, "getSupportTokens");
      // 桁数の分かっている(手書きにある)トークンだけ。ステーブル同士は動かないので外す
      const list = [...bases].map(String).filter((b) => known[b.toLowerCase()] && !known[b.toLowerCase()].stable && !same(b, quote))
        .slice(0, MAX_BASES).map((addr) => ({ addr, symbol: known[addr.toLowerCase()].symbol, dec: known[addr.toLowerCase()].decimals }));
      ctx = { pool, quote, qDec: qk.decimals, qSym: qk.symbol, bases: list };
      console.log(`[WOOFi計測] ${chain}: プール ${pool} 見積もり通貨 ${qk.symbol} 対象 ${list.map((b) => b.symbol).join(",") || "なし"}`
        + `(WOOFi の扱い${bases.length}種のうち手書きにあるもの)`);
      if (list.length === 0) ctx = null;
    }
  } catch (e) {
    console.warn(`[WOOFi計測] ${chain}: 準備に失敗 ${(e.shortMessage || e.message || "").slice(0, 80)}(次の周回で聞き直します)`);
    return null; // 失敗は覚えない(一時的な RPC の不調かもしれない)
  }
  setup.set(chain, ctx);
  return ctx;
}

function routes(chain, ctx) {
  const hubs = Object.keys(getKnownTokens(chain));
  const x = BigInt(SIZE_USD) * 10n ** BigInt(ctx.qDec);
  const list = [];
  for (const b of ctx.bases) {
    list.push({ key: `${b.symbol} WOOFi→DEX`, eval: async () => {
      const got = BigInt(await view(chain, ctx.pool, POOL_IFACE, "tryQuery", [ctx.quote, b.addr, x]));
      if (got === 0n) return { out: null, x };
      const s = await bestSellQuote(chain, b.addr, ctx.quote, got, hubs);
      return { out: s ? s.out : null, x, label: s?.label || "" };
    } });
    list.push({ key: `${b.symbol} DEX→WOOFi`, eval: async () => {
      const d = await bestSellQuote(chain, ctx.quote, b.addr, x, hubs);
      if (!d) return { out: null, x };
      const out = BigInt(await view(chain, ctx.pool, POOL_IFACE, "tryQuery", [b.addr, ctx.quote, d.out]));
      return { out: out > 0n ? out : null, x, label: d.label };
    } });
  }
  return list;
}

async function track(st, chain, ctx, route, gasUsd, firstNet) {
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
        if (r.out != null) net = Number(r.out - r.x) / 10 ** ctx.qDec - gasUsd;
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
  st.durations.push(sec);
  if (st.durations.length > 500) st.durations.shift();
  console.log(`[WOOFi計測/持続 ${nowJst()}] ${chain} ${id}: 黒字のずれが${capped ? `${Math.round(sec)}秒以上(追跡の上限)` : `約${Math.round(sec)}秒`}続いた`
    + `(${reads}回測定、最大純利$${maxNet.toFixed(3)})。送っていません`);
}

async function measure(chain, ctx, storm) {
  const st = stats.get(chain) || { reads: 0, stormReads: 0, byRoute: {}, noDex: 0, maxNetUsd: null, durations: [], tracking: new Set() };
  stats.set(chain, st);
  st.reads++;
  if (storm) st.stormReads++;
  const paused = await view(chain, ctx.pool, POOL_IFACE, "paused").catch(() => false);
  st.paused = !!paused;
  if (paused) return;
  const gasUsd = (await gasUnitsToUsd(chain, GAS_UNITS).catch(() => null)) ?? 0.05;
  for (const route of routes(chain, ctx)) await evalRoute(st, chain, ctx, route, storm, gasUsd, "");
}

function statsOf(chain) {
  const st = stats.get(chain) || { reads: 0, stormReads: 0, byRoute: {}, noDex: 0, maxNetUsd: null, durations: [], tracking: new Set() };
  stats.set(chain, st);
  return st;
}

/// 1本の経路をチェーンに試算させて記録する。黒字なら持続を追う。戻り値: 純利(読めなければ null)
async function evalRoute(st, chain, ctx, route, storm, gasUsd, tag) {
  let r;
  try { r = await route.eval(); } catch (e) { r = { out: null }; }
  if (r.out == null) { st.noDex++; return null; }
  const bps = Number(((r.out - r.x) * 100000n) / r.x) / 10;
  const netUsd = Number(r.out - r.x) / 10 ** ctx.qDec - gasUsd;
  const rr = st.byRoute[route.key] || { calmBest: null, stormBest: null, last: null, positives: 0 };
  rr.last = bps;
  const k = storm ? "stormBest" : "calmBest";
  if (rr[k] == null || bps > rr[k]) rr[k] = bps;
  st.byRoute[route.key] = rr;
  if (netUsd > 0) {
    rr.positives++;
    if (st.maxNetUsd == null || netUsd > st.maxNetUsd) st.maxNetUsd = netUsd;
    console.log(`[WOOFi計測/機会 ${nowJst()}] ${chain}${storm ? "(嵐)" : ""}${tag} ${route.key} $${SIZE_USD}: 差${bps.toFixed(1)}bps 純利$${netUsd.toFixed(3)}`
      + `(DEX ${r.label} / ガス$${gasUsd.toFixed(3)})。**送っていません**`);
    track(st, chain, ctx, route, gasUsd, netUsd).catch(() => {});
  }
  return netUsd;
}

// ===== 速報: DEX が動いた瞬間に WOOFi を読み直す(2026年9月25日、オーナーの指示「最低でも1秒ごと」) =====
//
// [なぜ] 11:53 の optimism WBTC は、差が開いてから14秒で閉じた(過去ブロックの再現、#193)。
// 平時60秒ごとの読み取りでは4回に1回しか見つからない。かといって5チェーンを毎秒読むと
// 1日43万回(月1,300万回)で RPC の枠(月2,000万、今36%)を超える。
// 再現では**差は DEX が動いて WOOFi が遅れた時に開いた**。DEX の値動きは WebSocket で
// 既に受け取っている(RPC を使わない)。そこで **WOOFi の対象トークンのプールが動いた時だけ**、
// 同じチェーンで**最短1秒おき**に WOOFi の値段を2回(買い・売り)だけ読み、地図の DEX の値段と比べる。
// 差が手数料を超えていそうな時だけ、いつもの経路の試算(bestSellQuote)まで進む。
// 静かな時は RPC を使わず、動いている間は1秒以内に反応する。
const FAST_ENABLED = process.env.WOOFI_FAST !== "false";
const FAST_MIN_MS = parseInt(process.env.WOOFI_FAST_MIN_MS || "1000", 10);
/// 地図の中値で見た差がこれ(bps)を超えたら、チェーンで試算する(DEX の手数料と滑りの分の余裕)
const FAST_SCREEN_BPS = parseFloat(process.env.WOOFI_FAST_SCREEN_BPS || "5");
const fast = new Map(); // chain -> { dirty: Map(base -> receivedAt), busy, lastAt, reads, screens, hits, lagMs: [] }

function fastOf(chain) {
  let f = fast.get(chain);
  if (!f) { f = { dirty: new Map(), busy: false, lastAt: 0, reads: 0, screens: 0, hits: 0, lagMs: [] }; fast.set(chain, f); }
  return f;
}

/// index.js のプール更新(WebSocket)から呼ぶ。RPC は使わない。
export function noteDexMove(chain, pool, receivedAt = Date.now()) {
  if (!FAST_ENABLED || !pool) return;
  const ctx = setup.get(chain);
  if (!ctx) return;
  for (const b of ctx.bases) {
    const a = b.addr.toLowerCase();
    // 相手が見積もり通貨でなくても、base の値段が動いたことに変わりはない
    if (pool.token0 === a || pool.token1 === a) {
      const f = fastOf(chain);
      if (!f.dirty.has(a)) f.dirty.set(a, receivedAt);
    }
  }
}

/// 地図にある base/見積もり通貨 のプールから、中値(見積もり通貨 / base 1枚)と最小手数料を出す。
export function mapMid(chain, ctx, base) {
  const pools = getPoolsForPair(chain, base.addr, ctx.quote) || [];
  const mids = [];
  let minFee = null;
  const bDec = base.dec ?? getTokenDecimals(chain, base.addr);
  if (bDec == null) return null;
  for (const p of pools) {
    const baseIs0 = p.token0 === base.addr.toLowerCase();
    const [d0, d1] = baseIs0 ? [bDec, ctx.qDec] : [ctx.qDec, bDec];
    let p1per0 = null; // token1 / token0(人の単位)
    if (p.kind === KIND_V3) {
      if (!(p.sqrtPriceX96 > 0n)) continue;
      const r = Number(p.sqrtPriceX96) / 2 ** 96;
      p1per0 = r * r * 10 ** (d0 - d1);
    } else {
      if (!(p.raw0 > 0n && p.raw1 > 0n)) continue;
      p1per0 = (Number(p.raw1) / 10 ** d1) / (Number(p.raw0) / 10 ** d0);
    }
    if (!(p1per0 > 0) || !isFinite(p1per0)) continue;
    mids.push(baseIs0 ? p1per0 : 1 / p1per0);
    const fee = Number(p.feeBps);
    if (Number.isFinite(fee)) minFee = minFee == null ? fee : Math.min(minFee, fee);
  }
  if (mids.length === 0) return null;
  mids.sort((a, b) => a - b);
  return { mid: mids[Math.floor(mids.length / 2)], feeBps: minFee ?? 30, n: mids.length };
}

async function fastTick(chain) {
  const f = fastOf(chain);
  if (f.busy || f.dirty.size === 0 || Date.now() - f.lastAt < FAST_MIN_MS) return;
  const ctx = setup.get(chain);
  if (!ctx) { f.dirty.clear(); return; }
  f.busy = true; f.lastAt = Date.now();
  const dirty = [...f.dirty.entries()];
  f.dirty.clear();
  try {
    const x = BigInt(SIZE_USD) * 10n ** BigInt(ctx.qDec);
    const storm = isStorm(chain);
    for (const [addr, movedAt] of dirty) {
      const base = ctx.bases.find((b) => b.addr.toLowerCase() === addr);
      if (!base) continue;
      const m = mapMid(chain, ctx, base);
      if (!m) { f.noPair = (f.noPair || 0) + 1; continue; }
      const bDec = base.dec ?? getTokenDecimals(chain, base.addr);
      // WOOFi の買い値・売り値(手数料・スプレッド込み)。RPC 2回だけ
      const baseForX = BigInt(Math.max(1, Math.floor((SIZE_USD / m.mid) * 10 ** bDec)));
      const [gotBase, gotQuote] = await Promise.all([
        view(chain, ctx.pool, POOL_IFACE, "tryQuery", [ctx.quote, base.addr, x]).catch(() => 0n),
        view(chain, ctx.pool, POOL_IFACE, "tryQuery", [base.addr, ctx.quote, baseForX]).catch(() => 0n),
      ]);
      f.reads++;
      const lag = Date.now() - movedAt;
      f.lagMs.push(lag); if (f.lagMs.length > 300) f.lagMs.shift();
      // A: WOOFi で買って DEX で売る / B: DEX で買って WOOFi で売る(地図の中値で概算)
      const aBps = gotBase > 0n ? ((Number(gotBase) / 10 ** bDec) * m.mid / SIZE_USD - 1) * 1e4 - m.feeBps : -1e9;
      const bBps = gotQuote > 0n ? ((Number(gotQuote) / 10 ** ctx.qDec) / ((Number(baseForX) / 10 ** bDec) * m.mid) - 1) * 1e4 - m.feeBps : -1e9;
      if (Math.max(aBps, bBps) < FAST_SCREEN_BPS) continue;
      f.screens++;
      const gasUsd = (await gasUnitsToUsd(chain, GAS_UNITS).catch(() => null)) ?? 0.05;
      const want = aBps >= bBps ? `${base.symbol} WOOFi→DEX` : `${base.symbol} DEX→WOOFi`;
      const route = routes(chain, ctx).find((r) => r.key === want);
      if (!route) continue;
      const net = await evalRoute(statsOf(chain), chain, ctx, route, storm, gasUsd, `(速報 値動きから${lag}ms)`);
      if (net != null && net > 0) f.hits++;
    }
  } catch (e) {
  } finally {
    f.busy = false;
  }
}

export function startWoofiWatch(activeChains) {
  if (!ENABLED) return;
  const chains = activeChains.filter((c) => HELPERS[c]);
  if (chains.length === 0) return;
  console.log(`[WOOFi計測] 平時${CALM_INTERVAL_MS / 1000}秒・嵐の間${STORM_INTERVAL_MS / 1000}秒ごとに、WOOFi と DEX のずれを $${SIZE_USD} で読みます`
    + `(${chains.join(",")})。黒字なら何秒続くかも測ります。**送信はしません**`);
  for (const [i, chain] of chains.entries()) {
    let lastAt = 0;
    const tick = async () => {
      try {
        const storm = isStorm(chain);
        if (Date.now() - lastAt >= (storm ? STORM_INTERVAL_MS : CALM_INTERVAL_MS)) {
          lastAt = Date.now();
          const ctx = await prepare(chain);
          if (ctx) await measure(chain, ctx, storm);
        }
      } catch (e) {
        console.warn(`[WOOFi計測] ${chain} 失敗 ${(e.shortMessage || e.message || "").slice(0, 80)}`);
      }
      const t = setTimeout(tick, 2000);
      if (typeof t.unref === "function") t.unref();
    };
    // 起動直後の混雑を避けて、チェーンごとにずらして始める
    setTimeout(tick, 3 * 60 * 1000 + i * 7000);
    if (FAST_ENABLED) {
      const fi = setInterval(() => { fastTick(chain).catch(() => {}); }, 200);
      if (typeof fi.unref === "function") fi.unref();
    }
  }
}

/// 生存ログ用。経路ごとに「今回の差」と「平時/嵐の最良」、黒字のずれが続いた秒数
export function formatWoofiLine() {
  if (stats.size === 0) return "";
  const f = (v) => (v == null ? "-" : v.toFixed(1));
  const parts = [];
  for (const [chain, st] of stats) {
    const routesTxt = Object.entries(st.byRoute)
      .sort((x, y) => Math.max(y[1].calmBest ?? -1e9, y[1].stormBest ?? -1e9) - Math.max(x[1].calmBest ?? -1e9, x[1].stormBest ?? -1e9))
      .slice(0, 2)
      .map(([rk, r]) => `${rk} 今${f(r.last)}/平時最良${f(r.calmBest)}/嵐最良${f(r.stormBest)}bps${r.positives ? ` 黒字${r.positives}回` : ""}`).join(" ");
    const d = [...st.durations].sort((a, b) => a - b);
    const durTxt = d.length ? ` 続いた秒数[中央${Math.round(d[Math.floor(d.length / 2)])} ${d.length}件]` : "";
    // [2026年9月25日の障害] ここを `const f` と書き、上の書式関数 f を同じ区画で隠していた。
    // 経路が1本でも記録されると f(...) が「初期化前の参照」で例外になり、生存ログの組み立てごと
    // 本番が4〜5分ごとに落ちた(14:40〜15:40 JST)。名前を分ける。
    const fq = fast.get(chain);
    const lag = fq && fq.lagMs.length ? [...fq.lagMs].sort((a, b) => a - b)[Math.floor(fq.lagMs.length / 2)] : null;
    const fastTxt = fq ? ` 速報[読み${fq.reads} 候補${fq.screens} 黒字${fq.hits}${lag != null ? ` 反応中央${lag}ms` : ""}${fq.noPair ? ` 地図に組なし${fq.noPair}` : ""}]` : "";
    parts.push(`${chain} 読み${st.reads}(嵐${st.stormReads})${fastTxt}${st.paused ? " **停止中**" : ""} ${routesTxt || "経路なし"}`
      + `${st.maxNetUsd != null ? ` 最大$${st.maxNetUsd.toFixed(3)}` : ""}${durTxt}`);
  }
  return ` WOOFi[${parts.join(" / ")}]`;
}
