/**
 * 裁定機会の網羅的精査エンジン
 * ------------------------------------------------------------
 * DeFiLlamaの全プールデータから、「同一チェーン上で同じトークンペアが
 * 複数のDEXに存在する」組み合わせを洗い出し、裁定候補としてランキングする。
 *
 * [方針1] 流動性が大きいほど高評価という設計を逆転させた。実測の結果、
 * 大型ペアは専業MEV botが常時監視しており、価格差が常に0.0〜0.4%で
 * 手数料(往復0.6%+Aave0.05%)を超えることが無かった。逆に中小プールでは
 * 2%超の価格差が実測された。
 *
 * [方針2] 「ルーター確認済みDEXが2つ以上」という条件を撤廃した。
 * コントラクトがプールを直接呼ぶ方式になり、DEXの種類を問わず実行
 * できるようになったため。この条件が候補の69%を捨てていた。
 * 代わりに、コントラクトをデプロイ済みのチェーンかどうかだけを見る。
 */

import { CHAIN_CONFIG } from "./chain-config.js";

const DEFILLAMA_POOLS = "https://yields.llama.fi/pools";
const PROSPECTOR_FETCH_TIMEOUT_MS = 25000;

// コントラクトをデプロイ済みのチェーンだけを対象にする。
const SUPPORTED_CHAINS = new Set(Object.keys(CHAIN_CONFIG));

const TARGET_MIN_TVL_USD = 30_000;
const TARGET_MAX_TVL_USD = 3_000_000;

// ガス代の実測値(1回あたり)と主要DEXの実測手数料を反映した優先度:
//   avalanche $0.0012 … 桁違いに安い。手数料も0.3%。最優先。
//   arbitrum  $0.0300 … 手数料0.3%のDEXが多く有利。
//   polygon   $0.0320 … ガス代は高いがDEXの数が多い。
//   optimism  $0.0100 … Velodromeの手数料が実測約1%で不利。
//   base      $0.0243 … Aerodromeの手数料が実測99bps(約1%)で最も不利。
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
  "swapr", "deltaswap", "windswap", "pendle",
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
      minTvl: Math.min(...tvls), totalTvl, totalVol1d: totalVol,
      turnover: totalTvl > 0 ? totalVol / totalTvl : 0,
    });
  }

  return { arbitragable, dexPoolCount, unsupportedChainCount, groupCount: groups.size, totalPools: pools.length };
}

export function summarizeByChain(arbitragable) {
  const byChain = new Map();
  for (const a of arbitragable) {
    if (!byChain.has(a.chain)) byChain.set(a.chain, { chain: a.chain, pairCount: 0, totalTvl: 0, dexes: new Set() });
    const c = byChain.get(a.chain);
    c.pairCount++;
    c.totalTvl += a.totalTvl;
    for (const v of a.venues) c.dexes.add(v.project);
  }
  return [...byChain.values()]
    .map((c) => ({ chain: c.chain, pairCount: c.pairCount, dexCount: c.dexes.size, dexList: [...c.dexes], totalTvl: c.totalTvl }))
    .sort((a, b) => b.pairCount - a.pairCount);
}

export function scoreOpportunity(a) {
  // 流動性は「ほどよい大きさ」が最良。$30万を中心に、離れるほど減点。
  const tvl = Math.max(a.minTvl, 1);
  if (tvl > TARGET_MAX_TVL_USD) return 0;
  const sizeScore = 1 / (1 + Math.abs(Math.log10(tvl / 300_000)));

  // 取引が静かなほど、価格差が埋められずに残りやすい。
  const quietScore = a.turnover > 0 ? 1 / (1 + a.turnover * 3) : 1;

  // プールの数が多いほど、組み合わせも増える。
  const venueScore = Math.min(a.venueCount, 4) / 2;

  const chainScore = CHAIN_PREFERENCE[(a.chain || "").toLowerCase()] ?? 1.0;

  return sizeScore * quietScore * venueScore * chainScore;
}

export async function runProspect({ minTvlUSD = TARGET_MIN_TVL_USD, topN = 150 } = {}) {
  const pools = await fetchAllPools();
  const { arbitragable, dexPoolCount, unsupportedChainCount, groupCount, totalPools } = findArbitragablePairs(pools, { minTvlUSD });

  console.log(`[Prospector] 対応5チェーンで候補${arbitragable.length}件(未対応チェーンのプール${unsupportedChainCount}件を除外)`);

  const chainSummary = summarizeByChain(arbitragable);
  console.log(`[Prospector] チェーン別: ${chainSummary.map((c) => `${c.chain}:${c.pairCount}件`).join(" / ")}`);

  const scored = arbitragable
    .map((a) => ({ ...a, score: scoreOpportunity(a) }))
    .filter((a) => a.score > 0)
    .sort((x, y) => y.score - x.score);

  const topChains = {};
  for (const a of scored.slice(0, topN)) topChains[a.chain] = (topChains[a.chain] || 0) + 1;
  console.log(`[Prospector] 選定した${Math.min(scored.length, topN)}件の内訳: ${Object.entries(topChains).map(([c, n]) => `${c}:${n}`).join(" / ")}`);

  return {
    scannedAt: new Date().toISOString(),
    stats: { totalPools, dexPoolCount, unsupportedChainCount, groupCount, arbitragableCount: arbitragable.length },
    chainSummary: chainSummary.slice(0, 30),
    arbitragableRaw: arbitragable,
    topPairs: scored.slice(0, topN).map((a) => ({
      chain: a.chain, symbol: a.symbol, tokenA: a.tokenA, tokenB: a.tokenB,
      venueCount: a.venueCount, minTvl: a.minTvl, turnover: a.turnover, score: a.score,
      venues: a.venues.map((v) => ({ project: v.project, tvlUsd: v.tvlUsd })),
    })),
    quietPairs: [],
  };
}
