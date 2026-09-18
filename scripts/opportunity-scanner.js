// scripts/opportunity-scanner.js
//
// メモリ上のプール地図から、裁定機会を探す。
// RPCへの問い合わせを一切行わず、全てメモリ上の計算で完結するため、
// イベントが届いた瞬間(ミリ秒単位)に判定できる。
//
// [V3の扱い]
// 現在価格と流動性だけから受取量を近似していたが、公式Quoterより最大2,184%も
// 過大な値を返していた(2026年9月16日)。V3は価格帯ごとに流動性が分かれており、
// 近似式では表現できない。
// 代わりに、プールごとに公式Quoterで作った「価格表」から補間する。
// 表に載っていない範囲(極端に大きい投入額)は判定に使わない。
//
// [送信直前に赤字と確定した経路は、状態が変わるまで再判定しない(2026年9月16日)]
// 同じ経路が毎分「黒字」と判定され、送信直前の正確な見積もりで毎回赤字と
// 分かって見送る、という繰り返しが起きていた(Optimismの3経路で1時間に数十回)。
// 黒字判定の件数が水増しされ、本物の機会が何件あるのか分からなくなるうえ、
// 毎回Quoterとガス見積もりの問い合わせを浪費する。
// 送信直前に赤字と確定した経路は、その時の各プールの状態(V2は準備量、V3は
// 価格と流動性)を記録し、どれかが変わるまで判定から外す。
//
// [V2だけの経路は判定しない(2026年9月17日)]
// V2だけで組んだ経路の黒字は、実測で全て税トークンか$2〜10の極小だった。
// 送信直前まで進んだ機会は全てV3を含む経路だったため、V3を1段も含まない
// 経路は計算しない。V2プールはV3を含む経路の片脚としてだけ使う。
//
// [フラッシュスワップ方式]
// 経路の最初のプール自身から借りるため、借入手数料はかからない。
//
// [V2とV3の混在]
// 経路の各段はV2形式でもV3形式でも構わない。同じペアにV2とV3が共存している
// 場合が最も機会が生まれやすいため、それらを優先して組み合わせる。

import {
  getPoolsForPair, getPoolsForToken, getArbitragablePairs,
  getTokenDecimals, getTokenPriceUsd, getPool, hasUsableState,
  KIND_V2, KIND_V3,
} from "./pool-registry.js";
import { quoteFromTable, hasQuoteTable, getTableRange } from "./v3-pools.js";

const MIN_TRADE_USD = parseFloat(process.env.MIN_TRADE_USD || "0");
// 手数料が未実測のV2プールに当てる想定値。30bpsは楽観的すぎることが多い。
const UNPROBED_FEE_BPS = parseInt(process.env.UNPROBED_FEE_BPS || "45", 10);
// 赤字と確定した経路の記録数の上限(メモリ保護)。
const MAX_REJECTED_ROUTES = 5000;

// ===== 送信直前の確認結果の記録 =====

const rejectedRoutes = new Map(); // 経路 -> その時の状態の署名
const routeCheckStats = { confirmed: 0, rejected: 0, suppressed: 0 };
let lastRouteStatsLine = "";

function routeKey(chain, tokenA, poolAddresses) {
  return `${chain}:${(tokenA || "").toLowerCase()}:${poolAddresses.map((a) => a.toLowerCase()).join(">")}`;
}

/// 経路上の全プールの現在の状態をまとめた文字列。どれかが変われば別の値になる。
function routeSignature(chain, poolAddresses) {
  return poolAddresses.map((addr) => {
    const p = getPool(chain, addr);
    if (!p) return "none";
    if (p.kind === KIND_V3) return `${p.sqrtPriceX96}:${p.liquidity}`;
    return `${p.raw0}:${p.raw1}`;
  }).join("|");
}

/// 送信直前の正確な見積もりで赤字と確定した経路を記録する。
export function markRouteRejected(opp) {
  if (!opp || !opp.poolAddresses) return;
  if (rejectedRoutes.size >= MAX_REJECTED_ROUTES) {
    const oldest = rejectedRoutes.keys().next().value;
    rejectedRoutes.delete(oldest);
  }
  rejectedRoutes.set(routeKey(opp.chain, opp.tokenA, opp.poolAddresses), routeSignature(opp.chain, opp.poolAddresses));
  routeCheckStats.rejected++;
}

