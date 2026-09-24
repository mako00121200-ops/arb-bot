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
import fs from "fs";
import path from "path";
import { ethers } from "ethers";
import { startOnchainFeeds, getSyncStats, isChainWsEnabled, isChainHealthy, setWatchedAddresses, getPendingStats } from "./dex-onchain-realtime.js";
import { runMainnetDeploy } from "./scripts/mainnet-deploy.js";
import { runPoolSurvey } from "./scripts/pool-survey.js";
import { runMainnetDepthSurvey } from "./scripts/mainnet-depth-survey.js";
import { runMorphoSurvey, morphoSurveyChains } from "./scripts/morpho-liquidation-survey.js";
import { runWickBacktestAll, wickBacktestSymbols } from "./scripts/wick-backtest.js";
import { startMainnetEdgeWatch, formatMainnetEdgeLine, flushMainnetEdge } from "./scripts/mainnet-edge-watch.js";
import { getRealExecutionStats } from "./scripts/real-execution-log.js";
import { getCurrentTradeCapUsd, getSuccessCount } from "./scripts/trade-cap.js";
import { scoutAllChains, getScoutChains, getReportOnlyChains, SCOUT_INTERVAL_MS, SCOUT_EVICT_IDLE_MS } from "./scripts/pool-scout.js";
import { probePoolFeeBps, isFeeProbeOnHold, getRpcStatus, getRpcCallTotals, callWithRpc, probePendingState, getProviderForChain , getFeeProbeStats, ensureAmountOutFlag } from "./scripts/onchain-reserves.js";
import { updateRpcUsage, formatRpcUsageLine } from "./scripts/rpc-usage.js";
import { alertOwner, getAlertStats, sendPendingQuestions } from "./scripts/owner-alert.js";
import { verifyAaveChains, getAaveChains, sweepAll as aaveSweepAll, checkWatchAll as aaveCheckWatchAll, formatAaveLine, AAVE_SWEEP_INTERVAL_MS, AAVE_WATCH_INTERVAL_MS } from "./scripts/aave-liquidation.js";
import { noteBigOutcome, formatBigLine, formatBigSummary, flushBigOpportunities } from "./scripts/big-opportunities.js";
import { formatTierLine, formatTierBreakdown, formatMoveBreakdown, flushTiers } from "./scripts/opportunity-tiers.js";
import { probeUniswapXOnce, formatUniswapXLine, formatUniswapXReport, getProbeChains, PROBE_INTERVAL_MS, formatMissingPairsLine } from "./scripts/uniswapx-probe.js";
import { fillMissingPairsOnce, formatPairFillLine, flushPairFiller } from "./scripts/pair-filler.js";
import { probeSolanaOnce, formatSolanaLine, getSolanaTokenCount, SOLANA_PROBE_INTERVAL_MS } from "./scripts/solana-probe.js";
import { startLiquidationMonitor, setCandidateHandler, formatLiquidationLine, getLiquidationDashboard, CHAIN as LIQUIDATION_CHAIN, TAG as LIQUIDATION_TAG } from "./scripts/liquidation-monitor.js";
import { handleLiquidationCandidate, selfCheckLiquidationExecutor } from "./scripts/liquidation-executor.js";
import { runLiquidatorDeploy, runMorphoLiquidatorDeploy } from "./scripts/liquidator-deploy.js";
import { startMorphoLiquidation, formatMorphoLine } from "./scripts/morpho-liquidation.js";
import { startCompoundMonitor, formatCompoundLine } from "./scripts/compound-buy-monitor.js";
import { startSparkMonitor, formatSparkLine } from "./scripts/spark-psm-monitor.js";
import { readPoolFeeOnchain } from "./scripts/pool-fee-onchain.js";
import { minProfitUsd, describeMinProfit, noteSendOutcome, formatSendBalanceLine } from "./scripts/min-profit.js";
// 画面とログの時刻は**すべて日本時間**に揃える(保存は UTC のまま)。
import { TZ_LABEL, formatJst as formatLocalTime, nowJst } from "./scripts/jst.js";
import {
  fetchReservesBatch, fetchPoolTokensBatch, fetchTokenDecimalsBatch,
  fetchV3StatesBatch, getMulticallStats, findV3PoolsBatch,
} from "./scripts/multicall-reserves.js";
import { estimateGasCostUsd, getGasCostStatus, exportGasPriceRatios, importGasPriceRatios, getGasPriceRatio, weiToUsd } from "./scripts/gas-cost.js";
import {
  registerPool, removePool, pruneToCandidates, getSubscribedAddresses, evictQuietScoutPools,
  updateReservesFromSync, updateV3FromSwap, setPoolFee, markFeeFromChain, getPool, getStats,
  setTokenDecimals, getTokenDecimals, setTokenPriceUsd, getTokenPriceUsd,
  getAllPoolAddressesByChain, getPoolsForToken, getStalePools, getPoolsByKind,
  getArbitragablePairs, savePoolMap, loadPoolMap, snapshotFullMap,
  hasUsableState, clearPoolState, formatStateDiagnostics, KIND_V2, KIND_V3,
  markQuoteBase, setQuoteBase, getQuoteFreshness, rankTokensByDepth,
} from "./scripts/pool-registry.js";
import {
  scanForChangedPool, scanAllPairs, getRouteCalcStats,
  getNearMissStats, countIfWallDrops, getWallBreakdown, NEAR_MISS_REACHABLE_WALL_BPS,
  getWhatIfProfit, getSpotScreenStats, takeQuoteDemand, getQuoteDemandTotal,
  getQuarantineStats, getSizeCurveStats,
} from "./scripts/opportunity-scanner.js";
import { executeOpportunity, formatSendSkipLine, flushSendSkips, ExecutionError, TAX_TOKEN_FEE_BPS, resetNonce, checkContractVersions, noteChainSendResult, formatSpeedLine } from "./scripts/execute-opportunity.js";
import {
  getKnownTokens, isBorrowable,
  markUsableStart, clearUsableStarts, countUsableStarts,
} from "./scripts/borrowable-tokens.js";
import { isKnownIncompatiblePool, recordIncompatiblePool } from "./scripts/incompatible-pools.js";
import { journal, loadJournal, trimJournalIfNeeded, summarize } from "./scripts/opportunity-journal.js";
import {
  activeV3Factories, isForkFactory, V3_FEE_TIERS, findV3Pool, feeTierToBps,
  buildQuoteTablesBatch, hasQuoteTable, clearQuoteTable, clearQuoteTableDirection,
  setTableTrustedMax, getTableTrustedMax, getTrustedMaxCount, countQuoteTables,
  verifyQuoteTable, QUOTE_SAMPLES_USD, exportQuoteTables, importQuoteTable,
} from "./scripts/v3-pools.js";
import { CHAIN_CONFIG } from "./chain-config.js";

// 最低利益は**チェーンごと**(ガス代が25倍違うため。scripts/min-profit.js)。

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
/// 全V3プールの価格表を順ぐりに作り置きするか。
///
/// [これを false にすると「作り置き」をやめられる(2026年9月18日)]
/// 作り置きは費用も鮮度もプール数に比例する(V3 5,000件で一巡69分)。
/// false にすると、価格表は「ふるいを通った経路が要求した分」だけになり、
/// **費用が候補の数に比例する**。実測では候補は毎分0〜22件しかない。
/// 既定は true のまま。ふるいからの要求が実際に届くのを確認してから切り替える。
const QUOTE_TABLE_FILL_ALL = (process.env.QUOTE_TABLE_FILL_ALL || "true").toLowerCase() !== "false";
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
/// 送信失敗を数える窓。**この窓の外の失敗は忘れる。**
/// 窓が無いと、何時間も動かすうちに失敗が積み上がり、
/// 「たまたま3回負けた」だけのプールが永久に消える。
const FAILURE_WINDOW_MS = parseInt(process.env.FAILURE_WINDOW_MS || String(30 * 60 * 1000), 10);
/// 送信失敗が続いたプールを外す時間。**永久にはしない。**
const FAILURE_DISABLE_MS = parseInt(process.env.FAILURE_DISABLE_MS || String(60 * 60 * 1000), 10);
const MAX_SANE_RETURN_RATIO = parseFloat(process.env.MAX_SANE_RETURN_RATIO || "0.20");
/// V3の価格表を公式Quoterと突き合わせる間隔。
///
/// [2分 → 45秒に縮めた(2026年9月21日 21:30 JST、実測で判明)]
/// base の `uniswap-v3(1.00%)→sync発見` が、**価格表が295bps過大**のまま
/// 何度も「黒字」と判定され、送信直前に毎回捨てられていた
/// (記録簿の「取れた可能性」の上位2件、合わせて$28.5 はこれだった)。
/// 捕まえたのは定期検証ではなく、**実際に取ろうとして失敗した後の答え合わせ**。
///
/// 定期検証は72回まわって**1件も上限を付けていない**(`V3表[確認72 上限制限0]`)。
/// 理由は単純で、**一周するのに時間がかかりすぎている**:
///   価格表327本 × 両方向 = 654通り。2分に1つなら**一周21.8時間**。
/// しかも向きを交代で測るようにした分(9月21日)、1プールあたり2枠使うので更に遅い。
///
/// 45秒なら一周8.2時間。RPCは 4件/45秒 = 毎分5.3回 = 月23万回 = **枠の1.2%**
/// (今は毎分2回=0.4%なので +0.8%。月末見込28% → 約29%で収まる)。
/// 壊れた表を早く見つけるほど、幻の機会と無駄な送信直前の確認が減る。
const V3_VERIFY_INTERVAL_MS = parseInt(process.env.V3_VERIFY_INTERVAL_MS || "45000", 10);
const MIN_PRICE_SOURCE_USD = parseFloat(process.env.MIN_PRICE_SOURCE_USD || "5000");

// ===== 価格表の保存と復元(2026年9月19日) =====
//
// [なぜ要るか]
// 作り置きをやめてから、**再デプロイのたびに価格表がゼロに戻り、
// 判定が立ち上がるまで20〜40分かかる**ようになった。この日の計測は
// 何度もその空白に当たって読めなかった。取引の機会もその間は取れない。
//
// [安全の考え方]
// 古い価格表をそのまま使うのは危険(それが9月18日の幻の利益の正体)。
// そこで**表を作った時の価格も一緒に保存し、起動時に今の価格と比べる**。
//   ・プールが動いていなければ、その表はいま作っても同じ → 復元してよい
//   ・少しでも動いていれば捨てる(作り直しは要求が来た時に走る)
// 基準の価格も当時の値で戻すので、ズレの積算もやり直しにならない。
const QUOTE_TABLE_FILE = process.env.QUOTE_TABLE_FILE
  || (process.env.POOL_MAP_FILE
      ? path.join(path.dirname(process.env.POOL_MAP_FILE), "quote-tables.json")
      : "/tmp/quote-tables.json");
// ===== ガス単価の補正比の保存(2026年9月20日) =====
//
// 補正比は**送信が成功した時にしか学習できない**(1日数件)。再デプロイの
// たびに 1.0 へ戻っていたため、実際には一度も貯まっていなかった。
// 比は相場そのものではなく「出す用意のあった単価と、実際に取られた単価の比」
// なので、数時間は持ち越してよい。
const GAS_RATIO_FILE = process.env.GAS_RATIO_FILE
  || (process.env.POOL_MAP_FILE
      ? path.join(path.dirname(process.env.POOL_MAP_FILE), "gas-price-ratio.json")
      : "/tmp/gas-price-ratio.json");
/// これより古い補正比は使わない。
const GAS_RATIO_MAX_AGE_HOURS = parseFloat(process.env.GAS_RATIO_MAX_AGE_HOURS || "6");

/// これより古い価格表は、価格が動いていなくても捨てる。
/// 価格が同じでも、流動性の出し入れで曲線そのものが変わっているため。
const QUOTE_TABLE_MAX_AGE_HOURS = parseFloat(process.env.QUOTE_TABLE_MAX_AGE_HOURS || "6");
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
// sendBusy は**2つの別の理由**を混ぜていた(2026年9月22日 07:22 JST に分けた)。
//   sendBusyParallel … チェーンあたりの同時送信の上限に当たった
//   sendBusyPool     … 同じプールを使う送信が進行中だった
// 直し方が正反対なので分ける:
//   前者が多ければ**上限を上げれば取れる**(その分ガスの同時持ち出しは増える)
//   後者が多ければ**上限を上げても無駄**。同じプールを2本同時に通せば
//   先に着いた方が価格を動かし、後の方は巻き戻ってガス代だけ失う
const reasons = { disabled: 0, taxToken: 0, cooldown: 0, trap: 0, notProfitable: 0, belowMin: 0, executing: 0, sendBusy: 0, sendBusyParallel: 0, sendBusyPool: 0, notSent: 0, failed: 0, success: 0 };

// ===== 最低利益未満で見送った機会の内訳(2026年9月20日) =====
//
// [なぜ要るか]
// 30分ごとの見回りで「下限で落ちている機会を通す調整」を判断するのに、
// 内訳[下限N] の件数だけでは、どのチェーンで・粗利がいくらで・ガス代がいくらで
// 落ちているのかが分からない(記録簿はダッシュボードにしか無く、ログからは読めない)。
// 直近30分の見送りをチェーン別に集計して [生存] に出し、5分に1件だけ実物も出す。
const BELOW_MIN_WINDOW_MS = 30 * 60 * 1000;
const belowMinRecent = []; // { at, chain, kind, tradeUsd, gross, net }
const belowMinLastSampleAt = {};
function noteBelowMin(opp) {
  const now = Date.now();
  belowMinRecent.push({ at: now, chain: opp.chain, kind: opp.kind, tradeUsd: opp.tradeAmountUsd, gross: opp.grossProfitUsd, net: opp.netProfitUsd });
  while (belowMinRecent.length > 0 && now - belowMinRecent[0].at > BELOW_MIN_WINDOW_MS) belowMinRecent.shift();
  if (belowMinRecent.length > 2000) belowMinRecent.shift();
  if (!belowMinLastSampleAt[opp.chain] || now - belowMinLastSampleAt[opp.chain] > 5 * 60 * 1000) {
    belowMinLastSampleAt[opp.chain] = now;
    const gas = (opp.grossProfitUsd ?? 0) - (opp.netProfitUsd ?? 0);
    console.log(`[下限] ${opp.kind} ${opp.chain} ${opp.label}: 投入$${(opp.tradeAmountUsd ?? 0).toFixed(2)} 粗利$${(opp.grossProfitUsd ?? 0).toFixed(4)} − ガス$${gas.toFixed(4)} = 純利$${(opp.netProfitUsd ?? 0).toFixed(4)}(手数料負け)`);
  }
}
function belowMinSummary() {
  const now = Date.now();
  while (belowMinRecent.length > 0 && now - belowMinRecent[0].at > BELOW_MIN_WINDOW_MS) belowMinRecent.shift();
  if (belowMinRecent.length === 0) return "";
  const byChain = new Map();
  for (const r of belowMinRecent) {
    const e = byChain.get(r.chain) || { n: 0, gross: [], gas: [], bestNet: -Infinity };
    e.n++;
    e.gross.push(r.gross ?? 0);
    e.gas.push((r.gross ?? 0) - (r.net ?? 0));
    if ((r.net ?? -Infinity) > e.bestNet) e.bestNet = r.net;
    byChain.set(r.chain, e);
  }
  const median = (a) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : 0; };
  const parts = [...byChain.entries()].map(([c, e]) => `${c}:${e.n}件 粗利中央$${median(e.gross).toFixed(4)} ガス中央$${median(e.gas).toFixed(4)} 最良純利$${e.bestNet.toFixed(4)}`);
  return ` 下限の内訳30分[${parts.join(" ")}]`;
}
const failStages = {};

