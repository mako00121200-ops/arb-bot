// scripts/morpho-mainnet-watch.js
//
// **Ethereum 本体の Morpho の清算を、送らずに見張る**(第2段の1。読み取りのみ・お金は動かない)。
//
// [なぜ(2026年9月24日、オーナーの指示「第2弾の見張りを始めてください」)]
// §17 の調査で、Ethereum 本体の Morpho は PT を除いても報酬が90日で約$43万(1日約$4,800)、
// 清算した人は約150人に分散していた(「主要」22人・1位29%、「ステーブル系」45人・1位30%)。
// ほとんどは**値段が動いたブロックの中で取られる競争**。Ethereum 本体は約12秒ごとの入札の勝負なので、
// base のミリ秒の差とは違い、**気づくのが同じブロックに間に合うか**と**入札の値付け**で決まる。
// コントラクトを置く前に、次を実測する:
//   1. 清算できる人が出た時、我々は**実際に清算されたブロックより前に**気づけていたか(何ブロック先行か)
//   2. その担保は Uniswap V3 で**その場で売って返せる**(= 借りたお金で取れる)ものだったか
//   3. 見逃したなら、なぜか(名簿に居ない / 危ない人に入っていなかった / 同じブロックで動いた)
//
// 送信は一切しない。コントラクトも使わない(売れるかは Uniswap の公式の見積もり QuoterV2 に聞く)。
//
// [環境変数]
//   MORPHO_MAINNET_WATCH=true … 動かす(既定は止まっている)
//   ETHEREUM_RPC_URL          … 読み取りに使う(URL はログに出さない)

import fs from "fs";
import { ethers } from "ethers";
import { stateFilePath } from "./state-file.js";
import { nowJst } from "./jst.js";
import { weiToUsd } from "./gas-cost.js";
import { healthOf, chooseAmounts, lifWad } from "./morpho-liquidation.js";

const ENABLED = process.env.MORPHO_MAINNET_WATCH === "true";
const MORPHO = "0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb";
const START_BLOCK = 18883124; // morpho-org/sdks の addresses.ts(Ethereum 本体の配備ブロック)
const MULTICALL3 = "0xcA11bde05977b3631167028862bE2a173976CA11";
// Uniswap V3 の公式の見積もり係(Ethereum 本体)。scripts/mainnet-depth-survey.js と同じ住所
const QUOTER_V2 = "0x61fFE014bA17989E743c5F6cB21bF9697530B21e";
const FEE_TIERS = [100, 500, 3000, 10000];

const SWEEP_MS = parseInt(process.env.MORPHO_MAINNET_SWEEP_MS || "300000", 10); // 全員を読み直す間隔
const POLL_MS = 3000;          // 新しいブロックを確かめる間隔(ブロックは約12秒)
const WATCH_RATIO = 0.95;      // これ以上を「危ない」として毎ブロック読む
const MIN_REPAID_USD = 100;    // これ未満は塵として数えない
const BATCH = 250;             // 1回の multicall に入れる借り手の数
const BACKFILL_CHUNK0 = 50_000;
const GAS_UNITS = 700_000n;    // 清算 + 1段の売却の見込み(base の実測に近い値)
const STATE_VERSION = 1;

