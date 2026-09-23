// scripts/real-totals-rebuild.js
//
// 画面の「累積利益(ガス控除後)」を、**チェーン上の記録から作り直す**(読み取りのみ・1回だけ)。
//
// [なぜ(2026年9月23日、オーナーの指摘「利益の総額が変わっている」)]
// 記録は直近500件しか残しておらず、累計をその500件から足し直していたので、
// 古い取引が捨てられるたびに総額が変わっていた。捨てた分はファイルにはもう無い。
// そこで、裁定コントラクトが成立のたびに出すイベント(版ごとに名前が違う。下の EVENT_SIGS)を
// 全チェーンから集め、実際に払ったガス代(receipt)を引いて、**一覧から消えた取引の分だけ**足す。
//
// [どの取引を数えるか]
// ・イベントの形で探す。住所は絞らない → 何度か再デプロイした**旧コントラクトの分も**拾える
// ・送り主が bot のウォレットの取引だけを数える(他人の同名イベントを混ぜない)
// ・成立した取引だけ(画面の累計と同じ定義)。取り消された送信のガス代は「送信の収支」の側で見る
//
// [値の決め方]
// ・一覧に残っている取引は**記録どおり**(当時の価格)
// ・一覧から消えた取引だけ、チェーンの値を**今の価格**でドルに直して足す(当時の値段は残っていない)
// ・両方にある取引で、記録と作り直しの差をログに出す(作り直しの精度の目安)
// ・読み切れないチェーンがある/価格不明/一覧の取引がチェーンで見つからない時は置き換えない
//
// 使い方: RUN_REBUILD_REAL_TOTALS=avalanche,polygon,optimism,base,arbitrum
//         (日数は REBUILD_SINCE_DAYS、既定 16 = 実取引の記録を始めた9月10日より前から)。終わったら空に戻す。

import { ethers } from "ethers";
import { callWithRpc } from "./onchain-reserves.js";
import { weiToUsd } from "./gas-cost.js";
import { loadRealExecutions, loadRealTotals, sumOfLog, adoptRebuiltTotals } from "./real-execution-log.js";

/// 成立のたびにコントラクトが出すイベント。**版ごとに名前が違う**(git の全履歴で確認):
///   RouteExecuted(address,uint256,uint256,uint8) … 今の版(9/20〜)と、その前の版
///   ArbExecuted / ArbitrageExecuted / TriArbExecuted(address,uint256,uint256) … それより前の版
/// どれも「1つ目の索引 = 利益の通貨、データの2語目 = 利益」の並びなので、同じ読み方で読める。
const EVENT_SIGS = [
  "RouteExecuted(address,uint256,uint256,uint8)",
  "ArbExecuted(address,uint256,uint256)",
  "ArbitrageExecuted(address,uint256,uint256)",
  "TriArbExecuted(address,uint256,uint256)",
];
const EVENT_TOPICS = EVENT_SIGS.map((sig) => ethers.id(sig));
const TOPIC_NAME = new Map(EVENT_TOPICS.map((t, i) => [t, EVENT_SIGS[i].split("(")[0]]));
const ERC20 = new ethers.Interface(["function symbol() view returns (string)", "function decimals() view returns (uint8)"]);
const STABLES = new Set(["USDC", "USDC.E", "USDBC", "USDT", "USDT0", "USDT.E", "DAI", "DAI.E", "USDCN"]);
const PAUSE_MS = 100;
/// polygon の RPC は1回に読めるブロック幅が狭い(断られたら幅を縮める)ので多めに取る
const MAX_REQUESTS_PER_CHAIN = 12000;
const MIN_CHUNK = 50;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function rebuildChains() {
  const raw = (process.env.RUN_REBUILD_REAL_TOTALS || "").trim();
  if (!raw || raw === "false") return [];
  return raw.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
}

async function fromBlockForDays(chain, latest, days) {
  const probe = Math.max(0, latest - 200_000);
  const [a, b] = await Promise.all([
    callWithRpc(chain, (p) => p.getBlock(latest)),
    callWithRpc(chain, (p) => p.getBlock(probe)),
  ]);
  const spb = a && b && latest > probe ? (Number(a.timestamp) - Number(b.timestamp)) / (latest - probe) : 2;
  return Math.max(0, latest - Math.floor((days * 86400) / Math.max(spb, 0.05)));
}

