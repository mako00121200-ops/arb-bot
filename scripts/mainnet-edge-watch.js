// scripts/mainnet-edge-watch.js
//
// Ethereum メインネットで、**歪みが実際に何回起きるか**を数えるだけの見張り。
// 送信は一切しない。判定もしない。**数えるだけ。**
//
// [なぜこれが要るか(2026年9月22日)]
// 深さの調査(mainnet-depth-survey.js)で、器の大きさは分かった:
//   USDC→WETH(0.30%) 10bpsの歪みで最適$40,748 粗利$20.37 − ガス$0.90 = 純利$19.48
//   採算の分かれ目: 2.10bps
// 今の5チェーンで実際に送っている額は$9.20なので、器は4,400倍になる。
//
// **しかし器の大きさは「水が来るか」を何も答えていない。**
// 2.10bps を超える歪みが1時間に0回なら、器がいくら大きくても収入は0。
// ここを推測で埋めてはいけない。**数える。**
//
// [手数料の壁を必ず引く]
// 「価格差10bps」はそのままでは機会ではない。0.05%のプールと0.30%のプールを
// 通れば壁は35bpsで、10bpsの価格差では赤字になる。今の5チェーンで
// 「幻の黒字」を大量に作ったのがまさにこれ。**壁を引いた後の値**を数える。
//
// [費用]
// RPCは受信1件も枠を消費する。対象は「同じペアに2つ以上プールがある」ものだけに
// 絞り、購読は1回にまとめる。受信数もログに出して、増えすぎたら止められるようにする。
//
// [環境変数]
//   RUN_MAINNET_WATCH … "true" で開始
//   ETHEREUM_WSS_URL  … メインネットのWebSocket(必須)
//   ETHEREUM_RPC_URL  … 初期値の読み取りに使う(必須)

import { ethers } from "ethers";
import { nowJst } from "./jst.js";

const UNIV3_FACTORY = "0x1F98431c8aD98523631AE4a59f267346ea31F984";

