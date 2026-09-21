// scripts/liquidation-monitor.js
//
// Avalanche の Aave V3 を見張り、清算できる借り手を見つける(第2段の本体)。
//
// [役割の分担]
//   scripts/aave-liquidation.js … 5チェーンの**計測**(読み取りのみ。avalanche はこちらへ移した)
//   このファイル               … avalanche の**見張りと判断**。送信は LIQUIDATION_DRY_RUN=false の時だけ
//
// [仕組み]
//   ① 名簿: 起動時に過去60日の Borrow から借り手を集める(裏で少しずつ遡る)。
//      以後は Borrow / Supply / Repay / Withdraw / LiquidationCall で名簿を更新する
//   ② 健全度: getUserAccountData を Multicall3 で束ねて読む。
//      HF < 1.05 は「要注意」として20秒ごと、それ以外は5分ごと
//   ③ 価格: Chainlink の AnswerUpdated を WebSocket で購読し、その資産を担保か借金に
//      持つ要注意の人を**即**測り直す(清算は価格更新の直後に起きる)
//   ④ HF < 1 の人は担保と借金の内訳を読み、清算する組(担保・借金・debtToCover)を決める
//
// [WebSocket は裁定と別の接続]
// 既存の DEX 購読(dex-onchain-realtime.js)には手を入れない。ここで受けるのは
// Aave の Pool と Chainlink のフィードだけで、件数は1日数千件に収まる。
//
// [RPC の枠]
// 名簿の遡りは1回の巡回で数回まで、健全度は1回の束ねで150人まで。
// 全部の入口に上限を付け、裁定の枠を食い潰さない。

import { ethers } from "ethers";
import fs from "fs";
import path from "path";
import { AaveV3Avalanche } from "@aave-dao/aave-address-book";
import { callWithRpc } from "./onchain-reserves.js";
import { MULTICALL3_ADDRESS } from "./multicall-reserves.js";
// お金に関わる行は、Railway の UTC ではなく**日本時間**で読めるようにする。
import { nowJst } from "./jst.js";

// ===== 対象(Avalanche のみ)=====
export const CHAIN = "avalanche";
/// Pool の住所は address-book から取る(思い込みで書かない)。起動時に応答を確かめる。
const POOL_ADDRESS = AaveV3Avalanche.POOL;
const ORACLE_ADDRESS = AaveV3Avalanche.ORACLE;
const DATA_PROVIDER_ADDRESS = AaveV3Avalanche.AAVE_PROTOCOL_DATA_PROVIDER;

// ===== 設定(環境変数。一覧は docs/HANDOVER.md)=====
const ENABLED = process.env.LIQUIDATION_ENABLED !== "false";
/// 既定は**送らない**。候補の検出と確認(eth_call)までを行い、ログと画面に出す。
export const DRY_RUN = process.env.LIQUIDATION_DRY_RUN !== "false";
/// 清算の最低利益。**オーナーの決定で $0.5 → $0.00001(2026年9月21日)。**
///
/// [なぜ下げたか]
/// $0.5 は私が手で決めた数字で、**$0.5未満の清算候補を確認すらせずに捨てていた**。
/// 清算の狙いは「小口は放置されている」なので、その小口を自分で捨てていたことになる。
/// 送るかどうかは `simulateLiquidation`(eth_call)で出た**実際の利益**が
/// ガス代を上回るかで決める。それが「手数料負けするなら見送る」。
export const MIN_PROFIT_USD = Number(process.env.LIQUIDATION_MIN_PROFIT_USD || "0.00001");
export const MAX_DEBT_USD = Number(process.env.LIQUIDATION_MAX_DEBT_USD || "2000");
/// 担保を売る時の滑りがこれを超える組は見送る。
export const MAX_SLIPPAGE_BPS = parseInt(process.env.LIQUIDATION_MAX_SLIPPAGE_BPS || "300", 10);
/// 同じ借り手への連続実行を避ける冷却時間。
export const COOLDOWN_MS = parseInt(process.env.LIQUIDATION_COOLDOWN_MS || String(5 * 60 * 1000), 10);
/// 名簿を作る時に遡る日数。
const ROSTER_DAYS = Number(process.env.LIQUIDATION_ROSTER_DAYS || "60");
/// 要注意にする健全度(18桁)。
const WATCH_HF = ethers.parseUnits(process.env.LIQUIDATION_WATCH_HF || "1.05", 18);
export const WATCH_INTERVAL_MS = parseInt(process.env.LIQUIDATION_WATCH_INTERVAL_MS || "20000", 10);
export const SWEEP_INTERVAL_MS = parseInt(process.env.LIQUIDATION_SWEEP_INTERVAL_MS || String(5 * 60 * 1000), 10);
/// 名簿の遡りの間隔と、1回に投げる getLogs の回数。
const BACKFILL_INTERVAL_MS = parseInt(process.env.LIQUIDATION_BACKFILL_INTERVAL_MS || "5000", 10);
const BACKFILL_CHUNKS_PER_TICK = parseInt(process.env.LIQUIDATION_BACKFILL_CHUNKS || "3", 10);
/// getLogs 1回のブロック幅の出発点と上下限(端点の制限に合わせて自動で広げ縮めする)。
const LOG_CHUNK_BLOCKS = parseInt(process.env.LIQUIDATION_LOG_CHUNK_BLOCKS || "2000", 10);
const LOG_CHUNK_MIN = 200;
const LOG_CHUNK_MAX = parseInt(process.env.LIQUIDATION_LOG_CHUNK_MAX || "100000", 10);
/// 健全度を1回の束ねで何人ぶん読むか、全員を測る時の束ねの上限。
const USERS_PER_CALL = parseInt(process.env.LIQUIDATION_USERS_PER_CALL || "150", 10);
const MAX_SWEEP_CALLS = parseInt(process.env.LIQUIDATION_MAX_SWEEP_CALLS || "80", 10);
/// 名簿の上限(超えたら最後に見た時期が古い順に捨てる)。
const MAX_ROSTER = parseInt(process.env.LIQUIDATION_MAX_ROSTER || "12000", 10);
/// 要注意の内訳(担保・借金)を一度に読む人数の上限。
const MAX_BREAKDOWN_USERS = parseInt(process.env.LIQUIDATION_MAX_BREAKDOWN_USERS || "60", 10);
/// WebSocket の URL。裁定と同じ端点を既定にする(別接続)。
const WSS_URL = process.env.LIQUIDATION_WSS_URL || process.env.AVALANCHE_WSS_URL || "";

// ===== Aave の定数(v3.3 の LiquidationLogic より)=====
const LIQUIDATABLE_HF = 10n ** 18n;
/// これ未満なら100%返せる。
const CLOSE_FACTOR_HF = ethers.parseUnits("0.95", 18);
/// 借金か担保が(その通貨で)これ未満なら100%返せる(v3.3 で追加された小口の規則)。base は USD 8桁。
const MIN_BASE_MAX_CLOSE_FACTOR_THRESHOLD = 2000n * 10n ** 8n;
/// 借金と担保の**両方**を残す時は、それぞれこれ以上残さないと拒否される(MUST_NOT_LEAVE_DUST)。
const MIN_LEFTOVER_BASE = 1000n * 10n ** 8n;