/// 送信直前の正確な見積もりでも黒字だった経路を数える。
export function markRouteConfirmed(opp) {
  if (!opp || !opp.poolAddresses) return;
  rejectedRoutes.delete(routeKey(opp.chain, opp.tokenA, opp.poolAddresses));
  routeCheckStats.confirmed++;
}

/// 判定の精度(黒字判定のうち、送信直前でも黒字だった割合)。
export function getRouteCheckStats() {
  const checked = routeCheckStats.confirmed + routeCheckStats.rejected;
  return {
    ...routeCheckStats,
    rejectedRoutesTracked: rejectedRoutes.size,
    precisionPercent: checked > 0 ? (routeCheckStats.confirmed / checked) * 100 : null,
  };
}

/// 赤字と確定した時から状態が変わっていない経路か。変わっていれば記録を消す。
function isSuppressed(chain, tokenA, poolAddresses) {
  const key = routeKey(chain, tokenA, poolAddresses);
  const saved = rejectedRoutes.get(key);
  if (saved == null) return false;
  if (saved === routeSignature(chain, poolAddresses)) {
    routeCheckStats.suppressed++;
    return true;
  }
  rejectedRoutes.delete(key);
  return false;
}

setInterval(() => {
  const s = getRouteCheckStats();
  const precision = s.precisionPercent == null ? "-" : `${s.precisionPercent.toFixed(0)}%`;
  const line = `[判定の精度] 送信直前でも黒字 ${s.confirmed}件 / 赤字と確定 ${s.rejected}件(精度${precision}) / 状態が変わるまで再判定しない ${s.rejectedRoutesTracked}経路(抑止${s.suppressed}回)`;
  if (line !== lastRouteStatsLine) {
    console.log(line);
    lastRouteStatsLine = line;
  }
}, 5 * 60 * 1000);

// ===== 計算 =====

function effectiveFeeBps(pool) {
  if (pool.kind === KIND_V3) return pool.feeBps;
  return pool.feeProbed ? pool.feeBps : Math.max(pool.feeBps, UNPROBED_FEE_BPS);
}

function getAmountOutV2(amountIn, reserveIn, reserveOut, feeBps) {
  if (amountIn <= 0n || reserveIn <= 0n || reserveOut <= 0n) return 0n;
  const amountInWithFee = amountIn * (10000n - BigInt(feeBps));
  const denominator = reserveIn * 10000n + amountInWithFee;
  return denominator === 0n ? 0n : (amountInWithFee * reserveOut) / denominator;
}

/// 1段の受取量。V3は公式Quoterで作った価格表から補間する。
function legAmountOut(leg, amountIn) {
  if (amountIn <= 0n) return 0n;
  if (leg.kind === KIND_V3) {
    return quoteFromTable({
      chain: leg.chain, pool: leg.pool, zeroForOne: leg.zeroForOne, amountIn,
    });
  }
  return getAmountOutV2(amountIn, leg.reserveIn, leg.reserveOut, leg.feeBps);
}

function orient(pool, tokenIn) {
  const inLower = tokenIn.toLowerCase();
  const isToken0In = pool.token0 === inLower;
  const tokenOut = isToken0In ? pool.token1 : pool.token0;
  const base = {
    kind: pool.kind,
    chain: pool.chain,
    pool: pool.address,
    dexId: pool.dexId,
    tokenIn: inLower,
    tokenOut,
    feeBps: effectiveFeeBps(pool),
    feeTier: pool.feeTier,
  };
  if (pool.kind === KIND_V3) {
    return { ...base, sqrtPriceX96: pool.sqrtPriceX96, liquidity: pool.liquidity, zeroForOne: isToken0In };
  }
  return {
    ...base,
    reserveIn: isToken0In ? pool.raw0 : pool.raw1,
    reserveOut: isToken0In ? pool.raw1 : pool.raw0,
  };
}

/// その段が判定に使える状態か。V3は価格表が必要。
function legIsUsable(leg) {
  if (leg.kind === KIND_V3) return hasQuoteTable(leg.chain, leg.pool, leg.zeroForOne);
  return leg.reserveIn > 0n && leg.reserveOut > 0n;
}

