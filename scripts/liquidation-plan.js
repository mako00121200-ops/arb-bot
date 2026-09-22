// scripts/liquidation-plan.js
//
// 清算の**計画を立てる**部分だけを、チェーンを引数に取る形で切り出したもの。
//
// [なぜ切り出したか(2026年9月22日)]
// 清算まわりは2つに分かれていた:
//   scripts/aave-liquidation.js  … **多チェーン**の名簿と健全度(計測のみ。送信しない)
//   scripts/liquidation-monitor.js … **avalanche 専用**の見張りと計画と送信
// 62日ぶりの実測で、価値のある清算は avalanche ではなく他チェーンにあった:
//   $1,000超の頻度  arbitrum 1.27回/日 / polygon 0.94 / base 0.93 / optimism 0.05
// ところが「どの借金をどの担保で取るか」を決める計画の部分だけが
// avalanche 専用の側にしか無く、他チェーンは**見つけても何もできなかった**。
//
// 名簿も健全度も多チェーン版が既にあるので、**足りないのはここだけ**。
// liquidation-monitor.js から計画の部分を、チェーンを引数に取る形で写した。
// 計算の中身(Aave v3.3 の close factor の規則)は1行も変えていない。
//
// [このファイルは送信しない]
// 読み取りと計算だけ。送信は liquidation-executor.js の仕事。

import { ethers } from "ethers";
import { callWithRpc } from "./onchain-reserves.js";
import { MULTICALL3_ADDRESS } from "./multicall-reserves.js";

// ===== 共有の設定 =====
// **ここが唯一の出どころ。** liquidation-monitor.js もここから読む
// (同じ環境変数を2か所で解釈すると、片方だけ直して食い違う)。

/// 送信するか。既定は送らない。**false にするのはオーナーの判断。**
export const DRY_RUN = process.env.LIQUIDATION_DRY_RUN !== "false";
/// 手数料負けするなら見送る(2026年9月21日のオーナーの決定)。
export const MIN_PROFIT_USD = Number(process.env.LIQUIDATION_MIN_PROFIT_USD || "0.00001");
/// 1回で肩代わりする借金の上限(USD)。
export const MAX_DEBT_USD = Number(process.env.LIQUIDATION_MAX_DEBT_USD || "2000");
/// 担保を売る時に許す滑り(bps)。
export const MAX_SLIPPAGE_BPS = parseInt(process.env.LIQUIDATION_MAX_SLIPPAGE_BPS || "300", 10);
/// 同じ借り手へ続けて手を出さない時間。
export const COOLDOWN_MS = parseInt(process.env.LIQUIDATION_COOLDOWN_MS || String(5 * 60 * 1000), 10);

// ===== Aave の定数(v3.3 の LiquidationLogic より)=====
/// HF がこれ未満なら一度に全額返せる。
const CLOSE_FACTOR_HF = ethers.parseUnits("0.95", 18);
/// 借金か担保がこの額(基準通貨・8桁)未満なら全額返せる。
const MIN_BASE_MAX_CLOSE_FACTOR_THRESHOLD = 2000n * 10n ** 8n;
/// 一部だけ返す時、借金も担保もこの額以上残さないと拒否される。
const MIN_LEFTOVER_BASE = 1000n * 10n ** 8n;
/// フラッシュローンの手数料(0.05%)。
const FLASH_FEE = 0.0005;