async function readRouteLogs(chain, from, to) {
  const out = [];
  let chunk = 50_000, cursor = from, requests = 0, ceiling = Infinity;
  while (cursor <= to && requests < MAX_REQUESTS_PER_CHAIN) {
    const end = Math.min(to, cursor + chunk - 1);
    requests++;
    try {
      const logs = await callWithRpc(chain, (p) => p.send("eth_getLogs", [{
        topics: [EVENT_TOPICS], fromBlock: "0x" + cursor.toString(16), toBlock: "0x" + end.toString(16),
      }]));
      out.push(...(logs || []));
      cursor = end + 1;
      chunk = Math.min(Math.floor(chunk * 1.5), ceiling, 2_000_000);
    } catch (e) {
      ceiling = Math.max(MIN_CHUNK, chunk - 1);
      if (chunk <= MIN_CHUNK) {
        // 最小幅でも読めない区間は飛ばさず、**読み切れなかった**として止める(黙って欠けさせない)
        return { logs: out, complete: false, requests, stoppedAt: cursor, error: (e.message || "").slice(0, 80) };
      }
      chunk = Math.max(MIN_CHUNK, Math.floor(chunk / 2));
    }
    await sleep(PAUSE_MS);
  }
  return { logs: out, complete: cursor > to, requests, stoppedAt: cursor };
}

