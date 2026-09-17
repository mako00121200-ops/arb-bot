// scripts/onchain-reserves.js
//
// チェーンから直接データを読むための共通処理。
//
// [実行用は待ち行列を通さない]
// 待ち行列は「大量に発生する背景作業」がRPCの秒間上限を超えないようにする
// ための仕組みで、1件ずつ順番に処理する。実行用の問い合わせをこれに通すと、
// 同時に投げたつもりの6回が直列化し、Baseの公開RPC(1件約1.4秒)では
// 8.4秒かかって上限を超えた(2026年9月15日)。
// 実行用は1回あたり6〜8件しか出ず頻度も低いため、待ち行列を迂回して
// そのまま同時に投げる。
//
// [通常列(背景作業)]
// 手数料実測・プール取込・定期読み直しはここを通る。チェーンごとの間隔を
// 守り、上限を超えたら古い要求から捨てて自己回復する。
//
// [RPCの自動切り替え]
// 一定回数連続で失敗したら次の候補URLへ切り替える。ただし
// "missing revert data" 等のコントラクト側の正当な応答は障害ではない。
//
// [手数料の実測(2026年9月16日に修正)]
// 以前は getAmountOut だけで測っていたが、この関数を持つのはSolidly系
// (Aerodrome等)だけで、QuickSwap・SushiSwap等のUniswap V2系は必ず失敗した。
// 失敗したプールは未実測のまま約70秒ごとに再挑戦され、必ず失敗する問い合わせを
// 1分に約240回出し続けていた(Chainstackの枠の約半分を浪費)。
// 修正後:
//  ① getAmountOut を持たないプールは記憶し、二度と呼ばない
//  ② Uniswap V2系は「過去の実際の取引」(Swapと、同じ取引内で直前に出るSync)
//     から手数料を逆算する。取引を送らずに既存のデータから求められる
//  ③ 直近に取引が無いプールは24時間、取得失敗は1時間、問い合わせを出さない
// なお②で分かるのはプールの手数料だけで、送金時に税を取るトークンは
// 見抜けない(税はプールの外で取られる)。税の判定は送信直前のガス見積もり
// (execute-opportunity.js)が引き続き担当する。

import { ethers } from "ethers";
import { getChainConfig, getAnyChainConfig, CHAIN_CONFIG } from "../chain-config.js";

const PAIR_ABI = [
  "function getReserves() view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast)",
  "function token0() view returns (address)",
  "function getAmountOut(uint256 amountIn, address tokenIn) view returns (uint256)",
];
const ERC20_DECIMALS_ABI = ["function decimals() view returns (uint8)"];

// 通常列(背景作業)の送信間隔。RPCの秒間上限に合わせる。
const MIN_INTERVAL_BY_CHAIN = {
  base: parseInt(process.env.BASE_MIN_INTERVAL_MS || "90", 10),
  polygon: parseInt(process.env.POLYGON_MIN_INTERVAL_MS || "45", 10),
};
const DEFAULT_MIN_INTERVAL_MS = parseInt(process.env.MIN_REQUEST_INTERVAL_MS || "60", 10);
function minIntervalFor(chain) {
  return MIN_INTERVAL_BY_CHAIN[chain] ?? DEFAULT_MIN_INTERVAL_MS;
}

const FAILURES_BEFORE_ROTATE = 3;
const RPC_CALL_TIMEOUT_MS = parseInt(process.env.RPC_CALL_TIMEOUT_MS || "8000", 10);
// 実行用は待ち行列を通さない代わりに、同時に出せる数に上限を設ける。
// 経路は最大4段なので、余裕を見てこの値で足りる。
const MAX_CONCURRENT_PRIORITY = parseInt(process.env.MAX_CONCURRENT_PRIORITY || "12", 10);
const NORMAL_QUEUE_LIMIT = parseInt(process.env.NORMAL_QUEUE_LIMIT || "300", 10);

const queues = new Map();

