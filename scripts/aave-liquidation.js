// scripts/aave-liquidation.js
//
// Aave V3 の清算の機会を**測るだけ**の仕組み(第1段)。
//
// [第1段では送信しない]
// 設計は docs/AAVE-LIQUIDATION-PLAN.md にある。いちばん正直に言うべきことは
// 「小口が本当に放置されているかを、うちがまだ実測していない」こと。外部の研究と
// Aave 自身の扱い(V4 で$1,000未満をダスト扱い)からの推定にすぎない。
// だからまず読み取りだけを行い、次を1〜3日ぶん測る。
//   ① 1日に何件、清算できる機会があるか
//   ② その規模はいくらか
//   ③ どれくらいの速さで他人に取られるか
//   ④ RPC をいくら食うか
// 見合わなければ、ここで止める。
//
// [仕様(一次情報で確認済み)]
// ・healthFactor は18桁。**1e18 未満で清算できる**
// ・一度に返せるのは HF≥0.95 で借金の50%、HF<0.95 で100%
// ・清算した側は担保を5〜10%引きで受け取れる(資産ごとの liquidationBonus)
//
// [RPCの枠を守る]
// 上限を全部の入口に付ける。枠を食い潰すと裁定の方が止まり、本末転倒になる。

import { ethers } from "ethers";
import fs from "fs";
import path from "path";
import { callWithRpc, getProviderForChain } from "./onchain-reserves.js";

/// Aave V3 Pool の住所。公開情報だが、**起動時に実測で確かめてから使う**
/// (getUserAccountData が返らないチェーンは自動で外す)。
const AAVE_POOLS = {
  polygon: "0x794a61358D6845594F94dc1DB02A252b5b4814aD",
  arbitrum: "0x794a61358D6845594F94dc1DB02A252b5b4814aD",
  avalanche: "0x794a61358D6845594F94dc1DB02A252b5b4814aD",
  optimism: "0x794a61358D6845594F94dc1DB02A252b5b4814aD",
  base: "0xA238Dd80C259a72e81d7e4664a9801593F98d1c5",
};

/// 対象チェーン。まず少なく始めて、実測を見てから広げる。
const AAVE_CHAINS = (process.env.AAVE_CHAINS ?? "base,optimism")
  .split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);

/// 清算の見張りを行うか。false で完全に止まる。
const AAVE_ENABLED = process.env.AAVE_ENABLED !== "false";

// ===== RPC の上限(全部の入口に付ける)=====
/// 名簿を伸ばす時、1回の巡回で投げる getLogs の上限。
const MAX_LOG_REQUESTS = parseInt(process.env.AAVE_MAX_LOG_REQUESTS || "10", 10);
/// getLogs 1回あたりのブロック数の**出発点**。ここから実測で広げ縮めする。
const LOG_CHUNK_BLOCKS = parseInt(process.env.AAVE_LOG_CHUNK_BLOCKS || "2000", 10);
/// 読み取り幅の上下限。端点ごとに制限が違うので、決め打ちにしない。
const LOG_CHUNK_MIN = parseInt(process.env.AAVE_LOG_CHUNK_MIN || "500", 10);
const LOG_CHUNK_MAX = parseInt(process.env.AAVE_LOG_CHUNK_MAX || "50000", 10);
/// 清算の実績を遡る時の、1回の巡回での読み取り回数の上限。
const HIST_MAX_REQUESTS = parseInt(process.env.AAVE_HIST_MAX_REQUESTS || "6", 10);
/// 中央値を出すために取っておく件数の上限(保存ファイルが太らないように)。
const HIST_SIZE_SAMPLES = parseInt(process.env.AAVE_HIST_SIZE_SAMPLES || "3000", 10);
/// 「清算した人」を何人ぶんまで覚えておくか。
const HIST_MAX_LIQUIDATORS = parseInt(process.env.AAVE_HIST_MAX_LIQUIDATORS || "1000", 10);
/// 清算の実績を数えるか。false で止まる(名簿の方だけ動く)。
const HIST_ENABLED = process.env.AAVE_HISTORY !== "false";
/// 名簿に載せる人数の上限。これを超えたら古い順に捨てる。
const MAX_ROSTER = parseInt(process.env.AAVE_MAX_ROSTER || "5000", 10);
/// 健全度を1回の束ねで何人ぶん読むか。
const USERS_PER_CALL = parseInt(process.env.AAVE_USERS_PER_CALL || "150", 10);
/// 全員の健全度を測る時の、束ねの回数の上限。
const MAX_SWEEP_CALLS = parseInt(process.env.AAVE_MAX_SWEEP_CALLS || "40", 10);

// ===== 間隔 =====
/// 名簿を伸ばす間隔と、全員の健全度を測る間隔。
export const AAVE_SWEEP_INTERVAL_MS = parseInt(process.env.AAVE_SWEEP_INTERVAL_MS || String(10 * 60 * 1000), 10);
/// 危ない人だけを測り直す間隔(人数が少ないので短くてよい)。
export const AAVE_WATCH_INTERVAL_MS = parseInt(process.env.AAVE_WATCH_INTERVAL_MS || String(60 * 1000), 10);

