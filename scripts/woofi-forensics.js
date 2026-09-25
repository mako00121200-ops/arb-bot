// scripts/woofi-forensics.js
//
// **WOOFi の黒字のずれが「いつ開いて・いつ・誰に閉じられたか」を、過去のブロックで1回だけ再現する。**
// 読み取りのみ・送信しない・お金は動かない。
//
// [なぜ(2026年9月25日、オーナーの指示「WOOFiの黒字は何秒で取られたか、我々なら何秒で届くか」)]
// 9/25 11:53:38 JST、optimism で WBTC「DEX→WOOFi」$1,000 が +155.8bps・純利$15.59 と出て、約17秒続いた。
// 計測は平時60秒ごとなので、**開いた瞬間は見ていない**。ブロックごとに当時の状態で見積もり直せば、
//   ・ずれが何ブロック目に開いて、何ブロック目に閉じたか(= 何秒残っていたか)
//   ・閉じたブロックで WOOFi や WBTC のプールに触った取引(= 誰が取ったか)
// が分かる。
//
// 使い方: RUN_WOOFI_FORENSICS=true(終わったら空に戻す)
//   既定は上の1件。別の件は WOOFI_FORENSICS_CHAIN / WOOFI_FORENSICS_AT(ISO時刻)/ WOOFI_FORENSICS_TOKEN で指定
//   WOOFI_FORENSICS_BEFORE / WOOFI_FORENSICS_AFTER(秒。既定 180 / 120)

import { ethers } from "ethers";
import { callWithRpc } from "./onchain-reserves.js";
import { gasUnitsToUsd } from "./gas-cost.js";
import { getKnownTokens } from "./borrowable-tokens.js";
import { bestSellQuote, findV3Pools } from "./onchain-quote.js";
import { V3_SWAP_TOPIC } from "./v3-pools.js";
import { formatJst } from "./jst.js";

const ROUTER = "0x4c4AF8DBc524681930a27b2F1Af5bcC8062E6fB7";
const GAS_UNITS = 450000n;
const ROUTER_IFACE = new ethers.Interface(["function wooPool() view returns (address)"]);
const POOL_IFACE = new ethers.Interface([
  "function quoteToken() view returns (address)",
  "function wooracle() view returns (address)",
  "function tryQuery(address fromToken, address toToken, uint256 fromAmount) view returns (uint256)",
  // woonetwork/WooPoolV2 contracts/interfaces/IWooPPV2.sol
  "event WooSwap(address indexed fromToken, address indexed toToken, uint256 fromAmount, uint256 toAmount, address from, address indexed to, address rebateTo, uint256 swapVol, uint256 swapFee)",
]);
const ERC20_IFACE = new ethers.Interface(["function decimals() view returns (uint8)", "function symbol() view returns (string)"]);

export function woofiForensicsEnabled() {
  return process.env.RUN_WOOFI_FORENSICS === "true";
}

async function view(chain, to, iface, fn, args = [], blockTag = "latest") {
  const raw = await callWithRpc(chain, (p) => p.call({ to, data: iface.encodeFunctionData(fn, args), blockTag }), false);
  const r = iface.decodeFunctionResult(fn, raw);
  return r.length === 1 ? r[0] : r;
}
const rpc = (chain, fn) => callWithRpc(chain, fn, false);

/// 指定時刻の直前のブロックを二分探索で探す
async function blockAt(chain, tsSec) {
  const latest = await rpc(chain, (p) => p.getBlock("latest"));
  let lo = Math.max(0, latest.number - 200000), hi = latest.number;
  const loB = await rpc(chain, (p) => p.getBlock(lo));
  if (loB.timestamp > tsSec) throw new Error("20万ブロックより前は探せません");
  while (hi - lo > 1) {
    const mid = Math.floor((lo + hi) / 2);
    const b = await rpc(chain, (p) => p.getBlock(mid));
    if (b.timestamp <= tsSec) lo = mid; else hi = mid;
  }
  return lo;
}

