// scripts/solana-probe.js
//
// **Solana に「放置されているのに取引されているコイン」があるかを測る。**
//
// [なぜ要るか(2026年9月22日、オーナーの指摘)]
// 私は Solana を「結局レイテンシ勝負」として一度却下した。根拠は
// 「$7.2億の大半を取った searcher は高度な戦略ではなく、より良いインフラを走らせていた」
// という実測。**だがこれは「争われている部分」の話で、「放置された尾」の話ではない。**
//
// そして今日 Avalanche で実証されたのはまさに後者だった —
// WAVAX/USDC が3,000ブロックで1,511回も取引されているのに、我々は見ていなかった。
// **同じ論理が Solana にも当てはまるはずで、測らずに却下したのは筋が通らない。**
//
// 一次情報にも裏付けがある:
//   「高流動性の帯で competing が成り立たないなら、現実的なエッジは薄い流動性へ移った
//    — 新しいローンチパッドのプールとニッチなミームコインのペアだ」
//
// [ここで測るもの(第1段・鍵不要)]
// DexScreener(無料・認証不要・300req/分)から、同じトークンの**複数DEXのプール**を取り、
//   ・両方に出来高がある(= 生きている。片方が死んでいれば売り抜ける相手が居ない)
//   ・両方に流動性がある(= 実際に入る)
// ものに絞って**価格差**を出す。そして**同じ価格差が次の観測でも残っているか**を数える。
//
//   **残る = 誰も取っていない = 放置されている。** これがオーナーの問いへの直接の答え。
//
// [これは「ふるい」であって「お金」ではない]
// DexScreener の価格は各DEXの観測値で、**実際に約定できる額ではない**。
// 我々は今日この罠を踏んでいる(§8-1「ふるいの利益を取り逃した金と読んではいけない」)。
// ここで分かるのは**「どこを見るべきか」**だけ。実行可能かの確定は第2段でやる。
//
// [第2段(未実装・**オーナーの作業が要る**)]
// Jupiter の見積りAPIは `dexes` パラメータで**特定のDEXだけに絞った見積り**が取れる。
// 「Aで買ってBで売る」の往復を実際に見積もれば、我々の simulateRoute と同じ「真実」になる。
// ただし `lite-api.jup.ag` は2026年1月31日に廃止され、`api.jup.ag` は **`x-api-key` が必須**
// (無料枠はあるが、ログインして鍵を発行する必要がある)。
// 鍵をもらえたら `SOLANA_JUPITER_KEY` に入れて第2段を作る。
//
// [対照群を必ず置く]
// 既定のトークンに SOL/USDC のような主要通貨を入れてある。**ここに大きな価格差が
// 継続的に出たら、測り方が壊れている。** 0に近いことを確認するための対照。
//
// [環境変数]
//   SOLANA_PROBE_TOKENS      … 調べるトークンのmint(カンマ区切り)
//   SOLANA_PROBE_INTERVAL_MS … 間隔(既定10分)
//   SOLANA_MIN_LIQUIDITY_USD … 薄い方のプールの下限(既定$5,000)
//   SOLANA_MIN_VOLUME_H24    … 両方に要る24h出来高の下限(既定$1,000)
//   SOLANA_SPREAD_BPS        … 「価格差あり」とみなす線(既定30bps)

import { readPairs, findSpreads } from "./solana-parse.js";

const API_BASE = process.env.SOLANA_DEXSCREENER_BASE || "https://api.dexscreener.com";

/// 調べるトークン。**mint を間違えてもペアが0件になるだけで、嘘の信号にはならない**
/// (存在しない住所には何も返らない)。返ってきた銘柄名をログに出すので目で確認できる。
/// 既定は「対照群(主要通貨)+ 出来高のある中位」。
const DEFAULT_TOKENS = [
  "So11111111111111111111111111111111111111112",  // SOL(対照)
  "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",  // USDC(対照)
  "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263",  // BONK
  "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN",   // JUP
  "4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R",  // RAY
  "EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm",  // WIF
];
const TOKENS = (process.env.SOLANA_PROBE_TOKENS || DEFAULT_TOKENS.join(","))
  .split(",").map((s) => s.trim()).filter(Boolean);

export const SOLANA_PROBE_INTERVAL_MS = parseInt(process.env.SOLANA_PROBE_INTERVAL_MS || String(10 * 60 * 1000), 10);
const MIN_LIQ = parseFloat(process.env.SOLANA_MIN_LIQUIDITY_USD || "5000");
const MIN_VOL = parseFloat(process.env.SOLANA_MIN_VOLUME_H24 || "1000");
const SPREAD_BPS = parseFloat(process.env.SOLANA_SPREAD_BPS || "30");
const FETCH_TIMEOUT_MS = parseInt(process.env.SOLANA_FETCH_TIMEOUT_MS || "8000", 10);

/// 端点の形が版によって違うため、**通った方を覚えて次から使う**。
/// 推測で1つに決め打ちすると、外れた時に黙って0件になる(いちばん困る壊れ方)。
const ENDPOINTS = [
  (t) => `${API_BASE}/latest/dex/tokens/${t}`,
  (t) => `${API_BASE}/token-pairs/v1/solana/${t}`,
  (t) => `${API_BASE}/latest/dex/search?q=${encodeURIComponent(t)}`,
];
let workingEndpoint = null;

