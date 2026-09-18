// index.js
//
// [設計] イベント駆動型のDEXアービトラージbot。V2形式とV3形式の両方を扱う。
//
// [V3は価格表で判定する]
// 独自の近似式は公式Quoterより最大2,184%も過大な値を返していた(2026年9月16日)。
// V3は価格帯ごとに流動性が分かれており、近似式では表現できない。
// プールごとに公式Quoterで「代表的な投入額での受取量」を取得して表にし、
// 判定時はそこから補間する。RPCを使わずミリ秒で済み、誤差もない。
// 価格が動いたプールは表を作り直す。
//
// [問い合わせを束ねる(2026年9月16日)]
// Chainstackは1回=1リクエスト単位で課金される。V3の状態読み(1プール2回)と
// 価格表の作成(1プール12回)を個別に出していたため、Polygonだけで月約1,100万
// 単位に達していた。どちらもMulticall3で束ね、複数プール分を1〜数回で済ませる。
//
// [WebSocketの無いチェーンでも価格表を作り直す(2026年9月16日)]
// 価格表の作り直しは「WebSocketでSwapが届いた時」にしか予約されていなかった。
// Optimism・Arbitrum・Avalancheは定期読み直しで価格だけが更新され、表は
// 起動時のまま古くなり続けた。これが同じ経路を毎分「黒字」と誤判定し続けた
// 原因。定期読み直しでも価格が動いていれば表を作り直す。
//
// [フラッシュスワップ方式]
// 経路の最初のプール自身から先に受け取るため、借入手数料がかからず、
// 桁数と価格が分かる通貨なら何でも始点にできる。
//
// [監視対象の絞り込み]
// 2段の裁定は「同じペアに2つ以上のプールがある」時にしか成立しない。
// 候補だけに絞ることでイベント量が1/10になり、費用が予算内に収まる。

import http from "http";
import { ethers } from "ethers";
import { startOnchainFeeds, getSyncStats, isChainWsEnabled, isChainHealthy, setWatchedAddresses } from "./dex-onchain-realtime.js";
import { runMainnetDeploy } from "./scripts/mainnet-deploy.js";
import { runPoolSurvey } from "./scripts/pool-survey.js";
import { getRealExecutionStats } from "./scripts/real-execution-log.js";
import { getCurrentTradeCapUsd, getSuccessCount } from "./scripts/trade-cap.js";
import { probePoolFeeBps, isFeeProbeOnHold, getRpcStatus, getRpcCallTotals, callWithRpc } from "./scripts/onchain-reserves.js";
import { updateRpcUsage, formatRpcUsageLine } from "./scripts/rpc-usage.js";
import {
  fetchReservesBatch, fetchPoolTokensBatch, fetchTokenDecimalsBatch,
  fetchV3StatesBatch, getMulticallStats, findV3PoolsBatch,
} from "./scripts/multicall-reserves.js";
import { estimateGasCostUsd, getGasCostStatus } from "./scripts/gas-cost.js";
import { discoverFactory, discoverPoolsFromFactory } from "./scripts/pool-discovery.js";
import {
  registerPool, removePool, pruneToCandidates, getSubscribedAddresses,
  updateReservesFromSync, updateV3FromSwap, setPoolFee, getPool, getStats,
  setTokenDecimals, getTokenDecimals, setTokenPriceUsd, getTokenPriceUsd,
  getAllPoolAddressesByChain, getPoolsForToken, getStalePools, getPoolsByKind,
  getArbitragablePairs, savePoolMap, loadPoolMap, snapshotFullMap,
  hasUsableState, clearPoolState, formatStateDiagnostics, KIND_V2, KIND_V3,
  markQuoteBase, getQuoteFreshness, rankTokensByDepth,
} from "./scripts/pool-registry.js";
import {
  scanForChangedPool, scanAllPairs, getRouteCalcStats,
  getNearMissStats, countIfWallDrops, getWallBreakdown, NEAR_MISS_REACHABLE_WALL_BPS,
  getWhatIfProfit,
} from "./scripts/opportunity-scanner.js";
import { executeOpportunity, ExecutionError, TAX_TOKEN_FEE_BPS } from "./scripts/execute-opportunity.js";
import {
  getKnownTokens, isBorrowable,
  markUsableStart, clearUsableStarts, countUsableStarts,
} from "./scripts/borrowable-tokens.js";
import { getVerifiedPairs } from "./scripts/verified-pairs.js";
import { isKnownIncompatiblePool, recordIncompatiblePool } from "./scripts/incompatible-pools.js";
import { journal, loadJournal, trimJournalIfNeeded, summarize } from "./scripts/opportunity-journal.js";
import {
  activeV3Factories, isForkFactory, V3_FEE_TIERS, findV3Pool, feeTierToBps,
  buildQuoteTablesBatch, hasQuoteTable, clearQuoteTable, countQuoteTables,
  verifyQuoteTable, QUOTE_SAMPLES_USD,
} from "./scripts/v3-pools.js";
import { CHAIN_CONFIG } from "./chain-config.js";

const MIN_PROFIT_USD = parseFloat(process.env.MIN_PROFIT_USD || "0.01");

/// 「壁がこれだけ下がったら何件増えるか」を見るときの基準値(bps)。
/// 実測: Polygonの手数料の壁は最小35bps、Optimismは最小6bps。その差が29bps。
/// Optimismへ移すと機会がどれだけ増えるかの目安になる。
const WALL_DROP_BPS = parseInt(process.env.WALL_DROP_BPS || "29", 10);
const FULL_SCAN_INTERVAL_SEC = parseInt(process.env.FULL_SCAN_INTERVAL_SEC || "30", 10);
const REFRESH_STALE_SEC = parseInt(process.env.REFRESH_STALE_SEC || "60", 10);
const REFRESH_BATCH_SIZE = parseInt(process.env.REFRESH_BATCH_SIZE || "600", 10);
// V3の状態を読み直す本数(20秒ごと)。束ねて読むので本数を増やしても1〜2回で済む。
const V3_REFRESH_PER_TICK = parseInt(process.env.V3_REFRESH_PER_TICK || "120", 10);
// 価格表を作り直すプール数(1回あたり)。束ねて問い合わせるので数回で済む。
const QUOTE_TABLE_PER_TICK = parseInt(process.env.QUOTE_TABLE_PER_TICK || "6", 10);
const QUOTE_TABLE_INTERVAL_MS = parseInt(process.env.QUOTE_TABLE_INTERVAL_MS || "5000", 10);
// 価格が動いたV3プールは表を作り直す。この割合(%)以上動いたら対象。
/// 価格表を作り直す基準。**価格表を作った時からの累積のズレ**(%)。
///
/// 以前は「今回の更新1回ぶんの変化率」で判定しており、0.09%ずつ何度も
/// 動くプールは永久に作り直されなかった。また既定の0.1%は10bpsで、
/// 狙う利幅(5〜50bps)と同じ桁のため、許容誤差が大きすぎた。
/// 累積で見るようになったので、既定を3bpsまで下げる。
const QUOTE_REBUILD_MOVE_PCT = parseFloat(process.env.QUOTE_REBUILD_MOVE_PCT || "0.03");
const FEE_PROBE_PER_TICK = parseInt(process.env.FEE_PROBE_PER_TICK || "4", 10);
const FEE_PROBE_INTERVAL_MS = 1000;
const SAVE_MAP_INTERVAL_MS = 5 * 60 * 1000;
const MAP_REBUILD_AFTER_HOURS = parseInt(process.env.MAP_REBUILD_AFTER_HOURS || "168", 10);
const HEARTBEAT_INTERVAL_MS = 60 * 1000;
const EXECUTION_TIMEOUT_MS = parseInt(process.env.EXECUTION_TIMEOUT_MS || "20000", 10);
const GAS_REFRESH_INTERVAL_MS = parseInt(process.env.GAS_REFRESH_INTERVAL_MS || "60000", 10);
const FAILURE_COOLDOWN_MS = 10 * 60 * 1000;
const DISABLE_AFTER_FAILURES = 3;
const MAX_SANE_RETURN_RATIO = parseFloat(process.env.MAX_SANE_RETURN_RATIO || "0.20");
const BIG_MOVE_PCT = parseFloat(process.env.BIG_MOVE_PCT || "0.5");
const V3_VERIFY_INTERVAL_MS = parseInt(process.env.V3_VERIFY_INTERVAL_MS || "120000", 10);
const MIN_PRICE_SOURCE_USD = parseFloat(process.env.MIN_PRICE_SOURCE_USD || "5000");
/// V3プールを探すトークンの上限。手書きの一覧に、V2で流動性のあるトークンを足す。
/// ペア数は概ね二乗で増える(24種なら276ペア)。照会は束ねるのでRPCは十数回で済むが、
/// 見つかったプールの分だけ購読と受信が増えるので、枠を見ながら上げる。
const V3_DISCOVERY_TOKENS = parseInt(process.env.V3_DISCOVERY_TOKENS || "24", 10);
/// 探索対象に加えるトークンの、V2での深さの下限(USD)。
const MIN_DISCOVERY_DEPTH_USD = parseFloat(process.env.MIN_DISCOVERY_DEPTH_USD || "50000");
const PRICE_REFRESH_INTERVAL_MS = 5 * 60 * 1000;
const SCAM_REVERT_PATTERNS = [/blacklist/i, /not allowed/i, /forbidden/i, /trading (is )?not (enabled|open)/i, /cooldown/i, /max ?tx/i, /max ?wallet/i, /antiwhale/i];

// ===== ガス代 =====
const FALLBACK_GAS = { base: 0.010, arbitrum: 0.035, optimism: 0.005, polygon: 0.014, avalanche: 0.001 };
const gasCostCache = new Map();
function getGasCost(chain, kind = "2step") {
  return gasCostCache.get(`${chain}::${kind}`) ?? FALLBACK_GAS[chain] ?? 0.02;
}
async function refreshGasCosts() {
  for (const chain of Object.keys(CHAIN_CONFIG)) {
    for (const kind of ["2step", "3step"]) {
      try { gasCostCache.set(`${chain}::${kind}`, await estimateGasCostUsd(chain, kind)); } catch (e) {}
    }
  }
}

// ===== 統計 =====
const reasons = { disabled: 0, taxToken: 0, cooldown: 0, trap: 0, belowMin: 0, executing: 0, sendBusy: 0, notSent: 0, failed: 0, success: 0 };
const failStages = {};

const stats = {
  scans: 0, profitableFound: 0, examined: 0, executed: 0, failed: 0,
  skippedCooldown: 0, trapsRejected: 0, taxTokensRejected: 0, staleRejected: 0, bigMoves: 0,
  v3Found: 0, v3Matched: 0, v3Opportunities: 0, v3LiquidityEvents: 0,
  quoteTablesBuilt: 0, quoteTablesPending: 0, quoteRebuildsFromPolling: 0,
  v3VerifyCount: 0, v3VerifyWorst: null, v3VerifyRecent: [],
  disabledFromFile: 0, disabledRuntime: 0,
  prunedTotal: 0, prunedKept: 0,
  decimalsKnown: 0, pricedTokens: 0,
  lastOpportunity: null, recent: [], syncMatched: 0, syncUnknown: 0, disabled: 0,
  latencies: [], refreshCycles: 0, mapSource: "-", mapSavedAt: null,
  feeProbed: 0, feeProbePending: 0, lastHeartbeat: null, reservesLoaded: 0, journalLoaded: 0,
};

const chainReady = new Set();
function isReady(chain) { return chainReady.has(chain); }
function anyReady() { return chainReady.size > 0; }

// ===== 失敗の抑制と無効化 =====
const cooldownUntil = new Map();
const poolFailures = new Map();
const disabledPools = new Set();

function poolKeyOf(chain, address) { return `${chain}::${address.toLowerCase()}`; }

function disablePool(chain, address, reason, fromFile = false) {
  const key = poolKeyOf(chain, address);
  if (disabledPools.has(key)) return;
  disabledPools.add(key);
  stats.disabled++;
  if (fromFile) stats.disabledFromFile++; else stats.disabledRuntime++;
  clearPoolState(getPool(chain, address));
  clearQuoteTable(chain, address);
  if (!fromFile) {
    recordIncompatiblePool(chain, address, reason);
    console.log(`[無効化] ${chain} ${address.slice(0, 10)}…: ${reason.slice(0, 70)}`);
  }
}

function isScamRevert(message) {
  return SCAM_REVERT_PATTERNS.some((re) => re.test(message || ""));
}