const stats = {
  scans: 0, profitableFound: 0, examined: 0, executed: 0, failed: 0,
  v3Opportunities: 0, quoteTablesPending: 0, quoteRebuildsFromPolling: 0, quoteTablesOnDemand: 0,
  raceLost: 0, feeFixedOnchain: 0, feeUnreadable: 0, feeLearned: 0,
  v3VerifyCount: 0, v3VerifyWorst: null, v3VerifyRecent: [], v3VerifyDropped: 0,
  v3VerifyCapped: 0, v3VerifyUnderCount: 0,
  disabledFromFile: 0, disabledRuntime: 0,
  prunedKept: 0,
  recent: [], disabled: 0,
  latencies: [], feeProbed: 0, feeProbePending: 0, lastHeartbeat: null, journalLoaded: 0,
};

// ふるいの計測の前回値(毎分の通過回数を出すため)。
let lastSpotScreenPassed = [];
let lastSpotScreenFresh = [];
let lastSpotNeedQuote = 0;
let lastSpotScreenAt = null;

const chainReady = new Set();
function isReady(chain) { return chainReady.has(chain); }
function anyReady() { return chainReady.size > 0; }

// ===== 失敗の抑制と無効化 =====
/// key(経路のプール一覧) -> { until, sticky }
///
/// [2種類ある。混ぜてはいけない(2026年9月22日 05:22 JST の実測で判明)]
/// `sticky: true`  … 送信して失敗した / 罠の疑い。**プールそのものが疑わしい**ので
///                   10分は時間で寝かせる。価格が動いても解かない。
/// `sticky: false` … 送信直前の確認で赤字だっただけ。**価格の問題**なので、
///                   経路のどれかのプールが動いたら**その場で解く**。
///
/// [なぜ分けたか]
/// 大物(見込み$0.10以上)の内訳:
///   152件検知 → 成立0件 / 逃した152件(見込み$34.04)
///   [冷却中:113 同じ経路を送信中:26 送信直前で見送り:7 同じプールが使用中:5 送信して失敗:1]
/// **74%が「冷却中」で捨てられていた。**
///
/// しかも捨てていたのは「本当に見るべきもの」だった。判定側には既に
/// `isSuppressed` があり、**経路のプールが1つも動いていない間は再判定しない**。
/// つまり handleOpportunity まで届いた時点で「どれかのプールが動いた」が確定している。
/// そこへ30秒の時間切れを重ねると、**より賢い仕組みが「見る価値がある」と判断した
/// ものだけを、時計で捨てる**ことになる。
const cooldownUntil = new Map();

/// そのプールを含む経路の冷却を解く(価格が原因の冷却だけ)。
/// 送信して失敗した冷却(sticky)はそのまま残す。
function clearPriceCooldownForPool(poolAddress) {
  if (cooldownUntil.size === 0) return;
  const needle = (poolAddress || "").toLowerCase();
  if (!needle) return;
  for (const [key, e] of cooldownUntil) {
    if (e && e.sticky) continue;
    if (key.includes(needle)) cooldownUntil.delete(key);
  }
}
/// key -> { times: [失敗した時刻] }。窓の外は捨てる。
const poolFailures = new Map();
/// key -> 期限(ms)。送信失敗で一時的に外したプール。
const temporarilyDisabled = new Map();
const disabledPools = new Set();

function poolKeyOf(chain, address) { return `${chain}::${address.toLowerCase()}`; }

/// 生存ログ用。永久に外した数・一時的に外して今も外れている数・先を越された数。
/// **「先を越された」は失敗ではなく競争の結果**なので、別に数える。
function disableLine() {
  const now = Date.now();
  let active = 0;
  for (const until of temporarilyDisabled.values()) if (until > now) active++;
  if (!disabledPools.size && !active && !stats.raceLost) return "";
  return ` 外した[永久${disabledPools.size} 一時${active} 先越され${stats.raceLost}]`;
}

/// [永久か一時か(2026年9月21日に判明)]
/// 「送信失敗3回」でプールを**永久に**無効化していた。しかし `wait` の失敗
/// (確定待ちで取り消された)は、**他者に先を越された**時に必ず起きる。
/// つまり**競争が激しいプールほど早く消える**。大きな機会があるのは
/// まさにそういうプールなので、**取りたい場所から順に地図から消していた**。
///
/// さらに今朝、不適合リストを /tmp からボリュームへ移したため、
/// **今まで再デプロイで消えていたこの誤判定が、永久に残るようになっていた**。
/// 自分の修正が、別の欠陥を悪化させていた。
///
/// 永久に外してよいのは、**プールやトークンの性質として変わらないもの**だけ。
///
/// **理由の文面で判定しない。** 最初そう書いたところ、自分の検算で
/// 「送金時に税を取るトークン」が「税トークン」に一致せず、
/// **税トークンが一時扱いになる**バグが出た。日本語の文面は書き換わる。
/// 呼ぶ側が `permanent` で明示する。
function disablePool(chain, address, reason, { fromFile = false, permanent = false } = {}) {
  const key = poolKeyOf(chain, address);

  // 送信失敗のような**移ろう理由**では、期限付きで外すだけにする。
  if (!fromFile && !permanent) {
    if (temporarilyDisabled.get(key) > Date.now()) return;
    temporarilyDisabled.set(key, Date.now() + FAILURE_DISABLE_MS);
    clearPoolState(getPool(chain, address));
    // 理由は**切り詰めすぎない**。70文字で切ると、いちばん知りたい
    // 取り消しのセレクタが消える(実際に消えていた)。
    console.log(`[一時無効] ${chain} ${address.slice(0, 10)}…: ${reason.slice(0, 140)} → ${Math.round(FAILURE_DISABLE_MS / 60000)}分だけ外します(永久ではありません)`);
    return;
  }

  if (disabledPools.has(key)) return;
  disabledPools.add(key);
  stats.disabled++;
  if (fromFile) stats.disabledFromFile++; else stats.disabledRuntime++;
  clearPoolState(getPool(chain, address));
  clearQuoteTable(chain, address);
  if (!fromFile) {
    recordIncompatiblePool(chain, address, reason, { permanent: true });
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
  cooldownUntil.set(opp.poolAddresses.join("|").toLowerCase(), { until: Date.now() + FAILURE_COOLDOWN_MS, sticky: true });

  if (error instanceof ExecutionError && error.taxToken) {
    const targets = error.taxPools?.length ? error.taxPools : opp.poolAddresses;
    for (const address of targets) {
      disablePool(opp.chain, address, `送金時に税を取るトークン(手数料${TAX_TOKEN_FEE_BPS}bps超)`, { permanent: true });
    }
    return;
  }
  if (error instanceof ExecutionError && error.staleReserves) {
    return;
  }

  // **他者に先を越された失敗は、プールのせいではない。**
  // `wait`(確定待ちで取り消された)は、送った後に価格が動いた時に起きる。
  // 「誰が取ったか」の集計でも、他者の裁定や通常取引が原因だと実測できている。
  // これを「価格が信用できないプール」として数えると、
  // **競争が激しい=機会が大きいプールから順に消えていく。**
  // K検算での拒否は「手数料の前提が低すぎる」の確証。**チェーンから読み直す。**
  //
  // あわせて、**そのプールが `getAmountOut` を持つかを確かめる**(2026年9月21日)。
  // 持っていればコントラクトがプール自身に受取量を聞くので、
  // **手数料を当てる必要がそもそも無くなり、K検算で落ちなくなる。**
  // 手数料がどの方法でも読めないプール(dystopia:0x60c08823… 等)は、
  // これが唯一の出口。
  if (stage === "feeMismatch") {
    queueOnchainFeeFix(opp);
    for (const leg of opp.legs || []) {
      if (leg.kind === KIND_V3 || !leg.pool) continue;
      const pool = getPool(opp.chain, leg.pool);
      if (!pool) continue;
      const inIsToken0 = pool.token0 === (leg.tokenIn || "").toLowerCase();
      const reserveIn = inIsToken0 ? pool.raw0 : pool.raw1;
      ensureAmountOutFlag(opp.chain, leg.pool, leg.tokenIn, reserveIn)
        .then((ok) => {
          if (ok) console.log(`[K検算の出口] ${opp.chain} ${leg.dexId}:${leg.pool.slice(0, 10)}…: getAmountOut を持っていました。以降はプール自身に受取量を聞くので、手数料を当てる必要がありません`);
        })
        .catch(() => {});
    }
  }

  const raceLost = stage === "wait";
  if (raceLost) {
    stats.raceLost++;
    return; // 冷却(上で設定済み)だけで十分。失敗回数には数えない
  }

  const scam = isScamRevert(reason);
  const now = Date.now();
  for (const address of opp.poolAddresses) {
    const key = poolKeyOf(opp.chain, address);
    const entry = poolFailures.get(key) || { times: [] };
    // **窓の外の失敗は忘れる。** 積み上げると、長く動かすほど地図が痩せる。
    entry.times = entry.times.filter((t) => now - t < FAILURE_WINDOW_MS);
    entry.times.push(now);
    poolFailures.set(key, entry);
    const n = entry.times.length;
    if (scam) {
      disablePool(opp.chain, address, `詐欺トークン: ${reason}`, { permanent: true });
    } else if (n >= DISABLE_AFTER_FAILURES) {
      entry.times = []; // 外したので数え直す
      disablePool(opp.chain, address, `送信失敗${n}回(${Math.round(FAILURE_WINDOW_MS / 60000)}分以内): ${reason}`);
    }
  }
}

function hasDisabledPool(opp) {
  const now = Date.now();
  return opp.poolAddresses.some((a) => {
    const key = poolKeyOf(opp.chain, a);
    if (disabledPools.has(key)) return true;
    const until = temporarilyDisabled.get(key);
    if (until == null) return false;
    if (until > now) return true;
    temporarilyDisabled.delete(key); // 期限切れ。地図に戻す
    return false;
  });
}

function pruneTaxTokenPools(opp) {
  let found = false;
  for (const address of opp.poolAddresses) {
    const pool = getPool(opp.chain, address);
    if (!pool || pool.kind === KIND_V3 || !pool.feeProbed) continue;
    if (pool.feeBps > TAX_TOKEN_FEE_BPS) {
      disablePool(opp.chain, address, `実測手数料${pool.feeBps}bps(税トークン)`, { permanent: true });
      found = true;
    }
  }
  return found;
}

function rejectIfTrap(opp) {
  if (opp.tradeAmountUsd <= 0) return false;
  const ratio = opp.netProfitUsd / opp.tradeAmountUsd;
  if (ratio <= MAX_SANE_RETURN_RATIO) return false;
  const reason = `異常なリターン${(ratio * 100).toFixed(0)}%`;
  if (opp.hasV3) {
    console.log(`[罠の疑い] ${opp.kind} ${opp.chain} ${opp.label}: ${reason}。見送ります`);
    cooldownUntil.set(opp.poolAddresses.join("|").toLowerCase(), { until: Date.now() + FAILURE_COOLDOWN_MS, sticky: true });
    return true;
  }
  console.log(`[罠] ${opp.kind} ${opp.chain} ${opp.label}: ${reason}(投入$${opp.tradeAmountUsd.toFixed(2)}→利益$${opp.netProfitUsd.toFixed(2)})。無効化します`);
  for (const address of opp.poolAddresses) disablePool(opp.chain, address, reason, { permanent: true });
  return true;
}

// ===== 記録簿 =====
/// 「模型の誤り」と呼ぶ境目(bps)。表の上限を下げる閾値(LEARN_CAP_BPS)と同じ尺度。
/// これより大きくずれていれば、価格の動きではなく**こちらの計算が違っていた**と見なす。
const MODEL_WRONG_BPS = parseFloat(process.env.MODEL_WRONG_BPS || "-20");

/// 送信まで行かなかった機会を、**実測で**分類する。
///
/// [なぜ要るか(2026年9月21日、オーナーの指摘)]
/// 画面の「送信直前に見送り 264件 +$77.89」には、中身の違う3つが混ざっていた。
///   ・チェーン上で赤字。**こちらの計算が違っていた**(直せる)
///   ・チェーン上で赤字。**判定から送信までに価格が動いた**(速さの問題。計算は正しい)
///   ・チェーン上では黒字。**ガス代に届かない**(そもそも失敗ではない)
/// 全部に「判定と実測のずれ」という同じ直し方が書かれていたので、
/// **どれから手を付ければよいか分からなかった。**
/// `sendResult` と `modelBps` は既に測ってあるので、それで分ける。
function notSentOutcome(opp) {
  if (opp.sendResult === "below_gas") return "below_gas";
  if (opp.sendResult !== "rejected") return "not_sent";
  // チェーン上で赤字だった。段ごとの答え合わせが原因を測れていれば、それで分ける。
  if (opp.modelBps != null) {
    return opp.modelBps <= MODEL_WRONG_BPS ? "model_wrong" : "price_moved";
  }
  return "not_profitable_onchain";
}

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
    // 段ごとの答え合わせで測った「模型の誤りの合計」(bps)。
    // これが小さければ、赤字の原因は価格の動き(= 競争に負けた)。
    ...(opp.modelBps != null ? { modelBps: Number(opp.modelBps.toFixed(1)) } : {}),
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
  // [手書きの桁数をチェーンで照合する(2026年9月20日)]
  // 手書きの一覧のトークンは、これまでチェーンに問い合わせずにそのまま
  // 使っていた。桁数を1つ間違えると量の計算が10倍ずれ、投入額も利益の
  // 判定も丸ごと狂う。CLAUDE.md の「推測で決めない」に従い、起動時に
  // 実物と突き合わせる。数トークンなので1回の束ね呼び出しで済む。
  // 食い違ったらチェーンの値を採り、直すべき場所が分かるよう大きく出す。
  const knownList = Object.keys(known);
  if (knownList.length > 0) {
    try {
      const actual = await fetchTokenDecimalsBatch(chain, knownList);
      for (const [address, decimals] of actual) {
        const written = known[address]?.decimals;
        if (written != null && decimals !== written) {
          console.error(`[桁数の照合] ${chain} ${known[address].symbol} ${address}: 手書き${written}桁 ≠ チェーン${decimals}桁。チェーンの値を使います(borrowable-tokens.js を直してください)`);
          setTokenDecimals(chain, address, decimals);
        }
      }
    } catch (e) {
      console.warn(`[桁数の照合] ${chain}: 確認できませんでした: ${(e.message || "").slice(0, 80)}`);
    }
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
  return priced;
}

// ===== V3の価格表 =====
// 公式Quoterに代表的な投入額を問い合わせ、結果を表として保持する。
// 判定はこの表から補間するため、RPCを使わずミリ秒で済み、誤差もない。

const quoteRebuildQueue = new Set(); // "chain::pool" 作り直しが必要なプール
// ふるいを通った経路が要求した価格表。作り置きより優先して作る。
const quoteDemandQueue = new Set();

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

/// いま持っている価格表を、作った時の価格つきで保存する。
function saveQuoteTables() {
  try {
    const tables = [];
    for (const e of exportQuoteTables()) {
      const [chain, address] = e.key.split("::");
      const pool = getPool(chain, address);
      // 基準の価格が無い表は、動いたかどうかを確かめられないので保存しない。
      if (!pool || !(pool.quoteBasePrice > 0n)) continue;
      tables.push({ ...e, basePrice: pool.quoteBasePrice.toString() });
    }
    if (tables.length === 0) return 0;
    const tmp = QUOTE_TABLE_FILE + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify({ savedAt: new Date().toISOString(), count: tables.length, tables }));
    fs.renameSync(tmp, QUOTE_TABLE_FILE);
    return tables.length;
  } catch (e) {
    console.warn(`[価格表の保存] 失敗: ${e.message.slice(0, 80)}`);
    return 0;
  }
}