// ===== ABI =====
const POOL_IFACE = new ethers.Interface([
  "function getReservesList() view returns (address[])",
  "function ADDRESSES_PROVIDER() view returns (address)",
]);
const PROVIDER_IFACE = new ethers.Interface([
  "function getPriceOracle() view returns (address)",
  "function getPoolDataProvider() view returns (address)",
]);
const ORACLE_IFACE = new ethers.Interface([
  "function getAssetsPrices(address[] assets) view returns (uint256[])",
]);
const DATA_IFACE = new ethers.Interface([
  "function getReserveConfigurationData(address asset) view returns (uint256 decimals,uint256 ltv,uint256 liquidationThreshold,uint256 liquidationBonus,uint256 reserveFactor,bool usageAsCollateralEnabled,bool borrowingEnabled,bool stableBorrowRateEnabled,bool isActive,bool isFrozen)",
  "function getLiquidationProtocolFee(address asset) view returns (uint256)",
  "function getUserReserveData(address asset,address user) view returns (uint256 currentATokenBalance,uint256 currentStableDebt,uint256 currentVariableDebt,uint256 principalStableDebt,uint256 scaledVariableDebt,uint256 stableBorrowRate,uint256 liquidityRate,uint40 stableRateLastUpdated,bool usageAsCollateralEnabled)",
]);
const ERC20_IFACE = new ethers.Interface(["function symbol() view returns (string)"]);
const MULTICALL3_ABI = [
  "function aggregate3((address target,bool allowFailure,bytes callData)[] calls) payable returns ((bool success,bytes returnData)[])",
];

// ===== 市場ごとの状態 =====
/// 市場の鍵 -> { oracle, dataProvider, list: [asset], reserves: Map(asset -> info), pricedAt }
const markets = new Map();

/// **読み込み中の約束を覚えておく(2026年9月22日 09:11 JST の実測で必要と分かった)。**
///
/// [何が起きたか]
/// 清算できる人を15人まとめて見つけた時、15本の計画づくりが**同時に**走り、
/// 全部が「まだ資産を読んでいない」と判断して**それぞれ別の表を作った**。
/// 最後に書いた表だけが markets に残り、価格はそこに入る。ところが
/// 各計画は自分が作った**古い表**を握っているので、価格が 0 のまま。
/// 結果、15人中11人が「計画できず(価格が無い)」になった。
/// ログに「資産15種を読みました」が4回出ていたのがその証拠。
///
/// 同じ市場への2本目以降は、1本目の約束をそのまま待たせる。
/// RPCも1回分で済む。
const loadingMarket = new Map();
const loadingPrices = new Map();

/// **価格はすぐ古くなる。** これより古ければ読み直す。
const PRICE_MAX_AGE_MS = parseInt(process.env.LIQUIDATION_PRICE_MAX_AGE_MS || "30000", 10);

function short(a) { return (a || "").slice(0, 10) + "…"; }
function baseToUsd(v) { return Number(v) / 1e8; }

async function multicall(chain, calls, priority = false) {
  return callWithRpc(chain, (p) =>
    new ethers.Contract(MULTICALL3_ADDRESS, MULTICALL3_ABI, p).aggregate3.staticCall(calls), priority);
}

/// Pool から オラクルと データプロバイダ を辿る。**住所は思い込みで書かない。**
/// フォークの市場でも同じやり方で解決できる。
async function resolveAddresses(chain, rpcChain, pool) {
  const raw = await callWithRpc(rpcChain, (p) =>
    p.call({ to: pool, data: POOL_IFACE.encodeFunctionData("ADDRESSES_PROVIDER", []) }), true);
  const provider = POOL_IFACE.decodeFunctionResult("ADDRESSES_PROVIDER", raw)[0];
  const calls = [
    { target: provider, allowFailure: true, callData: PROVIDER_IFACE.encodeFunctionData("getPriceOracle", []) },
    { target: provider, allowFailure: true, callData: PROVIDER_IFACE.encodeFunctionData("getPoolDataProvider", []) },
  ];
  const r = await multicall(rpcChain, calls, true);
  const oracle = r[0]?.success ? PROVIDER_IFACE.decodeFunctionResult("getPriceOracle", r[0].returnData)[0] : null;
  const dataProvider = r[1]?.success ? PROVIDER_IFACE.decodeFunctionResult("getPoolDataProvider", r[1].returnData)[0] : null;
  return { oracle, dataProvider };
}