function getQueue(chain) {
  const key = (chain || "").toLowerCase();
  if (!queues.has(key)) {
    queues.set(key, {
      normal: [], normalRunning: false,
      inflightPriority: 0, waitingPriority: [],
      dropped: 0, priorityDone: 0, normalDone: 0,
      priorityMaxMs: 0,
    });
  }
  return queues.get(key);
}

function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`RPC timeout after ${ms}ms (${label})`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/// 実行用: 待ち行列を通さず、そのまま同時に投げる。
/// 同時数だけ上限を設け、超えた分は先に出た呼び出しが終わってから始める。
async function runPriority(chain, fn) {
  const q = getQueue(chain);
  if (q.inflightPriority >= MAX_CONCURRENT_PRIORITY) {
    await new Promise((resolve) => q.waitingPriority.push(resolve));
  }
  q.inflightPriority++;
  const startedAt = Date.now();
  try {
    return await withTimeout(Promise.resolve().then(fn), RPC_CALL_TIMEOUT_MS, chain);
  } finally {
    q.inflightPriority--;
    q.priorityDone++;
    const ms = Date.now() - startedAt;
    if (ms > q.priorityMaxMs) q.priorityMaxMs = ms;
    const next = q.waitingPriority.shift();
    if (next) next();
  }
}

/// 背景作業: 1件ずつ、間隔を守って処理する。
async function pumpNormal(chain) {
  const q = getQueue(chain);
  if (q.normalRunning) return;
  q.normalRunning = true;
  try {
    while (q.normal.length > 0) {
      const job = q.normal.shift();
      try {
        const result = await withTimeout(Promise.resolve().then(job.fn), RPC_CALL_TIMEOUT_MS, chain);
        job.resolve(result);
      } catch (e) {
        job.reject(e);
      }
      q.normalDone++;
      await new Promise((r) => setTimeout(r, minIntervalFor(chain)));
    }
  } finally {
    q.normalRunning = false;
  }
}

function scheduleNormal(chain, fn) {
  const q = getQueue(chain);
  return new Promise((resolve, reject) => {
    while (q.normal.length >= NORMAL_QUEUE_LIMIT) {
      const dropped = q.normal.shift();
      q.dropped++;
      dropped.reject(new Error("待ち行列が上限に達したため破棄"));
    }
    q.normal.push({ fn, resolve, reject });
    pumpNormal(chain);
  });
}

const rpcState = new Map();
const providerCache = new Map();

function getState(chain) {
  const key = (chain || "").toLowerCase();
  if (!rpcState.has(key)) rpcState.set(key, { index: 0, failures: 0 });
  return rpcState.get(key);
}

/// [停止中のチェーンも読めるようにする(2026年9月17日)]
/// getChainConfig は ACTIVE_CHAINS にあるチェーンしか返さないため、
/// 停止したチェーンはRPCで読むことすらできなかった。
/// その結果「本当に機会が無いのか」を測る手段が無く、一度外したチェーンを
/// データで見直せない状態になっていた(Base/Optimismの除外がこれに当たる)。
/// ここは読み取りの入口なので、設定のあるチェーンは全て返す。
/// 監視や売買を始めるかどうかは prepareChain / chainReady が決めており、
/// そちらは CHAIN_CONFIG(稼働中のみ)を見るので、ここを緩めても
/// 停止中のチェーンで勝手に取引が始まることはない。
export function getProviderForChain(chain) {
  const config = getAnyChainConfig(chain);
  if (!config) throw new Error(`未対応チェーン: ${chain}`);
  const key = (chain || "").toLowerCase();
  const state = getState(key);
  const url = config.rpcUrls[state.index % config.rpcUrls.length];
  const cacheKey = `${key}::${url}`;
  if (!providerCache.has(cacheKey)) {
    const network = ethers.Network.from(config.chainId);
    providerCache.set(cacheKey, new ethers.JsonRpcProvider(url, network, { staticNetwork: network }));
  }
  return providerCache.get(cacheKey);
}

