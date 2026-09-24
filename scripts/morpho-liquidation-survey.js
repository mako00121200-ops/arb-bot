// Morpho Blue の**過去の清算**を実測する(読み取りのみ・送信しない・お金は動かない)。
//
// [なぜ(2026年9月23日、オーナーの了承「順番に進めてください」)]
// 清算は「誰でも参加できる」「報酬(LIF)が決まっている」ので、UniswapX のような
// 審査制の場より入りやすい。ただし **件数・大きさ・競争の激しさ** が分からないまま
// 清算用コントラクトを作ると、また「作ったが稼げない」を繰り返す。先に数字で決める。
//
// 使い方: RUN_MORPHO_SURVEY=base,arbitrum (日数は MORPHO_SURVEY_DAYS、既定 90)
// 終わったら RUN_MORPHO_SURVEY を空に戻すこと。
// 起動を待たせないよう、裏で1回だけ走る(裁定の処理には触れない)。
//
// [限界] 価格は**今の**DexScreener の値で換算する(過去の値ではない)。
// 報酬は価格に左右されにくい「返済額 × (LIF−1)」を主に使う。
// PreLiquidation(事前清算)の契約経由の分は Liquidate イベントが出ないので数に入らない。

import { ethers } from "ethers";
import fs from "fs";
import { callWithRpc } from "./onchain-reserves.js";
import { weiToUsd } from "./gas-cost.js";
import { stateFilePath } from "./state-file.js";

/// 住所と配備ブロック: morpho-org/sdks packages/morpho-ts/src/addresses.ts
const MORPHO = {
  // Ethereum 本体(2026年9月24日、オーナーの指示「難しい担保の清算の調査」)。
  // 住所は他チェーンの base と同じ 0xBBBB…(CREATE2)。配備ブロックは morpho-org/sdks の addresses.ts の値。
  // RPC は chain-config に無いので ETHEREUM_RPC_URL を直接使う(下の rpc())。
  ethereum: { address: "0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb", startBlock: 18883124 },
  base: { address: "0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb", startBlock: 13977148 },
  arbitrum: { address: "0x6c247b1F6182318877311737BaC0844bAa518F5e", startBlock: 296446593 },
  optimism: { address: "0xce95AfbB8EA029495c66020883F87aaE8864AF92", startBlock: 130770075 },
  polygon: { address: "0x1bF0c2541F820E775182832f06c0B7Fc27A25f67", startBlock: 66931042 },
};

/// morpho-blue EventsLib.sol / Morpho.sol
const IFACE = new ethers.Interface([
  "event Liquidate(bytes32 indexed id, address indexed caller, address indexed borrower, uint256 repaidAssets, uint256 repaidShares, uint256 seizedAssets, uint256 badDebtAssets, uint256 badDebtShares)",
  "function idToMarketParams(bytes32 id) view returns (address loanToken, address collateralToken, address oracle, address irm, uint256 lltv)",
  "function position(bytes32 id, address user) view returns (uint256 supplyShares, uint128 borrowShares, uint128 collateral)",
  "function market(bytes32 id) view returns (uint128 totalSupplyAssets, uint128 totalSupplyShares, uint128 totalBorrowAssets, uint128 totalBorrowShares, uint128 lastUpdate, uint128 fee)",
]);
const ORACLE = new ethers.Interface(["function price() view returns (uint256)"]);
const ERC20 = new ethers.Interface([
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
]);
const LIQUIDATE_TOPIC = IFACE.getEvent("Liquidate").topicHash;