const tokenCache = new Map();
async function tokenInfo(chain, token) {
  const key = `${chain}:${token.toLowerCase()}`;
  if (tokenCache.has(key)) return tokenCache.get(key);
  let symbol = token.slice(0, 8), decimals = 18, usd = null;
  try { symbol = ERC20.decodeFunctionResult("symbol", await callWithRpc(chain, (p) => p.call({ to: token, data: ERC20.encodeFunctionData("symbol") })))[0]; } catch (e) {}
  try { decimals = Number(ERC20.decodeFunctionResult("decimals", await callWithRpc(chain, (p) => p.call({ to: token, data: ERC20.encodeFunctionData("decimals") })))[0]); } catch (e) {}
  try {
    const res = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${token}`);
    if (res.ok) {
      const j = await res.json();
      const pairs = (j.pairs || []).filter((x) => (x.chainId || "").toLowerCase() === chain && (x.baseToken?.address || "").toLowerCase() === token.toLowerCase());
      pairs.sort((x, y) => (y.liquidity?.usd ?? 0) - (x.liquidity?.usd ?? 0));
      const v = parseFloat(pairs[0]?.priceUsd);
      if (isFinite(v) && v > 0) usd = v;
    }
  } catch (e) {}
  if (usd == null && STABLES.has(String(symbol).toUpperCase())) usd = 1;
  const info = { symbol, decimals, usd };
  tokenCache.set(key, info);
  await sleep(250);
  return info;
}

async function rebuildChain(chain, wallet, days) {
  const latest = await callWithRpc(chain, (p) => p.getBlockNumber());
  const from = await fromBlockForDays(chain, latest, days);
  const r = await readRouteLogs(chain, from, latest);
  const byTx = new Map();
  for (const log of r.logs) if (!byTx.has(log.transactionHash)) byTx.set(log.transactionHash, log);
  let count = 0, grossUsd = 0, gasUsd = 0, unpriced = 0, foreign = 0;
  const contracts = new Set();
  const txs = [];
  const byEvent = {};
  let first = null;
  for (const [hash, log] of byTx) {
    let rc;
    try { rc = await callWithRpc(chain, (p) => p.send("eth_getTransactionReceipt", [hash])); } catch (e) { continue; }
    if (!rc || (rc.from || "").toLowerCase() !== wallet.toLowerCase()) { foreign++; continue; }
    const asset = ethers.getAddress("0x" + log.topics[1].slice(26));
    const profitRaw = BigInt("0x" + log.data.slice(2 + 64, 2 + 128));
    const name = TOPIC_NAME.get(log.topics[0]) || "?";
    byEvent[name] = (byEvent[name] || 0) + 1;
    const tok = await tokenInfo(chain, asset);
    const profit = Number(profitRaw) / 10 ** tok.decimals;
    if (tok.usd == null) unpriced++;
    const g = tok.usd != null ? profit * tok.usd : 0;
    const wei = BigInt(rc.gasUsed) * BigInt(rc.effectiveGasPrice ?? "0x0") + BigInt(rc.l1Fee ?? "0x0");
    const gas = (await weiToUsd(chain, wei)) ?? 0;
    grossUsd += g;
    gasUsd += gas;
    txs.push({ hash: hash.toLowerCase(), grossUsd: g, gasUsd: gas, netUsd: g - gas });
    count++;
    contracts.add(log.address.toLowerCase());
    const bn = Number(BigInt(log.blockNumber));
    if (first == null || bn < first) first = bn;
    await sleep(40);
  }
  return { chain, count, grossUsd, gasUsd, netUsd: grossUsd - gasUsd, unpriced, foreign, contracts: contracts.size, complete: r.complete, requests: r.requests, error: r.error, from, latest, first, txs, byEvent };
}

export async function runRealTotalsRebuild() {
  const chains = rebuildChains();
  if (chains.length === 0) return;
  const key = process.env.MAINNET_BOT_PRIVATE_KEY;
  const wallet = process.env.MAINNET_BOT_ADDRESS || (key ? new ethers.Wallet(key).address : null);
  if (!wallet) { console.warn("[累計の作り直し] bot のウォレットが分からないので行いません"); return; }
  const days = Math.max(1, parseInt(process.env.REBUILD_SINCE_DAYS || "16", 10) || 16);
  const cutoffIso = new Date().toISOString();
  const before = loadRealTotals();
  const logSum = sumOfLog(loadRealExecutions());
  console.log(`[累計の作り直し] 開始: ${chains.join(",")} 過去${days}日(読み取りのみ)。今の画面の累計 ${before ? `${before.count}件 $${before.netUsd.toFixed(4)}(${before.source})` : `一覧から ${logSum.count}件 $${logSum.netUsd.toFixed(4)}`}`);
  const results = [];
  for (const c of chains) {
    try {
      const r = await rebuildChain(c, wallet, days);
      results.push(r);
      console.log(`[累計の作り直し] ${c}: 成立${r.count}件(コントラクト${r.contracts}個) 粗利$${r.grossUsd.toFixed(4)} − ガス$${r.gasUsd.toFixed(4)} = 純利$${r.netUsd.toFixed(4)}`
        + ` 種類[${Object.entries(r.byEvent).map(([k, v]) => `${k}:${v}`).join(" ")}]`
        + `${r.unpriced ? ` 価格不明${r.unpriced}件` : ""}${r.foreign ? ` 他人の取引${r.foreign}件(除外)` : ""} 最初のブロック${r.first ?? "-"}`
        + ` ${r.complete ? "読み切り" : `**途中まで**(${r.error || "上限"})`} RPC${r.requests}`);
    } catch (e) {
      console.error(`[累計の作り直し] ${c}: 失敗: ${(e.message || "").slice(0, 120)}`);
      results.push({ chain: c, failed: true });
    }
  }
  const incomplete = results.filter((r) => r.failed || !r.complete || r.unpriced > 0);
  const log = loadRealExecutions();
  const inLog = new Map(log.filter((e) => e.txHash).map((e) => [String(e.txHash).toLowerCase(), e]));
  // 突き合わせ: 両方にある取引で、記録(当時の価格)とチェーンからの作り直し(今の価格)がどれだけ違うか
  let overlapN = 0, overlapRecorded = 0, overlapRebuilt = 0;
  const missing = { count: 0, grossUsd: 0, gasUsd: 0, netUsd: 0 };
  for (const r of results.filter((x) => !x.failed)) {
    for (const t of r.txs) {
      const e = inLog.get(t.hash);
      if (e) {
        overlapN++;
        overlapRecorded += e.actualNetProfitUsd ?? ((e.actualProfitUsd || 0) - (e.actualGasCostUsd ?? e.gasCostUsd ?? 0));
        overlapRebuilt += t.netUsd;
      } else {
        missing.count++; missing.grossUsd += t.grossUsd; missing.gasUsd += t.gasUsd; missing.netUsd += t.netUsd;
      }
    }
  }
  const total = {
    count: logSum.count + missing.count,
    grossUsd: logSum.grossUsd + missing.grossUsd,
    gasUsd: logSum.gasUsd + missing.gasUsd,
    netUsd: logSum.netUsd + missing.netUsd,
  };
  console.log(`[累計の作り直し] 突き合わせ: 一覧に残っている${logSum.count}件のうちチェーンで見つかった${overlapN}件 — 記録の純利$${overlapRecorded.toFixed(4)} / 今の価格で作り直すと$${overlapRebuilt.toFixed(4)}`);
  console.log(`[累計の作り直し] 一覧から**消えていた取引 ${missing.count}件**: 粗利$${missing.grossUsd.toFixed(4)} − ガス$${missing.gasUsd.toFixed(4)} = 純利$${missing.netUsd.toFixed(4)}(今の価格で換算)`);
  console.log(`[累計の作り直し] 正しい累計 = 一覧の${logSum.count}件 $${logSum.netUsd.toFixed(4)}(当時の価格) + 消えていた${missing.count}件 $${missing.netUsd.toFixed(4)} = **${total.count}件 純利$${total.netUsd.toFixed(4)}**`);
  // 読み切れなかったチェーンがある時は採用しない(欠けた数字で上書きしない)
  if (incomplete.length > 0) {
    console.warn(`[累計の作り直し] ${incomplete.map((r) => r.chain).join(",")} が読み切れていない/価格不明のため、**画面の累計は置き換えません**`);
  } else if (overlapN < logSum.count * 0.9) {
    console.warn(`[累計の作り直し] 一覧の取引のうちチェーンで見つかったのが${overlapN}/${logSum.count}件しかないので、**置き換えません**(探し漏れがある)`);
  } else {
    const t = adoptRebuiltTotals(total, cutoffIso);
    console.log(`[累計の作り直し] 画面の累計を置き換えました: ${t.count}件 純利$${t.netUsd.toFixed(4)}。RUN_REBUILD_REAL_TOTALS を空に戻してください`);
  }
}