const IFACE = new ethers.Interface([
  "event Borrow(bytes32 indexed id, address caller, address indexed onBehalf, address indexed receiver, uint256 assets, uint256 shares)",
  "event Liquidate(bytes32 indexed id, address indexed caller, address indexed borrower, uint256 repaidAssets, uint256 repaidShares, uint256 seizedAssets, uint256 badDebtAssets, uint256 badDebtShares)",
  "function idToMarketParams(bytes32 id) view returns (address loanToken, address collateralToken, address oracle, address irm, uint256 lltv)",
  "function market(bytes32 id) view returns (uint128 totalSupplyAssets, uint128 totalSupplyShares, uint128 totalBorrowAssets, uint128 totalBorrowShares, uint128 lastUpdate, uint128 fee)",
  "function position(bytes32 id, address user) view returns (uint256 supplyShares, uint128 borrowShares, uint128 collateral)",
]);
const ORACLE = new ethers.Interface(["function price() view returns (uint256)"]);
const ERC20 = new ethers.Interface(["function symbol() view returns (string)", "function decimals() view returns (uint8)"]);
const MC = new ethers.Interface([
  "function aggregate3((address target,bool allowFailure,bytes callData)[] calls) view returns ((bool success,bytes returnData)[])",
  "function getBlockNumber() view returns (uint256)",
]);
const QUOTER = new ethers.Interface([
  "function quoteExactInputSingle((address tokenIn,address tokenOut,uint256 amountIn,uint24 fee,uint160 sqrtPriceLimitX96) params) returns (uint256 amountOut,uint160 sqrtPriceX96After,uint32 initializedTicksCrossed,uint256 gasEstimate)",
]);
const BORROW_TOPIC = IFACE.getEvent("Borrow").topicHash;
const LIQUIDATE_TOPIC = IFACE.getEvent("Liquidate").topicHash;
const keyOf = (id, user) => `${id}|${String(user).toLowerCase()}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ===== 状態 =====
const S = {
  started: false,
  roster: new Map(),   // key -> { id, user }
  markets: new Map(),  // id -> { params, lif, loan, coll } / null(読めない市場)
  watch: new Map(),    // key -> ratio(危ない人)
  seen: new Map(),     // key -> { block, at, repaidUsd, bonusUsd, sell } 清算できると最初に気づいた時
  backfill: { cursor: START_BLOCK, chunk: BACKFILL_CHUNK0 },
  lastBlock: null,
  lastSweep: 0,
  busy: false,
  stats: {
    sweeps: 0, reads: 0, readMs: [], liquidatable: 0,
    sellOk: 0, sellNo: 0, sellNetUsd: [],
    liq: 0, first: 0, lead: [], sameBlock: 0,
    missNoRoster: 0, missLow: 0, missSameBlock: 0,
    bonusSeenUsd: 0, bonusMissUsd: 0, winners: new Map(), errors: 0, lastError: "",
  },
};

let provider = null;
function eth() {
  if (provider) return provider;
  const url = (process.env.ETHEREUM_RPC_URL || "").trim();
  if (!url) throw new Error("ETHEREUM_RPC_URL が未設定");
  provider = new ethers.JsonRpcProvider(url, 1, { staticNetwork: true, batchMaxCount: 1 });
  return provider;
}

function noteError(e) {
  S.stats.errors++;
  S.stats.lastError = (e?.shortMessage || e?.message || String(e)).slice(0, 80);
}

// ===== 保存(再デプロイで名簿を作り直さない)=====
const FILE = () => stateFilePath("morpho-mainnet-watch.json");
function load() {
  try {
    const raw = JSON.parse(fs.readFileSync(FILE(), "utf8"));
    if (raw.version !== STATE_VERSION) return;
    for (const [id, user] of raw.roster || []) S.roster.set(keyOf(id, user), { id, user });
    if (Number.isFinite(raw.cursor)) S.backfill.cursor = raw.cursor;
    for (const k of ["liq", "first", "sameBlock", "missNoRoster", "missLow", "missSameBlock", "bonusSeenUsd", "bonusMissUsd", "sellOk", "sellNo", "liquidatable"]) {
      if (Number.isFinite(raw.stats?.[k])) S.stats[k] = raw.stats[k];
    }
    if (Array.isArray(raw.stats?.lead)) S.stats.lead = raw.stats.lead.slice(-500);
  } catch (e) {}
}
function save() {
  try {
    const st = {};
    for (const k of ["liq", "first", "sameBlock", "missNoRoster", "missLow", "missSameBlock", "bonusSeenUsd", "bonusMissUsd", "sellOk", "sellNo", "liquidatable", "lead"]) st[k] = S.stats[k];
    fs.writeFileSync(FILE(), JSON.stringify({
      version: STATE_VERSION, cursor: S.backfill.cursor,
      roster: [...S.roster.values()].map((e) => [e.id, e.user]), stats: st,
    }));
  } catch (e) {}
}

// ===== 市場の情報 =====
const STABLE = /^(USDC|USDT|DAI|USDS|PYUSD|USDe|FRAX|frxUSD|RLUSD|GHO|crvUSD|USD0|USDtb|USDA|AUSD|EURC)$/i;
let ethUsd = null, ethUsdAt = 0;
async function ethPrice() {
  if (ethUsd && Date.now() - ethUsdAt < 10 * 60 * 1000) return ethUsd;
  const v = await weiToUsd("base", 10n ** 18n).catch(() => null);
  if (v) { ethUsd = v; ethUsdAt = Date.now(); }
  return ethUsd;
}
/// 借金の通貨のドル値段。ステーブルは$1、WETH 系は ETH の値段、それ以外は DexScreener(読めなければ null)。
async function usdPrice(token, symbol) {
  if (STABLE.test(symbol)) return 1;
  if (/^(WETH|ETH)$/i.test(symbol)) return ethPrice();
  try {
    const res = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${token}`);
    if (!res.ok) return null;
    const j = await res.json();
    const pairs = (j.pairs || []).filter((p) => p.chainId === "ethereum" && (p.baseToken?.address || "").toLowerCase() === token.toLowerCase());
    pairs.sort((a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0));
    const v = parseFloat(pairs[0]?.priceUsd);
    return isFinite(v) && v > 0 ? v : null;
  } catch (e) { return null; }
}
async function tokenInfo(token) {
  let symbol = token.slice(0, 8), decimals = 18;
  try { symbol = ERC20.decodeFunctionResult("symbol", await eth().call({ to: token, data: ERC20.encodeFunctionData("symbol") }))[0]; } catch (e) {}
  try { decimals = Number(ERC20.decodeFunctionResult("decimals", await eth().call({ to: token, data: ERC20.encodeFunctionData("decimals") }))[0]); } catch (e) {}
  return { address: token, symbol, decimals };
}
async function ensureMarkets(ids) {
  for (const id of ids) {
    if (S.markets.has(id)) continue;
    try {
      const r = IFACE.decodeFunctionResult("idToMarketParams", await eth().call({ to: MORPHO, data: IFACE.encodeFunctionData("idToMarketParams", [id]) }));
      const params = { loanToken: r.loanToken, collateralToken: r.collateralToken, oracle: r.oracle, irm: r.irm, lltv: BigInt(r.lltv) };
      const [loan, coll] = [await tokenInfo(params.loanToken), await tokenInfo(params.collateralToken)];
      loan.usd = await usdPrice(loan.address, loan.symbol);
      S.markets.set(id, { params, lif: lifWad(params.lltv), loan, coll, usdAt: Date.now() });
    } catch (e) {
      S.markets.set(id, null);
    }
  }
}

