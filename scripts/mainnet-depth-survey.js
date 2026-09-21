// scripts/mainnet-depth-survey.js
//
// Ethereum メインネットの**深さ**を1回だけ測る、読み取り専用の調査。
//
// [何を答えるための調査か]
// 2026年9月21日の実測で、今の5チェーンの取引量はこうなっていた:
//   取引量[最適$1.00=上限の0.04% 上限$2000 出どころ 取引上限46/価格表0/検証0
//          4倍で利益-2000% 上限張付0]
// 上限$2,000の枠に対して実際に入れているのは**$1.00**。$4にすると赤字。
// 上限に張り付いたことは一度も無い。つまり**取引量を縛っているのは設定ではなく
// プールの深さ**で、設定をいじっても増えないことが確定した。
//
// 残る道は「深いプールのある場所へ行く」しかない。その候補がメインネット。
// ただし**推測で移ってはいけない**。メインネットはガス代が1件$2〜5かかるので、
// 深くても採算が合うとは限らない。だから先に測る:
//
//   ① 価格が10bps歪んだ時、**いくらまで入れられるのか**(今は$1.00)
//   ② その時の粗利は、メインネットのガス代を上回るのか
//
// [測り方: 近似式を使わない]
// V3の受取量を自前の式で近似したところ、公式Quoterより最大2,184%過大だった
// (2026年9月16日)。ここでも同じ過ちを繰り返さない。**公式のQuoterV2に
// 実際の投入額を渡して受取量を聞く**。滑りは、いちばん小さい投入額($100)を
// 「ほぼ滑らない基準」として、そこからの目減りで測る。
//
// [お金は1円も動かさない]
// 送信は一切しない。eth_call のみ。既存の裁定の動作にも触れない
// (このファイルは専用のプロバイダを持ち、chain-config.js を使わない)。
//
// [秘密情報]
// RPCのURLは環境変数からのみ読む。**ログにURLを出さない。**
//
// [環境変数]
//   RUN_MAINNET_SURVEY … "ethereum" か "true" で1回だけ実行
//   ETHEREUM_RPC_URL   … メインネットのRPC(必須)

import { ethers } from "ethers";
import { nowJst } from "./jst.js";

/// Uniswap V3 の公式のファクトリーと見積もり係(メインネット)。
const UNIV3_FACTORY = "0x1F98431c8aD98523631AE4a59f267346ea31F984";
const QUOTER_V2 = "0x61fFE014bA17989E743c5F6cB21bF9697530B21e";

/// 調べるトークン。**住所は実物で確かめてから使う**(下の verifyTokens)。
const TOKENS = {
  WETH: { address: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2", decimals: 18 },
  USDC: { address: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", decimals: 6 },
  USDT: { address: "0xdAC17F958D2ee523a2206206994597C13D831ec7", decimals: 6 },
  DAI:  { address: "0x6B175474E89094C44Da98b954EedeAC495271d0F", decimals: 18 },
  WBTC: { address: "0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599", decimals: 8 },
};

/// 調べる組み合わせ。**投入側は必ずドル建てが確実なもの**にする
/// (USDC/USDT/DAI は $1 として扱えるので、投入額をUSDで正確に刻める)。
const PAIRS = [
  { tokenIn: "USDC", tokenOut: "WETH", fee: 500 },
  { tokenIn: "USDC", tokenOut: "WETH", fee: 3000 },
  { tokenIn: "USDT", tokenOut: "WETH", fee: 500 },
  { tokenIn: "DAI",  tokenOut: "WETH", fee: 3000 },
  { tokenIn: "USDC", tokenOut: "USDT", fee: 100 },
  { tokenIn: "DAI",  tokenOut: "USDC", fee: 100 },
  { tokenIn: "USDC", tokenOut: "WBTC", fee: 3000 },
];

/// 投入額(USD)。いちばん小さい額を「ほぼ滑らない基準」として使う。
const SIZES_USD = [100, 1000, 10000, 100000, 1000000];

/// 裁定1件で使うガス量の目安。今の5チェーンでの実測(2段〜3段)に合わせる。
const GAS_UNITS = parseInt(process.env.MAINNET_SURVEY_GAS_UNITS || "300000", 10);

/// 狙う歪みの幅(bps)。「これだけ歪んだ時にいくら入るか」を出す。
const TARGET_EDGE_BPS = parseFloat(process.env.MAINNET_SURVEY_EDGE_BPS || "10");

/// 同時に投げる問い合わせ数。1回きりの調査なので控えめにする。
const CONCURRENCY = 5;

const FACTORY_ABI = ["function getPool(address,address,uint24) view returns (address)"];
const QUOTER_ABI = [
  "function quoteExactInputSingle((address tokenIn,address tokenOut,uint256 amountIn,uint24 fee,uint160 sqrtPriceLimitX96)) returns (uint256 amountOut,uint160 sqrtPriceX96After,uint32 initializedTicksCrossed,uint256 gasEstimate)",
];
const ERC20_ABI = [
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
];

/// 少しずつ並べて実行する(全部同時に投げてRPCを詰まらせない)。
async function mapLimited(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const workers = new Array(Math.min(limit, items.length)).fill(0).map(async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      try { out[i] = await fn(items[i], i); } catch (e) { out[i] = null; }
    }
  });
  await Promise.all(workers);
  return out;
}