export async function runWoofiForensics() {
  if (!woofiForensicsEnabled()) return;
  const P = "[WOOFi再現]";
  const chain = process.env.WOOFI_FORENSICS_CHAIN || "optimism";
  const at = Date.parse(process.env.WOOFI_FORENSICS_AT || "2026-09-25T02:53:38Z") / 1000;
  const token = (process.env.WOOFI_FORENSICS_TOKEN || "0x68f180fcce6836688e9084f035309e29bf0a2095").toLowerCase();
  const before = parseInt(process.env.WOOFI_FORENSICS_BEFORE || "180", 10);
  const after = parseInt(process.env.WOOFI_FORENSICS_AFTER || "120", 10);
  try {
    const pool = String(await view(chain, ROUTER, ROUTER_IFACE, "wooPool"));
    const quote = String(await view(chain, pool, POOL_IFACE, "quoteToken"));
    const qDec = Number(await view(chain, quote, ERC20_IFACE, "decimals"));
    const sym = await view(chain, token, ERC20_IFACE, "symbol").catch(() => token.slice(0, 8));
    const hubs = Object.keys(getKnownTokens(chain));
    const x = 1000n * 10n ** BigInt(qDec);
    const gasUsd = (await gasUnitsToUsd(chain, GAS_UNITS).catch(() => null)) ?? 0.01;

    const center = await blockAt(chain, at);
    const b0 = await blockAt(chain, at - before);
    const b1 = await blockAt(chain, at + after);
    console.log(`${P} ${chain} ${sym}: ${formatJst(at * 1000)} はブロック${center}。${b0}〜${b1}(${b1 - b0 + 1}ブロック)を1つずつ見積もり直します(読み取りのみ)`);

    // 1. ブロックごとの差(両方向)
    const rows = [];
    for (let b = b0; b <= b1; b++) {
      const blk = await rpc(chain, (p) => p.getBlock(b));
      let a = null, bb = null, labA = "", labB = "";
      try { // A: WOOFi で買って DEX で売る
        const got = BigInt(await view(chain, pool, POOL_IFACE, "tryQuery", [quote, token, x], b));
        const s = got > 0n ? await bestSellQuote(chain, token, quote, got, hubs, b) : null;
        if (s) { a = Number(s.out - x) / 10 ** qDec - gasUsd; labA = s.label; }
      } catch (e) {}
      try { // B: DEX で買って WOOFi で売る
        const d = await bestSellQuote(chain, quote, token, x, hubs, b);
        if (d) {
          const out = BigInt(await view(chain, pool, POOL_IFACE, "tryQuery", [token, quote, d.out], b));
          if (out > 0n) { bb = Number(out - x) / 10 ** qDec - gasUsd; labB = d.label; }
        }
      } catch (e) {}
      rows.push({ b, ts: blk.timestamp, a, bb, labA, labB });
    }
    const f = (v) => (v == null ? "  -   " : `${v >= 0 ? "+" : ""}${v.toFixed(2)}`);
    let prevPos = false, openAt = null;
    const episodes = [];
    for (const r of rows) {
      const pos = (r.a ?? -1) > 0 || (r.bb ?? -1) > 0;
      if (pos && !prevPos) openAt = r;
      if (!pos && prevPos && openAt) episodes.push({ open: openAt, close: r });
      prevPos = pos;
      // 黒字の前後だけ詳しく出す(行が多くなりすぎないように)
      if (pos || Math.abs(r.b - center) <= 3) {
        console.log(`${P}  ブロック${r.b} ${formatJst(r.ts * 1000)} WOOFi→DEX $${f(r.a)} / DEX→WOOFi $${f(r.bb)}${pos ? ` ← 黒字(${(r.bb ?? -1) > 0 ? r.labB : r.labA})` : ""}`);
      }
    }
    if (prevPos && openAt) episodes.push({ open: openAt, close: null });
    if (episodes.length === 0) console.log(`${P} 窓の中で黒字のブロックはありませんでした(見積もりの当時の状態が読めていない可能性。RPCが過去の状態を持っているか要確認)`);

    // 2. 閉じたブロックで何が起きたか(WOOFi の取引・対象トークンのプールの取引)
    const poolsSet = new Set();
    for (const h of hubs) {
      if (h.toLowerCase() === token) continue;
      for (const p of await findV3Pools(chain, token, h).catch(() => [])) poolsSet.add(p.address.toLowerCase());
    }
    const wooTopic = POOL_IFACE.getEvent("WooSwap").topicHash;
    for (const ep of episodes) {
      const openSec = ep.open.ts, closeSec = ep.close ? ep.close.ts : null;
      console.log(`${P} **黒字のずれ**: ブロック${ep.open.b}(${formatJst(openSec * 1000)})に開き、`
        + (ep.close ? `ブロック${ep.close.b}(${formatJst(closeSec * 1000)})に閉じた = **約${closeSec - openSec}秒** 残っていた` : "窓の終わりまで閉じなかった"));
      if (!ep.close) continue;
      const from = ep.close.b, to = ep.close.b;
      const wooLogs = await rpc(chain, (p) => p.getLogs({ address: pool, topics: [wooTopic], fromBlock: from, toBlock: to })).catch(() => []);
      const v3Logs = poolsSet.size
        ? await rpc(chain, (p) => p.getLogs({ address: [...poolsSet], topics: [V3_SWAP_TOPIC], fromBlock: from, toBlock: to })).catch(() => [])
        : [];
      const txs = new Map();
      for (const l of wooLogs) {
        const ev = POOL_IFACE.parseLog(l);
        txs.set(l.transactionHash, `${txs.get(l.transactionHash) || ""} WOOFi[${ev.args.fromToken.slice(0, 8)}→${ev.args.toToken.slice(0, 8)} 量${ev.args.fromAmount}]`);
      }
      for (const l of v3Logs) txs.set(l.transactionHash, `${txs.get(l.transactionHash) || ""} V3プール${l.address.slice(0, 10)}`);
      // 価格係(Wooracle)への書き込みも同じブロックにあったか(公開の関数名に頼らず、宛先で見る)
      try {
        const oracle = String(await view(chain, pool, POOL_IFACE, "wooracle", [], to)).toLowerCase();
        const blk = await rpc(chain, (p) => p.getBlock(to, true));
        const posts = (blk?.prefetchedTransactions || []).filter((t) => (t.to || "").toLowerCase() === oracle);
        console.log(`${P}   同じブロックの価格係(${oracle.slice(0, 10)})への書き込み: ${posts.length}件${posts.length ? `(位置 ${posts.map((t) => t.index).join(",")})` : ""}`);
      } catch (e) {}
      if (txs.size === 0) console.log(`${P}   閉じたブロックで WOOFi・対象プールの取引なし → **価格係(Wooracle)の書き込みか、別経路の値動きで閉じた**可能性`);
      for (const [hash, what] of txs) {
        const tx = await rpc(chain, (p) => p.getTransaction(hash)).catch(() => null);
        const rc = await rpc(chain, (p) => p.getTransactionReceipt(hash)).catch(() => null);
        console.log(`${P}   取引 ${hash} 送信者${tx?.from?.slice(0, 10) || "?"} 宛先${tx?.to?.slice(0, 10) || "?"} 位置${rc?.index ?? "?"}番目 優先手数料${tx?.maxPriorityFeePerGas != null ? ethers.formatUnits(tx.maxPriorityFeePerGas, "gwei") : "?"}gwei:${what}`);
      }
    }
    console.log(`${P} 終了。RUN_WOOFI_FORENSICS を空に戻してください`);
  } catch (e) {
    console.warn(`${P} 失敗: ${(e.shortMessage || e.message || "").slice(0, 160)}`);
  }
}
