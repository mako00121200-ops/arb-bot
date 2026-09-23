// scripts/morpho-liquidation.js
//
// Morpho Blue の清算の**見張り(第1段: 送信しない)**。
//
// [なぜ(2026年9月23日、オーナーの了承「進めてください」)]
// 過去90日の実測(scripts/morpho-liquidation-survey.js)で、base の Morpho は
//   清算 1日25件・報酬 1日約$9,700・清算者209人で1位の占有18%(独占されていない)
//   $1千〜1万の帯だけで 1日3.3件・報酬$1,080
// と、いまの裁定(平均$0.005)と桁が違った。arbitrum は1日$23 で対象外。
//
// [この段でやること]
//   1. 借り手の名簿を作る(Borrow イベントを遡って読み、借金が0になった人は外す)
//   2. 名簿の全員の健全度を定期的に読み、危ない人は短い間隔で読み直す
//   3. 清算できる人を見つけたら、売る経路を探し、コントラクトの simulateLiquidation(eth_call)で
//      返済後の利益を確かめる(**送らない**)
//   4. 実際に起きた清算(Liquidate イベント)と突き合わせて、**我々が先に見つけていたか・何ブロック
//      先行していたか**を数える。これが「送れば勝てたか」の答えになる
//
// 送信は**まだ作っていない**。この段の数字を見てからオーナーに相談する。
//
// [健全度の式(morpho-blue src/Morpho.sol の _isHealthy と同じ)]
//   borrowed = borrowShares を資産に直した量(切り上げ)
//   maxBorrow = collateral × price / 1e36 × lltv
//   borrowed > maxBorrow なら清算できる
// ここでは利息の積み上げ(_accrueInterest)を省く。数分ぶんの利息は 1e-6 程度で、
// 境目の判定は最後に eth_call(こちらは利息を積む)で確かめるので問題にならない。

import { ethers } from "ethers";
import fs from "fs";
import { callWithRpc } from "./onchain-reserves.js";
import { MULTICALL3_ADDRESS } from "./multicall-reserves.js";
import { gasUnitsToUsd } from "./gas-cost.js";
import { stateFilePath } from "./state-file.js";
import { nowJst } from "./jst.js";
import { buildRoutes as buildAaveRoutes } from "./liquidation-executor.js";
// 経路探し(liquidation-executor.js)は LIQUIDATION_CHAIN のチェーン用に作られている。
import { CHAIN as EXECUTOR_CHAIN } from "./liquidation-monitor.js";

/// Morpho 清算コントラクトの住所を入れる環境変数(未設定なら確認はせず、候補をログに出すだけ)。
export function morphoLiquidatorAddressEnvVar(chain) {
  return `MORPHO_LIQUIDATOR_ADDRESS_${(chain || "").toUpperCase()}`;
}

// ===== 設定 =====
/// 見張るチェーン。空にすると止まる。
export const MORPHO_LIQ_CHAIN = (process.env.MORPHO_LIQ_CHAIN ?? "base").trim().toLowerCase();
/// 全員を読み直す間隔。
export const MORPHO_SWEEP_MS = parseInt(process.env.MORPHO_LIQ_SWEEP_MS || "120000", 10);
/// 危ない人だけを読み直す間隔。
export const MORPHO_WATCH_MS = parseInt(process.env.MORPHO_LIQ_WATCH_MS || "4000", 10);
/// 「危ない」とみなす借金の使用率(借金 ÷ 借りられる上限)。
const WATCH_RATIO = parseFloat(process.env.MORPHO_LIQ_WATCH_RATIO || "0.97");
/// これ未満の清算は相手にしない(ガス代に負ける)。返済額のドル。
const MIN_DEBT_USD = parseFloat(process.env.MORPHO_LIQ_MIN_DEBT_USD || "10");
/// 1回の巡回で遡る getLogs の上限(裁定の RPC を圧迫しないため)。
const BACKFILL_REQUESTS_PER_TICK = parseInt(process.env.MORPHO_LIQ_BACKFILL_PER_TICK || "30", 10);
/// eth_call で確かめる経路の本数。
const SIMULATE_TOP_N = 3;
/// 同じ借り手を確かめ直すまでの時間。
const RESIM_MS = 60 * 1000;
/// ガス量の見込み(清算 + 1〜2段のスワップ)。
const GAS_UNITS = BigInt(process.env.MORPHO_LIQ_GAS_UNITS || "700000");

