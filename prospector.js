/**
 * 裁定機会の網羅的精査エンジン
 * ------------------------------------------------------------
 * [重大な発見と方針転換]
 * 実測の結果、観測されている価格差はほぼ全て0.02〜0.5%だった。一方、
 * 必要な最低ラインは「DEX手数料0.3%×2回 + Aave0.05% = 0.65%」。
 * つまり構造的に利益が出ない組み合わせばかりを追っていた。
 *
 * 突破口は価格差ではなく手数料側にある。手数料0.05%の安定通貨プール
 * (stable型)なら必要ラインは0.15%まで下がり、実際に観測されている
 * 0.2〜0.5%の価格差で黒字になる。
 *
 * そこで:
 *   ①安定通貨ペアを候補に含める(流動性が大きくても除外しない)
 *   ②手数料の低いプールを持つペアを優先する
 * という設計に変更した。
 */

import { CHAIN_CONFIG } from "./chain-config.js";

const DEFILLAMA_POOLS = "https://yields.llama.fi/pools";
const PROSPECTOR_FETCH_TIMEOUT_MS = 25000;

const SUPPORTED_CHAINS = new Set(Object.keys(CHAIN_CONFIG));

const TARGET_MIN_TVL_USD = 30_000;
const TARGET_MAX_TVL_USD = 3_000_000;
// 安定通貨ペアは流動性が数千万ドル規模でも、手数料が低く(0.01〜0.05%)
// 必要な価格差のラインが格段に低いため、上限の例外として扱う。
const STABLE_PAIR_MAX_TVL_USD = 200_000_000;

// 主要な安定通貨のシンボル(DeFiLlamaのsymbol欄との照合用)。
const STABLE_SYMBOLS = new Set([
  "USDC", "USDT", "DAI", "FRAX", "LUSD", "MAI", "USDC.E", "USDCE",
  "BUSD", "TUSD", "USDD", "GHO", "CRVUSD", "USDE", "SUSD", "DOLA", "USDS",
]);

// 価格が連動する資産同士(価格差が小さく、低手数料プールが使われる)。
const PEGGED_GROUPS = [
  new Set(["WETH", "ETH", "WSTETH", "STETH", "RETH", "CBETH", "WEETH", "EZETH"]),
  new Set(["WBTC", "BTC", "CBBTC", "TBTC", "BTCB"]),
  new Set(["WMATIC", "MATIC", "POL", "STMATIC", "MATICX"]),
  new Set(["WAVAX", "AVAX", "SAVAX"]),
];

function splitSymbols(symbol) {
  return (symbol || "").toUpperCase().split(/[-/]/).map((s) => s.trim()).filter(Boolean);
}

/// 価格が連動する2資産のペアか(安定通貨同士、ETH系同士など)。
/// こういうペアは低手数料のstableプールが使われることが多い。
export function isPeggedPair(symbol) {
  const parts = splitSymbols(symbol);
  if (parts.length !== 2) return false;
  const [a, b] = parts;
  if (STABLE_SYMBOLS.has(a) && STABLE_SYMBOLS.has(b)) return true;
  for (const group of PEGGED_GROUPS) {
    if (group.has(a) && group.has(b)) return true;
  }
  return false;
}

const CHAIN_PREFERENCE = {
  avalanche: 2.0,
  arbitrum: 1.4,
  polygon: 1.3,
  optimism: 0.7,
  base: 0.6,
};

async function fetchWithTimeout(url, timeoutMs = PROSPECTOR_FETCH_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try { return await fetch(url, { signal: controller.signal }); }
  finally { clearTimeout(timer); }
}

const DEX_KEYWORDS = [
  "swap", "dex", "uniswap", "sushi", "curve", "balancer", "pancake",
  "velodrome", "aerodrome", "camelot", "trader-joe", "quickswap",
  "spooky", "spirit", "solidly", "ramses", "thena", "biswap",
  "dodo", "kyber", "shibaswap", "baseswap", "alienbase", "swapbased",
  "beethoven", "maverick", "syncswap", "izumi", "wombat",
  "fraxswap", "pangolin", "honeyswap", "apeswap", "elk", "netswap",
  "zyberswap", "arbidex", "chronos", "solidlizard", "sterling",
  "equalizer", "nile", "cleo", "lynex", "nuri", "blackhole",
  "jetswap", "polyzap", "dfyn", "polycat", "waultswap", "infusion",
  "swapr", "deltaswap", "windswap", "pendle", "lydiafinance",
];

export function isDexProject(project) {
  const p = (project || "").toLowerCase();
  return DEX_KEYWORDS.some((k) => p.includes(k));
}

export async function fetchAllPools() {
  const res = await fetchWithTimeout(DEFILLAMA_POOLS);
  if (!res.ok) throw new Error(`DeFiLlama HTTP ${res.status}`);
  const json = await res.json();
  return json.data || [];
}

