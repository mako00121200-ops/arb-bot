// scripts/morpho-lag-deepdive.js
//
// **長く放置された清算を1件ずつ解剖する**(第1.5段。読み取りのみ・送信しない・お金は動かない)。
//
// [なぜ(2026年9月24日、オーナーの指示「1.5段に進んで」)]
// §17 の調査で、Ethereum 本体の Morpho では「その他」の担保(AVLT・AZND・apyUSD など)の大口清算が
// 清算できる状態のまま中央値で約64時間放置されていた。理由は2通りありうる:
//   ① 売り方を知る人が少なかった → 取りに行ける
//   ② 値付け(オラクル)が市場の値段より高く、清算しても儲からなかった → 放置は取り逃しではない
// これを見分けるため、勝者の取引の中の通貨の流れ(Transfer)を読み、
//   ・担保をその取引の中で売ったのか、持ち帰ったのか
//   ・売ったならどこへ(DEX のプール / それ以外の契約 / 個人の住所)
//   ・清算した側に、借金の通貨が差し引きいくら残ったか(= 実際の儲け)
// を出す。
//
// 入力: 前回の調査が保存した `morpho-liquidations-<chain>.jsonl`(txHash・lagBlocks 入り)
// 使い方: RUN_MORPHO_DEEPDIVE=ethereum(終わったら空に戻す)

import fs from "fs";
import { ethers } from "ethers";
import { stateFilePath } from "./state-file.js";
import { rpc, readMarket, readToken, short, usd } from "./morpho-liquidation-survey.js";

const TRANSFER = ethers.id("Transfer(address,address,uint256)");
const ERC20 = new ethers.Interface(["function name() view returns (string)"]);
const POOLISH = new ethers.Interface(["function token0() view returns (address)"]);
const MORPHO_ETH = "0xbbbbbbbbbb9cc5e90e3b3af64bdaf62c37eeffcb";
const LONG_LAG = 26;      // これ以上を「放置」とする(§17 と同じ区切り)
const MAX_LONG = parseInt(process.env.MORPHO_DEEPDIVE_LONG || "30", 10);
const MAX_SHORT = parseInt(process.env.MORPHO_DEEPDIVE_SHORT || "10", 10);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function morphoDeepdiveChains() {
  const raw = (process.env.RUN_MORPHO_DEEPDIVE || "").trim();
  if (!raw || raw === "false") return [];
  return raw.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
}

const lc = (a) => String(a || "").toLowerCase();
const topicAddr = (t) => "0x" + t.slice(26).toLowerCase();

/// 受領書の Transfer から、ある通貨の「誰から誰へいくら」を並べる(テストしやすいよう純粋関数)。
export function transfersOf(logs, token) {
  const out = [];
  for (const l of logs || []) {
    if (lc(l.address) !== lc(token) || l.topics?.[0] !== TRANSFER || l.topics.length < 3) continue;
    out.push({ from: topicAddr(l.topics[1]), to: topicAddr(l.topics[2]), amount: BigInt(l.data === "0x" ? 0 : l.data) });
  }
  return out;
}

/// 清算した側(住所の集まり)にとっての差し引き。正 = 増えた。
export function netFor(transfers, side) {
  let n = 0n;
  for (const t of transfers) {
    if (side.has(t.to) && !side.has(t.from)) n += t.amount;
    if (side.has(t.from) && !side.has(t.to)) n -= t.amount;
  }
  return n;
}

/// 清算した側から出ていった先(額の大きい順)。
export function outflows(transfers, side) {
  const m = new Map();
  for (const t of transfers) {
    if (side.has(t.from) && !side.has(t.to)) m.set(t.to, (m.get(t.to) || 0n) + t.amount);
  }
  return [...m.entries()].sort((a, b) => (b[1] > a[1] ? 1 : -1));
}

const kindCache = new Map();
/// 住所の正体: DEX のプールらしい(token0 を持つ)/ その他の契約 / 個人の住所(コードなし)
async function addressKind(chain, addr) {
  if (kindCache.has(addr)) return kindCache.get(addr);
  let kind = "不明";
  try {
    const code = await rpc(chain, (p) => p.getCode(addr));
    if (!code || code === "0x") kind = "個人の住所";
    else {
      try {
        await rpc(chain, (p) => p.call({ to: addr, data: POOLISH.encodeFunctionData("token0") }));
        kind = "DEXのプール";
      } catch (e) { kind = "契約"; }
    }
  } catch (e) {}
  kindCache.set(addr, kind);
  return kind;
}

