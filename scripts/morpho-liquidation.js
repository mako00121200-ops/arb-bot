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
import { callWithRpc, readBlockTag } from "./onchain-reserves.js";
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
export const MORPHO_WATCH_MS = parseInt(process.env.MORPHO_LIQ_WATCH_MS || "1000", 10);
/// 「危ない」とみなす借金の使用率(借金 ÷ 借りられる上限)。
const WATCH_RATIO = parseFloat(process.env.MORPHO_LIQ_WATCH_RATIO || "0.95");
/// これ未満の清算は相手にしない(ガス代に負ける)。返済額のドル。
const MIN_DEBT_USD = parseFloat(process.env.MORPHO_LIQ_MIN_DEBT_USD || "10");
/// 1回の巡回で遡る getLogs の上限(裁定の RPC を圧迫しないため)。
const BACKFILL_REQUESTS_PER_TICK = parseInt(process.env.MORPHO_LIQ_BACKFILL_PER_TICK || "30", 10);
/// eth_call で確かめる経路の本数。
const SIMULATE_TOP_N = 3;
/// 同じ借り手を確かめ直すまでの時間。清算されずに残る人(放置)を毎分確かめてログを埋めないため長めに。
const RESIM_MS = 10 * 60 * 1000;
/// 清算できるのに、これだけ誰にも清算されない人は「放置」として別に数える。
/// [なぜ(2026年9月23日 17:54 JST の初回の実測)]
/// wbCOIN/USDC で使用率102.6%の人が約20人、誰にも清算されずに残っていた。売れない担保・止まった
/// オラクル・送金停止などで「清算できても誰も取らない」ものは、競争の場ではない。
/// これを「清算可」に混ぜると、機会を水増しして読んでしまう。
const STALE_MS = 10 * 60 * 1000;
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
const MC_ABI = [
  "function aggregate3((address target,bool allowFailure,bytes callData)[] calls) view returns ((bool success,bytes returnData)[])",
  "function getBlockNumber() view returns (uint256)",
];
const MC_IFACE = new ethers.Interface(MC_ABI);
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
  seen: new Map(),       // key -> { block, at, repaidUsd, simUsd } 清算できると見つけた時(block は**読んだ状態の**ブロック)
  last: new Map(),       // key -> { ratio, block, at } 最後に読んだ使用率(見逃しの原因を切り分けるため)
  liqDone: new Map(),    // key -> 最後に数えた清算の取引(同じ取引の分割清算を二重に数えない)
  blockTs: new Map(),    // ブロック番号 -> 時刻(秒)
  lastSim: new Map(),    // key -> 時刻
  busy: false,
  watchBusy: false,
  owner: null,
  stats: {
    sweeps: 0, positionsRead: 0, liquidatable: 0, simulated: 0, simOk: 0, simBest: 0,
    liqEvents: 0, liqSeenFirst: 0, liqMissed: 0, leadBlocks: [], missedBonusUsd: 0, seenBonusUsd: 0,
    requests: 0, refusals: 0, noRoute: 0, dust: 0,
    // 先行の内訳: 同じブロック内(Flashblock 単位の勝負) / 1ブロック(同着の勝負) / 2ブロック以上(先に出せた)
    gapSame: 0, gapOne: 0, gapMore: 0,
    // 見逃しの内訳: 名簿に無い / 遡りが終わる前 / 名簿にいて直前の使用率が低かった(急落か式のずれ) / 近かったが間に合わず
    missNoRoster: 0, missBackfill: 0, missFar: 0, missSlow: 0,
    simErr: {},  // 取り消し理由 -> 件数(HEALTHY_POSITION が多ければ健全度の式がずれている)
    watchTicks: 0, watchMs: [],
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

/// blockTag を渡すと、全部の束を**同じブロックの状態**で読む(束ごとにブロックがずれると判定が狂う)。
async function aggregate(calls, priority = false, blockTag = "latest") {
  const out = [];
  for (let i = 0; i < calls.length; i += 400) {
    const part = calls.slice(i, i + 400);
    const r = await callWithRpc(MORPHO_LIQ_CHAIN, (p) => new ethers.Contract(MULTICALL3_ADDRESS, MC_ABI, p).aggregate3(part, { blockTag }), priority);
    out.push(...r);
  }
  return out;
}

async function blockTimestamp(n) {
  if (S.blockTs.has(n)) return S.blockTs.get(n);
  try {
    const b = await callWithRpc(MORPHO_LIQ_CHAIN, (p) => p.getBlock(n));
    const ts = b ? Number(b.timestamp) : null;
    if (ts != null) {
      S.blockTs.set(n, ts);
      if (S.blockTs.size > 2000) S.blockTs.delete(S.blockTs.keys().next().value);
    }
    return ts;
  } catch (e) {
    return null;
  }
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

/// ドル建てのステーブル(外部 API が落ちていても $1 とみなしてよいもの)。記号で判定する。
const USD_STABLES = new Set(["USDC", "USDBC", "USDT", "USDT0", "DAI", "USDS", "GHO", "USDE", "LUSD", "CRVUSD", "FRAX", "PYUSD", "USD0", "FXUSD", "USR", "SUSD"]);
async function loanUsdOf(m) {
  const v = await tokenUsd(m.params.loanToken);
  if (v != null) return v;
  return USD_STABLES.has(String(m.loan?.symbol || "").toUpperCase()) ? 1 : null;
}
const fmtUsd = (v, digits = 0) => (v == null ? "$?" : `$${v.toFixed(digits)}`);

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
///
/// [先行の読み方]
/// seen.block は「清算できると分かった**状態**のブロック」(Multicall3.getBlockNumber で読んだ番号。
/// pending で読んだ時は作りかけのブロック)。清算が入ったブロックを B とすると gap = B − seen.block。
///   gap ≤ 0 … 同じブロックの中で清算された。Flashblock(200ms)単位の速さ勝負
///   gap = 1 … 次のブロックに入った。そこへ出せば**同着の勝負**(優先手数料の順)
///   gap ≥ 2 … 丸1ブロック以上の余裕があった。**出していれば先に取れた**
/// 時間でも見る: 清算のブロックの時刻 − 見つけた時刻。
async function noteLiquidation(log) {
  let ev;
  try { ev = MORPHO_IFACE.parseLog(log); } catch (e) { return; }
  const id = ev.args.id, borrower = ev.args.borrower;
  const key = keyOf(id, borrower);
  // 同じ取引の中の分割清算は1回として数える
  if (S.liqDone.get(key) === log.transactionHash) return;
  S.liqDone.set(key, log.transactionHash);
  if (S.liqDone.size > 5000) S.liqDone.delete(S.liqDone.keys().next().value);
  const block = Number(log.blockNumber);
  await ensureMarkets([id]).catch(() => {});
  const m = S.markets.get(id);
  const loanUsd = m ? await loanUsdOf(m) : null;
  const repaidUsd = m && loanUsd != null ? (Number(ev.args.repaidAssets) / 10 ** m.loan.decimals) * loanUsd : null;
  const bonusUsd = repaidUsd != null ? repaidUsd * (Number(m.lif) / 1e18 - 1) : null;
  if (repaidUsd != null && repaidUsd < MIN_DEBT_USD) { S.seen.delete(key); return; } // 塵は数えない
  S.stats.liqEvents++;
  const seen = S.seen.get(key);
  const pair = m ? `${m.coll.symbol}/${m.loan.symbol}` : short(id);
  const head = `[Morpho清算/答え合わせ ${nowJst()}] ${pair} ${short(borrower)} 返済${fmtUsd(repaidUsd)} 報酬約${fmtUsd(bonusUsd, 2)} ブロック${block}`;
  if (seen) {
    const gap = block - seen.block;
    const ts = await blockTimestamp(block);
    const leadMs = ts != null ? ts * 1000 - seen.at : null;
    S.stats.liqSeenFirst++;
    if (gap <= 0) S.stats.gapSame++; else if (gap === 1) S.stats.gapOne++; else S.stats.gapMore++;
    S.stats.leadBlocks.push(gap);
    if (S.stats.leadBlocks.length > 500) S.stats.leadBlocks.shift();
    S.stats.seenBonusUsd += bonusUsd ?? 0;
    const staleFor = Date.now() - seen.at;
    const verdict = staleFor > STALE_MS ? `放置されていた(${(staleFor / 60000).toFixed(0)}分)後に清算。競争は薄い`
      : gap >= 2 ? "**出していれば先に取れた**" : gap === 1 ? "同着の勝負" : "同じブロック内で負け(Flashblock 単位の速さ勝負)";
    console.log(`${head}: 先に見つけていた(状態ブロック${seen.block} → 差${gap}ブロック、`
      + `ブロック時刻まで${leadMs != null ? (leadMs / 1000).toFixed(1) + "秒" : "?"}) → ${verdict}。`
      + `確認の利益${seen.simUsd != null ? "$" + seen.simUsd.toFixed(2) : seen.simRaw ?? "未確認"}。清算者 ${short(ev.args.caller)}`);
  } else {
    S.stats.liqMissed++;
    S.stats.missedBonusUsd += bonusUsd ?? 0;
    const last = S.last.get(key);
    let why;
    if (!S.roster.has(key) && !last) {
      const backfilling = S.backTo != null && S.backTo > MORPHO_BLUE[MORPHO_LIQ_CHAIN].startBlock;
      if (backfilling) { S.stats.missBackfill++; why = "名簿に無い(遡りの途中)"; }
      else { S.stats.missNoRoster++; why = "**名簿に無い**(Borrow 以外の道で借りた人? 要調査)"; }
    } else if (last && last.ratio < 0.99) {
      S.stats.missFar++;
      why = `直前の使用率${(last.ratio * 100).toFixed(1)}%(${((Date.now() - last.at) / 1000).toFixed(0)}秒前・ブロック${last.block})= 急落か、**健全度の式のずれ**`;
    } else {
      S.stats.missSlow++;
      why = `近かったが間に合わず(直前の使用率${last ? (last.ratio * 100).toFixed(1) + "%・" + ((Date.now() - last.at) / 1000).toFixed(0) + "秒前" : "?"})`;
    }
    console.log(`${head}: 見逃し — ${why}。清算者 ${short(ev.args.caller)}`);
  }
  S.seen.delete(key);
}

// ===== 健全度を読む =====

/// 健全度を読む。戻り値 { results, stateBlock, at }。
/// stateBlock は**読んだ状態そのもの**のブロック番号(Multicall3.getBlockNumber を同じ束で読む)。
async function readHealth(entries, priority, blockTag) {
  if (entries.length === 0) return { results: [], stateBlock: null, at: Date.now() };
  const morpho = MORPHO_BLUE[MORPHO_LIQ_CHAIN].address;
  const ids = [...new Set(entries.map((e) => e.id))];
  await ensureMarkets(ids);
  const liveIds = ids.filter((id) => S.markets.get(id));
  const liveSet = new Set(liveIds);
  const live = entries.filter((e) => liveSet.has(e.id));
  // 先頭: 状態のブロック番号 → 市場ごとの合計と価格 → 借り手ごとの持分。**全部を1つの状態で読む。**
  const calls = [
    { target: MULTICALL3_ADDRESS, allowFailure: true, callData: MC_IFACE.encodeFunctionData("getBlockNumber") },
    ...liveIds.map((id) => ({ target: morpho, allowFailure: true, callData: MORPHO_IFACE.encodeFunctionData("market", [id]) })),
    ...liveIds.map((id) => ({ target: S.markets.get(id).params.oracle, allowFailure: true, callData: ORACLE_IFACE.encodeFunctionData("price") })),
    ...live.map((e) => ({ target: morpho, allowFailure: true, callData: MORPHO_IFACE.encodeFunctionData("position", [e.id, e.user]) })),
  ];
  const r = await aggregate(calls, priority, blockTag);
  const at = Date.now();
  let stateBlock = null;
  try { if (r[0]?.success) stateBlock = Number(MC_IFACE.decodeFunctionResult("getBlockNumber", r[0].returnData)[0]); } catch (e) {}
  const mkt = new Map(), price = new Map();
  const n = liveIds.length;
  liveIds.forEach((id, i) => {
    try {
      if (r[1 + i]?.success) {
        const d = MORPHO_IFACE.decodeFunctionResult("market", r[1 + i].returnData);
        mkt.set(id, { totalBorrowAssets: BigInt(d.totalBorrowAssets), totalBorrowShares: BigInt(d.totalBorrowShares) });
      }
      if (r[1 + n + i]?.success) price.set(id, BigInt(ORACLE_IFACE.decodeFunctionResult("price", r[1 + n + i].returnData)[0]));
    } catch (e) {}
  });
  S.stats.positionsRead += live.length;
  const results = [];
  live.forEach((e, i) => {
    const pr = r[1 + 2 * n + i];
    if (!pr?.success || !mkt.has(e.id) || !price.has(e.id)) return;
    const d = MORPHO_IFACE.decodeFunctionResult("position", pr.returnData);
    const pos = { borrowShares: BigInt(d.borrowShares), collateral: BigInt(d.collateral) };
    const key = keyOf(e.id, e.user);
    if (pos.borrowShares === 0n) { S.roster.delete(key); S.watch.delete(key); return; }
    const m = S.markets.get(e.id);
    const h = healthOf(pos, mkt.get(e.id), price.get(e.id), m.params.lltv);
    S.last.set(key, { ratio: h.ratio, block: stateBlock, at });
    results.push({ ...e, pos, h, price: price.get(e.id), m });
  });
  return { results, stateBlock, at };
}

async function handleResults({ results, stateBlock, at }) {
  // **先に全部の「発見」を記録する。** 価格の問い合わせ(外部 API)や確認を挟むと、
  // 発見の時刻が遅れて「先行」を少なく測ってしまう。
  const found = [];
  for (const r of results) {
    const key = keyOf(r.id, r.user);
    if (r.h.ratio >= WATCH_RATIO) S.watch.set(key, r.h.ratio); else S.watch.delete(key);
    if (!r.h.liquidatable) continue;
    if (!S.seen.has(key)) {
      S.seen.set(key, { block: stateBlock, at, repaidUsd: null, simUsd: null, simRaw: null, pair: `${r.m.coll?.symbol}/${r.m.loan?.symbol}` });
      S.stats.liquidatable++; // 同じ人を読み直すたびに数えない(1秒ごとに読むので、数えると何十倍にもなる)
    }
    found.push(r);
  }
  for (const r of found) {
    const key = keyOf(r.id, r.user);
    const loanUsd = await loanUsdOf(r.m);
    const repaidUsd = loanUsd != null ? (Number(r.h.borrowed) / 10 ** r.m.loan.decimals) * loanUsd : null;
    const seen = S.seen.get(key);
    if (seen) seen.repaidUsd = repaidUsd;
    if (repaidUsd != null && repaidUsd < MIN_DEBT_USD) {
      // 塵も「人」で数える(毎秒読み直すたびに数えると、19:21 JST に 11,378 と膨らんでいた)
      if (seen && !seen.dust) { seen.dust = true; S.stats.dust++; }
      continue;
    }
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
    + `返済約${fmtUsd(repaidUsd)} 報酬見込み約${fmtUsd(bonusUsd, 2)}${amt.badDebtZone ? "(担保不足=貸し倒れ域)" : ""}`;
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
      await callWithRpc(MORPHO_LIQ_CHAIN, (p) => p.call({ to: address, from: S.owner, data, blockTag: readBlockTag(MORPHO_LIQ_CHAIN) }), true);
      notes.push(`${route.label}: 結果なし`);
    } catch (e) {
      const d = e?.data ?? e?.info?.error?.data ?? e?.error?.data ?? null;
      let parsed = null;
      try { parsed = typeof d === "string" ? LIQUIDATOR_IFACE.parseError(d) : null; } catch (inner) {}
      if (parsed?.name === "SimulationResult") {
        S.stats.simOk++;
        const profitRaw = parsed.args.returned - parsed.args.owed;
        const profitUsd = loanUsd != null ? (Number(profitRaw) / 10 ** r.m.loan.decimals) * loanUsd : null;
        notes.push(`${route.label}: 利益${profitUsd != null ? "$" + profitUsd.toFixed(2) : `${ethers.formatUnits(profitRaw, r.m.loan.decimals)} ${r.m.loan.symbol}`}`);
        if (!best || profitRaw > best.profitRaw) best = { route, profitRaw, profitUsd };
      } else {
        const reason = (e.reason || e.shortMessage || "不明").slice(0, 60);
        // "position is healthy" が多ければ、こちらの健全度の式が Morpho とずれている
        const k = /healthy/i.test(reason) ? "健全(式のずれ?)" : reason.slice(0, 30);
        S.stats.simErr[k] = (S.stats.simErr[k] || 0) + 1;
        notes.push(`${route.label}: 取り消し(${reason})`);
      }
    }
  }
  const gasUsd = (await gasUnitsToUsd(MORPHO_LIQ_CHAIN, GAS_UNITS).catch(() => null)) ?? 0.05;
  const net = best?.profitUsd != null ? best.profitUsd - gasUsd : null;
  if (net != null && net > 0) S.stats.simBest++;
  const seen = S.seen.get(keyOf(r.id, r.user));
  if (seen && best) { seen.simUsd = best.profitUsd; seen.simRaw = `${ethers.formatUnits(best.profitRaw, r.m.loan.decimals)} ${r.m.loan.symbol}`; }
  console.log(`${head} → 確認 ${notes.join(" / ")}。ガス約$${gasUsd.toFixed(3)} 純利${net != null ? "$" + net.toFixed(2) : "?"}(DRY_RUN なので送りません)`);
}

// ===== 巡回 =====

async function sweep() {
  if (S.busy) return;
  S.busy = true;
  try {
    const latest = await readForward();
    await backfill();
    const entries = [...S.roster.values()];
    // 全員は**確定済みの1つのブロック**に揃えて読む(束が多くても状態がずれない)
    const read = await readHealth(entries, false, latest);
    await handleResults(read);
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
    const entries = [...S.watch.keys()].map((k) => S.roster.get(k)).filter(Boolean);
    // 危ない人は**確定前(pending)の状態**を1回の束で読む。Flashblocks のチェーンでは
    // 200ms ごとに更新される作りかけのブロックが見えるので、確定(2秒)を待たずに気づける。
    const t0 = Date.now();
    const read = await readHealth(entries, true, readBlockTag(MORPHO_LIQ_CHAIN));
    S.stats.watchTicks++;
    S.stats.watchMs.push(Date.now() - t0);
    if (S.stats.watchMs.length > 200) S.stats.watchMs.shift();
    await handleResults(read);
  } catch (e) {
  } finally {
    S.watchBusy = false;
  }
}

/// **経路の点検(測り方の点検)。** 借り手の多い市場ごとに、担保 $1,000 ぶんを借金の通貨へ売る経路が
/// 見つかるか・どれだけ目減りするかを出す。経路探しは Aave 用の仕組みを借りているので、
/// base で大きい DEX(Aerodrome 等)を探せていなければ、主要な市場でも「経路なし」になり、
/// 確認(eth_call)の利益が測れない。本物の清算が来る前に確かめる。
async function selfCheckRoutes() {
  if (EXECUTOR_CHAIN !== MORPHO_LIQ_CHAIN) {
    console.log(`[Morpho清算/経路点検] 経路探しが ${EXECUTOR_CHAIN} 用のため点検できません`);
    return;
  }
  const count = new Map();
  for (const { id } of S.roster.values()) count.set(id, (count.get(id) || 0) + 1);
  const ids = [...count.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12).map(([id]) => id);
  await ensureMarkets(ids);
  const morpho = MORPHO_BLUE[MORPHO_LIQ_CHAIN].address;
  const live = ids.filter((id) => S.markets.get(id));
  const r = await aggregate(live.map((id) => ({ target: S.markets.get(id).params.oracle, allowFailure: true, callData: ORACLE_IFACE.encodeFunctionData("price") })));
  const lines = [];
  let ok = 0;
  for (const [i, id] of live.entries()) {
    const m = S.markets.get(id);
    const pair = `${m.coll.symbol}/${m.loan.symbol}(${count.get(id)}人)`;
    try {
      if (!r[i]?.success) { lines.push(`${pair}:価格読めず`); continue; }
      const price = BigInt(ORACLE_IFACE.decodeFunctionResult("price", r[i].returnData)[0]);
      const loanUsd = await loanUsdOf(m);
      if (!loanUsd || price === 0n) { lines.push(`${pair}:ドル不明`); continue; }
      // $1,000 ぶんの借金の通貨 → それに見合う担保の量(オラクル価格で)
      const loanAmt = BigInt(Math.round((1000 / loanUsd) * 10 ** Math.min(m.loan.decimals, 12))) * 10n ** BigInt(Math.max(0, m.loan.decimals - 12));
      const collAmt = (loanAmt * ORACLE_PRICE_SCALE) / price;
      const routes = await buildAaveRoutes(m.params.collateralToken, m.params.loanToken, collAmt);
      if (routes.length === 0) { lines.push(`${pair}:**経路なし**`); continue; }
      const best = routes[0];
      const lossBps = Number(((loanAmt - best.estimatedOut) * 10000n) / loanAmt);
      ok++;
      lines.push(`${pair}:${best.label} 目減り${lossBps}bps(報酬${((Number(m.lif) / 1e18 - 1) * 100).toFixed(1)}%)`);
    } catch (e) {
      lines.push(`${pair}:失敗(${(e.message || "").slice(0, 40)})`);
    }
  }
  console.log(`[Morpho清算/経路点検] 借り手の多い${live.length}市場のうち経路あり${ok}。$1,000 を売った時: ${lines.join(" | ")}`);
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
  // 経路の点検は名簿がある程度そろってから(起動5分後)と、その後6時間ごと
  setTimeout(() => { selfCheckRoutes().catch((e) => console.warn(`[Morpho清算/経路点検] 失敗: ${(e.message || "").slice(0, 100)}`)); }, 5 * 60 * 1000);
  setInterval(() => { selfCheckRoutes().catch(() => {}); }, 6 * 3600 * 1000);
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
  const err = Object.entries(st.simErr).map(([k, v]) => `${k}:${v}`).join(" ");
  const wm = median(st.watchMs);
  const now = Date.now();
  const stale = [...S.seen.values()].filter((v) => now - v.at > STALE_MS);
  const staleMarkets = new Map();
  for (const v of stale) if (v.pair) staleMarkets.set(v.pair, (staleMarkets.get(v.pair) || 0) + 1);
  const staleLine = stale.length ? ` 放置${stale.length}(10分以上。${[...staleMarkets].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k, v]) => `${k}:${v}`).join(" ")})` : "";
  return ` Morpho[名簿${S.roster.size} 遡り${done}% 危ない${S.watch.size}(読み${wm != null ? wm + "ms" : "-"}) 清算可${st.liquidatable}(塵${st.dust})${staleLine}`
    + ` 確認${st.simOk}/${st.simulated} 黒字${st.simBest} 経路なし${st.noRoute}${err ? ` 取消[${err}]` : ""}`
    + ` 実清算${st.liqEvents}=先に発見${st.liqSeenFirst}[2ブロック以上${st.gapMore} 1ブロック${st.gapOne} 同ブロック内${st.gapSame}]`
    + `/見逃し${st.liqMissed}[名簿なし${st.missNoRoster} 遡り中${st.missBackfill} 使用率低${st.missFar} 間に合わず${st.missSlow}]`
    + ` 報酬 発見分$${st.seenBonusUsd.toFixed(0)}/見逃し分$${st.missedBonusUsd.toFixed(0)} RPC${st.requests}(断${st.refusals})]`;
}