// ===== ABI =====
const POOL_IFACE = new ethers.Interface([
  "function getUserAccountData(address user) view returns (uint256 totalCollateralBase, uint256 totalDebtBase, uint256 availableBorrowsBase, uint256 currentLiquidationThreshold, uint256 ltv, uint256 healthFactor)",
  "function getReservesList() view returns (address[])",
  "function getUserEMode(address user) view returns (uint256)",
]);
const ORACLE_IFACE = new ethers.Interface([
  "function getAssetsPrices(address[] assets) view returns (uint256[])",
  "function getSourceOfAsset(address asset) view returns (address)",
]);
const DATA_PROVIDER_IFACE = new ethers.Interface([
  "function getReserveConfigurationData(address asset) view returns (uint256 decimals, uint256 ltv, uint256 liquidationThreshold, uint256 liquidationBonus, uint256 reserveFactor, bool usageAsCollateralEnabled, bool borrowingEnabled, bool stableBorrowRateEnabled, bool isActive, bool isFrozen)",
  "function getLiquidationProtocolFee(address asset) view returns (uint256)",
  "function getUserReserveData(address asset, address user) view returns (uint256 currentATokenBalance, uint256 currentStableDebt, uint256 currentVariableDebt, uint256 principalStableDebt, uint256 scaledVariableDebt, uint256 stableBorrowRate, uint256 liquidityRate, uint40 stableRateLastUpdated, bool usageAsCollateralEnabled)",
]);
const ERC20_IFACE = new ethers.Interface([
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
]);
/// Chainlink のフィード。プロキシ(EACAggregatorProxy)は aggregator() を持ち、
/// Aave の価格調整器(CAPO)は ASSET_TO_USD_AGGREGATOR / BASE_TO_USD_AGGREGATOR を持つ。
const FEED_IFACE = new ethers.Interface([
  "function aggregator() view returns (address)",
  "function ASSET_TO_USD_AGGREGATOR() view returns (address)",
  "function BASE_TO_USD_AGGREGATOR() view returns (address)",
]);
const MULTICALL3_ABI = [
  "function aggregate3((address target, bool allowFailure, bytes callData)[] calls) view returns ((bool success, bytes returnData)[] returnData)",
];

// イベントの識別子は手で書かず、形から計算する(1文字欠けの再発防止)。
const TOPIC_BORROW = ethers.id("Borrow(address,address,address,uint256,uint8,uint256,uint16)");
const TOPIC_SUPPLY = ethers.id("Supply(address,address,address,uint256,uint16)");
const TOPIC_REPAY = ethers.id("Repay(address,address,address,uint256,bool)");
const TOPIC_WITHDRAW = ethers.id("Withdraw(address,address,address,uint256)");
const TOPIC_LIQUIDATION = ethers.id("LiquidationCall(address,address,address,uint256,uint256,address,bool)");
const TOPIC_ANSWER_UPDATED = ethers.id("AnswerUpdated(int256,uint256,uint256)");
const POOL_TOPICS = [TOPIC_BORROW, TOPIC_SUPPLY, TOPIC_REPAY, TOPIC_WITHDRAW, TOPIC_LIQUIDATION];
/// 既存の計測モジュールで確かめ済みの値と突き合わせる(計算違いの早期発見)。
const TOPIC_BORROW_CONFIRMED = "0xb3d084820fb1a9decffb176436bd02558d15fac9b0ddfed8c465bc7359d7dce0";
const TOPIC_LIQUIDATION_CONFIRMED = "0xe413a321e8681d831f4dbccbca790d2952b56f977908e45be37335533e005286";
if (TOPIC_BORROW !== TOPIC_BORROW_CONFIRMED || TOPIC_LIQUIDATION !== TOPIC_LIQUIDATION_CONFIRMED) {
  console.error("[清算AVAX] 致命的: イベント識別子が確認済みの値と一致しません");
}

// ===== 保存 =====
const STATE_FILE = process.env.LIQUIDATION_STATE_FILE
  || (process.env.POOL_MAP_FILE
      ? path.join(path.dirname(process.env.POOL_MAP_FILE), "liquidation-avalanche.json")
      : "/tmp/liquidation-avalanche.json");
const STATE_VERSION = 1;

/// 名簿: 住所(小文字) -> { seenBlock: 最後に見たブロック }
const roster = new Map();
/// 遡りの進み具合。cursor から下(古い方)へ読み、targetFrom に届いたら完了。
const backfill = { targetFrom: 0, cursor: 0, done: false, latestAtStart: 0 };
/// 生のイベントで追いついた最後のブロック(取りこぼしを getLogs で埋める起点)。
let liveBlock = 0;

function loadState() {
  try {
    if (!fs.existsSync(STATE_FILE)) return;
    const raw = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
    if (raw.version !== STATE_VERSION) return;
    for (const [u, v] of Object.entries(raw.roster || {})) roster.set(u, { seenBlock: v.seenBlock || 0 });
    Object.assign(backfill, raw.backfill || {});
    liveBlock = raw.liveBlock || 0;
    console.log(`[清算AVAX] 保存から復元: 名簿${roster.size}人 遡り${backfill.done ? "完了" : `途中(${backfill.cursor})`} 追いつき${liveBlock}`);
  } catch (e) {
    console.warn(`[清算AVAX] 保存の読み込みに失敗: ${(e.message || "").slice(0, 80)}`);
  }
}

function saveState() {
  try {
    const out = { version: STATE_VERSION, roster: {}, backfill, liveBlock, savedAt: new Date().toISOString() };
    for (const [u, v] of roster) out.roster[u] = v;
    fs.writeFileSync(STATE_FILE, JSON.stringify(out));
  } catch (e) {
    console.warn(`[清算AVAX] 保存に失敗: ${(e.message || "").slice(0, 80)}`);
  }
}

// ===== 状態(メモリ)=====
/// 資産の情報: 住所(小文字) -> { symbol, decimals, bonusBps, protocolFeeBps, collateralEnabled, price(8桁), source }
const reserves = new Map();
let reserveList = [];
/// フィードの住所(小文字) -> その価格で評価される資産の集合
const feedToAssets = new Map();
/// 健全度: 住所 -> { hf, collateralUsd, debtUsd, at }
const health = new Map();
/// 要注意(HF < 1.05)の集合。
const watch = new Set();
/// 要注意の内訳: 住所 -> { at, items: [{ asset, aToken(担保量), debt(借金量), collateralEnabled }] }
const breakdown = new Map();
/// 即測り直す予約(イベントや価格更新で入る)。
const recheckQueue = new Set();
/// 清算できる人の記録: 住所 -> { firstAt, plan, lastPlanAt, attempts, lastResult }
const candidates = new Map();
/// 最近の候補(画面用、新しい順)。
const recentCandidates = [];
/// 最後に実行(または DRY_RUN で確認)した時刻: 住所 -> ms
const lastActionAt = new Map();