/// 住所と配備ブロック: morpho-org/sdks packages/morpho-ts/src/addresses.ts
export const MORPHO_BLUE = {
  base: { address: "0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb", startBlock: 13977148 },
  arbitrum: { address: "0x6c247b1F6182318877311737BaC0844bAa518F5e", startBlock: 296446593 },
};

const ORACLE_PRICE_SCALE = 10n ** 36n;
const WAD = 10n ** 18n;
const VIRTUAL_SHARES = 10n ** 6n;
const VIRTUAL_ASSETS = 1n;
const MAX_LIF = 1150000000000000000n;      // 1.15
const LIQUIDATION_CURSOR = 300000000000000000n; // 0.3

// ===== ABI(morpho-blue の IMorpho.sol / EventsLib.sol)=====
const MORPHO_IFACE = new ethers.Interface([
  "event Borrow(bytes32 indexed id, address caller, address indexed onBehalf, address indexed receiver, uint256 assets, uint256 shares)",
  "event Liquidate(bytes32 indexed id, address indexed caller, address indexed borrower, uint256 repaidAssets, uint256 repaidShares, uint256 seizedAssets, uint256 badDebtAssets, uint256 badDebtShares)",
  "function idToMarketParams(bytes32 id) view returns (address loanToken, address collateralToken, address oracle, address irm, uint256 lltv)",
  "function market(bytes32 id) view returns (uint128 totalSupplyAssets, uint128 totalSupplyShares, uint128 totalBorrowAssets, uint128 totalBorrowShares, uint128 lastUpdate, uint128 fee)",
  "function position(bytes32 id, address user) view returns (uint256 supplyShares, uint128 borrowShares, uint128 collateral)",
]);
const ORACLE_IFACE = new ethers.Interface(["function price() view returns (uint256)"]);
const ERC20_IFACE = new ethers.Interface(["function symbol() view returns (string)", "function decimals() view returns (uint8)"]);
const MC_ABI = ["function aggregate3((address target,bool allowFailure,bytes callData)[] calls) view returns ((bool success,bytes returnData)[])"];
const MP_TUPLE = "(address loanToken, address collateralToken, address oracle, address irm, uint256 lltv)";
const LIQ_TUPLE = "(address borrower, uint256 seizedAssets, uint256 repaidShares, uint256 minProfit)";
const LEG_TUPLE = "(address pool, address tokenOut, uint8 flags, uint16 feeBps)[]";
const LIQUIDATOR_IFACE = new ethers.Interface([
  `function simulateLiquidation(${MP_TUPLE} mp, ${LIQ_TUPLE} liq, ${LEG_TUPLE} legs)`,
  "function owner() view returns (address)",
  "function MORPHO() view returns (address)",
  "error SimulationResult(uint256 returned, uint256 owed)",
]);
const BORROW_TOPIC = MORPHO_IFACE.getEvent("Borrow").topicHash;
const LIQUIDATE_TOPIC = MORPHO_IFACE.getEvent("Liquidate").topicHash;

// ===== 計算(純粋関数。テストで確かめる)=====

/// SharesMathLib.toAssetsUp
export function toAssetsUp(shares, totalAssets, totalShares) {
  const num = shares * (totalAssets + VIRTUAL_ASSETS);
  const den = totalShares + VIRTUAL_SHARES;
  return (num + den - 1n) / den;
}

/// 清算報酬の倍率(WAD)。min(1.15, 1 / (1 − 0.3 × (1 − lltv)))
export function lifWad(lltv) {
  const denom = WAD - (LIQUIDATION_CURSOR * (WAD - lltv)) / WAD;
  const lif = (WAD * WAD) / denom;
  return lif < MAX_LIF ? lif : MAX_LIF;
}