// ===== 健全度をまとめて読む(1つのブロックの状態で)=====
async function aggregate(calls, blockTag) {
  const data = MC.encodeFunctionData("aggregate3", [calls]);
  const raw = await eth().call({ to: MULTICALL3, data, blockTag: blockTag ?? "latest" });
  return MC.decodeFunctionResult("aggregate3", raw)[0];
}
async function readHealth(entries, blockTag) {
  const out = [];
  for (let i = 0; i < entries.length; i += BATCH) {
    const part = entries.slice(i, i + BATCH);
    const ids = [...new Set(part.map((e) => e.id))];
    await ensureMarkets(ids);
    const liveIds = ids.filter((id) => S.markets.get(id));
    const live = part.filter((e) => S.markets.get(e.id));
    const calls = [
      { target: MULTICALL3, allowFailure: true, callData: MC.encodeFunctionData("getBlockNumber") },
      ...liveIds.map((id) => ({ target: MORPHO, allowFailure: true, callData: IFACE.encodeFunctionData("market", [id]) })),
      ...liveIds.map((id) => ({ target: S.markets.get(id).params.oracle, allowFailure: true, callData: ORACLE.encodeFunctionData("price") })),
      ...live.map((e) => ({ target: MORPHO, allowFailure: true, callData: IFACE.encodeFunctionData("position", [e.id, e.user]) })),
    ];
    const r = await aggregate(calls, blockTag);
    const block = r[0]?.success ? Number(MC.decodeFunctionResult("getBlockNumber", r[0].returnData)[0]) : null;
    const n = liveIds.length;
    const mkt = new Map(), price = new Map();
    liveIds.forEach((id, j) => {
      try {
        if (r[1 + j]?.success) {
          const d = IFACE.decodeFunctionResult("market", r[1 + j].returnData);
          mkt.set(id, { totalBorrowAssets: BigInt(d.totalBorrowAssets), totalBorrowShares: BigInt(d.totalBorrowShares) });
        }
        if (r[1 + n + j]?.success) price.set(id, BigInt(ORACLE.decodeFunctionResult("price", r[1 + n + j].returnData)[0]));
      } catch (e) {}
    });
    live.forEach((e, j) => {
      const pr = r[1 + 2 * n + j];
      if (!pr?.success || !mkt.has(e.id) || !price.has(e.id)) return;
      const d = IFACE.decodeFunctionResult("position", pr.returnData);
      const pos = { borrowShares: BigInt(d.borrowShares), collateral: BigInt(d.collateral) };
      const key = keyOf(e.id, e.user);
      if (pos.borrowShares === 0n) { S.roster.delete(key); S.watch.delete(key); return; }
      const m = S.markets.get(e.id);
      out.push({ ...e, key, pos, price: price.get(e.id), m, block, h: healthOf(pos, mkt.get(e.id), price.get(e.id), m.params.lltv) });
    });
  }
  S.stats.reads += entries.length;
  return out;
}