const stats = {
  enabled: false, verified: false, wsConnected: false, wsReconnects: 0,
  rpcCalls: 0, errors: 0, lastError: null, shrinks: 0,
  poolEvents: 0, priceEvents: 0, priceRechecks: 0,
  sweeps: 0, watchChecks: 0, found: 0, takenByOthers: 0, recovered: 0,
  feedsResolved: 0, feedsUnresolved: 0,
  lastSweepAt: null, lastPriceEventAt: null,
  simulated: 0, sent: 0, sentOk: 0,
};

/// 外から差し込む「候補が出た時の処理」(第2段: 確認と送信)。無ければログのみ。
let onCandidate = null;
export function setCandidateHandler(fn) { onCandidate = fn; }

// ===== RPC の小道具 =====
async function rpc(fn, priority = false) {
  stats.rpcCalls++;
  return callWithRpc(CHAIN, fn, priority);
}

async function multicall(calls, priority = false) {
  return rpc((p) => new ethers.Contract(MULTICALL3_ADDRESS, MULTICALL3_ABI, p).aggregate3(calls), priority);
}

let chunkBlocks = LOG_CHUNK_BLOCKS;
/// 「幅が広すぎる」と断られた幅の直下を天井にする。同じ幅で何度も断られない。
let chunkCeiling = LOG_CHUNK_MAX;
function isRangeRefusal(msg) {
  const m = (msg || "").toLowerCase();
  return m.includes("range") || m.includes("limit") || m.includes("too many")
    || m.includes("exceed") || m.includes("too large") || m.includes("response size")
    || m.includes("-32005") || m.includes("query timeout");
}

/// getLogs を1回投げる。断られたら幅を縮めて null を返す。成功したら幅を広げる。
async function tryGetLogs(params, fromBlock, toBlock) {
  if (fromBlock > toBlock) return [];
  const span = toBlock - fromBlock + 1;
  try {
    const logs = await rpc((p) => p.send("eth_getLogs", [{
      ...params,
      fromBlock: "0x" + fromBlock.toString(16),
      toBlock: "0x" + toBlock.toString(16),
    }]));
    if (span >= chunkBlocks) chunkBlocks = Math.min(chunkCeiling, chunkBlocks * 2);
    return logs || [];
  } catch (e) {
    const msg = (e.message || "").slice(0, 120);
    chunkBlocks = Math.max(LOG_CHUNK_MIN, Math.floor(chunkBlocks / 2));
    if (isRangeRefusal(msg)) {
      stats.shrinks++;
      chunkCeiling = Math.max(LOG_CHUNK_MIN, Math.min(chunkCeiling, span - 1));
    } else { stats.errors++; stats.lastError = msg.slice(0, 80); }
    return null;
  }
}

function baseToUsd(v) { return Number(v) / 1e8; }
function hfToNumber(hf) {
  if (hf >= 2n ** 128n) return Infinity; // 借金が無い人は最大値が返る
  return Number(hf) / 1e18;
}
function short(a) { return (a || "").slice(0, 10) + "…"; }
function sym(asset) { return reserves.get((asset || "").toLowerCase())?.symbol || short(asset); }

// ===== 起動: 応答の確認・資産の情報・フィードの解決 =====

async function verifyPool() {
  const data = POOL_IFACE.encodeFunctionData("getUserAccountData", [ethers.ZeroAddress]);
  const ret = await rpc((p) => p.call({ to: POOL_ADDRESS, data }));
  if (!ret || ret === "0x") throw new Error("空が返りました");
  POOL_IFACE.decodeFunctionResult("getUserAccountData", ret);
}

async function loadReserves() {
  const listRaw = await rpc((p) => p.call({ to: POOL_ADDRESS, data: POOL_IFACE.encodeFunctionData("getReservesList", []) }));
  reserveList = POOL_IFACE.decodeFunctionResult("getReservesList", listRaw)[0].map((a) => a.toLowerCase());

  const calls = [];
  for (const asset of reserveList) {
    const a = ethers.getAddress(asset);
    calls.push({ target: DATA_PROVIDER_ADDRESS, allowFailure: true, callData: DATA_PROVIDER_IFACE.encodeFunctionData("getReserveConfigurationData", [a]) });
    calls.push({ target: DATA_PROVIDER_ADDRESS, allowFailure: true, callData: DATA_PROVIDER_IFACE.encodeFunctionData("getLiquidationProtocolFee", [a]) });
    calls.push({ target: a, allowFailure: true, callData: ERC20_IFACE.encodeFunctionData("symbol", []) });
    calls.push({ target: ORACLE_ADDRESS, allowFailure: true, callData: ORACLE_IFACE.encodeFunctionData("getSourceOfAsset", [a]) });
  }
  const returned = await multicall(calls);
  for (let i = 0; i < reserveList.length; i++) {
    const asset = reserveList[i];
    const [rc, rf, rs, ro] = [returned[i * 4], returned[i * 4 + 1], returned[i * 4 + 2], returned[i * 4 + 3]];
    const info = { symbol: short(asset), decimals: 18, bonusBps: 0, protocolFeeBps: 0, collateralEnabled: false, active: false, frozen: false, price: 0n, source: null };
    try {
      if (rc?.success) {
        const d = DATA_PROVIDER_IFACE.decodeFunctionResult("getReserveConfigurationData", rc.returnData);
        info.decimals = Number(d[0]);
        // liquidationBonus は 10500 = 5% の形。ボーナスだけを bps にする。
        info.bonusBps = Math.max(0, Number(d[3]) - 10000);
        info.collateralEnabled = Boolean(d[5]);
        info.active = Boolean(d[8]);
        info.frozen = Boolean(d[9]);
      }
      if (rf?.success) info.protocolFeeBps = Number(DATA_PROVIDER_IFACE.decodeFunctionResult("getLiquidationProtocolFee", rf.returnData)[0]);
      if (rs?.success) { try { info.symbol = ERC20_IFACE.decodeFunctionResult("symbol", rs.returnData)[0]; } catch (e) {} }
      if (ro?.success) info.source = ORACLE_IFACE.decodeFunctionResult("getSourceOfAsset", ro.returnData)[0].toLowerCase();
    } catch (e) {}
    reserves.set(asset, info);
  }
  await refreshPrices(reserveList);
  const line = reserveList.map((a) => { const r = reserves.get(a); return `${r.symbol}(ボーナス${(r.bonusBps / 100).toFixed(1)}% $${baseToUsd(r.price).toFixed(2)})`; }).join(" ");
  console.log(`[清算AVAX/資産] ${reserveList.length}種: ${line}`);
}