function noteExecutionFailure(opp, error) {
  const reason = error?.message || String(error);
  const stage = error instanceof ExecutionError ? error.stage : "unknown";
  failStages[stage] = (failStages[stage] || 0) + 1;
  cooldownUntil.set(opp.poolAddresses.join("|").toLowerCase(), Date.now() + FAILURE_COOLDOWN_MS);

  if (error instanceof ExecutionError && error.taxToken) {
    stats.taxTokensRejected++;
    const targets = error.taxPools?.length ? error.taxPools : opp.poolAddresses;
    for (const address of targets) {
      disablePool(opp.chain, address, `送金時に税を取るトークン(手数料${TAX_TOKEN_FEE_BPS}bps超)`);
    }
    return;
  }
  if (error instanceof ExecutionError && error.staleReserves) {
    stats.staleRejected++;
    return;
  }

  const scam = isScamRevert(reason);
  for (const address of opp.poolAddresses) {
    const key = poolKeyOf(opp.chain, address);
    const n = (poolFailures.get(key) || 0) + 1;
    poolFailures.set(key, n);
    if (scam) {
      disablePool(opp.chain, address, `詐欺トークン: ${reason}`);
    } else if (n >= DISABLE_AFTER_FAILURES) {
      disablePool(opp.chain, address, `送信失敗${n}回(価格が信用できない): ${reason}`);
    }
  }
}

function hasDisabledPool(opp) {
  return opp.poolAddresses.some((a) => disabledPools.has(poolKeyOf(opp.chain, a)));
}

function pruneTaxTokenPools(opp) {
  let found = false;
  for (const address of opp.poolAddresses) {
    const pool = getPool(opp.chain, address);
    if (!pool || pool.kind === KIND_V3 || !pool.feeProbed) continue;
    if (pool.feeBps > TAX_TOKEN_FEE_BPS) {
      stats.taxTokensRejected++;
      disablePool(opp.chain, address, `実測手数料${pool.feeBps}bps(税トークン)`);
      found = true;
    }
  }
  return found;
}

function rejectIfTrap(opp) {
  if (opp.tradeAmountUsd <= 0) return false;
  const ratio = opp.netProfitUsd / opp.tradeAmountUsd;
  if (ratio <= MAX_SANE_RETURN_RATIO) return false;
  stats.trapsRejected++;
  const reason = `異常なリターン${(ratio * 100).toFixed(0)}%`;
  if (opp.hasV3) {
    console.log(`[罠の疑い] ${opp.kind} ${opp.chain} ${opp.label}: ${reason}。見送ります`);
    cooldownUntil.set(opp.poolAddresses.join("|").toLowerCase(), Date.now() + FAILURE_COOLDOWN_MS);
    return true;
  }
  console.log(`[罠] ${opp.kind} ${opp.chain} ${opp.label}: ${reason}(投入$${opp.tradeAmountUsd.toFixed(2)}→利益$${opp.netProfitUsd.toFixed(2)})。無効化します`);
  for (const address of opp.poolAddresses) disablePool(opp.chain, address, reason);
  return true;
}

// ===== 記録簿 =====
function record(opp, outcome, extra = {}) {
  journal({
    outcome, chain: opp.chain, kind: opp.kind, label: opp.label, hasV3: !!opp.hasV3,
    tradeAmountUsd: Number(opp.tradeAmountUsd?.toFixed?.(4) ?? 0),
    netProfitUsd: Number(opp.netProfitUsd?.toFixed?.(6) ?? 0),
    feeWallPercent: opp.feeWallPercent,
    pools: opp.poolAddresses,
    // 送信まで進んだ機会は、確定した実際の値も残す。これが無いと
    // 記録簿の「実際に得た利益」が構造的に常に0になる。
    ...(opp.actualProfitUsd != null ? { actualProfitUsd: opp.actualProfitUsd } : {}),
    ...(opp.actualGasCostUsd != null ? { actualGasCostUsd: opp.actualGasCostUsd } : {}),
    ...(opp.actualNetProfitUsd != null ? { actualNetProfitUsd: opp.actualNetProfitUsd } : {}),
    // 送信直前の確認でどれだけ足りなかったか(赤字だった場合)。
    ...(opp.shortfallBps != null ? { shortfallBps: opp.shortfallBps } : {}),
    ...(opp.sendResult ? { sendResult: opp.sendResult } : {}),
    ...extra,
  });
}

// ===== トークンの桁数と価格 =====
async function loadTokenDecimals(chain) {
  const known = getKnownTokens(chain);
  const needed = new Set();
  for (const kind of [KIND_V2, KIND_V3]) {
    for (const pool of getPoolsByKind(chain, kind)) {
      for (const t of [pool.token0, pool.token1]) {
        if (known[t] || getTokenDecimals(chain, t) != null) continue;
        needed.add(t);
      }
    }
  }
  for (const [address, info] of Object.entries(known)) {
    setTokenDecimals(chain, address, info.decimals);
  }
  if (needed.size === 0) return 0;
  const found = await fetchTokenDecimalsBatch(chain, [...needed]);
  for (const [address, decimals] of found) setTokenDecimals(chain, address, decimals);
  return found.size;
}

/// 価格を何回まで隣へ辿るか。1回目は「すでに価格が分かっている通貨と
/// 直結したトークン」、2回目はその隣、と広がる。
const PRICE_HOPS = parseInt(process.env.PRICE_HOPS || "4", 10);

/// V3プールの「仮想準備量」。
///
/// V3は価格帯ごとに流動性が分かれているため、実際の残高は価格の比率を
/// 表さない。代わりに現在の価格帯での仮想準備量 (L/√P, L·√P) を使う。
/// この2つの比を取ると現在価格そのものになり、また現在の価格帯の内側では
/// x·y=k と同じように動くので、深さの目安としても使える。
/// 価格帯が狭いプールでは深さを多めに見積もるが、その分は
/// MIN_PRICE_SOURCE_USD の下限で落とす。
function v3VirtualReserves(pool) {
  const sqrt = Number(pool.sqrtPriceX96) / Number(2n ** 96n);
  const liquidity = Number(pool.liquidity);
  if (!isFinite(sqrt) || sqrt <= 0) return null;
  if (!isFinite(liquidity) || liquidity <= 0) return null;
  return { raw0: liquidity / sqrt, raw1: liquidity * sqrt };
}

/// そのトークンのUSD価格を、隣のプールから逆算する。
///
/// [2026年9月18日に広げた。それまで始点が少なかった原因]
/// 以前は「安定通貨と直結したV2プール」しか見ていなかった。そのため
///   ① V3にしかないトークン(チェーンによっては活動の97%がV3)
///   ② 安定通貨と直接のプールが無いトークン(WETH経由など)
/// が丸ごと価格不明になり、始点から外れていた。始点に使えるかは
/// 「桁数と価格が分かるか」だけで決まるので、これがそのまま
/// 「狙える範囲の狭さ」になっていた。
///
/// 今は相手が安定通貨でなくても、**その周で価格が確定した通貨**なら
/// 起点にする。V3プールの現在価格も使う。呼び出し側が数回まわすので
/// 安定通貨 → WETH → その隣、と順に広がる。
///
/// RPCは使わない。全てメモリ上の地図の値だけで求める。
///
/// @param priceOf その周で確定した価格を返す関数(前の周の値は使わない)
function derivePriceFromPools(chain, token, priceOf) {
  const decimals = getTokenDecimals(chain, token);
  if (decimals == null) return null;
  let best = null, bestDepthUsd = 0;
  for (const pool of getPoolsForToken(chain, token)) {
    if (!hasUsableState(pool)) continue;
    const isToken0 = pool.token0 === token;
    const other = isToken0 ? pool.token1 : pool.token0;
    if (other === token) continue;
    const otherPrice = priceOf(other);
    if (!otherPrice) continue;
    const otherDecimals = getTokenDecimals(chain, other);
    if (otherDecimals == null) continue;

    let rawToken, rawOther;
    if (pool.kind === KIND_V3) {
      const v = v3VirtualReserves(pool);
      if (!v) continue;
      rawToken = isToken0 ? v.raw0 : v.raw1;
      rawOther = isToken0 ? v.raw1 : v.raw0;
    } else {
      rawToken = Number(isToken0 ? pool.raw0 : pool.raw1);
      rawOther = Number(isToken0 ? pool.raw1 : pool.raw0);
    }
    const tokenAmount = rawToken / Math.pow(10, decimals);
    const otherAmount = rawOther / Math.pow(10, otherDecimals);
    if (!(tokenAmount > 0) || !(otherAmount > 0)) continue;

    // 深さは「相手側の価値」で測る。薄いプールの価格は当てにならないうえ、
    // 価格を間違えると投入額の計算ごと狂うので、下限は必ず掛ける。
    const depthUsd = otherAmount * otherPrice;
    if (depthUsd < MIN_PRICE_SOURCE_USD) continue;

    const price = depthUsd / tokenAmount;
    if (!isFinite(price) || price <= 0) continue;
    // 同じトークンに複数の経路がある場合は、いちばん深いプールを採る。
    if (depthUsd > bestDepthUsd) { bestDepthUsd = depthUsd; best = price; }
  }
  return best;
}

/// 全チェーンのトークン価格を作り直し、始点に使える通貨を登録する。
///
/// [毎回ゼロから作り直す理由(2026年9月18日)]
/// 以前は「まだ価格が無いトークンだけ」を埋めていたため、一度付いた価格は
/// 二度と更新されなかった。価格は投入額の計算と利益のUSD換算の両方に
/// 使うので、古いままだとガス代とのハードル比較がその分ずれる。
/// 計算はメモリ上だけで完結しRPCを使わないので、毎回作り直す。
function refreshTokenPrices() {
  clearUsableStarts();
  let priced = 0;
  for (const chain of Object.keys(CHAIN_CONFIG)) {
    // その周で確定した価格。前の周の値を混ぜると、古い価格が
    // いつまでも残り続けるので分けて持つ。
    const next = new Map();
    const priceOf = (token) => next.get(token) ?? null;

    for (const [address, info] of Object.entries(getKnownTokens(chain))) {
      setTokenDecimals(chain, address, info.decimals);
      if (info.stable) next.set(address, 1);
    }
    // 価格の起点。安定通貨から辿れないトークンのために、
    // よく使う通貨の目安値も起点に入れる(辿れるなら上書きされる)。
    for (const [address, info] of Object.entries(getKnownTokens(chain))) {
      if (next.has(address) || !info.priceHintUsd) continue;
      next.set(address, info.priceHintUsd);
    }

    for (let hop = 0; hop < PRICE_HOPS; hop++) {
      const found = [];
      for (const kind of [KIND_V2, KIND_V3]) {
        for (const pool of getPoolsByKind(chain, kind)) {
          for (const token of [pool.token0, pool.token1]) {
            if (next.has(token)) continue;
            const price = derivePriceFromPools(chain, token, priceOf);
            if (price) found.push([token, price]);
          }
        }
      }
      if (found.length === 0) break; // これ以上は広がらない
      for (const [token, price] of found) if (!next.has(token)) next.set(token, price);
    }

    for (const [token, price] of next) setTokenPriceUsd(chain, token, price);

    const seen = new Set();
    for (const kind of [KIND_V2, KIND_V3]) {
      for (const pool of getPoolsByKind(chain, kind)) {
        for (const token of [pool.token0, pool.token1]) {
          if (seen.has(token)) continue;
          seen.add(token);
          if (getTokenDecimals(chain, token) == null) continue;
          if (!next.has(token)) continue;
          markUsableStart(chain, token);
          priced++;
        }
      }
    }
  }
  stats.pricedTokens = priced;
  return priced;
}

// ===== V3の価格表 =====
// 公式Quoterに代表的な投入額を問い合わせ、結果を表として保持する。
// 判定はこの表から補間するため、RPCを使わずミリ秒で済み、誤差もない。

const quoteRebuildQueue = new Set(); // "chain::pool" 作り直しが必要なプール

function queueQuoteRebuild(chain, address) {
  quoteRebuildQueue.add(poolKeyOf(chain, address));
}

/// 指定した投入額(USD)を、そのトークンの生の整数に直す。
function usdToAmount(chain, token, usd) {
  const decimals = getTokenDecimals(chain, token);
  const priceUsd = getTokenPriceUsd(chain, token);
  if (decimals == null || !priceUsd) return null;
  const amount = usd / priceUsd;
  try {
    const [intPart, fracPart = ""] = amount.toFixed(Math.min(decimals, 18)).split(".");
    const v = BigInt(intPart + fracPart.padEnd(decimals, "0").slice(0, decimals));
    return v > 0n ? v : null;
  } catch (e) { return null; }
}

