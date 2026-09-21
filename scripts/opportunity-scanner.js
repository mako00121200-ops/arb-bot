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
  getTokenDecimals, getTokenPriceUsd, getPool, hasUsableState, clearFeeProbed,
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

/// 同じプールで何度も赤字と確定したら、手数料の実測をやり直させる。
///
/// [2026年9月19日の実測がもとになっている]
/// dystopia を含む経路が12回続けて「チェーン上では赤字」になった。
/// 誤差は投入額によらず −11.6〜−20.6bps でほぼ一定。**幅が一定なのは
/// 深さの計算ではなく手数料の値が違うから**で、壁0.35%(V3 5bps +
/// V2 30bps)という前提が実際より約16bps低かったことになる。
///
/// しかも `feeProbed` はプール地図に保存されるため、**一度「実測済み」に
/// なると二度とやり直されない**。生存ログの「手数料0(残0)」がその状態。
/// ここで印を外すと、判定は安全側の45bpsに戻り、実測待ち行列にも入る。
const rejectionsByPool = new Map();
const REPROBE_AFTER_REJECTIONS = parseInt(process.env.REPROBE_AFTER_REJECTIONS || "2", 10);

function noteRejectionForFeeCheck(opp) {
  for (const leg of opp.legs || []) {
    if (leg.kind === KIND_V3) continue;
    const key = `${opp.chain}::${(leg.pool || "").toLowerCase()}`;
    const n = (rejectionsByPool.get(key) || 0) + 1;
    rejectionsByPool.set(key, n);
    if (n < REPROBE_AFTER_REJECTIONS) continue;
    if (clearFeeProbed(opp.chain, leg.pool)) {
      rejectionsByPool.set(key, 0);
      console.log(`[手数料の見直し] ${opp.chain} ${leg.dexId}:${leg.pool.slice(0, 10)}… が${n}回続けてチェーン上で赤字。手数料${leg.feeBps}bpsの前提を外し、実測し直します`);
    }
  }
}

/// **待たずに**手数料の前提を外す。K検算での拒否のように、
/// 「こちらの計算が物理的に不可能」と分かった時に使う。
export function forceFeeReprobe(opp, why) {
  let cleared = 0;
  for (const leg of opp.legs || []) {
    if (leg.kind === KIND_V3) continue;
    if (clearFeeProbed(opp.chain, leg.pool)) {
      cleared++;
      rejectionsByPool.set(`${opp.chain}::${(leg.pool || "").toLowerCase()}`, 0);
      console.log(`[手数料の見直し] ${opp.chain} ${leg.dexId}:${(leg.pool || "").slice(0, 10)}…: ${why}。手数料${leg.feeBps}bpsの前提を外し、実測し直します`);
    }
  }
  return cleared;
}