/// Aave 自身のオラクルから価格を読み直す(清算の判定に使われているのと同じ価格)。
async function refreshPrices(assets) {
  if (assets.length === 0) return;
  try {
    const raw = await rpc((p) => p.call({ to: ORACLE_ADDRESS, data: ORACLE_IFACE.encodeFunctionData("getAssetsPrices", [assets.map((a) => ethers.getAddress(a))]) }));
    const prices = ORACLE_IFACE.decodeFunctionResult("getAssetsPrices", raw)[0];
    assets.forEach((a, i) => { const r = reserves.get(a); if (r) r.price = prices[i]; });
  } catch (e) {
    stats.errors++; stats.lastError = `価格: ${(e.message || "").slice(0, 60)}`;
  }
}

/// 価格の出どころ(フィード)を辿り、AnswerUpdated を出す本体(aggregator)の住所を集める。
/// 解決できなくても source そのものを購読するので、取りこぼしても安全側。
async function resolveFeeds() {
  const sources = [...new Set([...reserves.values()].map((r) => r.source).filter(Boolean))];
  const addFeed = (addr, asset) => {
    const k = addr.toLowerCase();
    if (!feedToAssets.has(k)) feedToAssets.set(k, new Set());
    feedToAssets.get(k).add(asset);
  };
  const assetsOf = (source) => reserveList.filter((a) => reserves.get(a)?.source === source);
  const probe = async (addrs) => {
    if (addrs.length === 0) return new Map();
    const calls = [];
    for (const s of addrs) {
      const t = ethers.getAddress(s);
      for (const fn of ["aggregator", "ASSET_TO_USD_AGGREGATOR", "BASE_TO_USD_AGGREGATOR"]) {
        calls.push({ target: t, allowFailure: true, callData: FEED_IFACE.encodeFunctionData(fn, []) });
      }
    }
    const returned = await multicall(calls);
    const out = new Map();
    addrs.forEach((s, i) => {
      const found = [];
      ["aggregator", "ASSET_TO_USD_AGGREGATOR", "BASE_TO_USD_AGGREGATOR"].forEach((fn, j) => {
        const r = returned[i * 3 + j];
        if (!r?.success || r.returnData === "0x") return;
        try {
          const a = FEED_IFACE.decodeFunctionResult(fn, r.returnData)[0];
          if (a && a !== ethers.ZeroAddress) found.push({ fn, address: a.toLowerCase() });
        } catch (e) {}
      });
      out.set(s, found);
    });
    return out;
  };

  // 1段目: source 自身(プロキシか調整器)。2段目: 調整器が指すプロキシの aggregator。
  const first = await probe(sources);
  const second = [];
  for (const s of sources) {
    const assets = assetsOf(s);
    for (const a of assets) addFeed(s, a);
    const found = first.get(s) || [];
    for (const f of found) {
      for (const a of assets) addFeed(f.address, a);
      if (f.fn !== "aggregator") second.push({ address: f.address, assets });
    }
  }
  if (second.length > 0) {
    const secondMap = await probe(second.map((x) => x.address));
    for (const x of second) {
      for (const f of secondMap.get(x.address) || []) for (const a of x.assets) addFeed(f.address, a);
    }
  }
  stats.feedsResolved = sources.filter((s) => (first.get(s) || []).length > 0).length;
  stats.feedsUnresolved = sources.length - stats.feedsResolved;
  const unresolved = sources.filter((s) => (first.get(s) || []).length === 0).map((s) => `${assetsOf(s).map(sym).join("/")}=${short(s)}`);
  console.log(`[清算AVAX/価格] 出どころ${sources.length}件 → 購読する住所${feedToAssets.size}件(本体まで辿れた${stats.feedsResolved}件${unresolved.length ? ` / 辿れず(出どころのまま購読): ${unresolved.join(" ")}` : ""})`);
}

// ===== 名簿 =====

function addToRoster(user, block) {
  const u = user.toLowerCase();
  if (u === ethers.ZeroAddress) return false;
  const cur = roster.get(u);
  if (cur) { if (block > cur.seenBlock) cur.seenBlock = block; return false; }
  roster.set(u, { seenBlock: block });
  return true;
}

function trimRoster() {
  if (roster.size <= MAX_ROSTER) return;
  const sorted = [...roster.entries()].sort((a, b) => a[1].seenBlock - b[1].seenBlock);
  const drop = roster.size - MAX_ROSTER;
  for (let i = 0; i < drop; i++) {
    const u = sorted[i][0];
    if (watch.has(u)) continue; // 要注意は捨てない
    roster.delete(u); health.delete(u);
  }
}

/// ブロック番号からおよその日数を出すため、ブロック時間を実測する。
async function estimateBlocksPerDay(latest) {
  const span = 50000;
  const [a, b] = await Promise.all([
    rpc((p) => p.getBlock(latest)),
    rpc((p) => p.getBlock(Math.max(1, latest - span))),
  ]);
  const sec = Number(a.timestamp) - Number(b.timestamp);
  if (sec <= 0) return 43200; // 2秒/ブロック相当
  return Math.round((span / sec) * 86400);
}

async function initBackfill() {
  const latest = await rpc((p) => p.getBlockNumber());
  if (!liveBlock) liveBlock = latest;
  if (backfill.done || (backfill.cursor > 0 && backfill.targetFrom > 0)) return;
  const perDay = await estimateBlocksPerDay(latest);
  backfill.targetFrom = Math.max(1, latest - Math.round(perDay * ROSTER_DAYS));
  backfill.cursor = latest;
  backfill.latestAtStart = latest;
  backfill.done = false;
  console.log(`[清算AVAX/名簿] ${ROSTER_DAYS}日ぶんの Borrow を遡ります: ${backfill.targetFrom}〜${latest}(約${perDay.toLocaleString()}ブロック/日)`);
}

/// 裏で少しずつ遡る(新しい方から)。1回に BACKFILL_CHUNKS_PER_TICK 回まで。
let backfillBusy = false;
async function backfillTick() {
  if (backfill.done || backfillBusy || backfill.cursor <= 0) return;
  backfillBusy = true;
  try {
    let added = 0;
    for (let i = 0; i < BACKFILL_CHUNKS_PER_TICK && !backfill.done; i++) {
      const to = backfill.cursor;
      const from = Math.max(backfill.targetFrom, to - chunkBlocks + 1);
      const logs = await tryGetLogs({ address: POOL_ADDRESS, topics: [TOPIC_BORROW] }, from, to);
      if (logs === null) break; // 幅を縮めたので次の巡回で
      for (const log of logs) {
        const user = "0x" + (log.topics[2] || "").slice(26);
        if (user.length === 42 && addToRoster(user, parseInt(log.blockNumber, 16))) added++;
      }
      backfill.cursor = from - 1;
      if (backfill.cursor < backfill.targetFrom) backfill.done = true;
    }
    if (added > 0) trimRoster();
    if (backfill.done) {
      console.log(`[清算AVAX/名簿] 遡りが完了しました: 名簿${roster.size}人`);
      saveState();
    }
  } finally {
    backfillBusy = false;
  }
}