function recordRpcFailure(chain, message) {
  // RPCの切り替えは読み取りに付随する処理なので、停止中のチェーンでも働かせる。
  const config = getAnyChainConfig(chain);
  if (!config || config.rpcUrls.length < 2) return;
  const state = getState(chain);
  state.failures++;
  if (state.failures < FAILURES_BEFORE_ROTATE) return;
  const oldUrl = config.rpcUrls[state.index % config.rpcUrls.length];
  state.index = (state.index + 1) % config.rpcUrls.length;
  state.failures = 0;
  console.log(`[RPC切替] ${chain}: 続けて失敗したため次の候補へ(${oldUrl.slice(0, 40)} → ${config.rpcUrls[state.index].slice(0, 40)} / 理由: ${(message || "").slice(0, 70)})`);
}

function isContractLevelError(msg) {
  return msg.includes("execution reverted")
    || msg.includes("could not decode result data")
    || msg.includes("missing revert data")
    || msg.includes("CALL_EXCEPTION");
}

/// RPC呼び出しの共通入口。
/// priority=true は「実行に直結する問い合わせ」で、待ち行列を通さず即座に投げる。
export async function callWithRpc(chain, fn, priority = false) {
  const call = () => fn(getProviderForChain(chain));
  try {
    const result = priority
      ? await runPriority(chain, call)
      : await scheduleNormal(chain, call);
    getState(chain).failures = 0;
    return result;
  } catch (e) {
    const msg = e.message || "";
    const isContractLevel = isContractLevelError(msg) || msg.includes("待ち行列が上限");
    if (!isContractLevel) recordRpcFailure(chain, msg);
    throw e;
  }
}

export async function fetchOnchainReserves({ chain, pairAddress, tokenXAddress, decimalsX, decimalsY, priority = false }) {
  if (!ethers.isAddress(pairAddress)) throw new Error(`プールアドレスの形式が不正: ${pairAddress}`);
  const addr = ethers.getAddress(pairAddress);
  const contract = (p) => new ethers.Contract(addr, PAIR_ABI, p);
  const [reserves, token0] = await Promise.all([
    callWithRpc(chain, (p) => contract(p).getReserves(), priority),
    callWithRpc(chain, (p) => contract(p).token0(), priority),
  ]);
  const isToken0X = token0.toLowerCase() === ethers.getAddress(tokenXAddress).toLowerCase();
  const rawX = isToken0X ? reserves[0] : reserves[1];
  const rawY = isToken0X ? reserves[1] : reserves[0];
  return {
    reserveX: parseFloat(ethers.formatUnits(rawX, decimalsX)),
    reserveY: parseFloat(ethers.formatUnits(rawY, decimalsY)),
    rawX, rawY,
  };
}

// ===== 手数料の実測 =====

// イベントの識別子は手で書かず、関数の形から計算する(1文字欠けの再発防止)。
const SWAP_V2_TOPIC = ethers.id("Swap(address,uint256,uint256,uint256,uint256,address)");
const SYNC_V2_TOPIC = ethers.id("Sync(uint112,uint112)");
const SYNC_V2_TOPIC_CONFIRMED = "0x1c411e9a96e071241c2f21f7726b17ae89e3cab4c78be50e062b03a9fffbbad1";
if (SYNC_V2_TOPIC !== SYNC_V2_TOPIC_CONFIRMED) {
  console.warn(`[手数料実測] Syncの識別子が確認済みの値と一致しません: ${SYNC_V2_TOPIC}`);
}

// 1回の取引記録の取得で見るブロック数。Chainstackの推奨上限(Polygon 2,000)に合わせる。
const LOG_WINDOW_BLOCKS = parseInt(process.env.FEE_LOG_WINDOW_BLOCKS || "2000", 10);
// 取引が見つからない時に遡る回数(1回=1問い合わせ)。
const LOG_WINDOWS = parseInt(process.env.FEE_LOG_WINDOWS || "3", 10);
// これだけ取引が集まったら遡るのをやめる。
const TARGET_SAMPLES = 5;
// 端数の影響を避けるため、極小の取引は計算に使わない。
const MIN_SAMPLE_AMOUNT_IN = 1_000_000_000n;
// 正常なDEXの手数料は最大1%程度。これを超える値は取引1件だけでは採用しない。
const SINGLE_SAMPLE_MAX_BPS = 100;
const MAX_FEE_BPS = 1000;
// 問い合わせを止める時間。
const RETRY_NO_TRADES_MS = 24 * 60 * 60 * 1000;
const RETRY_ERROR_MS = 60 * 60 * 1000;
const RETRY_BUSY_QUEUE_MS = 5 * 60 * 1000;
// 1チェーンで同時に実測するプール数。背景作業の待ち行列を溢れさせないため。
const MAX_CONCURRENT_FEE_PROBES = 2;