/// 健全度。戻り値 { borrowed, maxBorrow, ratio, liquidatable }
/// ratio = 借金 ÷ 借りられる上限(1 を超えたら清算できる)。
export function healthOf(pos, mkt, price, lltv) {
  const borrowed = toAssetsUp(pos.borrowShares, mkt.totalBorrowAssets, mkt.totalBorrowShares);
  const maxBorrow = (((pos.collateral * price) / ORACLE_PRICE_SCALE) * lltv) / WAD;
  const ratio = maxBorrow > 0n ? Number((borrowed * 1_000_000n) / maxBorrow) / 1_000_000 : (borrowed > 0n ? Infinity : 0);
  return { borrowed, maxBorrow, ratio, liquidatable: borrowed > maxBorrow };
}

/// 清算の量を決める。担保が足りる時は借金の持分の全部、足りない時(貸し倒れ域)は担保の全部。
/// 戻り値 { repaidShares, seizedAssets, expectedSeized, badDebtZone }
export function chooseAmounts(pos, borrowed, price, lltv) {
  const lif = lifWad(lltv);
  // 借金の全部を返した時に受け取る担保 = borrowed × LIF ÷ price(Morpho と同じ丸め: 切り下げ)
  const seizeForAll = (((borrowed * lif) / WAD) * ORACLE_PRICE_SCALE) / (price > 0n ? price : 1n);
  // 利息の積み上げで少し増えても外れないよう、0.5% の余裕を見て判定する
  if (seizeForAll * 1005n / 1000n <= pos.collateral) {
    return { repaidShares: pos.borrowShares, seizedAssets: 0n, expectedSeized: seizeForAll, badDebtZone: false };
  }
  return { repaidShares: 0n, seizedAssets: pos.collateral, expectedSeized: pos.collateral, badDebtZone: true };
}

/// getLogs の幅を実測で合わせる。断られた幅より広げない(広げ縮めの往復で半分を捨てないため)。
export function nextChunk(state, ok) {
  if (ok) {
    const grown = Math.floor(state.size * 1.5);
    state.size = Math.min(grown, state.ceiling ?? Infinity, 2_000_000);
  } else {
    state.ceiling = Math.max(500, state.size - 1);
    state.size = Math.max(500, Math.floor(state.size / 2));
  }
  return state.size;
}

// ===== 状態 =====
const S = {
  started: false,
  roster: new Map(),     // `${id}|${user}` -> { id, user }
  markets: new Map(),    // id -> { params, loan, coll, lif }
  backTo: null,          // ここより前はまだ読んでいない(遡りの先頭)
  forwardFrom: null,     // 次に前へ読むブロック
  chunkFwd: { size: 20_000, ceiling: null },
  chunkBack: { size: 20_000, ceiling: null },
  watch: new Map(),      // key -> 最後の比率
  seen: new Map(),       // key -> { block, at, repaidUsd, simUsd } 清算できると見つけた時
  lastSim: new Map(),    // key -> 時刻
  busy: false,
  watchBusy: false,
  owner: null,
  stats: {
    sweeps: 0, positionsRead: 0, liquidatable: 0, simulated: 0, simOk: 0, simBest: 0,
    liqEvents: 0, liqSeenFirst: 0, liqMissed: 0, leadBlocks: [], missedBonusUsd: 0, seenBonusUsd: 0,
    requests: 0, refusals: 0, noRoute: 0, dust: 0,
  },
};

function contractAddress() { return process.env[morphoLiquidatorAddressEnvVar(MORPHO_LIQ_CHAIN)] || ""; }
function short(a) { return a ? `${a.slice(0, 6)}…${a.slice(-4)}` : "?"; }
function keyOf(id, user) { return `${id.toLowerCase()}|${user.toLowerCase()}`; }
function statePath() { return stateFilePath(`morpho-roster-${MORPHO_LIQ_CHAIN}.json`); }

function saveState() {
  try {
    const byMarket = {};
    for (const { id, user } of S.roster.values()) (byMarket[id] ||= []).push(user);
    fs.writeFileSync(statePath(), JSON.stringify({ v: 1, backTo: S.backTo, forwardFrom: S.forwardFrom, byMarket }));
  } catch (e) {}
}

