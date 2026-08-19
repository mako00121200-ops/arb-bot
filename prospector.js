/**
 * 裁定機会の網羅的精査エンジン(モジュール版)
 * ------------------------------------------------------------
 * DeFiLlamaの全プールデータから、「同一チェーン上で同じトークンペアが
 * 複数のDEXに存在する」組み合わせを洗い出し、裁定候補としてランキングする。
 *
 * 読み取り専用でガス代は一切かからないため、定期実行して
 * 時間帯ごとの傾向や新しいチェーンの出現を継続的に観測する。
 */

const DEFILLAMA_POOLS = "https://yields.llama.fi/pools";

const DEX_KEYWORDS = [
  "swap", "dex", "uniswap", "sushi", "curve", "balancer", "pancake",
  "velodrome", "aerodrome", "camelot", "trader-joe", "quickswap",
  "spooky", "spirit", "solidly", "ramses", "thena", "biswap",
  "dodo", "kyber", "shibaswap", "baseswap", "alienbase", "swapbased",
  "beethoven", "maverick", "syncswap", "izumi", "wombat",
  "fraxswap", "pangolin", "honeyswap", "apeswap", "elk", "netswap",
  "zyberswap", "arbidex", "chronos", "solidlizard", "sterling",
  "equalizer", "nile", "cleo", "lynex", "nuri", "blackhole",
];

export function isDexProject(project) {
  const p = (project || "").toLowerCase();
  return DEX_KEYWORDS.some((k) => p.includes(k));
}

export async function fetchAllPools() {
  const res = await fetch(DEFILLAMA_POOLS);
  if (!res.ok) throw new Error(`DeFiLlama HTTP ${res.status}`);
  const json = await res.json();
  return json.data || [];
}

/** 複数DEXに存在するトークンペアを抽出する */
export function findArbitragablePairs(pools, { minTvlUSD = 10000 } = {}) {
  const groups = new Map();
  let dexPoolCount = 0;

  for (const p of pools) {
    if (!isDexProject(p.project)) continue;
    if (!p.underlyingTokens || p.underlyingTokens.length !== 2) continue;
    if ((p.tvlUsd || 0) < minTvlUSD) continue;
    dexPoolCount++;

    const toks = p.underlyingTokens.map((t) => String(t).toLowerCase());
    if (toks[0] === toks[1]) continue;
    const key = p.chain + "||" + [...toks].sort().join("|");

    if (!groups.has(key)) {
      groups.set(key, {
        chain: p.chain, symbol: p.symbol,
        tokenA: toks[0], tokenB: toks[1], venues: new Map(),
      });
    }
    const g = groups.get(key);
    const proj = (p.project || "").toLowerCase();
    const prev = g.venues.get(proj);
    if (!prev || p.tvlUsd > prev.tvlUsd) {
      g.venues.set(proj, {
        project: proj, tvlUsd: p.tvlUsd,
        volumeUsd1d: p.volumeUsd1d ?? null, poolId: p.pool,
      });
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
      chain: g.chain, symbol: g.symbol,
      tokenA: g.tokenA, tokenB: g.tokenB,
      venueCount: venues.length, venues,
      minTvl: Math.min(...tvls), totalTvl, totalVol1d: totalVol,
      turnover: totalTvl > 0 ? totalVol / totalTvl : 0,
    });
  }

  return { arbitragable, dexPoolCount, groupCount: groups.size, totalPools: pools.length };
}

export function summarizeByChain(arbitragable) {
  const byChain = new Map();
  for (const a of arbitragable) {
    if (!byChain.has(a.chain)) {
      byChain.set(a.chain, {
        chain: a.chain, pairCount: 0, totalTvl: 0, totalVol: 0,
        dexes: new Set(), quietPairs: 0,
      });
    }
    const c = byChain.get(a.chain);
    c.pairCount++;
    c.totalTvl += a.totalTvl;
    c.totalVol += a.totalVol1d;
    for (const v of a.venues) c.dexes.add(v.project);
    if (a.turnover > 0 && a.turnover < 0.05 && a.minTvl >= 50000) c.quietPairs++;
  }
  return [...byChain.values()]
    .map((c) => ({
      chain: c.chain, pairCount: c.pairCount, dexCount: c.dexes.size,
      dexList: [...c.dexes], totalTvl: c.totalTvl, quietPairs: c.quietPairs,
      turnover: c.totalTvl > 0 ? c.totalVol / c.totalTvl : 0,
    }))
    .sort((a, b) => b.pairCount - a.pairCount);
}

/** 流動性 × 場の多さ × 静かさ でスコアリング */
export function scoreOpportunity(a) {
  const liquidityScore = Math.log10(Math.max(a.minTvl, 1));
  const venueScore = Math.min(a.venueCount, 5);
  const quietScore = a.turnover > 0 ? 1 / (1 + a.turnover) : 1;
  return liquidityScore * venueScore * quietScore;
}

/** 1回分の精査を実行し、結果をまとめて返す */
export async function runProspect({ minTvlUSD = 10000, topN = 50 } = {}) {
  const pools = await fetchAllPools();
  const { arbitragable, dexPoolCount, groupCount, totalPools } =
    findArbitragablePairs(pools, { minTvlUSD });

  const chainSummary = summarizeByChain(arbitragable);

  const scored = arbitragable
    .map((a) => ({ ...a, score: scoreOpportunity(a) }))
    .sort((x, y) => y.score - x.score);

  const quiet = arbitragable
    .filter((a) => a.minTvl >= 50000 && a.turnover > 0 && a.turnover < 0.05)
    .sort((a, b) => a.turnover - b.turnover);

  return {
    scannedAt: new Date().toISOString(),
    stats: { totalPools, dexPoolCount, groupCount, arbitragableCount: arbitragable.length },
    chainSummary: chainSummary.slice(0, 30),
    topPairs: scored.slice(0, topN).map((a) => ({
      chain: a.chain, symbol: a.symbol, venueCount: a.venueCount,
      minTvl: a.minTvl, turnover: a.turnover, score: a.score,
      venues: a.venues.map((v) => ({ project: v.project, tvlUsd: v.tvlUsd })),
    })),
    quietPairs: quiet.slice(0, 40).map((a) => ({
      chain: a.chain, symbol: a.symbol, venueCount: a.venueCount,
      minTvl: a.minTvl, turnover: a.turnover,
      venues: a.venues.map((v) => v.project),
    })),
  };
}