/// 1つのV3プールについて、両方向の価格表の「作り方」を用意する(RPCは使わない)。
function quoteJobsForPool(pool) {
  const chain = pool.chain;
  const jobs = [];
  for (const zeroForOne of [true, false]) {
    const tokenIn = zeroForOne ? pool.token0 : pool.token1;
    const tokenOut = zeroForOne ? pool.token1 : pool.token0;
    const amountsIn = [];
    for (const usd of QUOTE_SAMPLES_USD) {
      const amount = usdToAmount(chain, tokenIn, usd);
      if (amount) amountsIn.push(amount);
    }
    if (amountsIn.length === 0) continue;
    // フォークのプールは公式Quoterでは正しく見積もれないので、その旨を渡す。
    jobs.push({
      pool: pool.address, zeroForOne, tokenIn, tokenOut,
      feeTier: pool.feeTier, amountsIn, fork: isForkFactory(chain, pool.factory),
    });
  }
  return jobs;
}

/// 複数のV3プールの価格表を、チェーンごとにまとめて作る。
async function buildTablesForPools(pools) {
  const byChain = new Map();
  for (const pool of pools) {
    const jobs = quoteJobsForPool(pool);
    if (jobs.length === 0) continue;
    if (!byChain.has(pool.chain)) byChain.set(pool.chain, []);
    byChain.get(pool.chain).push(...jobs);
  }
  let built = 0;
  await Promise.all([...byChain.entries()].map(async ([chain, jobs]) => {
    try { built += await buildQuoteTablesBatch(chain, jobs); } catch (e) {}
  }));
  // 表を作れたプールは、その時点の価格を基準として覚える。
  // 以降の作り直しは、ここからの累積のズレで判断する。
  for (const pool of pools) {
    if (hasQuoteTable(pool.chain, pool.address, true) || hasQuoteTable(pool.chain, pool.address, false)) {
      markQuoteBase(pool.chain, pool.address);
    }
  }
  return built;
}

let quoteCursor = 0;
let quoteRefreshRunning = false;
async function refreshQuoteTables() {
  if (!anyReady() || quoteRefreshRunning) return;
  quoteRefreshRunning = true;
  try {
    const selected = [];

    // 価格が動いたプールを優先して作り直す。
    //
    // 作り直せる本数は1回あたり QUOTE_TABLE_PER_TICK に限られるので、
    // 待ち行列の先頭から取るのではなく、**ズレの大きい順**に処理する。
    // 限られた枠を、いちばん誤差が出ているプールに使うため。
    const urgent = [...quoteRebuildQueue]
      .map((key) => {
        const [chain, address] = key.split("::");
        return { key, pool: disabledPools.has(key) ? null : getPool(chain, address) };
      })
      .filter((x) => x.pool && x.pool.kind === KIND_V3)
      .sort((a, b) => (b.pool.quoteDriftPct || 0) - (a.pool.quoteDriftPct || 0))
      .slice(0, QUOTE_TABLE_PER_TICK);
    for (const { key, pool } of urgent) {
      quoteRebuildQueue.delete(key);
      selected.push(pool);
    }
    // 対象外(無効化済みなど)は待ち行列から外しておく。
    for (const key of [...quoteRebuildQueue]) {
      if (disabledPools.has(key)) quoteRebuildQueue.delete(key);
    }

    // 残り枠で、表がまだ無いプール(破棄された表を含む)を順に埋める。
    const budget = QUOTE_TABLE_PER_TICK - urgent.length;
    if (budget > 0) {
      const targets = [];
      for (const chain of chainReady) {
        for (const pool of getPoolsByKind(chain, KIND_V3)) {
          if (disabledPools.has(poolKeyOf(chain, pool.address))) continue;
          if (!hasUsableState(pool)) continue;
          const done = hasQuoteTable(chain, pool.address, true) && hasQuoteTable(chain, pool.address, false);
          if (!done) targets.push(pool);
        }
      }
      stats.quoteTablesPending = targets.length + quoteRebuildQueue.size;
      for (let i = 0; i < Math.min(budget, targets.length); i++) {
        selected.push(targets[quoteCursor % targets.length]);
        quoteCursor++;
      }
    } else {
      stats.quoteTablesPending = quoteRebuildQueue.size;
    }

    if (selected.length === 0) return;
    stats.quoteTablesBuilt += await buildTablesForPools(selected);
  } finally {
    quoteRefreshRunning = false;
  }
}

/// 価格表の補間が公式Quoterとどれだけ一致するかを確かめる。
let v3VerifyCursor = 0;
/// 見積もりの誤差を測る投入額(USD)。
///
/// [なぜ複数の額で測るか]
/// 以前は$20だけで測っていた。価格表の点は $1,3,10,30,100,300,1000,2000 で、
/// $20は「$10〜$30」という狭い区間にあり、補間の誤差が最も小さい場所だった。
/// 一方、実際に赤字と確定した取引は $102 と $276、つまり「$100〜$300」という
/// 広い区間にある。**いちばん簡単な点だけを測っていた。**
/// 区間の広さごとに誤差がどう変わるかを見るため、複数の額で測る。
const VERIFY_AMOUNTS_USD = (process.env.VERIFY_AMOUNTS_USD || "20,200,700")
  .split(",").map((v) => parseFloat(v.trim())).filter((v) => v > 0);

/// 投入額ごとの誤差(bps)。狙う利幅は5〜50bpsなので、%ではなくbpsで見る。
const verifyErrorByUsd = new Map(); // usd -> { count, sumAbsBps, worstBps, overCount }

export function getVerifyErrorStats() {
  const out = [];
  for (const usd of VERIFY_AMOUNTS_USD) {
    const e = verifyErrorByUsd.get(usd);
    if (!e || !e.count) continue;
    out.push({
      usd,
      count: e.count,
      avgAbsBps: e.sumAbsBps / e.count,
      worstBps: e.worstBps,
      overRate: e.overCount / e.count,
    });
  }
  return out;
}

async function verifyV3Calculations() {
  if (!anyReady()) return;
  const candidates = [];
  for (const chain of chainReady) {
    for (const pool of getPoolsByKind(chain, KIND_V3)) {
      if (disabledPools.has(poolKeyOf(chain, pool.address))) continue;
      if (!hasQuoteTable(chain, pool.address, true)) continue;
      // フォークのプールは公式Quoterで引けないため、この検証の対象外にする。
      if (isForkFactory(chain, pool.factory)) continue;
      candidates.push(pool);
    }
  }
  if (candidates.length === 0) return;
  const pool = candidates[v3VerifyCursor % candidates.length];
  v3VerifyCursor++;

  for (const usd of VERIFY_AMOUNTS_USD) {
    // 表の点そのものではなく、点と点の間の値で確かめる。
    const amountIn = usdToAmount(pool.chain, pool.token0, usd);
    if (!amountIn) continue;

    let result;
    try {
      result = await verifyQuoteTable({
        chain: pool.chain, pool: pool.address, zeroForOne: true,
        tokenIn: pool.token0, tokenOut: pool.token1, feeTier: pool.feeTier, amountIn,
      });
    } catch (e) { continue; }
    // 流動性が足りず公式Quoterが失敗した場合は測れない。その額は飛ばす。
    if (!result) continue;

    const bps = result.diffPercent * 100;
    if (!verifyErrorByUsd.has(usd)) {
      verifyErrorByUsd.set(usd, { count: 0, sumAbsBps: 0, worstBps: 0, overCount: 0 });
    }
    const e = verifyErrorByUsd.get(usd);
    e.count++;
    e.sumAbsBps += Math.abs(bps);
    if (Math.abs(bps) > Math.abs(e.worstBps)) e.worstBps = bps;
    if (bps > 0) e.overCount++; // 補間が公式より過大だった回数

    stats.v3VerifyCount++;
    const entry = {
      chain: pool.chain, address: pool.address, dexId: pool.dexId,
      feeBps: pool.feeBps, diffPercent: result.diffPercent, tradeUsd: usd,
      at: new Date().toISOString(),
    };
    stats.v3VerifyRecent = [entry, ...stats.v3VerifyRecent].slice(0, 10);
    if (!stats.v3VerifyWorst || Math.abs(result.diffPercent) > Math.abs(stats.v3VerifyWorst.diffPercent)) {
      stats.v3VerifyWorst = entry;
    }
    // 閾値は1%(100bps)では粗すぎた。狙う利幅が5〜50bpsなので20bpsで出す。
    if (Math.abs(bps) > 20) {
      console.log(`[V3検証] ${pool.chain} ${pool.address.slice(0, 10)}…(${(pool.feeBps / 100).toFixed(2)}%) 投入$${usd}: 補間が公式より${bps > 0 ? "過大" : "過小"}${Math.abs(bps).toFixed(1)}bps`);
    }
  }
}

// ===== V3プールの発見と状態 =====
// Algebra系のプールは手数料が動的なので、手数料帯という概念を持たない。
// 実際の手数料は見積もり表(quote table)の結果に既に含まれているため、
// ここの値は画面表示と記録に使うだけの目安で、損益の計算には使われない。
const ALGEBRA_DISPLAY_FEE_BPS = 30;

/// 深さを測るために準備量を読むV2プールの上限(1チェーンあたり)。
/// 起動を何分も待たせないための歯止め。
const MAX_DEPTH_PROBE_POOLS = parseInt(process.env.MAX_DEPTH_PROBE_POOLS || "15000", 10);

/// 探索対象を選ぶ前に、V2の準備量を読む。
///
/// [なぜ要るか(2026年9月18日に実測で判明)]
/// 保存済みの地図には準備量が入っていなかったため、読み直した直後は
/// 全プールの準備量が0だった。そのため深さを測れず、
/// 「深さ$50,000以上の追加候補なし」となって探索対象が1件も増えなかった。
/// 地図に準備量を残すようにしたが、既存の保存分には入っていないので、
/// ここで読んで埋める。次回以降は保存済みの値が使えるため、ここは
/// 「まだ準備量を持たないプール」だけになり、自然に減っていく。
///
/// 対象は**片側が手書きの一覧にある通貨**のプールだけ。物差しが無いプールは
/// 深さを測れないので、読んでも意味がない。
async function loadDepthProbeReserves(chain) {
  const known = getKnownTokens(chain);
  const targets = [];
  for (const pool of getPoolsByKind(chain, KIND_V2)) {
    if (pool.raw0 > 0n && pool.raw1 > 0n) continue;
    if (!known[pool.token0] && !known[pool.token1]) continue;
    targets.push(pool.address);
    if (targets.length >= MAX_DEPTH_PROBE_POOLS) break;
  }
  if (targets.length === 0) return 0;

  let loaded = 0;
  const CHUNK = 1000;
  for (let i = 0; i < targets.length; i += CHUNK) {
    const chunk = targets.slice(i, i + CHUNK);
    try {
      const batch = await fetchReservesBatch(chain, chunk.map((a) => ({ address: a })));
      for (const address of chunk) {
        const r = batch.get(address.toLowerCase());
        if (r && r.raw0 > 0n && r.raw1 > 0n) {
          updateReservesFromSync(chain, address, r.raw0, r.raw1);
          loaded++;
        }
      }
    } catch (e) {}
  }
  console.log(`[深さ調査] ${chain}: 手書きの通貨と組むV2プール${targets.length}件を読み、${loaded}件で準備量を得ました`);
  return loaded;
}

/// V3プールを探すトークンの一覧(チェーン別)。絞り込みの前に決める。
const discoveryTokens = new Map();