function loadState() {
  try {
    const j = JSON.parse(fs.readFileSync(statePath(), "utf8"));
    if (j.v !== 1) return;
    S.backTo = j.backTo ?? null;
    S.forwardFrom = j.forwardFrom ?? null;
    for (const [id, users] of Object.entries(j.byMarket || {})) for (const u of users) S.roster.set(keyOf(id, u), { id, user: u });
  } catch (e) {}
}

async function aggregate(calls, priority = false) {
  const out = [];
  for (let i = 0; i < calls.length; i += 400) {
    const part = calls.slice(i, i + 400);
    const r = await callWithRpc(MORPHO_LIQ_CHAIN, (p) => new ethers.Contract(MULTICALL3_ADDRESS, MC_ABI, p).aggregate3(part), priority);
    out.push(...r);
  }
  return out;
}

async function getLogs(from, to, topics) {
  S.stats.requests++;
  return callWithRpc(MORPHO_LIQ_CHAIN, (p) => p.send("eth_getLogs", [{
    address: MORPHO_BLUE[MORPHO_LIQ_CHAIN].address, topics,
    fromBlock: "0x" + from.toString(16), toBlock: "0x" + to.toString(16),
  }]));
}

// ===== 市場の情報 =====
const priceCache = new Map(); // token -> { usd, at }
async function tokenUsd(token) {
  const k = token.toLowerCase();
  const c = priceCache.get(k);
  if (c && Date.now() - c.at < 30 * 60 * 1000) return c.usd;
  let usd = c?.usd ?? null;
  try {
    const res = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${token}`);
    if (res.ok) {
      const j = await res.json();
      const pairs = (j.pairs || []).filter((p) => (p.chainId || "").toLowerCase() === MORPHO_LIQ_CHAIN
        && (p.baseToken?.address || "").toLowerCase() === k);
      pairs.sort((a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0));
      const v = parseFloat(pairs[0]?.priceUsd);
      if (isFinite(v) && v > 0) usd = v;
    }
  } catch (e) {}
  priceCache.set(k, { usd, at: Date.now() });
  return usd;
}

async function ensureMarkets(ids) {
  const missing = [...new Set(ids)].filter((id) => !S.markets.has(id));
  if (missing.length === 0) return;
  const morpho = MORPHO_BLUE[MORPHO_LIQ_CHAIN].address;
  const r = await aggregate(missing.map((id) => ({ target: morpho, allowFailure: true, callData: MORPHO_IFACE.encodeFunctionData("idToMarketParams", [id]) })));
  const tokens = new Set();
  const params = new Map();
  missing.forEach((id, i) => {
    if (!r[i]?.success) return;
    const [loanToken, collateralToken, oracle, irm, lltv] = MORPHO_IFACE.decodeFunctionResult("idToMarketParams", r[i].returnData);
    params.set(id, { loanToken, collateralToken, oracle, irm, lltv });
    tokens.add(loanToken); tokens.add(collateralToken);
  });
  const tokenList = [...tokens].filter((t) => t !== ethers.ZeroAddress);
  const info = new Map();
  const tr = await aggregate(tokenList.flatMap((t) => [
    { target: t, allowFailure: true, callData: ERC20_IFACE.encodeFunctionData("symbol") },
    { target: t, allowFailure: true, callData: ERC20_IFACE.encodeFunctionData("decimals") },
  ]));
  tokenList.forEach((t, i) => {
    let symbol = short(t), decimals = 18;
    try { if (tr[2 * i]?.success) symbol = ERC20_IFACE.decodeFunctionResult("symbol", tr[2 * i].returnData)[0]; } catch (e) {}
    try { if (tr[2 * i + 1]?.success) decimals = Number(ERC20_IFACE.decodeFunctionResult("decimals", tr[2 * i + 1].returnData)[0]); } catch (e) {}
    info.set(t.toLowerCase(), { address: t, symbol, decimals });
  });
  for (const [id, p] of params) {
    // 担保0の市場(借りるだけ・オラクル無し)は清算が起きないので除く
    if (p.oracle === ethers.ZeroAddress || p.lltv === 0n || p.collateralToken === ethers.ZeroAddress) { S.markets.set(id, null); continue; }
    S.markets.set(id, {
      params: p, lif: lifWad(p.lltv),
      loan: info.get(p.loanToken.toLowerCase()), coll: info.get(p.collateralToken.toLowerCase()),
    });
  }
  for (const id of missing) if (!S.markets.has(id)) S.markets.set(id, null);
}

// ===== 名簿(Borrow を遡る・前へ読む)と、実際の清算との突き合わせ =====

async function readForward() {
  const latest = await callWithRpc(MORPHO_LIQ_CHAIN, (p) => p.getBlockNumber());
  if (S.forwardFrom == null) S.forwardFrom = latest - 5;
  if (S.backTo == null) S.backTo = S.forwardFrom;
  let guard = 0;
  while (S.forwardFrom <= latest && guard++ < 20) {
    const to = Math.min(latest, S.forwardFrom + S.chunkFwd.size - 1);
    let logs;
    try {
      logs = await getLogs(S.forwardFrom, to, [[BORROW_TOPIC, LIQUIDATE_TOPIC]]);
      if (to - S.forwardFrom + 1 >= S.chunkFwd.size) nextChunk(S.chunkFwd, true);
    } catch (e) {
      S.stats.refusals++;
      nextChunk(S.chunkFwd, false);
      continue;
    }
    for (const log of logs || []) {
      if (log.topics[0] === BORROW_TOPIC) {
        const id = log.topics[1];
        const user = ethers.getAddress("0x" + log.topics[2].slice(26));
        S.roster.set(keyOf(id, user), { id, user });
      } else if (log.topics[0] === LIQUIDATE_TOPIC) {
        await noteLiquidation(log);
      }
    }
    S.forwardFrom = to + 1;
  }
  return latest;
}

async function backfill() {
  const start = MORPHO_BLUE[MORPHO_LIQ_CHAIN].startBlock;
  let n = 0;
  while (S.backTo > start && n++ < BACKFILL_REQUESTS_PER_TICK) {
    const from = Math.max(start, S.backTo - S.chunkBack.size);
    const to = S.backTo - 1;
    let logs;
    try {
      logs = await getLogs(from, to, [BORROW_TOPIC]);
      nextChunk(S.chunkBack, true);
    } catch (e) {
      S.stats.refusals++;
      nextChunk(S.chunkBack, false);
      continue;
    }
    for (const log of logs || []) {
      const id = log.topics[1];
      const user = ethers.getAddress("0x" + log.topics[2].slice(26));
      S.roster.set(keyOf(id, user), { id, user });
    }
    S.backTo = from;
  }
}

/// 実際に起きた清算を、我々が先に見つけていたかと突き合わせる。
async function noteLiquidation(log) {
  let ev;
  try { ev = MORPHO_IFACE.parseLog(log); } catch (e) { return; }
  const id = ev.args.id, borrower = ev.args.borrower;
  const key = keyOf(id, borrower);
  const block = Number(log.blockNumber);
  await ensureMarkets([id]).catch(() => {});
  const m = S.markets.get(id);
  const loanUsd = m ? await tokenUsd(m.params.loanToken) : null;
  const repaidUsd = m && loanUsd != null ? (Number(ev.args.repaidAssets) / 10 ** m.loan.decimals) * loanUsd : null;
  const bonusUsd = repaidUsd != null ? repaidUsd * (Number(m.lif) / 1e18 - 1) : null;
  if (repaidUsd != null && repaidUsd < MIN_DEBT_USD) return; // 塵は数えない
  S.stats.liqEvents++;
  const seen = S.seen.get(key);
  const pair = m ? `${m.coll.symbol}/${m.loan.symbol}` : short(id);
  if (seen && seen.block <= block) {
    const lead = block - seen.block;
    S.stats.liqSeenFirst++;
    S.stats.leadBlocks.push(lead);
    if (S.stats.leadBlocks.length > 500) S.stats.leadBlocks.shift();
    S.stats.seenBonusUsd += bonusUsd ?? 0;
    console.log(`[Morpho清算/答え合わせ ${nowJst()}] ${pair} ${short(borrower)} 返済$${(repaidUsd ?? 0).toFixed(0)} 報酬約$${(bonusUsd ?? 0).toFixed(2)}: `
      + `**先に見つけていた**(${lead}ブロック先行、確認の利益${seen.simUsd != null ? "$" + seen.simUsd.toFixed(2) : "未確認"})。清算者 ${short(ev.args.caller)}`);
  } else {
    S.stats.liqMissed++;
    S.stats.missedBonusUsd += bonusUsd ?? 0;
    const inRoster = S.roster.has(key);
    console.log(`[Morpho清算/答え合わせ ${nowJst()}] ${pair} ${short(borrower)} 返済$${(repaidUsd ?? 0).toFixed(0)} 報酬約$${(bonusUsd ?? 0).toFixed(2)}: `
      + `見逃し(${inRoster ? "名簿にいたが間に合わず" : "名簿に無かった"})。清算者 ${short(ev.args.caller)}`);
  }
  S.seen.delete(key);
}

// ===== 健全度を読む =====

async function readHealth(entries, priority) {
  if (entries.length === 0) return [];
  const morpho = MORPHO_BLUE[MORPHO_LIQ_CHAIN].address;
  const ids = [...new Set(entries.map((e) => e.id))];
  await ensureMarkets(ids);
  const liveIds = ids.filter((id) => S.markets.get(id));
  const oracles = liveIds.map((id) => S.markets.get(id).params.oracle);
  const head = [
    ...liveIds.map((id) => ({ target: morpho, allowFailure: true, callData: MORPHO_IFACE.encodeFunctionData("market", [id]) })),
    ...oracles.map((o) => ({ target: o, allowFailure: true, callData: ORACLE_IFACE.encodeFunctionData("price") })),
  ];
  const hr = await aggregate(head, priority);
  const mkt = new Map(), price = new Map();
  liveIds.forEach((id, i) => {
    try {
      if (hr[i]?.success) {
        const r = MORPHO_IFACE.decodeFunctionResult("market", hr[i].returnData);
        mkt.set(id, { totalBorrowAssets: BigInt(r.totalBorrowAssets), totalBorrowShares: BigInt(r.totalBorrowShares) });
      }
      const j = liveIds.length + i;
      if (hr[j]?.success) price.set(id, BigInt(ORACLE_IFACE.decodeFunctionResult("price", hr[j].returnData)[0]));
    } catch (e) {}
  });
  const live = entries.filter((e) => mkt.has(e.id) && price.has(e.id));
  const pr = await aggregate(live.map((e) => ({ target: morpho, allowFailure: true, callData: MORPHO_IFACE.encodeFunctionData("position", [e.id, e.user]) })), priority);
  S.stats.positionsRead += live.length;
  const out = [];
  live.forEach((e, i) => {
    if (!pr[i]?.success) return;
    const r = MORPHO_IFACE.decodeFunctionResult("position", pr[i].returnData);
    const pos = { borrowShares: BigInt(r.borrowShares), collateral: BigInt(r.collateral) };
    if (pos.borrowShares === 0n) { S.roster.delete(keyOf(e.id, e.user)); S.watch.delete(keyOf(e.id, e.user)); return; }
    const m = S.markets.get(e.id);
    const h = healthOf(pos, mkt.get(e.id), price.get(e.id), m.params.lltv);
    out.push({ ...e, pos, h, price: price.get(e.id), m });
  });
  return out;
}

async function handleResults(results, block) {
  for (const r of results) {
    const key = keyOf(r.id, r.user);
    if (r.h.ratio >= WATCH_RATIO) S.watch.set(key, r.h.ratio); else S.watch.delete(key);
    if (!r.h.liquidatable) continue;
    S.stats.liquidatable++;
    const loanUsd = await tokenUsd(r.m.params.loanToken);
    const repaidUsd = loanUsd != null ? (Number(r.h.borrowed) / 10 ** r.m.loan.decimals) * loanUsd : null;
    if (repaidUsd != null && repaidUsd < MIN_DEBT_USD) { S.stats.dust++; continue; }
    if (!S.seen.has(key)) S.seen.set(key, { block, at: Date.now(), repaidUsd, simUsd: null });
    const last = S.lastSim.get(key) || 0;
    if (Date.now() - last < RESIM_MS) continue;
    S.lastSim.set(key, Date.now());
    await examine(r, repaidUsd, loanUsd).catch((e) => console.warn(`[Morpho清算] 確認で失敗: ${(e.message || "").slice(0, 100)}`));
  }
}

/// 清算できる人の計画を立て、コントラクトがあれば eth_call で利益を確かめる(送らない)。
async function examine(r, repaidUsd, loanUsd) {
  const pair = `${r.m.coll.symbol}/${r.m.loan.symbol}`;
  const amt = chooseAmounts(r.pos, r.h.borrowed, r.price, r.m.params.lltv);
  const bonusUsd = repaidUsd != null ? repaidUsd * (Number(r.m.lif) / 1e18 - 1) : null;
  const head = `[Morpho清算/候補 ${nowJst()}] ${pair} LLTV${(Number(r.m.params.lltv) / 1e16).toFixed(1)}% ${short(r.user)} 使用率${(r.h.ratio * 100).toFixed(2)}% `
    + `返済約$${(repaidUsd ?? 0).toFixed(0)} 報酬見込み約$${(bonusUsd ?? 0).toFixed(2)}${amt.badDebtZone ? "(担保不足=貸し倒れ域)" : ""}`;
  const address = contractAddress();
  if (!address) { console.log(`${head} → 契約未配備のため確認なし`); return; }
  if (EXECUTOR_CHAIN !== MORPHO_LIQ_CHAIN) { console.log(`${head} → 経路探しは ${EXECUTOR_CHAIN} 用のため確認なし`); return; }

  const routes = await buildAaveRoutes(r.m.params.collateralToken, r.m.params.loanToken, amt.expectedSeized);
  if (routes.length === 0) { S.stats.noRoute++; console.log(`${head} → 売る経路なし`); return; }
  if (!S.owner) {
    const raw = await callWithRpc(MORPHO_LIQ_CHAIN, (p) => p.call({ to: address, data: LIQUIDATOR_IFACE.encodeFunctionData("owner") }), true);
    S.owner = LIQUIDATOR_IFACE.decodeFunctionResult("owner", raw)[0];
  }
  const mp = { ...r.m.params };
  const liq = { borrower: r.user, seizedAssets: amt.seizedAssets, repaidShares: amt.repaidShares, minProfit: 0n };
  let best = null;
  const notes = [];
  for (const route of routes.slice(0, SIMULATE_TOP_N)) {
    S.stats.simulated++;
    const legs = route.legs.map(({ pool, tokenOut, flags, feeBps }) => ({ pool, tokenOut, flags, feeBps }));
    const data = LIQUIDATOR_IFACE.encodeFunctionData("simulateLiquidation", [mp, liq, legs]);
    try {
      await callWithRpc(MORPHO_LIQ_CHAIN, (p) => p.call({ to: address, from: S.owner, data }), true);
      notes.push(`${route.label}: 結果なし`);
    } catch (e) {
      const d = e?.data ?? e?.info?.error?.data ?? e?.error?.data ?? null;
      let parsed = null;
      try { parsed = typeof d === "string" ? LIQUIDATOR_IFACE.parseError(d) : null; } catch (inner) {}
      if (parsed?.name === "SimulationResult") {
        S.stats.simOk++;
        const profitRaw = parsed.args.returned - parsed.args.owed;
        const profitUsd = loanUsd != null ? (Number(profitRaw) / 10 ** r.m.loan.decimals) * loanUsd : null;
        notes.push(`${route.label}: 利益${profitUsd != null ? "$" + profitUsd.toFixed(2) : "?"}`);
        if (!best || profitRaw > best.profitRaw) best = { route, profitRaw, profitUsd };
      } else {
        notes.push(`${route.label}: 取り消し(${(e.reason || e.shortMessage || "").slice(0, 60)})`);
      }
    }
  }
  const gasUsd = (await gasUnitsToUsd(MORPHO_LIQ_CHAIN, GAS_UNITS).catch(() => null)) ?? 0.05;
  const net = best?.profitUsd != null ? best.profitUsd - gasUsd : null;
  if (net != null && net > 0) S.stats.simBest++;
  const seen = S.seen.get(keyOf(r.id, r.user));
  if (seen && best?.profitUsd != null) seen.simUsd = best.profitUsd;
  console.log(`${head} → 確認 ${notes.join(" / ")}。ガス約$${gasUsd.toFixed(3)} 純利${net != null ? "$" + net.toFixed(2) : "?"}(DRY_RUN なので送りません)`);
}

// ===== 巡回 =====

async function sweep() {
  if (S.busy) return;
  S.busy = true;
  try {
    const block = await readForward();
    await backfill();
    const entries = [...S.roster.values()];
    const results = await readHealth(entries, false);
    await handleResults(results, block);
    // 清算されないまま1日経った「発見」は捨てる(誰も手を出さない塵や、自力で直した人)
    for (const [k, v] of S.seen) if (Date.now() - v.at > 24 * 3600 * 1000) S.seen.delete(k);
    for (const [k, t] of S.lastSim) if (Date.now() - t > 3600 * 1000) S.lastSim.delete(k);
    S.stats.sweeps++;
    saveState();
  } catch (e) {
    console.warn(`[Morpho清算] 巡回で失敗: ${(e.message || "").slice(0, 120)}`);
  } finally {
    S.busy = false;
  }
}

async function watchTick() {
  if (S.watchBusy || S.watch.size === 0) return;
  S.watchBusy = true;
  try {
    const block = await callWithRpc(MORPHO_LIQ_CHAIN, (p) => p.getBlockNumber(), true);
    const entries = [...S.watch.keys()].map((k) => S.roster.get(k)).filter(Boolean);
    const results = await readHealth(entries, true);
    await handleResults(results, block);
  } catch (e) {
  } finally {
    S.watchBusy = false;
  }
}

export async function startMorphoLiquidation(activeChains) {
  if (!MORPHO_LIQ_CHAIN || !MORPHO_BLUE[MORPHO_LIQ_CHAIN]) return false;
  if (!activeChains.includes(MORPHO_LIQ_CHAIN)) {
    console.log(`[Morpho清算] ${MORPHO_LIQ_CHAIN} は稼働していないので見張りません`);
    return false;
  }
  loadState();
  S.started = true;
  const addr = contractAddress();
  console.log(`[Morpho清算] 見張りを始めます: ${MORPHO_LIQ_CHAIN}(名簿${S.roster.size}人を引き継ぎ、全員${MORPHO_SWEEP_MS / 1000}秒ごと・危ない人${MORPHO_WATCH_MS / 1000}秒ごと)。`
    + `**送信はしません**。契約 ${addr ? addr : `未配備(${morphoLiquidatorAddressEnvVar(MORPHO_LIQ_CHAIN)} が空)`}`);
  setInterval(() => { sweep(); }, MORPHO_SWEEP_MS);
  setInterval(() => { watchTick(); }, MORPHO_WATCH_MS);
  setTimeout(() => { sweep(); }, 20 * 1000);
  return true;
}

function median(xs) {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

/// 生存ログの1区切り。
export function formatMorphoLine() {
  if (!S.started) return "";
  const st = S.stats;
  const start = MORPHO_BLUE[MORPHO_LIQ_CHAIN].startBlock;
  const span = (S.forwardFrom ?? start) - start;
  const done = span > 0 && S.backTo != null ? Math.round((((S.forwardFrom ?? start) - S.backTo) / span) * 100) : 0;
  const lead = median(st.leadBlocks);
  return ` Morpho[名簿${S.roster.size} 遡り${done}% 危ない${S.watch.size} 清算可${st.liquidatable}(塵${st.dust}) 確認${st.simOk}/${st.simulated} 黒字${st.simBest} 経路なし${st.noRoute}`
    + ` 実清算${st.liqEvents}=先に発見${st.liqSeenFirst}${lead != null ? `(先行中央${lead}ブロック)` : ""}/見逃し${st.liqMissed}`
    + ` 報酬 発見分$${st.seenBonusUsd.toFixed(0)}/見逃し分$${st.missedBonusUsd.toFixed(0)} RPC${st.requests}(断${st.refusals})]`;
}