const stats = {
  samples: 0, tokensSeen: 0, pairsSeen: 0, comparable: 0,
  withSpread: 0, persisted: 0, best: null, controlBps: null, lastError: null,
};
/// 「前回も価格差があったか」。key -> 連続回数。**これが「放置」の証拠。**
const streak = new Map();

async function fetchJson(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: ctrl.signal, headers: { accept: "application/json" } });
    if (!res.ok) return { ok: false, status: res.status };
    return { ok: true, body: await res.json() };
  } catch (e) {
    return { ok: false, status: (e.message || "").slice(0, 40) };
  } finally {
    clearTimeout(timer);
  }
}

/// 1トークンぶんのペアを取る。通る端点を探し、見つけたら覚える。
async function fetchPairsFor(token) {
  const order = workingEndpoint != null
    ? [ENDPOINTS[workingEndpoint], ...ENDPOINTS.filter((_, i) => i !== workingEndpoint)]
    : ENDPOINTS;
  for (const make of order) {
    const r = await fetchJson(make(token));
    if (!r.ok) { stats.lastError = `${r.status}`; continue; }
    const pairs = readPairs(r.body);
    if (pairs.length > 0) {
      const idx = ENDPOINTS.indexOf(make);
      if (workingEndpoint !== idx) {
        workingEndpoint = idx;
        console.log(`[Solana計測] 端点${idx + 1}番が通りました(${make("<mint>")})`);
      }
      return pairs;
    }
  }
  return [];
}

/// 1回ぶん測る。**注文も送金も一切しない。読んで計算するだけ。**
export async function probeSolanaOnce() {
  stats.samples++;
  const seenThisRound = new Set();
  let tokens = 0, pairsTotal = 0, comparable = 0, withSpread = 0, persisted = 0;

  for (const token of TOKENS) {
    const pairs = await fetchPairsFor(token);
    if (pairs.length === 0) continue;
    tokens++;
    pairsTotal += pairs.length;

    // solana のペアだけに絞る(search は他チェーンも返しうる)。
    const solana = pairs.filter((p) => p.base && p.quote);
    const spreads = findSpreads(solana, { minLiquidityUsd: MIN_LIQ, minVolumeH24: MIN_VOL });
    comparable += spreads.length;

    for (const s of spreads) {
      const key = `${s.key}|${s.low.dexId}|${s.high.dexId}`;
      seenThisRound.add(key);
      if (s.spreadBps < SPREAD_BPS) { streak.delete(key); continue; }
      withSpread++;
      const n = (streak.get(key) || 0) + 1;
      streak.set(key, n);
      if (n >= 2) persisted++;

      if (stats.best == null || s.spreadBps > stats.best.spreadBps) {
        stats.best = {
          what: `${s.baseSymbol}/${s.quoteSymbol}`, spreadBps: s.spreadBps,
          low: s.low.dexId, high: s.high.dexId,
          thinLiquidityUsd: s.thinLiquidityUsd, volumeUsd: s.volumeUsd, streak: n,
        };
      }
      // **対照群。** SOL/USDC のような主要ペアに継続的な差が出たら測り方が壊れている。
      if (s.baseSymbol === "SOL" && (s.quoteSymbol === "USDC" || s.quoteSymbol === "USDT")) {
        stats.controlBps = s.spreadBps;
      }
    }
  }
  // 今回見えなかった組は連続を切る(取られた、または条件を外れた)。
  for (const k of [...streak.keys()]) if (!seenThisRound.has(k)) streak.delete(k);

  stats.tokensSeen = tokens;
  stats.pairsSeen = pairsTotal;
  stats.comparable = comparable;
  stats.withSpread = withSpread;
  stats.persisted = persisted;
}

/// 生存ログ用の1行。
export function formatSolanaLine() {
  if (stats.samples === 0) return "";
  const b = stats.best;
  const control = stats.controlBps != null ? `対照SOL/USDC ${stats.controlBps.toFixed(1)}bps` : "対照まだ";
  const bestPart = b
    ? ` 最大${b.spreadBps.toFixed(0)}bps(${b.what} ${b.low}→${b.high} 薄い側$${Math.round(b.thinLiquidityUsd).toLocaleString()} 24h$${Math.round(b.volumeUsd).toLocaleString()} 連続${b.streak})`
    : "";
  const err = stats.lastError && stats.pairsSeen === 0 ? ` 取得失敗[${stats.lastError}]` : "";
  return ` Solana計測[${stats.samples}回目 銘柄${stats.tokensSeen} ペア${stats.pairsSeen} 比較可${stats.comparable} ${SPREAD_BPS}bps超${stats.withSpread}(**連続で残る${stats.persisted}**) ${control}${bestPart}${err}]`;
}

export function getSolanaStats() { return { ...stats, tracking: streak.size }; }
export function getSolanaTokenCount() { return TOKENS.length; }