/// その市場の資産の情報(桁数・ボーナス・手数料・担保に使えるか)を**1回だけ**読む。
/// 価格は別(古くなるので refreshPrices で読み直す)。
export async function ensureReserves(chain, rpcChain, pool) {
  const existing = markets.get(chain);
  if (existing && existing.reserves.size > 0) return existing;
  // **同時に呼ばれても読み込みは1回だけ。** 二重に読むと表が分かれて価格が迷子になる。
  const inFlight = loadingMarket.get(chain);
  if (inFlight) return inFlight;
  const promise = loadReservesOnce(chain, rpcChain, pool).finally(() => loadingMarket.delete(chain));
  loadingMarket.set(chain, promise);
  return promise;
}

async function loadReservesOnce(chain, rpcChain, pool) {
  const { oracle, dataProvider } = await resolveAddresses(chain, rpcChain, pool);
  if (!oracle || !dataProvider) {
    console.warn(`[清算/計画] ${chain}: オラクルかデータプロバイダを辿れません。計画は立てられません`);
    return null;
  }

  const listRaw = await callWithRpc(rpcChain, (p) =>
    p.call({ to: pool, data: POOL_IFACE.encodeFunctionData("getReservesList", []) }), true);
  const list = POOL_IFACE.decodeFunctionResult("getReservesList", listRaw)[0].map((a) => a.toLowerCase());

  const calls = [];
  for (const asset of list) {
    const a = ethers.getAddress(asset);
    calls.push({ target: dataProvider, allowFailure: true, callData: DATA_IFACE.encodeFunctionData("getReserveConfigurationData", [a]) });
    calls.push({ target: dataProvider, allowFailure: true, callData: DATA_IFACE.encodeFunctionData("getLiquidationProtocolFee", [a]) });
    calls.push({ target: a, allowFailure: true, callData: ERC20_IFACE.encodeFunctionData("symbol", []) });
  }
  const returned = await multicall(rpcChain, calls, true);

  const reserves = new Map();
  for (let i = 0; i < list.length; i++) {
    const asset = list[i];
    const [rc, rf, rs] = [returned[i * 3], returned[i * 3 + 1], returned[i * 3 + 2]];
    const info = { symbol: short(asset), decimals: 18, bonusBps: 0, protocolFeeBps: 0, collateralEnabled: false, active: false, frozen: false, price: 0n };
    try {
      if (rc?.success) {
        const d = DATA_IFACE.decodeFunctionResult("getReserveConfigurationData", rc.returnData);
        info.decimals = Number(d[0]);
        // liquidationBonus は 10500 = 5% の形。**ボーナスだけ**を bps にする。
        info.bonusBps = Math.max(0, Number(d[3]) - 10000);
        info.collateralEnabled = Boolean(d[5]);
        info.active = Boolean(d[8]);
        info.frozen = Boolean(d[9]);
      }
      if (rf?.success) info.protocolFeeBps = Number(DATA_IFACE.decodeFunctionResult("getLiquidationProtocolFee", rf.returnData)[0]);
      if (rs?.success) { try { info.symbol = ERC20_IFACE.decodeFunctionResult("symbol", rs.returnData)[0]; } catch (e) {} }
    } catch (e) {}
    reserves.set(asset, info);
  }

  const m = { oracle, dataProvider, pool, rpcChain, list, reserves, pricedAt: 0 };
  markets.set(chain, m);
  const withBonus = list.filter((a) => reserves.get(a).bonusBps > 0).length;
  console.log(`[清算/計画] ${chain}: 資産${list.length}種(担保になるもの${withBonus}種)を読みました`);
  return m;
}