/// これを下回ったら「危ない」として見張り名簿に入れる(18桁)。
const WATCH_HF = BigInt(process.env.AAVE_WATCH_HF || "1050000000000000000"); // 1.05
/// 清算できる境目。**1e18 未満**。
const LIQUIDATABLE_HF = 10n ** 18n;
/// 借金の50%までしか返せなくなる境目(これ未満なら100%)。
const CLOSE_FACTOR_HF = 950000000000000000n; // 0.95
/// 担保のボーナスの見積もり。資産ごとに5〜10%だが、第1段では控えめに5%で見る。
/// 実際の値は第2段で reserve ごとに読む。
const ASSUMED_BONUS_BPS = parseInt(process.env.AAVE_ASSUMED_BONUS_BPS || "500", 10);

/// 名簿を遡る時、1回の巡回でどれだけ過去に伸ばすか(チャンク数)。
/// Aave Pool は何年も前からあるので一度に全部は遡れない。毎回少しずつ伸ばし、
/// **前へ追いつきながら後ろへも伸ばす**。第1段は「直近の借り手」から始まるので、
/// 測った件数は**少なめに出る**ことを承知しておく。
const BACKFILL_CHUNKS_PER_RUN = parseInt(process.env.AAVE_BACKFILL_CHUNKS || "4", 10);

const MULTICALL3_ADDRESS = "0xcA11bde05977b3631167028862bE2a173976CA11";
const MULTICALL3_ABI = [
  "function aggregate3((address target, bool allowFailure, bytes callData)[] calls) view returns ((bool success, bytes returnData)[] returnData)",
];
const POOL_IFACE = new ethers.Interface([
  "function getUserAccountData(address user) view returns (uint256 totalCollateralBase, uint256 totalDebtBase, uint256 availableBorrowsBase, uint256 currentLiquidationThreshold, uint256 ltv, uint256 healthFactor)",
]);

/// Aave V3 の Borrow。topics[2] が onBehalfOf(実際に借りた人)。
/// Borrow(address indexed reserve, address user, address indexed onBehalfOf,
///        uint256 amount, uint8 interestRateMode, uint256 borrowRate, uint16 indexed referralCode)
const BORROW_TOPIC = "0xb3d084820fb1a9decffb176436bd02558d15fac9b0ddfed8c465bc7359d7dce0";

/// Aave V3 の LiquidationCall。**実際に清算が起きた記録**。
/// LiquidationCall(address indexed collateralAsset, address indexed debtAsset,
///   address indexed user, uint256 debtToCover, uint256 liquidatedCollateralAmount,
///   address liquidator, bool receiveAToken)
/// 添字なしの4語が data に並ぶ: debtToCover / 受け取った担保 / 清算した人 / aToken受取
/// (この topic0 は ethers.id() で計算して確かめた。思い込みで書いていない)
const LIQUIDATION_TOPIC = "0xe413a321e8681d831f4dbccbca790d2952b56f977908e45be37335533e005286";

/// 金額を USD に直すために使う。価格は **Aave 自身の価格オラクル**から取る
/// (清算の判定に使われているのと同じ価格なので、他所から持ってくるより正しい)。
const ADDRESSES_PROVIDER_IFACE = new ethers.Interface([
  "function ADDRESSES_PROVIDER() view returns (address)",
]);
const PRICE_ORACLE_LOCATOR_IFACE = new ethers.Interface([
  "function getPriceOracle() view returns (address)",
]);
const ORACLE_IFACE = new ethers.Interface([
  "function getAssetPrice(address asset) view returns (uint256)",
]);
const ERC20_IFACE = new ethers.Interface([
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
]);

/// 名簿と進み具合の保存先。プール地図と同じ場所(ボリューム)に置く。
const STATE_FILE = process.env.AAVE_STATE_FILE
  || (process.env.POOL_MAP_FILE
      ? path.join(path.dirname(process.env.POOL_MAP_FILE), "aave-borrowers.json")
      : "/tmp/aave-borrowers.json");

/// chain -> { users: [住所…], forwardFrom: 次に前へ読む番号, backwardTo: 次に後ろへ読む番号 }
const state = new Map();
/// 実測で応答を確かめられたチェーンだけを見張る。
let verifiedChains = [];
/// chain -> Map(住所 -> 健全度) 危ない人だけ
const watchList = new Map();
/// chain -> Map(住所 -> { at, hf, debtUsd }) 清算できる状態で見つけた人(追跡用)
const seenLiquidatable = new Map();

const stats = {
  rosterTotal: 0, sweeps: 0, watchChecks: 0, found: 0, taken: 0, recovered: 0,
  rpcCalls: 0, errors: 0, lastError: null, disabledChains: [], shrinks: 0,
};

function loadState() {
  try {
    if (!fs.existsSync(STATE_FILE)) return;
    const data = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
    for (const [chain, v] of Object.entries(data.chains || {})) {
      state.set(chain, {
        users: Array.isArray(v.users) ? v.users : [],
        forwardFrom: Number(v.forwardFrom) || 0,
        backwardTo: Number(v.backwardTo) || 0,
        histFrom: Number(v.histFrom) || 0,
        histTo: Number(v.histTo) || 0,
        hist: normalizeHist(v.hist),
      });
    }
  } catch (e) {
    console.warn(`[清算/名簿] 読み込みに失敗: ${(e.message || "").slice(0, 80)}`);
  }
}