const CHUNK_START = 100_000;
const CHUNK_MIN = 1_000;
const CHUNK_MAX = 5_000_000;
const PAUSE_MS = 150;       // 裁定の RPC を圧迫しないよう、1回ごとに少し待つ
const MAX_REQUESTS = 4_000; // 暴走止め
const RECEIPT_SAMPLES = 30; // ガス代を実測する件数(大きい順)
// 「清算できるようになってから何ブロック放置されたか」を測る件数(大きい順)。
// 過去のブロックの状態を読むので、アーカイブに対応した RPC が要る(無ければ測らずに理由を出す)。
const LAG_SAMPLES = parseInt(process.env.MORPHO_SURVEY_LAG_SAMPLES || "80", 10);
const LAG_MAX_BLOCKS = 50_000; // これより前まで遡らない(Ethereum 本体で約1週間)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Ethereum 本体だけは chain-config の外なので、ETHEREUM_RPC_URL の接続を自前で持つ。
// **URL はログに出さない。**
let ethProvider = null;
function ethereumProvider() {
  if (ethProvider) return ethProvider;
  const url = (process.env.ETHEREUM_RPC_URL || "").trim();
  if (!url) throw new Error("ETHEREUM_RPC_URL が未設定");
  ethProvider = new ethers.JsonRpcProvider(url, 1, { staticNetwork: true, batchMaxCount: 1 });
  return ethProvider;
}
/// チェーンに合わせて RPC を呼ぶ。ethereum は自前の接続(一時的な失敗は2回まで取り直す)、他は既存の仕組み。
export async function rpc(chain, fn) {
  if (chain !== "ethereum") return callWithRpc(chain, fn);
  let last;
  for (let i = 0; i < 3; i++) {
    try { return await fn(ethereumProvider()); } catch (e) {
      last = e;
      if (isRangeRefusal(e.message || "") || /revert|execution reverted|CALL_EXCEPTION/i.test(e.message || "")) throw e;
      await sleep(500 * (i + 1));
    }
  }
  throw last;
}
/// ガス代(wei)をドルに。ETH の値段はどのチェーンでも同じなので、ethereum は base の値段を借りる。
const gasWeiToUsd = (chain, wei) => weiToUsd(chain === "ethereum" ? "base" : chain, wei);

export function morphoSurveyChains() {
  const raw = (process.env.RUN_MORPHO_SURVEY || "").trim();
  if (!raw || raw === "false") return [];
  return raw.split(",").map((s) => s.trim().toLowerCase()).filter((c) => MORPHO[c]);
}

/// Morpho の清算報酬の倍率。LIF = min(1.15, 1 / (0.3×LLTV + 0.7))
export function liquidationIncentiveFactor(lltv) {
  return Math.min(1.15, 1 / (0.3 * lltv + 0.7));
}

/// 返済額(ドル)の大きさ別に数える。
export function sizeBucket(usd) {
  if (usd == null) return "価格不明";
  if (usd >= 10_000) return "$1万以上";
  if (usd >= 1_000) return "$1千〜1万";
  if (usd >= 100) return "$100〜1千";
  if (usd >= 10) return "$10〜100";
  return "$10未満";
}

function isRangeRefusal(msg) {
  const m = msg.toLowerCase();
  return m.includes("range") || m.includes("limit") || m.includes("too many")
    || m.includes("exceed") || m.includes("too large") || m.includes("response size")
    || m.includes("-32005") || m.includes("query timeout") || m.includes("timeout");
}

async function blockTime(chain, n) {
  const b = await rpc(chain, (p) => p.getBlock(n));
  return b ? Number(b.timestamp) : null;
}

/// 指定日数ぶん遡った開始ブロックを、実際のブロック時刻から見積もる。
async function fromBlockForDays(chain, latest, days) {
  const probe = Math.max(MORPHO[chain].startBlock, latest - 200_000);
  const [tLatest, tProbe] = await Promise.all([blockTime(chain, latest), blockTime(chain, probe)]);
  const secPerBlock = (tLatest && tProbe && latest > probe) ? (tLatest - tProbe) / (latest - probe) : 2;
  const back = Math.floor((days * 86400) / Math.max(secPerBlock, 0.05));
  return { from: Math.max(MORPHO[chain].startBlock, latest - back), secPerBlock, tLatest };
}

async function readLogs(chain, from, to) {
  const out = [];
  let chunk = CHUNK_START;
  let cursor = from;
  let requests = 0;
  let refusals = 0;
  while (cursor <= to && requests < MAX_REQUESTS) {
    const end = Math.min(to, cursor + chunk - 1);
    requests++;
    try {
      const logs = await rpc(chain, (p) => p.send("eth_getLogs", [{
        address: MORPHO[chain].address,
        topics: [LIQUIDATE_TOPIC],
        fromBlock: "0x" + cursor.toString(16),
        toBlock: "0x" + end.toString(16),
      }]));
      out.push(...(logs || []));
      if (end - cursor + 1 >= chunk) chunk = Math.min(CHUNK_MAX, chunk * 2);
      cursor = end + 1;
    } catch (e) {
      const msg = e.message || "";
      refusals++;
      if (!isRangeRefusal(msg) && chunk <= CHUNK_MIN) {
        console.warn(`[Morpho調査] ${chain}: 読めない区間を飛ばす ${cursor}〜${end}: ${msg.slice(0, 80)}`);
        cursor = end + 1;
      }
      chunk = Math.max(CHUNK_MIN, Math.floor(chunk / 2));
    }
    await sleep(PAUSE_MS);
  }
  return { logs: out, requests, refusals, reachedBlock: cursor - 1 };
}