/// Aave 自身のオラクルで価格を読み直す(清算の判定に使われているのと同じ価格)。
export async function refreshPrices(chain, force = false) {
  const m = markets.get(chain);
  if (!m || m.list.length === 0) return false;
  if (!force && Date.now() - m.pricedAt < PRICE_MAX_AGE_MS) return true;
  // **こちらも同時に呼ばれる。** 15人ぶん同時に価格を読むとRPCを15回使う。
  const inFlight = loadingPrices.get(chain);
  if (inFlight) return inFlight;
  const promise = fetchPrices(m, chain).finally(() => loadingPrices.delete(chain));
  loadingPrices.set(chain, promise);
  return promise;
}

async function fetchPrices(m, chain) {
  try {
    const raw = await callWithRpc(m.rpcChain, (p) => p.call({
      to: m.oracle,
      data: ORACLE_IFACE.encodeFunctionData("getAssetsPrices", [m.list.map((a) => ethers.getAddress(a))]),
    }), true);
    const prices = ORACLE_IFACE.decodeFunctionResult("getAssetsPrices", raw)[0];
    m.list.forEach((a, i) => { const r = m.reserves.get(a); if (r) r.price = prices[i]; });
    m.pricedAt = Date.now();
    return true;
  } catch (e) {
    console.warn(`[清算/計画] ${chain}: 価格を読めません(${(e.message || "").slice(0, 60)})`);
    return false;
  }
}

/// 1人の内訳(どの資産をいくら借りて、いくら担保に入れているか)を読む。
async function loadBreakdown(chain, user) {
  const m = markets.get(chain);
  if (!m || m.list.length === 0) return null;
  const calls = m.list.map((asset) => ({
    target: m.dataProvider, allowFailure: true,
    callData: DATA_IFACE.encodeFunctionData("getUserReserveData", [ethers.getAddress(asset), ethers.getAddress(user)]),
  }));
  const returned = await multicall(m.rpcChain, calls, true);
  const items = [];
  m.list.forEach((asset, i) => {
    const r = returned[i];
    if (!r?.success || r.returnData === "0x") return;
    try {
      const d = DATA_IFACE.decodeFunctionResult("getUserReserveData", r.returnData);
      const aToken = d[0], debt = d[1] + d[2];
      if (aToken > 0n || debt > 0n) items.push({ asset, aToken, debt, collateralEnabled: Boolean(d[8]) });
    } catch (e) {}
  });
  return items;
}

function amountToUsd(m, asset, amount) {
  const r = m.reserves.get(asset);
  if (!r || r.price === 0n) return 0;
  return Number((amount * r.price) / (10n ** BigInt(r.decimals))) / 1e8;
}

