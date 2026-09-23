// scripts/real-totals-rebuild.js
//
// 画面の「累積利益(ガス控除後)」を、**チェーン上の記録から作り直す**(読み取りのみ・1回だけ)。
//
// [なぜ(2026年9月23日、オーナーの指摘「利益の総額が変わっている」)]
// 記録は直近500件しか残しておらず、累計をその500件から足し直していたので、
// 古い取引が捨てられるたびに総額が変わっていた。捨てた分はファイルにはもう無い。
// そこで、裁定コントラクトが成立のたびに出す RouteExecuted(asset, amountIn, profit, legCount) を
// 全チェーンから集め、実際に払ったガス代(receipt)を引いて、累計を作り直す。
//
// [どの取引を数えるか]
// ・イベントの名前と形(RouteExecuted(address,uint256,uint256,uint8))で探す。住所は絞らない
//   → 何度か再デプロイした**旧コントラクトの分も**拾える
// ・送り主が bot のウォレットの取引だけを数える(他人の同名イベントを混ぜない)
// ・成立した取引だけ(画面の累計と同じ定義)。取り消された送信のガス代は「送信の収支」の側で見る
//
// [限界]
// 利益の通貨とガス代は**今の価格**でドルに直す(当時の値段は残っていない)。
// 1週間ほどの値動きの分だけずれる。額が小さいので影響も小さいが、ログにその旨を書く。
//
// 使い方: RUN_REBUILD_REAL_TOTALS=avalanche,polygon,optimism,base,arbitrum
//         (日数は REBUILD_SINCE_DAYS、既定 30)。終わったら空に戻す。

import { ethers } from "ethers";
import { callWithRpc } from "./onchain-reserves.js";
import { weiToUsd } from "./gas-cost.js";
import { loadRealExecutions, loadRealTotals, sumOfLog, adoptRebuiltTotals } from "./real-execution-log.js";

const ROUTE_IFACE = new ethers.Interface(["event RouteExecuted(address indexed asset, uint256 amountIn, uint256 profit, uint8 legCount)"]);
const ROUTE_TOPIC = ROUTE_IFACE.getEvent("RouteExecuted").topicHash;
const ERC20 = new ethers.Interface(["function symbol() view returns (string)", "function decimals() view returns (uint8)"]);
const STABLES = new Set(["USDC", "USDC.E", "USDBC", "USDT", "USDT0", "USDT.E", "DAI", "DAI.E", "USDCN"]);
const PAUSE_MS = 120;
const MAX_REQUESTS_PER_CHAIN = 3000;

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
        topics: [ROUTE_TOPIC], fromBlock: "0x" + cursor.toString(16), toBlock: "0x" + end.toString(16),
      }]));
      out.push(...(logs || []));
      cursor = end + 1;
      chunk = Math.min(Math.floor(chunk * 1.5), ceiling, 2_000_000);
    } catch (e) {
      ceiling = Math.max(500, chunk - 1);
      if (chunk <= 500) {
        // 最小幅でも読めない区間は飛ばさず、**読み切れなかった**として止める(黙って欠けさせない)
        return { logs: out, complete: false, requests, stoppedAt: cursor, error: (e.message || "").slice(0, 80) };
      }
      chunk = Math.max(500, Math.floor(chunk / 2));
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
  let first = null;
  for (const [hash, log] of byTx) {
    let rc;
    try { rc = await callWithRpc(chain, (p) => p.send("eth_getTransactionReceipt", [hash])); } catch (e) { continue; }
    if (!rc || (rc.from || "").toLowerCase() !== wallet.toLowerCase()) { foreign++; continue; }
    const ev = ROUTE_IFACE.parseLog(log);
    const tok = await tokenInfo(chain, ev.args.asset);
    const profit = Number(ev.args.profit) / 10 ** tok.decimals;
    if (tok.usd == null) unpriced++;
    grossUsd += tok.usd != null ? profit * tok.usd : 0;
    const wei = BigInt(rc.gasUsed) * BigInt(rc.effectiveGasPrice ?? "0x0") + BigInt(rc.l1Fee ?? "0x0");
    gasUsd += (await weiToUsd(chain, wei)) ?? 0;
    count++;
    contracts.add(log.address.toLowerCase());
    const bn = Number(BigInt(log.blockNumber));
    if (first == null || bn < first) first = bn;
    await sleep(40);
  }
  return { chain, count, grossUsd, gasUsd, netUsd: grossUsd - gasUsd, unpriced, foreign, contracts: contracts.size, complete: r.complete, requests: r.requests, error: r.error, from, latest, first };
}

export async function runRealTotalsRebuild() {
  const chains = rebuildChains();
  if (chains.length === 0) return;
  const key = process.env.MAINNET_BOT_PRIVATE_KEY;
  const wallet = process.env.MAINNET_BOT_ADDRESS || (key ? new ethers.Wallet(key).address : null);
  if (!wallet) { console.warn("[累計の作り直し] bot のウォレットが分からないので行いません"); return; }
  const days = Math.max(1, parseInt(process.env.REBUILD_SINCE_DAYS || "30", 10) || 30);
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
        + `${r.unpriced ? ` 価格不明${r.unpriced}件` : ""}${r.foreign ? ` 他人の取引${r.foreign}件(除外)` : ""} 最初のブロック${r.first ?? "-"}`
        + ` ${r.complete ? "読み切り" : `**途中まで**(${r.error || "上限"})`} RPC${r.requests}`);
    } catch (e) {
      console.error(`[累計の作り直し] ${c}: 失敗: ${(e.message || "").slice(0, 120)}`);
      results.push({ chain: c, failed: true });
    }
  }
  const incomplete = results.filter((r) => r.failed || !r.complete || r.unpriced > 0);
  const total = results.filter((r) => !r.failed).reduce((a, r) => ({
    count: a.count + r.count, grossUsd: a.grossUsd + r.grossUsd, gasUsd: a.gasUsd + r.gasUsd, netUsd: a.netUsd + r.netUsd,
  }), { count: 0, grossUsd: 0, gasUsd: 0, netUsd: 0 });
  console.log(`[累計の作り直し] 合計: 成立${total.count}件 粗利$${total.grossUsd.toFixed(4)} − ガス$${total.gasUsd.toFixed(4)} = **純利$${total.netUsd.toFixed(4)}**`
    + `(一覧に残っている分は ${logSum.count}件 $${logSum.netUsd.toFixed(4)})。価格は今の値で換算`);
  // 読み切れなかったチェーンがある時は採用しない(欠けた数字で上書きしない)
  if (incomplete.length > 0) {
    console.warn(`[累計の作り直し] ${incomplete.map((r) => r.chain).join(",")} が読み切れていない/価格不明のため、**画面の累計は置き換えません**`);
  } else if (total.count < logSum.count) {
    console.warn(`[累計の作り直し] チェーンから見つかった件数(${total.count})が一覧(${logSum.count})より少ないので、**置き換えません**(日数を延ばすか、旧コントラクトのイベントの形が違う可能性)`);
  } else {
    const t = adoptRebuiltTotals(total, cutoffIso);
    console.log(`[累計の作り直し] 画面の累計をチェーンの記録に置き換えました: ${t.count}件 純利$${t.netUsd.toFixed(4)}。RUN_REBUILD_REAL_TOTALS を空に戻してください`);
  }
}