/// 「どのトークンでV3プールを探すか」を決める。
///
/// [それまでの問題(2026年9月18日に判明)]
/// ここは `Object.keys(getKnownTokens(chain))`、つまり**手書きの4〜7種**
/// だけを見ていた。V2は44,000件も発見しているのに、V3の探索だけが
/// 手書きの一覧に縛られていた。さらに絞り込みが「両トークンがV3プールに
/// あるV2だけ残す」ため、地図に入るトークンがこの一覧に固定され、
/// **始点に使える通貨が18件から動かない**原因になっていた。
///
/// 推測はしない。実際に発見したV2プールの中で、**価格も桁数も分かっている
/// 通貨と組んでいて、その相手側が十分に厚い**トークンを選ぶ。
function pickDiscoveryTokens(chain) {
  const known = getKnownTokens(chain);
  const knownList = Object.keys(known);
  const knownSet = new Set(knownList);

  // 相手側の価値(USD)。手書きの一覧にある通貨だけを物差しに使うので、
  // まだ桁数も価格も分からないトークンでも深さを測れる。
  const valueOf = (token, raw) => {
    const info = known[token];
    if (!info) return 0;
    const price = info.stable ? 1 : info.priceHintUsd;
    if (!price) return 0;
    return (Number(raw) / Math.pow(10, info.decimals)) * price;
  };

  const room = Math.max(0, V3_DISCOVERY_TOKENS - knownList.length);
  const added = rankTokensByDepth(chain, valueOf)
    .filter(([token, usd]) => !knownSet.has(token) && usd >= MIN_DISCOVERY_DEPTH_USD)
    .slice(0, room);

  const list = [...knownList, ...added.map(([token]) => token)];
  discoveryTokens.set(chain, list);
  if (added.length > 0) {
    const top = added.slice(0, 3).map(([t, usd]) => `${t.slice(0, 8)}…($${Math.round(usd).toLocaleString()})`).join(" ");
    console.log(`[探索対象] ${chain}: 手書き${knownList.length}種 + V2で深いトークン${added.length}種 = ${list.length}種でV3プールを探します(上位: ${top})`);
  } else {
    console.log(`[探索対象] ${chain}: 手書き${knownList.length}種のみ(深さ$${MIN_DISCOVERY_DEPTH_USD.toLocaleString()}以上の追加候補なし)`);
  }
  return list;
}

async function discoverV3PoolsForChain(chain) {
  // フォークのファクトリーは ENABLE_FORK_QUOTER に入れたチェーンでのみ対象になる。
  const factories = activeV3Factories(chain);
  if (factories.length === 0) return 0;
  const tokens = discoveryTokens.get(chain) || Object.keys(getKnownTokens(chain));
  if (tokens.length < 2) return 0;

  const pairs = [];
  for (let i = 0; i < tokens.length; i++) {
    for (let j = i + 1; j < tokens.length; j++) pairs.push([tokens[i], tokens[j]]);
  }

  let found = 0;
  for (const factory of factories) {
    // Algebra系は手数料帯の引数を取らないため、ペアごとに1回だけ問い合わせる。
    const feeTiers = factory.style === "algebra" ? [null] : V3_FEE_TIERS;
    const requests = [];
    for (const [tokenA, tokenB] of pairs) {
      for (const feeTier of feeTiers) requests.push({ tokenA, tokenB, feeTier });
    }

    // 1ペアずつRPCを使うと24種で3,588回になる。Multicall3で束ねる。
    let addresses;
    try {
      addresses = await findV3PoolsBatch(chain, factory.address, factory.style, requests);
    } catch (e) {
      console.warn(`[発見] ${chain} ${factory.dexId}: 照会に失敗 ${e.message.slice(0, 60)}`);
      continue;
    }

    let foundHere = 0;
    for (let k = 0; k < requests.length; k++) {
      const address = addresses[k];
      if (!address) continue;
      if (isKnownIncompatiblePool(chain, address)) continue;
      const { tokenA, tokenB, feeTier } = requests[k];
      const [t0, t1] = [tokenA.toLowerCase(), tokenB.toLowerCase()].sort();
      registerPool({
        chain, address, dexId: factory.dexId, factory: factory.address, kind: KIND_V3,
        token0: t0, token1: t1, feeTier,
        feeBps: feeTier == null ? ALGEBRA_DISPLAY_FEE_BPS : feeTierToBps(feeTier),
      });
      foundHere++;
    }
    // フォークは住所も呼び出し方式も未検証なので、件数を出して正否が分かるようにする。
    // 0件が続く場合はアドレスか style(uniswap / algebra)の指定が誤っている。
    if (factory.fork) {
      console.log(`[発見] ${chain} ${factory.dexId}(${factory.style}): V3プール${foundHere}件`);
    }
    found += foundHere;
  }
  return found;
}

/// 探索対象を広げると、作られただけで中身が空のV3プールも見つかる。
/// これを地図に残すと購読枠と受信を消費するだけなので、起動時の読み取りで
/// 状態が取れなかったものは外す。
/// ただし読み取りがまとめて失敗した場合(RPCの不調)に地図を壊さないよう、
/// 失敗が半分を超えたときは何も外さない。
const V3_EMPTY_DROP_MAX_RATIO = 0.5;

async function loadV3StatesForChain(chain) {
  const pools = getPoolsByKind(chain, KIND_V3).filter((p) => !disabledPools.has(poolKeyOf(chain, p.address)));
  if (pools.length === 0) return { loaded: 0, dropped: 0 };
  let states;
  try {
    states = await fetchV3StatesBatch(chain, pools.map((p) => p.address));
  } catch (e) {
    return { loaded: 0, dropped: 0 };
  }
  let loaded = 0;
  const empty = [];
  for (const pool of pools) {
    const s = states.get(pool.address.toLowerCase());
    if (!s) { empty.push(pool.address); continue; }
    updateV3FromSwap(chain, pool.address, s.sqrtPriceX96, s.liquidity);
    if (!hasUsableState(getPool(chain, pool.address))) { empty.push(pool.address); continue; }
    loaded++;
  }
  let dropped = 0;
  if (empty.length > 0 && empty.length <= pools.length * V3_EMPTY_DROP_MAX_RATIO) {
    for (const address of empty) { removePool(chain, address); dropped++; }
  }
  return { loaded, dropped };
}

const v3NeedsRefresh = new Set();
let v3RefreshCursor = 0;
let v3RefreshRunning = false;
async function refreshV3States() {
  if (!anyReady() || v3RefreshRunning) return;
  v3RefreshRunning = true;
  try {
    const urgentByChain = new Map();
    const normalByChain = new Map();
    const push = (map, chain, address) => {
      if (!map.has(chain)) map.set(chain, []);
      map.get(chain).push(address);
    };

    // 流動性が変わったプールを優先する。
    const urgentKeys = [...v3NeedsRefresh].slice(0, V3_REFRESH_PER_TICK);
    for (const key of urgentKeys) {
      v3NeedsRefresh.delete(key);
      if (disabledPools.has(key)) continue;
      const [chain, address] = key.split("::");
      push(urgentByChain, chain, address);
    }

    // 残り枠で、WebSocketが無い(または不達の)チェーンのV3を順に読み直す。
    const budget = V3_REFRESH_PER_TICK - urgentKeys.length;
    if (budget > 0) {
      const targets = [];
      for (const chain of chainReady) {
        if (isChainWsEnabled(chain) && isChainHealthy(chain)) continue;
        for (const pool of getPoolsByKind(chain, KIND_V3)) {
          if (disabledPools.has(poolKeyOf(chain, pool.address))) continue;
          targets.push(pool);
        }
      }
      for (let n = 0; n < Math.min(budget, targets.length); n++) {
        const pool = targets[v3RefreshCursor % targets.length];
        v3RefreshCursor++;
        push(normalByChain, pool.chain, pool.address);
      }
    }

    const jobs = [];
    for (const [chain, addresses] of urgentByChain) {
      jobs.push((async () => {
        const states = await fetchV3StatesBatch(chain, addresses, true);
        for (const address of addresses) {
          const s = states.get(address.toLowerCase());
          if (!s) continue;
          updateV3FromSwap(chain, address, s.sqrtPriceX96, s.liquidity);
          queueQuoteRebuild(chain, address);
        }
      })());
    }
    for (const [chain, addresses] of normalByChain) {
      jobs.push((async () => {
        const states = await fetchV3StatesBatch(chain, addresses, false);
        for (const address of addresses) {
          const s = states.get(address.toLowerCase());
          if (!s) continue;
          const pool = updateV3FromSwap(chain, address, s.sqrtPriceX96, s.liquidity);
          // 定期読み直しでも、表を作った時からのズレが基準を超えたら作り直す。
          if (pool && (pool.quoteDriftPct || 0) >= QUOTE_REBUILD_MOVE_PCT) {
            queueQuoteRebuild(chain, address);
            stats.quoteRebuildsFromPolling++;
          }
        }
      })());
    }
    await Promise.all(jobs.map((j) => j.catch(() => {})));
  } finally {
    v3RefreshRunning = false;
  }
}

// ===== プール地図 =====
function collectSeedPools() {
  const seedsByChain = {};
  for (const pair of getVerifiedPairs()) {
    if (!CHAIN_CONFIG[pair.chain]) continue;
    if (!seedsByChain[pair.chain]) seedsByChain[pair.chain] = new Map();
    for (const pool of pair.pools) {
      const dexId = (pool.dexId || "unknown").toLowerCase();
      if (!seedsByChain[pair.chain].has(dexId)) seedsByChain[pair.chain].set(dexId, pool.address);
    }
  }
  return seedsByChain;
}

const knownFactories = new Set();

async function buildPoolMapFromFactories() {
  const seedsByChain = collectSeedPools();
  const totalSeeds = Object.values(seedsByChain).reduce((s, m) => s + m.size, 0);
  if (totalSeeds === 0) return;
  console.log(`[プール地図] 種プール${totalSeeds}件からファクトリーを逆算します`);
  for (const [chain, dexMap] of Object.entries(seedsByChain)) {
    for (const [dexId, address] of dexMap.entries()) {
      try {
        const factory = await discoverFactory(chain, address);
        if (!factory) continue;
        const fkey = `${chain}::${factory.toLowerCase()}`;
        if (knownFactories.has(fkey)) continue;
        knownFactories.add(fkey);
        const pools = await discoverPoolsFromFactory(chain, factory, dexId);
        for (const p of pools) {
          if (isKnownIncompatiblePool(chain, p.address)) continue;
          registerPool({ ...p, kind: KIND_V2 });
        }
      } catch (e) {
        console.warn(`[プール発見] ${dexId} on ${chain}: 失敗 ${e.message.slice(0, 70)}`);
      }
    }
  }
}

async function prepareChain(chain) {
  try {
    // V3の探索は preparePoolMap が絞り込みの前に済ませている。
    const addresses = getAllPoolAddressesByChain(KIND_V2)[chain] || [];
    let loaded = 0;
    const CHUNK = 1000;
    for (let i = 0; i < addresses.length; i += CHUNK) {
      const chunk = addresses.slice(i, i + CHUNK);
      try {
        const batch = await fetchReservesBatch(chain, chunk.map((a) => ({ address: a })));
        for (const address of chunk) {
          const r = batch.get(address.toLowerCase());
          if (r && r.raw0 > 0n && r.raw1 > 0n) {
            updateReservesFromSync(chain, address, r.raw0, r.raw1);
            loaded++;
          }
        }
      } catch (e) {}
    }
    stats.reservesLoaded += loaded;

    const { loaded: v3Loaded, dropped: v3Dropped } = await loadV3StatesForChain(chain);
    const decimalsFound = await loadTokenDecimals(chain);
    stats.decimalsKnown += decimalsFound;

    for (const key of disabledPools) {
      if (!key.startsWith(`${chain}::`)) continue;
      const [, address] = key.split("::");
      clearPoolState(getPool(chain, address));
    }

    const watched = getSubscribedAddresses(chain).filter((a) => !disabledPools.has(poolKeyOf(chain, a)));
    setWatchedAddresses(chain, watched);

    chainReady.add(chain);
    const emptyNote = v3Dropped > 0 ? `(中身が空のV3 ${v3Dropped}件を除外)` : "";
    console.log(`[準備完了] ${chain}: V2 ${loaded}件 / V3 ${v3Loaded}件${emptyNote}、桁数${decimalsFound}トークン、${watched.length}プールを監視します`);
  } catch (e) {
    console.error(`[準備] ${chain}: 失敗 ${e.message.slice(0, 100)}`);
  }
}