/// 清算する組を決める。
/// 借金は最大の1種、担保は(有効で、借金と別の)最大の1種。
/// debtToCover は Aave v3.3 の規則で「上限ぴったり」にする。
///
/// **計算の中身は liquidation-monitor.js の planLiquidation と同じ。**
/// あちらで本番に通っている式なので、写す時に1行も変えていない。
function decidePlan(chain, m, user, hf, items) {
  if (!items || items.length === 0) return { error: "内訳なし" };
  const sym = (a) => m.reserves.get(a)?.symbol || short(a);
  const debts = items.filter((it) => it.debt > 0n)
    .map((it) => ({ ...it, usd: amountToUsd(m, it.asset, it.debt) })).sort((x, y) => y.usd - x.usd);
  const colls = items.filter((it) => it.aToken > 0n && it.collateralEnabled && m.reserves.get(it.asset)?.collateralEnabled)
    .map((it) => ({ ...it, usd: amountToUsd(m, it.asset, it.aToken) })).sort((x, y) => y.usd - x.usd);
  if (debts.length === 0) return { error: "借金なし" };
  const debt = debts[0];
  const coll = colls.find((c) => c.asset !== debt.asset);
  if (!coll) return { error: `担保なし(借金${sym(debt.asset)}と同じ通貨の担保しか無い)` };
  const rd = m.reserves.get(debt.asset), rc = m.reserves.get(coll.asset);
  if (!rd || !rc || rd.price === 0n || rc.price === 0n) return { error: "価格が無い" };

  // 一度に返せる割合(v3.3): HF<0.95、または借金か担保がその通貨で$2,000未満なら100%。
  const debtBase = BigInt(Math.round(debt.usd * 1e8));
  const collBase = BigInt(Math.round(coll.usd * 1e8));
  const full = hf < CLOSE_FACTOR_HF || debtBase < MIN_BASE_MAX_CLOSE_FACTOR_THRESHOLD || collBase < MIN_BASE_MAX_CLOSE_FACTOR_THRESHOLD;
  let cover = full ? debt.debt : debt.debt / 2n;
  let why = full ? "100%" : "50%";

  // 担保で払える上限: 担保の価値 ÷ (1 + ボーナス)。超える分は Aave が削る。
  const bonusBps = BigInt(rc.bonusBps);
  const collValueBase = (coll.aToken * rc.price) / (10n ** BigInt(rc.decimals));
  const maxDebtBase = (collValueBase * 10000n) / (10000n + bonusBps);
  const coverBase = (cover * rd.price) / (10n ** BigInt(rd.decimals));
  if (coverBase > maxDebtBase) {
    cover = (maxDebtBase * (10n ** BigInt(rd.decimals))) / rd.price;
    why += "→担保で頭打ち";
  }
  // うちの上限額。
  const capBase = BigInt(Math.round(MAX_DEBT_USD * 1e8));
  let coverBaseNow = (cover * rd.price) / (10n ** BigInt(rd.decimals));
  if (coverBaseNow > capBase) {
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
  // 見込みの粗利: ボーナスからプロトコルの取り分を引く。フラッシュローン料も引く。
  const netBonus = (rc.bonusBps / 10000) * (1 - rc.protocolFeeBps / 10000);
  const grossUsd = coverUsd * netBonus - coverUsd * FLASH_FEE;
  return {
    chain, rpcChain: m.rpcChain, pool: m.pool,
    user, debtAsset: debt.asset, collateralAsset: coll.asset, debtToCover: cover,
    debtSymbol: sym(debt.asset), collateralSymbol: sym(coll.asset),
    coverUsd, debtUsd: debt.usd, collateralUsd: coll.usd,
    bonusBps: rc.bonusBps, protocolFeeBps: rc.protocolFeeBps,
    grossUsd, why, hf: Number(hf) / 1e18,
  };
}

/// **清算できる人ひとりぶんの計画を作る。** 読み取りのみ・送信しない。
/// @param chain    市場の鍵(既定の市場ならチェーン名)
/// @param rpcChain RPCを投げる実際のチェーン名
/// @param pool     Aave V3 Pool の住所
/// @param user     借り手
/// @param hf       健全度(18桁の BigInt)
export async function buildPlan(chain, rpcChain, pool, user, hf) {
  try {
    const m = await ensureReserves(chain, rpcChain, pool);
    if (!m) return { error: "資産を読めていない" };
    await refreshPrices(chain);
    const items = await loadBreakdown(chain, user);
    return decidePlan(chain, m, user, hf, items);
  } catch (e) {
    return { error: (e.message || "").slice(0, 100) };
  }
}

/// 実行側が担保と借金の情報を引くため。
export function getReserveInfo(chain, asset) {
  return markets.get(chain)?.reserves.get((asset || "").toLowerCase()) || null;
}

/// 計画を人が読める1行にする。
export function formatPlan(p) {
  if (!p || p.error) return `計画できず(${p?.error || "不明"})`;
  return `${p.debtSymbol}の借金$${p.debtUsd.toFixed(2)} を 担保${p.collateralSymbol}$${p.collateralUsd.toFixed(2)} で`
    + ` 肩代わり$${p.coverUsd.toFixed(2)}(${p.why})`
    + ` → ボーナス${(p.bonusBps / 100).toFixed(1)}%・手数料引後の粗利**$${p.grossUsd.toFixed(2)}**`;
}