/// 学んだガス単価の補正比を保存する。
function saveGasPriceRatios() {
  try {
    const ratios = exportGasPriceRatios();
    if (Object.keys(ratios).length === 0) return 0;
    const tmp = GAS_RATIO_FILE + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify({ savedAt: new Date().toISOString(), ratios }));
    fs.renameSync(tmp, GAS_RATIO_FILE);
    return Object.keys(ratios).length;
  } catch (e) {
    console.warn(`[ガス単価の補正] 保存に失敗: ${e.message.slice(0, 80)}`);
    return 0;
  }
}

/// 保存しておいた補正比を戻す。古すぎるものは使わない。
function restoreGasPriceRatios() {
  try {
    if (!fs.existsSync(GAS_RATIO_FILE)) return 0;
    const data = JSON.parse(fs.readFileSync(GAS_RATIO_FILE, "utf8"));
    const ageHours = data.savedAt ? (Date.now() - new Date(data.savedAt).getTime()) / 3600000 : null;
    if (ageHours != null && ageHours > GAS_RATIO_MAX_AGE_HOURS) {
      console.log(`[ガス単価の補正] 保存分は${ageHours.toFixed(1)}時間前で古いため使いません`);
      return 0;
    }
    const n = importGasPriceRatios(data.ratios);
    if (n > 0) {
      const parts = Object.keys(data.ratios).map((c) => `${c}:${getGasPriceRatio(c).toFixed(3)}`).join(" ");
      console.log(`[ガス単価の補正] ${n}チェーン分を戻しました(${parts})。見積もりはこの比を掛けた額になります`);
    }
    return n;
  } catch (e) {
    console.warn(`[ガス単価の補正] 復元に失敗: ${e.message.slice(0, 80)}`);
    return 0;
  }
}

/// 保存しておいた価格表を戻す。**V3の状態を読んだ後に呼ぶこと**
/// (今の価格と比べて、動いていない分だけを戻すため)。
function loadQuoteTables() {
  let restored = 0, movedOut = 0, tooOld = 0, noPool = 0;
  try {
    if (!fs.existsSync(QUOTE_TABLE_FILE)) return 0;
    const data = JSON.parse(fs.readFileSync(QUOTE_TABLE_FILE, "utf8"));
    const maxAgeMs = QUOTE_TABLE_MAX_AGE_HOURS * 3600 * 1000;
    for (const t of data.tables || []) {
      if (!t || typeof t.key !== "string") continue;
      if (t.at && Date.now() - t.at > maxAgeMs) { tooOld++; continue; }
      const [chain, address] = t.key.split("::");
      const pool = getPool(chain, address);
      if (!pool || pool.kind !== KIND_V3 || !(pool.sqrtPriceX96 > 0n)) { noPool++; continue; }

      let base;
      try { base = BigInt(t.basePrice); } catch (e) { continue; }
      if (!(base > 0n)) continue;

      // 表を作った時から価格が動いていれば、その表はもう正しくない。
      const drift = Math.abs((Number(pool.sqrtPriceX96) - Number(base)) / Number(base)) * 200;
      if (!isFinite(drift) || drift > QUOTE_REBUILD_MOVE_PCT) { movedOut++; continue; }

      if (importQuoteTable(t.key, t.points, t.at)) {
        setQuoteBase(chain, address, base, drift);
        restored++;
      }
    }
    const ageHours = data.savedAt ? (Date.now() - new Date(data.savedAt).getTime()) / 3600000 : null;
    console.log(`[価格表の復元] ${restored}本を戻しました(${ageHours != null ? ageHours.toFixed(1) + "時間前の保存" : "保存時刻不明"}) / 価格が動いていて破棄${movedOut} / 古すぎ${tooOld} / 対象なし${noPool}`);
  } catch (e) {
    console.warn(`[価格表の復元] 失敗: ${e.message.slice(0, 80)}`);
  }
  return restored;
}