const T = {
  WETH: { address: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2", decimals: 18 },
  USDC: { address: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", decimals: 6 },
  USDT: { address: "0xdAC17F958D2ee523a2206206994597C13D831ec7", decimals: 6 },
  DAI:  { address: "0x6B175474E89094C44Da98b954EedeAC495271d0F", decimals: 18 },
  WBTC: { address: "0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599", decimals: 8 },
};

/// 見張るペアと、探す手数料帯。**同じペアに2つ以上プールがある時だけ**裁定が成り立つ。
const PAIRS = [
  { a: "USDC", b: "WETH", fees: [100, 500, 3000, 10000] },
  { a: "USDT", b: "WETH", fees: [100, 500, 3000, 10000] },
  { a: "USDC", b: "USDT", fees: [100, 500, 3000] },
  { a: "DAI",  b: "USDC", fees: [100, 500, 3000] },
  { a: "WBTC", b: "WETH", fees: [100, 500, 3000] },
  { a: "DAI",  b: "WETH", fees: [500, 3000] },
];

/// 壁を引いた後の歪みを数える段(bps)。採算の分かれ目(約2.1bps)を挟む値にする。
const EDGE_EDGES = [0, 1, 2, 5, 10, 20];

/// 受信の上限。**枠を守るための非常停止。** これを超えたら購読を止める。
const MAX_EVENTS = parseInt(process.env.MAINNET_WATCH_MAX_EVENTS || "300000", 10);

/// **薄いプールを外す基準。** 同じペアでいちばん深いプールの流動性に対し、
/// これで割った値より浅いプールは見張らない。
///
/// [なぜ要るか(2026年9月22日 00:30 JST の初回実測で判明)]
/// 最初の版は流動性を全く見ておらず、`USDT/WETH 0.01%→0.05%` で
/// **30.42bps** という値を出した。メインネットでこれが放置される訳がなく、
/// 正体は**ほとんど流動性の無い手数料帯**だった。薄いプールの値段は
/// 誰も直しに行かない(直しても$0.1にもならない)ので、いつまでもずれている。
/// **これを「機会」と数えると、取れない機会で期待収入を水増しする。**
/// 購読から外せば受信量も減り、RPCの枠も助かる。
const LIQ_RATIO = parseFloat(process.env.MAINNET_WATCH_LIQ_RATIO || "100");

const V3_SWAP_TOPIC = ethers.id("Swap(address,address,int256,int256,uint160,uint128,int24)");
const FACTORY_ABI = ["function getPool(address,address,uint24) view returns (address)"];
const POOL_ABI = [
  "function slot0() view returns (uint160 sqrtPriceX96,int24,uint16,uint16,uint16,uint8,bool)",
  "function liquidity() view returns (uint128)",
];

/// プールの住所(小文字) -> { pairKey, feeBps, label, price }
const pools = new Map();
/// ペア名 -> そのペアのプール住所の配列
const byPair = new Map();

/// [回数ではなく「何回起きたか」を数える(2026年9月22日に直した)]
/// 最初の版は Swap が届くたびに数えていた。歪みが1時間続けば、その間に届いた
/// 何百件の Swap の**すべてで1件ずつ数えて**いたことになる。
/// これは opportunity-scanner.js が2026年9月18日に同じ形で直した間違い
/// (「回数ではなく別々の経路の本数を数える」)と全く同じで、**既知の失敗の再現**だった。
///
/// 正しくは「下から上へ跨いだ瞬間」を1回と数える(episodes)。
/// 併せて「その段より上にいた時間」も足す(msAbove)。どちらも
/// 期待収入の計算に直接使える:
///   1時間の期待利益 ≒ 跨いだ回数 × その歪みでの粗利 × 勝率
const stats = {
  started: false, events: 0, stoppedForCap: false,
  episodes: new Array(EDGE_EDGES.length).fill(0),
  msAbove: new Array(EDGE_EDGES.length).fill(0),
  bestBps: null, bestLabel: null,
  startedAt: null, watched: 0, dropped: 0,
};

/// ペアごとの「今どの段より上にいるか」。跨いだ瞬間だけを数えるために要る。
const pairState = new Map();

function feeToBps(fee) { return fee / 100; }

/// Swap の data から更新後の価格(sqrtPriceX96)を取り出す。
/// 中身の並びは dex-onchain-realtime.js の decodeV3SwapData と同じ。
function sqrtFromSwapData(dataHex) {
  const data = dataHex.startsWith("0x") ? dataHex.slice(2) : dataHex;
  if (data.length < 320) return null;
  try {
    const v = BigInt("0x" + data.slice(128, 192));
    return v > 0n ? v : null;
  } catch (e) { return null; }
}

/// sqrtPriceX96 を「token0 1つあたりの token1」に直す(桁を揃えた実数)。
function priceFromSqrt(sqrtPriceX96, dec0, dec1) {
  const r = Number(sqrtPriceX96) / 2 ** 96;
  if (!Number.isFinite(r) || r <= 0) return null;
  const p = r * r; // 生の整数どうしの比
  const adj = p * Math.pow(10, dec0 - dec1);
  return Number.isFinite(adj) && adj > 0 ? adj : null;
}

/// そのペアの中で、**壁を引いた後にいちばん大きい歪み**(bps)を求める。
/// 片方で買って片方で売る、その往復の手数料を必ず引く。
function bestNetEdgeBps(pairKey) {
  const list = (byPair.get(pairKey) || []).map((a) => pools.get(a)).filter((p) => p && p.price > 0);
  if (list.length < 2) return null;
  let best = null;
  for (const buy of list) {
    for (const sell of list) {
      if (buy === sell) continue;
      // buy で token0 を安く買い、sell で高く売る。価格は token1/token0。
      const rawBps = (sell.price / buy.price - 1) * 10000;
      if (!Number.isFinite(rawBps) || rawBps <= 0) continue;
      const netBps = rawBps - buy.feeBps - sell.feeBps;
      if (best == null || netBps > best.netBps) {
        best = { netBps, buy, sell, label: `${pairKey} ${buy.feeBps / 100}%→${sell.feeBps / 100}%` };
      }
    }
  }
  return best;
}

// ===== 確認: 本当に取れるのかを Quoter に実際に聞く(2026年9月22日に追加) =====
//
// [なぜ要るか(01:22 JST の実測で分かった)]
// 数え方と薄いプールを直した後でも、最大が
//   `USDC/WETH 0.05%→0.01%` で **117.20bps**
// と出た。メインネットで最も見られているペアで117bpsが放置される訳がない。
//
// 正体は「価格が動いたのに、その手数料帯では誰も取引していないので値が古いまま」。
// **チェーン上の値としては本物**だが、その値段で買える量がほとんど無い
// (V3は価格帯ごとに流動性が分かれており、離れた価格帯には板が無い)。
// 起動時に読んだ `liquidity()` は**今いる価格帯の板**なので、
// 価格が離れた後の実際の厚みを表していない。
//
// **だから bps では判断しない。Quoterに「$X入れたら$いくら返るか」を聞く。**
// これは9月16日に学んだ教訓(近似式ではなく公式Quoterで測る)と同じ。
// 返ってくるのは「実際に取れたはずの金額(USD)」で、これが欲しかった数字。
const QUOTER_V2 = "0x61fFE014bA17989E743c5F6cB21bF9697530B21e";
const QUOTER_ABI = [
  "function quoteExactInputSingle((address tokenIn,address tokenOut,uint256 amountIn,uint24 fee,uint160 sqrtPriceLimitX96)) returns (uint256 amountOut,uint160 sqrtPriceX96After,uint32 initializedTicksCrossed,uint256 gasEstimate)",
];
/// 確認で試す投入額(USD)。深さの調査で最適が$37,000〜$40,000だったので、その前後。
const VERIFY_SIZES_USD = [5000, 50000];
/// 確認の間隔。**RPCの枠を守る。** 1回につき4回問い合わせる。
const VERIFY_INTERVAL_MS = parseInt(process.env.MAINNET_VERIFY_INTERVAL_MS || "60000", 10);
/// 確認を始める歪み(bps)。採算の分かれ目(約2.1bps)より少し上。
const VERIFY_MIN_BPS = parseFloat(process.env.MAINNET_VERIFY_MIN_BPS || "3");
/// メインネットのガス代の目安(USD)。深さの調査の実測値。
const VERIFY_GAS_USD = parseFloat(process.env.MAINNET_VERIFY_GAS_USD || "0.90");

let verifyProvider = null;
let lastVerifyAt = 0;
const verify = { tried: 0, profitable: 0, bestUsd: 0, bestLabel: null, totalUsd: 0, errors: 0 };

/// トークンのUSD価格。安定通貨は$1、それ以外は見張っているプールの価格から出す。
function usdPriceOf(sym) {
  if (sym === "USDC" || sym === "USDT" || sym === "DAI") return 1;
  if (sym === "WETH") {
    // USDC/WETH のいちばん深いプールの価格(WETH per USDC)から逆算する。
    for (const p of pools.values()) {
      if (p.pairKey !== "USDC/WETH" || !(p.price > 0)) continue;
      // price は token1/token0。USDC が token0 なので price = WETH per USDC。
      return p.sym0 === "USDC" ? 1 / p.price : p.price;
    }
    return null;
  }
  if (sym === "WBTC") {
    const eth = usdPriceOf("WETH");
    if (!eth) return null;
    for (const p of pools.values()) {
      if (p.pairKey !== "WBTC/WETH" || !(p.price > 0)) continue;
      // WBTC 1つあたりの WETH を求めて、ETHの価格を掛ける。
      const wethPerWbtc = p.sym0 === "WBTC" ? p.price : 1 / p.price;
      return wethPerWbtc * eth;
    }
    return null;
  }
  return null;
}

function toRaw(usd, priceUsd, decimals) {
  const amount = usd / priceUsd;
  const [i, f = ""] = amount.toFixed(Math.min(decimals, 18)).split(".");
  try { return BigInt(i + f.padEnd(decimals, "0").slice(0, decimals)); } catch (e) { return 0n; }
}

/// **本当に取れるのかを実際に聞く。** buy で token0 を買い、sell で売り戻す。
/// 戻り値は「実際に残ったはずの純利益(USD)」。取れなければ負の数。
async function verifyEpisode(buy, sell, label) {
  if (!verifyProvider) return;
  const now = Date.now();
  if (now - lastVerifyAt < VERIFY_INTERVAL_MS) return;
  lastVerifyAt = now;

  // 始点は token1(これを出して token0 を買い、売り戻して token1 を増やす)。
  const priceUsd = usdPriceOf(buy.sym1);
  if (!priceUsd) return;
  const quoter = new ethers.Contract(QUOTER_V2, QUOTER_ABI, verifyProvider);
  let best = null;
  for (const usd of VERIFY_SIZES_USD) {
    const amountIn = toRaw(usd, priceUsd, buy.dec1);
    if (amountIn <= 0n) continue;
    try {
      const leg1 = await quoter.quoteExactInputSingle.staticCall({
        tokenIn: buy.token1, tokenOut: buy.token0, amountIn, fee: buy.feeTier, sqrtPriceLimitX96: 0,
      });
      const mid = BigInt(leg1[0]);
      if (mid <= 0n) continue;
      const leg2 = await quoter.quoteExactInputSingle.staticCall({
        tokenIn: sell.token0, tokenOut: sell.token1, amountIn: mid, fee: sell.feeTier, sqrtPriceLimitX96: 0,
      });
      const back = BigInt(leg2[0]);
      if (back <= 0n) continue;
      const profitTokens = Number(back - amountIn) / Math.pow(10, buy.dec1);
      const netUsd = profitTokens * priceUsd - VERIFY_GAS_USD;
      if (best == null || netUsd > best.netUsd) best = { usd, netUsd };
    } catch (e) {
      verify.errors++;
    }
  }
  if (best == null) return;
  verify.tried++;
  if (best.netUsd > 0) {
    verify.profitable++;
    verify.totalUsd += best.netUsd;
    if (best.netUsd > verify.bestUsd) { verify.bestUsd = best.netUsd; verify.bestLabel = label; }
    console.log(`[メインネット確認 ${nowJst()}] ${label}: 投入$${best.usd.toLocaleString()} で 純利$${best.netUsd.toFixed(2)}(ガス$${VERIFY_GAS_USD}を引いた後)`);
  } else {
    console.log(`[メインネット確認 ${nowJst()}] ${label}: 実際に聞くと赤字($${best.netUsd.toFixed(2)})。価格差は見えても取れない`);
  }
}

/// **跨いだ瞬間だけを数える。** 同じ歪みが続いている間は数え直さない。
function note(pairKey, netBps, label) {
  const now = Date.now();
  let st = pairState.get(pairKey);
  if (!st) {
    st = { above: new Array(EDGE_EDGES.length).fill(false), since: new Array(EDGE_EDGES.length).fill(0) };
    pairState.set(pairKey, st);
  }
  for (let i = 0; i < EDGE_EDGES.length; i++) {
    const isAbove = netBps > EDGE_EDGES[i];
    if (isAbove && !st.above[i]) {
      st.above[i] = true; st.since[i] = now; stats.episodes[i]++;
    } else if (!isAbove && st.above[i]) {
      st.above[i] = false; stats.msAbove[i] += now - st.since[i];
    }
  }
  if (netBps > 0 && (stats.bestBps == null || netBps > stats.bestBps)) {
    stats.bestBps = netBps;
    stats.bestLabel = label;
  }
}

/// 見張るプールを実物で探す。**同じペアに2つ以上見つかった時だけ**対象にする。
async function discoverPools(provider) {
  const factory = new ethers.Contract(UNIV3_FACTORY, FACTORY_ABI, provider);
  for (const pair of PAIRS) {
    const ta = T[pair.a], tb = T[pair.b];
    const found = [];
    for (const fee of pair.fees) {
      let address = null;
      try { address = await factory.getPool(ta.address, tb.address, fee); } catch (e) {}
      if (!address || address === ethers.ZeroAddress) continue;
      // token0 は住所の小さい方(Uniswap V3 の決まり)。桁の補正に要る。
      const aIsToken0 = ta.address.toLowerCase() < tb.address.toLowerCase();
      found.push({
        address: address.toLowerCase(), feeBps: feeToBps(fee), feeTier: fee,
        dec0: aIsToken0 ? ta.decimals : tb.decimals,
        dec1: aIsToken0 ? tb.decimals : ta.decimals,
        // 確認(Quoterに実際に聞く)に要る。
        token0: aIsToken0 ? ta.address : tb.address,
        token1: aIsToken0 ? tb.address : ta.address,
        sym0: aIsToken0 ? pair.a : pair.b,
        sym1: aIsToken0 ? pair.b : pair.a,
      });
    }
    if (found.length < 2) continue; // 1つしか無いペアは裁定にならない
    const pairKey = `${pair.a}/${pair.b}`;
    byPair.set(pairKey, found.map((f) => f.address));
    for (const f of found) pools.set(f.address, { ...f, pairKey, price: 0, liquidity: 0n });
  }
}

/// 起動時の価格と流動性を1回だけ読む。
/// 価格が無いと最初のSwapまで比べられず、流動性が無いと**薄いプールを外せない**。
async function loadInitialState(provider) {
  for (const [address, p] of pools) {
    try {
      const c = new ethers.Contract(address, POOL_ABI, provider);
      const [slot0, liquidity] = await Promise.all([c.slot0(), c.liquidity()]);
      const price = priceFromSqrt(BigInt(slot0[0]), p.dec0, p.dec1);
      if (price) p.price = price;
      p.liquidity = BigInt(liquidity);
    } catch (e) {}
  }
}

/// **薄いプールを見張りから外す。**
/// 同じペアの中でいちばん深いプールと比べて LIQ_RATIO 分の1に満たないものは、
/// 値段がずれていても誰も直しに行かない(直しても採算が合わない)。
/// 数えれば取れない機会で期待収入を水増しし、購読すればRPCの枠も食う。
/// 流動性は同じペアであれば手数料帯が違っても比べられる。
function dropThinPools() {
  let dropped = 0;
  for (const [pairKey, addresses] of [...byPair.entries()]) {
    const list = addresses.map((a) => pools.get(a)).filter(Boolean);
    let maxLiq = 0n;
    for (const p of list) if ((p.liquidity ?? 0n) > maxLiq) maxLiq = p.liquidity;
    if (maxLiq <= 0n) continue;
    const floor = maxLiq / BigInt(Math.max(1, Math.round(LIQ_RATIO)));
    const keep = [];
    for (const p of list) {
      if ((p.liquidity ?? 0n) >= floor && p.price > 0) { keep.push(p.address); continue; }
      const share = maxLiq > 0n ? Number((p.liquidity ?? 0n) * 10000n / maxLiq) / 100 : 0;
      console.log(`[メインネット頻度] ${pairKey} の ${p.feeBps / 100}% を外します(深さが最深の${share.toFixed(2)}%しかない)`);
      pools.delete(p.address);
      dropped++;
    }
    // 残りが1本以下になったペアは裁定にならないので、まるごと外す。
    if (keep.length < 2) {
      for (const a of keep) pools.delete(a);
      byPair.delete(pairKey);
      console.log(`[メインネット頻度] ${pairKey} は深いプールが2本未満なので見張りません`);
    } else {
      byPair.set(pairKey, keep);
    }
  }
  return dropped;
}

/// メインネットの歪みの頻度を見張り始める。**送信は一切しない。**
export async function startMainnetEdgeWatch() {
  const httpUrl = (process.env.ETHEREUM_RPC_URL || "").trim();
  const wsUrl = (process.env.ETHEREUM_WSS_URL || "").trim();
  if (!httpUrl || !wsUrl) {
    console.warn("[メインネット頻度] ETHEREUM_RPC_URL と ETHEREUM_WSS_URL の両方が要ります");
    return false;
  }
  // **URLはログに出さない。**
  const provider = new ethers.JsonRpcProvider(httpUrl, 1, { staticNetwork: true });
  try {
    await discoverPools(provider);
  } catch (e) {
    console.error(`[メインネット頻度] プールを探せませんでした: ${(e.message || "").slice(0, 120)}`);
    return false;
  }
  if (pools.size === 0) {
    console.warn("[メインネット頻度] 2つ以上プールのあるペアが見つかりませんでした");
    return false;
  }
  verifyProvider = provider;
  await loadInitialState(provider);
  stats.dropped = dropThinPools();
  if (pools.size === 0) {
    console.warn("[メインネット頻度] 深いプールが2本そろうペアがありませんでした");
    return false;
  }

  const addresses = [...pools.keys()];
  const pairLines = [...byPair.entries()].map(([k, v]) => `${k}:${v.length}本`).join(" ");
  console.log(`[メインネット頻度 ${nowJst()}] ${pools.size}プール(${pairLines})を見張ります。数えるだけで送信しません`);

  const ws = new ethers.WebSocketProvider(wsUrl, 1, { staticNetwork: true });
  ws.on({ address: addresses, topics: [V3_SWAP_TOPIC] }, (log) => {
    if (stats.stoppedForCap) return;
    stats.events++;
    if (stats.events > MAX_EVENTS) {
      stats.stoppedForCap = true;
      console.warn(`[メインネット頻度] 受信が上限${MAX_EVENTS.toLocaleString()}件に達したので数えるのを止めます`);
      try { ws.removeAllListeners(); } catch (e) {}
      return;
    }
    const p = pools.get((log.address || "").toLowerCase());
    if (!p) return;
    const sqrtPriceX96 = sqrtFromSwapData(log.data);
    if (!sqrtPriceX96) return;
    const price = priceFromSqrt(sqrtPriceX96, p.dec0, p.dec1);
    if (!price) return;
    p.price = price;
    const best = bestNetEdgeBps(p.pairKey);
    if (!best) return;
    note(p.pairKey, best.netBps, best.label);
    // **bpsでは判断しない。** 見えている歪みが本当に取れるのかを実際に聞く。
    if (best.netBps >= VERIFY_MIN_BPS) {
      verifyEpisode(best.buy, best.sell, best.label).catch(() => { verify.errors++; });
    }
  });
  ws.websocket?.addEventListener?.("error", () => {});

  stats.started = true;
  stats.watched = pools.size;
  stats.startedAt = Date.now();
  return true;
}

/// いま開いたままの区間も足した「その段より上にいた時間」。
function msAboveNow() {
  const now = Date.now();
  const out = [...stats.msAbove];
  for (const st of pairState.values()) {
    for (let i = 0; i < EDGE_EDGES.length; i++) {
      if (st.above[i] && st.since[i] > 0) out[i] += now - st.since[i];
    }
  }
  return out;
}

/// 生存ログ用。**1時間あたりの「起きた回数」**と、その段より上にいた時間の割合。
/// 回数はそのまま期待収入の計算に使える:
///   1時間の期待利益 ≒ 回数 × その歪みでの粗利 × 勝率
export function formatMainnetEdgeLine() {
  if (!stats.started) return "";
  const elapsedMs = stats.startedAt ? Date.now() - stats.startedAt : 0;
  const hours = elapsedMs / 3600000;
  const perHour = (n) => (hours > 0.01 ? Math.round(n / hours) : 0);
  const ms = msAboveNow();
  const parts = EDGE_EDGES.map((e, i) => {
    const pct = elapsedMs > 0 ? (ms[i] / elapsedMs) * 100 : 0;
    return `${e}bps超:${perHour(stats.episodes[i])}回(${pct.toFixed(0)}%)`;
  }).join(" ");
  const best = stats.bestBps == null ? "-" : `${stats.bestBps.toFixed(2)}bps(${stats.bestLabel})`;
  // **これが唯一の本物の数字。** bpsは見えても取れるとは限らない。
  const v = verify.tried > 0
    ? ` 確認${verify.tried}件中${verify.profitable}件が黒字 合計$${verify.totalUsd.toFixed(2)}${verify.bestUsd > 0 ? ` 最良$${verify.bestUsd.toFixed(2)}(${verify.bestLabel})` : ""}`
    : " 確認まだ0件";
  return ` メインネット歪み[毎時 ${parts} 最大${best} 見張り${stats.watched}本(薄い${stats.dropped}本除外) 受信${stats.events.toLocaleString()}${stats.stoppedForCap ? " 上限で停止" : ""}${v}]`;
}

/// 画面・診断用。
export function getMainnetEdgeStats() {
  return { ...stats, edges: [...EDGE_EDGES], episodes: [...stats.episodes], msAbove: msAboveNow() };
}
