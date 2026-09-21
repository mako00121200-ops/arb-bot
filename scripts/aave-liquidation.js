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
const MAX_LOG_REQUESTS = parseInt(process.env.AAVE_MAX_LOG_REQUESTS || "6", 10);
/// getLogs 1回あたりのブロック数。端点の上限に当たらない範囲にする。
const LOG_CHUNK_BLOCKS = parseInt(process.env.AAVE_LOG_CHUNK_BLOCKS || "2000", 10);
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
const BACKFILL_CHUNKS_PER_RUN = parseInt(process.env.AAVE_BACKFILL_CHUNKS || "2", 10);

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
  rpcCalls: 0, errors: 0, lastError: null, disabledChains: [],
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
      chains[chain] = { users: v.users, forwardFrom: v.forwardFrom, backwardTo: v.backwardTo };
    }
    const tmp = STATE_FILE + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify({ savedAt: new Date().toISOString(), chains }));
    fs.renameSync(tmp, STATE_FILE);
  } catch (e) {
    console.warn(`[清算/名簿] 保存に失敗: ${(e.message || "").slice(0, 80)}`);
  }
}

function stateFor(chain) {
  if (!state.has(chain)) state.set(chain, { users: [], forwardFrom: 0, backwardTo: 0 });
  return state.get(chain);
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
  let requests = 0;

  const collect = async (fromBlock, toBlock) => {
    if (requests >= MAX_LOG_REQUESTS || fromBlock > toBlock) return false;
    requests++;
    stats.rpcCalls++;
    const logs = await callWithRpc(chain, (p) => p.send("eth_getLogs", [{
      address: pool,
      topics: [BORROW_TOPIC],
      fromBlock: "0x" + fromBlock.toString(16),
      toBlock: "0x" + toBlock.toString(16),
    }]));
    for (const log of logs || []) {
      // topics[2] が onBehalfOf。32バイトの右端20バイトが住所。
      const t = log?.topics?.[2];
      if (typeof t !== "string" || t.length < 66) continue;
      const addr = ethers.getAddress("0x" + t.slice(26));
      if (!known.has(addr)) { known.add(addr); st.users.push(addr); }
    }
    return true;
  };

  try {
    // 前へ追いつく(新しく借りた人を拾う)。
    while (st.forwardFrom < latest && requests < MAX_LOG_REQUESTS) {
      const to = Math.min(latest, st.forwardFrom + LOG_CHUNK_BLOCKS - 1);
      if (!(await collect(st.forwardFrom, to))) break;
      st.forwardFrom = to + 1;
    }
    // 後ろへ伸ばす(昔から借りている人を拾う)。
    for (let i = 0; i < BACKFILL_CHUNKS_PER_RUN && st.backwardTo > 0 && requests < MAX_LOG_REQUESTS; i++) {
      const from = Math.max(0, st.backwardTo - LOG_CHUNK_BLOCKS);
      if (!(await collect(from, st.backwardTo - 1))) break;
      st.backwardTo = from;
    }
  } catch (e) {
    stats.errors++; stats.lastError = (e.message || "").slice(0, 80);
  }

  // 人数の上限。古い順(名簿の先頭)から捨てる。
  if (st.users.length > MAX_ROSTER) st.users = st.users.slice(st.users.length - MAX_ROSTER);

  const added = st.users.length - before;
  stats.rosterTotal = [...state.values()].reduce((n, v) => n + v.users.length, 0);
  if (added > 0 || requests > 0) {
    const backNote = st.backwardTo > 0 ? `。過去へ ${st.backwardTo} まで遡り済み` : "。全期間を遡り終えました";
    console.log(`[清算/名簿] ${chain}: 借り手 ${st.users.length.toLocaleString()}人(新規 ${added}人)。RPC ${requests}回${backNote}`);
  }
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
  return ` 清算[名簿${stats.rosterTotal.toLocaleString()} 見張り${watching} 見つけた${stats.found} 他者${stats.taken} 回復${stats.recovered} RPC${stats.rpcCalls}${stats.errors ? ` 失敗${stats.errors}` : ""}]`;
}

export function getAaveStats() {
  return { ...stats, chains: [...verifiedChains], watching: [...watchList.values()].reduce((n, m) => n + m.size, 0) };
}