async function preparePoolMap() {
  const saved = loadPoolMap();
  let needBuild = saved.count === 0;
  if (saved.count > 0) {
    const ageHours = saved.savedAt ? (Date.now() - new Date(saved.savedAt).getTime()) / 3600000 : 999;
    console.log(`[プール地図] 保存済みを読み込みました: ${saved.count}プール(${ageHours.toFixed(1)}時間前)`);
    stats.mapSource = "保存済み";
    stats.mapSavedAt = saved.savedAt;
    if (ageHours > MAP_REBUILD_AFTER_HOURS) needBuild = true;
  }
  if (needBuild) {
    stats.mapSource = saved.count > 0 ? "保存済み+再構築" : "新規構築";
    await buildPoolMapFromFactories();
  }

  for (const [chain, addresses] of Object.entries(getAllPoolAddressesByChain())) {
    for (const address of addresses) {
      if (isKnownIncompatiblePool(chain, address)) disablePool(chain, address, "過去の記録から復元", true);
    }
  }
  console.log(`[無効化] 過去の記録から${stats.disabledFromFile}件を復元しました`);

  // V3の探索は、絞り込みより**先**に行う。
  //
  // [順番が結果を決める]
  // 絞り込みは「両トークンがV3プールにあるV2だけ残す」。先に絞り込むと、
  // これから探索対象にするトークンのV2プールが、その判断材料ごと
  // 捨てられてしまう。深さの集計にも全体の地図が要る。
  // 深さを測る材料(V2の準備量)を先に揃える。保存済みの地図から戻した直後は
  // 準備量が入っていないことがあるため。
  await Promise.all(Object.keys(CHAIN_CONFIG).map(async (chain) => {
    try { await loadDepthProbeReserves(chain); } catch (e) {}
  }));
  for (const chain of Object.keys(CHAIN_CONFIG)) pickDiscoveryTokens(chain);
  await Promise.all(Object.keys(CHAIN_CONFIG).map(async (chain) => {
    try {
      stats.v3Found += await discoverV3PoolsForChain(chain);
    } catch (e) {
      console.warn(`[探索] ${chain}: 失敗 ${e.message.slice(0, 80)}`);
    }
  }));

  const full = snapshotFullMap();
  const { kept, removed } = pruneToCandidates();
  stats.prunedTotal = removed;
  stats.prunedKept = kept;
  console.log(`[絞り込み] 全${full}プールのうち、裁定候補${kept}プールを残し${removed}プールを監視対象から外しました`);

  const s = getStats();
  console.log(`[プール地図] 候補: V2 ${s.byKind.v2}件 / V3 ${s.byKind.v3}件 / ${s.arbitragablePairs}ペア(うちV2とV3が共存${s.mixedPairs}件)`);

  await Promise.all(Object.keys(CHAIN_CONFIG).map((chain) => prepareChain(chain)));

  const priced = refreshTokenPrices();
  console.log(`[始点] 桁数と価格が揃い、経路の始点として使えるトークン: ${priced}件`);
  console.log(`[V3価格表] 公式Quoterで作成を開始します(V3プール${s.byKind.v3}件 × 2方向、まとめて問い合わせ)`);

  savePoolMap();
  stats.mapSavedAt = new Date().toISOString();
}

// ===== V2の手数料の実測 =====
let feeProbeQueue = [];
async function probeFeesGradually() {
  if (!anyReady()) return;
  if (feeProbeQueue.length === 0) {
    const pending = [];
    const seen = new Set();
    for (const entry of getArbitragablePairs()) {
      if (!isReady(entry.chain)) continue;
      for (const p of entry.pools) {
        if (p.kind === KIND_V3 || p.feeProbed) continue;
        // 再試行待ちのプールを積み直しても、RPCを呼ばずに null が返るだけで
        // 何も進まない。積むとキューが空にならず、同じログが毎秒出続ける。
        if (isFeeProbeOnHold(p.chain, p.address)) continue;
        const key = poolKeyOf(p.chain, p.address);
        if (disabledPools.has(key) || seen.has(key)) continue;
        seen.add(key);
        pending.push({ chain: p.chain, address: p.address });
      }
    }
    feeProbeQueue = pending;
    stats.feeProbePending = feeProbeQueue.length;
    if (feeProbeQueue.length === 0) return;
    console.log(`[手数料実測] 裁定候補のうち未実測${feeProbeQueue.length}プールを確認します`);
  }
  const batch = feeProbeQueue.splice(0, FEE_PROBE_PER_TICK);
  stats.feeProbePending = feeProbeQueue.length;
  await Promise.all(batch.map(async ({ chain, address }) => {
    const pool = getPool(chain, address);
    if (!pool) return;
    try {
      const fee = await probePoolFeeBps({ chain, pairAddress: address, tokenInAddress: pool.token0, reserveIn: pool.raw0, reserveOut: pool.raw1 });
      if (fee != null) {
        if (fee !== 30) setPoolFee(chain, address, fee);
        pool.feeProbed = true;
        stats.feeProbed++;
        if (fee > TAX_TOKEN_FEE_BPS) {
          stats.taxTokensRejected++;
          disablePool(chain, address, `実測手数料${fee}bps(税トークン)`);
        }
      }
    } catch (e) {}
  }));
}

// ===== 機会が見つかった時の処理 =====
/// 同じ経路を二重に送らないための印(経路ごと)。
const executing = new Set();

/// 送信中のチェーン。同じチェーンでは一度に1件だけ送る。
///
/// [なぜ要るか(2026年9月17日に実測)]
/// 経路ごとの executing だけでは、別の経路どうしが並行して走れてしまう。
/// WebSocketのイベントから呼ぶ経路(reactToPoolChange)は await していないため、
/// 同じミリ秒に2件が送信に入ることが実際に起きた。両方が pending の nonce を
/// 取るので同じ番号になり、片方が "replacement fee too low" で拒否され、
/// もう片方も revert した。粗利$0.4155の機会を丸ごと失っている。
///
/// [待たずに見送る理由]
/// 裁定の機会は数秒で消える。ロックが空くまで待ってから送ると、その時には
/// 状態が変わっていて simulateRoute で赤字になるだけ。次のイベントで
/// 同じ機会が改めて検知されるので、ここでは見送る方が無駄がない。
const sendingChains = new Set();
async function handleOpportunity(opp, meta = {}) {
  stats.examined++;
  if (hasDisabledPool(opp)) { reasons.disabled++; return; }
  if (pruneTaxTokenPools(opp)) { reasons.taxToken++; record(opp, "tax_token"); return; }

  const key = opp.poolAddresses.join("|").toLowerCase();
  const until = cooldownUntil.get(key);
  if (until && Date.now() < until) { reasons.cooldown++; stats.skippedCooldown++; return; }

  if (rejectIfTrap(opp)) { reasons.trap++; record(opp, "trap"); return; }
  if (!opp.profitable) return;

  stats.profitableFound++;
  if (opp.hasV3) stats.v3Opportunities++;
  stats.lastOpportunity = new Date().toISOString();
  stats.recent = [{ ...opp, at: new Date().toISOString(), ...meta }, ...stats.recent.filter((r) => r.label !== opp.label)].slice(0, 20);

  if (opp.netProfitUsd < MIN_PROFIT_USD) { reasons.belowMin++; record(opp, "below_min", meta); return; }
  if (executing.has(key)) { reasons.executing++; return; }
  // 同じチェーンで別の送信が進行中なら見送る(nonceの取り合いを防ぐ)。
  if (sendingChains.has(opp.chain)) { reasons.sendBusy++; return; }
  executing.add(key);
  sendingChains.add(opp.chain);
  try {
    console.log(`[機会] ${opp.kind} ${opp.chain} ${opp.label}: 純利益+$${opp.netProfitUsd.toFixed(4)}(投入$${opp.tradeAmountUsd.toFixed(2)} 壁${opp.feeWallPercent.toFixed(2)}%${opp.hasV3 ? " V3含む" : ""})`);
    const ok = await Promise.race([
      executeOpportunity(opp),
      new Promise((_, reject) => setTimeout(() => reject(new ExecutionError("実行が制限時間を超えました", { stage: "timeout" })), EXECUTION_TIMEOUT_MS)),
    ]);
    if (ok) {
      stats.executed++; reasons.success++;
      cooldownUntil.delete(key);
      record(opp, "success", meta);
    } else {
      reasons.notSent++;
      cooldownUntil.set(key, Date.now() + 30 * 1000);
      record(opp, "not_sent", meta);
    }
  } catch (e) {
    stats.failed++; reasons.failed++;
    const msg = (e.message || "").slice(0, 120);
    const stage = e instanceof ExecutionError ? e.stage : "unknown";
    console.warn(`[実行] 失敗(${stage}): ${msg}`);
    noteExecutionFailure(opp, e);
    record(opp, "failed", { ...meta, error: msg, stage });
  } finally {
    executing.delete(key);
    sendingChains.delete(opp.chain);
  }
}

function reactToPoolChange(chain, poolAddress, pool, receivedAt, source) {
  if (!isReady(chain)) return;
  const movePct = pool.lastMovePct || 0;
  if (movePct >= BIG_MOVE_PCT) stats.bigMoves++;
  try {
    const opp = scanForChangedPool({
      chain, poolAddress, capUsd: getCurrentTradeCapUsd(),
      gasCostUsd: getGasCost(chain, "2step"), gasCostUsd3: getGasCost(chain, "3step"), isBorrowable,
    });
    const latency = Date.now() - receivedAt;
    stats.latencies.push(latency);
    if (stats.latencies.length > 200) stats.latencies.shift();
    if (opp) handleOpportunity(opp, { source, movePct }).catch(() => {});
  } catch (e) {}
}

function handleSync(chain, poolAddress, reserve0, reserve1, receivedAt) {
  if (disabledPools.has(poolKeyOf(chain, poolAddress))) return false;
  const pool = updateReservesFromSync(chain, poolAddress, reserve0, reserve1);
  if (!pool) { stats.syncUnknown++; return false; }
  stats.syncMatched++;
  reactToPoolChange(chain, poolAddress, pool, receivedAt, "sync");
  return true;
}

function handleV3Swap(chain, poolAddress, sqrtPriceX96, liquidity, receivedAt) {
  if (disabledPools.has(poolKeyOf(chain, poolAddress))) return false;
  const pool = updateV3FromSwap(chain, poolAddress, sqrtPriceX96, liquidity);
  if (!pool) return false;
  stats.v3Matched++;
  // 表を作った時からのズレが基準を超えたら作り直す。
  // 1回ぶんの変化ではなく累積で見る(小さな変化が積み重なる場合を拾うため)。
  if ((pool.quoteDriftPct || 0) >= QUOTE_REBUILD_MOVE_PCT) queueQuoteRebuild(chain, poolAddress);
  reactToPoolChange(chain, poolAddress, pool, receivedAt, "v3swap");
  return true;
}

function handleV3Liquidity(chain, poolAddress) {
  const key = poolKeyOf(chain, poolAddress);
  if (disabledPools.has(key)) return false;
  const pool = getPool(chain, poolAddress);
  if (!pool || pool.kind !== KIND_V3) return false;
  stats.v3LiquidityEvents++;
  v3NeedsRefresh.add(key);
  queueQuoteRebuild(chain, poolAddress);
  return true;
}

// ===== 全件スキャン =====
let fullScanRunning = false;
async function fullScanOnce() {
  if (fullScanRunning || !anyReady()) return;
  fullScanRunning = true;
  try {
    for (const chain of chainReady) {
      const opportunities = scanAllPairs({
        chain, capUsd: getCurrentTradeCapUsd(),
        gasCostUsd: getGasCost(chain, "2step"), gasCostUsd3: getGasCost(chain, "3step"), isBorrowable,
      });
      for (const opp of opportunities.slice(0, 3)) await handleOpportunity(opp, { source: "scan" });
    }
    stats.scans++;
  } catch (e) {
    console.error(`[全件スキャン] エラー: ${e.message.slice(0, 100)}`);
  } finally {
    fullScanRunning = false;
  }
}

// ===== V2準備量の読み直し =====
let refreshRunning = false;
async function refreshStaleReserves() {
  if (refreshRunning || !anyReady()) return;
  refreshRunning = true;
  try {
    for (const chain of chainReady) {
      if (isChainWsEnabled(chain) && isChainHealthy(chain)) continue;
      const stale = getStalePools(chain, REFRESH_STALE_SEC * 1000, KIND_V2)
        .filter((p) => !disabledPools.has(poolKeyOf(chain, p.address)))
        .slice(0, REFRESH_BATCH_SIZE);
      if (stale.length === 0) continue;
      const batch = await fetchReservesBatch(chain, stale.map((p) => ({ address: p.address })));
      for (const pool of stale) {
        const r = batch.get(pool.address.toLowerCase());
        if (r) updateReservesFromSync(chain, pool.address, r.raw0, r.raw1);
      }
    }
    stats.refreshCycles++;
  } catch (e) {
  } finally {
    refreshRunning = false;
  }
}