function backfillProgressPct() {
  if (backfill.done) return 100;
  const total = backfill.latestAtStart - backfill.targetFrom;
  if (total <= 0) return 0;
  return Math.min(99, Math.max(0, Math.round(((backfill.latestAtStart - backfill.cursor) / total) * 100)));
}

/// WebSocket の取りこぼしを埋める。追いついた最後のブロックから今までを getLogs で読む。
async function catchUpLive() {
  const latest = await rpc((p) => p.getBlockNumber());
  if (!liveBlock) { liveBlock = latest; return; }
  let from = liveBlock + 1;
  let requests = 0;
  while (from <= latest && requests < 6) {
    const to = Math.min(latest, from + chunkBlocks - 1);
    const logs = await tryGetLogs({ address: POOL_ADDRESS, topics: [POOL_TOPICS] }, from, to);
    requests++;
    if (logs === null) continue; // 幅を縮めて同じ from からやり直す
    for (const log of logs) handlePoolLog(log, false);
    from = to + 1;
    liveBlock = to;
  }
}

// ===== イベント =====

/// Pool のイベントから対象の人を取り出し、名簿に入れて測り直しを予約する。
function handlePoolLog(log, fromWs) {
  const topic = (log.topics?.[0] || "").toLowerCase();
  const block = typeof log.blockNumber === "string" ? parseInt(log.blockNumber, 16) : Number(log.blockNumber || 0);
  let user = null;
  if (topic === TOPIC_BORROW || topic === TOPIC_SUPPLY) user = "0x" + (log.topics[2] || "").slice(26);
  else if (topic === TOPIC_REPAY || topic === TOPIC_WITHDRAW) user = "0x" + (log.topics[2] || "").slice(26);
  else if (topic === TOPIC_LIQUIDATION) user = "0x" + (log.topics[3] || "").slice(26);
  if (!user || user.length !== 42) return;
  const u = user.toLowerCase();
  if (fromWs) { stats.poolEvents++; if (block > liveBlock) liveBlock = block; }
  addToRoster(u, block);
  recheckQueue.add(u);
  if (topic === TOPIC_LIQUIDATION) {
    // 誰かが清算した。うちが候補にしていた人なら「他者が取った」と数える。
    let liquidator = "?";
    try {
      const [, , liq] = ethers.AbiCoder.defaultAbiCoder().decode(["uint256", "uint256", "address", "bool"], log.data);
      liquidator = liq;
    } catch (e) {}
    const c = candidates.get(u);
    if (c && !c.doneByUs) {
      stats.takenByOthers++;
      console.log(`[清算AVAX/他者 ${nowJst()}] ${short(u)} を ${short(liquidator)} が清算しました(うちが候補にしてから${Math.round((Date.now() - c.firstAt) / 1000)}秒)`);
      candidates.delete(u);
    }
  }
}

/// Chainlink の価格更新。その資産を担保か借金に持つ要注意の人を即測り直す。
function handlePriceLog(log) {
  stats.priceEvents++;
  stats.lastPriceEventAt = Date.now();
  const assets = feedToAssets.get((log.address || "").toLowerCase());
  if (!assets || assets.size === 0) return;
  const touched = [...assets];
  refreshPrices(touched).catch(() => {});
  let n = 0;
  for (const u of watch) {
    const b = breakdown.get(u);
    // 内訳が分からない人は安全側で測り直す。
    const hit = !b || b.items.some((it) => assets.has(it.asset) && (it.aToken > 0n || it.debt > 0n));
    if (hit) { recheckQueue.add(u); n++; }
  }
  stats.priceRechecks += n;
  if (n > 0) console.log(`[清算AVAX/価格] ${touched.map(sym).join("/")} が更新 → 要注意${n}人を測り直します`);
  if (n > 0) processRecheckQueue().catch(() => {});
}

// ===== WebSocket(裁定とは別の接続)=====
let socket = null;
let wsBackoffMs = 1000;
let wsLastMessageAt = 0;
let wsPingTimer = null;
const WS_SUB_POOL_ID = 9101;
const WS_SUB_FEEDS_ID = 9102;
const WS_PING_ID = 9199;

function connectWs() {
  if (!WSS_URL) {
    console.log("[清算AVAX] AVALANCHE_WSS_URL が未設定のため、イベントは5分ごとの getLogs だけで追います");
    return;
  }
  try {
    socket = new WebSocket(WSS_URL);
  } catch (e) {
    scheduleWsReconnect(`接続できず: ${e.message}`);
    return;
  }
  socket.addEventListener("open", () => {
    stats.wsConnected = true;
    wsLastMessageAt = Date.now();
    try {
      socket.send(JSON.stringify({ jsonrpc: "2.0", id: WS_SUB_POOL_ID, method: "eth_subscribe", params: ["logs", { address: POOL_ADDRESS, topics: [POOL_TOPICS] }] }));
      const feeds = [...feedToAssets.keys()];
      if (feeds.length > 0) {
        socket.send(JSON.stringify({ jsonrpc: "2.0", id: WS_SUB_FEEDS_ID, method: "eth_subscribe", params: ["logs", { address: feeds, topics: [TOPIC_ANSWER_UPDATED] }] }));
      }
    } catch (e) {}
    if (wsPingTimer) clearInterval(wsPingTimer);
    wsPingTimer = setInterval(() => {
      if (!socket || socket.readyState !== 1) return;
      // 10分黙っていたら繋ぎ直す(接続はあるが届かない状態を放置しない)。
      if (Date.now() - wsLastMessageAt > 10 * 60 * 1000) { try { socket.close(); } catch (e) {} return; }
      try { socket.send(JSON.stringify({ jsonrpc: "2.0", id: WS_PING_ID, method: "eth_blockNumber", params: [] })); } catch (e) {}
    }, 30 * 1000);
  });
  socket.addEventListener("message", (event) => {
    wsLastMessageAt = Date.now();
    try {
      const msg = JSON.parse(event.data);
      if (msg.id !== undefined) {
        if ((msg.id === WS_SUB_POOL_ID || msg.id === WS_SUB_FEEDS_ID) && msg.error) {
          console.warn(`[清算AVAX] 購読が拒否されました(${msg.id === WS_SUB_POOL_ID ? "Pool" : "価格"}): ${JSON.stringify(msg.error).slice(0, 120)}`);
        } else if (msg.id === WS_SUB_POOL_ID || msg.id === WS_SUB_FEEDS_ID) {
          console.log(`[清算AVAX] ${msg.id === WS_SUB_POOL_ID ? "Pool のイベント" : `価格フィード${feedToAssets.size}件`}の購読を始めました`);
          wsBackoffMs = 1000;
        }
        return;
      }
      if (msg.method !== "eth_subscription" || !msg.params?.result) return;
      const log = msg.params.result;
      const addr = (log.address || "").toLowerCase();
      if (addr === POOL_ADDRESS.toLowerCase()) { handlePoolLog(log, true); processRecheckQueue().catch(() => {}); }
      else if (feedToAssets.has(addr)) handlePriceLog(log);
    } catch (e) {}
  });
  socket.addEventListener("close", () => scheduleWsReconnect("切断"));
  socket.addEventListener("error", () => { try { socket.close(); } catch (e) {} });
}

