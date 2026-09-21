// scripts/competitor-check.js
//
// 「誰が取ったか」の記録(2026年9月16日追加)。
//
// [目的]
// 黒字と判定した経路が、実際にはどうなったかを後から確かめる。
//   ours            … 自分が取った
//   other_arbitrage … 他者が1つの取引で経路上の2つ以上のプールを動かした
//                     (=裁定取引。機会は本物で、速度で負けた)
//   moved_by_trade  … 通常の取引で価格が動いた(裁定ではないが、歪みは消えた)
//   untouched       … 誰も触っていない(送信直前に赤字なら、判定が幻だった)
// 48時間分を集計すれば「機会が無い」「あるが負けている」「判定が幻」を
// 数字で区別でき、速度に投資すべきかを判断できる。
//
// [問い合わせの量]
// 判定時にブロック番号を1回(2秒間は使い回す)、30秒後に経路上の全プールの
// イベントを1回まとめて取得するだけ。同じ経路は2分に1回まで、1時間に最大
// 300件までに制限する。

import { ethers } from "ethers";
import { callWithRpc } from "./onchain-reserves.js";
import { getChainConfig } from "../chain-config.js";
import { V3_SWAP_TOPIC } from "./v3-pools.js";
import { journal } from "./opportunity-journal.js";

const CHECK_DELAY_MS = parseInt(process.env.COMPETITOR_CHECK_DELAY_MS || "30000", 10);
const SAME_ROUTE_INTERVAL_MS = 2 * 60 * 1000;
const MAX_CHECKS_PER_HOUR = parseInt(process.env.COMPETITOR_CHECKS_PER_HOUR || "300", 10);

const SWAP_V2_TOPIC = ethers.id("Swap(address,uint256,uint256,uint256,uint256,address)");
const SWAP_SOLIDLY_TOPIC = ethers.id("Swap(address,address,uint256,uint256,uint256,uint256)");
const SWAP_TOPICS = [SWAP_V2_TOPIC, SWAP_SOLIDLY_TOPIC, V3_SWAP_TOPIC];

const lastCheckedAt = new Map();
const blockCache = new Map();
let hourWindowStart = Date.now();
let checksThisHour = 0;

const totals = { scheduled: 0, ours: 0, other_arbitrage: 0, moved_by_trade: 0, untouched: 0, error: 0 };
// 送信直前の結果ごとの内訳(例: rejected かつ other_arbitrage = 送信直前には既に取られていた)
const bySendResult = {};
let lastSummaryLine = "";

async function currentBlock(chain) {
  const cached = blockCache.get(chain);
  if (cached && Date.now() - cached.at < 2000) return cached.value;
  const value = await callWithRpc(chain, (p) => p.getBlockNumber());
  blockCache.set(chain, { value, at: Date.now() });
  return value;
}

function topicToAddress(topic) {
  if (!topic || topic.length !== 66) return "";
  return ("0x" + topic.slice(26)).toLowerCase();
}

/// 黒字と判定した経路を、30秒後に確認する予約を入れる。
/// opp.sendResult は execute-opportunity.js が送信直前の結果で上書きする。
export function scheduleCompetitorCheck(opp) {
  if (!opp || !opp.poolAddresses || opp.poolAddresses.length < 2) return;
  const now = Date.now();
  if (now - hourWindowStart > 3600 * 1000) { hourWindowStart = now; checksThisHour = 0; }
  if (checksThisHour >= MAX_CHECKS_PER_HOUR) return;

  const key = `${opp.chain}:${opp.poolAddresses.map((a) => a.toLowerCase()).join(">")}`;
  const last = lastCheckedAt.get(key);
  if (last && now - last < SAME_ROUTE_INTERVAL_MS) return;
  lastCheckedAt.set(key, now);
  if (lastCheckedAt.size > 5000) lastCheckedAt.delete(lastCheckedAt.keys().next().value);
  checksThisHour++;
  totals.scheduled++;

  const detectedAt = now;
  currentBlock(opp.chain)
    .then((detectedBlock) => {
      setTimeout(() => runCheck(opp, detectedBlock, detectedAt).catch(() => {}), CHECK_DELAY_MS);
    })
    .catch(() => { totals.error++; });
}