/// 送信直前の正確な見積もりで赤字と確定した経路を記録する。
export function markRouteRejected(opp) {
  if (!opp || !opp.poolAddresses) return;
  noteRejectionForFeeCheck(opp);
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

/// 判定に使った準備量ではなく、**今のプール地図**で同じ経路を計算し直す。
///
/// [なぜ要るか(2026年9月20日に本番ログで判明)]
/// 段ごとの答え合わせで avalanche の3段目 pangolin が −190.0bps と出たが、
/// 内訳は「判定後に地図が −190.0bps / 地図とチェーンの差 0.0bps」だった。
/// **地図は正確で、遅れていたのは経路の方**。経路を作った時に写し取った
/// 準備量のまま、確認と送信まで持ち回っていたことになる。
///
/// 地図は Syncイベントで更新され続けているので、この計算にRPCは一切要らない。
/// まずは「どれくらい動いているか」を測るために使う。
export function revalueRouteFromMap(opp) {
  if (!opp || !Array.isArray(opp.legs) || opp.legs.length === 0) return null;
  if (!(opp.amountIn > 0n)) return null;
  const fresh = [];
  for (const leg of opp.legs) {
    const pool = getPool(opp.chain, leg.pool);
    if (!pool) return null;
    const l = orient(pool, leg.tokenIn);
    if (!legIsUsable(l)) return null;
    fresh.push(l);
  }
  const amountOut = simulateRoute(opp.amountIn, fresh);
  if (!(amountOut > 0n)) return null;
  return { amountOut };
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

/// 「手数料の壁がこれだけ低かったら」を試算する幅(bps)。
///
/// [なぜ要るか]
/// 「壁が29bps下がれば+17本」は本数しか答えず、いくら取れたのかが分からない。
/// 実際に取れる金額まで出せば、この戦略の上限が分かる。100bpsは現実に
/// 到達できる値ではない(Polygonの壁35bps、Optimism 6bps、差は29bps)が、
/// 「壁を極限まで下げても $いくらにしかならない」という天井を測る意味がある。
const WHATIF_DROPS = (process.env.WHATIF_WALL_DROPS || "29,50,100")
  .split(",").map((v) => parseInt(v.trim(), 10)).filter((v) => v > 0);

// ===== 取引量を増やせるかを測る(2026年9月21日、オーナーの指示)=====
//
// [なぜ測るか]
// オーナーの目標は「1回あたりの取引量を増やす」。ところが今の実行は投入$1.00で、
// 取引上限は$2,000。**2,000倍の余裕があるのに使っていない。**
// 理由は2つのどちらかで、対策が正反対になる。
//   ① プールが浅く、大きく入れると値が動いて利益が減る → **上限を上げても無駄**。
//      深いプールを見つけるしかない
//   ② こちらの都合(価格表の範囲・刻み)で大きい額を試していない → **直せる**
//
// `findBestAmount` は既に15通りの投入額で利益を計算しているのに、
// **一番良かった1つ以外を捨てている**。捨てている値がそのまま答えになる。
// RPCは1回も増えない(全部その場の計算)。
//
// 測るのは3つ:
//   ・最適額が「使える上限」の何%か(小さいほど浅い)
//   ・最適額の4倍にすると利益が何%になるか(高いほど余裕がある)
//   ・上限に張り付いた回数(こちらの都合で切られている証拠)
const SIZE_SAMPLES_MAX = 600;
const sizeCurve = { bestPct: [], at4xPct: [] };

function noteSizeCurve(best, cap, at4) {
  if (cap <= 0n || best.amountIn <= 0n || best.profit <= 0n) return;
  sizeCurve.bestPct.push(Number((best.amountIn * 10000n) / cap) / 100);
  if (at4) sizeCurve.at4xPct.push(Number((at4.profit * 1000n) / best.profit) / 10);
  // 増え続けないように、古い方から間引く。
  for (const arr of [sizeCurve.bestPct, sizeCurve.at4xPct]) {
    if (arr.length > SIZE_SAMPLES_MAX) arr.splice(0, arr.length - SIZE_SAMPLES_MAX);
  }
}

function medianOf(arr) {
  if (arr.length === 0) return null;
  const a = [...arr].sort((x, y) => x - y);
  return a[Math.floor(a.length / 2)];
}

/// 取引量の余裕。null は「まだ測れていない」。
export function getSizeCurveStats() {
  return {
    samples: sizeCurve.bestPct.length,
    bestPctMedian: medianOf(sizeCurve.bestPct),
    at4xPctMedian: medianOf(sizeCurve.at4xPct),
    hitCap: routeCalcStats.hitCap,
  };
}

function findBestAmount(maxAmountIn, legs) {
  let best = { amountIn: 0n, amountOut: 0n, profit: 0n, returnBps: null };
  const cap = routeMaxAmountIn(maxAmountIn, legs);
  if (cap <= 0n) return { ...best, whatIf: [] };

  // 赤字でも「一番良かった時の利回り」をbpsで残す。
  // simulateRoute を呼ぶ回数は増やさず、すでに計算した値から比率を取るだけ。
  let bestReturnBps = null;

  // 壁が下がった場合の最良の利益(投入額ごとに計算し、一番良いものを残す)。
  // 手数料が下がる分だけ受取が増えるとみなす。段をまたぐ手数料は掛け算だが、
  // この規模では足し算で近似できる。
  const whatIf = WHATIF_DROPS.map((drop) => ({ drop, amountIn: 0n, profit: 0n }));

  const note = (amountIn, amountOut, profit) => {
    if (amountIn <= 0n) return;
    const bps = Number((profit * 10000n) / amountIn);
    if (bestReturnBps == null || bps > bestReturnBps) bestReturnBps = bps;
    for (const w of whatIf) {
      const adjOut = amountOut + (amountOut * BigInt(w.drop)) / 10000n;
      const adjProfit = adjOut - amountIn;
      if (adjProfit > w.profit) { w.profit = adjProfit; w.amountIn = amountIn; }
    }
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
  // 試した額と利益を控える(今までは一番良い1つ以外を捨てていた)。
  const evals = [];
  for (const r of ratios) {
    const amountIn = (cap * BigInt(Math.round(r * 100000))) / 100000n;
    if (amountIn <= 0n) continue;
    const amountOut = simulateRoute(amountIn, legs);
    const profit = amountOut - amountIn;
    note(amountIn, amountOut, profit);
    evals.push({ amountIn, profit });
    if (profit > best.profit) best = { amountIn, amountOut, profit, returnBps: null };
  }
  if (best.amountIn > 0n) {
    for (const r of [0.7, 0.85, 1.15, 1.3]) {
      const amountIn = (best.amountIn * BigInt(Math.round(r * 1000))) / 1000n;
      if (amountIn <= 0n || amountIn > cap) continue;
      const amountOut = simulateRoute(amountIn, legs);
      const profit = amountOut - amountIn;
      note(amountIn, amountOut, profit);
      if (profit > best.profit) best = { amountIn, amountOut, profit, returnBps: null };
    }
  }
  // 一番良かった額が上限のすぐ下なら、上限で切られていた可能性がある。
  if (best.amountIn > 0n && best.amountIn * 100n >= cap * 95n) routeCalcStats.hitCap++;
  // **捨てていた値で「もっと大きく入れられるか」を測る。**
  // 最適額の4倍以上を試した中で、いちばん4倍に近いものと比べる。
  if (best.profit > 0n) {
    const target = best.amountIn * 4n;
    let at4 = null;
    for (const e of evals) {
      if (e.amountIn < target) continue;
      if (at4 == null || e.amountIn < at4.amountIn) at4 = e;
    }
    noteSizeCurve(best, cap, at4);
  }
  return { ...best, returnBps: bestReturnBps, whatIf };
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

/// 現実的に裁定が成り立つ壁の上限(bps)。**表示にしか使わない**
/// (getNearMissStats の絞り込み。判定にも送信にも影響しない)。
///
/// [60 は低すぎた(2026年9月21日に実測で訂正)]
/// 「0.3%+0.3%=60bps までしか成り立たない」という前提で 60 にしていたが、
/// 実際に黒字になった取引の壁を数えると、8件中5件が60bps以上だった。
///   壁105bps avalanche pangolin→uniswap-v3(0.30%)→pangolin  純利+$0.0093
///   壁101bps arbitrum uniswap-v3(1.00%)→uniswap-v3(0.01%)    純利+$0.0097
///   壁 75bps polygon  algebra-a(0.30%)→dfyn→dystopia         純利+$0.0087
///   壁 65bps polygon  uniswap-v3(0.05%)→dfyn→sync発見        純利+$0.0057
///   壁 60bps avalanche pangolin→univ3-fork-f(0.30%)          純利+$0.0077
/// 理由は単純で、**浅いプールでは価格差が100〜160bpsに達する**から。
/// 同じ時間帯の粗利は +48.9 / +62.9 / +63.5 / +75.0 / +88.0 / +138.2 /
/// +153.7 / +161.5 bps。90bpsの壁は160bpsの価格差の前では障害にならない。
///
/// 60 のままだと、polygon では3,274本中210本(6.4%)しか惜しさの分布に
/// 入らず、**実際に稼いでいる 60〜100bps の2,791本(85%)が丸ごと視界の外**に
/// なっていた。100 にすると、その帯が見えるようになる。
/// 100〜200bps でも黒字は出る(上の arbitrum 101bps)ので、そちらは
/// 壁の高さの内訳で別途見る。
const REACHABLE_WALL_BPS = parseInt(process.env.REACHABLE_WALL_BPS || "100", 10);

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

/// 壁が下がった場合の純利益(USD)を経路ごとに記録する。
/// ガス代を引いた後の値で、経路ごとに一番良かったものだけを残す。
function recordWhatIf(key, whatIf, toUsd, gasCostUsd) {
  const entry = routeBest.get(key);
  if (!entry || !whatIf || whatIf.length === 0) return;
  if (!entry.netByDrop) entry.netByDrop = new Array(whatIf.length).fill(0);
  for (let i = 0; i < whatIf.length; i++) {
    const w = whatIf[i];
    if (w.amountIn <= 0n || w.profit <= 0n) continue;
    const net = toUsd(w.profit) - gasCostUsd;
    if (net > entry.netByDrop[i]) {
      entry.netByDrop[i] = net;
      if (!entry.tradeUsdByDrop) entry.tradeUsdByDrop = new Array(whatIf.length).fill(0);
      entry.tradeUsdByDrop[i] = toUsd(w.amountIn);
      // 壁が下がらなかった場合、この投入額であと何bps足りないのか。
      // 試算は「受取が drop bps 増えたら」なので、その分を引けば実際の
      // 利回りになる。深い経路がどれだけ惜しいかを直接読めるようにする。
      if (!entry.shortfallByDrop) entry.shortfallByDrop = new Array(whatIf.length).fill(null);
      const adjBps = Number((w.profit * 10000n) / w.amountIn);
      entry.shortfallByDrop[i] = adjBps - w.drop;
    }
  }
}

/// 「壁がW bps下がっていたら、いくら取れたか」の集計。
///
/// [必ず多めに出ることに注意]
/// ・経路ごとの最良の瞬間だけを足している(同時に全部は取れない)
/// ・複数の経路が同じプールを共有していても別々に数えている。
///   実際には1つの価格差は1回しか取れない
/// ・自分が取れば価格が動くので、その分は引けていない
/// つまりこれは「この戦略の天井」であって、期待できる金額ではない。
export function getWhatIfProfit() {
  const out = {};
  for (const r of routeBest.values()) {
    if (!r.netByDrop) continue;
    if (!out[r.chain]) {
      out[r.chain] = WHATIF_DROPS.map((drop) => ({
        drop, routes: 0, totalUsd: 0, maxUsd: 0, maxTradeUsd: 0,
        maxLabel: null, maxWallBps: null, maxShortfallBps: null,
      }));
    }
    for (let i = 0; i < r.netByDrop.length && i < out[r.chain].length; i++) {
      const net = r.netByDrop[i];
      if (net <= 0) continue;
      const o = out[r.chain][i];
      o.routes++;
      o.totalUsd += net;
      if (net > o.maxUsd) {
        o.maxUsd = net;
        o.maxTradeUsd = r.tradeUsdByDrop ? r.tradeUsdByDrop[i] : 0;
        o.maxLabel = r.label ?? null;
        o.maxWallBps = r.wall ?? null;
        o.maxShortfallBps = r.shortfallByDrop ? r.shortfallByDrop[i] : null;
      }
    }
  }
  return out;
}


function recordNearMiss(chain, key, returnBps, wallBps, label) {
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
  routeBest.set(key, { bps: returnBps, wall: wallBps, chain, label });
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

// ===== 現在価格によるふるいの計測(2026年9月18日に追加) =====
//
// [何を測るのか]
// 見積もりを「常時作り置き」から「候補が出てから」へ変える設計の、前提を測る。
//
// 1段の受取比率は、どんなAMMでも投入額が増えるほど悪くなる(V2の x·y=k も、
// V3の集中流動性も、出力は投入に対して上に凸)。したがって投入額ゼロの極限、
// つまり**現在価格**が、その段で得られるいちばん良い比率になる。経路全体では
//
//     ∏(現在価格ᵢ × (1 − 手数料ᵢ)) ≤ 1  ならば、どんな投入額でも黒字にならない
//
// が**必ず**成り立つ。近似ではないので、**本物の機会を取りこぼさない**。
//
// [なぜ実装より先に測るのか]
// 切り替えると「ふるいを通った経路」ごとに正確な見積もりを取ることになる。
// 通過率が分からないまま切り替えると、候補が毎分数千件出た場合にRPCが破裂する。
// ここでは**数えるだけ**で、RPCも判定の動作も一切変えない。
//
// [桁数を気にしなくてよい理由]
// rateOf は生の整数どうしの比を返すが、経路は同じトークンに戻ってくるので、
// 掛け合わせると桁数の係数が打ち消し合う。比は無次元になる。

/// 通過とみなす利幅の段(bps)。0は「理論上あり得る」、それ以上は
/// ガス代を考えた現実的な線。段ごとに数えると、閾値をどこに置けば
/// 見積もりの回数がいくつになるかが分かる。
const SPOT_SCREEN_EDGES = [0, 5, 10, 30];
const SPOT_SCREEN_ROUTE_LIMIT = 50000;
/// 1ペアで見るプール数の上限。総当たりは二乗で増えるための歯止め。
const SPOT_SCREEN_MAX_POOLS = 24;

/// これを超える利幅は計算が壊れている、とみなす上限(bps)。既定10000 = 100%。
///
/// [なぜ要るか(2026年9月18日、最初の計測で判明)]
/// 最初の版は上限を置かず、`最良10,084,520,773,245bps`(= 10垓%)という
/// 値が出た。壊れたプール(準備量が1weiしかない、死んだトークンなど)の
/// 現在価格はいくらでも極端になるので、ふるいは必ず通ってしまう。
/// HANDOVER の「投入$2で利益$24 のような価格差はハニーポット」と同じ話で、
/// **本物は投入額の0.1〜0.5%程度**。これを混ぜたまま数えると、
/// 通過率が実態とかけ離れる。別枠で数えて、通過からは外す。
/// [1000から10000へ上げた理由(2026年9月18日、計器の検証中に判明)]
/// 1000bps(10%)にしていたため、**薄いプールの大きな価格差が「異常」で
/// 全部落ちていた**。落ちていたのは正しい結果だったが、落としていたのは
/// この上限であって、狙っていた「金額の条件」ではなかった。
/// 割合で切ると「深いプールの大きな価格差」という本物まで落とす。
/// 本物かどうかを決めるのは**金額**なので、そちらに判断させる。
/// ここは「10垓%」のような、計算が壊れている値だけを弾く役に戻す。
const SPOT_SCREEN_SANE_MAX_BPS = parseFloat(process.env.SPOT_SCREEN_SANE_MAX_BPS || "10000");

/// 別々の経路を利幅で分けるときの境目(bps)。
const SPOT_ROUTE_EDGES = [0, 5, 10, 30, 100];
const SPOT_ROUTE_LABELS = ["0〜5bps", "5〜10bps", "10〜30bps", "30〜100bps", "100bps超"];

/// 金額の条件を通したとみなす、ガス代を引いたあとの最低利益(USD)。
///
/// [送信の基準に合わせる(2026年9月20日、実測で判明)]
/// ここは $0.01 固定だった。一方、実際に送る基準は MIN_PROFIT_USD で、
/// 本番は **$0.005**。つまり**ふるいが送信基準の2倍厳しく**、
/// 「送るなら通る」はずの経路を、価格表を作る前に捨てていた。
///
/// Optimism を育てている最中にこれが表面化した。`[ふるいの実物]` を
/// チェーンごとに出すようにしたところ、arbitrum / polygon / avalanche は
/// 出るのに **optimism だけ1件も出ない**。Optimism はガスが最安($0.005)で
/// 1件あたりの利益が小さく、$0.01 の足切りにほぼ全部が引っかかっていた。
/// 価格表は「候補が出た段」しか作らないので、ここで捨てられた経路は
/// **永久に正確な判定を受けられない**。
///
/// 送信の基準と揃える。捨てるのは「送っても基準に満たない」経路だけにする。
const SPOT_SCREEN_MIN_PROFIT_USD = parseFloat(
  process.env.SPOT_SCREEN_MIN_PROFIT_USD || process.env.MIN_PROFIT_USD || "0.01",
);

export function getScreenMinProfitUsd() { return SPOT_SCREEN_MIN_PROFIT_USD; }

/// 金額の見積もりで試す投入額(取引上限に対する比率)。
/// findBestAmount と同じ考え方だが、ふるいなので点数を減らしている。
const SPOT_SIZE_RATIOS = [0.0005, 0.002, 0.008, 0.03, 0.12, 0.3, 0.6, 1.0];

/// 経路を「ガス代を引いた利益」で分ける境目(USD)。
const SPOT_NET_EDGES = [0, 0.01, 0.1, 1];
const SPOT_NET_LABELS = ["赤字", "〜$0.01", "$0.01〜0.1", "$0.1〜1", "$1超"];

/// 実物を確かめるために残す、いちばん良かった経路の数。
const SPOT_SAMPLE_LIMIT = 5;

const spotScreen = {
  evaluated: 0,
  passed: SPOT_SCREEN_EDGES.map(() => 0),
  // 状態が変わってから初めて通った回数。**切り替え後に本当に必要な見積もりの回数**。
  // 同じ状態の同じ経路を何度評価しても、見積もりは1回で足りる。
  fresh: SPOT_SCREEN_EDGES.map(() => 0),
  passedWithTable: 0,
  insane: 0,
  bestBps: null,
  // 金額の条件(ガス代+最低利益)まで通った、状態が変わってからの初回。
  // **これが切り替え後に本当に必要な見積もりの回数**。
  freshNeedQuote: 0,
  needQuote: 0,
  routes: new Map(),
  routeNet: new Map(),
  signatures: new Map(),
  samples: [],
  capped: 0,
};

/// 1段の準備量を浮動小数で取り出す。
///
/// [V3をx·y=kで近似する理由]
/// ここは**ふるいの金額の目安**であって、送信前の見積もりではない。
/// 現在の価格帯の仮想準備量 (L/√P, L·√P) を使うと、価格帯の内側では
/// x·y=k と同じように動く。価格帯が狭いプールでは多めに出るが、
/// 多めに出る=ふるいを通る側なので、本物を落とすことはない。
/// 落としてよいかの最終判断は、通ったあとの正確な見積もりが行う。
function legReservesFloat(leg) {
  if (leg.kind === KIND_V3) {
    const sqrt = Number(leg.sqrtPriceX96) / 2 ** 96;
    const liquidity = Number(leg.liquidity);
    if (!(sqrt > 0) || !(liquidity > 0)) return null;
    const r0 = liquidity / sqrt, r1 = liquidity * sqrt;
    const out = leg.zeroForOne ? { rIn: r0, rOut: r1 } : { rIn: r1, rOut: r0 };
    return isFinite(out.rIn) && isFinite(out.rOut) ? out : null;
  }
  const rIn = Number(leg.reserveIn), rOut = Number(leg.reserveOut);
  return rIn > 0 && rOut > 0 ? { rIn, rOut } : null;
}

/// x·y=k の受取量(浮動小数版)。ふるいの目安なので精度は要らない。
function outFloat(amountIn, rIn, rOut, feeBps) {
  if (!(amountIn > 0) || !(rIn > 0) || !(rOut > 0)) return 0;
  const withFee = (amountIn * (10000 - feeBps)) / 10000;
  return (withFee * rOut) / (rIn + withFee);
}

/// 現在の準備量から「取れそうな利益(USD)」を見積もる。RPCは使わない。
///
/// [なぜ要るか(2026年9月18日の計測で判明)]
/// ふるいは**割合(%)しか見ていなかった**。流動性$50のプールで500%の
/// 価格差があっても取れるのは数ドルで、その大半は税トークンや死んだプール。
/// 実測では経路3,908本のうち2,282本(58%)が100bps超という、本物では
/// あり得ない分布になっていた。深さは無料で手に入るので、金額まで見る。
function estimateNetUsd(chain, tokenA, legs, capUsd, gasCostUsd) {
  const decimals = getTokenDecimals(chain, tokenA);
  const priceUsd = getTokenPriceUsd(chain, tokenA);
  if (decimals == null || !priceUsd) return null;
  const reserves = [];
  for (const leg of legs) {
    const r = legReservesFloat(leg);
    if (!r) return null;
    reserves.push(r);
  }
  const capRaw = (capUsd / priceUsd) * Math.pow(10, decimals);
  if (!(capRaw > 0) || !isFinite(capRaw)) return null;

  let bestRaw = 0;
  for (const ratio of SPOT_SIZE_RATIOS) {
    const amountIn = capRaw * ratio;
    let amount = amountIn;
    for (let i = 0; i < legs.length; i++) {
      amount = outFloat(amount, reserves[i].rIn, reserves[i].rOut, legs[i].feeBps);
      if (!(amount > 0)) break;
    }
    const profit = amount - amountIn;
    if (profit > bestRaw) bestRaw = profit;
  }
  if (!(bestRaw > 0)) return -gasCostUsd;
  const grossUsd = (bestRaw / Math.pow(10, decimals)) * priceUsd;
  return isFinite(grossUsd) ? grossUsd - gasCostUsd : null;
}

// ふるいを通った経路が「判定するのに価格表が要る」と言っているプール。
//
// [これが作り置きをやめる要](2026年9月18日)
// 今までは全V3プールの価格表を順ぐりに作っていたので、費用も鮮度も
// プール数に比例していた(V3 5,000件なら一巡69分)。
// ここに積まれるのは**金額の条件まで通った経路の段だけ**なので、
// 費用が「プール数」ではなく「候補の数」に比例するようになる。
// 実測では候補は毎分0〜22件しかない。
const quoteDemand = new Set();
const QUOTE_DEMAND_LIMIT = 500;
let quoteDemandTotal = 0;

/// 積まれた要求を取り出して空にする。index.js が最優先で作る。
export function takeQuoteDemand() {
  if (quoteDemand.size === 0) return [];
  const out = [...quoteDemand];
  quoteDemand.clear();
  return out;
}

export function getQuoteDemandTotal() { return quoteDemandTotal; }

/// 実物を確かめるための見本を残す(利益の大きい順)。
///
/// [チェーンごとに残す(2026年9月20日)]
/// 以前は全チェーンをまとめて上位3件にしていた。ところが Polygon の
/// 壊れたプール(価格差6,622bps・見積利益$10.67)が毎分1位〜3位を占め続け、
/// **他のチェーンの候補が1件も見えなかった**。Optimism を育てている最中に
/// 「そこで何が惜しかったのか」が読めないのは困る。
/// チェーンごとに上位 SPOT_SAMPLE_PER_CHAIN 件を残す。
const SPOT_SAMPLE_PER_CHAIN = parseInt(process.env.SPOT_SAMPLE_PER_CHAIN || "2", 10);

function keepSample(sample) {
  const list = spotScreen.samples;
  const existing = list.findIndex((x) => x.key === sample.key);
  if (existing >= 0) {
    if (list[existing].netUsd >= sample.netUsd) return;
    list.splice(existing, 1);
  }
  list.push(sample);
  list.sort((a, b) => b.netUsd - a.netUsd);
  // チェーンごとに上限まで残す。全体の上限も残しておく(際限なく増やさないため)。
  const perChain = new Map();
  spotScreen.samples = list.filter((x) => {
    const n = (perChain.get(x.chain) || 0) + 1;
    perChain.set(x.chain, n);
    return n <= SPOT_SAMPLE_PER_CHAIN;
  }).slice(0, SPOT_SAMPLE_LIMIT * 4);
}

/// 経路の現在価格の積。手数料を引いたあとの利幅をbpsで返す。
function spotEdgeBps(legs) {
  let product = 1;
  for (const leg of legs) {
    const rate = rateOf(leg);
    if (!isFinite(rate) || rate <= 0) return null;
    product *= rate * (1 - leg.feeBps / 10000);
  }
  if (!isFinite(product)) return null;
  return (product - 1) * 10000;
}

/// 1ペアぶんの2段経路を、**価格表の有無に関係なく**ふるいにかけて数える。
/// 今の判定は価格表のある段しか使えないので、ここでは「切り替えたら
/// いくつ候補が出るか」を測るために、その条件を外して数える。
function measureSpotScreen(chain, tokenA, tokenB, pools, capUsd, gasCostUsd) {
  let usable = pools.filter(hasUsableState);
  if (usable.length < 2) return;
  if (usable.length > SPOT_SCREEN_MAX_POOLS) {
    spotScreen.capped++;
    usable = usable.slice(0, SPOT_SCREEN_MAX_POOLS);
  }

  for (const [borrow, other] of [[tokenA, tokenB], [tokenB, tokenA]]) {
    const borrowLower = borrow.toLowerCase();
    const otherLower = other.toLowerCase();
    const outbound = [], inbound = [];
    for (const p of usable) {
      const l1 = orient(p, borrowLower);
      if (l1.tokenOut === otherLower) outbound.push({ pool: p, leg: l1 });
      const l2 = orient(p, otherLower);
      if (l2.tokenOut === borrowLower) inbound.push({ pool: p, leg: l2 });
    }
    for (const a of outbound) {
      for (const b of inbound) {
        if (a.pool.address.toLowerCase() === b.pool.address.toLowerCase()) continue;
        const legs = [a.leg, b.leg];
        const edge = spotEdgeBps(legs);
        if (edge == null) continue;
        spotScreen.evaluated++;
        if (edge <= 0) continue;
        // 壊れたプールは必ずふるいを通る。別枠で数えて通過からは外す。
        if (edge > SPOT_SCREEN_SANE_MAX_BPS) { spotScreen.insane++; continue; }
        if (spotScreen.bestBps == null || edge > spotScreen.bestBps) spotScreen.bestBps = edge;

        const addrs = [a.pool.address, b.pool.address];
        const key = `${chain}:${borrowLower}:${addrs[0].toLowerCase()}>${addrs[1].toLowerCase()}`;

        // 同じ経路が同じ状態のままなら、見積もりは1回で足りる。
        // 切り替え後のRPCを見積もるには、こちらを数えないといけない。
        const sig = routeSignature(chain, addrs);
        const isFresh = spotScreen.signatures.get(key) !== sig;
        if (isFresh && spotScreen.signatures.size < SPOT_SCREEN_ROUTE_LIMIT) {
          spotScreen.signatures.set(key, sig);
        }

        for (let i = 0; i < SPOT_SCREEN_EDGES.length; i++) {
          if (edge <= SPOT_SCREEN_EDGES[i]) continue;
          spotScreen.passed[i]++;
          if (isFresh) spotScreen.fresh[i]++;
        }
        if (legIsUsable(a.leg) && legIsUsable(b.leg)) spotScreen.passedWithTable++;

        // 金額の条件。ここまで通ったものだけが、切り替え後に見積もりを要する。
        const netUsd = estimateNetUsd(chain, borrowLower, legs, capUsd, gasCostUsd);
        if (netUsd != null) {
          const prevNet = spotScreen.routeNet.get(key);
          if (prevNet == null) {
            if (spotScreen.routeNet.size < SPOT_SCREEN_ROUTE_LIMIT) spotScreen.routeNet.set(key, netUsd);
          } else if (netUsd > prevNet) {
            spotScreen.routeNet.set(key, netUsd);
          }
          if (netUsd > SPOT_SCREEN_MIN_PROFIT_USD) {
            spotScreen.needQuote++;
            if (isFresh) spotScreen.freshNeedQuote++;

            // 金額の条件まで通ったのに価格表が無くて判定できない段は、
            // その場で作るよう要求する。ここが「候補が出てから見積もる」の入口。
            for (const leg of legs) {
              if (leg.kind !== KIND_V3 || legIsUsable(leg)) continue;
              if (quoteDemand.size >= QUOTE_DEMAND_LIMIT) break;
              if (quoteDemand.has(`${chain}::${leg.pool.toLowerCase()}`)) continue;
              quoteDemand.add(`${chain}::${leg.pool.toLowerCase()}`);
              quoteDemandTotal++;
            }
            keepSample({
              key, chain, netUsd, edge,
              tokenIn: borrowLower,
              pools: `${a.pool.dexId}:${addrs[0].slice(0, 8)}…→${b.pool.dexId}:${addrs[1].slice(0, 8)}…`,
              feeBps: legs.reduce((sum, l) => sum + l.feeBps, 0),
            });
          }
        }

        const prev = spotScreen.routes.get(key);
        if (prev == null) {
          if (spotScreen.routes.size < SPOT_SCREEN_ROUTE_LIMIT) spotScreen.routes.set(key, edge);
        } else if (edge > prev) {
          spotScreen.routes.set(key, edge);
        }
      }
    }
  }
}

/// ふるいの計測結果。edges は段の値(bps)、passed は段ごとの通過回数。
export function getSpotScreenStats() {
  // 別々の経路を、いちばん良かった利幅で分ける。
  // 通過「回数」は同じ経路の数え直しを含むが、こちらは本数なので実態に近い。
  const routeCounts = new Array(SPOT_ROUTE_LABELS.length).fill(0);
  for (const edge of spotScreen.routes.values()) {
    let i = SPOT_ROUTE_EDGES.findIndex((e, k) => {
      const next = SPOT_ROUTE_EDGES[k + 1];
      return edge > e && (next == null || edge <= next);
    });
    if (i === -1) i = SPOT_ROUTE_LABELS.length - 1;
    routeCounts[i]++;
  }
  // 経路を「ガス代を引いた利益」で分ける。
  const netCounts = new Array(SPOT_NET_LABELS.length).fill(0);
  for (const net of spotScreen.routeNet.values()) {
    let i = 0;
    while (i < SPOT_NET_EDGES.length && net > SPOT_NET_EDGES[i]) i++;
    netCounts[i]++;
  }
  return {
    edges: [...SPOT_SCREEN_EDGES],
    evaluated: spotScreen.evaluated,
    passed: [...spotScreen.passed],
    fresh: [...spotScreen.fresh],
    passedWithTable: spotScreen.passedWithTable,
    insane: spotScreen.insane,
    bestBps: spotScreen.bestBps,
    distinctRoutes: spotScreen.routes.size,
    routeLabels: [...SPOT_ROUTE_LABELS],
    routeCounts,
    needQuote: spotScreen.needQuote,
    freshNeedQuote: spotScreen.freshNeedQuote,
    netLabels: [...SPOT_NET_LABELS],
    netCounts,
    samples: spotScreen.samples.map((x) => ({ ...x })),
    minProfitUsd: SPOT_SCREEN_MIN_PROFIT_USD,
    capped: spotScreen.capped,
  };
}

// ===== 答え合わせで繰り返し犯人になったプールの一時除外(2026年9月20日) =====
//
// [実測がもとになっている]
// 一晩(8.5時間)の赤字12件を段ごとに答え合わせしたところ、同じプールが
// 何度も犯人になっていた(Optimism の 0xc1738D90… が2回、dystopia、sushiswap…)。
// 誤差は −15〜−57bps で、狙う利幅(5〜50bps)と同じ大きさ。
// このプールを含む経路は「黒字に見えて送信直前で赤字」を繰り返し、
// 見積もりの呼び出しと冷却の枠を消費し、精度(67%→25%)を下げていた。
//
// [なぜ外しても本物の機会は減らないか]
// 犯人の段は「同じ式・同じ手数料で、今の状態を読み直して」も見込みと
// 合わなかったプール。つまりメモリ上の状態そのものが信用できない。
// 本物の機会ならチェーン上でも黒字のはずで、それが出ていない。
// 手数料の見直し(45bpsに戻す)と同じ発想で、一定回数で一定時間外す。
const BLAME_QUARANTINE_AFTER = parseInt(process.env.BLAME_QUARANTINE_AFTER || "2", 10);
const BLAME_QUARANTINE_MINUTES = parseFloat(process.env.BLAME_QUARANTINE_MINUTES || "60");
const BLAME_WINDOW_MINUTES = parseFloat(process.env.BLAME_WINDOW_MINUTES || "360");
const blamedPools = new Map(); // "chain::pool" -> { times: [ms...], until: ms }
const quarantineStats = { quarantined: 0, skippedRoutes: 0 };

/// 答え合わせで犯人と名指しされたプールを記録する。回数が閾値に達したら一時除外。
export function notePoolBlame(chain, pool, diffBps) {
  const key = `${chain}::${(pool || "").toLowerCase()}`;
  const now = Date.now();
  const entry = blamedPools.get(key) || { times: [], until: 0 };
  entry.times = entry.times.filter((t) => now - t < BLAME_WINDOW_MINUTES * 60000);
  entry.times.push(now);
  blamedPools.set(key, entry);
  if (entry.times.length >= BLAME_QUARANTINE_AFTER && now >= entry.until) {
    entry.until = now + BLAME_QUARANTINE_MINUTES * 60000;
    entry.times = [];
    quarantineStats.quarantined++;
    console.log(`[一時除外] ${chain} ${pool}: 答え合わせで${BLAME_QUARANTINE_AFTER}回犯人になった(直近${diffBps != null ? diffBps.toFixed(1) + "bps" : "-"})。${BLAME_QUARANTINE_MINUTES}分間、このプールを含む経路を判定しません`);
    return true;
  }
  return false;
}

export function isPoolQuarantined(chain, pool) {
  const entry = blamedPools.get(`${chain}::${(pool || "").toLowerCase()}`);
  return !!entry && Date.now() < entry.until;
}

export function getQuarantineStats() {
  let active = 0;
  const now = Date.now();
  for (const e of blamedPools.values()) if (now < e.until) active++;
  return { ...quarantineStats, active };
}

function finalize({ chain, tokenA, legs, maxAmountIn, gasCostUsd, label, kind, poolAddresses }) {
  // 答え合わせで繰り返し犯人になったプールを含む経路は、しばらく判定しない。
  if (poolAddresses.some((a) => isPoolQuarantined(chain, a))) {
    quarantineStats.skippedRoutes++;
    return null;
  }
  // V3を1段も含まない経路は判定しない。
  if (!legs.some((l) => l.kind === KIND_V3)) return null;

  // 送信直前に赤字と確定し、その後どのプールも動いていない経路は計算しない。
  if (isSuppressed(chain, tokenA, poolAddresses)) return null;

  routeCalcStats.computed++;
  const best = findBestAmount(maxAmountIn, legs);
  // 捨てる前に「どれくらい惜しかったか」を経路ごとに残す。
  // 同じ経路を何度評価しても1本として数える(回数ではなく本数を知りたい)。
  const wallBps = legs.reduce((sum, l) => sum + l.feeBps, 0);
  const routeKey = routeKeyOf(chain, tokenA, poolAddresses);
  recordNearMiss(chain, routeKey, best.returnBps, wallBps, label);

  // 桁数と価格は「壁が下がった場合」の金額換算にも要るので、
  // 赤字で打ち切る前に取っておく。どちらもメモリ上の参照で、RPCは使わない。
  const decimals = getTokenDecimals(chain, tokenA);
  const priceUsd = getTokenPriceUsd(chain, tokenA);
  const toNumber = (v) => Number(v) / Math.pow(10, decimals);

  // 赤字の経路こそ「壁が下がっていれば取れたか」を知りたいので、
  // 打ち切りの手前で試算を記録する。
  if (decimals != null && priceUsd) {
    recordWhatIf(routeKey, best.whatIf, (v) => toNumber(v) * priceUsd, gasCostUsd);
  }

  // 粗利(ガス代を引く前)がプラスでなければ、そこで終わり。
  // 裁定の機会が無い時はここで止まるのが正常。
  if (best.profit <= 0n) return null;
  routeCalcStats.grossProfitable++;

  if (decimals == null || !priceUsd) return null;
  const tradeAmountUsd = toNumber(best.amountIn) * priceUsd;
  if (MIN_TRADE_USD > 0 && tradeAmountUsd < MIN_TRADE_USD) return null;

  // フラッシュスワップ方式のため、借入手数料は差し引かない。
  const grossProfitUsd = toNumber(best.profit) * priceUsd;
  const netProfitUsd = grossProfitUsd - gasCostUsd;
  const hasV3 = legs.some((l) => l.kind === KIND_V3);

  // 段ごとに「いくら入れて、いくら返ると見込んだか」を残す。
  //
  // [なぜ要るか(2026年9月19日)]
  // 送信直前の確認で赤字と分かったとき、今までは**経路全体で何bpsずれたか**
  // しか分からなかった。-476.7bps のようなずれが出ても、どの段が嘘を
  // ついているのか特定できない。段ごとの見込みを残しておけば、赤字の時に
  // 各段を単独で正確に見積もり直して突き合わせられる。
  const legAmounts = [];
  {
    let amount = best.amountIn;
    for (const leg of legs) {
      const out = legAmountOut(leg, amount);
      legAmounts.push({ in: amount, out });
      amount = out;
      if (amount <= 0n) break;
    }
  }

  return {
    kind, chain, tokenA, label, poolAddresses, legs, hasV3, legAmounts,
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
  // 計測だけ先に行う。RPCは使わず、この下の判定には一切影響しない。
  measureSpotScreen(chain, tokenA, tokenB, pools, capUsd, gasCostUsd);

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