/// その担保を Uniswap V3 で売ったら、返済額を上回るか(1段のみ・公式の見積もり)。
/// @returns { ok, netUsd, fee } / 売れる経路が無ければ { ok:false }
async function sellCheck(r, amt, repaidLoan) {
  let best = null;
  for (const fee of FEE_TIERS) {
    try {
      const raw = await eth().call({ to: QUOTER_V2, data: QUOTER.encodeFunctionData("quoteExactInputSingle", [{
        tokenIn: r.m.params.collateralToken, tokenOut: r.m.params.loanToken, amountIn: amt.expectedSeized, fee, sqrtPriceLimitX96: 0n,
      }]) });
      const outAmt = BigInt(QUOTER.decodeFunctionResult("quoteExactInputSingle", raw)[0]);
      if (!best || outAmt > best.out) best = { out: outAmt, fee };
    } catch (e) {}
  }
  if (!best) return { ok: false };
  if (r.m.loan.usd == null) return { ok: false, unknownPrice: true, fee: best.fee };
  const gasWei = GAS_UNITS * ((await eth().getFeeData().catch(() => null))?.gasPrice ?? 0n);
  const gasUsd = (await weiToUsd("base", gasWei).catch(() => null)) ?? 0;
  const net = (Number(best.out - repaidLoan) / 10 ** r.m.loan.decimals) * (r.m.loan.usd ?? 0) - gasUsd;
  return { ok: net > 0, netUsd: net, fee: best.fee };
}

async function handle(results) {
  for (const r of results) {
    if (r.h.ratio >= WATCH_RATIO) S.watch.set(r.key, r.h.ratio); else S.watch.delete(r.key);
    if (!r.h.liquidatable) { S.seen.delete(r.key); continue; } // 健全に戻った人は、次に清算できるようになった時を新しく数える
    if (S.seen.has(r.key)) continue;
    const amt = chooseAmounts(r.pos, r.h.borrowed, r.price, r.m.params.lltv);
    // 返す額(借金の通貨): 全部返せるなら借金全額、貸し倒れ域なら担保全部に見合う額
    const repaidLoan = amt.badDebtZone
      ? (((amt.expectedSeized * r.price) / 10n ** 36n) * 10n ** 18n) / r.m.lif
      : r.h.borrowed;
    const repaidUsd = r.m.loan.usd != null ? (Number(repaidLoan) / 10 ** r.m.loan.decimals) * r.m.loan.usd : null;
    const entry = { block: r.block, at: Date.now(), repaidUsd, bonusUsd: repaidUsd != null ? repaidUsd * (Number(r.m.lif) / 1e18 - 1) : null, sell: null, pair: `${r.m.coll.symbol}/${r.m.loan.symbol}` };
    S.seen.set(r.key, entry);
    if (repaidUsd != null && repaidUsd < MIN_REPAID_USD) { entry.dust = true; continue; }
    S.stats.liquidatable++;
    entry.sell = await sellCheck(r, amt, repaidLoan).catch(() => ({ ok: false }));
    if (entry.sell.ok) { S.stats.sellOk++; S.stats.sellNetUsd.push(entry.sell.netUsd); } else S.stats.sellNo++;
    console.log(`[Morpho本体/候補 ${nowJst()}] ${entry.pair} ${r.user.slice(0, 8)}… 使用率${(r.h.ratio * 100).toFixed(2)}% 返済約$${repaidUsd?.toFixed(0) ?? "?"} 報酬見込み$${entry.bonusUsd?.toFixed(0) ?? "?"} ブロック${r.block}`
      + ` → Uniswap V3 で${entry.sell.ok ? `売って返せる(ガス後 約$${entry.sell.netUsd.toFixed(0)}、手数料帯${entry.sell.fee})` : entry.sell.unknownPrice ? "売る経路はあるが借金の通貨の値段が不明" : entry.sell.netUsd != null ? `売ると赤字(約$${entry.sell.netUsd.toFixed(0)})` : "直接売れる経路なし"}(送りません)`);
  }
}