async function runCheck(opp, detectedBlock, detectedAt) {
  const chain = opp.chain;
  const pools = opp.poolAddresses.map((a) => a.toLowerCase());
  const contract = (process.env[getChainConfig(chain)?.contractAddressEnvVar] || "").toLowerCase();

  let logs;
  let toBlock;
  try {
    toBlock = await currentBlock(chain);
    logs = await callWithRpc(chain, (p) => p.getLogs({
      address: pools.map((a) => ethers.getAddress(a)),
      topics: [SWAP_TOPICS],
      fromBlock: Math.max(0, detectedBlock - 1),
      toBlock,
    }));
  } catch (e) {
    totals.error++;
    return;
  }

  const byTx = new Map();
  let ours = null;
  for (const log of logs) {
    const tx = log.transactionHash;
    if (!byTx.has(tx)) byTx.set(tx, { block: log.blockNumber, pools: new Set() });
    byTx.get(tx).pools.add(log.address.toLowerCase());
    if (contract) {
      const sender = topicToAddress(log.topics[1]);
      const recipient = topicToAddress(log.topics[2]);
      if (sender === contract || recipient === contract) ours = { hash: tx, block: log.blockNumber };
    }
  }

  const arbitrages = [];
  for (const [hash, info] of byTx) {
    if (ours && hash === ours.hash) continue;
    if (info.pools.size >= 2) arbitrages.push({ hash, blockDelta: info.block - detectedBlock, poolsTouched: info.pools.size });
  }
  arbitrages.sort((a, b) => a.blockDelta - b.blockDelta);

  let verdict;
  if (ours) verdict = "ours";
  else if (arbitrages.length > 0) verdict = "other_arbitrage";
  else if (byTx.size > 0) verdict = "moved_by_trade";
  else verdict = "untouched";

  totals[verdict]++;
  const sendResult = opp.sendResult || "unknown";
  if (!bySendResult[sendResult]) bySendResult[sendResult] = { ours: 0, other_arbitrage: 0, moved_by_trade: 0, untouched: 0 };
  bySendResult[sendResult][verdict]++;

  // 記録簿の「黒字判定の合計」に混ざらないよう、利益は別の名前で残す。
  journal({
    outcome: "competitor_check",
    verdict, sendResult,
    chain, kind: opp.kind, label: opp.label, hasV3: !!opp.hasV3,
    pools: opp.poolAddresses,
    profitUsdAtDetection: Number((opp.netProfitUsd || 0).toFixed(6)),
    tradeAmountUsd: Number((opp.tradeAmountUsd || 0).toFixed(4)),
    detectedBlock, toBlock,
    secondsWatched: Math.round((Date.now() - detectedAt) / 1000),
    otherArbitrages: arbitrages.slice(0, 3),
    tradesTouchingRoute: byTx.size,
  });

  if (verdict === "other_arbitrage") {
    const first = arbitrages[0];
    console.log(`[誰が取ったか] ${chain} ${opp.label}: 他者の裁定 ${first.hash.slice(0, 12)}…(判定から${first.blockDelta}ブロック後、送信直前の結果: ${sendResult})`);
  }
}

setInterval(() => {
  const t = totals;
  const judged = t.ours + t.other_arbitrage + t.moved_by_trade + t.untouched;
  const breakdown = Object.entries(bySendResult)
    .map(([k, v]) => `${k}=他者裁定${v.other_arbitrage}/通常取引${v.moved_by_trade}/誰も触らず${v.untouched}/自分${v.ours}`)
    .join(" ");
  const line = `[誰が取ったか/集計] 確認${judged}件: 自分${t.ours} / 他者の裁定${t.other_arbitrage} / 通常取引で価格が動いた${t.moved_by_trade} / 誰も触らず${t.untouched}(取得失敗${t.error}) ${breakdown}`;
  if (line !== lastSummaryLine) {
    console.log(line);
    lastSummaryLine = line;
  }
}, 10 * 60 * 1000);