/// 現在の交換比率の概算(どちらが安いかの比較用)。
function rateOf(leg) {
  if (leg.kind === KIND_V3) {
    if (leg.sqrtPriceX96 <= 0n) return 0;
    const r = Number(leg.sqrtPriceX96) / Number(2n ** 96n);
    const price = r * r; // token1 / token0
    return leg.zeroForOne ? price : (price > 0 ? 1 / price : 0);
  }
  if (leg.reserveIn <= 0n) return 0;
  return Number(leg.reserveOut) / Number(leg.reserveIn);
}

function simulateRoute(amountIn, legs) {
  let amount = amountIn;
  for (const leg of legs) {
    amount = legAmountOut(leg, amount);
    if (amount <= 0n) return 0n;
  }
  return amount;
}

/// 経路全体で使える投入額の上限。V3の価格表の範囲を超える額は判定できない。
function routeMaxAmountIn(maxAmountIn, legs) {
  const first = legs[0];
  if (first.kind !== KIND_V3) return maxAmountIn;
  const range = getTableRange(first.chain, first.pool, first.zeroForOne);
  if (!range) return 0n;
  return maxAmountIn < range.max ? maxAmountIn : range.max;
}

/// 経路を何本計算し、そのうち何本が粗利プラスだったか。
///
/// [なぜ数えるか]
/// 生存ログの「精査」は handleOpportunity に渡った件数、つまり
/// 粗利がプラスだった件数であって、計算した経路の数ではない。
/// この区別が無いために「判定が止まっている」と2度誤診した。
/// 「計算はしているが機会が無い」のか「そもそも計算していない」のかを
/// 見分けられるようにする。
///
/// hitCap は投入額が上限(価格表の最大点)に張り付いた回数。
/// 価格表を伸ばす意味があったのかを測る。0のままなら上限は効いておらず、
/// 刻みを増やした分のRPCが無駄なので元に戻せる。
///
/// findBestAmount から参照するので、その手前で宣言しておく。
const routeCalcStats = { computed: 0, grossProfitable: 0, hitCap: 0 };
export function getRouteCalcStats() { return { ...routeCalcStats }; }

function findBestAmount(maxAmountIn, legs) {
  let best = { amountIn: 0n, amountOut: 0n, profit: 0n, returnBps: null };
  const cap = routeMaxAmountIn(maxAmountIn, legs);
  if (cap <= 0n) return best;

  // 赤字でも「一番良かった時の利回り」をbpsで残す。
  // simulateRoute を呼ぶ回数は増やさず、すでに計算した値から比率を取るだけ。
  let bestReturnBps = null;
  const note = (amountIn, profit) => {
    if (amountIn <= 0n) return;
    const bps = Number((profit * 10000n) / amountIn);
    if (bestReturnBps == null || bps > bestReturnBps) bestReturnBps = bps;
  };

  // 上限に対する比率で探すので、上限が大きいほど最小の刻みが粗くなる。
  // 以前は最小が0.01で、上限$300なら$3から探せたが、価格表を$2000まで
  // 伸ばすと最小が$20になり、実測の最適額($1.78〜$8.05)を全て飛ばしていた。
  // 検証では上限$2000のとき理想の60%の利益しか取れなかった。
  // 小さい側を対数的に細かく刻み、上限を伸ばしても取り逃さないようにする。
  const ratios = [
    0.0005, 0.001, 0.002, 0.004, 0.008, 0.015, 0.03, 0.06,
    0.12, 0.2, 0.3, 0.45, 0.6, 0.8, 1.0,
  ];
  for (const r of ratios) {
    const amountIn = (cap * BigInt(Math.round(r * 100000))) / 100000n;
    if (amountIn <= 0n) continue;
    const amountOut = simulateRoute(amountIn, legs);
    const profit = amountOut - amountIn;
    note(amountIn, profit);
    if (profit > best.profit) best = { amountIn, amountOut, profit, returnBps: null };
  }
  if (best.amountIn > 0n) {
    for (const r of [0.7, 0.85, 1.15, 1.3]) {
      const amountIn = (best.amountIn * BigInt(Math.round(r * 1000))) / 1000n;
      if (amountIn <= 0n || amountIn > cap) continue;
      const amountOut = simulateRoute(amountIn, legs);
      const profit = amountOut - amountIn;
      note(amountIn, profit);
      if (profit > best.profit) best = { amountIn, amountOut, profit, returnBps: null };
    }
  }
  // 一番良かった額が上限のすぐ下なら、上限で切られていた可能性がある。
  if (best.amountIn > 0n && best.amountIn * 100n >= cap * 95n) routeCalcStats.hitCap++;
  return { ...best, returnBps: bestReturnBps };
}