// ===== コントラクトに溜まった利益 =====
const BALANCE_ABI = ["function balancesOf(address[] tokens) view returns (uint256[])"];
let contractBalances = {};
async function refreshContractBalances() {
  if (!anyReady()) return;
  const out = {};
  for (const [chain, config] of Object.entries(CHAIN_CONFIG)) {
    const address = process.env[config.contractAddressEnvVar];
    if (!address) continue;
    const tokens = Object.entries(getKnownTokens(chain));
    if (tokens.length === 0) continue;
    try {
      const amounts = await callWithRpc(chain, (p) =>
        new ethers.Contract(address, BALANCE_ABI, p).balancesOf(tokens.map(([a]) => a)));
      const held = [];
      for (let i = 0; i < tokens.length; i++) {
        const [, info] = tokens[i];
        if (amounts[i] > 0n) {
          const amount = Number(amounts[i]) / Math.pow(10, info.decimals);
          const usd = amount * (getTokenPriceUsd(chain, tokens[i][0]) ?? 0);
          held.push({ symbol: info.symbol, amount, usd });
        }
      }
      if (held.length > 0) out[chain] = held;
    } catch (e) {}
  }
  contractBalances = out;
}

// ===== 生存確認 =====
function heartbeat() {
  stats.lastHeartbeat = new Date().toISOString();
  const rpc = getRpcStatus();
  const queued = Object.entries(rpc).filter(([, v]) => v.queued > 0).map(([c, v]) => `${c}:${v.normalQueued}`).join(" ");
  const stageLine = Object.entries(failStages).map(([k, v]) => `${k}:${v}`).join(" ") || "なし";
  const sync = getSyncStats();
  const ev = Object.entries(sync).map(([c, v]) => `${c}:${v.received}`).join(" ") || "なし";
  const mc = getMulticallStats();
  // RPCの月間使用量を更新する。呼び出しとWebSocket受信の両方が枠を消費する。
  // 生存ログは稼働の健全性を見る唯一の手段なので、使用量の計測が失敗しても
  // ログ自体は必ず出るようにする。
  let usageLine = "";
  try {
    const wsEvents = Object.values(sync).reduce((sum, v) => sum + (v.received || 0), 0);
    usageLine = " " + formatRpcUsageLine(updateRpcUsage(getRpcCallTotals().total, wsEvents));
  } catch (e) {
    usageLine = " 枠[計測できず: " + e.message + "]";
  }
  // 価格表は「プール×方向」ごとに要る。分母が無いと揃っているように見えてしまう。
  // V3の段は価格表が無いと使えないので、欠けている分はそのまま経路が組めない。
  let v3Total = 0;
  for (const chain of chainReady) v3Total += getPoolsByKind(chain, KIND_V3).length;
  const rc = getRouteCalcStats();
  console.log(`[生存] 稼働${[...chainReady].join(",") || "なし"} 始点${countUsableStarts()} 価格表${countQuoteTables()}/${v3Total * 2}(待${stats.quoteTablesPending} 定期で作り直し${stats.quoteRebuildsFromPolling}) スキャン${stats.scans} 経路計算${rc.computed.toLocaleString()}→粗利プラス${rc.grossProfitable}(上限張付${rc.hitCap.toLocaleString()}) 精査${stats.examined} 黒字${stats.profitableFound} 実行${stats.executed}/${stats.failed} 内訳[無効${reasons.disabled} 冷却${reasons.cooldown} 罠${reasons.trap} 下限${reasons.belowMin} 送信中${reasons.sendBusy} 見送${reasons.notSent}] 失敗段階[${stageLine}] 受信[${ev}] 手数料${stats.feeProbed}(残${stats.feeProbePending}) 行列[${queued || "空"}] 束ね[${mc.calls}回で${mc.subcalls}件]${usageLine}`);

  // 価格表の鮮度。作り直しが追いついているかを見る。
  // ズレ超過が減らない場合、閾値ではなく作り直しの処理能力
  // (QUOTE_TABLE_PER_TICK)が上限になっている。
  try {
    const parts = [];
    for (const chain of chainReady) {
      const f = getQuoteFreshness(chain, QUOTE_REBUILD_MOVE_PCT);
      if (!f.withBase) continue;
      parts.push(`${chain}:基準${f.withBase}件 ズレ超過${f.stale}件 最大${f.maxDriftBps.toFixed(1)}bps`);
    }
    if (parts.length) console.log(`[価格表の鮮度] ${parts.join(" / ")}(基準${(QUOTE_REBUILD_MOVE_PCT * 100).toFixed(0)}bps)`);
  } catch (e) {}

  // 見積もりの誤差。狙う利幅は5〜50bpsなので、誤差がそれを上回っていれば
  // 「機会」ではなくノイズを拾っていることになる。投入額ごとに出すのは、
  // 価格表の点の間隔が広いほど補間の誤差が大きくなるため。
  try {
    const ve = getVerifyErrorStats();
    if (ve.length) {
      const parts = ve.map((e) =>
        `$${e.usd}:${e.count}件 平均±${e.avgAbsBps.toFixed(1)}bps 最悪${e.worstBps > 0 ? "+" : ""}${e.worstBps.toFixed(1)} 過大${(e.overRate * 100).toFixed(0)}%`
      ).join(" / ");
      console.log(`[見積もり誤差] ${parts}`);
    }
  } catch (e) {}

  // 判定の手前で何件が脱落しているかを出す。スキャンは回っているのに経路が
  // 1本も評価されない状態が続いたため、どの段階で落ちているかを見えるようにする。
  for (const chain of chainReady) {
    try { console.log(formatStateDiagnostics(chain)); } catch (e) {}
  }

  // どれくらい惜しかったかの分布。機会が0件でも「壁さえ低ければ届いていた」
  // のか「そもそも価格が動いていない」のかを区別できるようにする。
  try {
    const W = NEAR_MISS_REACHABLE_WALL_BPS;
    const all = getNearMissStats();
    const near = getNearMissStats(W);
    for (const [chain, d] of Object.entries(all)) {
      if (!d.total) continue;
      const r = near[chain];
      // 件数は「別々の経路の本数」。同じ経路を何度評価しても1本。
      // 壁が高すぎて構造的に黒字にならない経路を除いた分も併記する。
      const head = `経路${d.total.toLocaleString()}本(壁${W}bps以下${(r?.total || 0).toLocaleString()}本)`;
      const parts = r
        ? r.labels.map((l, i) => `${l}:${r.counts[i].toLocaleString()}`).join(" ")
        : "壁の低い経路なし";
      console.log(`[惜しい] ${chain}: ${head} / 壁${W}bps以下の内訳 ${parts} / 壁が${WALL_DROP_BPS}bps下がれば+${countIfWallDrops(chain, WALL_DROP_BPS, W).toLocaleString()}本`);
    }
  } catch (e) {}

  // 「壁が下がっていたら、いくら取れたか」。本数だけでは戦略の上限が
  // 分からないため、ガス代を引いた後の金額で出す。必ず多めに出る
  // (同じ価格差を複数の経路で重複して数えているため)。
  try {
    const wi = getWhatIfProfit();
    for (const [chain, rows] of Object.entries(wi)) {
      const parts = rows.map((r) =>
        `壁-${r.drop}bps:${r.routes.toLocaleString()}本 $${r.totalUsd.toFixed(2)}(最大$${r.maxUsd.toFixed(4)}/投入$${r.maxTradeUsd.toFixed(0)})`
      ).join(" ");
      if (parts) console.log(`[試算] ${chain}: ${parts}`);
    }
  } catch (e) {}
}

// ===== ダッシュボード =====
// iPhoneの縦画面(幅390px前後)で横にはみ出さないことを基準にしている。
// はみ出す原因は2つあった。
//   ① 経路の表示にプールのアドレス(42文字)がそのまま入ることがあり、
//      途中で改行できないため表が画面幅より広く押し広げられていた
//   ② .stat が4列固定で、1枠あたりが狭くなりすぎていた
// table-layout:fixed にすると列幅が中身に引きずられなくなるので、
// 長い文字列が入っても表が広がらない。折り返しは overflow-wrap で行う。
const STYLE = `*{box-sizing:border-box}
body{font-family:-apple-system,sans-serif;background:#0d100c;color:#e8e6d8;margin:0;padding:18px 12px;overflow-x:hidden}
h1{font-size:17px;margin:0 0 4px}h2{font-size:13px;margin:0 0 10px;font-weight:600}
.sub{color:#888;font-size:11px;margin-bottom:16px}
.card{background:#14180f;border:1px solid #2a331d;border-radius:8px;padding:13px;margin-bottom:13px;overflow:hidden}
.card.real{border-color:#2ecc71}
table{width:100%;table-layout:fixed;border-collapse:collapse;font-size:11px}
th{text-align:left;color:#888;font-weight:500;font-size:9.5px;padding:5px 3px;border-bottom:1px solid #2a331d}
td{padding:6px 3px;border-bottom:1px solid #1c1c1c}
th,td{overflow-wrap:anywhere;word-break:break-word}
/* 実際の取引結果。日時と経路に幅を寄せ、右の数字列は詰める */
.t-real th:nth-child(1),.t-real td:nth-child(1){width:21%}
.t-real th:nth-child(2),.t-real td:nth-child(2){width:29%}
.t-real th:nth-child(3),.t-real td:nth-child(3){width:15%}
.t-real th:nth-child(4),.t-real td:nth-child(4){width:24%}
.t-real th:nth-child(5),.t-real td:nth-child(5){width:11%}
/* 連番つきの表(取り逃し・黒字の機会)。#は最小限にし、経路に幅を回す */
.t-num th:nth-child(1),.t-num td:nth-child(1){width:7%}
.t-num th:nth-child(2),.t-num td:nth-child(2){width:33%}
/* 惜しかった分布: 目盛り・棒・件数 */
.t-miss th:nth-child(1),.t-miss td:nth-child(1){width:38%}
.t-miss th:nth-child(3),.t-miss td:nth-child(3){width:22%}
/* 壁を下げた試算 */
.t-whatif th:nth-child(1),.t-whatif td:nth-child(1){width:26%}
.t-whatif th:nth-child(2),.t-whatif td:nth-child(2){width:18%}
/* 2列の表は左を広く */
.t-two th:nth-child(2),.t-two td:nth-child(2){width:32%}
.note{font-size:10px;color:#888;line-height:1.6;margin-top:9px;padding-top:9px;border-top:1px solid #222;overflow-wrap:anywhere}
/* 幅140pxを下限にすると、iPhoneの縦画面では2列×2段に落ちる。
   4列のままだと1枠が約90pxしかなく、金額が数字の途中で折り返してしまう。 */
.stat{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:6px;margin-bottom:13px}
/* 直接の子だけに枠を付ける。.stat div にすると中の .v と .l(どちらもdiv)
   にも枠が付き、枠が二重に見えて縦にも間延びする */
.stat > div{background:#14180f;border:1px solid #2a331d;border-radius:8px;padding:11px 6px;text-align:center;min-width:0;
display:flex;flex-direction:column;justify-content:center;gap:3px}
/* 金額は途中で折り返させない。入り切らない時は字を縮める */
.stat .v{font-size:17px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.stat .l{font-size:9px;color:#888}
a{color:#6fae62}.footerlink{margin-top:18px;font-size:11px}`;

/// 経路の表示を短くする。未知のプールは dexId がアドレスそのものになるため、
/// そのまま出すと42文字が1列を占めて読みづらい。先頭だけ残す。
function shortenLabel(label) {
  return String(label ?? "").replace(/0x[0-9a-fA-F]{40}/g, (m) => `${m.slice(0, 8)}…`);
}

const REASON_LABEL = {
  disabled: "無効化済みのプールを含む", taxToken: "税トークン", cooldown: "冷却中(直近に失敗)",
  trap: "罠または計算の誤差", belowMin: `最低利益$${MIN_PROFIT_USD}未満`, executing: "実行中で重複",
  notSent: "送信条件を満たさず", failed: "送信に失敗", success: "送信成功",
};
const STAGE_LABEL = {
  state: "状態取得に失敗(RPCが遅い)", quote: "受取量の確定に失敗", estimateGas: "ガス見積もりで拒否",
  feeLadder: "手数料を上げても拒否", shortfall: "量が足りず拒否", send: "送信時のエラー", wait: "確定待ちで失敗",
  timeout: "制限時間超過", unknown: "不明",
};