function saveState() {
  try {
    const chains = {};
    for (const [chain, v] of state.entries()) {
      chains[chain] = {
        users: v.users, forwardFrom: v.forwardFrom, backwardTo: v.backwardTo,
        histFrom: v.histFrom, histTo: v.histTo, hist: v.hist,
      };
    }
    const tmp = STATE_FILE + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify({ savedAt: new Date().toISOString(), chains }));
    fs.renameSync(tmp, STATE_FILE);
  } catch (e) {
    console.warn(`[清算/名簿] 保存に失敗: ${(e.message || "").slice(0, 80)}`);
  }
}

function stateFor(chain) {
  if (!state.has(chain)) {
    state.set(chain, { users: [], forwardFrom: 0, backwardTo: 0, histFrom: 0, histTo: 0, hist: emptyHist() });
  }
  const st = state.get(chain);
  if (!st.hist) st.hist = emptyHist();
  return st;
}

/// 清算の実績をためる入れ物。
function emptyHist() {
  return { count: 0, sumUsd: 0, sizes: [], byLiquidator: {}, oldestBlock: 0, newestBlock: 0, unpriced: 0 };
}

function normalizeHist(h) {
  if (!h || typeof h !== "object") return emptyHist();
  return {
    count: Number(h.count) || 0,
    sumUsd: Number(h.sumUsd) || 0,
    sizes: Array.isArray(h.sizes) ? h.sizes.map(Number).filter((n) => Number.isFinite(n)).slice(-HIST_SIZE_SAMPLES) : [],
    byLiquidator: (h.byLiquidator && typeof h.byLiquidator === "object") ? { ...h.byLiquidator } : {},
    oldestBlock: Number(h.oldestBlock) || 0,
    newestBlock: Number(h.newestBlock) || 0,
    unpriced: Number(h.unpriced) || 0,
  };
}

function poolFor(chain) {
  return AAVE_POOLS[chain] || null;
}

/// オラクルの基準通貨(USD、8桁)を普通の数に直す。
function baseToUsd(v) {
  return Number(v) / 1e8;
}

/// 健全度(18桁)を読みやすい数に直す。
function hfToNumber(hf) {
  // 借金が無い人は uint256 の最大値が返る。そのまま数にすると桁が溢れる。
  if (hf > 10n ** 30n) return Infinity;
  return Number(hf) / 1e18;
}

// ===== ログの読み取り幅を実測で合わせる =====
//
// [なぜ固定をやめたか(2026年9月21日の実測)]
// 2,000ブロック固定で始めたところ、10分で4,000ブロックしか遡れず、
// base の全期間(約4,920万ブロック)を遡るのに**約85日**かかる計算だった。
// これでは「1〜3日測って判断する」が成立しない。
// 端点が1回にどれだけ返せるかは端点ごとに違うので、**成功したら倍・
// 断られたら半分**にして実測で合わせる。呼び出し回数は増えず、幅だけ広がる。

/// 用途ごとの現在の読み取り幅。key は "チェーン:用途"。
const chunkBlocks = new Map();

function chunkFor(key) {
  if (!chunkBlocks.has(key)) chunkBlocks.set(key, LOG_CHUNK_BLOCKS);
  return chunkBlocks.get(key);
}
function growChunk(key) {
  chunkBlocks.set(key, Math.min(LOG_CHUNK_MAX, Math.floor(chunkFor(key) * 2)));
}
function shrinkChunk(key) {
  chunkBlocks.set(key, Math.max(LOG_CHUNK_MIN, Math.floor(chunkFor(key) / 2)));
}

/// 「幅が広すぎる」と断られた時の文言。端点ごとに違うので幅広く見る。
/// **当てはまらない失敗は本当の失敗として数える**(通信障害を見逃さないため)。
function isRangeRefusal(msg) {
  const m = (msg || "").toLowerCase();
  return m.includes("range") || m.includes("limit") || m.includes("too many")
    || m.includes("exceed") || m.includes("too large") || m.includes("response size")
    || m.includes("-32005") || m.includes("query timeout");
}

/// getLogs を1回投げる。断られたら幅を縮めて **null** を返す(呼ぶ側が狭めて再挑戦)。
/// 成功したら幅を広げる。どちらも次回以降に効く。
async function tryGetLogs(chain, key, params, fromBlock, toBlock) {
  if (fromBlock > toBlock) return [];
  const span = toBlock - fromBlock + 1;
  stats.rpcCalls++;
  try {
    const logs = await callWithRpc(chain, (p) => p.send("eth_getLogs", [{
      ...params,
      fromBlock: "0x" + fromBlock.toString(16),
      toBlock: "0x" + toBlock.toString(16),
    }]));
    // **今の幅いっぱいを読めた時だけ広げる。**
    // 追いつき済みで数百ブロックしか読んでいない成功を「余裕がある証拠」にすると、
    // 実力より広い幅まで育ってしまい、次の遡りで無駄に断られる。
    if (span >= chunkFor(key)) growChunk(key);
    return logs || [];
  } catch (e) {
    const msg = (e.message || "").slice(0, 120);
    shrinkChunk(key);
    if (isRangeRefusal(msg)) {
      stats.shrinks++;  // 想定内。幅を合わせている最中
    } else {
      stats.errors++;
      stats.lastError = msg.slice(0, 80);
    }
    return null;
  }
}