let quoteCursor = 0;
let quoteRefreshRunning = false;
async function refreshQuoteTables() {
  if (!anyReady() || quoteRefreshRunning) return;
  quoteRefreshRunning = true;
  try {
    const selected = [];
    const picked = new Set();

    // ① ふるいを通った経路が要求した価格表。**最優先**。
    //    ここが「候補が出てから見積もる」の実体。取り切れなかった分は
    //    次の回に残す(要求そのものは消さない)。
    for (const key of takeQuoteDemand()) quoteDemandQueue.add(key);
    for (const key of [...quoteDemandQueue]) {
      if (selected.length >= QUOTE_TABLE_PER_TICK) break;
      quoteDemandQueue.delete(key);
      if (disabledPools.has(key)) continue;
      const [chain, address] = key.split("::");
      const pool = getPool(chain, address);
      if (!pool || pool.kind !== KIND_V3) continue;
      if (picked.has(key)) continue;
      picked.add(key);
      selected.push(pool);
      stats.quoteTablesOnDemand++;
    }

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
      .slice(0, Math.max(0, QUOTE_TABLE_PER_TICK - selected.length));
    for (const { key, pool } of urgent) {
      quoteRebuildQueue.delete(key);
      if (picked.has(key)) continue;
      picked.add(key);
      selected.push(pool);
    }
    // 対象外(無効化済みなど)は待ち行列から外しておく。
    for (const key of [...quoteRebuildQueue]) {
      if (disabledPools.has(key)) quoteRebuildQueue.delete(key);
    }

    // 残り枠で、表がまだ無いプール(破棄された表を含む)を順に埋める。
    const budget = QUOTE_TABLE_FILL_ALL ? QUOTE_TABLE_PER_TICK - selected.length : 0;
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
      stats.quoteTablesPending = quoteRebuildQueue.size + quoteDemandQueue.size;
    }

    if (selected.length === 0) return;
    await buildTablesForPools(selected);
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
/// 価格表のずれがこれを超えたら、その表を捨てて作り直させる(bps)。
/// 20bps は「出す」閾値で、そこで捨てると作り直しが増えすぎる。
/// 狙う利幅の上限(50bps)を超えたら、その表は判定に使えないと見なす。
/// 補間が公式より**過大**な時に、投入量の上限を下げる閾値(bps)。
///
/// [なぜ50から20へ下げたか(2026年9月21日、オーナーの指摘)]
/// 「投入額を上げると失敗している。大きい額での手数料の計算が合っていないのでは」
/// —— 実測がこれを裏付けていた。
///
///   avalanche 0xd18384F4(1.00%): $20 誤差20bps以内 / $200 28.3bps / $700 92.2bps
///   avalanche 0x27b571f3(0.30%): $20 誤差20bps以内 / $200 84.8bps
///   optimism 3段V3 投入$276: 判定+$0.4833 → 実測 **-30.9bps**
///
/// **誤差は投入額とともに増える。** 表の点と点を直線で結んでいるので、
/// 小額では曲線とほぼ重なるが、大きくなるほど離れる。
///
/// そして**狙う利幅は5〜50bps**。50bpsで切っていては、
/// 「利幅と同じだけ間違っている表」を通してしまう。**利幅の尺度に合わせる。**
const VERIFY_DROP_TABLE_BPS = parseFloat(process.env.VERIFY_DROP_TABLE_BPS || "20");

/// 直近の機会で実際に使ったV3プール。**確かめる順番をここから決める。**
///
/// [なぜ要るか]
/// 今までは全V3プールを順ぐりに確かめていた。表が約240本あり2分に1本なので、
/// **一周に約8時間**。大きな機会を運んでいるプールが、何時間も確かめられない。
/// 「使っているプールから確かめる」だけで、上限の制限が効くまでの時間が桁で縮む。
const recentlyUsedV3 = new Map(); // "chain::pool" -> 最後に使った時刻
const RECENT_USE_MS = parseInt(process.env.RECENT_USE_MS || String(30 * 60 * 1000), 10);

function noteV3PoolsUsed(opp) {
  const now = Date.now();
  for (const leg of opp.legs || []) {
    if (leg.kind !== KIND_V3 || !leg.pool) continue;
    recentlyUsedV3.set(poolKeyOf(opp.chain, leg.pool), now);
  }
  if (recentlyUsedV3.size > 500) {
    for (const [k, t] of recentlyUsedV3) if (now - t > RECENT_USE_MS) recentlyUsedV3.delete(k);
  }
}

/// 確かめる投入額。**実際の取引額($1〜30)を含む点を必ず入れる。**
/// 以前は最小が$20で、$200/$700 のずれだけを理由に価格表を捨てていた。
/// 小さい側の点があると、制限をかける時の刻みも細かくなる。
const VERIFY_AMOUNTS_USD = (process.env.VERIFY_AMOUNTS_USD || "5,20,200,700")
  .split(",").map((v) => parseFloat(v.trim())).filter((v) => v > 0);

/// 投入額ごとの誤差(bps)。狙う利幅は5〜50bpsなので、%ではなくbpsで見る。
const verifyErrorByUsd = new Map(); // usd -> { count, sumAbsBps, worstBps, overCount }

/// 生存ログ用。価格表に制限をかけた数と、向きごと取り下げた数。
///
/// [2026年9月21日: 今まで見えていなかったものを足した]
/// オーナーの指摘「書いたのに一度も呼ばれていない仕組みは無いか」で洗ったところ、
/// **数えているのに一度も画面にもログにも出していない値**が見つかった。
///   getTrustedMaxCount()  … 今この瞬間、上限がかかっている表の数
///   getQuarantineStats()  … 一時除外の実績
///   getFeeProbeStats()    … 手数料の実測の実績
/// どれも「効いているのか」を判断するのに要る数字だった。
function v3TableLine() {
  const capped = getTrustedMaxCount();
  if (!stats.v3VerifyCapped && !stats.v3VerifyDropped && !stats.v3VerifyUnderCount && !capped) return "";
  return ` V3表[確認${stats.v3VerifyCount} 上限制限${stats.v3VerifyCapped}(今${capped}本) 取下${stats.v3VerifyDropped} 過小${stats.v3VerifyUnderCount}]`;
}

/// 一時除外と手数料の実測の実績。どちらも0のうちは出さない。
function quarantineFeeLine() {
  let out = "";
  try {
    const q = getQuarantineStats();
    if (q && (q.quarantined || q.active || q.skippedRoutes)) {
      out += ` 一時除外[のべ${q.quarantined} 今${q.active} 飛ばした経路${(q.skippedRoutes || 0).toLocaleString()}本(のべ${(q.skippedEvals || 0).toLocaleString()}回)]`;
    }
  } catch (e) {}
  try {
    // 項目名は実物に合わせる(最初 probed/failed/onHold と書いて存在しなかった)。
    const fp = getFeeProbeStats();
    const known = (fp?.byAmountOut ?? 0) + (fp?.byLogs ?? 0);
    if (known || fp?.noTrades || fp?.implausible || fp?.errors) {
      out += ` 手数料実測[判明${known}(30bps以外${fp.non30 ?? 0}) 取引なしで保留${fp.noTrades ?? 0} 疑わしい${fp.implausible ?? 0} 失敗${fp.errors ?? 0}]`;
    }
  } catch (e) {}
  return out;
}

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
  // **向きも交代で確かめる(2026年9月21日)。**
  //
  // [なぜ要るか]
  // 信用できる上限は**向きごと**に付くのに、この検証は zeroForOne=true しか
  // 測っていなかった。つまり**逆向きに付いた上限は一度も外れない**。
  // 下げる一方のラチェットになり、使うほど判定できる額が痩せていく
  // (同じ型の欠陥を9月21日に「順位の数え方」で1件直している)。
  const zeroForOne = (v3VerifyCursor % 2) === 0;
  const candidates = [];
  for (const chain of chainReady) {
    for (const pool of getPoolsByKind(chain, KIND_V3)) {
      if (disabledPools.has(poolKeyOf(chain, pool.address))) continue;
      if (!hasQuoteTable(chain, pool.address, zeroForOne)) continue;
      // フォークのプールは公式Quoterで引けないため、この検証の対象外にする。
      if (isForkFactory(chain, pool.factory)) continue;
      candidates.push(pool);
    }
  }
  if (candidates.length === 0) return;

  // **使っているプールを先に確かめる。** 使っていないプールの精度は利益に効かない。
  const now = Date.now();
  const used = candidates.filter((p) => {
    const t = recentlyUsedV3.get(poolKeyOf(p.chain, p.address));
    return t != null && now - t < RECENT_USE_MS;
  });
  const list = used.length > 0 ? used : candidates;
  // **同じ数え札で「プール」と「向き」を選んではいけない。**
  // どちらも1ずつ進むと噛み合ってしまい、プール数が偶数の時は
  // 「このプールは必ず順方向、隣は必ず逆方向」と固定される(偶奇の取り違え)。
  // 札を2で割って進めれば、1つのプールを順・逆の順に続けて測れる。
  const pool = list[Math.floor(v3VerifyCursor / 2) % list.length];
  v3VerifyCursor++;

  // **小さい順に確かめ、「どこまでなら信用できるか」を決める。**
  //
  // [なぜ捨てるのをやめたか(2026年9月21日の実測)]
  // 前の版はずれが50bpsを超えると価格表を丸ごと捨てていた。実測で3つの欠陥が出た。
  //
  //  ① **使わない額のずれで捨てていた。** 捨てた2件とも $20 では誤差20bps以内で、
  //     $200/$700 のずれだけが理由だった。実際の取引額は $1〜30。
  //  ② **向きを区別していなかった。** 2件とも「補間が公式より過小」、つまり
  //     **こちらの見積もりが辛い側**。この向きは機会を取り逃すだけで、
  //     損はしない。危ないのは逆の「過大」(幻の利益)だけ。
  //  ③ **測っていない向きの表まで消していた。** 検証は zeroForOne=true しか
  //     測っていないのに、clearQuoteTable は両方向を消していた。
  //
  // そして根本の問題として、**捨ててもずれは直らない**。作り直しても同じ形の
  // 補間なので、また捨てることになる(堂々巡り)。その間そのプールを通る経路は
  // 1本も判定されない。
  //
  // 正しいのは、消すことではなく **信用できる範囲まで投入量を抑えること**。
  // その仕組み(routeMaxAmountIn → getTableRange().max)は既にあった。
  const amounts = [...VERIFY_AMOUNTS_USD].sort((a, b) => a - b);
  let lastOkAmountIn = null;   // ここまでは信用できる、と分かった投入量
  let cappedAt = null;         // 過大が出た投入額($)
  const curve = [];            // 投入額ごとの誤差(大きさとの関係を見るため)

  const tokenIn = zeroForOne ? pool.token0 : pool.token1;
  const tokenOut = zeroForOne ? pool.token1 : pool.token0;
  const dirNote = zeroForOne ? "" : "(逆向き)";

  for (const usd of amounts) {
    // 表の点そのものではなく、点と点の間の値で確かめる。
    const amountIn = usdToAmount(pool.chain, tokenIn, usd);
    if (!amountIn) continue;

    let result;
    try {
      result = await verifyQuoteTable({
        chain: pool.chain, pool: pool.address, zeroForOne,
        tokenIn, tokenOut, feeTier: pool.feeTier, amountIn,
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
      console.log(`[V3検証] ${pool.chain} ${pool.address.slice(0, 10)}…${dirNote}(${(pool.feeBps / 100).toFixed(2)}%) 投入$${usd}: 補間が公式より${bps > 0 ? "過大" : "過小"}${Math.abs(bps).toFixed(1)}bps`);
    }

    // **過大だけが危ない。** 過小は見積もりが辛いだけで、損にはならない。
    const tooHigh = bps > VERIFY_DROP_TABLE_BPS;
    if (bps < -VERIFY_DROP_TABLE_BPS) stats.v3VerifyUnderCount++;

    curve.push(`$${usd}:${bps >= 0 ? "+" : ""}${bps.toFixed(1)}bps`);
    if (tooHigh) { cappedAt = usd; break; }
    lastOkAmountIn = amountIn;   // ここまでは信用してよい
  }

  // **どの額から壊れるかを1行で残す。** これが「大きい額で失敗する」の証拠になる。
  if (curve.length > 1) {
    console.log(`[V3検証/大きさ] ${pool.chain} ${pool.address.slice(0, 10)}…${dirNote}(${(pool.feeBps / 100).toFixed(2)}%): ${curve.join(" / ")}${cappedAt != null ? ` → **$${cappedAt}で過大**` : ""}`);
  }

  if (cappedAt != null) {
    if (lastOkAmountIn != null) {
      // 信用できるところまでで頭打ちにする。**プールは地図に残る。**
      //
      // **定期検証は「下げる」ことしかしない。**
      // 答え合わせ(実際に取ろうとした経路の、実際の額での誤差)が
      // すでにもっと厳しい上限を学んでいるなら、そちらを尊重する。
      // 定期検証は $5/$20/$200/$700 の固定点しか見ないが、
      // 答え合わせは**本当に使った額**を見ている。情報の濃さが違う。
      // (全ての額で誤差が収まった時だけ、下の分岐で制限を外す)
      const learned = getTableTrustedMax(pool.chain, pool.address, zeroForOne);
      const next = learned != null && learned < lastOkAmountIn ? learned : lastOkAmountIn;
      setTableTrustedMax(pool.chain, pool.address, zeroForOne, next);
      stats.v3VerifyCapped++;
      console.log(
        `[V3検証] ${pool.chain} ${pool.address.slice(0, 10)}…${dirNote}(${(pool.feeBps / 100).toFixed(2)}%): ` +
        `投入$${cappedAt}で過大のため、**信用できる上限を${next === lastOkAmountIn ? `$${amounts.filter((a) => a < cappedAt).pop()}相当` : "答え合わせで学んだ値"}に下げました**` +
        `(プールは判定に使い続けます)`
      );
    } else {
      // いちばん小さい額でも過大。この向きは使えないので、**その向きだけ**捨てる。
      clearQuoteTableDirection(pool.chain, pool.address, zeroForOne);
      stats.v3VerifyDropped++;
      console.log(
        `[V3検証] ${pool.chain} ${pool.address.slice(0, 10)}…${dirNote}(${(pool.feeBps / 100).toFixed(2)}%): ` +
        `最小の投入$${cappedAt}でも過大のため、この向きの価格表を捨てました(逆向きは残します)`
      );
    }
  } else if (lastOkAmountIn != null) {
    // 全部通った。前に付けた制限があれば外す(流動性が改善した場合に戻せる)。
    // **上限を外してよいのは、上限の元になった額を測り直して通った時だけ。**
    // verifyQuoteTable は上限を無視して測るので、ここまで来たら本当に全部通っている。
    const had = getTableTrustedMax(pool.chain, pool.address, zeroForOne);
    setTableTrustedMax(pool.chain, pool.address, zeroForOne, null);
    if (had != null) {
      console.log(`[V3検証] ${pool.chain} ${pool.address.slice(0, 10)}…${dirNote}: 全ての額で誤差が収まったので、信用できる上限の制限を**外しました**`);
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

    const { loaded: v3Loaded, dropped: v3Dropped } = await loadV3StatesForChain(chain);
    const decimalsFound = await loadTokenDecimals(chain);

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
    if (ageHours > MAP_REBUILD_AFTER_HOURS) needBuild = true;
  }
  if (needBuild) {
    // [2026年9月21日に整理] ここで「ファクトリーからの全プール取り込み」を呼んでいたが、
    // 種となる verified-pairs.json を書く処理がどこにも無く、一度も動いていなかった。
    // プールの発見は pool-scout.js(住所を指定しない getLogs で取引のある
    // プールを全て見る)が担っているので、この道ごと削除した。
  }

  for (const [chain, addresses] of Object.entries(getAllPoolAddressesByChain())) {
    for (const address of addresses) {
      if (isKnownIncompatiblePool(chain, address)) disablePool(chain, address, "過去の記録から復元", { fromFile: true });
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
      await discoverV3PoolsForChain(chain);
    } catch (e) {
      console.warn(`[探索] ${chain}: 失敗 ${e.message.slice(0, 80)}`);
    }
  }));

  // ファクトリーの住所を知らないプールを、取引のイベントから見つけて足す。
  // 絞り込みより先に行う(V3が増えると、組めるV2も増えるため)。
  try {
    await scoutAllChains(Object.keys(CHAIN_CONFIG));
  } catch (e) {
    console.warn(`[プール発見] 失敗 ${(e.message || "").slice(0, 80)}`);
  }

  const full = snapshotFullMap();
  const { kept, removed } = pruneToCandidates();
  stats.prunedKept = kept;
  console.log(`[絞り込み] 全${full}プールのうち、裁定候補${kept}プールを残し${removed}プールを監視対象から外しました`);

  const s = getStats();
  console.log(`[プール地図] 候補: V2 ${s.byKind.v2}件 / V3 ${s.byKind.v3}件 / ${s.arbitragablePairs}ペア(うちV2とV3が共存${s.mixedPairs}件)`);

  await Promise.all(Object.keys(CHAIN_CONFIG).map((chain) => prepareChain(chain)));

  // 価格表の復元は、V3の状態を読んだ後(prepareChain の後)に行う。
  // 今の価格と比べて「動いていない表」だけを戻すため。
  loadQuoteTables();

  const priced = refreshTokenPrices();
  console.log(`[始点] 桁数と価格が揃い、経路の始点として使えるトークン: ${priced}件`);
  console.log(`[V3価格表] 公式Quoterで作成を開始します(V3プール${s.byKind.v3}件 × 2方向、まとめて問い合わせ)`);

  savePoolMap();
}

// ===== V2の手数料の実測 =====
// ===== K検算で拒否された経路の手数料を、チェーンから読み直す =====
//
// [なぜ要るか(2026年9月21日、実測で判明)]
// K() で拒否 → `forceFeeReprobe` → `clearFeeProbed` と繋いだが、**何も起きなかった**。
// `clearFeeProbed` は「実測済み」の印を**外す**関数で、
// このプールは**一度も実測されていなかった**(生存ログ `手数料1(残0)`)。
// **外す印が無いので、空振りしていた。**
//
// 既存の実測はスワップのログから逆算する方式で、Aerodrome では当たらない。
// **プール自身と工場に聞けば、推測も逆算も要らない。**
const feeFixQueue = new Map(); // key -> { chain, address }
const feeFixDone = new Set();  // 一度読んだプールは繰り返さない
const FEE_FIX_INTERVAL_MS = parseInt(process.env.FEE_FIX_INTERVAL_MS || "15000", 10);
const FEE_FIX_PER_TICK = parseInt(process.env.FEE_FIX_PER_TICK || "2", 10);
/// チェーンからも読めないプールに当てる手数料(bps)。
/// **K検算は等号の判定なので、2bps低いだけでも拒否される**(実測で確認)。
/// 読めないなら高めに倒す。高すぎれば機会を逃すだけだが、低すぎるとガスを捨て続ける。
const UNREADABLE_FEE_BPS = parseInt(process.env.UNREADABLE_FEE_BPS || "50", 10);

/// K検算で拒否された経路の V2 プールを、チェーン読み直しの列に積む。
function queueOnchainFeeFix(opp) {
  for (const leg of opp.legs || []) {
    if (leg.kind === KIND_V3 || !leg.pool) continue;
    const key = poolKeyOf(opp.chain, leg.pool);
    if (feeFixDone.has(key) || feeFixQueue.has(key)) continue;
    feeFixQueue.set(key, { chain: opp.chain, address: leg.pool });
  }
}

/// 積まれたプールの手数料をチェーンから読み、地図に入れる。
async function runOnchainFeeFixes() {
  if (feeFixQueue.size === 0) return;
  const batch = [...feeFixQueue.entries()].slice(0, FEE_FIX_PER_TICK);
  for (const [key] of batch) feeFixQueue.delete(key);

  for (const [key, { chain, address }] of batch) {
    feeFixDone.add(key);
    const pool = getPool(chain, address);
    if (!pool) continue;
    let info = null;
    try {
      info = await readPoolFeeOnchain(chain, address, pool.factory);
    } catch (e) {
      console.warn(`[手数料/直読み] ${chain} ${address.slice(0, 10)}…: 読めません(${(e.message || "").slice(0, 60)})`);
      continue;
    }
    if (!info) {
      const safe = Math.max(pool.feeBps || 0, UNREADABLE_FEE_BPS);
      setPoolFee(chain, address, safe);
      stats.feeUnreadable++;  // 印は付けない(当て推量なので訂正されるべき)
      console.warn(`[手数料/直読み] ${chain} ${address.slice(0, 10)}…: 手数料も stable も読めません。**当て推量の${safe}bps**を当てます(実測で訂正されます)`);
      continue;
    }
    // stable プールは x³y+y³x 曲線。**x·y=k の式では値段を出せない。**
    // 手数料をいくら直しても合わないので、地図から外す。
    if (info.stable) {
      disablePool(chain, address, `stable曲線のプール(x·y=kの式が通用しない)`, { permanent: true });
      console.log(`[手数料/直読み] ${chain} ${address.slice(0, 10)}…: **stable曲線**と判明。判定に使えないので外します`);
      continue;
    }
    if (info.feeBps == null) {
      // **読めないなら、安全側に倒す。**
      // K検算は等号の判定なので、**2bps低いだけでも拒否される**(実測で確認)。
      // 読めないプールに楽観的な既定を当てると、送信を無駄にし続ける。
      const safe = Math.max(pool.feeBps || 0, UNREADABLE_FEE_BPS);
      setPoolFee(chain, address, safe);
      // **印は付けない。** これはチェーンから読んだ値ではなく**当て推量**。
      // 一次情報の印を付けると訂正できなくなる(実際そうしてしまっていた)。
      stats.feeUnreadable++;
      console.warn(`[手数料/直読み] ${chain} ${address.slice(0, 10)}…: 手数料を読めません(${info.source})。**当て推量の${safe}bps**を当てます(実測で訂正されます)`);
      continue;
    }
    const before = pool.feeBps;
    setPoolFee(chain, address, info.feeBps);
    // **一次情報として印を付ける。** 以降、推測(赤字が続いた等)では外れない。
    markFeeFromChain(chain, address);
    stats.feeProbed++;
    stats.feeFixedOnchain++;
    console.log(`[手数料/直読み] ${chain} ${address.slice(0, 10)}…: ${before}bps → **${info.feeBps}bps**(${info.source})。K検算で拒否されていた経路が通るようになります`);
    if (info.feeBps > TAX_TOKEN_FEE_BPS) {
      disablePool(chain, address, `実測手数料${info.feeBps}bps(税トークン)`, { permanent: true });
    }
  }
}

// ===== 送信直前の実測の「不足」から、V2の手数料を学ぶ =====
//
// [なぜ要るか(2026年9月21日の実測)]
// base の `uniswap-v3(X%)→aerodrome→sync発見` が、V3側の手数料帯を
// 0.01% / 0.05% / 0.30% と変えても **不足 -248.9 / -256.2 / -260.5bps** と
// ほぼ同じだった。**V3の段を変えても誤差が変わらない = 誤差はV2の段にある。**
//
// Aerodrome は工場から 30bps と読めている。残るのは `sync発見` の
// 0xde66c35e で、**このプールは stable() も factory() も fee() も答えない**。
// つまり当て推量の 50bps を当てていた。50 + 250 ≈ **300bps**。
//
// `[段ごとの答え合わせ]` はV2の段の手数料誤差を**見られない**。
// 見込みも実測も**同じ手数料の前提**で計算しているので差が出ない
// (実際、全部の段が +0.0bps と出ていた)。
// **不足の実測(simulateRoute の結果)だけが、この誤差を知っている。**
const LEARN_FEE_MIN_BPS = parseFloat(process.env.LEARN_FEE_MIN_BPS || "50");
const LEARN_FEE_MAX_BPS = parseInt(process.env.LEARN_FEE_MAX_BPS || "2000", 10);

/// 不足の実測から、手数料の分からないV2プールの手数料を引き上げる。
/// **原因を1つに絞れる時だけ**行う(未確定のV2が1本だけの経路)。
function learnV2FeeFromShortfall(opp) {
  const short = Number(opp?.shortfallBps);
  if (!Number.isFinite(short) || short > -LEARN_FEE_MIN_BPS) return;

  const unknown = [];
  for (const leg of opp.legs || []) {
    if (leg.kind === KIND_V3 || !leg.pool) continue;
    const pool = getPool(opp.chain, leg.pool);
    if (!pool || pool.feeFromChain) continue;   // 確かな値は触らない
    unknown.push({ leg, pool });
  }
  // **2本以上あると、どちらのせいか決められない。** 決められない時は何もしない。
  if (unknown.length !== 1) return;

  const { leg, pool } = unknown[0];
  const before = pool.feeBps || 0;
  const next = Math.min(LEARN_FEE_MAX_BPS, before + Math.round(Math.abs(short)));
  if (next <= before) return;

  setPoolFee(opp.chain, leg.pool, next);
  stats.feeLearned++;
  console.log(
    `[手数料/不足から学習] ${opp.chain} ${leg.dexId}:${leg.pool.slice(0, 10)}…: ` +
    `実測で**${Math.abs(short).toFixed(1)}bps 不足**。手数料 ${before}bps → **${next}bps** に引き上げます` +
    `(この経路で手数料が未確定のV2はこの1本だけ)`
  );
  if (next > TAX_TOKEN_FEE_BPS) {
    disablePool(opp.chain, leg.pool, `実測手数料${next}bps(税トークン)`, { permanent: true });
    console.log(`[手数料/不足から学習] ${opp.chain} ${leg.pool.slice(0, 10)}…: ${next}bps は上限${TAX_TOKEN_FEE_BPS}bpsを超えるため、**税トークンとして外します**`);
  }
}

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
      // **取引の記録から測れないなら、プールと工場に直接聞く。**
      //
      // [なぜ(2026年9月21日、生存ログに出して初めて見えた)]
      //   手数料実測[判明4(30bps以外3) **取引なしで保留42** 疑わしい1 失敗0]
      // 42プールが「直近の取引が無い」という理由で測れないまま、
      // 安全側の既定(45bps)を使い続けていた。
      // **直近の取引が無くても、工場は手数料を知っている。**
      // 直読みの仕組みは既に作ってあったのに、K検算で拒否された時しか
      // 呼んでいなかった。「作ったのに使っていない」の一種。
      if (fee == null) {
        const key = poolKeyOf(chain, address);
        if (!feeFixDone.has(key) && !feeFixQueue.has(key)) {
          feeFixQueue.set(key, { chain, address });
        }
      }
      if (fee != null) {
        if (fee !== 30) setPoolFee(chain, address, fee);
        pool.feeProbed = true;
        stats.feeProbed++;
        if (fee > TAX_TOKEN_FEE_BPS) {
          disablePool(chain, address, `実測手数料${fee}bps(税トークン)`, { permanent: true });
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
// [同じチェーンで1件ずつ → 同じプールを使わなければ並行(2026年9月19日)]
// nonce の取り合いは execute-opportunity.js の NonceManager が防ぐようになった
// ので、チェーン単位の錠は要らない。代わりに**プール単位**で錠をかける。
// 同じプールを使う経路を同時に送ると、先に着いた方が価格を動かして
// 後の方が巻き戻り、ガス代だけ失うため。
// 同時に飛ばす本数には上限を置く(1本が詰まった時の被害を限るため)。
const MAX_PARALLEL_SENDS_PER_CHAIN = parseInt(process.env.MAX_PARALLEL_SENDS_PER_CHAIN || "3", 10);
const executingPools = new Set();   // "chain::pool" 送信中の経路が使っているプール
const inFlightByChain = new Map();  // chain -> 送信中の本数

/// **内訳の合計と「精査」のずれ。** 合っていれば何も出さない。
///
/// [なぜ要るか(2026年9月23日)]
/// `無効562` を追った時、**精査が+110件増えているのに内訳の全項目が止まっていた**。
/// 調べると `税トークン` `同じ経路を送信中` `送信して失敗` の3つを
/// **加算しているのに生存ログに出していなかった**(「測っているのに使っていない」8件目)。
/// 出していない箱があると、**機会がどこへ消えたかを追えない**。
///
/// 3つを出すようにした上で、**合計が合っているかもここで見張る**。
/// 今後また箱を足して出し忘れたら、ここに `残N` として現れる。
/// (送信中のものが数件あるので、小さいずれは正常)
function reasonsResidual() {
  const counted = reasons.disabled + reasons.taxToken + reasons.cooldown + reasons.trap
    + reasons.notProfitable + reasons.belowMin + reasons.executing + reasons.sendBusy
    + reasons.success + reasons.notSent + reasons.failed;
  // **いま送信中のものは、まだどの箱にも入っていない。** これは正常なので差し引く。
  // 引かないと「送信が混んでいる時ほど穴が空いて見える」ことになる。
  let inFlight = 0;
  for (const n of inFlightByChain.values()) inFlight += n;
  const diff = stats.examined - counted - inFlight;
  return diff === 0 ? "" : ` 残${diff}`;
}

function poolLockKeys(opp) {
  return opp.poolAddresses.map((a) => `${opp.chain}::${a.toLowerCase()}`);
}

async function handleOpportunity(opp, meta = {}) {
  stats.examined++;
  // **引き金の大きさを機会に写す。**
  //
  // [2026年9月22日] `pool-registry` は前から `lastMovePct`(1回の取引でプールの価格が
  // 何%動いたか)を計算し、`reactToPoolChange` はそれを meta に入れて渡していた。
  // **だが誰も読まなかった。** 大口スワップを別に検知する仕組みを作る必要はなく、
  // **既にある値をここで読むだけ**でよかった(「測っているのに使っていない」7件目)。
  // これが Backrun の信号そのもの。段の集計(opportunity-tiers)がこれを使う。
  if (opp.movePct == null && Number.isFinite(Number(meta.movePct))) opp.movePct = Number(meta.movePct);
  if (opp.source == null && meta.source != null) opp.source = meta.source;
  noteV3PoolsUsed(opp);
  // **捨てる道すべてで大物を数える。** 記録の無い道があると、
  // 「大きな機会が消えた」を後から確かめられない(2026年9月21日に判明)。
  if (hasDisabledPool(opp)) { reasons.disabled++; noteBigOutcome(opp, "disabled"); return; }
  if (pruneTaxTokenPools(opp)) { reasons.taxToken++; record(opp, "tax_token"); noteBigOutcome(opp, "tax_token"); return; }

  const key = opp.poolAddresses.join("|").toLowerCase();
  const cool = cooldownUntil.get(key);
  if (cool && Date.now() < cool.until) {
    reasons.cooldown++;
    noteBigOutcome(opp, "cooldown", `あと${Math.ceil((cool.until - Date.now()) / 1000)}秒${cool.sticky ? "(送信失敗)" : ""}`);
    return;
  }
  if (cool) cooldownUntil.delete(key);

  if (rejectIfTrap(opp)) { reasons.trap++; record(opp, "trap"); noteBigOutcome(opp, "trap"); return; }
  // **黒字にならなかった。** ここは今まで無言で帰っていた
  // (2026年9月23日、`残N` の見張りを入れて発覚。精査の3割がここだった)。
  // 粗利は出たが、手数料とガス代を入れたら黒字にならなかった機会。
  // **いちばん件数の多い出口**なので、数えないと内訳が意味を成さない。
  if (!opp.profitable) { reasons.notProfitable++; return; }

  stats.profitableFound++;
  if (opp.hasV3) stats.v3Opportunities++;
  stats.recent = [{ ...opp, at: new Date().toISOString(), ...meta }, ...stats.recent.filter((r) => r.label !== opp.label)].slice(0, 20);

  if (opp.netProfitUsd < minProfitUsd()) {
    reasons.belowMin++;
    record(opp, "below_min", meta);
    noteBelowMin(opp);
    noteBigOutcome(opp, "below_min");
    return;
  }
  if (executing.has(key)) { reasons.executing++; noteBigOutcome(opp, "executing"); return; }
  // 同じプールを使う送信が進行中か、同時送信の上限に達していれば見送る。
  const lockKeys = poolLockKeys(opp);
  const inFlight = inFlightByChain.get(opp.chain) || 0;
  const hitParallel = inFlight >= MAX_PARALLEL_SENDS_PER_CHAIN;
  const hitPool = lockKeys.some((k) => executingPools.has(k));
  if (hitParallel || hitPool) {
    reasons.sendBusy++;
    // **どちらで止まったのかを分けて数える。** 直し方が正反対のため。
    if (hitPool) reasons.sendBusyPool++; else reasons.sendBusyParallel++;
    noteBigOutcome(opp, "send_busy", hitPool ? "同じプールが使用中" : `同時${inFlight}本の上限`);
    return;
  }
  executing.add(key);
  for (const k of lockKeys) executingPools.add(k);
  inFlightByChain.set(opp.chain, inFlight + 1);
  try {
    console.log(`[機会] ${opp.kind} ${opp.chain} ${opp.label}: 純利益+$${opp.netProfitUsd.toFixed(4)}(投入$${opp.tradeAmountUsd.toFixed(2)} 壁${opp.feeWallPercent.toFixed(2)}%${opp.hasV3 ? " V3含む" : ""})`);
    const ok = await Promise.race([
      executeOpportunity(opp),
      new Promise((_, reject) => setTimeout(() => reject(new ExecutionError("実行が制限時間を超えました", { stage: "timeout" })), EXECUTION_TIMEOUT_MS)),
    ]);
    if (ok) {
      stats.executed++; reasons.success++;
      // **収支の実測。** 手元に残った純利益を足す。
      noteSendOutcome(opp.chain, true, opp.actualNetProfitUsd ?? opp.netProfitUsd ?? 0);
      noteChainSendResult(opp.chain, true, opp.actualNetProfitUsd ?? opp.netProfitUsd ?? 0);
      cooldownUntil.delete(key);
      record(opp, "success", meta);
      noteBigOutcome(opp, "success");
    } else {
      reasons.notSent++;
      // 価格が原因なので、経路のプールが動けば上の clearPriceCooldownForPool が解く。
      cooldownUntil.set(key, { until: Date.now() + 30 * 1000, sticky: false });
      record(opp, notSentOutcome(opp), meta);
      noteBigOutcome(opp, "not_sent", opp.shortfallBps != null ? `不足${opp.shortfallBps.toFixed(1)}bps` : "");
      // **不足の実測は、V2の手数料の誤差を知っている唯一の情報。** 捨てない。
      try { learnV2FeeFromShortfall(opp); } catch (e) {}
    }
  } catch (e) {
    stats.failed++; reasons.failed++;
    const msg = (e.message || "").slice(0, 120);
    const stage = e instanceof ExecutionError ? e.stage : "unknown";
    console.warn(`[実行] 失敗(${stage}): ${msg}`);
    noteExecutionFailure(opp, e);
    noteBigOutcome(opp, "failed", stage);
    // 制限時間超過など、送信側の catch を通らない失敗でも手元の nonce を
    // 鎖上の値に合わせ直す。放置すると以降の送信が詰まる。
    try { resetNonce(opp.chain); } catch (inner) {}
    // **勝率の実測(負けた側)。**
    // ガス代を失うのは `wait`(送った後に取り消された)だけ。
    // simulate / estimateGas / send での失敗はガス代がかからないので数えない。
    if (stage === "wait") {
      noteSendOutcome(opp.chain, false, opp.gasCostUsd ?? 0);
      noteChainSendResult(opp.chain, false, opp.gasCostUsd ?? 0);
    }
    // **「失敗」と「負け」を同じ箱に入れない。**
    // `wait`(確定待ちで取り消された)は、送った後に他者が先に取った時に起きる。
    // 直し方が「取り消しの中身から原因を特定する」ではなく「速さ」なので分ける。
    record(opp, stage === "wait" ? "race_lost" : "failed", { ...meta, error: msg, stage });
  } finally {
    executing.delete(key);
    for (const k of lockKeys) executingPools.delete(k);
    inFlightByChain.set(opp.chain, Math.max(0, (inFlightByChain.get(opp.chain) || 1) - 1));
  }
}

function reactToPoolChange(chain, poolAddress, pool, receivedAt, source) {
  if (!isReady(chain)) return;
  const movePct = pool.lastMovePct || 0;
  // **このプールが動いた。** 価格が理由で寝かせていた経路は、もう寝かせる理由がない。
  clearPriceCooldownForPool(poolAddress);
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
  if (!pool) return false;
  reactToPoolChange(chain, poolAddress, pool, receivedAt, "sync");
  return true;
}

function handleV3Swap(chain, poolAddress, sqrtPriceX96, liquidity, receivedAt) {
  if (disabledPools.has(poolKeyOf(chain, poolAddress))) return false;
  const pool = updateV3FromSwap(chain, poolAddress, sqrtPriceX96, liquidity);
  if (!pool) return false;
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
  } catch (e) {
  } finally {
    refreshRunning = false;
  }
}

// ===== コントラクトに溜まった利益 =====
//
// [画面の「累積利益」はこれ(2026年9月23日、オーナーの指示)]
// 裁定の利益はコントラクトに貯まり、**一度も引き出していない**。だから今コントラクトにある残高が、
// そのまま「これまでに貯めた利益」になる。記録を足し上げる方式は、記録を500件で捨てていたため
// 総額が勝手に変わった。残高はチェーンが持つ実物なので、記録の欠けに左右されない。
// ガス代はウォレットから払っているので、この残高には**含まれない**(ガス代は別に表示)。
//
// 旧コントラクト(再デプロイ前の版)にも利益が残っているので、一緒に数える。
// 住所は docs/HANDOVER.md の記録(完全な住所が残っているものだけ)。
const OLD_CONTRACTS = {
  polygon: ["0xD2D45cC99AAe1AF7302b067d116fEEA8d7ceAca1"],
  avalanche: ["0xD2D45cC99AAe1AF7302b067d116fEEA8d7ceAca1"],
  optimism: ["0xD2D45cC99AAe1AF7302b067d116fEEA8d7ceAca1"],
  base: ["0x68bCbb3f8ec1E783E176Ca76b0ecDc758fdf9B6F"],
};
const ERC20_BALANCE_IFACE = new ethers.Interface(["function balanceOf(address) view returns (uint256)"]);
const MC3_ABI = ["function aggregate3((address target,bool allowFailure,bytes callData)[] calls) view returns ((bool success,bytes returnData)[])"];
const MC3_ADDRESS = "0xcA11bde05977b3631167028862bE2a173976CA11";
let contractBalances = {};
let contractBalancesAt = null;
async function refreshContractBalances() {
  if (!anyReady()) return;
  const out = {};
  for (const [chain, config] of Object.entries(CHAIN_CONFIG)) {
    const current = process.env[config.contractAddressEnvVar];
    const addresses = [...new Set([current, ...(OLD_CONTRACTS[chain] || [])].filter(Boolean).map((a) => a.toLowerCase()))];
    if (addresses.length === 0) continue;
    const tokens = Object.entries(getKnownTokens(chain));
    if (tokens.length === 0) continue;
    try {
      // 版に関係なく読めるよう、各通貨の balanceOf を束ねて読む
      const calls = [];
      for (const addr of addresses) for (const [t] of tokens) {
        calls.push({ target: t, allowFailure: true, callData: ERC20_BALANCE_IFACE.encodeFunctionData("balanceOf", [addr]) });
      }
      const results = [];
      for (let i = 0; i < calls.length; i += 400) {
        const part = calls.slice(i, i + 400);
        results.push(...await callWithRpc(chain, (p) => new ethers.Contract(MC3_ADDRESS, MC3_ABI, p).aggregate3(part)));
      }
      const bySymbol = new Map();
      results.forEach((r, i) => {
        if (!r?.success || r.returnData === "0x") return;
        const amountRaw = BigInt(ERC20_BALANCE_IFACE.decodeFunctionResult("balanceOf", r.returnData)[0]);
        if (amountRaw === 0n) return;
        const [tokenAddr, info] = tokens[i % tokens.length];
        const amount = Number(amountRaw) / Math.pow(10, info.decimals);
        const price = getTokenPriceUsd(chain, tokenAddr);
        const e = bySymbol.get(info.symbol) || { symbol: info.symbol, amount: 0, usd: 0, unpriced: false };
        e.amount += amount;
        if (price == null) e.unpriced = true; else e.usd += amount * price;
        bySymbol.set(info.symbol, e);
      });
      const held = [...bySymbol.values()].sort((x, y) => y.usd - x.usd);
      if (held.length > 0) out[chain] = held;
    } catch (e) {
      // 読めなかったチェーンは前回の値を残す(黙って0にしない)
      if (contractBalances[chain]) out[chain] = contractBalances[chain];
    }
  }
  contractBalances = out;
  contractBalancesAt = Date.now();
}

/// コントラクトに貯まった利益の合計(ドル)。
function heldProfitUsd() {
  return Object.values(contractBalances).flat().reduce((a, h) => a + (h.usd || 0), 0);
}

// ===== 生存確認 =====
function heartbeat() {
  stats.lastHeartbeat = new Date().toISOString();
  const rpc = getRpcStatus();
  const queued = Object.entries(rpc).filter(([, v]) => v.queued > 0).map(([c, v]) => `${c}:${v.normalQueued}`).join(" ");
  const stageLine = Object.entries(failStages).map(([k, v]) => `${k}:${v}`).join(" ") || "なし";
  const sync = getSyncStats();
  // 確定前(pending)のイベントの先読み統計。取れているチェーンだけ出す。
  const pendingLine = Object.entries(getPendingStats()).filter(([, p]) => p.polls > 0).map(([c, p]) =>
    `${c}:事前${p.events}件 確定で照合${p.sealedHits}件 先行平均${p.leadAvgMs ?? "-"}ms(最大${p.leadMaxMs}ms) ${p.push ? "押し出し" : "取得"}${p.polls}回 失敗${p.errors}`).join(" ");
  const ev = Object.entries(sync).map(([c, v]) => `${c}:${v.received}`).join(" ") || "なし";
  const mc = getMulticallStats();
  // RPCの月間使用量を更新する。呼び出しとWebSocket受信の両方が枠を消費する。
  // 生存ログは稼働の健全性を見る唯一の手段なので、使用量の計測が失敗しても
  // ログ自体は必ず出るようにする。
  let usageLine = "";
  let usageSummary = null;
  try {
    const wsEvents = Object.values(sync).reduce((sum, v) => sum + (v.received || 0), 0);
    usageSummary = updateRpcUsage(getRpcCallTotals().total, wsEvents);
    usageLine = " " + formatRpcUsageLine(usageSummary);
  } catch (e) {
    usageLine = " 枠[計測できず: " + e.message + "]";
  }
  // オーナーが動かないと解決しないことだけを見張る(通知は LINE)。
  try { checkOwnerAlerts(usageSummary); } catch (e) {}
  let alertLine = "";
  try {
    const a = getAlertStats();
    // 未設定のうちは黙っている。設定後、送った件数か失敗があれば出す。
    if (a.configured && (a.sentToday > 0 || a.errors > 0)) {
      alertLine = ` 通知[本日${a.sentToday}通 失敗${a.errors}${a.lastError ? `:${a.lastError.slice(0, 40)}` : ""}]`;
    } else if (!a.configured) {
      alertLine = " 通知[LINE未設定]";
    }
  } catch (e) {}

  // 価格表は「プール×方向」ごとに要る。分母が無いと揃っているように見えてしまう。
  // V3の段は価格表が無いと使えないので、欠けている分はそのまま経路が組めない。
  let v3Total = 0;
  for (const chain of chainReady) v3Total += getPoolsByKind(chain, KIND_V3).length;
  const rc = getRouteCalcStats();
  console.log(`[生存 ${nowJst()}] 稼働${[...chainReady].join(",") || "なし"} 始点${countUsableStarts()} 価格表${countQuoteTables()}/${v3Total * 2}(待${stats.quoteTablesPending} 要求で作成${stats.quoteTablesOnDemand}/${getQuoteDemandTotal()} 定期で作り直し${stats.quoteRebuildsFromPolling}${QUOTE_TABLE_FILL_ALL ? "" : " 作り置き停止"}) スキャン${stats.scans} 経路計算${rc.computed.toLocaleString()}→粗利プラス${rc.grossProfitable}(上限張付${rc.hitCap.toLocaleString()}) 精査${stats.examined} 黒字${stats.profitableFound} 実行${stats.executed}/${stats.failed} 内訳[無効${reasons.disabled} 税${reasons.taxToken} 冷却${reasons.cooldown} 罠${reasons.trap} 非黒字${reasons.notProfitable} 下限${reasons.belowMin} 同経路${reasons.executing} 送信中${reasons.sendBusy}(同時上限${reasons.sendBusyParallel}/同プール${reasons.sendBusyPool}) 見送${reasons.notSent} 失敗${reasons.failed}${reasonsResidual()}]${belowMinSummary()} 失敗段階[${stageLine}] 受信[${ev}]${pendingLine ? ` 先読み[${pendingLine}]` : ""} 手数料${stats.feeProbed}(残${stats.feeProbePending}${stats.feeFixedOnchain ? ` 直読み${stats.feeFixedOnchain}` : ""}${stats.feeUnreadable ? ` 読めず${stats.feeUnreadable}` : ""}${stats.feeLearned ? ` 学習${stats.feeLearned}` : ""}${feeFixQueue.size ? ` 待${feeFixQueue.size}` : ""}) 行列[${queued || "空"}] 束ね[${mc.calls}回で${mc.subcalls}件]${usageLine}${v3TableLine()}${quarantineFeeLine()}${disableLine()}${formatTierLine()}${formatSendBalanceLine()}${formatSendSkipLine()}${formatUniswapXLine()}${formatMissingPairsLine()}${formatSolanaLine()}${formatMainnetEdgeLine()}${formatAaveLine()}${formatLiquidationLine()}${formatMorphoLine()}${formatCompoundLine()}${formatSparkLine()}${formatSpeedLine()}${alertLine}`);

  // 現在価格によるふるいの通過率。
  //
  // [何のための数字か]
  // 見積もりを「常時作り置き」から「候補が出てから」へ変える設計の前提。
  // 切り替えると、ふるいを通った回数がそのまま見積もりの回数(=RPC)になる。
  // **段ごとの毎分の通過回数が、切り替え後に必要なRPCの見積もりそのもの。**
  // 「表あり」は、今の価格表でも判定できていた回数。ふるいの方が多ければ、
  // その差が「価格表が無いせいで見えていなかった候補」になる。
  try {
    const ss = getSpotScreenStats();
    if (ss.evaluated > 0) {
      const elapsedMin = lastSpotScreenAt ? (Date.now() - lastSpotScreenAt) / 60000 : 0;
      const perMin = (now, prev) => (elapsedMin > 0 ? Math.round((now - prev) / elapsedMin) : 0);
      // 「毎分」は fresh(状態が変わってから初めて通った回数)で出す。
      // 同じ状態の同じ経路を何度評価しても見積もりは1回で足りるので、
      // **こちらが切り替え後に必要なRPCの見積もり**になる。
      const steps = ss.edges
        .map((e, i) => `${e}bps超:毎分${perMin(ss.fresh[i], lastSpotScreenFresh[i] ?? 0)}`)
        .join(" ");
      const routes = ss.routeLabels.map((l, i) => `${l}:${ss.routeCounts[i]}`).join(" ");
      const nets = ss.netLabels.map((l, i) => `${l}:${ss.netCounts[i]}`).join(" ");
      const best = ss.bestBps == null ? "-" : `${ss.bestBps.toFixed(1)}bps`;
      const needPerMin = perMin(ss.freshNeedQuote, lastSpotNeedQuote);
      console.log(`[ふるい] 評価${ss.evaluated.toLocaleString()} 価格差だけ[${steps}] 金額まで通過:毎分${needPerMin} 経路${ss.distinctRoutes.toLocaleString()}本[${routes}] 利益[${nets}] 異常${ss.insane.toLocaleString()} 最良${best}`);
      lastSpotNeedQuote = ss.freshNeedQuote;

      // 上位の経路を実物で確かめる。2,282本が何なのかを推測で語らないため。
      // チェーンごとに残してあるので、全チェーンぶんを出す(育てている最中の
      // チェーンが、他所の壊れたプールに押し出されないように)。
      for (const x of ss.samples.slice(0, 8)) {
        console.log(`[ふるいの実物] ${x.chain} ${x.pools} 始点${x.tokenIn.slice(0, 10)}… 価格差${x.edge.toFixed(1)}bps 壁${x.feeBps}bps 見積利益$${x.netUsd.toFixed(4)}`);
      }
      lastSpotScreenPassed = [...ss.passed];
      lastSpotScreenFresh = [...ss.fresh];
      lastSpotScreenAt = Date.now();
    }
  } catch (e) {}

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
    // 大物(既定$0.10以上)の行く先のまとめ。**チェーンごとの繰り返しの外で1回だけ。**
    // (最初は繰り返しの中に置いてしまい、同じ行が5〜6回流れていた)
    {
      const bigLine = formatBigSummary();
      if (bigLine) console.log(bigLine);
    }

    // **利益の段と、引き金の大きさ別の成績。**
    // 引き金の方が Backrun の答え:「大口スワップの後ほど儲かるのか」。
    // ここも繰り返しの外で1回だけ。
    {
      for (const line of [formatTierBreakdown(), formatMoveBreakdown()]) {
        if (line) console.log(line);
      }
    }

    // UniswapX の「勝てたか」の詳細。**送信も約定もしていない、読んで計算しただけの数字。**
    for (const line of formatUniswapXReport()) console.log(line);

    // 「[惜しい]」「[試算]」(あと何bpsで黒字か・壁が下がれば取れた額)は外した(2026年9月23日、オーナーの指示)。
    // 裁定botの1回あたりの利益を増やす改善は決着済み(上限1日$0.156)で、判断に使わないため。
  } catch (e) {}

}

// ===== オーナーの判断が要ることだけを見張る(2026年9月21日) =====
//
// [方針]
// 普段の失敗・機会ゼロ・静かな市況は通知しない。こちらで対処できるため。
// 通知が多いと読まれなくなり、本当に必要な1通が埋もれる。
// **オーナーが動かないと解決しないこと**だけを送る。

/// 全チェーンが止まってからこれだけ経ったら知らせる(ミリ秒)。
const ALERT_ALL_DOWN_MS = parseInt(process.env.ALERT_ALL_DOWN_MS || String(10 * 60 * 1000), 10);
/// RPCの月末見込がこれを超えたら知らせる(%)。枠を使い切ると全部止まる。
const ALERT_QUOTA_PERCENT = parseFloat(process.env.ALERT_QUOTA_PERCENT || "70");
/// 送信用ウォレットのガス残高が「あと何回送れるか」でこれを下回ったら知らせる。
///
/// [通貨の量で決めてはいけない(2026年9月21日に誤報で判明)]
/// 最初は「0.002(そのチェーンの通貨)」で決めていたが、これは雑すぎた。
/// 0.002 ETH は約$5(arbitrum で340回ぶん)なのに、0.002 MATIC は約$0.001
/// (polygon で0回ぶん)。同じ数字が意味する余裕が桁違いに違う。
/// 実際、arbitrum の残高 0.0017 ETH で「足りません」と誤報した。
/// **あと何回送れるか**なら、通貨にもガス相場にも左右されない。
const ALERT_MIN_REMAINING_SENDS = parseInt(process.env.ALERT_MIN_REMAINING_SENDS || "100", 10);
/// ガス残高を確かめる間隔(ミリ秒)。1チェーンにつき1回の呼び出し。
const GAS_BALANCE_CHECK_MS = parseInt(process.env.GAS_BALANCE_CHECK_MS || String(30 * 60 * 1000), 10);
/// 送信後の失敗がこの数を続けて超えたら知らせる(お金が減っている)。
const ALERT_CONSECUTIVE_SEND_FAILS = parseInt(process.env.ALERT_CONSECUTIVE_SEND_FAILS || "5", 10);

let allDownSince = null;
let lastGasBalanceCheck = 0;
let lastFailedCount = 0;
let consecutiveSendFails = 0;

/// 生存ログのたびに呼ぶ。条件に当てはまった時だけ通知する。
function checkOwnerAlerts(usage) {
  const now = Date.now();

  // ① 全チェーンが止まった。bot が働いていない = 機会をすべて失っている。
  if (chainReady.size === 0) {
    if (allDownSince == null) allDownSince = now;
    if (now - allDownSince >= ALERT_ALL_DOWN_MS) {
      const mins = Math.round((now - allDownSince) / 60000);
      alertOwner("all-down", "botが止まっています",
        `全チェーンが${mins}分間、稼働していません。\n` +
        `Railway のログを見て再起動が要るかもしれません。\n` +
        `画面: https://secure-amazement-production-5364.up.railway.app/`);
    }
  } else {
    allDownSince = null;
  }

  // ② RPC の枠。使い切ると全部止まるので、超える前に手を打つ必要がある。
  //    計測時間が足りないうちの見込みは当てにならないので使わない。
  if (usage && usage.reliable && usage.projectedPercent > ALERT_QUOTA_PERCENT) {
    alertOwner("quota", "RPCの枠が足りなくなりそうです",
      `今の速度だと月末に枠の${usage.projectedPercent.toFixed(0)}%を使います(現在${usage.percent.toFixed(1)}%)。\n` +
      `このままだと月末前に止まります。\n` +
      `監視するプールを減らすか、プランを上げるかの判断をお願いします。`);
  }

  // ③ 送信用ウォレットのガス残高。尽きると送信できなくなる。
  //    補充はオーナーにしかできないので、これは必ず知らせる。
  if (botAddress() && now - lastGasBalanceCheck >= GAS_BALANCE_CHECK_MS) {
    lastGasBalanceCheck = now;
    checkGasBalances().catch(() => {});
  }

  // ④ 送信後の失敗が続いている。送ったのに確定しない = ガス代だけ失っている。
  const newFails = stats.failed - lastFailedCount;
  lastFailedCount = stats.failed;
  if (newFails > 0) {
    consecutiveSendFails += newFails;
    if (consecutiveSendFails >= ALERT_CONSECUTIVE_SEND_FAILS) {
      alertOwner("send-fails", "送信の失敗が続いています",
        `直近で${consecutiveSendFails}件の失敗が積み上がりました。\n` +
        `ガス代だけを失っている可能性があります。原因はこちらで調べて直しますが、` +
        `続くようなら一度止める判断が要るかもしれません。`);
      consecutiveSendFails = 0;
    }
  } else if (stats.executed > 0) {
    // 成功が出たら連続の数え直し。
    consecutiveSendFails = 0;
  }
}

/// 送信用ウォレットの住所。`MAINNET_BOT_ADDRESS` が無ければ、送信に使っている鍵から導く
/// (住所は公開情報。**鍵そのものはどこにも出さない**)。
///
/// [2026年9月23日] `MAINNET_BOT_ADDRESS` が未設定だと、下の残高確認が**一度も走っていなかった**
/// 可能性がある(LINE も未設定なので、走っても誰にも見えなかった)。optimism の送信再開の準備で発覚。
let cachedBotAddress = null;
function botAddress() {
  if (cachedBotAddress) return cachedBotAddress;
  if (process.env.MAINNET_BOT_ADDRESS) return (cachedBotAddress = process.env.MAINNET_BOT_ADDRESS);
  const key = process.env.MAINNET_BOT_PRIVATE_KEY;
  if (!key) return null;
  try { cachedBotAddress = new ethers.Wallet(key).address; } catch (e) { return null; }
  return cachedBotAddress;
}

/// 各チェーンの送信用ウォレットのガス残高を「あと何回送れるか」で確かめる。
/// **ログにも必ず出す**(通知が未設定でも見えるように)。
async function checkGasBalances() {
  const address = botAddress();
  if (!address) return;
  const parts = [];
  for (const chain of chainReady) {
    try {
      const provider = getProviderForChain(chain);
      if (!provider) { parts.push(`${chain}:読めず(RPCなし)`); continue; }
      const wei = await provider.getBalance(address);
      // 残高と、1回あたりのガス代を、どちらもUSDに直して比べる。
      const balanceUsd = await weiToUsd(chain, wei);
      const perSendUsd = await estimateGasCostUsd(chain, "2step");
      // **読めなかったチェーンを黙って飛ばさない**(2026年9月23日、optimism だけ行に出なかった)。
      if (balanceUsd == null || !(perSendUsd > 0)) {
        parts.push(`${chain}:${parseFloat(ethers.formatEther(wei)).toFixed(5)}(${balanceUsd == null ? "価格不明" : "ガス代不明"})`);
        continue;
      }
      const remaining = Math.floor(balanceUsd / perSendUsd);
      parts.push(`${chain}:${parseFloat(ethers.formatEther(wei)).toFixed(5)}(約$${balanceUsd.toFixed(2)} あと約${remaining}回)`);
      if (remaining < ALERT_MIN_REMAINING_SENDS) {
        const native = parseFloat(ethers.formatEther(wei));
        alertOwner(`gas-balance:${chain}`, `${chain} のガス残高が残り少ないです`,
          `あと約${remaining}回ぶんしか送れません(下限 ${ALERT_MIN_REMAINING_SENDS}回)。\n` +
          `残高 ${native.toFixed(5)}(約$${balanceUsd.toFixed(2)})/ 1回あたり約$${perSendUsd.toFixed(4)}。\n` +
          `尽きると ${chain} で取引を送れなくなります。\n` +
          `補充をお願いします: ${address}`);
      }
    } catch (e) {
      parts.push(`${chain}:読めず(${(e.shortMessage || e.message || "").slice(0, 40)})`);
    }
  }
  if (parts.length > 0) console.log(`[ガス残高] ${parts.join(" ")}(下限 ${ALERT_MIN_REMAINING_SENDS}回)`);
  // **実際のお金で見た収支の材料**(2026年9月24日、オーナーの質問「ガス代に対して利益はプラスか」)。
  // 送信の収支はガス代の見積もりで数えるので、実物(コントラクトに貯まった利益)を隣に並べる。
  // 「貯まった利益の増え方 − ガス残高の減り方(入金を除く)」が本当の損益。
  const held = Object.entries(contractBalances)
    .map(([c, list]) => `${c}:$${list.reduce((a, h) => a + (h.usd || 0), 0).toFixed(4)}`);
  if (held.length > 0) {
    console.log(`[貯まった利益] ${held.join(" ")} 計$${heldProfitUsd().toFixed(4)}`
      + `(${contractBalancesAt ? Math.round((Date.now() - contractBalancesAt) / 60000) + "分前に読んだ値" : "未読"})`);
  }
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
/// 取引量の余裕を1行で出す。**「上限を上げれば大きく取れるのか」への答え。**
/// 最適額が上限のごく一部で、4倍にすると利益が大きく落ちるなら、
/// 制限しているのは設定ではなく**プールの深さ**。上限を上げても意味がない。

function shortenLabel(label) {
  return String(label ?? "").replace(/0x[0-9a-fA-F]{40}/g, (m) => `${m.slice(0, 8)}…`);
}

const REASON_LABEL = {
  disabled: "無効化済みのプールを含む", taxToken: "税トークン", cooldown: "冷却中(直近に失敗)",
  trap: "罠または計算の誤差", belowMin: "手数料負け(粗利がガス代に届かない)", executing: "実行中で重複",
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
  const realRows = real.recent.map((e) => `<tr><td>${formatLocalTime(e.timestamp)}</td><td style="font-size:9px">${shortenLabel(e.pairLabel)}</td>
    <td style="text-align:right">$${e.tradeAmountUsd.toFixed(2)}</td>
    <td style="text-align:right;color:#2ecc71;font-weight:600">${netOf(e) != null ? `+$${netOf(e).toFixed(4)}` : '-'}<br><span style="color:#888;font-weight:400;font-size:9px">粗${e.actualProfitUsd != null ? `$${e.actualProfitUsd.toFixed(4)}` : '-'} ガス${gasOf(e) != null ? `$${gasOf(e).toFixed(4)}` : '-'}</span></td>
    <td><a href="${e.explorerUrl}" target="_blank">確認</a></td></tr>`).join('') || `<tr><td colspan="5" style="color:#888">まだ実際の取引はありません</td></tr>`;

  // 記録簿の outcome を日本語にする。なぜ取れなかったかを一目で読めるように。
  const OUTCOME_LABEL = {
    success: "成功", not_sent: "送信直前に見送り", failed: "送信失敗",
    below_min: "最低利益未満", trap: "罠の疑い", tax_token: "税トークン",
    unprofitable: "赤字", skipped_cooldown: "冷却中", not_profitable_onchain: "実測で赤字",
    model_wrong: "こちらの計算が違っていた", price_moved: "先に価格が動いた",
    below_gas: "ガス代に届かず見送り", race_lost: "送信後に先を越された",
  };
  const outcomeLine = Object.entries(sum.byOutcome)
    .sort((a, b) => b[1] - a[1])
    .map(([k, n]) => `${OUTCOME_LABEL[k] || k} ${n.toLocaleString()}`)
    .join(' / ') || '記録なし';

  const oppRows = stats.recent.slice(0, 10).map((o, i) => `<tr><td>${i+1}</td>
    <td style="font-size:9px">${o.kind} ${o.chain}${o.hasV3 ? ' <span style="color:#6fae62">V3</span>' : ''}<br>${shortenLabel(o.label)}</td>
    <td style="text-align:right">${o.feeWallPercent.toFixed(2)}%</td>
    <td style="text-align:right">$${o.tradeAmountUsd.toFixed(2)}</td>
    <td style="text-align:right;color:#2ecc71;font-weight:600">+$${o.netProfitUsd.toFixed(4)}</td></tr>`).join('') || `<tr><td colspan="5" style="color:#888">まだ黒字の機会が見つかっていません</td></tr>`;

  const reasonRows = Object.entries(reasons).filter(([, v]) => v > 0).sort((a,b)=>b[1]-a[1]).map(([k, v]) =>
    `<tr><td>${REASON_LABEL[k] || k}</td><td style="text-align:right">${v.toLocaleString()}件</td></tr>`).join('') || `<tr><td colspan="2" style="color:#888">まだ記録がありません</td></tr>`;

  const stageRows = Object.entries(failStages).sort((a,b)=>b[1]-a[1]).map(([k, v]) =>
    `<tr><td>${STAGE_LABEL[k] || k}</td><td style="text-align:right">${v.toLocaleString()}件</td></tr>`).join('') || `<tr><td colspan="2" style="color:#888">送信の失敗はありません</td></tr>`;

  const verifyRows = stats.v3VerifyRecent.map((v) => `<tr>
    <td style="font-size:9px">${v.chain}<br>${v.address.slice(0, 10)}…(${(v.feeBps/100).toFixed(2)}%)</td>
    <td style="text-align:right;color:${Math.abs(v.diffPercent) > 5 ? '#e74c3c' : Math.abs(v.diffPercent) > 1 ? '#e8a33d' : '#2ecc71'}">${v.diffPercent > 0 ? '+' : ''}${v.diffPercent.toFixed(3)}%</td>
    </tr>`).join('') || `<tr><td colspan="2" style="color:#888">まだ検証していません</td></tr>`;

  const balanceLine = Object.entries(contractBalances).map(([c, held]) =>
    `${c}: ${held.map((h) => `${h.symbol} ${h.amount.toFixed(4)}(${h.unpriced ? "価格不明" : `$${h.usd.toFixed(2)}`})`).join(" / ")}`).join('<br>') || '残高なし';

  const syncLine = Object.entries(syncStats).map(([c, v]) =>
    `${c}: ${v.watched.toLocaleString()}プールを${v.subscriptions}回で購読 / 受信 V2 ${v.v2.toLocaleString()}・V3 ${v.v3.toLocaleString()}・流動性 ${v.liquidity.toLocaleString()} ${v.healthy ? '<span style="color:#2ecc71">正常</span>' : `<span style="color:#e74c3c">不達</span>`}`
  ).join('<br>') || 'WebSocket未設定';

  const gasLine = Object.entries(gas).map(([c, g]) => `${c}: $${g.costUsd}`).join(' / ') || '取得中';
  const readyLine = Object.keys(CHAIN_CONFIG).map((c) => `${c}: ${isReady(c) ? '<span style="color:#2ecc71">稼働中</span>' : '<span style="color:#e8a33d">準備中</span>'}`).join(' / ');
  const startsLine = Object.keys(CHAIN_CONFIG).map((c) => `${c}:${countUsableStarts(c)}`).join(' / ');

  return `<!DOCTYPE html><html lang="ja"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"><meta http-equiv="refresh" content="20">
<title>DEXアービトラージ</title><style>${STYLE}</style></head><body>
<h1>🔍 DEXアービトラージ</h1><div class="sub">フラッシュスワップ方式 / V2 + V3 / ${readyLine}<br>表示はすべて${TZ_LABEL}(いま ${nowJst()})</div>

<div class="card real"><h2>💰 実際の取引結果</h2>
<div class="stat"><div><div class="v">${real.count}</div><div class="l">実行回数</div></div>
<div><div class="v" style="color:#2ecc71">$${heldProfitUsd().toFixed(4)}</div><div class="l">累積利益(コントラクトに貯まった額)</div></div>
<div><div class="v">$${getCurrentTradeCapUsd()}</div><div class="l">取引上限</div></div>
<div><div class="v" style="color:${isLive?'#2ecc71':'#888'}">${isLive?'稼働中':'停止中'}</div><div class="l">自動売買</div></div></div>
<table class="t-real"><thead><tr><th>日時(${TZ_LABEL})</th><th>経路</th><th style="text-align:right">投入</th><th style="text-align:right">純利益</th><th></th></tr></thead><tbody>${realRows}</tbody></table>
<div class="note">累積利益は、コントラクトに貯まっている利益の<b>実際の残高</b>です(一度も引き出していないので、これが貯めてきた利益の全部。旧コントラクトの分も含む。今の価格で換算、${contractBalancesAt ? formatLocalTime(contractBalancesAt) : "まだ読んでいない"}時点)。<br>
内訳: ${balanceLine}<br>
ガス代はウォレットから払っているので、この額には含まれていません。</div></div></div>

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

${renderLiquidationCard()}

<div class="card"><h2>📒 24時間の記録簿</h2>
<div class="stat"><div><div class="v" style="color:#2ecc71">+$${sum.realizedUsd.toFixed(4)}</div><div class="l">実際に得た利益</div></div>
<div><div class="v">${sum.count.toLocaleString()}</div><div class="l">記録件数</div></div>
<div><div class="v" style="color:${sum.phantomCount ? '#e74c3c' : '#888'}">${sum.phantomCount.toLocaleString()}</div><div class="l">計算が壊れた経路</div></div></div>
<div class="note">なぜそうなったか: ${outcomeLine}<br>
「取れた可能性がある額」「直せば取れる額」「あと何bpsで黒字だったか」は外しました(2026年9月23日、オーナーの指示)。
検証の結果、大口の機会は本物0/10で、判定上の利益は取り逃した金ではなかったためです。</div>

<h2 style="margin-top:14px">直近に検知した機会</h2>
<table class="t-num"><thead><tr><th>#</th><th>経路</th><th style="text-align:right">壁</th><th style="text-align:right">投入</th><th style="text-align:right">純利益</th></tr></thead><tbody>${oppRows}</tbody></table></div>

<div class="footerlink"><a href="/about">→ 仕組みについて</a></div></body></html>`;
}

/// Aave 清算の見張り(LIQUIDATION_CHAIN のチェーン)の状態。画面の1枚。
function renderLiquidationCard() {
  const d = getLiquidationDashboard();
  if (!d.enabled) return "";
  const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const ago = (ms) => (ms ? `${Math.round((Date.now() - ms) / 1000)}秒前` : "まだ");
  const watchRows = d.watching.length
    ? d.watching.map((w) => `<tr><td>${esc(w.user.slice(0, 10))}…</td><td style="text-align:right;color:${w.hf < 1 ? "#e74c3c" : "#e8a33d"}">${w.hf.toFixed(4)}</td><td style="text-align:right">$${w.debtUsd.toFixed(2)}</td></tr>`).join("")
    : `<tr><td colspan="3" style="color:#888">HF&lt;1.05 の人はいません</td></tr>`;
  const recentRows = d.recent.length
    ? d.recent.map((r) => `<tr><td>${esc(formatLocalTime(r.at))}</td><td>${esc(r.user.slice(0, 10))}…</td><td>${esc(r.pair)}</td><td style="text-align:right">${r.hf.toFixed(4)}</td><td style="text-align:right">$${r.coverUsd.toFixed(2)}</td><td style="text-align:right">$${r.grossUsd.toFixed(2)}</td><td>${esc(r.result)}</td></tr>`).join("")
    : `<tr><td colspan="7" style="color:#888">まだ候補はありません</td></tr>`;
  return `<div class="card"><h2>🏦 Aave 清算(${LIQUIDATION_CHAIN})${d.dryRun ? ' <span style="color:#e8a33d;font-size:0.8em">DRY_RUN(送信しない)</span>' : ' <span style="color:#e74c3c;font-size:0.8em">本番送信</span>'}</h2>
<div class="stat"><div><div class="v">${d.roster.toLocaleString()}</div><div class="l">借り手の名簿(遡り${d.backfillPct}%)</div></div>
<div><div class="v" style="color:#e8a33d">${d.watch}</div><div class="l">要注意(HF&lt;1.05)</div></div>
<div><div class="v" style="color:#e74c3c">${d.found}</div><div class="l">清算できた候補</div></div>
<div><div class="v">${d.priceEvents.toLocaleString()}</div><div class="l">価格更新の受信</div></div></div>
<div class="note">${d.verified ? "Pool 応答あり" : "Pool 応答なし"} / WebSocket ${d.wsUrlSet ? (d.wsConnected ? "接続中" : "切断") : "未設定"} / 価格フィード${d.feeds}件(辿れず${d.feedsUnresolved}) / Pool イベント受信${d.poolEvents.toLocaleString()} / 他者が先に清算${d.takenByOthers} / 自力で回復${d.recovered} / 確認${d.simulated} 送信${d.sent}(成功${d.sentOk})<br>
最低利益$${d.minProfitUsd} / 肩代わりの上限$${d.maxDebtUsd} / 全員の測定 ${ago(d.lastSweepAt)} / 最後の価格更新 ${ago(d.lastPriceEventAt)} / RPC${d.rpcCalls.toLocaleString()}回${d.errors ? ` / 失敗${d.errors}(${esc(d.lastError)})` : ""}</div>
<table class="t-num"><thead><tr><th>要注意の人</th><th style="text-align:right">HF</th><th style="text-align:right">借金</th></tr></thead><tbody>${watchRows}</tbody></table>
<h2 style="margin-top:14px">候補の記録</h2>
<table class="t-num"><thead><tr><th>時刻(${TZ_LABEL})</th><th>借り手</th><th>担保→借金</th><th style="text-align:right">HF</th><th style="text-align:right">肩代わり</th><th style="text-align:right">見込み粗利</th><th>結果</th></tr></thead><tbody>${recentRows}</tbody></table></div>`;
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
  // [画面の不具合でbotを止めない(2026年9月19日)]
  // 見出しに ${tzLabel} と書いたが、その変数は別の関数の中にあった。
  // renderPage が ReferenceError を投げ、**捕まえる人がいないので
  // プロセスごと落ちた**。裁定の判定も送信も道連れになり、
  // 復旧のたびに価格表の作り直し(20〜40分)からやり直しになっていた。
  // 画面は「あれば便利なもの」で、botの本体ではない。必ず捕まえる。
  http.createServer((req, res) => {
    try {
      // 生きているかだけを確かめる軽い入口。画面が真っ白な時の切り分けに使う。
      if (req.url === "/ping") {
        res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
        res.end(`ok ${nowJst()} (${TZ_LABEL})\n`);
        return;
      }
      const body = req.url === "/about" ? renderAbout() : renderPage();
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(body);
    } catch (e) {
      console.error(`[ダッシュボード] 表示に失敗(botは動き続けます): ${e.message}`);
      try {
        res.writeHead(500, { "Content-Type": "text/html; charset=utf-8" });
        res.end(`<meta charset="utf-8"><body style="font-family:sans-serif;background:#111;color:#eee;padding:20px">
<h2>画面の表示に失敗しました</h2><p>botの判定と売買は動き続けています。</p>
<pre style="color:#e74c3c;white-space:pre-wrap">${String(e && e.message).slice(0, 300)}</pre></body>`);
      } catch (inner) {}
    }
  }).listen(port, () => console.log(`ダッシュボード: ポート${port}`));

  // ===== 画面の自己点検(2026年9月20日) =====
  //
  // [なぜ要るか]
  // 「画面が真っ白」と報告されたが、Railway の記録では応答は全て 200 で、
  // サーバー側にエラーのログも無かった。この砂場からは本番の画面を取れないため、
  // **bot 自身に自分の画面を取りに行かせて**、中身が壊れていないかを記録する。
  // 送り出す直前の姿がそのまま分かるので、原因が中身か経路かを切り分けられる。
  // 自分自身への接続なので費用も外部への通信も発生しない。
  const check = () => {
    const started = Date.now();
    const req = http.get({ host: "127.0.0.1", port, path: "/", timeout: 10000 }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (c) => { body += c; });
      res.on("end", () => {
        const bytes = Buffer.byteLength(body, "utf8");
        const closed = body.trimEnd().endsWith("</html>");
        const opens = (body.match(/<!--/g) || []).length;
        const closes = (body.match(/-->/g) || []).length;
        const broken = !closed || bytes < 2000 || opens !== closes;
        const line = `[画面の自己点検] ${res.statusCode} / ${bytes.toLocaleString()}バイト / 末尾${closed ? "正常" : "欠け"} / コメント${opens}:${closes} / ${Date.now() - started}ms`;
        if (broken) {
          console.error(`${line} ← 壊れています。先頭120字: ${JSON.stringify(body.slice(0, 120))} / 末尾120字: ${JSON.stringify(body.slice(-120))}`);
        } else {
          console.log(line);
        }
      });
    });
    req.on("timeout", () => { req.destroy(); console.error("[画面の自己点検] 10秒以内に応答がありません"); });
    req.on("error", (e) => console.error(`[画面の自己点検] 取得に失敗: ${e.message}`));
  };
  setTimeout(check, 20000);
  setInterval(check, 10 * 60 * 1000);
}