const nameCache = new Map();
async function tokenName(chain, token) {
  if (nameCache.has(token)) return nameCache.get(token);
  let n = "";
  try {
    const r = await rpc(chain, (p) => p.call({ to: token, data: ERC20.encodeFunctionData("name") }));
    n = ERC20.decodeFunctionResult("name", r)[0];
  } catch (e) {}
  nameCache.set(token, n);
  return n;
}

async function dissect(chain, row, secPerBlock) {
  const [rc, tx] = await Promise.all([
    rpc(chain, (p) => p.send("eth_getTransactionReceipt", [row.txHash])),
    rpc(chain, (p) => p.send("eth_getTransactionByHash", [row.txHash])),
  ]);
  if (!rc || !tx) return null;
  const m = await readMarket(chain, row.id);
  const [loan, coll] = await Promise.all([readToken(chain, m.loanToken), readToken(chain, m.collateralToken)]);
  const side = new Set([lc(tx.from), lc(tx.to), lc(row.caller)].filter(Boolean));
  const collT = transfersOf(rc.logs, m.collateralToken);
  const loanT = transfersOf(rc.logs, m.loanToken);
  // Morpho から清算した側へ入った担保(差し押さえ)
  const seized = collT.filter((t) => t.from === MORPHO_ETH && side.has(t.to)).reduce((s, t) => s + t.amount, 0n);
  const collNet = netFor(collT, side);
  const loanNet = netFor(loanT, side);
  const kept = Number(collNet) / 10 ** coll.decimals;
  const profitLoan = Number(loanNet) / 10 ** loan.decimals;
  const outs = [];
  for (const [to, amt] of outflows(collT, side).slice(0, 2)) {
    if (to === MORPHO_ETH) continue;
    outs.push(`${await addressKind(chain, to)} ${short(to)}(${(Number(amt) / 10 ** coll.decimals).toPrecision(4)})`);
  }
  // 借金の通貨・担保以外で清算側に残った通貨(儲けを別の通貨で持ち帰る場合がある。例: WETH)
  const others = [];
  const tokens = new Set((rc.logs || []).filter((l) => l.topics?.[0] === TRANSFER && l.topics.length === 3).map((l) => lc(l.address)));
  for (const t of tokens) {
    if (t === lc(m.collateralToken) || t === lc(m.loanToken)) continue;
    const n = netFor(transfersOf(rc.logs, t), side);
    if (n !== 0n) {
      const info = await readToken(chain, t);
      const v = Number(n) / 10 ** info.decimals;
      others.push(`${info.symbol} ${v >= 0 ? "+" : ""}${v.toPrecision(4)}${info.priceUsd != null ? `(${usd(v * info.priceUsd)})` : ""}`);
    }
  }
  const how = collNet > 0n && (seized === 0n || collNet * 2n >= seized)
    ? "担保を持ち帰り(同じ取引では売っていない)"
    : outs.length ? `担保を売却/渡した先: ${outs.join(" / ")}` : "担保の流れが読めない";
  return {
    pair: row.pair, collName: await tokenName(chain, m.collateralToken), collAddr: m.collateralToken,
    repaidUsd: row.repaidUsd, bonusUsd: row.bonusUsd, lagBlocks: row.lagBlocks,
    lagHours: row.lagBlocks != null ? (row.lagBlocks * secPerBlock) / 3600 : null,
    how, kept, keptUsd: coll.priceUsd != null ? kept * coll.priceUsd : null,
    profitLoan, profitUsd: loan.priceUsd != null ? profitLoan * loan.priceUsd : null,
    others, loanSym: loan.symbol, collSym: coll.symbol, from: lc(tx.from), to: lc(tx.to), txHash: row.txHash,
  };
}