// ===== ① 借り手の名簿を伸ばす =====

/// Borrow のイベントから借り手を集める。前へ追いつきながら、後ろへも少しずつ伸ばす。
async function refreshRoster(chain) {
  const pool = poolFor(chain);
  if (!pool) return;
  const st = stateFor(chain);
  const provider = getProviderForChain(chain);
  if (!provider) return;

  let latest;
  try {
    latest = await callWithRpc(chain, (p) => p.getBlockNumber());
    stats.rpcCalls++;
  } catch (e) {
    stats.errors++; stats.lastError = (e.message || "").slice(0, 80);
    return;
  }

  // 初回は「直近のひとかたまり」から始める。過去は毎回少しずつ遡る。
  if (!st.forwardFrom) {
    st.forwardFrom = Math.max(0, latest - LOG_CHUNK_BLOCKS);
    st.backwardTo = st.forwardFrom;
  }

  const before = st.users.length;
  const known = new Set(st.users);
  const key = `${chain}:roster`;
  const params = { address: pool, topics: [BORROW_TOPIC] };
  let requests = 0;

  const absorb = (logs) => {
    for (const log of logs) {
      // topics[2] が onBehalfOf。32バイトの右端20バイトが住所。
      const t = log?.topics?.[2];
      if (typeof t !== "string" || t.length < 66) continue;
      const addr = ethers.getAddress("0x" + t.slice(26));
      if (!known.has(addr)) { known.add(addr); st.users.push(addr); }
    }
  };

  // 前へ追いつく(新しく借りた人を拾う)。
  // **後ろへ伸ばす枠を必ず残す。** 前へ追いつく処理に全部の予算を食わせると、
  // 遅れを取り戻している間じゅう遡りが1ブロックも進まない
  // (今回直した「名簿が完成しない」のと同じ形の詰まりになる)。
  const forwardBudget = Math.max(1, MAX_LOG_REQUESTS - BACKFILL_CHUNKS_PER_RUN);
  while (st.forwardFrom <= latest && requests < forwardBudget) {
    const to = Math.min(latest, st.forwardFrom + chunkFor(key) - 1);
    requests++;
    const logs = await tryGetLogs(chain, key, params, st.forwardFrom, to);
    if (logs === null) continue; // 幅を縮めて次の回で狭く読み直す
    absorb(logs);
    st.forwardFrom = to + 1;
  }
  // 後ろへ伸ばす(昔から借りている人を拾う)。
  let backDone = 0;
  while (backDone < BACKFILL_CHUNKS_PER_RUN && st.backwardTo > 0 && requests < MAX_LOG_REQUESTS) {
    const from = Math.max(0, st.backwardTo - chunkFor(key));
    requests++;
    const logs = await tryGetLogs(chain, key, params, from, st.backwardTo - 1);
    if (logs === null) continue;
    absorb(logs);
    st.backwardTo = from;
    backDone++;
  }

  // 人数の上限。古い順(名簿の先頭)から捨てる。
  if (st.users.length > MAX_ROSTER) st.users = st.users.slice(st.users.length - MAX_ROSTER);

  const added = st.users.length - before;
  stats.rosterTotal = [...state.values()].reduce((n, v) => n + v.users.length, 0);
  if (added > 0 || requests > 0) {
    const backNote = st.backwardTo > 0
      ? `。過去へ ${st.backwardTo.toLocaleString()} まで遡り済み(残り${(latest - st.backwardTo > 0 ? st.backwardTo : 0).toLocaleString()}ブロック 幅${chunkFor(key).toLocaleString()})`
      : "。**全期間を遡り終えました**";
    console.log(`[清算/名簿] ${chain}: 借り手 ${st.users.length.toLocaleString()}人(新規 ${added}人)。RPC ${requests}回${backNote}`);
  }
}

// ===== ①-2 実際に起きた清算を数える(名簿に頼らない測り方)=====
//
// [なぜこれを足したか(2026年9月21日)]
// 名簿から「これから清算できそうな人」を探す作りは、名簿が完成するまで答えが出ない。
// 実測では base で約85日かかる見込みだった。**「1〜3日測って決める」に間に合わない。**
//
// 一方 LiquidationCall は「**実際に起きた清算**」の記録で、滅多に起きないぶん
// 1回の読み取りで何十万ブロックも見られる。第1段の問いにそのまま答えが出る。
//   ① どれくらいの頻度で起きているか
//   ② 規模はいくらか(= 小口は本当にあるのか)
//   ③ 誰が取っているか(= 小口まで専業が押さえているのか)
// 「小口は放置されている」は外部の研究からの**推定**でしかなかった。
// ここを実績の分布で置き換える。