/// USD を、そのトークンの生の整数に直す(投入側は $1 のものだけを使う)。
function usdToRaw(usd, decimals) {
  const [intPart, fracPart = ""] = usd.toFixed(Math.min(decimals, 18)).split(".");
  return BigInt(intPart + fracPart.padEnd(decimals, "0").slice(0, decimals));
}

/// 住所が本当にそのトークンかを、チェーン上の symbol と decimals で確かめる。
/// **手書きの住所を信用しない。** 1文字違いで別のトークンを測っても気づけない。
async function verifyTokens(provider) {
  const names = Object.keys(TOKENS);
  const results = await mapLimited(names, CONCURRENCY, async (name) => {
    const c = new ethers.Contract(TOKENS[name].address, ERC20_ABI, provider);
    const [symbol, decimals] = await Promise.all([c.symbol(), c.decimals()]);
    return { name, symbol, decimals: Number(decimals) };
  });
  const bad = [];
  for (const r of results) {
    if (!r) { bad.push("(応答なし)"); continue; }
    const expected = TOKENS[r.name];
    // symbol は表記ゆれがあり得るので、**桁数の一致を必須**にし、symbol は参考に出す。
    if (r.decimals !== expected.decimals) {
      bad.push(`${r.name}: 桁数が${r.decimals}(${expected.decimals}のはず)`);
    } else if (!String(r.symbol || "").toUpperCase().includes(r.name.replace("W", ""))) {
      console.log(`[メインネット調査] ${r.name} の symbol は "${r.symbol}"(桁数は一致)`);
    }
  }
  return bad;
}

/// 1つのプールの深さを測る。
/// 戻り値: { label, pool, points: [{ usd, outRaw, slipBps }], sizeAtEdgeUsd }
async function surveyPool(provider, pair) {
  const tIn = TOKENS[pair.tokenIn];
  const tOut = TOKENS[pair.tokenOut];
  const label = `${pair.tokenIn}→${pair.tokenOut}(${(pair.fee / 10000).toFixed(2)}%)`;

  const factory = new ethers.Contract(UNIV3_FACTORY, FACTORY_ABI, provider);
  const pool = await factory.getPool(tIn.address, tOut.address, pair.fee);
  if (!pool || pool === ethers.ZeroAddress) return { label, pool: null };

  const quoter = new ethers.Contract(QUOTER_V2, QUOTER_ABI, provider);
  const quotes = await mapLimited(SIZES_USD, CONCURRENCY, async (usd) => {
    const amountIn = usdToRaw(usd, tIn.decimals);
    if (amountIn <= 0n) return null;
    const r = await quoter.quoteExactInputSingle.staticCall({
      tokenIn: tIn.address, tokenOut: tOut.address,
      amountIn, fee: pair.fee, sqrtPriceLimitX96: 0,
    });
    return { usd, amountIn, outRaw: BigInt(r[0]) };
  });

  const ok = quotes.filter((q) => q && q.outRaw > 0n);
  if (ok.length === 0) return { label, pool, points: [] };

  // いちばん小さい投入額を「ほぼ滑らない基準」にする。
  const base = ok[0];
  const baseRate = Number(base.outRaw) / Number(base.amountIn);
  const points = ok.map((q) => {
    const rate = Number(q.outRaw) / Number(q.amountIn);
    // 目減り(bps)。手数料は全ての点に等しく掛かるので、比で取ると消える。
    const slipBps = baseRate > 0 ? (1 - rate / baseRate) * 10000 : null;
    return { usd: q.usd, outRaw: q.outRaw, slipBps };
  });

  // **狙う歪みを取り切るのに入る額。**
  // 2段の経路なら滑りは2回かかるので、片道で TARGET_EDGE_BPS/2 に達する額を探す。
  const halfEdge = TARGET_EDGE_BPS / 2;
  let sizeAtEdgeUsd = null;
  for (let i = 0; i < points.length; i++) {
    const s = points[i].slipBps;
    if (s == null) continue;
    if (s >= halfEdge) {
      // 1つ手前との間を直線で補間する(点の間隔が10倍なので目安として扱う)。
      const prev = points[i - 1];
      if (!prev || prev.slipBps == null || s === prev.slipBps) { sizeAtEdgeUsd = points[i].usd; break; }
      const ratio = (halfEdge - prev.slipBps) / (s - prev.slipBps);
      sizeAtEdgeUsd = prev.usd + (points[i].usd - prev.usd) * ratio;
      break;
    }
    // 最後まで達しなければ「測った範囲では足りない」= 最大額以上入る。
    if (i === points.length - 1) sizeAtEdgeUsd = points[i].usd;
  }
  // 基準の点(=いちばん小さい額)の受取量も返す。価格の算出に使う。
  return { label, pool, points, sizeAtEdgeUsd, baseUsd: base.usd, baseOutRaw: base.outRaw, tokenOut: pair.tokenOut };
}