function maxAmountFromUsd(chain, token, capUsd) {
  const decimals = getTokenDecimals(chain, token);
  const priceUsd = getTokenPriceUsd(chain, token);
  if (decimals == null || !priceUsd) return null;
  const amount = capUsd / priceUsd;
  try {
    const [intPart, fracPart = ""] = amount.toFixed(Math.min(decimals, 18)).split(".");
    return BigInt(intPart + fracPart.padEnd(decimals, "0").slice(0, decimals));
  } catch (e) { return null; }
}

/// 「あと何bpsで粗利プラスだったか」の分布。
///
/// [なぜ数えるか]
/// 粗利がプラスにならない経路は finalize がその場で捨てるので、
/// 「機会が無かった」としか残らず、どれくらい惜しかったのかが分からない。
/// 手数料の壁はチェーンによって大きく違う(実測: Polygonは最小35bps、
/// Optimismは最小6bps)。壁の低いチェーンへ移すと機会が何倍になるのかを、
/// 推測ではなく実測で答えられるようにするための分布。
///
/// [2026年9月18日の修正: 回数ではなく「別々の経路の数」を数える]
/// 最初の版は評価するたびに1件数えていた。Polygonは21ペアしか無いのに
/// 43分で50万回評価するため、同じ経路が何千回も数え直され、
/// 「+66件」が66個の機会なのか1個を66回見たのかを区別できなかった。
/// Avalancheで「-20〜-10bpsに200件、隣は0件」という不自然な穴が出たのが
/// その証拠。今は経路ごとに「今までで一番良かった利回り」だけを持ち、
/// 分布はそれを数える。これで件数は「届きうる別々の経路の本数」になる。
///
/// [壁の高さで絞れるようにした理由]
/// 手数料1%のプールを2段通れば壁は200bpsで、価格がどれだけ動いても
/// 黒字にならない。こうした構造的に無理な経路がPolygonでは99.4%を占め、
/// 届きうる経路の信号を埋もれさせていた。壁の合計も一緒に持たせ、
/// 「壁がREACHABLE_WALL_BPS以下の経路だけ」に絞った分布も出せるようにする。
///
/// RPCは一切使わない。findBestAmount がすでに計算した値を数えるだけ。
const NEAR_MISS_EDGES = [0, -5, -10, -20, -30, -50, -100];
const NEAR_MISS_LABELS = [
  "0bps以上(粗利プラス)", "-5〜0bps", "-10〜-5bps", "-20〜-10bps",
  "-30〜-20bps", "-50〜-30bps", "-100〜-50bps", "-100bps未満",
];

/// 現実的に裁定が成り立つ壁の上限(bps)。既定60は 0.3%+0.3% まで。
/// 1%+1%(200bps)や1%+0.3%(130bps)はここで外れる。
const REACHABLE_WALL_BPS = parseInt(process.env.REACHABLE_WALL_BPS || "60", 10);

/// 経路ごとに「今までで一番良かった利回り」と「壁の合計」を持つ。
/// キーが増え続けないよう上限を設ける(超えたら新規は足さず、既存だけ更新)。
const ROUTE_LIMIT = parseInt(process.env.NEAR_MISS_ROUTE_LIMIT || "50000", 10);
const routeBest = new Map(); // "chain|tokenA|pool,pool,..." -> { bps, wall }
let routeLimitHit = false;

function routeKeyOf(chain, tokenA, poolAddresses) {
  // アドレスは先頭8文字だけ使う。完全一致でなくても数えるには十分で、
  // 50,000件ぶん保持してもメモリを圧迫しない長さに収めたい。
  const pools = poolAddresses.map((a) => a.slice(2, 10)).join(",");
  return `${chain}|${tokenA.slice(2, 8)}|${pools}`;
}