/// chain -> 価格オラクルの住所(null は取れなかった)
const oracleFor = new Map();
/// chain -> Map(資産 -> { decimals, symbol, priceUsd })
const assetInfo = new Map();
/// chain -> { block, ts } いちばん古く読めたブロックの時刻(何日ぶん読めたかの計算用)
const oldestTs = new Map();

/// Aave の価格オラクルを Pool からたどる。**住所を決め打ちしない。**
async function ensureOracle(chain) {
  if (oracleFor.has(chain)) return oracleFor.get(chain);
  let oracle = null;
  try {
    stats.rpcCalls++;
    const r1 = await callWithRpc(chain, (p) => p.call({
      to: poolFor(chain),
      data: ADDRESSES_PROVIDER_IFACE.encodeFunctionData("ADDRESSES_PROVIDER"),
    }));
    const provider = ADDRESSES_PROVIDER_IFACE.decodeFunctionResult("ADDRESSES_PROVIDER", r1)[0];
    stats.rpcCalls++;
    const r2 = await callWithRpc(chain, (p) => p.call({
      to: provider,
      data: PRICE_ORACLE_LOCATOR_IFACE.encodeFunctionData("getPriceOracle"),
    }));
    oracle = PRICE_ORACLE_LOCATOR_IFACE.decodeFunctionResult("getPriceOracle", r2)[0];
    console.log(`[清算] ${chain}: 価格オラクル ${oracle} を Pool からたどりました`);
  } catch (e) {
    stats.errors++; stats.lastError = (e.message || "").slice(0, 80);
    console.warn(`[清算] ${chain}: 価格オラクルをたどれません(${(e.message || "").slice(0, 60)})。金額は数えません`);
  }
  oracleFor.set(chain, oracle);
  return oracle;
}

/// 資産の桁数・記号・価格をまとめて読む。**1資産につき1回だけ**。
async function resolveAssets(chain, addrs) {
  if (!assetInfo.has(chain)) assetInfo.set(chain, new Map());
  const known = assetInfo.get(chain);
  const missing = [...new Set(addrs)].filter((a) => !known.has(a));
  if (missing.length === 0) return known;

  const oracle = await ensureOracle(chain);
  const per = oracle ? 3 : 2;
  const calls = [];
  for (const a of missing) {
    calls.push({ target: a, allowFailure: true, callData: ERC20_IFACE.encodeFunctionData("decimals") });
    calls.push({ target: a, allowFailure: true, callData: ERC20_IFACE.encodeFunctionData("symbol") });
    if (oracle) calls.push({ target: oracle, allowFailure: true, callData: ORACLE_IFACE.encodeFunctionData("getAssetPrice", [a]) });
  }
  try {
    stats.rpcCalls++;
    const ret = await callWithRpc(chain, (p) =>
      new ethers.Contract(MULTICALL3_ADDRESS, MULTICALL3_ABI, p).aggregate3(calls));
    for (let i = 0; i < missing.length; i++) {
      let decimals = null, symbol = "", priceUsd = null;
      const d = ret[i * per], sy = ret[i * per + 1], pr = oracle ? ret[i * per + 2] : null;
      try { if (d?.success) decimals = Number(ERC20_IFACE.decodeFunctionResult("decimals", d.returnData)[0]); } catch (e2) {}
      try { if (sy?.success) symbol = String(ERC20_IFACE.decodeFunctionResult("symbol", sy.returnData)[0]).slice(0, 12); } catch (e2) {}
      try { if (pr?.success) priceUsd = baseToUsd(ORACLE_IFACE.decodeFunctionResult("getAssetPrice", pr.returnData)[0]); } catch (e2) {}
      known.set(missing[i], { decimals, symbol, priceUsd });
    }
  } catch (e) {
    stats.errors++; stats.lastError = (e.message || "").slice(0, 80);
  }
  return known;
}

/// いちばん古く読めたブロックが何日前かを返す(読めなければ null)。
async function daysSinceBlock(chain, block) {
  const cached = oldestTs.get(chain);
  if (cached && cached.block === block) return (Date.now() / 1000 - cached.ts) / 86400;
  try {
    stats.rpcCalls++;
    const b = await callWithRpc(chain, (p) => p.getBlock(block));
    if (!b) return null;
    oldestTs.set(chain, { block, ts: Number(b.timestamp) });
    return (Date.now() / 1000 - Number(b.timestamp)) / 86400;
  } catch (e) {
    return null;
  }
}

/// LiquidationCall を1件ぶん読み解く。data は添字なしの4語。
function decodeLiquidation(log) {
  const t = log?.topics;
  const data = log?.data;
  if (!Array.isArray(t) || t.length < 4 || typeof data !== "string" || data.length < 2 + 64 * 4) return null;
  try {
    return {
      block: Number(log.blockNumber),
      collateralAsset: ethers.getAddress("0x" + t[1].slice(26)),
      debtAsset: ethers.getAddress("0x" + t[2].slice(26)),
      user: ethers.getAddress("0x" + t[3].slice(26)),
      debtToCover: BigInt("0x" + data.slice(2, 66)),
      liquidator: ethers.getAddress("0x" + data.slice(2 + 64 * 2 + 24, 2 + 64 * 3)),
    };
  } catch (e) {
    return null;
  }
}