const feeProbeState = new Map();   // key -> { fee } または { retryAt }
const noAmountOutPools = new Set(); // getAmountOut を持たないプール
const feeProbeActive = new Map();  // chain -> 実測中の数
const blockNumberCache = new Map();
const feeProbeStats = { byAmountOut: 0, byLogs: 0, non30: 0, noTrades: 0, errors: 0 };
let lastFeeStatsLine = "";

function feeKey(chain, address) {
  return `${(chain || "").toLowerCase()}:${address.toLowerCase()}`;
}

/// そのプールが今は実測しても無駄かどうか(手数料が判明済み、または再試行待ち)。
///
/// [なぜ必要か(2026年9月17日に本番ログで判明)]
/// probePoolFeeBps は再試行待ちの間はRPCを呼ばずに null を返すが、呼び出し側は
/// それを「まだ未実測」と見て毎秒キューに積み直していた。直近に取引が無く
/// 手数料を逆算できないプールは24時間待つ設計なのに、待っている間ずっと
/// 「未実測○プールを確認します」を2秒ごとに出し続け、1日約43,200行になって
/// [生存] や [機会] の行を流していた。RPCは消費していないが、ログが読めない。
export function isFeeProbeOnHold(chain, address) {
  if (!address) return false;
  let key;
  try { key = feeKey(chain, ethers.getAddress(address)); } catch (e) { return false; }
  const state = feeProbeState.get(key);
  if (!state) return false;
  if (state.fee != null) return true;
  return state.retryAt != null && Date.now() < state.retryAt;
}

async function getLatestBlock(chain) {
  const cached = blockNumberCache.get(chain);
  if (cached && Date.now() - cached.at < 30_000) return cached.value;
  const value = await callWithRpc(chain, (p) => p.getBlockNumber());
  blockNumberCache.set(chain, { value, at: Date.now() });
  return value;
}

/// 取引1件から、その取引と矛盾しない最大の手数料(0.01bps単位)を求める。
/// 取引者が受取量を最大まで取っていれば真の手数料と一致し、少なく取っていれば
/// 高めに出る。そのため複数件の最小値を使えば、手数料を低く見積もることは無い。
function feeFromSwap(swapLog, syncLog) {
  const coder = ethers.AbiCoder.defaultAbiCoder();
  const [a0In, a1In, a0Out, a1Out] = coder.decode(["uint256", "uint256", "uint256", "uint256"], swapLog.data);
  const [r0After, r1After] = coder.decode(["uint256", "uint256"], syncLog.data);

  let amountIn, amountOut, rInBefore, rOutBefore;
  if (a0In > 0n && a1In === 0n && a1Out > 0n && a0Out === 0n) {
    amountIn = a0In; amountOut = a1Out;
    rInBefore = r0After - a0In; rOutBefore = r1After + a1Out;
  } else if (a1In > 0n && a0In === 0n && a0Out > 0n && a1Out === 0n) {
    amountIn = a1In; amountOut = a0Out;
    rInBefore = r1After - a1In; rOutBefore = r0After + a0Out;
  } else {
    return null; // 両方向に出入りがある取引(フラッシュスワップ等)は使わない
  }
  if (amountIn < MIN_SAMPLE_AMOUNT_IN || rInBefore <= 0n || rOutBefore <= amountOut) return null;

  // 手数料を引いた後に必要だった投入量(切り上げ)
  const remainingOut = rOutBefore - amountOut;
  const effectiveIn = (amountOut * rInBefore + remainingOut - 1n) / remainingOut;
  if (effectiveIn > amountIn) return null; // 前提(x·y=k)と合わない取引
  const feeCentiBps = Number(((amountIn - effectiveIn) * 1_000_000n) / amountIn);
  if (feeCentiBps > MAX_FEE_BPS * 100) return null;
  return feeCentiBps;
}