function renderPage() {
  const s = getStats();
  const real = getRealExecutionStats();
  const isLive = process.env.DRY_RUN === "false";
  const lat = stats.latencies.length ? [...stats.latencies].sort((a, b) => a - b)[Math.floor(stats.latencies.length / 2)] : null;
  const syncStats = getSyncStats();
  const rpc = getRpcStatus();
  const gas = getGasCostStatus();
  const hbAge = stats.lastHeartbeat ? Math.round((Date.now() - new Date(stats.lastHeartbeat).getTime()) / 1000) : null;
  const sum = summarize(24);
  const maxQueue = Math.max(0, ...Object.values(rpc).map((v) => v.queued));
  const totalEvents = Object.values(syncStats).reduce((a, v) => a + v.received, 0);
  const mc = getMulticallStats();

  // 記録のガス代と純利益。古い記録は純利益を持たないので粗利から引いて補う。
  const gasOf = (e) => e.actualGasCostUsd ?? e.gasCostUsd ?? null;
  const netOf = (e) => {
    if (e.actualNetProfitUsd != null) return e.actualNetProfitUsd;
    if (e.actualProfitUsd == null) return null;
    return e.actualProfitUsd - (gasOf(e) ?? 0);
  };
  const realRows = real.recent.map((e) => `<tr><td>${new Date(e.timestamp).toLocaleString('ja-JP')}</td><td style="font-size:9px">${shortenLabel(e.pairLabel)}</td>
    <td style="text-align:right">$${e.tradeAmountUsd.toFixed(2)}</td>
    <td style="text-align:right;color:#2ecc71;font-weight:600">${netOf(e) != null ? `+$${netOf(e).toFixed(4)}` : '-'}<br><span style="color:#888;font-weight:400;font-size:9px">粗${e.actualProfitUsd != null ? `$${e.actualProfitUsd.toFixed(4)}` : '-'} ガス${gasOf(e) != null ? `$${gasOf(e).toFixed(4)}` : '-'}</span></td>
    <td><a href="${e.explorerUrl}" target="_blank">確認</a></td></tr>`).join('') || `<tr><td colspan="5" style="color:#888">まだ実際の取引はありません</td></tr>`;

  // 記録簿の outcome を日本語にする。なぜ取れなかったかを一目で読めるように。
  const OUTCOME_LABEL = {
    success: "成功", not_sent: "送信直前に見送り", failed: "送信失敗",
    below_min: "最低利益未満", trap: "罠の疑い", tax_token: "税トークン",
    unprofitable: "赤字", skipped_cooldown: "冷却中", not_profitable_onchain: "実測で赤字",
  };
  const outcomeLine = Object.entries(sum.byOutcome)
    .sort((a, b) => b[1] - a[1])
    .map(([k, n]) => `${OUTCOME_LABEL[k] || k} ${n.toLocaleString()}`)
    .join(' / ') || '記録なし';

  // 黒字と判定したのに取れなかった上位。ここが改善の手がかりになる。
  const missedRows = sum.topMissed.map((m, i) => `<tr><td>${i+1}</td>
    <td style="font-size:9px">${m.kind || ''} ${m.chain || ''}${m.hasV3 ? ' <span style="color:#6fae62">V3</span>' : ''}<br>${shortenLabel(m.label)}</td>
    <td style="font-size:9px">${OUTCOME_LABEL[m.outcome] || m.outcome}${m.shortfallBps != null ? `<br><span style="color:#888">実測${m.shortfallBps.toFixed(1)}bps</span>` : ''}${m.stage ? `<br><span style="color:#888">${m.stage}</span>` : ''}</td>
    <td style="text-align:right">$${(m.tradeAmountUsd ?? 0).toFixed(2)}</td>
    <td style="text-align:right;color:#e8a33d;font-weight:600">+$${(m.netProfitUsd ?? 0).toFixed(4)}</td></tr>`).join('')
    || `<tr><td colspan="5" style="color:#888">取り逃した黒字はありません</td></tr>`;

  const oppRows = stats.recent.slice(0, 10).map((o, i) => `<tr><td>${i+1}</td>
    <td style="font-size:9px">${o.kind} ${o.chain}${o.hasV3 ? ' <span style="color:#6fae62">V3</span>' : ''}<br>${shortenLabel(o.label)}</td>
    <td style="text-align:right">${o.feeWallPercent.toFixed(2)}%</td>
    <td style="text-align:right">$${o.tradeAmountUsd.toFixed(2)}</td>
    <td style="text-align:right;color:#2ecc71;font-weight:600">+$${o.netProfitUsd.toFixed(4)}</td></tr>`).join('') || `<tr><td colspan="5" style="color:#888">まだ黒字の機会が見つかっていません</td></tr>`;

  // 「あと何bpsで黒字だったか」の分布。機会が0件のとき、原因が
  // 「手数料の壁」なのか「そもそも価格が動いていない」のかを見分ける。
  // 件数は「別々の経路の本数」で、同じ経路を何度評価しても1本。
  const W = NEAR_MISS_REACHABLE_WALL_BPS;
  const nmAll = getNearMissStats();
  const nmNear = getNearMissStats(W);
  const walls = getWallBreakdown();

  const barRow = (label, n, scale, color) =>
    `<tr><td>${label}</td>
      <td><div style="background:#222;border-radius:3px;height:8px;width:100%"><div style="background:${color};height:8px;border-radius:3px;width:${Math.min(100, Math.round((n / scale) * 100))}%"></div></div></td>
      <td style="text-align:right">${n.toLocaleString()}</td></tr>`;

  // 「壁が下がっていたら、いくら取れたか」。戦略の上限を見るための試算。
  const whatIf = getWhatIfProfit();
  const whatIfRows = (chain) => {
    const rows = whatIf[chain];
    if (!rows || !rows.length) return '';
    const body = rows.map((r) => `<tr>
      <td>壁 −${r.drop}bps</td>
      <td style="text-align:right">${r.routes.toLocaleString()}本</td>
      <td style="text-align:right;color:${r.totalUsd > 0 ? '#e8a33d' : '#888'};font-weight:600">$${r.totalUsd.toFixed(2)}</td>
      <td style="text-align:right;color:#888">$${r.maxUsd.toFixed(4)}<br><span style="font-size:9px">投入$${r.maxTradeUsd.toFixed(0)}</span></td></tr>`).join('');
    return `<div class="note" style="border-top:none;padding-top:4px">壁が下がっていたら取れた金額(ガス代を引いた後):</div>
<table class="t-whatif"><thead><tr><th></th><th style="text-align:right">経路</th><th style="text-align:right">合計</th><th style="text-align:right">最大の1本</th></tr></thead><tbody>${body}</tbody></table>
<div class="note" style="border-top:none;padding-top:4px;color:#888">合計は<b>必ず多めに出ます</b>。同じ価格差を複数の経路で重複して数えており、実際には1つの価格差は1回しか取れません。自分が取れば価格も動きます。<b>期待できる金額ではなく、この戦略の天井</b>として見てください。</div>`;
  };

  const nearMissBlocks = Object.entries(nmAll).filter(([, d]) => d.total > 0).map(([chain, d]) => {
    const w = walls[chain];
    const wScale = Math.max(...(w ? w.counts : [1]), 1);
    const wallRows = w ? w.labels.map((l, i) =>
      barRow(l, w.counts[i], wScale, i <= 2 ? '#6fae62' : '#555')).join('') : '';

    const r = nmNear[chain];
    if (!r || !r.total) {
      return `<h2 style="margin-top:14px">${chain}</h2>
<div class="note" style="margin-top:0;border-top:none;padding-top:0">経路${d.total.toLocaleString()}本。壁の内訳:</div>
<table class="t-miss"><tbody>${wallRows}</tbody></table>
<div class="note">壁${W}bps以下の経路が1本もありません。手数料の高いプールしか無いため、価格がどれだけ動いても黒字になりません。</div>
${whatIfRows(chain)}`;
    }
    // 棒の目盛りは最下段(-100bps未満)を除いた最大値に合わせる。
    // 大半がそこに入るため、そこを基準にすると判断に使う上の段が潰れて読めない。
    const scale = Math.max(...r.counts.slice(0, -1), 1);
    const rows = r.labels.map((l, i) =>
      barRow(l, r.counts[i], scale, i === 0 ? '#2ecc71' : i <= 3 ? '#e8a33d' : '#555')).join('');
    const gain = countIfWallDrops(chain, WALL_DROP_BPS, W);
    return `<h2 style="margin-top:14px">${chain}</h2>
<div class="note" style="margin-top:0;border-top:none;padding-top:0">経路${d.total.toLocaleString()}本。まず壁の高さの内訳:</div>
<table class="t-miss"><tbody>${wallRows}</tbody></table>
<div class="note" style="border-top:none;padding-top:4px">このうち<b>壁${W}bps以下の${r.total.toLocaleString()}本</b>だけを取り出した、惜しさの分布:</div>
<table class="t-miss"><tbody>${rows}</tbody></table>
<div class="note">壁が${WALL_DROP_BPS}bps下がれば <b style="color:#e8a33d">+${gain.toLocaleString()}本</b> が粗利プラスに変わります(いま粗利プラスは${r.counts[0].toLocaleString()}本)。<br>段をまたぐ分は数えていないので、実際はこれより多くなります。</div>
${whatIfRows(chain)}`;
  }).join('') || '<div class="note" style="color:#888">まだ経路を計算していません</div>';

  const reasonRows = Object.entries(reasons).filter(([, v]) => v > 0).sort((a,b)=>b[1]-a[1]).map(([k, v]) =>
    `<tr><td>${REASON_LABEL[k] || k}</td><td style="text-align:right">${v.toLocaleString()}件</td></tr>`).join('') || `<tr><td colspan="2" style="color:#888">まだ記録がありません</td></tr>`;

  const stageRows = Object.entries(failStages).sort((a,b)=>b[1]-a[1]).map(([k, v]) =>
    `<tr><td>${STAGE_LABEL[k] || k}</td><td style="text-align:right">${v.toLocaleString()}件</td></tr>`).join('') || `<tr><td colspan="2" style="color:#888">送信の失敗はありません</td></tr>`;

  const verifyRows = stats.v3VerifyRecent.map((v) => `<tr>
    <td style="font-size:9px">${v.chain}<br>${v.address.slice(0, 10)}…(${(v.feeBps/100).toFixed(2)}%)</td>
    <td style="text-align:right;color:${Math.abs(v.diffPercent) > 5 ? '#e74c3c' : Math.abs(v.diffPercent) > 1 ? '#e8a33d' : '#2ecc71'}">${v.diffPercent > 0 ? '+' : ''}${v.diffPercent.toFixed(3)}%</td>
    </tr>`).join('') || `<tr><td colspan="2" style="color:#888">まだ検証していません</td></tr>`;

  const balanceLine = Object.entries(contractBalances).map(([c, held]) =>
    `${c}: ${held.map((h) => `${h.symbol} ${h.amount.toFixed(4)}($${h.usd.toFixed(2)})`).join(" / ")}`).join('<br>') || '残高なし';

  const syncLine = Object.entries(syncStats).map(([c, v]) =>
    `${c}: ${v.watched.toLocaleString()}プールを${v.subscriptions}回で購読 / 受信 V2 ${v.v2.toLocaleString()}・V3 ${v.v3.toLocaleString()}・流動性 ${v.liquidity.toLocaleString()} ${v.healthy ? '<span style="color:#2ecc71">正常</span>' : `<span style="color:#e74c3c">不達</span>`}`
  ).join('<br>') || 'WebSocket未設定';

  const gasLine = Object.entries(gas).map(([c, g]) => `${c}: $${g.costUsd}`).join(' / ') || '取得中';
  const readyLine = Object.keys(CHAIN_CONFIG).map((c) => `${c}: ${isReady(c) ? '<span style="color:#2ecc71">稼働中</span>' : '<span style="color:#e8a33d">準備中</span>'}`).join(' / ');
  const startsLine = Object.keys(CHAIN_CONFIG).map((c) => `${c}:${countUsableStarts(c)}`).join(' / ');

  return `<!DOCTYPE html><html lang="ja"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"><meta http-equiv="refresh" content="20">
<title>DEXアービトラージ</title><style>${STYLE}</style></head><body>
<h1>🔍 DEXアービトラージ</h1><div class="sub">フラッシュスワップ方式 / V2 + V3 / ${readyLine}</div>

<div class="card real"><h2>💰 実際の取引結果</h2>
<div class="stat"><div><div class="v">${real.count}</div><div class="l">実行回数</div></div>
<div><div class="v" style="color:#2ecc71">+$${real.totalProfitUsd.toFixed(4)}</div><div class="l">累積利益(ガス控除後)</div></div>
<div><div class="v">$${getCurrentTradeCapUsd()}</div><div class="l">取引上限</div></div>
<div><div class="v" style="color:${isLive?'#2ecc71':'#888'}">${isLive?'稼働中':'停止中'}</div><div class="l">自動売買</div></div></div>
<table class="t-real"><thead><tr><th>日時</th><th>経路</th><th style="text-align:right">投入</th><th style="text-align:right">純利益</th><th></th></tr></thead><tbody>${realRows}</tbody></table>
<div class="note">経路の最初のプール自身から先に受け取るため、借入手数料はかかりません。<br>累計の内訳: 粗利+$${real.totalGrossProfitUsd.toFixed(4)} − ガス代$${real.totalGasCostUsd.toFixed(4)}<br>コントラクトに溜まっている利益: ${balanceLine}</div></div>

<div class="card"><h2>📐 V3の価格表(公式Quoter)</h2>
<div class="stat"><div><div class="v" style="color:#6fae62">${countQuoteTables().toLocaleString()}</div><div class="l">作成済みの表</div></div>
<div><div class="v">${stats.quoteTablesPending.toLocaleString()}</div><div class="l">作成待ち</div></div>
<div><div class="v" style="color:${stats.v3VerifyWorst && Math.abs(stats.v3VerifyWorst.diffPercent) > 5 ? '#e74c3c' : '#2ecc71'}">${stats.v3VerifyWorst ? stats.v3VerifyWorst.diffPercent.toFixed(2) + '%' : '-'}</div><div class="l">補間の最大誤差</div></div>
<div><div class="v">${stats.v3Opportunities}</div><div class="l">V3を含む機会</div></div></div>
<table class="t-two"><thead><tr><th>プール</th><th style="text-align:right">補間と公式の差</th></tr></thead><tbody>${verifyRows}</tbody></table>
<div class="note">V3は価格帯ごとに流動性が分かれるため、独自の近似式では最大2,184%も過大な値になりました。今はプールごとに公式Quoterで「代表的な投入額での受取量」を取得して表にし、判定はそこから補間しています。価格が動いた表は作り直します(WebSocketの無いチェーンでも、定期読み直しで価格の動きを検知して作り直します。これまでに${stats.quoteRebuildsFromPolling}回)。<br>表が無いV3プールは判定に使いません(幻の機会を防ぐため)。</div></div>

<div class="card"><h2>🔎 機会がどこで止まっているか</h2>
<div class="stat"><div><div class="v">${stats.examined.toLocaleString()}</div><div class="l">精査した経路</div></div>
<div><div class="v" style="color:${stats.profitableFound>0?'#2ecc71':'#888'}">${stats.profitableFound}</div><div class="l">黒字と判定</div></div>
<div><div class="v" style="color:${stats.executed>0?'#2ecc71':'#888'}">${stats.executed}</div><div class="l">送信成功</div></div>
<div><div class="v" style="color:${stats.failed>0?'#e74c3c':'#888'}">${stats.failed}</div><div class="l">送信失敗</div></div></div>
<table class="t-two"><thead><tr><th>止まった理由</th><th style="text-align:right">件数</th></tr></thead><tbody>${reasonRows}</tbody></table>
<div class="note"><strong>送信に失敗した段階</strong></div>
<table class="t-two"><thead><tr><th>段階</th><th style="text-align:right">件数</th></tr></thead><tbody>${stageRows}</tbody></table></div>

<div class="card"><h2>📡 監視対象と始点</h2>
<div class="stat"><div><div class="v" style="color:#6fae62">${stats.prunedKept.toLocaleString()}</div><div class="l">監視中プール</div></div>
<div><div class="v">${countUsableStarts().toLocaleString()}</div><div class="l">始点に使える通貨</div></div>
<div><div class="v">${totalEvents.toLocaleString()}</div><div class="l">受信イベント</div></div>
<div><div class="v">${s.arbitragablePairs.toLocaleString()}</div><div class="l">裁定候補ペア</div></div></div>
<div class="note">${syncLine}<br>始点の内訳: ${startsLine}</div></div>

<div class="card"><h2>🩺 システムの健全性</h2>
<div class="stat"><div><div class="v" style="color:${hbAge != null && hbAge < 120 ? '#2ecc71' : '#e74c3c'}">${hbAge != null ? hbAge + '秒前' : '-'}</div><div class="l">最終生存確認</div></div>
<div><div class="v" style="color:${maxQueue > 500 ? '#e74c3c' : maxQueue > 100 ? '#e8a33d' : '#2ecc71'}">${maxQueue.toLocaleString()}</div><div class="l">待ち行列</div></div>
<div><div class="v">${lat != null ? lat + 'ms' : '-'}</div><div class="l">判定時間</div></div>
<div><div class="v">${stats.feeProbed.toLocaleString()}</div><div class="l">手数料実測済み</div></div></div>
<div class="note">実測ガス代(2step): ${gasLine}<br>
問い合わせの束ね: ${mc.calls.toLocaleString()}回の呼び出しで${mc.subcalls.toLocaleString()}件を処理(分割再試行${mc.splits}回)<br>
プール: V2 ${s.byKind.v2.toLocaleString()} / V3 ${s.byKind.v3.toLocaleString()}(V2とV3が共存${s.mixedPairs}ペア)<br>
チェーン別: ${Object.entries(s.byChain).map(([c, n]) => `${c}:${n.toLocaleString()}`).join(' / ') || '構築中'}<br>
無効化${stats.disabled}件(過去の記録${stats.disabledFromFile} / 今回${stats.disabledRuntime})<br>
手数料の未実測: 残${stats.feeProbePending.toLocaleString()}プール</div></div>

<div class="card"><h2>📒 24時間の記録簿</h2>
<div class="stat"><div><div class="v">${sum.count.toLocaleString()}</div><div class="l">記録件数</div></div>
<div><div class="v" style="color:#e8a33d">+$${sum.profitableUsd.toFixed(3)}</div><div class="l">黒字判定の合計</div></div>
<div><div class="v" style="color:#2ecc71">+$${sum.realizedUsd.toFixed(4)}</div><div class="l">実際に得た利益</div></div>
<div><div class="v">${stats.bigMoves.toLocaleString()}</div><div class="l">大口取引の検知</div></div></div>
<div class="note">なぜそうなったか: ${outcomeLine}<br>
送信まで進んだ判定額: +$${sum.sentUsd.toFixed(4)}<br>
<span style="color:#e8a33d">「黒字判定の合計」は同じ経路の再検知を何度も足した値で、送信直前の実測では赤字になる分も含みます。取り逃した金額ではありません。</span></div>

<h2 style="margin-top:14px">黒字と判定したのに取れなかった上位</h2>
<table class="t-num"><thead><tr><th>#</th><th>経路</th><th>理由</th><th style="text-align:right">投入</th><th style="text-align:right">判定額</th></tr></thead><tbody>${missedRows}</tbody></table>

<h2 style="margin-top:14px">直近に検知した機会</h2>
<table class="t-num"><thead><tr><th>#</th><th>経路</th><th style="text-align:right">壁</th><th style="text-align:right">投入</th><th style="text-align:right">純利益</th></tr></thead><tbody>${oppRows}</tbody></table></div>

<div class="card"><h2>📏 あと何bpsで黒字だったか</h2>
<div class="note" style="margin-top:0;border-top:none;padding-top:0">件数は<b>別々の経路の本数</b>です(同じ経路を何度評価しても1本)。<br>手数料1%のプールを2段通れば壁は200bpsで、価格がどれだけ動いても黒字になりません。そうした経路を除くため、まず壁の高さで分けてから、届きうる経路だけの惜しさを見ます。<br>壁は実測で Polygon 最小35bps / Optimism 最小6bps です。</div>
${nearMissBlocks}</div>

<div class="footerlink"><a href="/about">→ 仕組みについて</a></div></body></html>`;
}