function median(arr) {
  if (arr.length === 0) return 0;
  const a = [...arr].sort((x, y) => x - y);
  const m = Math.floor(a.length / 2);
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}

/// 清算の実績を遡って数える。前へ(新しい清算)と後ろへ(過去)を両方進める。
export async function scanLiquidationHistory(chain) {
  if (!HIST_ENABLED) return;
  const pool = poolFor(chain);
  if (!pool) return;
  const st = stateFor(chain);

  let latest;
  try {
    latest = await callWithRpc(chain, (p) => p.getBlockNumber());
    stats.rpcCalls++;
  } catch (e) {
    stats.errors++; stats.lastError = (e.message || "").slice(0, 80);
    return;
  }
  if (!st.histFrom) { st.histFrom = latest; st.histTo = latest; }

  const key = `${chain}:hist`;
  const params = { address: pool, topics: [LIQUIDATION_TOPIC] };
  let requests = 0;
  const found = [];

  // 前へ(新しく起きた清算を拾う)。こちらも遡る枠を必ず残す。
  const histForwardBudget = Math.max(1, Math.floor(HIST_MAX_REQUESTS / 3));
  while (st.histFrom <= latest && requests < histForwardBudget) {
    const to = Math.min(latest, st.histFrom + chunkFor(key) - 1);
    requests++;
    const logs = await tryGetLogs(chain, key, params, st.histFrom, to);
    if (logs === null) continue;
    found.push(...logs);
    st.histFrom = to + 1;
  }
  // 後ろへ(過去の清算を掘る)。
  while (st.histTo > 0 && requests < HIST_MAX_REQUESTS) {
    const from = Math.max(0, st.histTo - chunkFor(key));
    requests++;
    const logs = await tryGetLogs(chain, key, params, from, st.histTo - 1);
    if (logs === null) continue;
    found.push(...logs);
    st.histTo = from;
  }
  if (requests === 0) return;

  const hist = st.hist;
  const records = found.map(decodeLiquidation).filter(Boolean);
  if (records.length > 0) {
    const known = await resolveAssets(chain, records.map((r) => r.debtAsset));
    for (const r of records) {
      hist.count++;
      hist.byLiquidator[r.liquidator] = (hist.byLiquidator[r.liquidator] || 0) + 1;
      if (!hist.oldestBlock || r.block < hist.oldestBlock) hist.oldestBlock = r.block;
      if (r.block > hist.newestBlock) hist.newestBlock = r.block;
      const info = known.get(r.debtAsset);
      if (!info || info.decimals == null || info.priceUsd == null) { hist.unpriced++; continue; }
      const usd = (Number(r.debtToCover) / 10 ** info.decimals) * info.priceUsd;
      if (!Number.isFinite(usd)) { hist.unpriced++; continue; }
      hist.sumUsd += usd;
      hist.sizes.push(usd);
    }
    if (hist.sizes.length > HIST_SIZE_SAMPLES) hist.sizes = hist.sizes.slice(-HIST_SIZE_SAMPLES);
    // 清算した人の記録も上限を付ける(保存ファイルが際限なく太らないように)。
    // 実際は多くても数百人なので、まず当たらない歯止め。
    const names = Object.keys(hist.byLiquidator);
    if (names.length > HIST_MAX_LIQUIDATORS) {
      const top = names.sort((a, b) => hist.byLiquidator[b] - hist.byLiquidator[a]).slice(0, HIST_MAX_LIQUIDATORS);
      const kept = {};
      for (const n of top) kept[n] = hist.byLiquidator[n];
      hist.byLiquidator = kept;
    }
  }

  await reportHistory(chain, st, latest, requests, records.length);
}

/// 数えた結果を1行で出す。**規模の分布と、誰が取っているかが要**。
async function reportHistory(chain, st, latest, requests, added) {
  const hist = st.hist;
  // 全期間を読み終えた後は、Aave が無かった時期まで日数に入れないよう
  // 「最初に見つけた清算」を起点にする。
  const spanBlock = st.histTo > 0 ? st.histTo : (hist.oldestBlock || 0);
  const days = await daysSinceBlock(chain, spanBlock);
  const spanNote = days != null ? `約${days.toFixed(1)}日ぶん` : `ブロック${spanBlock.toLocaleString()}まで`;
  const doneNote = st.histTo > 0 ? "" : "(**全期間を読み終えました**)";

  if (hist.count === 0) {
    console.log(`[清算/実績] ${chain}: ${spanNote}を読んで清算 0件${doneNote}。RPC ${requests}回 幅${chunkFor(`${chain}:hist`).toLocaleString()}`);
    return;
  }

  const small = hist.sizes.filter((v) => v < 100).length;
  const mid = hist.sizes.filter((v) => v >= 100 && v < 1000).length;
  const large = hist.sizes.filter((v) => v >= 1000).length;
  const priced = hist.sizes.length || 1;
  const perDay = days && days > 0 ? hist.count / days : null;

  const tally = Object.entries(hist.byLiquidator).sort((a, b) => b[1] - a[1]);
  const topShare = tally.length ? (tally[0][1] / hist.count) * 100 : 0;

  console.log(
    `[清算/実績] ${chain}: ${spanNote}で ${hist.count.toLocaleString()}件${doneNote}` +
    (perDay != null ? `(1日あたり${perDay.toFixed(1)}件)` : "") + `。新規${added}件。RPC ${requests}回\n` +
    `  規模: $100未満 ${small}件(${((small / priced) * 100).toFixed(0)}%) / ` +
    `$100〜1,000 ${mid}件 / $1,000超 ${large}件、中央$${median(hist.sizes).toFixed(2)}` +
    (hist.unpriced ? `(価格不明${hist.unpriced}件は除く)` : "") + `\n` +
    `  清算した人: ${tally.length}人、上位1者が${topShare.toFixed(0)}%` +
    (tally.length ? `(${tally[0][0].slice(0, 10)}… ${tally[0][1]}件)` : "") +
    `。※金額は**現在の価格**での換算(ステーブルの借金なら正確、変動資産は目安)`
  );
}

