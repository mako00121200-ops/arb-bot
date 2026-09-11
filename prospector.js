/**
 * 裁定機会の網羅的精査エンジン
 * ------------------------------------------------------------
 * DeFiLlamaの全プールデータから、「同一チェーン上で同じトークンペアが
 * 複数のDEXに存在する」組み合わせを洗い出し、裁定候補としてランキングする。
 *
 * [方針転換] 以前は流動性が大きいほど高スコアにしていたが、実測の結果
 * それは専業MEV botの狩場そのものだった。WETH-USDC等の主要ペアは
 * 価格差が常に0.0〜0.4%で、手数料(往復0.6%+Aave0.05%)を超えることが無い。
 * 逆に、専業botが相手にしない中小プールでは2%超の価格差が実測された。
 * そこで「大手が見ていない、ほどよい大きさのプール」を狙う設計に変える。
 *
 * あわせて、ルーターが確認済みのDEXが2つ以上あるペア(=実際に実行できる
 * ペア)を強く優先する。以前は実行不可能なペアの観測に枠を浪費していた。
 */

import { getRouterInfo } from "./router-addresses.js";

const DEFILLAMA_POOLS = "https://yields.llama.fi/pools";
const PROSPECTOR_FETCH_TIMEOUT_MS = 25000;

// Ethereumはガス代($8想定)が確実に価格差を食い潰すため除外。
const EXCLUDED_CHAINS = new Set(["ethereum"]);

// 狙う流動性の範囲。
//   下限: 小さすぎると1回の利益が数セントにしかならず、ガス代に見合わない。
//   上限: 大きすぎると専業botが常時監視しており、価格差が残らない。
const TARGET_MIN_TVL_USD = 30_000;
const TARGET_MAX_TVL_USD = 3_000_000;

// ガス代の実測値(2026年9月時点、フラッシュローン1回あたり)と、
// 各チェーンの主要DEXの実測手数料を反映した優先度:
//   avalanche $0.0012 … 桁違いに安い。TraderJoe/Uniswapとも0.3%。最優先。
//   arbitrum  $0.0300 … Uniswap/SushiSwapとも0.3%で有利。
//   polygon   $0.0351 … ガス代は最も高いが、DEXの数が多く機会も多い。
//   optimism  $0.0100 … Velodromeの手数料が実測約1%で不利。
//   base      $0.0242 … Aerodromeの手数料が実測99bps(約1%)で最も不利。
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
];

export function isDexProject(project) {
  const p = (project || "").toLowerCase();
  return DEX_KEYWORDS.some((k) => p.includes(k));
}

// DeFiLlamaのproject名("sushiswap-v2"等)を、DexScreenerのdexId
// ("sushiswap")に寄せてルーター確認する。
function hasConfirmedRouter(chain, project) {
  const p = (project || "").toLowerCase();
  const base = p.replace(/-v\d.*$/, "").replace(/-classic$/, "");
  return getRouterInfo(chain, base) !== null || getRouterInfo(chain, p) !== null;
}

export async function fetchAllPools() {
  const res = await fetchWithTimeout(DEFILLAMA_POOLS);
  if (!res.ok) throw new Error(`DeFiLlama HTTP ${res.status}`);
  const json = await res.json();
  return json.data || [];
}

export function findArbitragablePairs(pools, { minTvlUSD = TARGET_MIN_TVL_USD } = {}) {
  const groups = new Map();
  let dexPoolCount = 0, excludedChainCount = 0;

  for (const p of pools) {
    if (!isDexProject(p.project)) continue;
    if (!p.underlyingTokens || p.underlyingTokens.length !== 2) continue;
    if ((p.tvlUsd || 0) < minTvlUSD) continue;
    if (EXCLUDED_CHAINS.has((p.chain || "").toLowerCase())) { excludedChainCount++; continue; }
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
    const confirmedVenues = venues.filter((v) => hasConfirmedRouter(g.chain, v.project));

    arbitragable.push({
      chain: g.chain, symbol: g.symbol, tokenA: g.tokenA, tokenB: g.tokenB,
      venueCount: venues.length, venues,
      confirmedVenueCount: confirmedVenues.length,
      minTvl: Math.min(...tvls), totalTvl, totalVol1d: totalVol,
      turnover: totalTvl > 0 ? totalVol / totalTvl : 0,
    });
  }

  return { arbitragable, dexPoolCount, excludedChainCount, groupCount: groups.size, totalPools: pools.length };
}