function renderAbout() {
  return `<!DOCTYPE html><html lang="ja"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"><title>仕組み</title><style>${STYLE}</style></head><body>
<h1>📊 仕組み</h1>
<div class="card"><h2>① フラッシュスワップ方式</h2><div class="note">経路の最初のプールから出力通貨を先に受け取り、残りの経路を回って投入通貨に戻し、それで最初のプールに支払います。外部から借りないため手数料がかからず、始点に使える通貨の制限もありません。</div></div>
<div class="card"><h2>② V3は公式Quoterの価格表で判定</h2><div class="note">V3は価格帯ごとに流動性が分かれるため、現在価格と流動性だけの近似式では正しく計算できません(実測で最大2,184%の過大)。プールごとに公式Quoterで代表的な投入額の受取量を取得して表にし、判定はそこから補間します。表が無いプールは判定に使いません。</div></div>
<div class="card"><h2>③ 始点に使える通貨</h2><div class="note">桁数と価格が分かる通貨はすべて始点にできます。桁数はプールのトークンから一括取得し、価格は安定通貨と繋がるプールから逆算します。</div></div>
<div class="card"><h2>④ 監視対象を絞る</h2><div class="note">2段の裁定は「同じペアに2つ以上のプールがある」時にしか成立しません。比べる相手のいないプールは監視してもイベント量が増えるだけなので、候補だけに絞っています。</div></div>
<div class="card"><h2>⑤ 問い合わせを束ねる</h2><div class="note">RPCは1回の呼び出しごとに課金されるため、V3の状態読みと価格表の作成はMulticall3で複数プール分をまとめて1回にしています。</div></div>
<div class="card"><h2>⑥ 安全策</h2><div class="note">ガス見積もりが失敗すればプールに拒否されているので、送信せずに済みガス代を失いません。利益は実行前後の残高差分で判定するため、過去の利益が残っていても誤判定しません。</div></div>
<div class="footerlink"><a href="/">← 戻る</a></div></body></html>`;
}

function startServer() {
  const port = process.env.PORT || 8080;
  http.createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(req.url === "/about" ? renderAbout() : renderPage());
  }).listen(port, () => console.log(`ダッシュボード: ポート${port}`));
}

async function main() {
  console.log("=== DEXアービトラージ(フラッシュスワップ / V2 + V3) 起動 ===");
  startServer();

  const deployTarget = process.env.RUN_MAINNET_DEPLOY;
  if (deployTarget && deployTarget !== "false") {
    try { await runMainnetDeploy(deployTarget); } catch (e) { console.error("[本番デプロイ] 失敗:", e.message); }
  }

  // 環境変数 RUN_POOL_SURVEY にチェーン名を入れた時だけ、V3型プールの調査を一度だけ行う。
  // 未監視のDEXに、いま取引しているペアのプールがあるかを確かめるための読み取り専用の処理。
  // 終わったら RUN_POOL_SURVEY を false に戻すこと。
  const surveyTarget = process.env.RUN_POOL_SURVEY;
  if (surveyTarget && surveyTarget !== "false") {
    try { await runPoolSurvey(surveyTarget); } catch (e) { console.error("[プール調査] 失敗:", e.message); }
  }

  stats.journalLoaded = loadJournal();
  if (stats.journalLoaded > 0) console.log(`[記録簿] 直近${stats.journalLoaded}件を読み込みました`);

  setInterval(heartbeat, HEARTBEAT_INTERVAL_MS);
  await refreshGasCosts();
  // 判定に使うガス代の更新。5分ごとだと、判定時のガス代が最大5分古くなる。
  // Polygonの baseFee は数十秒で動くため、古い値のままだと薄い機会を
  // 取り逃がす。RPCは3チェーン×2回で毎分6回(枠の1.3%)に収まる。
  setInterval(refreshGasCosts, GAS_REFRESH_INTERVAL_MS);

  startOnchainFeeds(handleSync, handleV3Swap, handleV3Liquidity);

  await preparePoolMap();

  setInterval(probeFeesGradually, FEE_PROBE_INTERVAL_MS);
  setInterval(refreshStaleReserves, REFRESH_STALE_SEC * 1000);
  setInterval(refreshV3States, 20000);
  setInterval(refreshQuoteTables, QUOTE_TABLE_INTERVAL_MS);
  setInterval(verifyV3Calculations, V3_VERIFY_INTERVAL_MS);
  setInterval(refreshTokenPrices, PRICE_REFRESH_INTERVAL_MS);
  setInterval(() => { savePoolMap(); stats.mapSavedAt = new Date().toISOString(); }, SAVE_MAP_INTERVAL_MS);
  setInterval(trimJournalIfNeeded, 30 * 60 * 1000);
  setTimeout(refreshContractBalances, 30000);
  setInterval(refreshContractBalances, 10 * 60 * 1000);
  setTimeout(fullScanOnce, 10000);
  setInterval(fullScanOnce, FULL_SCAN_INTERVAL_SEC * 1000);

  console.log(`[起動] 準備完了 / 取引上限$${getCurrentTradeCapUsd()} / 最低利益$${MIN_PROFIT_USD}`);
}

main().catch((e) => { console.error("致命的エラー:", e); process.exit(1); });