// ===== ② 健全度を測る =====

/// 指定した人たちの健全度をまとめて読む。戻り値: Map(住所 -> {hf, collateralUsd, debtUsd})
async function readHealth(chain, users, maxCalls) {
  const pool = poolFor(chain);
  const out = new Map();
  // 戻り値の形は必ず { map, calls }。ここで Map だけ返すと呼ぶ側が壊れる。
  if (!pool || users.length === 0) return { map: out, calls: 0 };

  let calls = 0;
  for (let i = 0; i < users.length && calls < maxCalls; i += USERS_PER_CALL) {
    const slice = users.slice(i, i + USERS_PER_CALL);
    const batch = slice.map((u) => ({
      target: pool, allowFailure: true,
      callData: POOL_IFACE.encodeFunctionData("getUserAccountData", [u]),
    }));
    try {
      calls++;
      stats.rpcCalls++;
      const returned = await callWithRpc(chain, (p) =>
        new ethers.Contract(MULTICALL3_ADDRESS, MULTICALL3_ABI, p).aggregate3(batch));
      for (let j = 0; j < slice.length; j++) {
        const r = returned[j];
        if (!r?.success || r.returnData === "0x") continue;
        try {
          const d = POOL_IFACE.decodeFunctionResult("getUserAccountData", r.returnData);
          out.set(slice[j], {
            collateralUsd: baseToUsd(d[0]),
            debtUsd: baseToUsd(d[1]),
            hf: d[5],
          });
        } catch (inner) {}
      }
    } catch (e) {
      stats.errors++; stats.lastError = (e.message || "").slice(0, 80);
      break;
    }
  }
  return { map: out, calls };
}

/// 清算できる人を見つけたら、規模と見込みの利益をログに出す(**送信はしない**)。
function reportLiquidatable(chain, user, info) {
  const hf = hfToNumber(info.hf);
  // 一度に返せる割合。HF<0.95 なら100%、それ以外は50%。
  const closeFactor = info.hf < CLOSE_FACTOR_HF ? 1.0 : 0.5;
  const coverUsd = info.debtUsd * closeFactor;
  // 担保をボーナスぶん多く受け取れる。第1段は控えめに5%で見積もる。
  const grossUsd = coverUsd * (ASSUMED_BONUS_BPS / 10000);

  const seen = seenLiquidatable.get(chain) || new Map();
  if (!seen.has(user)) {
    stats.found++;
    seen.set(user, { at: Date.now(), hf, debtUsd: info.debtUsd });
    seenLiquidatable.set(chain, seen);
    console.log(
      `[清算/見つけた] ${chain} ${user.slice(0, 10)}…: HF ${hf.toFixed(4)} ` +
      `借金$${info.debtUsd.toFixed(2)} 担保$${info.collateralUsd.toFixed(2)} ` +
      `→ 肩代わり$${coverUsd.toFixed(2)}(${closeFactor * 100}%まで) ` +
      `ボーナス${ASSUMED_BONUS_BPS / 100}%で粗利**$${grossUsd.toFixed(2)}**(担保の売却手数料とガス代は未計算)`
    );
  }
}

/// 前に見つけた人がどうなったかを追う。**「誰が取ったか」を知るため。**
function trackResolved(chain, healthMap) {
  const seen = seenLiquidatable.get(chain);
  if (!seen || seen.size === 0) return;
  for (const [user, rec] of [...seen.entries()]) {
    const now = healthMap.get(user);
    if (!now) continue; // 測れていない
    if (now.hf >= LIQUIDATABLE_HF) {
      const mins = Math.round((Date.now() - rec.at) / 60000);
      // 借金が大きく減っていれば他人が清算した。減っていなければ自力で回復した。
      const cleared = now.debtUsd < rec.debtUsd * 0.9;
      if (cleared) stats.taken++; else stats.recovered++;
      console.log(
        `[清算/追跡] ${chain} ${user.slice(0, 10)}…: ${mins}分後に清算できなくなりました` +
        `(${cleared ? "**他者が清算した**" : "自力で回復した"}。借金$${rec.debtUsd.toFixed(2)}→$${now.debtUsd.toFixed(2)})`
      );
      seen.delete(user);
    }
  }
}