// ===== 実際の清算との突き合わせ =====
async function checkLiquidations(from, to) {
  const logs = await eth().send("eth_getLogs", [{ address: MORPHO, topics: [LIQUIDATE_TOPIC], fromBlock: "0x" + from.toString(16), toBlock: "0x" + to.toString(16) }]);
  for (const log of logs || []) {
    let ev; try { ev = IFACE.parseLog(log); } catch (e) { continue; }
    const key = keyOf(ev.args.id, ev.args.borrower);
    const block = Number(log.blockNumber);
    await ensureMarkets([ev.args.id]);
    const m = S.markets.get(ev.args.id);
    const repaidUsd = m?.loan.usd != null ? (Number(ev.args.repaidAssets) / 10 ** m.loan.decimals) * m.loan.usd : null;
    if (repaidUsd != null && repaidUsd < MIN_REPAID_USD) continue;
    // 名簿を読み終えて全員を1回読むまでは、見逃しに数えない(起動直後の数字を汚さない)
    if (S.stats.sweeps === 0) continue;
    const bonusUsd = repaidUsd != null ? repaidUsd * (Number(m.lif) / 1e18 - 1) : 0;
    S.stats.liq++;
    const caller = ev.args.caller.toLowerCase();
    S.stats.winners.set(caller, (S.stats.winners.get(caller) || 0) + 1);
    const seen = S.seen.get(key);
    let verdict;
    if (seen && seen.block != null && seen.block < block) {
      S.stats.first++; S.stats.bonusSeenUsd += bonusUsd;
      const lead = block - seen.block;
      S.stats.lead.push(lead); if (S.stats.lead.length > 500) S.stats.lead.shift();
      verdict = `**先に気づいていた**(${lead}ブロック前。売って返せる=${seen.sell?.ok ? "はい" : "いいえ"})`;
    } else {
      S.stats.bonusMissUsd += bonusUsd;
      if (!S.roster.has(key)) { S.stats.missNoRoster++; verdict = "見逃し(名簿に居ない)"; }
      else if (seen && seen.block === block) { S.stats.missSameBlock++; S.stats.sameBlock++; verdict = "見逃し(清算できるようになったのと同じブロックで取られた)"; }
      else { S.stats.missLow++; verdict = "見逃し(危ない人に入っていなかった=一気に値段が動いた)"; }
    }
    console.log(`[Morpho本体/実清算 ${nowJst()}] ${m ? `${m.coll.symbol}/${m.loan.symbol}` : ev.args.id.slice(0, 10)} 返済$${repaidUsd?.toFixed(0) ?? "?"} 報酬約$${bonusUsd.toFixed(0)} by ${caller.slice(0, 8)}… ブロック${block} → ${verdict}`);
    S.seen.delete(key);
  }
}