/// プールの過去の取引記録から手数料を逆算する(Uniswap V2系)。
async function measureFeeFromSwapLogs(chain, address) {
  const latest = await getLatestBlock(chain);
  const samples = [];
  for (let w = 0; w < LOG_WINDOWS; w++) {
    const toBlock = latest - w * LOG_WINDOW_BLOCKS;
    const fromBlock = Math.max(0, toBlock - LOG_WINDOW_BLOCKS + 1);
    if (toBlock <= 0) break;
    const logs = await callWithRpc(chain, (p) => p.getLogs({
      address, topics: [[SWAP_V2_TOPIC, SYNC_V2_TOPIC]], fromBlock, toBlock,
    }));
    const byPosition = new Map();
    for (const log of logs) byPosition.set(`${log.transactionHash}:${log.index}`, log);
    for (const log of logs) {
      if (log.topics[0] !== SWAP_V2_TOPIC) continue;
      const sync = byPosition.get(`${log.transactionHash}:${log.index - 1}`);
      if (!sync || sync.topics[0] !== SYNC_V2_TOPIC) continue;
      try {
        const fee = feeFromSwap(log, sync);
        if (fee != null) samples.push(fee);
      } catch (e) {}
    }
    if (samples.length >= TARGET_SAMPLES) break;
  }
  if (samples.length === 0) return { fee: null, reason: "noTrades" };
  const minCentiBps = Math.min(...samples);
  if (minCentiBps > SINGLE_SAMPLE_MAX_BPS * 100 && samples.length < 2) return { fee: null, reason: "noTrades" };
  // 端数の切り捨てで僅かに高めに出るため、0.01bpsの誤差を許して切り上げる
  const fee = Math.max(0, Math.ceil((minCentiBps - 1) / 100));
  return { fee, samples: samples.length };
}

/// プールの実際の手数料(bps)を返す。分からなければ null。
/// null を返すとき、問い合わせを止める期間中は一切RPCを使わない。
export async function probePoolFeeBps({ chain, pairAddress, tokenInAddress, reserveIn, reserveOut }) {
  if (!ethers.isAddress(pairAddress)) return null;
  const addr = ethers.getAddress(pairAddress);
  const key = feeKey(chain, addr);

  const state = feeProbeState.get(key);
  if (state && state.fee != null) return state.fee;
  if (state && state.retryAt && Date.now() < state.retryAt) return null;

  const active = feeProbeActive.get(chain) || 0;
  if (active >= MAX_CONCURRENT_FEE_PROBES) return null; // 次の巡回で改めて測る
  feeProbeActive.set(chain, active + 1);

  try {
    // ① Solidly系: プール自身の getAmountOut に極小額を問い合わせて逆算する
    const hasReserves = typeof reserveIn === "bigint" && typeof reserveOut === "bigint" && reserveIn > 0n && reserveOut > 0n;
    if (!noAmountOutPools.has(key) && hasReserves && tokenInAddress && ethers.isAddress(tokenInAddress)) {
      const amountIn = reserveIn / 1_000_000n;
      if (amountIn > 0n) {
        try {
          const amountOut = await callWithRpc(chain, (p) =>
            new ethers.Contract(addr, PAIR_ABI, p).getAmountOut(amountIn, ethers.getAddress(tokenInAddress)));
          const ideal = (amountIn * reserveOut) / (reserveIn + amountIn);
          if (amountOut > 0n && ideal > 0n) {
            const feeBps = Number(((ideal - amountOut) * 10000n) / ideal);
            if (feeBps >= 0 && feeBps <= MAX_FEE_BPS) {
              feeProbeState.set(key, { fee: feeBps });
              feeProbeStats.byAmountOut++;
              if (feeBps !== 30) feeProbeStats.non30++;
              return feeBps;
            }
          }
          noAmountOutPools.add(key);
        } catch (e) {
          const msg = e.message || "";
          if (isContractLevelError(msg)) {
            noAmountOutPools.add(key); // この関数を持たないプール。二度と呼ばない
          } else {
            feeProbeState.set(key, { retryAt: Date.now() + RETRY_BUSY_QUEUE_MS });
            feeProbeStats.errors++;
            return null;
          }
        }
      }
    }

    // ② Uniswap V2系: 過去の取引記録から逆算する
    try {
      const result = await measureFeeFromSwapLogs(chain, addr);
      if (result.fee != null) {
        feeProbeState.set(key, { fee: result.fee });
        feeProbeStats.byLogs++;
        if (result.fee !== 30) feeProbeStats.non30++;
        return result.fee;
      }
      feeProbeState.set(key, { retryAt: Date.now() + RETRY_NO_TRADES_MS });
      feeProbeStats.noTrades++;
      return null;
    } catch (e) {
      const msg = e.message || "";
      const retry = msg.includes("待ち行列が上限") ? RETRY_BUSY_QUEUE_MS : RETRY_ERROR_MS;
      feeProbeState.set(key, { retryAt: Date.now() + retry });
      feeProbeStats.errors++;
      return null;
    }
  } finally {
    feeProbeActive.set(chain, (feeProbeActive.get(chain) || 1) - 1);
  }
}