function recordNearMiss(chain, key, returnBps, wallBps) {
  if (returnBps == null || !Number.isFinite(returnBps)) return;
  const prev = routeBest.get(key);
  if (prev) {
    if (returnBps > prev.bps) prev.bps = returnBps;
    return;
  }
  if (routeBest.size >= ROUTE_LIMIT) {
    if (!routeLimitHit) {
      routeLimitHit = true;
      console.warn(`[惜しい] 経路の記録が上限${ROUTE_LIMIT.toLocaleString()}件に達しました。以降は新しい経路を数えません`);
    }
    return;
  }
  routeBest.set(key, { bps: returnBps, wall: wallBps, chain });
}

function bucketOf(bps) {
  const i = NEAR_MISS_EDGES.findIndex((e) => bps >= e);
  return i === -1 ? NEAR_MISS_LABELS.length - 1 : i;
}

/// チェーンごとの分布。maxWallBps を渡すと、壁がそれ以下の経路だけを数える。
export function getNearMissStats(maxWallBps = null) {
  const out = {};
  for (const r of routeBest.values()) {
    if (maxWallBps != null && r.wall > maxWallBps) continue;
    if (!out[r.chain]) {
      out[r.chain] = { labels: [...NEAR_MISS_LABELS], counts: new Array(NEAR_MISS_LABELS.length).fill(0), total: 0 };
    }
    out[r.chain].counts[bucketOf(r.bps)]++;
    out[r.chain].total++;
  }
  return out;
}

/// 壁の高さごとに、経路が何本あるかの内訳。
/// 「そもそも届きうる経路がどれだけあるのか」を見るため。
export function getWallBreakdown() {
  const edges = [20, 40, 60, 100, 200];
  const labels = ["20bps以下", "20〜40bps", "40〜60bps", "60〜100bps", "100〜200bps", "200bps超"];
  const out = {};
  for (const r of routeBest.values()) {
    if (!out[r.chain]) out[r.chain] = { labels: [...labels], counts: new Array(labels.length).fill(0), total: 0 };
    let i = edges.findIndex((e) => r.wall <= e);
    if (i === -1) i = labels.length - 1;
    out[r.chain].counts[i]++;
    out[r.chain].total++;
  }
  return out;
}

/// 手数料の壁が dropBps 下がったら、新たに粗利プラスへ変わる経路の本数。
/// 壁の分だけ受取が増えるので、-dropBps 以上に入っている経路が黒字側へ移る。
/// すでに黒字の段(先頭)は含めない。
///
/// 段をまたぐ場合(例: 29bps下がると -30〜-20 の段は一部しか該当しない)は
/// その段を数えない。つまり必ず少なめに出る。判断を誤る方向ではない。
export function countIfWallDrops(chain, dropBps, maxWallBps = null) {
  const d = getNearMissStats(maxWallBps)[chain];
  if (!d) return 0;
  let n = 0;
  for (let i = 1; i < NEAR_MISS_EDGES.length; i++) {
    if (NEAR_MISS_EDGES[i] >= -dropBps) n += d.counts[i];
  }
  return n;
}

export const NEAR_MISS_REACHABLE_WALL_BPS = REACHABLE_WALL_BPS;