function scheduleWsReconnect(why) {
  stats.wsConnected = false;
  if (wsPingTimer) { clearInterval(wsPingTimer); wsPingTimer = null; }
  stats.wsReconnects++;
  const wait = wsBackoffMs;
  wsBackoffMs = Math.min(60 * 1000, wsBackoffMs * 2);
  console.log(`[清算AVAX] WebSocket ${why}。${Math.round(wait / 1000)}秒後に繋ぎ直します`);
  setTimeout(connectWs, wait);
}

// ===== 健全度 =====

/// 束ねて読む。戻り値は Map(住所 -> { hf, collateralUsd, debtUsd })。
async function readHealth(users, maxCalls, priority = false) {
  const out = new Map();
  let calls = 0;
  for (let i = 0; i < users.length && calls < maxCalls; i += USERS_PER_CALL) {
    const slice = users.slice(i, i + USERS_PER_CALL);
    const batch = slice.map((u) => ({ target: POOL_ADDRESS, allowFailure: true, callData: POOL_IFACE.encodeFunctionData("getUserAccountData", [ethers.getAddress(u)]) }));
    try {
      calls++;
      const returned = await multicall(batch, priority);
      for (let j = 0; j < slice.length; j++) {
        const r = returned[j];
        if (!r?.success || r.returnData === "0x") continue;
        try {
          const d = POOL_IFACE.decodeFunctionResult("getUserAccountData", r.returnData);
          out.set(slice[j], { collateralUsd: baseToUsd(d[0]), debtUsd: baseToUsd(d[1]), hf: d[5], at: Date.now() });
        } catch (e) {}
      }
    } catch (e) {
      stats.errors++; stats.lastError = `健全度: ${(e.message || "").slice(0, 60)}`;
      break;
    }
  }
  return out;
}

/// 読めた結果を反映し、要注意の出入りと清算できる人を扱う。
async function applyHealth(map) {
  const newlyWatched = [];
  const liquidatable = [];
  for (const [u, h] of map) {
    health.set(u, h);
    if (h.debtUsd <= 0) {
      // 借金の無い人は測る意味が無い。名簿から外す(借りたら Borrow で戻る)。
      roster.delete(u); watch.delete(u); breakdown.delete(u); health.delete(u);
      continue;
    }
    const wasWatched = watch.has(u);
    if (h.hf < WATCH_HF) {
      if (!wasWatched) { watch.add(u); newlyWatched.push(u); }
    } else if (wasWatched) {
      watch.delete(u); breakdown.delete(u);
    }
    if (h.hf < LIQUIDATABLE_HF) liquidatable.push(u);
    else if (candidates.has(u)) {
      const c = candidates.get(u);
      if (!c.doneByUs) {
        stats.recovered++;
        console.log(`[清算AVAX/回復 ${nowJst()}] ${short(u)}: HF ${hfToNumber(h.hf).toFixed(4)} に戻りました(候補にしてから${Math.round((Date.now() - c.firstAt) / 1000)}秒。借金$${h.debtUsd.toFixed(2)})`);
      }
      candidates.delete(u);
    }
  }
  if (newlyWatched.length > 0) {
    console.log(`[清算AVAX/要注意] ${newlyWatched.length}人が HF<${ethers.formatUnits(WATCH_HF, 18)} に入りました(要注意 計${watch.size}人)`);
    await loadBreakdown(newlyWatched.slice(0, MAX_BREAKDOWN_USERS));
  }
  for (const u of liquidatable) {
    try { await handleLiquidatable(u); } catch (e) {
      stats.errors++; stats.lastError = `候補: ${(e.message || "").slice(0, 60)}`;
    }
  }
}

/// 担保と借金の内訳を読む(要注意の人だけ。資産の数 × 人数の呼び出しを束ねる)。
async function loadBreakdown(users) {
  if (users.length === 0 || reserveList.length === 0) return;
  const perCall = Math.max(1, Math.floor(USERS_PER_CALL / reserveList.length));
  for (let i = 0; i < users.length; i += perCall) {
    const slice = users.slice(i, i + perCall);
    const calls = [];
    for (const u of slice) {
      for (const asset of reserveList) {
        calls.push({ target: DATA_PROVIDER_ADDRESS, allowFailure: true, callData: DATA_PROVIDER_IFACE.encodeFunctionData("getUserReserveData", [ethers.getAddress(asset), ethers.getAddress(u)]) });
      }
    }
    let returned;
    try { returned = await multicall(calls); } catch (e) {
      stats.errors++; stats.lastError = `内訳: ${(e.message || "").slice(0, 60)}`;
      return;
    }
    slice.forEach((u, ui) => {
      const items = [];
      reserveList.forEach((asset, ai) => {
        const r = returned[ui * reserveList.length + ai];
        if (!r?.success || r.returnData === "0x") return;
        try {
          const d = DATA_PROVIDER_IFACE.decodeFunctionResult("getUserReserveData", r.returnData);
          const aToken = d[0], debt = d[1] + d[2];
          if (aToken > 0n || debt > 0n) items.push({ asset, aToken, debt, collateralEnabled: Boolean(d[8]) });
        } catch (e) {}
      });
      breakdown.set(u, { at: Date.now(), items });
    });
  }
}

/// トークン量を USD に(Aave のオラクル価格・8桁)。
function amountToUsd(asset, amount) {
  const r = reserves.get(asset);
  if (!r || r.price === 0n) return 0;
  return Number((amount * r.price) / (10n ** BigInt(r.decimals))) / 1e8;
}