export async function readMarket(chain, id) {
  const r = await rpc(chain, (p) => p.call({ to: MORPHO[chain].address, data: IFACE.encodeFunctionData("idToMarketParams", [id]) }));
  const [loanToken, collateralToken, oracle, irm, lltv] = IFACE.decodeFunctionResult("idToMarketParams", r);
  return { loanToken, collateralToken, oracle, irm, lltv: Number(lltv) / 1e18, lltvWad: BigInt(lltv) };
}

const tokenInfoCache = new Map();
export async function readToken(chain, token) {
  const key = `${chain}:${token.toLowerCase()}`;
  if (tokenInfoCache.has(key)) return tokenInfoCache.get(key);
  let symbol = token.slice(0, 8);
  let decimals = 18;
  try {
    const s = await rpc(chain, (p) => p.call({ to: token, data: ERC20.encodeFunctionData("symbol") }));
    symbol = ERC20.decodeFunctionResult("symbol", s)[0];
  } catch (e) {}
  try {
    const d = await rpc(chain, (p) => p.call({ to: token, data: ERC20.encodeFunctionData("decimals") }));
    decimals = Number(ERC20.decodeFunctionResult("decimals", d)[0]);
  } catch (e) {}
  const info = { symbol, decimals, priceUsd: await dexPriceUsd(chain, token) };
  tokenInfoCache.set(key, info);
  return info;
}