export function findArbitragablePairs(pools, { minTvlUSD = TARGET_MIN_TVL_USD } = {}) {
  const groups = new Map();
  let dexPoolCount = 0, unsupportedChainCount = 0;

  for (const p of pools) {
    if (!isDexProject(p.project)) continue;
    if (!p.underlyingTokens || p.underlyingTokens.length !== 2) continue;
    if ((p.tvlUsd || 0) < minTvlUSD) continue;
    if (!SUPPORTED_CHAINS.has((p.chain || "").toLowerCase())) { unsupportedChainCount++; continue; }
    dexPoolCount++;

    const toks = p.underlyingTokens.map((t) => String(t).toLowerCase());
    if (toks[0] === toks[1]) continue;
    const key = p.chain + "||" + [...toks].sort().join("|");

    if (!groups.has(key)) {
      groups.set(key, { chain: p.chain, symbol: p.symbol, tokenA: toks[0], tokenB: toks[1], venues: new Map() });
    }
    const g = groups.get(key);
    const proj = (p.project || "").toLowerCase();
    const prev = g.venues.get(proj);
    if (!prev || p.tvlUsd > prev.tvlUsd) {
      g.venues.set(proj, { project: proj, tvlUsd: p.tvlUsd, volumeUsd1d: p.volumeUsd1d ?? null, poolId: p.pool });
    }
  }

  const arbitragable = [];
  for (const g of groups.values()) {
    if (g.venues.size < 2) continue;
    const venues = [...g.venues.values()].sort((a, b) => b.tvlUsd - a.tvlUsd);
    const tvls = venues.map((v) => v.tvlUsd);
    const totalTvl = tvls.reduce((s, v) => s + v, 0);
    const totalVol = venues.reduce((s, v) => s + (v.volumeUsd1d || 0), 0);

    arbitragable.push({
      chain: g.chain, symbol: g.symbol, tokenA: g.tokenA, tokenB: g.tokenB,
      venueCount: venues.length, venues,
      pegged: isPeggedPair(g.symbol),
      minTvl: Math.min(...tvls), totalTvl, totalVol1d: totalVol,
      turnover: totalTvl > 0 ? totalVol / totalTvl : 0,
    });
  }

  return { arbitragable, dexPoolCount, unsupportedChainCount, groupCount: groups.size, totalPools: pools.length };
}

export function summarizeByChain(arbitragable) {
  const byChain = new Map();
  for (const a of arbitragable) {
    if (!byChain.has(a.chain)) byChain.set(a.chain, { chain: a.chain, pairCount: 0, peggedCount: 0, dexes: new Set() });
    const c = byChain.get(a.chain);
    c.pairCount++;
    if (a.pegged) c.peggedCount++;
    for (const v of a.venues) c.dexes.add(v.project);
  }
  return [...byChain.values()]
    .map((c) => ({ chain: c.chain, pairCount: c.pairCount, peggedCount: c.peggedCount, dexCount: c.dexes.size, dexList: [...c.dexes] }))
    .sort((a, b) => b.pairCount - a.pairCount);
}

export function scoreOpportunity(a) {
  const tvl = Math.max(a.minTvl, 1);

  // 価格が連動するペア(安定通貨同士など)は、低手数料プールが使われるため
  // 必要な価格差のラインが格段に低い。流動性が大きくても除外せず、強く優遇する。
  if (a.pegged) {
    if (tvl > STABLE_PAIR_MAX_TVL_USD) return 0;
    const venueScore = Math.min(a.venueCount, 5) / 2;
    const chainScore = CHAIN_PREFERENCE[(a.chain || "").toLowerCase()] ?? 1.0;
    // 手数料の壁が低いぶん、通常ペアの3倍の重みを与える。
    return 3.0 * venueScore * chainScore;
  }

  // 通常ペアは従来通り「ほどよい大きさで静か」を狙う。
  if (tvl > TARGET_MAX_TVL_USD) return 0;
  const sizeScore = 1 / (1 + Math.abs(Math.log10(tvl / 300_000)));
  const quietScore = a.turnover > 0 ? 1 / (1 + a.turnover * 3) : 1;
  const venueScore = Math.min(a.venueCount, 4) / 2;
  const chainScore = CHAIN_PREFERENCE[(a.chain || "").toLowerCase()] ?? 1.0;
  return sizeScore * quietScore * venueScore * chainScore;
}

export async function runProspect({ minTvlUSD = TARGET_MIN_TVL_USD, topN = 150 } = {}) {
  const pools = await fetchAllPools();
  const { arbitragable, dexPoolCount, unsupportedChainCount, groupCount, totalPools } = findArbitragablePairs(pools, { minTvlUSD });

  const peggedCount = arbitragable.filter((a) => a.pegged).length;
  console.log(`[Prospector] 対応5チェーンで候補${arbitragable.length}件(うち価格連動ペア${peggedCount}件 / 未対応チェーン${unsupportedChainCount}件を除外)`);

  const scored = arbitragable
    .map((a) => ({ ...a, score: scoreOpportunity(a) }))
    .filter((a) => a.score > 0)
    .sort((x, y) => y.score - x.score);

  const selected = scored.slice(0, topN);
  const topChains = {};
  for (const a of selected) topChains[a.chain] = (topChains[a.chain] || 0) + 1;
  const selectedPegged = selected.filter((a) => a.pegged).length;
  console.log(`[Prospector] 選定した${selected.length}件の内訳: ${Object.entries(topChains).map(([c, n]) => `${c}:${n}`).join(" / ")} / 価格連動ペア${selectedPegged}件`);

  return {
    scannedAt: new Date().toISOString(),
    stats: { totalPools, dexPoolCount, unsupportedChainCount, groupCount, arbitragableCount: arbitragable.length, peggedCount },
    chainSummary: summarizeByChain(arbitragable).slice(0, 30),
    arbitragableRaw: arbitragable,
    topPairs: selected.map((a) => ({
      chain: a.chain, symbol: a.symbol, tokenA: a.tokenA, tokenB: a.tokenB,
      venueCount: a.venueCount, minTvl: a.minTvl, turnover: a.turnover, score: a.score, pegged: a.pegged,
      venues: a.venues.map((v) => ({ project: v.project, tvlUsd: v.tvlUsd })),
    })),
    quietPairs: [],
  };
}