/// 清算する組を決める。
/// 借金は最大の1種、担保は(有効で、借金と別の)最大の1種。
/// debtToCover は Aave v3.3 の規則で「上限ぴったり」にする。
export function planLiquidation(user, h, b) {
  if (!b || b.items.length === 0) return { error: "内訳なし" };
  const debts = b.items.filter((it) => it.debt > 0n).map((it) => ({ ...it, usd: amountToUsd(it.asset, it.debt) })).sort((x, y) => y.usd - x.usd);
  const colls = b.items.filter((it) => it.aToken > 0n && it.collateralEnabled && reserves.get(it.asset)?.collateralEnabled)
    .map((it) => ({ ...it, usd: amountToUsd(it.asset, it.aToken) })).sort((x, y) => y.usd - x.usd);
  if (debts.length === 0) return { error: "借金なし" };
  const debt = debts[0];
  const coll = colls.find((c) => c.asset !== debt.asset);
  if (!coll) return { error: `担保なし(借金${sym(debt.asset)}と同じ通貨の担保しか無い)` };
  const rd = reserves.get(debt.asset), rc = reserves.get(coll.asset);

  // 一度に返せる割合(v3.3): HF<0.95、または借金か担保がその通貨で$2,000未満なら100%。
  const debtBase = BigInt(Math.round(debt.usd * 1e8));
  const collBase = BigInt(Math.round(coll.usd * 1e8));
  const full = h.hf < CLOSE_FACTOR_HF || debtBase < MIN_BASE_MAX_CLOSE_FACTOR_THRESHOLD || collBase < MIN_BASE_MAX_CLOSE_FACTOR_THRESHOLD;
  let cover = full ? debt.debt : debt.debt / 2n;
  let why = full ? "100%" : "50%";

  // 担保で払える上限: 担保の価値 ÷ (1 + ボーナス)。超える分は Aave が削る。
  const bonusBps = BigInt(rc.bonusBps);
  const collValueBase = (coll.aToken * rc.price) / (10n ** BigInt(rc.decimals));
  const maxDebtBase = (collValueBase * 10000n) / (10000n + bonusBps);
  const coverBase = (cover * rd.price) / (10n ** BigInt(rd.decimals));
  if (coverBase > maxDebtBase && rd.price > 0n) {
    cover = (maxDebtBase * (10n ** BigInt(rd.decimals))) / rd.price;
    why += "→担保で頭打ち";
  }
  // うちの上限額。
  const capBase = BigInt(Math.round(MAX_DEBT_USD * 1e8));
  let coverBaseNow = (cover * rd.price) / (10n ** BigInt(rd.decimals));
  if (coverBaseNow > capBase && rd.price > 0n) {
    cover = (capBase * (10n ** BigInt(rd.decimals))) / rd.price;
    coverBaseNow = capBase;
    why += `→上限$${MAX_DEBT_USD}`;
    // 借金も担保も残す形になるので、借金の残りが$1,000未満だと拒否される。残りを$1,000にする。
    const leftover = debtBase - coverBaseNow;
    if (leftover > 0n && leftover < MIN_LEFTOVER_BASE) {
      const allowed = debtBase - MIN_LEFTOVER_BASE;
      if (allowed <= 0n) return { error: "上限額では残り$1,000の規則を満たせない" };
      cover = (allowed * (10n ** BigInt(rd.decimals))) / rd.price;
      coverBaseNow = allowed;
      why += "→残り$1,000";
    }
  }
  if (cover <= 0n) return { error: "肩代わり額が0" };
  const coverUsd = baseToUsd(coverBaseNow);
  // 見込みの粗利: ボーナスからプロトコルの取り分を引く。フラッシュローン料(0.05%)も引く。
  const netBonus = (rc.bonusBps / 10000) * (1 - rc.protocolFeeBps / 10000);
  const grossUsd = coverUsd * netBonus - coverUsd * 0.0005;
  return {
    user, debtAsset: debt.asset, collateralAsset: coll.asset, debtToCover: cover,
    coverUsd, debtUsd: debt.usd, collateralUsd: coll.usd, bonusBps: rc.bonusBps, protocolFeeBps: rc.protocolFeeBps,
    grossUsd, why, hf: hfToNumber(h.hf),
  };
}

/// HF < 1 の人。組を決めてログに出し、外から差し込まれた処理(確認・送信)へ渡す。
async function handleLiquidatable(u) {
  const h = health.get(u);
  if (!h) return;
  if (!breakdown.has(u) || Date.now() - breakdown.get(u).at > 60 * 1000) await loadBreakdown([u]);
  const plan = planLiquidation(u, h, breakdown.get(u));
  let c = candidates.get(u);
  if (!c) {
    c = { firstAt: Date.now(), attempts: 0, lastResult: null, doneByUs: false };
    candidates.set(u, c);
    stats.found++;
  }
  c.plan = plan; c.lastPlanAt = Date.now();
  if (plan.error) {
    if (!c.loggedError) {
      c.loggedError = true;
      console.log(`[清算AVAX/候補 ${nowJst()}] ${short(u)} HF ${hfToNumber(h.hf).toFixed(4)} 借金$${h.debtUsd.toFixed(2)} 担保$${h.collateralUsd.toFixed(2)} → 組めません: ${plan.error}`);
    }
    return;
  }
  if (!c.loggedPlan) {
    c.loggedPlan = true;
    recentCandidates.unshift({ at: new Date().toISOString(), user: u, hf: plan.hf, debtUsd: h.debtUsd, coverUsd: plan.coverUsd, grossUsd: plan.grossUsd, pair: `${sym(plan.collateralAsset)}→${sym(plan.debtAsset)}`, result: DRY_RUN ? "DRY_RUN" : "" });
    if (recentCandidates.length > 30) recentCandidates.pop();
    console.log(
      `[清算AVAX/候補 ${nowJst()}] ${short(u)} HF ${plan.hf.toFixed(4)} 借金$${h.debtUsd.toFixed(2)} 担保$${h.collateralUsd.toFixed(2)} ` +
      `→ 借金${sym(plan.debtAsset)}$${plan.debtUsd.toFixed(2)} / 担保${sym(plan.collateralAsset)}$${plan.collateralUsd.toFixed(2)} / ` +
      `肩代わり$${plan.coverUsd.toFixed(2)}(${plan.why}) ボーナス${(plan.bonusBps / 100).toFixed(1)}%(うちプロトコル${(plan.protocolFeeBps / 100).toFixed(0)}%) ` +
      `見込み粗利$${plan.grossUsd.toFixed(2)}(担保の売却とガス代は未計算)`
    );
  }
  if (plan.grossUsd < MIN_PROFIT_USD) return;
  const last = lastActionAt.get(u) || 0;
  if (Date.now() - last < COOLDOWN_MS) return;
  if (onCandidate) {
    lastActionAt.set(u, Date.now());
    c.attempts++;
    try {
      const result = await onCandidate(plan, c);
      c.lastResult = result || null;
      if (result?.sent) { c.doneByUs = true; stats.sent++; if (result.ok) stats.sentOk++; }
      const rec = recentCandidates.find((r) => r.user === u);
      if (rec && result?.summary) rec.result = result.summary;
    } catch (e) {
      c.lastResult = { error: (e.message || "").slice(0, 120) };
      console.warn(`[清算AVAX/候補] ${short(u)}: 処理に失敗: ${(e.message || "").slice(0, 120)}`);
    }
  }
}

// ===== 周期処理 =====