async function main() {
  console.log("=== DEXアービトラージ(フラッシュスワップ / V2 + V3) 起動 ===");
  startServer();

  const deployTarget = process.env.RUN_MAINNET_DEPLOY;
  if (deployTarget && deployTarget !== "false") {
    try { await runMainnetDeploy(deployTarget); } catch (e) { console.error("[本番デプロイ] 失敗:", e.message); }
  }
  // 清算コントラクト(AaveLiquidator)のデプロイ。仕組みは上と同じ。
  const liquidatorTarget = process.env.RUN_LIQUIDATOR_DEPLOY;
  if (liquidatorTarget && liquidatorTarget !== "false") {
    try { await runLiquidatorDeploy(liquidatorTarget); } catch (e) { console.error("[清算デプロイ] 失敗:", e.message); }
  }
  // Morpho Blue の清算コントラクト(MorphoLiquidator)のデプロイ。住所が設定済みなら飛ばす。
  const morphoDeployTarget = process.env.RUN_MORPHO_LIQUIDATOR_DEPLOY;
  if (morphoDeployTarget && morphoDeployTarget !== "false") {
    try { await runMorphoLiquidatorDeploy(morphoDeployTarget); } catch (e) { console.error("[Morpho清算デプロイ] 失敗:", e.message); }
  }

  // 環境変数 RUN_POOL_SURVEY にチェーン名を入れた時だけ、V3型プールの調査を一度だけ行う。
  // 未監視のDEXに、いま取引しているペアのプールがあるかを確かめるための読み取り専用の処理。
  // 終わったら RUN_POOL_SURVEY を false に戻すこと。
  const surveyTarget = process.env.RUN_POOL_SURVEY;
  if (surveyTarget && surveyTarget !== "false") {
    try { await runPoolSurvey(surveyTarget); } catch (e) { console.error("[プール調査] 失敗:", e.message); }
  }

  // Ethereum メインネットの**深さ**を1回だけ測る(読み取りのみ・送信しない)。
  // 今の5チェーンは取引量$1.00が天井で、原因がプールの深さだと実測で確定した
  // (2026年9月21日)。深い場所へ移る価値があるかを、推測ではなく数字で決める。
  // 既存の裁定には一切触れない(専用のプロバイダで、この1回きり)。
  const mainnetSurvey = process.env.RUN_MAINNET_SURVEY;
  if (mainnetSurvey && mainnetSurvey !== "false") {
    try { await runMainnetDepthSurvey(); } catch (e) { console.error("[メインネット調査] 失敗:", e.message); }
  }

  // Morpho Blue の過去の清算を実測する(読み取りのみ・送信しない)。
  // 清算用コントラクトを作る価値があるかを、件数・大きさ・競争の数字で決めるため。
  // 読む量が多いので**待たずに裏で**走らせる(裁定の起動を遅らせない)。
  // 終わったら RUN_MORPHO_SURVEY を空に戻すこと。
  if (morphoSurveyChains().length > 0) {
    runMorphoSurvey().catch((e) => console.error("[Morpho調査] 失敗:", e.message));
  }


  // **「ロスカットの急落を買って戻ったら売る」を過去データで検証する**(オーナーの案)。
  // Binance の無料の公開ダンプ(1分足)を読んで計算するだけ。**取引も送金もしない。**
  // 裁定botには一切触れない。終わったら RUN_WICK_BACKTEST を空に戻すこと。
  if (wickBacktestSymbols().length > 0) {
    try { await runWickBacktestAll(); } catch (e) { console.error("[ヒゲ検証] 失敗:", e.message); }
  }

  // メインネットの**歪みの頻度**を数えるだけの見張り(送信しない・判定もしない)。
  // 深さの調査は「器の大きさ」しか答えていない。2.10bpsを超える歪みが
  // 実際に何回起きるかを数えないと、期待収入が計算できない。
  // 失敗しても既存の裁定は止めない。
  const mainnetWatch = process.env.RUN_MAINNET_WATCH;
  if (mainnetWatch && mainnetWatch !== "false") {
    startMainnetEdgeWatch().catch((e) => console.warn(`[メインネット頻度] 始められません: ${(e.message || "").slice(0, 100)}`));
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

  // 各チェーンのコントラクトの版(新旧)と住所の中身を起動時に確かめてログに出す。
  // 再デプロイ直後の裏付け用。失敗しても起動は止めない。
  try { await checkContractVersions(Object.keys(CHAIN_CONFIG)); } catch (e) {}
  // OP Stack のチェーンで、Flashblocks の「pending」状態が標準の RPC から読めるかを確かめる(ログのみ)。
  for (const chain of ["optimism", "base"]) {
    if (CHAIN_CONFIG[chain] && process.env.FLASHBLOCKS_PROBE !== "false") {
      try { await probePendingState(chain); } catch (e) {}
    }
  }

  setInterval(probeFeesGradually, FEE_PROBE_INTERVAL_MS);
  setInterval(() => { runOnchainFeeFixes().catch(() => {}); }, FEE_FIX_INTERVAL_MS);
  setInterval(refreshStaleReserves, REFRESH_STALE_SEC * 1000);
  setInterval(refreshV3States, 20000);
  setInterval(refreshQuoteTables, QUOTE_TABLE_INTERVAL_MS);
  setInterval(verifyV3Calculations, V3_VERIFY_INTERVAL_MS);
  setInterval(refreshTokenPrices, PRICE_REFRESH_INTERVAL_MS);
  setInterval(() => {
    savePoolMap();
    saveQuoteTables();
    saveGasPriceRatios();
  }, SAVE_MAP_INTERVAL_MS);
  setInterval(trimJournalIfNeeded, 30 * 60 * 1000);
  // Claude が docs/owner-questions.json に置いた質問を LINE へ転送する。
  // 起動時に1回と、送れなかった分の再試行のため10分ごと。
  sendPendingQuestions().catch(() => {});
  setInterval(() => { sendPendingQuestions().catch(() => {}); }, 10 * 60 * 1000);

  // Aave V3 清算の速い見張り(第2段の本体。既定は LIQUIDATION_DRY_RUN=true で送らない)。
  // 見る先は LIQUIDATION_CHAIN(既定 avalanche)。**1チェーンだけ**。
  // 失敗しても裁定は止めない。
  let liquidationStarted = false;
  try {
    liquidationStarted = await startLiquidationMonitor(Object.keys(CHAIN_CONFIG));
    // 候補が出た時の処理(経路探し → eth_call で確認 → DRY_RUN でなければ送信)。
    if (liquidationStarted) {
      setCandidateHandler(handleLiquidationCandidate);
      // 実行の道筋(契約の住所・所有者・経路探し)を起動時に一度通しておく(読み取りのみ)。
      setTimeout(() => { selfCheckLiquidationExecutor().catch(() => {}); }, 90 * 1000);
    }
  } catch (e) {
    console.warn(`[${LIQUIDATION_TAG}] 始められませんでした: ${(e.message || "").slice(0, 100)}`);
  }

  // Morpho Blue の清算の見張り(送信しない)。先に見つけられるか・利益はいくらかを実測する。
  try {
    await startMorphoLiquidation(Object.keys(CHAIN_CONFIG));
  } catch (e) {
    console.warn(`[Morpho清算] 始められませんでした: ${(e.message || "").slice(0, 100)}`);
  }

  // 新しい戦略の**送らない計測**(オーナーの指示で案1・案2を進める、2026年9月24日)。
  // Compound III の割引担保 / Spark PSM と DEX のずれ。読むだけで、ガスも元手も使わない。
  try { startCompoundMonitor(Object.keys(CHAIN_CONFIG)); } catch (e) { console.warn(`[Compound計測] 始められませんでした: ${(e.message || "").slice(0, 100)}`); }
  try { startSparkMonitor(Object.keys(CHAIN_CONFIG)); } catch (e) { console.warn(`[Spark計測] 始められませんでした: ${(e.message || "").slice(0, 100)}`); }

  // Aave V3 の清算の機会を**測るだけ**(第1段。送信は一切しない)。
  // 住所は公開情報だが、応答するかを実測で確かめてから見張る。
  // avalanche は上の見張りに移したので、計測からは外す(同じ読み取りを二重にしない)。
  try {
    const measureChains = Object.keys(CHAIN_CONFIG).filter((c) => !(liquidationStarted && c === LIQUIDATION_CHAIN));
    const aaveChains = await verifyAaveChains(measureChains);
    if (aaveChains.length > 0) {
      setInterval(() => { aaveSweepAll().catch(() => {}); }, AAVE_SWEEP_INTERVAL_MS);
      setInterval(() => { aaveCheckWatchAll().catch(() => {}); }, AAVE_WATCH_INTERVAL_MS);
      // 最初の1回は起動が落ち着いてから(裁定の準備を邪魔しない)。
      setTimeout(() => { aaveSweepAll().catch(() => {}); }, 60 * 1000);
      console.log(`[清算] 見張りを始めます: ${aaveChains.join(",")}(${AAVE_SWEEP_INTERVAL_MS / 60000}分ごとに全員、${AAVE_WATCH_INTERVAL_MS / 1000}秒ごとに危ない人だけ)`);
    }
  } catch (e) {
    console.warn(`[清算] 見張りを始められませんでした: ${(e.message || "").slice(0, 100)}`);
  }
  // 新しく出来たプールを定期的に拾う。見つかったら、そのチェーンだけ
  // 桁数・状態・購読を作り直す(判定は止めない)。
  // 報告だけのチェーンしか設定されていない場合も回す(そうしないと測れない)。
  if ((getScoutChains().length > 0 || getReportOnlyChains().length > 0) && SCOUT_INTERVAL_MS > 0) {
    console.log(`[プール発見] ${SCOUT_INTERVAL_MS / 3600000}時間ごと。載せる: ${getScoutChains().join(",") || "なし"} / **報告のみ(1本も載せない)**: ${getReportOnlyChains().join(",") || "なし"}`);
    // (報告のみのチェーンの初回は preparePoolMap の起動時探索が兼ねる。
    //  3分後にもう一度走らせていたが、同じ結果を2回出していたので外した。)

    // **UniswapX の計測。** 約定済みの注文を読み、我々の経路なら同じ注文を
    // いくらで埋められたかを比べるだけ。**送信も約定もしない**ので、
    // ガスも元手もリスクも無い。価格表が育ってから測りたいので、起動5分後から。
    if (getProbeChains().length > 0 && PROBE_INTERVAL_MS > 0) {
      console.log(`[UniswapX計測] ${PROBE_INTERVAL_MS / 60000}分ごとに約定済みの注文を読みます(${getProbeChains().join(",")})。**注文は出しません**`);
      const runProbe = () => probeUniswapXOnce(Object.keys(CHAIN_CONFIG))
        .catch((e) => console.warn(`[UniswapX計測] 失敗 ${(e.message || "").slice(0, 80)}`));
      setTimeout(() => { runProbe(); setInterval(runProbe, PROBE_INTERVAL_MS); }, 5 * 60 * 1000);

      // **「経路が無い」と落ちた組を、ファクトリーに聞いて地図に足す。**
      //
      // [2026年9月22日] base は新しい注文81件のうち **68件(84%)が「経路なし」**
      // だった。地図にその組が無いだけで、UniswapX で起きていることの16%しか
      // 見ていなかった。総当たりの発見(pool-scout)と違い、
      // **足りないと分かっている組だけ**を聞くので安い。
      //
      // 計測が組を溜めてから動かしたいので、計測開始の10分後から。
      // 枠が苦しい時は動かさない(発見と同じ歯止め)。
      // 枠の歯止めは pair-filler の中に置いてある(発見と同じ判定)。
      const runFill = () => fillMissingPairsOnce(Object.keys(CHAIN_CONFIG))
        .catch((e) => console.warn(`[組を足す] 失敗 ${(e.message || "").slice(0, 80)}`));
      setTimeout(() => { runFill(); setInterval(runFill, 10 * 60 * 1000); }, 15 * 60 * 1000);
    }

    // **Solana の計測。** 「放置されているのに取引されているコイン」があるかを測る。
    // DexScreener(無料・認証不要)を読むだけ。**Solana へは何も送らない。**
    // 価格差が**次の観測でも残っているか**を数える = 誰も取っていない証拠。
    if (getSolanaTokenCount() > 0 && SOLANA_PROBE_INTERVAL_MS > 0) {
      console.log(`[Solana計測] ${SOLANA_PROBE_INTERVAL_MS / 60000}分ごとに${getSolanaTokenCount()}銘柄の複数DEX価格差を測ります。**取引はしません**`);
      const runSolana = () => probeSolanaOnce()
        .catch((e) => console.warn(`[Solana計測] 失敗 ${(e.message || "").slice(0, 80)}`));
      setTimeout(() => { runSolana(); setInterval(runSolana, SOLANA_PROBE_INTERVAL_MS); }, 6 * 60 * 1000);
    }
    setInterval(async () => {
      try {
        const scouted = await scoutAllChains(Object.keys(CHAIN_CONFIG));
        for (const [chain, r] of Object.entries(scouted)) {
          if (!r || r.reportOnly) continue;
          // **足す前に減らす。** 探索が自動で載せたプールのうち、しばらくイベントの無い
          // ものを外す。手書き由来は対象外。送信中の経路が使っているプールも外さない。
          const inUse = new Set([...executingPools].filter((k) => k.startsWith(`${chain}::`)));
          const evicted = evictQuietScoutPools(chain, SCOUT_EVICT_IDLE_MS, inUse);
          if (evicted.length > 0) {
            const sample = evicted.slice(0, 5).map((e) =>
              `${e.dexId}:${e.address.slice(0, 8)}…(${Math.round(e.idleMs / 3600000)}時間無音)`).join(" ");
            console.log(`[プール発見] ${chain}: 静かな探索プール${evicted.length}件を外した(${SCOUT_EVICT_IDLE_MS / 3600000}時間イベントなし): ${sample}`);
          }
          if (r.added === 0 && evicted.length === 0) continue;
          // 監視対象が変わったので、状態を読み直して購読をやり直す(古い購読は解除される)。
          await prepareChain(chain);
          refreshTokenPrices();
        }
      } catch (e) {
        console.warn(`[プール発見] 定期実行に失敗 ${(e.message || "").slice(0, 80)}`);
      }
    }, SCOUT_INTERVAL_MS);
  }
  setTimeout(refreshContractBalances, 30000);
  setInterval(refreshContractBalances, 10 * 60 * 1000);
  setTimeout(fullScanOnce, 10000);
  setInterval(fullScanOnce, FULL_SCAN_INTERVAL_SEC * 1000);

  restoreGasPriceRatios();
  console.log(`[起動] 準備完了 / 取引上限$${getCurrentTradeCapUsd()} / 最低利益[${describeMinProfit()}]`);
}

// **終了の合図を受けたら、計測を書き出してから終わる。**
//
// [なぜ要るか(2026年9月22日、オーナーの提案)]
// Railway は再デプロイの前に SIGTERM を送る。今までこれを受けていなかったので、
// メモリの上にしかない計測が**毎回そのまま消えていた**。1日4回デプロイした結果、
// UniswapX の計測と大物の台帳が一度も積み上がらなかった。
//
// 書き出しは同期(fs.writeFileSync)なので、ここで待つ時間はほぼ無い。
// 送信中の取引があっても、チェーン上の守り(returned >= owed + minProfit)が
// 効いているので、途中で落ちても損失にはならない(元々コンテナは強制終了される)。
let shuttingDown = false;
for (const sig of ["SIGTERM", "SIGINT"]) {
  process.on(sig, () => {
    if (shuttingDown) return;  // 二重に来ても1回だけ
    shuttingDown = true;
    // **測っているものを全部書き出してから終わる。**
    for (const [name, fn] of [["大物", flushBigOpportunities],
                              ["メインネット歪み", flushMainnetEdge],
                              ["送信停止", flushSendSkips],
                              ["段", flushTiers],
                              ["組を足す", flushPairFiller]]) {
      try { fn(); } catch (e) { console.warn(`[終了] ${name} の書き出しに失敗`); }
    }
    console.log(`[終了] ${sig} を受けました。計測を書き出しました`);
    process.exit(0);
  });
}

main().catch((e) => { console.error("致命的エラー:", e); process.exit(1); });