function finalize({ chain, tokenA, legs, maxAmountIn, gasCostUsd, label, kind, poolAddresses }) {
  // V3を1段も含まない経路は判定しない。
  if (!legs.some((l) => l.kind === KIND_V3)) return null;

  // 送信直前に赤字と確定し、その後どのプールも動いていない経路は計算しない。
  if (isSuppressed(chain, tokenA, poolAddresses)) return null;

  routeCalcStats.computed++;
  const best = findBestAmount(maxAmountIn, legs);
  // 捨てる前に「どれくらい惜しかったか」を経路ごとに残す。
  // 同じ経路を何度評価しても1本として数える(回数ではなく本数を知りたい)。
  const wallBps = legs.reduce((sum, l) => sum + l.feeBps, 0);
  recordNearMiss(chain, routeKeyOf(chain, tokenA, poolAddresses), best.returnBps, wallBps);
  // 粗利(ガス代を引く前)がプラスでなければ、そこで終わり。
  // 裁定の機会が無い時はここで止まるのが正常。
  if (best.profit <= 0n) return null;
  routeCalcStats.grossProfitable++;

  const decimals = getTokenDecimals(chain, tokenA);
  const priceUsd = getTokenPriceUsd(chain, tokenA);
  if (decimals == null || !priceUsd) return null;

  const toNumber = (v) => Number(v) / Math.pow(10, decimals);
  const tradeAmountUsd = toNumber(best.amountIn) * priceUsd;
  if (MIN_TRADE_USD > 0 && tradeAmountUsd < MIN_TRADE_USD) return null;

  // フラッシュスワップ方式のため、借入手数料は差し引かない。
  const grossProfitUsd = toNumber(best.profit) * priceUsd;
  const netProfitUsd = grossProfitUsd - gasCostUsd;
  const hasV3 = legs.some((l) => l.kind === KIND_V3);

  return {
    kind, chain, tokenA, label, poolAddresses, legs, hasV3,
    amountIn: best.amountIn,
    amountOutEstimated: best.amountOut,
    amountOwed: best.amountIn,
    tradeAmountUsd, grossProfitUsd, netProfitUsd,
    feeWallPercent: wallBps / 100,
    profitable: netProfitUsd > 0,
  };
}

function labelOf(legs) {
  return legs.map((l) => `${l.dexId}${l.kind === KIND_V3 ? `(${(l.feeBps / 100).toFixed(2)}%)` : ""}`).join("→");
}

export function scanTwoStep({ chain, tokenA, tokenB, pools, capUsd, gasCostUsd, isBorrowable }) {
  const usable = pools.filter(hasUsableState);
  if (usable.length < 2) return null;

  const candidates = [];
  for (const [borrow, other] of [[tokenA, tokenB], [tokenB, tokenA]]) {
    if (!isBorrowable(chain, borrow)) continue;
    const maxAmountIn = maxAmountFromUsd(chain, borrow, capUsd);
    if (!maxAmountIn) continue;

    const priced = [];
    for (const p of usable) {
      const leg = orient(p, borrow);
      if (leg.tokenOut !== other.toLowerCase()) continue;
      if (!legIsUsable(leg)) continue;
      const rate = rateOf(leg);
      if (!isFinite(rate) || rate <= 0) continue;
      priced.push({ pool: p, leg, rate });
    }
    if (priced.length < 2) continue;
    priced.sort((a, b) => b.rate - a.rate);

    // 最も高く売れるプールで買い、最も安いプールで戻すのが基本の組み合わせ。
    // ただしV2だけの経路は判定しないので、両端がどちらもV2の場合は、
    // V3を片側に入れた組み合わせも試す(共存ペアの機会を落とさないため)。
    const top = priced[0], bottom = priced[priced.length - 1];
    const combos = [[top, bottom]];
    if (top.pool.kind !== KIND_V3 && bottom.pool.kind !== KIND_V3) {
      const v3s = priced.filter((x) => x.pool.kind === KIND_V3);
      if (v3s.length > 0) {
        combos.push([top, v3s[v3s.length - 1]]);
        combos.push([v3s[0], bottom]);
      }
    }

    for (const [buySide, sellSide] of combos) {
      if (buySide.pool.address.toLowerCase() === sellSide.pool.address.toLowerCase()) continue;
      const leg2 = orient(sellSide.pool, other);
      if (leg2.tokenOut !== borrow.toLowerCase()) continue;
      if (!legIsUsable(leg2)) continue;

      const legs = [buySide.leg, leg2];
      const result = finalize({
        chain, tokenA: borrow, legs, maxAmountIn, gasCostUsd, kind: "2step",
        label: labelOf(legs),
        poolAddresses: [buySide.pool.address, sellSide.pool.address],
      });
      if (result) candidates.push(result);
    }
  }
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => b.netProfitUsd - a.netProfitUsd);
  return candidates[0];
}