/// 全員の健全度を測り、危ない人を見張り名簿に入れる。
export async function sweepChain(chain) {
  const st = stateFor(chain);
  if (st.users.length === 0) return;
  const { map, calls } = await readHealth(chain, st.users, MAX_SWEEP_CALLS);
  if (map.size === 0) return;
  stats.sweeps++;

  const watch = new Map();
  let liquidatable = 0;
  for (const [user, info] of map.entries()) {
    if (info.hf < LIQUIDATABLE_HF) {
      liquidatable++;
      reportLiquidatable(chain, user, info);
      watch.set(user, info.hf);
    } else if (info.hf < WATCH_HF) {
      watch.set(user, info.hf);
    }
  }
  watchList.set(chain, watch);
  trackResolved(chain, map);

  console.log(
    `[清算/健全度] ${chain}: 測定 ${map.size.toLocaleString()}人 / ` +
    `危険(HF<${hfToNumber(WATCH_HF).toFixed(2)}) ${watch.size}人 / 清算可(HF<1.00) ${liquidatable}人。RPC ${calls}回`
  );
}

/// 危ない人だけを測り直す(人数が少ないので頻繁にやれる)。
export async function checkWatchChain(chain) {
  const watch = watchList.get(chain);
  if (!watch || watch.size === 0) return;
  const users = [...watch.keys()];
  const { map } = await readHealth(chain, users, 3);
  if (map.size === 0) return;
  stats.watchChecks++;

  const next = new Map();
  for (const [user, info] of map.entries()) {
    if (info.hf < LIQUIDATABLE_HF) reportLiquidatable(chain, user, info);
    if (info.hf < WATCH_HF) next.set(user, info.hf);
  }
  watchList.set(chain, next);
  trackResolved(chain, map);
}

// ===== 入口 =====

/// 対象チェーンで Aave の Pool が実際に応答するかを確かめる。
/// **住所は公開情報だが、思い込みで進めない。** 応答しないチェーンは外す。
export async function verifyAaveChains(activeChains) {
  if (!AAVE_ENABLED) return [];
  loadState();
  const targets = AAVE_CHAINS.filter((c) => activeChains.includes(c) && poolFor(c));
  const ok = [];
  for (const chain of targets) {
    try {
      // 誰でもよいので1人分読む。住所が違えば取り消されるか空が返る。
      const data = POOL_IFACE.encodeFunctionData("getUserAccountData", [ethers.ZeroAddress]);
      const ret = await callWithRpc(chain, (p) => p.call({ to: poolFor(chain), data }));
      stats.rpcCalls++;
      if (!ret || ret === "0x") throw new Error("空が返りました");
      POOL_IFACE.decodeFunctionResult("getUserAccountData", ret);
      ok.push(chain);
      console.log(`[清算] ${chain}: Aave V3 Pool ${poolFor(chain)} に応答を確認しました`);
    } catch (e) {
      stats.disabledChains.push(chain);
      console.warn(`[清算] ${chain}: Aave V3 Pool ${poolFor(chain)} が応答しません(${(e.message || "").slice(0, 60)})。このチェーンは見張りません`);
    }
  }
  verifiedChains = ok;
  return ok;
}

export function getAaveChains() { return [...verifiedChains]; }

/// 全チェーンの名簿を伸ばし、健全度を測る。
export async function sweepAll() {
  for (const chain of verifiedChains) {
    try {
      await refreshRoster(chain);
      await sweepChain(chain);
      await scanLiquidationHistory(chain);
    } catch (e) {
      stats.errors++; stats.lastError = (e.message || "").slice(0, 80);
    }
  }
  saveState();
}

/// 危ない人だけを測り直す(短い間隔で呼ぶ)。
export async function checkWatchAll() {
  for (const chain of verifiedChains) {
    try { await checkWatchChain(chain); } catch (e) {
      stats.errors++; stats.lastError = (e.message || "").slice(0, 80);
    }
  }
}

/// 生存ログ用の1行。まだ何も測れていないうちは空を返す。
export function formatAaveLine() {
  if (verifiedChains.length === 0) return "";
  const watching = [...watchList.values()].reduce((n, m) => n + m.size, 0);

  // 実績(過去に実際に起きた清算)。**規模の分布がこの第1段の答えそのもの**なので、
  // 生存ログにも小口の割合まで出す。
  let histCount = 0, histSmall = 0, histPriced = 0;
  for (const v of state.values()) {
    const h = v.hist;
    if (!h) continue;
    histCount += h.count;
    histPriced += h.sizes.length;
    histSmall += h.sizes.filter((x) => x < 100).length;
  }
  const histNote = histCount > 0
    ? ` 実績${histCount.toLocaleString()}件${histPriced ? `(小口${Math.round((histSmall / histPriced) * 100)}%)` : ""}`
    : "";

  return ` 清算[名簿${stats.rosterTotal.toLocaleString()} 見張り${watching} 見つけた${stats.found} 他者${stats.taken} 回復${stats.recovered}${histNote} RPC${stats.rpcCalls}${stats.errors ? ` 失敗${stats.errors}` : ""}]`;
}

export function getAaveStats() {
  return { ...stats, chains: [...verifiedChains], watching: [...watchList.values()].reduce((n, m) => n + m.size, 0) };
}