export function summarizeByChain(arbitragable) {
  const byChain = new Map();
  for (const a of arbitragable) {
    if (!byChain.has(a.chain)) {
      byChain.set(a.chain, { chain: a.chain, pairCount: 0, executableCount: 0, totalTvl: 0, totalVol: 0, dexes: new Set() });
    }
    const c = byChain.get(a.chain);
    c.pairCount++;
    if (a.confirmedVenueCount >= 2) c.executableCount++;
    c.totalTvl += a.totalTvl;
    c.totalVol += a.totalVol1d;
    for (const v of a.venues) c.dexes.add(v.project);
  }
  return [...byChain.values()]
    .map((c) => ({ chain: c.chain, pairCount: c.pairCount, executableCount: c.executableCount, dexCount: c.dexes.size, dexList: [...c.dexes], totalTvl: c.totalTvl }))
    .sort((a, b) => b.executableCount - a.executableCount);
}

/**
 * 「大手botが見ていない、実行できるペア」を高く評価する。
 * 以前の「流動性が大きいほど高評価」を逆転させたのが最大の変更点。
 */
export function scoreOpportunity(a) {
  // ①実行できること。ルーター確認済みDEXが2つ未満なら、観測しても送信できない。
  if (a.confirmedVenueCount < 2) return 0;

  // ②流動性は「ほどよい大きさ」が最良。目標帯の中心($30万)から離れるほど減点。
  //   小さすぎる=利益が数セント、大きすぎる=専業botに埋められて価格差が残らない。
  const tvl = Math.max(a.minTvl, 1);
  if (tvl > TARGET_MAX_TVL_USD) return 0;
  const idealTvl = 300_000;
  const sizeScore = 1 / (1 + Math.abs(Math.log10(tvl / idealTvl)));

  // ③取引が静かなほど、価格差が埋められずに残りやすい。
  const quietScore = a.turnover > 0 ? 1 / (1 + a.turnover * 3) : 1;

  // ④実行できるDEXの組み合わせが多いほど、機会も増える。
  const venueScore = Math.min(a.confirmedVenueCount, 4) / 2;

  // ⑤ガス代と手数料の実測値を反映したチェーン優先度。
  const chainScore = CHAIN_PREFERENCE[(a.chain || "").toLowerCase()] ?? 1.0;

  return sizeScore * quietScore * venueScore * chainScore;
}

export async function runProspect({ minTvlUSD = TARGET_MIN_TVL_USD, topN = 150 } = {}) {
  const pools = await fetchAllPools();
  const { arbitragable, dexPoolCount, excludedChainCount, groupCount, totalPools } = findArbitragablePairs(pools, { minTvlUSD });

  const executable = arbitragable.filter((a) => a.confirmedVenueCount >= 2);
  console.log(`[Prospector] 候補${arbitragable.length}件のうち、ルーター確認済みDEXが2つ以上あるのは${executable.length}件(Ethereum除外${excludedChainCount}件)`);

  const chainSummary = summarizeByChain(arbitragable);
  console.log(`[Prospector] 実行可能な候補が多いチェーン: ${chainSummary.slice(0, 4).map((c) => `${c.chain}:${c.executableCount}件`).join(" / ")}`);

  const scored = arbitragable
    .map((a) => ({ ...a, score: scoreOpportunity(a) }))
    .filter((a) => a.score > 0)
    .sort((x, y) => y.score - x.score);

  const topChains = {};
  for (const a of scored.slice(0, topN)) topChains[a.chain] = (topChains[a.chain] || 0) + 1;
  console.log(`[Prospector] 選定した${Math.min(scored.length, topN)}件の内訳: ${Object.entries(topChains).map(([c, n]) => `${c}:${n}`).join(" / ")}`);

  return {
    scannedAt: new Date().toISOString(),
    stats: { totalPools, dexPoolCount, excludedChainCount, groupCount, arbitragableCount: arbitragable.length, executableCount: executable.length },
    chainSummary: chainSummary.slice(0, 30),
    arbitragableRaw: arbitragable,
    topPairs: scored.slice(0, topN).map((a) => ({
      chain: a.chain, symbol: a.symbol, tokenA: a.tokenA, tokenB: a.tokenB,
      venueCount: a.venueCount, confirmedVenueCount: a.confirmedVenueCount,
      minTvl: a.minTvl, turnover: a.turnover, score: a.score,
      venues: a.venues.map((v) => ({ project: v.project, tvlUsd: v.tvlUsd })),
    })),
    quietPairs: [],
  };
}