export function getFeeProbeStats() {
  return { ...feeProbeStats, noAmountOutPools: noAmountOutPools.size };
}

setInterval(() => {
  const s = feeProbeStats;
  const line = `[手数料実測/集計] 判明: getAmountOut ${s.byAmountOut}件 / 取引記録 ${s.byLogs}件(うち30bps以外${s.non30}件) / 直近取引なしで24時間保留 ${s.noTrades}件 / 取得失敗 ${s.errors}件`;
  if (line !== lastFeeStatsLine) {
    console.log(line);
    lastFeeStatsLine = line;
  }
}, 5 * 60 * 1000);

const decimalsCache = new Map();
export async function fetchTokenDecimals(chain, tokenAddress) {
  const normalized = ethers.getAddress(tokenAddress);
  const key = `${chain}:${normalized.toLowerCase()}`;
  if (decimalsCache.has(key)) return decimalsCache.get(key);
  const decimals = Number(await callWithRpc(chain, (p) => new ethers.Contract(normalized, ERC20_DECIMALS_ABI, p).decimals()));
  decimalsCache.set(key, decimals);
  return decimals;
}

export function isOnchainReadAvailable(chain) {
  return getChainConfig(chain) !== null;
}

/// 全チェーン合計のRPC呼び出し数(プロセス起動からの通算)。
/// 失敗した呼び出しも枠を消費するため、成否を問わず数える。
/// Multicall3で束ねた場合は、束ねた1回が1リクエスト。
export function getRpcCallTotals() {
  let priority = 0, normal = 0;
  for (const q of queues.values()) {
    priority += q.priorityDone;
    normal += q.normalDone;
  }
  return { priority, normal, total: priority + normal };
}

/// ダッシュボード表示用。
export function getRpcStatus() {
  const out = {};
  for (const [chain, config] of Object.entries(CHAIN_CONFIG)) {
    const state = getState(chain);
    const q = getQueue(chain);
    out[chain] = {
      url: config.rpcUrls[state.index % config.rpcUrls.length].replace(/\/[a-f0-9]{20,}/i, "/***"),
      index: state.index + 1, total: config.rpcUrls.length,
      failures: state.failures,
      queued: q.normal.length,
      priorityQueued: q.inflightPriority,
      normalQueued: q.normal.length,
      dropped: q.dropped,
      priorityDone: q.priorityDone,
      normalDone: q.normalDone,
      priorityMaxMs: q.priorityMaxMs,
      intervalMs: minIntervalFor(chain),
    };
  }
  return out;
}