function line(P, d) {
  const lag = d.lagBlocks == null ? "?" : d.lagBlocks === 0 ? "同じブロック" : `${d.lagBlocks}ブロック≒${d.lagHours.toFixed(1)}時間`;
  return `${P} ${d.pair}(${d.collName || "?"} ${short(d.collAddr)}) 返済${usd(d.repaidUsd)} 報酬見込み${usd(d.bonusUsd)} 放置${lag} → ${d.how}。`
    + `清算側の差し引き ${d.loanSym} ${d.profitLoan >= 0 ? "+" : ""}${d.profitLoan.toFixed(2)}(${usd(d.profitUsd)})`
    + `${d.others?.length ? ` 他の通貨 ${d.others.join(" ")}` : ""}`
    + `${d.kept > 0 ? ` 持ち帰った担保 ${d.kept.toPrecision(4)} ${d.collSym}(今の値段で${usd(d.keptUsd)})` : ""} by ${short(d.from)}→${short(d.to)}`;
}

export async function runMorphoDeepdive() {
  for (const chain of morphoDeepdiveChains()) {
    const P = `[Morpho解剖] ${chain}:`;
    let rows = [];
    try {
      rows = fs.readFileSync(stateFilePath(`morpho-liquidations-${chain}.jsonl`), "utf8")
        .split("\n").filter(Boolean).map((l) => JSON.parse(l));
    } catch (e) {
      console.warn(`${P} 前回の調査の保存が読めません(先に RUN_MORPHO_SURVEY=${chain} を走らせる): ${(e.message || "").slice(0, 80)}`);
      continue;
    }
    const secPerBlock = chain === "ethereum" ? 12 : 2;
    const measured = rows.filter((r) => r.lagBlocks != null);
    const long = measured.filter((r) => r.lagBlocks >= LONG_LAG).sort((a, b) => (b.repaidUsd ?? 0) - (a.repaidUsd ?? 0)).slice(0, MAX_LONG);
    const short0 = measured.filter((r) => r.lagBlocks === 0).sort((a, b) => (b.repaidUsd ?? 0) - (a.repaidUsd ?? 0)).slice(0, MAX_SHORT);
    console.log(`${P} 開始。放置${LONG_LAG}ブロック以上 ${long.length}件と、比較用に同じブロック ${short0.length}件を解剖します(読むだけ)`);
    const results = { long: [], short: [] };
    for (const [key, list] of [["long", long], ["short", short0]]) {
      for (const r of list) {
        try {
          const d = await dissect(chain, r, secPerBlock);
          if (d) { results[key].push(d); console.log(line(`${P} [${key === "long" ? "放置" : "即時"}]`, d)); }
        } catch (e) {
          console.warn(`${P} ${r.txHash?.slice(0, 10)} を読めません: ${(e.shortMessage || e.message || "").slice(0, 80)}`);
        }
        await sleep(150);
      }
    }
    // まとめ: 放置された清算は、同じ取引で売られたか・持ち帰られたか・実際に儲かったか
    for (const [key, label] of [["long", "放置"], ["short", "即時"]]) {
      const xs = results[key];
      if (!xs.length) continue;
      const keptN = xs.filter((d) => d.how.startsWith("担保を持ち帰り")).length;
      const pos = xs.filter((d) => (d.profitUsd ?? d.profitLoan) > 0).length;
      const sumProfit = xs.reduce((s, d) => s + (d.profitUsd ?? 0), 0);
      const sumKept = xs.reduce((s, d) => s + (d.keptUsd ?? 0), 0);
      const perMarket = new Map();
      for (const d of xs) perMarket.set(d.pair, (perMarket.get(d.pair) || 0) + 1);
      console.log(`${P} まとめ[${label}] ${xs.length}件: 同じ取引で担保を売った${xs.length - keptN}件 / 持ち帰った${keptN}件、`
        + `借金の通貨がプラスで終わった${pos}件(計${usd(sumProfit)})、持ち帰った担保 計${usd(sumKept)}(今の値段)。`
        + `市場 ${[...perMarket].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([k, v]) => `${k}:${v}`).join(" ")}`);
    }
    try {
      fs.writeFileSync(stateFilePath(`morpho-deepdive-${chain}.json`), JSON.stringify(results));
    } catch (e) {}
    console.log(`${P} 終了。RUN_MORPHO_DEEPDIVE を空に戻してください`);
  }
}