async function dexPriceUsd(chain, token) {
  try {
    const res = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${token}`);
    if (!res.ok) return null;
    const json = await res.json();
    const pairs = (json.pairs || []).filter((p) => (p.chainId || "").toLowerCase() === chain
      && (p.baseToken?.address || "").toLowerCase() === token.toLowerCase());
    pairs.sort((a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0));
    const price = parseFloat(pairs[0]?.priceUsd);
    return isFinite(price) && price > 0 ? price : null;
  } catch (e) {
    return null;
  } finally {
    await sleep(250); // DexScreener の回数制限よけ
  }
}

/// 担保の種類分け(**知識で勝てる担保か**を見るため)。上から順に当てはめる。
/// PT(Pendle)・Ethena・LRT は、売り方(満期・引き出し待ち・薄い流動性)を知らないと現金に戻せない担保。
export function collateralCategory(symbol) {
  const s = String(symbol || "");
  if (/^PT-/i.test(s)) return "PT(Pendle)";
  if (/USDe/i.test(s)) return "Ethena系";
  if (/(weETH|ezETH|rsETH|pufETH|rswETH|rstETH|eETH|agETH|pzETH|mETH|osETH|ETHx|LBTC|eBTC|uniBTC|solvBTC|pumpBTC)/i.test(s)) return "LRT/再ステーク";
  if (/(wstETH|stETH|rETH|cbETH|sfrxETH|OETH)/i.test(s)) return "LST";
  if (/^(WETH|WBTC|cbBTC|tBTC|ETH|BTC)$/i.test(s)) return "主要";
  if (/(USD|DAI|FRAX|GHO|EUR)/i.test(s)) return "ステーブル系";
  return "その他";
}

/// 過去のあるブロックの時点で、その借り手が清算できたか(Morpho の式: 借金 > 担保×価格×LLTV)。
/// 読めなければ例外(アーカイブ非対応など)。
async function liquidatableAt(chain, id, borrower, mk, block) {
  const tag = "0x" + block.toString(16);
  const [pr, mr, or] = await Promise.all([
    rpc(chain, (p) => p.call({ to: MORPHO[chain].address, data: IFACE.encodeFunctionData("position", [id, borrower]), blockTag: tag })),
    rpc(chain, (p) => p.call({ to: MORPHO[chain].address, data: IFACE.encodeFunctionData("market", [id]), blockTag: tag })),
    rpc(chain, (p) => p.call({ to: mk.m.oracle, data: ORACLE.encodeFunctionData("price"), blockTag: tag })),
  ]);
  const pos = IFACE.decodeFunctionResult("position", pr);
  const mkt = IFACE.decodeFunctionResult("market", mr);
  const price = BigInt(ORACLE.decodeFunctionResult("price", or)[0]);
  const borrowShares = BigInt(pos.borrowShares);
  if (borrowShares === 0n) return false;
  const tBA = BigInt(mkt.totalBorrowAssets), tBS = BigInt(mkt.totalBorrowShares);
  const borrowed = tBS > 0n ? (borrowShares * tBA + tBS - 1n) / tBS : 0n;
  const maxBorrow = (((BigInt(pos.collateral) * price) / 10n ** 36n) * mk.m.lltvWad) / 10n ** 18n;
  return borrowed > maxBorrow;
}

/// 清算された時点から遡って、**清算できる状態が何ブロック続いていたか**を測る。
/// 0 = 清算の直前のブロックではまだ健全(同じブロックの中で値段が動き、即座に取られた=速さ・入札の勝負)。
/// 大きい = 誰も取らずに放置されていた(=売り方の知識で勝てる余地)。
export async function measureLag(chain, row, mk, at = (b) => liquidatableAt(chain, row.id, row.borrower, mk, b), pauseMs = PAUSE_MS) {
  const B = row.blockNumber;
  if (!(await at(B - 1))) return 0;
  // 倍々に遡って健全だったブロックを見つけ、その間を二分探索する
  let good = null, bad = B - 1, step = 1;
  while (true) {
    const b = B - 1 - step;
    if (!(await at(b))) { good = b; break; }
    bad = b;
    if (step >= LAG_MAX_BLOCKS) break;
    step = Math.min(step * 2, LAG_MAX_BLOCKS);
    await sleep(pauseMs);
  }
  if (good == null) return LAG_MAX_BLOCKS; // 上限まで遡っても清算できる状態のまま
  while (bad - good > 1) {
    const mid = Math.floor((good + bad) / 2);
    if (await at(mid)) bad = mid; else good = mid;
    await sleep(pauseMs);
  }
  return B - bad; // 清算できるようになったブロックから、清算されたブロックまで
}

/// 放置の長さの区分け。
export function lagBucket(lag) {
  if (lag == null) return "不明";
  if (lag === 0) return "同じブロック";
  if (lag <= 2) return "1〜2ブロック";
  if (lag <= 25) return "3〜25ブロック";
  return "26ブロック以上";
}

export function short(a) { return a ? `${a.slice(0, 6)}…${a.slice(-4)}` : "?"; }
function median(xs) {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}
export const usd = (v) => (v == null ? "?" : `$${v >= 100 ? Math.round(v).toLocaleString() : v.toFixed(2)}`);

/// 1件の清算を、ドル換算して行にする(テストしやすいよう純粋関数)。
export function toRow({ id, caller, borrower, repaidAssets, seizedAssets, badDebtAssets, blockNumber, txHash }, market, loan, coll) {
  const repaid = Number(repaidAssets) / 10 ** loan.decimals;
  const seized = Number(seizedAssets) / 10 ** coll.decimals;
  const badDebt = Number(badDebtAssets) / 10 ** loan.decimals;
  const lif = liquidationIncentiveFactor(market.lltv);
  const repaidUsd = loan.priceUsd != null ? repaid * loan.priceUsd : null;
  const seizedUsd = coll.priceUsd != null ? seized * coll.priceUsd : null;
  return {
    id, caller, borrower, blockNumber, txHash,
    pair: `${coll.symbol}/${loan.symbol}`, lltv: market.lltv, lif,
    repaidUsd, seizedUsd,
    // 報酬の主な見積もり: 返済額 × (LIF−1)。今の価格の揺れに左右されにくい
    bonusUsd: repaidUsd != null ? repaidUsd * (lif - 1) : null,
    // 参考: 受け取った担保 − 返した額(今の価格で換算。ずれる)
    bonusBySeizedUsd: repaidUsd != null && seizedUsd != null ? seizedUsd - repaidUsd : null,
    badDebtUsd: loan.priceUsd != null ? badDebt * loan.priceUsd : null,
  };
}

async function surveyChain(chain, days) {
  const t0 = Date.now();
  let meta_lag = {};
  const latest = await rpc(chain, (p) => p.getBlockNumber());
  const { from, secPerBlock, tLatest } = await fromBlockForDays(chain, latest, days);
  const actualDays = ((latest - from) * secPerBlock) / 86400;
  console.log(`[Morpho調査] ${chain}: ブロック ${from.toLocaleString()}〜${latest.toLocaleString()}(約${actualDays.toFixed(1)}日)を読みます`);

  const { logs, requests, refusals, reachedBlock } = await readLogs(chain, from, latest);
  const readDays = ((reachedBlock - from) * secPerBlock) / 86400;

  const markets = new Map();
  const rows = [];
  for (const log of logs) {
    let ev;
    try { ev = IFACE.parseLog(log); } catch (e) { continue; }
    const id = ev.args.id;
    if (!markets.has(id)) {
      try {
        const m = await readMarket(chain, id);
        const [loan, coll] = [await readToken(chain, m.loanToken), await readToken(chain, m.collateralToken)];
        markets.set(id, { m, loan, coll });
      } catch (e) {
        markets.set(id, null);
      }
    }
    const mk = markets.get(id);
    if (!mk) continue;
    rows.push(toRow({
      id, caller: ev.args.caller, borrower: ev.args.borrower,
      repaidAssets: ev.args.repaidAssets, seizedAssets: ev.args.seizedAssets, badDebtAssets: ev.args.badDebtAssets,
      blockNumber: Number(log.blockNumber), txHash: log.transactionHash,
    }, mk.m, mk.loan, mk.coll));
  }

  // 大きい順に、勝者が実際に払ったガス代を測る
  const bySize = [...rows].sort((a, b) => (b.repaidUsd ?? 0) - (a.repaidUsd ?? 0));
  for (const r of bySize.slice(0, RECEIPT_SAMPLES)) {
    try {
      // 生の受領書を読む(OP Stack の L1 手数料 l1Fee は ethers の整形で落ちるため)
      const rc = await rpc(chain, (p) => p.send("eth_getTransactionReceipt", [r.txHash]));
      if (!rc) continue;
      const wei = BigInt(rc.gasUsed) * BigInt(rc.effectiveGasPrice ?? "0x0") + BigInt(rc.l1Fee ?? "0x0");
      r.gasUsd = await gasWeiToUsd(chain, wei);
      r.gasUsed = Number(BigInt(rc.gasUsed));
      r.txTo = rc.to;
      r.txIndex = Number(BigInt(rc.transactionIndex));
    } catch (e) {}
    await sleep(PAUSE_MS);
  }

  // 担保の種類
  for (const r of rows) r.category = collateralCategory(r.pair.split("/")[0]);

  // 放置の長さ(大きい順)。最初の数件で過去の状態が読めなければ、アーカイブ非対応として打ち切る
  let lagErrors = 0, lagDone = 0, lagNote = "";
  for (const r of bySize.filter((x) => x.repaidUsd != null).slice(0, LAG_SAMPLES)) {
    const mk = markets.get(r.id);
    if (!mk) continue;
    try {
      r.lagBlocks = await measureLag(chain, r, mk);
      lagDone++;
    } catch (e) {
      lagErrors++;
      if (lagDone === 0 && lagErrors >= 3) { lagNote = `過去の状態を読めません(アーカイブ非対応の可能性): ${(e.shortMessage || e.message || "").slice(0, 80)}`; break; }
    }
  }
  meta_lag = { lagDone, lagErrors, lagNote };

  try {
    const file = stateFilePath(`morpho-liquidations-${chain}.jsonl`);
    fs.writeFileSync(file, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
  } catch (e) {}

  report(chain, rows, { ...meta_lag, readDays, requests, refusals, markets: markets.size, sec: (Date.now() - t0) / 1000, reachedBlock, latest, secPerBlock });
}

function report(chain, rows, meta) {
  const P = `[Morpho調査] ${chain}:`;
  const days = Math.max(meta.readDays, 0.01);
  const done = meta.reachedBlock >= meta.latest ? "" : `(途中まで: ブロック${meta.reachedBlock.toLocaleString()})`;
  const bonusSum = rows.reduce((s, r) => s + (r.bonusUsd ?? 0), 0);
  const badDebtSum = rows.reduce((s, r) => s + (r.badDebtUsd ?? 0), 0);
  const repaidSum = rows.reduce((s, r) => s + (r.repaidUsd ?? 0), 0);
  console.log(`${P} ${days.toFixed(1)}日で清算 ${rows.length}件(1日あたり${(rows.length / days).toFixed(1)}件)${done}。`
    + `返済合計 ${usd(repaidSum)}、報酬合計(返済×(LIF−1)) ${usd(bonusSum)}(1日あたり${usd(bonusSum / days)})、`
    + `貸し倒れ ${usd(badDebtSum)}。市場${meta.markets}個、RPC ${meta.requests}回(断られ${meta.refusals})、${meta.sec.toFixed(0)}秒`);

  // 大きさ別
  const buckets = new Map();
  for (const r of rows) {
    const b = sizeBucket(r.repaidUsd);
    const e = buckets.get(b) || { n: 0, bonus: 0 };
    e.n++; e.bonus += r.bonusUsd ?? 0;
    buckets.set(b, e);
  }
  const order = ["$1万以上", "$1千〜1万", "$100〜1千", "$10〜100", "$10未満", "価格不明"];
  console.log(`${P} 大きさ別(返済額) ` + order.filter((b) => buckets.has(b))
    .map((b) => `${b} ${buckets.get(b).n}件/報酬${usd(buckets.get(b).bonus)}`).join("、"));

  // 清算した人(caller)の偏り
  const callers = new Map();
  for (const r of rows) {
    const e = callers.get(r.caller) || { n: 0, bonus: 0, markets: new Set() };
    e.n++; e.bonus += r.bonusUsd ?? 0; e.markets.add(r.id);
    callers.set(r.caller, e);
  }
  const topCallers = [...callers.entries()].sort((a, b) => b[1].bonus - a[1].bonus);
  const top1Share = bonusSum > 0 && topCallers[0] ? topCallers[0][1].bonus / bonusSum : 0;
  console.log(`${P} 清算者 ${callers.size}人。報酬の上位: ` + topCallers.slice(0, 6)
    .map(([a, e]) => `${short(a)} ${e.n}件/${usd(e.bonus)}(${bonusSum > 0 ? Math.round((e.bonus / bonusSum) * 100) : 0}%)`).join("、")
    + `。1位の占有 ${Math.round(top1Share * 100)}%`);

  // 市場別(報酬の多い順)。清算者が少ない市場 = 競争が薄い候補
  const perMarket = new Map();
  for (const r of rows) {
    const e = perMarket.get(r.id) || { pair: r.pair, lltv: r.lltv, lif: r.lif, n: 0, bonus: 0, callers: new Set(), maxRepaid: 0 };
    e.n++; e.bonus += r.bonusUsd ?? 0; e.callers.add(r.caller); e.maxRepaid = Math.max(e.maxRepaid, r.repaidUsd ?? 0);
    perMarket.set(r.id, e);
  }
  const mk = [...perMarket.values()].sort((a, b) => b.bonus - a.bonus);
  console.log(`${P} 市場別(報酬の多い順) ` + mk.slice(0, 10)
    .map((e) => `${e.pair} LLTV${Math.round(e.lltv * 1000) / 10}% 報酬率${((e.lif - 1) * 100).toFixed(1)}% ${e.n}件/${usd(e.bonus)} 清算者${e.callers.size}人 最大${usd(e.maxRepaid)}`).join(" | "));

  // 日ごと(直近の偏りが分かるよう、件数の多い日と中央値)
  const perDay = new Map();
  for (const r of rows) {
    const d = Math.floor((r.blockNumber * meta.secPerBlock) / 86400); // 約1日の区切り(ブロック番号から換算)
    perDay.set(d, (perDay.get(d) || 0) + 1);
  }
  const counts = [...perDay.values()];
  console.log(`${P} 清算があった日 約${counts.length}日、1日の件数 中央値${median(counts) ?? 0}・最大${counts.length ? Math.max(...counts) : 0}(急落の日に集中するか)`);

  // 大きい清算の実際のガス代(勝者が払った額)
  // 大きい順に並べる(rows は時刻順なので、そのままだと「上位5」が小口になる)
  const sampled = rows.filter((r) => r.gasUsd != null).sort((a, b) => (b.repaidUsd ?? 0) - (a.repaidUsd ?? 0));
  if (sampled.length > 0) {
    const gas = sampled.map((r) => r.gasUsd);
    const net = sampled.filter((r) => r.bonusUsd != null).map((r) => r.bonusUsd - r.gasUsd);
    const txTos = new Map();
    for (const r of sampled) txTos.set(r.txTo, (txTos.get(r.txTo) || 0) + 1);
    const firstInBlock = sampled.filter((r) => r.txIndex != null && r.txIndex <= 2).length;
    console.log(`${P} 大きい順${sampled.length}件の勝者のガス代 中央値${usd(median(gas))}・最大${usd(Math.max(...gas))}、`
      + `報酬−ガス 中央値${usd(median(net))}。ブロックの先頭3番以内 ${firstInBlock}/${sampled.length}件(優先料金で競っている目安)。`
      + `送り先の契約 ${txTos.size}種`);
    console.log(`${P} 大きい清算 上位5: ` + sampled.slice(0, 5)
      .map((r) => `${r.pair} 返済${usd(r.repaidUsd)} 報酬${usd(r.bonusUsd)} ガス${usd(r.gasUsd)} 位置${r.txIndex} by ${short(r.caller)}`).join(" | "));
  }
  reportByCategory(P, rows, meta, meta.secPerBlock);
}

/// **担保の種類別**: 件数・報酬・清算者の数・1位の占有・放置の長さ。
/// 「難しい担保ほど清算者が少なく、放置が長い」なら、知識で勝てる場所がある。
export function reportByCategory(P, rows, meta, secPerBlock) {
  const cats = new Map();
  for (const r of rows) {
    const c = r.category || "その他";
    const e = cats.get(c) || { n: 0, bonus: 0, callers: new Map(), lags: [] };
    e.n++; e.bonus += r.bonusUsd ?? 0;
    e.callers.set(r.caller, (e.callers.get(r.caller) || 0) + (r.bonusUsd ?? 0));
    if (r.lagBlocks != null) e.lags.push(r.lagBlocks);
    cats.set(c, e);
  }
  const order = [...cats.entries()].sort((a, b) => b[1].bonus - a[1].bonus);
  for (const [c, e] of order) {
    const top = Math.max(0, ...e.callers.values());
    const lb = new Map();
    for (const l of e.lags) lb.set(lagBucket(l), (lb.get(lagBucket(l)) || 0) + 1);
    const lagLine = e.lags.length
      ? ` 放置[${["同じブロック", "1〜2ブロック", "3〜25ブロック", "26ブロック以上"].filter((k) => lb.has(k)).map((k) => `${k}${lb.get(k)}`).join(" ")} 中央${median(e.lags)}ブロック≒${Math.round((median(e.lags) * secPerBlock) / 60)}分](${e.lags.length}件測定)`
      : "";
    console.log(`${P} 担保の種類 ${c}: ${e.n}件 報酬${usd(e.bonus)} 清算者${e.callers.size}人 1位の占有${e.bonus > 0 ? Math.round((top / e.bonus) * 100) : 0}%${lagLine}`);
  }
  if (meta.lagNote) console.log(`${P} 放置の長さ: ${meta.lagNote}`);
  else if (meta.lagDone != null) console.log(`${P} 放置の長さ: 大きい順に${meta.lagDone}件を測定(失敗${meta.lagErrors})。`
    + `「同じブロック」は値段が動いたブロックの中で即座に取られた=速さと入札の勝負、「26ブロック以上」は誰も取らなかった=売り方を知っていれば取れた可能性`);
}

export async function runMorphoSurvey() {
  const chains = morphoSurveyChains();
  if (chains.length === 0) return;
  const days = Math.max(1, parseInt(process.env.MORPHO_SURVEY_DAYS || "90", 10) || 90);
  console.log(`[Morpho調査] 開始: ${chains.join(",")} 過去${days}日(読み取りのみ・送信しない)`);
  for (const chain of chains) {
    try {
      await surveyChain(chain, days);
    } catch (e) {
      console.error(`[Morpho調査] ${chain}: 失敗: ${(e.message || "").slice(0, 160)}`);
    }
  }
  console.log(`[Morpho調査] 終了。RUN_MORPHO_SURVEY を空に戻してください`);
}