// ===== 名簿を作る(Borrow を配備ブロックから遡る。少しずつ)=====
async function backfillStep(latest) {
  let requests = 0;
  while (S.backfill.cursor <= latest && requests < 20) {
    const from = S.backfill.cursor;
    const to = Math.min(latest, from + S.backfill.chunk - 1);
    requests++;
    try {
      const logs = await eth().send("eth_getLogs", [{ address: MORPHO, topics: [BORROW_TOPIC], fromBlock: "0x" + from.toString(16), toBlock: "0x" + to.toString(16) }]);
      for (const l of logs || []) {
        try {
          const ev = IFACE.parseLog(l);
          const key = keyOf(ev.args.id, ev.args.onBehalf);
          if (!S.roster.has(key)) S.roster.set(key, { id: ev.args.id, user: ev.args.onBehalf.toLowerCase() });
        } catch (e) {}
      }
      S.backfill.cursor = to + 1;
      S.backfill.chunk = Math.min(S.backfill.chunk * 2, 500_000);
    } catch (e) {
      S.backfill.chunk = Math.max(1_000, Math.floor(S.backfill.chunk / 2));
      if (S.backfill.chunk === 1_000) noteError(e);
    }
    await sleep(100);
  }
}

async function tick() {
  if (S.busy) return;
  S.busy = true;
  try {
    const latest = await eth().getBlockNumber();
    if (S.backfill.cursor <= latest) await backfillStep(latest);
    const backfillDone = S.backfill.cursor > latest;
    if (S.lastBlock != null && latest > S.lastBlock) {
      // 危ない人を、新しいブロックの状態で読み直す
      const entries = [...S.watch.keys()].map((k) => S.roster.get(k)).filter(Boolean);
      const t0 = Date.now();
      await handle(await readHealth(entries, latest));
      S.stats.readMs.push(Date.now() - t0); if (S.stats.readMs.length > 200) S.stats.readMs.shift();
      await checkLiquidations(S.lastBlock + 1, latest);
    }
    S.lastBlock = latest;
    // 全員の読み直し(名簿ができてから)
    if (backfillDone && Date.now() - S.lastSweep > SWEEP_MS) {
      S.lastSweep = Date.now();
      await handle(await readHealth([...S.roster.values()], latest));
      S.stats.sweeps++;
      // 古い「気づいた」記録は捨てる(清算されずに1日以上残るものは競争の場ではない)
      for (const [k, v] of S.seen) if (Date.now() - v.at > 24 * 3600 * 1000) S.seen.delete(k);
      save();
    }
  } catch (e) {
    noteError(e);
  } finally {
    S.busy = false;
  }
}

export function startMorphoMainnetWatch() {
  if (!ENABLED || S.started) return;
  try { eth(); } catch (e) { console.warn(`[Morpho本体] ${e.message}のため見張りません`); return; }
  S.started = true;
  load();
  console.log(`[Morpho本体] 見張りを始めます(送信しない)。名簿${S.roster.size}人を引き継ぎ、遡り位置ブロック${S.backfill.cursor.toLocaleString()}`);
  setInterval(() => { tick(); }, POLL_MS);
}

const median = (xs) => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };

export function formatMorphoMainnetLine() {
  if (!S.started) return "";
  const st = S.stats;
  const span = Math.max(1, (S.lastBlock ?? START_BLOCK) - START_BLOCK);
  const done = Math.min(100, Math.round(((S.backfill.cursor - START_BLOCK) / span) * 100));
  const lead = median(st.lead);
  const top = [...st.winners.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([a, n]) => `${a.slice(0, 6)}:${n}`).join(" ");
  return ` Morpho本体[名簿${S.roster.size} 遡り${done}% 危ない${S.watch.size}(読み${median(st.readMs) ?? "-"}ms) 清算可${st.liquidatable}(売って返せる${st.sellOk}/不可${st.sellNo})`
    + ` 実清算${st.liq}=先に気づいた${st.first}(先行中央${lead ?? "-"}ブロック)/見逃し[名簿なし${st.missNoRoster} 急変${st.missLow} 同ブロック${st.missSameBlock}]`
    + ` 報酬 気づいた分$${Math.round(st.bonusSeenUsd)}/見逃し分$${Math.round(st.bonusMissUsd)}${top ? ` 勝者[${top}]` : ""}`
    + `${st.errors ? ` 失敗${st.errors}(${st.lastError})` : ""} 送信しない]`;
}