/// メインネットの深さを1回だけ測って、ログに出す。**送信は一切しない。**
export async function runMainnetDepthSurvey() {
  const url = (process.env.ETHEREUM_RPC_URL || "").trim();
  if (!url) {
    console.warn("[メインネット調査] ETHEREUM_RPC_URL が未設定のため行いません");
    return false;
  }
  // **URLはログに出さない。** 出るのは「つながったかどうか」だけ。
  const provider = new ethers.JsonRpcProvider(url, 1, { staticNetwork: true });

  let blockNumber = null;
  try {
    blockNumber = await provider.getBlockNumber();
  } catch (e) {
    console.error(`[メインネット調査] RPCにつながりません: ${(e.message || "").slice(0, 120)}`);
    return false;
  }
  console.log(`[メインネット調査 ${nowJst()}] 開始。ブロック${blockNumber}(読み取りのみ・送信しません)`);

  const bad = await verifyTokens(provider);
  if (bad.length > 0) {
    console.error(`[メインネット調査] トークンの住所が確かめられませんでした: ${bad.join(" / ")}。中止します`);
    return false;
  }

  const results = [];
  for (const pair of PAIRS) {
    try {
      const r = await surveyPool(provider, pair);
      if (!r.pool) { console.log(`[メインネット調査] ${r.label}: プールがありません`); continue; }
      if (!r.points || r.points.length === 0) { console.log(`[メインネット調査] ${r.label}: 見積もれませんでした`); continue; }
      results.push(r);
      const curve = r.points.map((p) => `$${p.usd.toLocaleString()}:${p.slipBps == null ? "-" : `${p.slipBps.toFixed(1)}bps`}`).join(" ");
      console.log(`[メインネット調査] ${r.label} ${r.pool.slice(0, 10)}… 目減り[${curve}] → ${TARGET_EDGE_BPS}bpsの歪みで入る額 $${Math.round(r.sizeAtEdgeUsd ?? 0).toLocaleString()}`);
    } catch (e) {
      console.warn(`[メインネット調査] ${pair.tokenIn}→${pair.tokenOut}(${pair.fee}) で失敗: ${(e.message || "").slice(0, 100)}`);
    }
  }

  if (results.length === 0) {
    console.error("[メインネット調査] 1件も測れませんでした");
    return false;
  }

  // ガス代。ETHの価格は USDC→WETH の基準点から逆算する(外部の価格APIを使わない)。
  let ethPriceUsd = null;
  const ethPool = results.find((r) => r.tokenOut === "WETH");
  if (ethPool && ethPool.baseOutRaw > 0n) {
    const ethOut = Number(ethPool.baseOutRaw) / 1e18;
    if (ethOut > 0) ethPriceUsd = ethPool.baseUsd / ethOut;
  }
  let gasUsd = null;
  try {
    const fee = await provider.getFeeData();
    const priceWei = fee.gasPrice ?? ((fee.maxFeePerGas ?? 0n) + (fee.maxPriorityFeePerGas ?? 0n)) / 2n;
    if (priceWei > 0n && ethPriceUsd) {
      gasUsd = parseFloat(ethers.formatEther(priceWei * BigInt(GAS_UNITS))) * ethPriceUsd;
      console.log(`[メインネット調査] ガス代: 単価${(Number(priceWei) / 1e9).toFixed(2)}gwei × ${GAS_UNITS.toLocaleString()} = $${gasUsd.toFixed(2)}(ETH $${ethPriceUsd.toFixed(0)})`);
    }
  } catch (e) {}

  // **結論。** 今の$1.00と直接比べられる形で出す。
  const best = results.reduce((a, b) => ((b.sizeAtEdgeUsd ?? 0) > (a.sizeAtEdgeUsd ?? 0) ? b : a));
  const size = best.sizeAtEdgeUsd ?? 0;
  const gross = size * (TARGET_EDGE_BPS / 10000);
  const net = gasUsd != null ? gross - gasUsd : null;
  console.log(
    `[メインネット調査 まとめ] 最良 ${best.label}: ${TARGET_EDGE_BPS}bpsの歪みで $${Math.round(size).toLocaleString()} 入る`
    + `(今の5チェーンは$1.00)。粗利$${gross.toFixed(2)}`
    + (net != null ? ` − ガス$${gasUsd.toFixed(2)} = 純利$${net.toFixed(2)}` : "(ガス代は算出できず)")
  );
  return true;
}
