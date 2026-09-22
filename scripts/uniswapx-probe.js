// scripts/uniswapx-probe.js
//
// **UniswapX の「勝てたか」を、1円も賭けずに測る。**
//
// [なぜ要るか(2026年9月22日、オーナーと方針を見直して)]
// 原子的DEX裁定は実測で 1日$0.156 が天井だった。理由は構造的で、
//   ・深いプール … 価格差は同一ブロックで消えている(メインネット30件中30件が赤字)
//   ・浅いプール … 価格差は残るが$1しか入らない
// `深さ × 価格差` がほぼ一定で小さい。**裁定の利幅は競争でゼロに削られる。**
//
// 一方 **注文フローの利幅は削られない**。ユーザーは「すぐ約定すること」に対価を払うため。
// UniswapX はその注文フローに、**審査も担保も無しで**参加できる:
//   ・quoter(RFQで値段を聞かれる役) … Uniswap Labs の審査が要る
//   ・filler(注文を約定させる役)     … **permissionless。最低ステークは無い**
// しかも UniswapX の展開チェーンには polygon / avalanche / base / optimism / arbitrum が
// 含まれており、**我々が既にプール地図を持っているチェーンそのもの**。
//
// [ここで測るもの]
// 「すでに約定した注文」を公開APIから取り、**我々の経路なら同じ注文をいくらで
// 埋められたか**を計算して、実際の約定額と比べる。
//
//   我々の受取 > ユーザーへの支払い  → その差が我々の取り分。**勝てた**
//   我々の受取 < ユーザーへの支払い  → 勝てなかった
//
// **送信しない。約定もしない。ガスも元手も要らない。** 読んで計算するだけ。
// これで「作る価値があるか」が、作る前に分かる。
//
// [なぜ「約定済み」を見るのか]
// 未約定の注文を見ても、勝者がいくらで埋めたかが分からない。約定済みなら
// **答え合わせができる**。相手は実在の競争相手で、我々の実力がそのまま出る。
//
// [環境変数]
//   UNISWAPX_PROBE_CHAINS … 測るチェーン(既定は稼働中のうち UniswapX 対応のもの)
//   UNISWAPX_PROBE_INTERVAL_MS … 取りに行く間隔(既定5分)
//   UNISWAPX_PROBE_LIMIT  … 1回に取る注文数(既定20、APIの上限は50)

import { bestOutputFor } from "./opportunity-scanner.js";
import { extractSwap } from "./uniswapx-parse.js";
import { getTokenDecimals, getTokenPriceUsd } from "./pool-registry.js";
import { getKnownTokens } from "./borrowable-tokens.js";

/// UniswapX の公開API。**鍵は要らない**(注文の取得は誰でもできる)。
const API_BASE = process.env.UNISWAPX_API_BASE || "https://api.uniswap.org/v2";

/// chainId は UniswapX 側の指定。我々のチェーン名と対応づける。
const CHAIN_IDS = {
  ethereum: 1, optimism: 10, bnb: 56, polygon: 137, base: 8453,
  arbitrum: 42161, avalanche: 43114, celo: 42220, unichain: 130,
};

const PROBE_CHAINS = (process.env.UNISWAPX_PROBE_CHAINS || "polygon,base,arbitrum,optimism,avalanche")
  .split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
export const PROBE_INTERVAL_MS = parseInt(process.env.UNISWAPX_PROBE_INTERVAL_MS || String(5 * 60 * 1000), 10);
const PROBE_LIMIT = Math.min(parseInt(process.env.UNISWAPX_PROBE_LIMIT || "20", 10), 50);
/// 1回の取得にかける時間の上限。ここで詰まると裁定側の処理が遅れるため。
const FETCH_TIMEOUT_MS = parseInt(process.env.UNISWAPX_FETCH_TIMEOUT_MS || "8000", 10);
/// 同じ注文を二度数えないための記憶。
const seenOrders = new Set();
const SEEN_LIMIT = 5000;

/// チェーンごとの集計。**これが判断材料。**
const stats = new Map(); // chain -> { seen, quotable, won, lost, marginUsd, bestUsd, best }

function statFor(chain) {
  if (!stats.has(chain)) {
    stats.set(chain, { seen: 0, quotable: 0, won: 0, lost: 0, marginUsd: 0, bestUsd: 0, best: null,
      noRoute: 0, noDecimals: 0 });
  }
  return stats.get(chain);
}