export function scanTrianglesForPool({ chain, pool, capUsd, gasCostUsd, isBorrowable, maxRoutes = 60 }) {
  if (!hasUsableState(pool)) return null;
  const results = [];
  let examined = 0;

  for (const [tokenA, tokenB] of [[pool.token0, pool.token1], [pool.token1, pool.token0]]) {
    if (!isBorrowable(chain, tokenA)) continue;
    const maxAmountIn = maxAmountFromUsd(chain, tokenA, capUsd);
    if (!maxAmountIn) continue;
    const leg1 = orient(pool, tokenA);
    if (leg1.tokenOut !== tokenB) continue;
    if (!legIsUsable(leg1)) continue;

    for (const pool2 of getPoolsForToken(chain, tokenB)) {
      if (examined > maxRoutes) break;
      if (pool2.address.toLowerCase() === pool.address.toLowerCase()) continue;
      if (!hasUsableState(pool2)) continue;
      const leg2 = orient(pool2, tokenB);
      const tokenC = leg2.tokenOut;
      if (tokenC === tokenA) continue;
      if (!legIsUsable(leg2)) continue;

      for (const pool3 of getPoolsForPair(chain, tokenC, tokenA)) {
        const addr3 = pool3.address.toLowerCase();
        if (addr3 === pool.address.toLowerCase() || addr3 === pool2.address.toLowerCase()) continue;
        if (!hasUsableState(pool3)) continue;
        const leg3 = orient(pool3, tokenC);
        if (leg3.tokenOut !== tokenA) continue;
        if (!legIsUsable(leg3)) continue;
        examined++;
        if (examined > maxRoutes) break;

        const legs = [leg1, leg2, leg3];
        const result = finalize({
          chain, tokenA, legs, maxAmountIn, gasCostUsd, kind: "3step",
          label: labelOf(legs),
          poolAddresses: [pool.address, pool2.address, pool3.address],
        });
        if (result) results.push(result);
      }
    }
  }
  if (results.length === 0) return null;
  results.sort((a, b) => b.netProfitUsd - a.netProfitUsd);
  return results[0];
}

export function scanForChangedPool({ chain, poolAddress, capUsd, gasCostUsd, gasCostUsd3, isBorrowable }) {
  const pool = getPool(chain, poolAddress);
  if (!pool) return null;
  const found = [];

  const twoStep = scanTwoStep({
    chain, tokenA: pool.token0, tokenB: pool.token1,
    pools: getPoolsForPair(chain, pool.token0, pool.token1),
    capUsd, gasCostUsd, isBorrowable,
  });
  if (twoStep) found.push(twoStep);

  const three = scanTrianglesForPool({
    chain, pool, capUsd,
    gasCostUsd: gasCostUsd3 ?? gasCostUsd * 1.35,
    isBorrowable,
  });
  if (three) found.push(three);

  if (found.length === 0) return null;
  found.sort((a, b) => b.netProfitUsd - a.netProfitUsd);
  return found[0];
}

export function scanAllPairs({ chain, capUsd, gasCostUsd, gasCostUsd3, isBorrowable, maxTrianglePools = 400 }) {
  const results = [];
  const entries = getArbitragablePairs(chain);

  entries.sort((a, b) => {
    const mixA = new Set(a.pools.map((p) => p.kind)).size > 1 ? 1 : 0;
    const mixB = new Set(b.pools.map((p) => p.kind)).size > 1 ? 1 : 0;
    return mixB - mixA;
  });

  for (const entry of entries) {
    const r = scanTwoStep({
      chain: entry.chain, tokenA: entry.token0, tokenB: entry.token1,
      pools: entry.pools, capUsd, gasCostUsd, isBorrowable,
    });
    if (r) results.push(r);
  }

  const triGas = gasCostUsd3 ?? gasCostUsd * 1.35;
  let count = 0;
  for (const entry of entries) {
    for (const pool of entry.pools) {
      if (count >= maxTrianglePools) break;
      count++;
      const t = scanTrianglesForPool({ chain, pool, capUsd, gasCostUsd: triGas, isBorrowable, maxRoutes: 20 });
      if (t) results.push(t);
    }
    if (count >= maxTrianglePools) break;
  }

  results.sort((a, b) => b.netProfitUsd - a.netProfitUsd);
  return results;
}