let sweepBusy = false;
/// 全員の健全度(5分ごと)。取りこぼしの追いつきと価格の読み直しも兼ねる。
export async function sweep() {
  if (!stats.verified || sweepBusy) return;
  sweepBusy = true;
  try {
    stats.sweeps++;
    await catchUpLive();
    await refreshPrices(reserveList);
    const users = [...roster.keys()];
    const map = await readHealth(users, MAX_SWEEP_CALLS);
    await applyHealth(map);
    // 要注意の内訳は5分ごとに読み直す(借入や返済で変わる)。
    if (watch.size > 0) await loadBreakdown([...watch].slice(0, MAX_BREAKDOWN_USERS));
    stats.lastSweepAt = Date.now();
    saveState();
  } catch (e) {
    stats.errors++; stats.lastError = `巡回: ${(e.message || "").slice(0, 60)}`;
  } finally {
    sweepBusy = false;
  }
}

/// 要注意の人だけ(20秒ごと)。
let watchBusy = false;
export async function checkWatch() {
  if (!stats.verified || watchBusy) return;
  watchBusy = true;
  try {
    stats.watchChecks++;
    const users = [...new Set([...watch, ...recheckQueue])];
    recheckQueue.clear();
    if (users.length === 0) return;
    const map = await readHealth(users, 4, true);
    await applyHealth(map);
  } catch (e) {
    stats.errors++; stats.lastError = `要注意: ${(e.message || "").slice(0, 60)}`;
  } finally {
    watchBusy = false;
  }
}

/// イベントで予約された人を即測る(要注意の巡回を待たない)。
let recheckBusy = false;
async function processRecheckQueue() {
  if (!stats.verified || recheckBusy || recheckQueue.size === 0) return;
  recheckBusy = true;
  try {
    const users = [...recheckQueue];
    recheckQueue.clear();
    const map = await readHealth(users, 2, true);
    await applyHealth(map);
  } catch (e) {
    stats.errors++; stats.lastError = `即時: ${(e.message || "").slice(0, 60)}`;
  } finally {
    recheckBusy = false;
    if (recheckQueue.size > 0) setTimeout(() => processRecheckQueue().catch(() => {}), 500);
  }
}

// ===== 起動 =====

/// index.js から呼ぶ。失敗しても例外を外に出さない(裁定を止めない)。
export async function startLiquidationMonitor(activeChains) {
  if (!ENABLED) { console.log("[清算AVAX] LIQUIDATION_ENABLED=false のため動かしません"); return false; }
  if (!activeChains.includes(CHAIN)) { console.log(`[清算AVAX] ${CHAIN} が稼働チェーンに無いため動かしません`); return false; }
  stats.enabled = true;
  try {
    await verifyPool();
    stats.verified = true;
    console.log(`[清算AVAX] Aave V3 Pool ${POOL_ADDRESS} に応答を確認しました(DRY_RUN=${DRY_RUN} 最低利益$${MIN_PROFIT_USD} 上限$${MAX_DEBT_USD})`);
  } catch (e) {
    console.warn(`[清算AVAX] Pool ${POOL_ADDRESS} が応答しません(${(e.message || "").slice(0, 80)})。見張りません`);
    return false;
  }
  loadState();
  try { await loadReserves(); } catch (e) { console.warn(`[清算AVAX] 資産の情報を読めませんでした: ${(e.message || "").slice(0, 100)}`); }
  try { await resolveFeeds(); } catch (e) { console.warn(`[清算AVAX] 価格フィードを辿れませんでした: ${(e.message || "").slice(0, 100)}`); }
  try { await initBackfill(); } catch (e) { console.warn(`[清算AVAX] 名簿の遡りを始められませんでした: ${(e.message || "").slice(0, 100)}`); }
  connectWs();
  setInterval(() => { backfillTick().catch((e) => { stats.errors++; stats.lastError = `遡り: ${(e.message || "").slice(0, 60)}`; }); }, BACKFILL_INTERVAL_MS);
  setInterval(() => { sweep().catch(() => {}); }, SWEEP_INTERVAL_MS);
  setInterval(() => { checkWatch().catch(() => {}); }, WATCH_INTERVAL_MS);
  // 最初の全員測定は、名簿が少し貯まってから。
  setTimeout(() => { sweep().catch(() => {}); }, 45 * 1000);
  setInterval(saveState, 10 * 60 * 1000);
  console.log(`[清算AVAX] 見張りを始めます(全員${SWEEP_INTERVAL_MS / 60000}分ごと、要注意${WATCH_INTERVAL_MS / 1000}秒ごと、名簿は${ROSTER_DAYS}日ぶん)`);
  return true;
}

// ===== 表示 =====

/// 生存ログ用の1項目。
export function formatLiquidationLine() {
  if (!stats.enabled) return "";
  if (!stats.verified) return " 清算AVAX[応答なし]";
  const ws = WSS_URL ? (stats.wsConnected ? "接続" : "切断") : "WSなし";
  return ` 清算AVAX[名簿${roster.size.toLocaleString()}(遡り${backfillProgressPct()}%${backfill.done ? "" : ` 幅${chunkBlocks.toLocaleString()}`}) 要注意${watch.size} 候補${stats.found} 他者${stats.takenByOthers} 回復${stats.recovered} 価格更新${stats.priceEvents}(即${stats.priceRechecks}) Pool受信${stats.poolEvents} WS${ws}${stats.simulated ? ` 確認${stats.simulated}` : ""}${stats.sent ? ` 送信${stats.sent}/${stats.sentOk}` : ""} RPC${stats.rpcCalls}${stats.errors ? ` 失敗${stats.errors}` : ""}]`;
}

/// 画面用。
export function getLiquidationDashboard() {
  return {
    enabled: stats.enabled, verified: stats.verified, dryRun: DRY_RUN,
    roster: roster.size, backfillPct: backfillProgressPct(), watch: watch.size,
    found: stats.found, takenByOthers: stats.takenByOthers, recovered: stats.recovered,
    priceEvents: stats.priceEvents, poolEvents: stats.poolEvents, wsConnected: stats.wsConnected, wsUrlSet: Boolean(WSS_URL),
    feeds: feedToAssets.size, feedsUnresolved: stats.feedsUnresolved,
    rpcCalls: stats.rpcCalls, errors: stats.errors, lastError: stats.lastError,
    lastSweepAt: stats.lastSweepAt, lastPriceEventAt: stats.lastPriceEventAt,
    simulated: stats.simulated, sent: stats.sent, sentOk: stats.sentOk,
    minProfitUsd: MIN_PROFIT_USD, maxDebtUsd: MAX_DEBT_USD,
    watching: [...watch].map((u) => ({ user: u, hf: hfToNumber(health.get(u)?.hf ?? 0n), debtUsd: health.get(u)?.debtUsd ?? 0 })).sort((a, b) => a.hf - b.hf).slice(0, 15),
    recent: recentCandidates.slice(0, 15),
  };
}

export function noteSimulation() { stats.simulated++; }
export function getReserveInfo(asset) { return reserves.get((asset || "").toLowerCase()) || null; }
export function getPoolAddress() { return POOL_ADDRESS; }