/// API から約定済みの注文を取る。失敗しても例外は投げない(裁定側を止めない)。
async function fetchFilledOrders(chain) {
  const chainId = CHAIN_IDS[chain];
  if (!chainId) return [];
  const url = `${API_BASE}/orders?chainId=${chainId}&orderStatus=filled&limit=${PROBE_LIMIT}`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: ctrl.signal, headers: { accept: "application/json" } });
    if (!res.ok) {
      console.warn(`[UniswapX計測] ${chain}: APIが${res.status}を返しました`);
      return [];
    }
    const body = await res.json();
    return Array.isArray(body?.orders) ? body.orders : [];
  } catch (e) {
    console.warn(`[UniswapX計測] ${chain}: 取得に失敗 ${(e.message || "").slice(0, 60)}`);
    return [];
  } finally {
    clearTimeout(timer);
  }
}

function toUsd(chain, token, raw) {
  const dec = getTokenDecimals(chain, token);
  const price = getTokenPriceUsd(chain, token);
  if (dec == null || !(price > 0)) return null;
  return (Number(raw) / Math.pow(10, dec)) * price;
}

/// 1チェーンぶん測る。
async function probeChain(chain) {
  const orders = await fetchFilledOrders(chain);
  if (orders.length === 0) return;
  const s = statFor(chain);
  const hubs = Object.keys(getKnownTokens(chain));

  for (const order of orders) {
    const hash = order?.orderHash;
    if (!hash || seenOrders.has(hash)) continue;
    seenOrders.add(hash);
    if (seenOrders.size > SEEN_LIMIT) {
      let n = 0;
      for (const k of seenOrders) { seenOrders.delete(k); if (++n >= SEEN_LIMIT / 2) break; }
    }
    s.seen++;

    const swap = extractSwap(order);
    if (!swap) continue;

    // 我々の経路なら、同じ投入額で何が返るか。
    const mine = bestOutputFor({
      chain, tokenIn: swap.tokenIn, tokenOut: swap.tokenOut, amountIn: swap.amountIn, hubTokens: hubs,
    });
    if (!mine) { s.noRoute++; continue; }

    // 差額をUSDにする。出力通貨の桁数と価格が無ければ数えない。
    const diffUsd = toUsd(chain, swap.tokenOut, mine.amountOut - swap.amountOut);
    if (diffUsd == null) { s.noDecimals++; continue; }
    s.quotable++;

    if (diffUsd > 0) {
      s.won++;
      s.marginUsd += diffUsd;
      if (diffUsd > s.bestUsd) {
        s.bestUsd = diffUsd;
        s.best = { hash, label: mine.label, sizeUsd: toUsd(chain, swap.tokenIn, swap.amountIn) };
      }
    } else {
      s.lost++;
    }
  }
}

/// 全チェーンを測る。**注文は取るが、約定は一切しない。**
export async function probeUniswapXOnce(activeChains) {
  for (const chain of PROBE_CHAINS) {
    if (!activeChains.includes(chain)) continue;
    try {
      await probeChain(chain);
    } catch (e) {
      console.warn(`[UniswapX計測] ${chain}: 失敗 ${(e.message || "").slice(0, 60)}`);
    }
  }
}

/// 生存ログ用の1行。まだ1件も見ていなければ空。
export function formatUniswapXLine() {
  if (stats.size === 0) return "";
  const parts = [];
  for (const [chain, s] of stats) {
    if (s.seen === 0) continue;
    const rate = s.quotable > 0 ? ((s.won / s.quotable) * 100).toFixed(0) : "-";
    parts.push(`${chain} 見${s.seen}/値付け${s.quotable}(経路なし${s.noRoute})勝${s.won}(${rate}%) 取り分計$${s.marginUsd.toFixed(3)} 最良$${s.bestUsd.toFixed(3)}`);
  }
  return parts.length > 0 ? ` UniswapX計測[${parts.join(" / ")}]` : "";
}

/// 詳しい報告(30分ごと)。勝てた最良の1本を出す。
export function formatUniswapXReport() {
  const lines = [];
  for (const [chain, s] of stats) {
    if (!s.best) continue;
    lines.push(`[UniswapX計測] ${chain}: 最良 ${s.best.label} で $${s.bestUsd.toFixed(4)} の取り分`
      + `(注文$${s.best.sizeUsd != null ? s.best.sizeUsd.toFixed(0) : "?"} / ${s.best.hash.slice(0, 10)}…)`);
  }
  return lines;
}

export function getUniswapXStats() {
  const out = {};
  for (const [chain, s] of stats) out[chain] = { ...s };
  return out;
}

export function getProbeChains() { return PROBE_CHAINS.filter((c) => CHAIN_IDS[c]); }
