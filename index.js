import http from "http";
import fs from "fs";
import { runProspect } from "./prospector.js";
import { startOnchainFeeds, updatePoolSubscriptions } from "./dex-onchain-realtime.js";

const DEX_FETCH_TIMEOUT_MS = 20000;

async function dexFetchWithTimeout(url, timeoutMs = DEX_FETCH_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

// 1回の取引の上限額(USD)。理論上の最適額がこれより小さければそのまま
// 使い(過剰投入で非効率になるのを防ぐ)、上限を超える場合だけこの額で
// キャップする(資金不足で負けが続かないようにするため)。
// 現状は自動売買を実装していないため、この値はシミュレーション上の
// 想定としてのみ使われている。
const MAX_TRADE_USD = parseFloat(process.env.MAX_TRADE_USD || "300");

function dexGetAmountOut(amountIn, reserveIn, reserveOut, feeRetain) {
  if (amountIn <= 0) return 0;
  const amountInWithFee = amountIn * feeRetain;
  return (reserveOut * amountInWithFee) / (reserveIn + amountInWithFee);
}

// 任意の投入量(Yトークン建て)でのプロフィットを計算する共通関数。
function dexSimulateProfitForAmount(pool1, pool2, amountIn) {
  const xOut = dexGetAmountOut(amountIn, pool1.reserveY, pool1.reserveX, 1 - pool1.fee);
  const yOut = dexGetAmountOut(xOut, pool2.reserveX, pool2.reserveY, 1 - pool2.fee);
  return yOut - amountIn;
}

function dexComputeOptimalArbitrage(pool1, pool2) {
  const a = pool1.reserveY;
  const A = pool1.reserveX;
  const X2 = pool2.reserveX;
  const Y2 = pool2.reserveY;
  const g1 = 1 - pool1.fee;
  const g2 = 1 - pool2.fee;

  const P = Y2 * g2 * A;
  const Q = X2 * a;
  const R = X2 + g2 * A;
  const inner = g1 * P * Q;

  if (inner <= Q * Q) {
    return { amountIn: 0, grossProfit: 0, profitable: false };
  }

  const s = Math.sqrt(inner) - Q;
  const theoreticalAmountIn = s / (g1 * R);

  if (theoreticalAmountIn <= 0) {
    return { amountIn: 0, grossProfit: 0, profitable: false };
  }

  let bestT = theoreticalAmountIn;
  let bestProfit = dexSimulateProfitForAmount(pool1, pool2, theoreticalAmountIn);

  for (let mult = 0.5; mult <= 1.5; mult += 0.01) {
    const t = theoreticalAmountIn * mult;
    const p = dexSimulateProfitForAmount(pool1, pool2, t);
    if (p > bestProfit) {
      bestProfit = p;
      bestT = t;
    }
  }

  return { amountIn: bestT, grossProfit: bestProfit, profitable: bestProfit > 0 };
}

// cheapPool.priceUsdPerY を使って上限額($300)をYトークン建てに換算し、
// 「理論上の最適額」と「上限額」の小さい方を実際の投入量として使う。
function dexEvaluateOpportunity({ cheapPool, expensivePool, gasCostUsd, maxTradeAmountUsd, slippageBuffer = 0, pairLabel = "" }) {
  const priceCheap = cheapPool.reserveY / cheapPool.reserveX;
  const priceExpensive = expensivePool.reserveY / expensivePool.reserveX;
  const priceDiffPercent = ((priceExpensive - priceCheap) / priceCheap) * 100;

  const priceUsdPerY = cheapPool.priceUsdPerY;
  const maxTradeAmountIn = maxTradeAmountUsd / priceUsdPerY;
  const gasCostInY = gasCostUsd / priceUsdPerY;

  const optimalResult = dexComputeOptimalArbitrage(cheapPool, expensivePool);

  // 実際に使う投入量: 理論上の最適額と上限額の小さい方。
  const actualTradeAmountIn = Math.min(optimalResult.amountIn, maxTradeAmountIn);
  const cappedByBudget = optimalResult.amountIn > maxTradeAmountIn;

  const actualGrossProfitY = dexSimulateProfitForAmount(cheapPool, expensivePool, actualTradeAmountIn);
  const actualSlippageCostY = actualGrossProfitY * slippageBuffer;
  const actualNetProfitY = actualGrossProfitY - gasCostInY - actualSlippageCostY;

  return {
    timestamp: new Date().toISOString(),
    pairLabel,
    priceDiffPercent,
    tradeAmountUsd: actualTradeAmountIn * priceUsdPerY,
    tradeAmountIn: actualTradeAmountIn,
    grossProfit: actualGrossProfitY * priceUsdPerY,
    gasCostInY: gasCostUsd,
    slippageCost: actualSlippageCostY * priceUsdPerY,
    netProfit: actualNetProfitY * priceUsdPerY,
    profitable: actualNetProfitY > 0,
    optimalAmountIn: optimalResult.amountIn,
    optimalGrossProfitUsd: optimalResult.grossProfit * priceUsdPerY,
    cappedByBudget,
  };
}

const DEXSCREENER_TOKEN_API = "https://api.dexscreener.com/latest/dex/tokens/";
const DEX_LOG_FILE = process.env.WATCHER_LOG_FILE || "/tmp/dex-arb-observations.json";
const DEX_STATS_FILE = process.env.STATS_FILE || "/tmp/dex-arb-stats.json";

const DEX_DEFAULT_FEE_BY_DEX = {
  uniswap: 0.003,
  aerodrome: 0.0005,
  "aerodrome-slipstream": 0.0005,
  sushiswap: 0.003,
  camelot: 0.003,
  velodrome: 0.0005,
  default: 0.003,
};

function dexGetFeeForDex(dexId) {
  return DEX_DEFAULT_FEE_BY_DEX[(dexId || "").toLowerCase()] ?? DEX_DEFAULT_FEE_BY_DEX.default;
}

// DeFiLlamaとDexScreenerでチェーンの表記が一致しない場合がある。
// 特にOptimismはDeFiLlamaが"OP Mainnet"、DexScreenerが"optimism"と
// 表記しており、変換しないと候補が常に0件になってしまっていた。
function dexNormalizeChain(chain) {
  const map = {
    base: "base",
    arbitrum: "arbitrum",
    optimism: "optimism",
    "op mainnet": "optimism",
    ethereum: "ethereum",
  };
  return map[(chain || "").toLowerCase()] || (chain || "").toLowerCase();
}

// チェーンごとの想定ガス代(USD)。イーサリアムL1はL2群より一桁以上高いため、
// 一律の値を使うと「小さな価格差」を誤って黒字判定してしまう。
// bsc/binance/bnbは、DeFiLlamaがどの表記を使っているか未確定なため
// 念のため全パターンを登録している。
const CHAIN_GAS_COST_USD = {
  base: 0.05,
  arbitrum: 0.10,
  optimism: 0.05,
  ethereum: 8.0,
  polygon: 0.05,
  avalanche: 0.05,
  bsc: 0.10,
  binance: 0.10,
  bnb: 0.10,
  flare: 0.02,
};
function getGasCostForChain(chain) {
  const key = dexNormalizeChain(chain);
  return CHAIN_GAS_COST_USD[key] ?? 0.25;
}

// 両プールとも流動性が厚い(=プロのbotが常時監視している)のに
// 大きな価格差が残っている場合、本物の機会ではなくデータ取得時の
// ズレ・プール種別の誤判定である可能性が高い(WETH-USDC on Base で
// 2回実際に確認済み: PancakeSwap V3プールが除外の網をすり抜けていた)。
// 厚いプール同士は許容する価格差を厳しく制限する
// (薄いプール側が絡む場合は適用しない)。
const DEEP_POOL_LIQUIDITY_USD = 500000;
const DEEP_POOL_MAX_GAP_PCT = 1;

// 取引がほぼ枯れている(=事実上稼働停止している)プールを除外する基準。
// ZipSwapの実例(24時間の取引0件・出来高$13.7)で確認済み。
const DEAD_POOL_MIN_VOLUME_USD = 50;
const DEAD_POOL_MIN_TXNS_24H = 3;
function isDeadPool(pair) {
  const volume24h = pair.volume?.h24 ?? 0;
  const txns24h = (pair.txns?.h24?.buys ?? 0) + (pair.txns?.h24?.sells ?? 0);
  return volume24h < DEAD_POOL_MIN_VOLUME_USD || txns24h < DEAD_POOL_MIN_TXNS_24H;
}

// 実際に調査して「見せかけの歪み」と確定したペア/DEXの組み合わせ。
// USDbC(Base)・USDC.e(Avalanche)は、どちらも実勢が正規USDCとほぼ
// $1.00で一致すると確認済み(USDC.eは実際$0.99549で乖離0.45%程度)。
// コントラクトアドレスでの厳密な判定も検討したが、信頼できる完全な
// アドレスを確認できなかったため、実際のログで動作確認済みの
// シンボル名判定を採用している。zipswapは実質稼働停止と確認済み。
function isKnownFalsePositive({ symbol, cheapDexId, expensiveDexId }) {
  const upperSymbol = (symbol || "").toUpperCase();
  if (upperSymbol.includes("USDBC")) return true;
  if (upperSymbol.includes("USDC.E") || upperSymbol.includes("USDCE")) return true;
  if (cheapDexId === "zipswap" || expensiveDexId === "zipswap") return true;
  return false;
}

// 過去(修正前)に「同じDEX名同士」「両プール厚いのに大きな価格差」
// 「実際に見せかけと確認できたペア」の誤ったデータが記録済みの場合が
// あるため、読み込み時にも同じ基準で弾く。
function dexLoadLog() {
  try {
    if (fs.existsSync(DEX_LOG_FILE)) {
      const entries = JSON.parse(fs.readFileSync(DEX_LOG_FILE, "utf8"));
      return entries.filter((e) => {
        if (e.cheapDex === e.expensiveDex) return false;
        if (isKnownFalsePositive({ symbol: e.pairLabel, cheapDexId: e.cheapDex, expensiveDexId: e.expensiveDex })) return false;
        const bothDeep = (e.cheapPoolLiquidityUsd ?? 0) >= DEEP_POOL_LIQUIDITY_USD
          && (e.expensivePoolLiquidityUsd ?? 0) >= DEEP_POOL_LIQUIDITY_USD;
        if (bothDeep && Math.abs(e.priceDiffPercent) > DEEP_POOL_MAX_GAP_PCT) return false;
        return true;
      });
    }
  } catch (e) {
    /* 読み込み失敗時は空ログから再開 */
  }
  return [];
}

function dexSaveLog(entries) {
  try {
    const trimmed = entries.length > 2000 ? entries.slice(-2000) : entries;
    fs.writeFileSync(DEX_LOG_FILE, JSON.stringify(trimmed));
  } catch (e) {
    console.warn("観測ログの保存に失敗:", e.message);
  }
}

// 記録件数・黒字件数・累積純利益は、観測ログの2000件上限とは独立した
// 専用ファイルで管理する(古い記録が押し出されても数字が減らないため)。
function dexLoadStats() {
  try {
    if (fs.existsSync(DEX_STATS_FILE)) return JSON.parse(fs.readFileSync(DEX_STATS_FILE, "utf8"));
  } catch (e) {}
  const existing = dexLoadLog();
  const profitable = existing.filter((r) => r.profitable);
  const seeded = {
    totalObserved: existing.length,
    totalProfitableCount: profitable.length,
    cumulativeProfit: profitable.reduce((s, r) => s + r.netProfit, 0),
  };
  dexSaveStats(seeded);
  return seeded;
}
function dexSaveStats(stats) {
  try {
    fs.writeFileSync(DEX_STATS_FILE, JSON.stringify(stats));
  } catch (e) {
    console.warn("累積統計の保存に失敗:", e.message);
  }
}
function dexRecordStats(observed) {
  const stats = dexLoadStats();
  stats.totalObserved = (stats.totalObserved || 0) + 1;
  if (observed.profitable) {
    stats.totalProfitableCount = (stats.totalProfitableCount || 0) + 1;
    stats.cumulativeProfit = (stats.cumulativeProfit || 0) + observed.netProfit;
  }
  dexSaveStats(stats);
}

// tokenAだけで検索すると、人気トークン(WETH等)は上位30件がUSDC等の
// 出来高最大ペアで埋まり、本命のペアが枠外に押し出されることがある。
// tokenA・tokenB両方で検索して結果を合成することで、この取りこぼしを防ぐ。
async function dexFetchPairsForToken(tokenAddress, chain, otherTokenAddress) {
  const targetChain = dexNormalizeChain(chain);
  const target = tokenAddress.toLowerCase();
  const other = otherTokenAddress.toLowerCase();

  const [resA, resB] = await Promise.all([
    dexFetchWithTimeout(DEXSCREENER_TOKEN_API + tokenAddress),
    dexFetchWithTimeout(DEXSCREENER_TOKEN_API + otherTokenAddress),
  ]);
  if (!resA.ok && !resB.ok) {
    throw new Error(`DexScreener HTTP ${resA.status}/${resB.status}`);
  }

  const pairsA = resA.ok ? (await resA.json()).pairs || [] : [];
  const pairsB = resB.ok ? (await resB.json()).pairs || [] : [];

  const merged = new Map();
  for (const p of [...pairsA, ...pairsB]) {
    if (p.pairAddress) merged.set(p.pairAddress, p);
  }
  const allPairs = [...merged.values()];

  const filtered = allPairs.filter((p) => {
    if ((p.chainId || "").toLowerCase() !== targetChain) return false;
    const base = (p.baseToken?.address || "").toLowerCase();
    const quote = (p.quoteToken?.address || "").toLowerCase();
    const hasTarget = base === target || quote === target;
    const hasOther = base === other || quote === other;
    return hasTarget && hasOther;
  });

  const rawChainIds = [...new Set(allPairs.map((p) => p.chainId))];
  console.log(`[DEX診断] candidate.chain="${chain}" → 正規化後="${targetChain}" / DexScreener取得件数=${allPairs.length}件(tokenA検索${pairsA.length}件+tokenB検索${pairsB.length}件、重複除去後・chainId内訳: ${JSON.stringify(rawChainIds)}) / フィルター後=${filtered.length}件(うちDEX一覧: ${JSON.stringify([...new Set(filtered.map(p=>p.dexId))])})`);

  if (filtered.length === 0) {
    console.log(`[DEX診断詳細] tokenA(${target})・tokenB(${other})両方で検索したが、${chain}上で両方を含むペアが見つからなかった`);
  }

  return filtered;
}

const CONCENTRATED_LIQUIDITY_DEX_IDS = new Set([
  "aerodrome-slipstream", "velodrome-slipstream", "pancakeswap-v3", "uniswap-v3",
]);
function isConcentratedLiquidity(pair) {
  const labels = (pair.labels || []).map((l) => String(l).toLowerCase());
  if (labels.some((l) => /v3|concentrated|slipstream|\bcl\b/.test(l))) return true;
  if (CONCENTRATED_LIQUIDITY_DEX_IDS.has((pair.dexId || "").toLowerCase())) return true;
  return false;
}

function dexToPoolShape(pair, targetTokenAddress) {
  if (isConcentratedLiquidity(pair)) {
    console.log(`[DEX診断] ${pair.dexId}: 集中流動性型(V3方式)のため除外(labels=${JSON.stringify(pair.labels)}) - 今の計算式は通用しないため`);
    return null;
  }

  if (isDeadPool(pair)) {
    const volume24h = pair.volume?.h24 ?? 0;
    const txns24h = (pair.txns?.h24?.buys ?? 0) + (pair.txns?.h24?.sells ?? 0);
    console.log(`[DEX診断] ${pair.dexId}: 取引がほぼ枯れているため除外(24時間出来高=$${volume24h.toFixed(2)}, 取引件数=${txns24h}件) - ZipSwap等で実際に確認された「活動停止プール」の誤検知パターン`);
    return null;
  }

  const liqBase = pair.liquidity?.base;
  const liqQuote = pair.liquidity?.quote;
  const priceNative = parseFloat(pair.priceNative);

  if (!liqBase || !liqQuote || !priceNative || !isFinite(priceNative)) {
    console.log(`[DEX診断] ${pair.dexId}: liquidity情報が不完全のため除外(liqBase=${liqBase}, liqQuote=${liqQuote}, priceNative=${pair.priceNative})`);
    return null;
  }

  const impliedPrice = liqQuote / liqBase;
  const deviation = Math.abs(impliedPrice - priceNative) / priceNative;
  if (deviation > 0.05) {
    console.log(`[DEX診断] ${pair.dexId}: 自己整合性チェック不合格のため除外(逆算価格=${impliedPrice.toFixed(6)}, 公表価格=${priceNative}, 乖離=${(deviation*100).toFixed(1)}%)`);
    return null;
  }

  const baseIsTarget = (pair.baseToken?.address || "").toLowerCase() === targetTokenAddress.toLowerCase();
  const reserveX = baseIsTarget ? liqBase : liqQuote;
  const reserveY = baseIsTarget ? liqQuote : liqBase;

  // Yトークン(取引の投入・利益の建値通貨)のUSD価格を、DexScreenerの
  // priceUsd(base側のUSD価格)とpriceNative(baseがquote何枚分か)から
  // 逆算する。上限$300をYトークン建てに正しく換算するために必須。
  const basePriceUsd = parseFloat(pair.priceUsd);
  let priceUsdPerY = null;
  if (isFinite(basePriceUsd) && basePriceUsd > 0) {
    const quotePriceUsd = basePriceUsd / priceNative;
    priceUsdPerY = baseIsTarget ? quotePriceUsd : basePriceUsd;
  }

  return {
    dexId: pair.dexId,
    pairAddress: pair.pairAddress,
    reserveX,
    reserveY,
    fee: dexGetFeeForDex(pair.dexId),
    priceUsd: pair.priceUsd,
    liquidityUsd: (pair.liquidity?.usd ?? null),
    priceUsdPerY,
  };
}

async function dexWatchOnePair(candidate) {
  const gasCostUsd = getGasCostForChain(candidate.chain);
  const rawPairs = await dexFetchPairsForToken(candidate.tokenA, candidate.chain, candidate.tokenB);

  const pools = rawPairs
    .map((p) => dexToPoolShape(p, candidate.tokenA))
    .filter(Boolean)
    .sort((a, b) => b.reserveX + b.reserveY - (a.reserveX + a.reserveY));

  if (pools.length < 2) return null;

  const [poolA, poolB] = pools;

  // 同じDEX名同士(例: aerodrome vs aerodrome)は、AerodromeやVelodrome系に
  // ある「Volatile」「Stable」という異なる計算式のプールを取り違えている
  // 可能性が高い。今のコードはVolatile(x*y=k)しか対応していないため、
  // 安全のため除外する。
  if (poolA.dexId === poolB.dexId) {
    console.log(`[DEX診断] ${candidate.symbol} on ${candidate.chain}: 同じDEX名同士(${poolA.dexId})のため除外(Stable/Volatileプールの取り違えの可能性 - 今の計算式では区別できないため)`);
    return null;
  }

  // 調査により「見せかけの歪み」と確定済みのペア/DEXは、観測の
  // 時点で弾く(過去ログの読み込み時だけでなく、新規記録もここで防ぐ)。
  if (isKnownFalsePositive({ symbol: candidate.symbol, cheapDexId: poolA.dexId, expensiveDexId: poolB.dexId })) {
    console.log(`[DEX診断] ${candidate.symbol} on ${candidate.chain}: 調査により「見せかけの歪み」と確定済みのため除外(USDbC/USDC.e/ZipSwap)`);
    return null;
  }

  const priceA = poolA.reserveY / poolA.reserveX;
  const priceB = poolB.reserveY / poolB.reserveX;
  const [cheapPool, expensivePool] = priceA < priceB ? [poolA, poolB] : [poolB, poolA];

  if (!cheapPool.priceUsdPerY || !isFinite(cheapPool.priceUsdPerY) || cheapPool.priceUsdPerY <= 0) {
    console.log(`[DEX診断] ${candidate.symbol} on ${candidate.chain}: USD換算価格が取得できないため、上限$${MAX_TRADE_USD}の計算ができず除外`);
    return null;
  }

  const result = dexEvaluateOpportunity({
    cheapPool,
    expensivePool,
    gasCostUsd,
    maxTradeAmountUsd: MAX_TRADE_USD,
    slippageBuffer: 0.002,
    pairLabel: `${candidate.symbol} on ${candidate.chain} (${cheapPool.dexId} -> ${expensivePool.dexId})`,
  });

  if (Math.abs(result.priceDiffPercent) > 20) {
    console.warn(`[DEX] 異常な価格差を検出、データ不備として除外 (${candidate.symbol} / ${candidate.chain}): ${result.priceDiffPercent.toFixed(1)}%`);
    return null;
  }

  // 両プールとも流動性が厚い($500,000以上)のに1%を超える価格差が
  // 残っているのは、本物の機会というよりデータ取得時のズレや
  // プール種別の誤判定である可能性が高い(厚いプール同士は他のbotが
  // 常時監視しているため)。
  const bothPoolsDeep = (cheapPool.liquidityUsd ?? 0) >= DEEP_POOL_LIQUIDITY_USD
    && (expensivePool.liquidityUsd ?? 0) >= DEEP_POOL_LIQUIDITY_USD;
  if (bothPoolsDeep && Math.abs(result.priceDiffPercent) > DEEP_POOL_MAX_GAP_PCT) {
    console.warn(`[DEX] 両プールとも流動性十分($${Math.round(cheapPool.liquidityUsd).toLocaleString()} / $${Math.round(expensivePool.liquidityUsd).toLocaleString()})なのに価格差${result.priceDiffPercent.toFixed(2)}%は不自然、データ不備として除外 (${candidate.symbol} / ${candidate.chain})`);
    return null;
  }

  return {
    ...result,
    chain: candidate.chain,
    tokenA: candidate.tokenA,
    tokenB: candidate.tokenB,
    cheapDex: cheapPool.dexId,
    expensiveDex: expensivePool.dexId,
    cheapPoolAddress: cheapPool.pairAddress,
    expensivePoolAddress: expensivePool.pairAddress,
    cheapPoolLiquidityUsd: cheapPool.liquidityUsd,
    expensivePoolLiquidityUsd: expensivePool.liquidityUsd,
  };
}

const DEX_PERSISTENCE_LOG_FILE = process.env.PERSISTENCE_LOG_FILE || "/tmp/dex-persistence-log.json";
const PERSISTENCE_CHECK_DELAYS_SEC = [5, 15, 30, 60];
const PERSISTENCE_TRIGGER_THRESHOLD_PCT = 0.1;

function dexLoadPersistenceLog() {
  try {
    if (fs.existsSync(DEX_PERSISTENCE_LOG_FILE)) return JSON.parse(fs.readFileSync(DEX_PERSISTENCE_LOG_FILE, "utf8"));
  } catch (e) {}
  return [];
}
function dexSavePersistenceLog(entries) {
  try {
    const trimmed = entries.length > 500 ? entries.slice(-500) : entries;
    fs.writeFileSync(DEX_PERSISTENCE_LOG_FILE, JSON.stringify(trimmed));
  } catch (e) {
    console.warn("持続性ログの保存に失敗:", e.message);
  }
}

function trackPersistence(candidate, initialResult) {
  const trackingId = `${candidate.chain}-${candidate.symbol}-${Date.now()}`;
  const record = {
    trackingId,
    pairLabel: initialResult.pairLabel,
    chain: candidate.chain,
    detectedAt: initialResult.timestamp,
    initialPriceDiffPercent: initialResult.priceDiffPercent,
    initialNetProfit: initialResult.netProfit,
    followUps: [],
  };

  console.log(`[DEX持続性] 追跡開始: ${initialResult.pairLabel}(初回ズレ${initialResult.priceDiffPercent.toFixed(2)}%) → 5/15/30/60秒後に再チェックします`);

  for (const delaySec of PERSISTENCE_CHECK_DELAYS_SEC) {
    setTimeout(async () => {
      try {
        const followUp = await dexWatchOnePair(candidate);
        const entry = followUp
          ? { delaySec, stillExists: true, priceDiffPercent: followUp.priceDiffPercent, netProfit: followUp.netProfit }
          : { delaySec, stillExists: false, priceDiffPercent: null, netProfit: null };
        record.followUps.push(entry);
        console.log(`[DEX持続性] ${initialResult.pairLabel} の${delaySec}秒後: ${entry.stillExists ? `まだ残っている(ズレ${entry.priceDiffPercent.toFixed(2)}%)` : "消えていた"}`);

        if (delaySec === PERSISTENCE_CHECK_DELAYS_SEC[PERSISTENCE_CHECK_DELAYS_SEC.length - 1]) {
          const log = dexLoadPersistenceLog();
          log.push(record);
          dexSavePersistenceLog(log);
        }
      } catch (e) {
        console.warn(`[DEX持続性] 再チェック失敗(${delaySec}秒後):`, e.message);
      }
    }, delaySec * 1000);
  }
}

function getPersistenceSummary() {
  const log = dexLoadPersistenceLog();
  if (log.length === 0) return null;

  const summary = PERSISTENCE_CHECK_DELAYS_SEC.map((delaySec) => {
    const withThisDelay = log
      .map((r) => r.followUps.find((f) => f.delaySec === delaySec))
      .filter(Boolean);
    const stillExisting = withThisDelay.filter((f) => f.stillExists).length;
    return {
      delaySec,
      total: withThisDelay.length,
      stillExisting,
      survivalRate: withThisDelay.length > 0 ? (stillExisting / withThisDelay.length) * 100 : null,
    };
  });

  return { trackedCount: log.length, byDelay: summary };
}

const DEX_PROSPECT_REFRESH_INTERVAL_MS = 60 * 60 * 1000;

let dexCachedCandidates = [];
let dexCandidateRotationOffset = 0;
const poolAddressToCandidate = new Map();
let onchainReactionCount = 0;
let onchainLatencyLog = [];

async function handleOnchainSync(chainName, poolAddress, reserve0, reserve1, receivedAt) {
  const entry = poolAddressToCandidate.get(poolAddress);
  if (!entry) return;
  try {
    const observed = await dexWatchOnePair(entry.candidate);
    const latencyMs = Date.now() - receivedAt;
    onchainReactionCount++;
    onchainLatencyLog.push(latencyMs);
    if (onchainLatencyLog.length > 200) onchainLatencyLog.shift();

    if (observed) {
      latestDexResults = [observed, ...latestDexResults].slice(0, 30);
      const log = dexLoadLog();
      log.push({ ...observed, viaOnchainEvent: true, reactionLatencyMs: latencyMs });
      dexSaveLog(log);
      dexRecordStats(observed);
      console.log(`[オンチェーン反応] ${observed.pairLabel}: Sync検知から${latencyMs}ms後に再評価完了(ズレ${observed.priceDiffPercent.toFixed(2)}%、純利益${observed.netProfit>=0?'+':''}$${observed.netProfit.toFixed(2)})`);
    }
  } catch (e) {
    console.warn(`[オンチェーン反応] 再評価失敗:`, e.message);
  }
}

function getOnchainLatencyStats() {
  if (onchainLatencyLog.length === 0) return null;
  const sorted = [...onchainLatencyLog].sort((a, b) => a - b);
  const avg = sorted.reduce((s, v) => s + v, 0) / sorted.length;
  const median = sorted[Math.floor(sorted.length / 2)];
  return { count: onchainReactionCount, avgMs: avg, medianMs: median, minMs: sorted[0], maxMs: sorted[sorted.length - 1] };
}

let dexLastProspectAt = 0;
let dexProspectRefreshing = false;

async function dexGetCandidates(topN) {
  const now = Date.now();
  const needsRefresh = dexCachedCandidates.length === 0 || now - dexLastProspectAt > DEX_PROSPECT_REFRESH_INTERVAL_MS;

  if (needsRefresh && !dexProspectRefreshing) {
    dexProspectRefreshing = true;
    try {
      console.log("[DEX] 候補ペアを再選定中(DeFiLlama全件取得。数十秒かかることがあります)...");
      // TVL下限を$20,000→$5,000に、キャッシュ件数を30→60に拡大。
      const prospect = await runProspect({ minTvlUSD: 5000, topN: 60 });
      dexCachedCandidates = prospect.topPairs;
      dexLastProspectAt = now;
      dexCandidateRotationOffset = 0;
      console.log(`[DEX] 候補ペア再選定完了: ${dexCachedCandidates.length}件`);
    } catch (e) {
      console.error("[DEX] 候補ペア選定に失敗(前回のキャッシュを使い続けます):", e.message);
    } finally {
      dexProspectRefreshing = false;
    }
  }

  const total = dexCachedCandidates.length;
  if (total === 0) return [];

  // 毎回同じ上位N件だけを見るのではなく、キャッシュ済みの全候補を
  // 順番にローテーションして観測する。こうすることでDeFiLlamaへの
  // 追加リクエストなしに、1時間待たず短時間で全候補を一巡できる。
  const batchSize = Math.min(topN, total);
  const start = dexCandidateRotationOffset % total;
  const selected = [];
  for (let i = 0; i < batchSize; i++) {
    selected.push(dexCachedCandidates[(start + i) % total]);
  }
  dexCandidateRotationOffset = (start + batchSize) % total;

  return selected;
}

async function runWatchCycle({ topN = 8 } = {}) {
  console.log("[DEX] 観測サイクル開始");
  const candidates = await dexGetCandidates(topN);

  if (candidates.length === 0) {
    console.log("[DEX] 候補ペアがまだありません(初回の選定待ち、または失敗)");
    return { scannedAt: new Date().toISOString(), checked: 0, logged: 0, results: [] };
  }

  const log = dexLoadLog();
  const results = [];

  for (const candidate of candidates) {
    try {
      const observed = await dexWatchOnePair(candidate);
      if (observed) {
        results.push(observed);
        log.push(observed);
        dexRecordStats(observed);
        if (Math.abs(observed.priceDiffPercent) >= PERSISTENCE_TRIGGER_THRESHOLD_PCT) {
          trackPersistence(candidate, observed);
        }
        if (observed.cheapPoolAddress && observed.expensivePoolAddress) {
          poolAddressToCandidate.set(observed.cheapPoolAddress, { candidate });
          poolAddressToCandidate.set(observed.expensivePoolAddress, { candidate });
          updatePoolSubscriptions(candidate.chain, [observed.cheapPoolAddress, observed.expensivePoolAddress]);
        }
      }
    } catch (e) {
      console.warn(`[DEX] 観測失敗 (${candidate.symbol} / ${candidate.chain}):`, e.message);
    }
  }

  dexSaveLog(log);
  console.log(`[DEX] 観測サイクル完了: 対象${candidates.length}件・記録${results.length}件・黒字${results.filter(r=>r.profitable).length}件`);

  return {
    scannedAt: new Date().toISOString(),
    checked: candidates.length,
    logged: results.length,
    results,
  };
}

const DEX_WATCH_INTERVAL_SEC = parseInt(process.env.DEX_WATCH_INTERVAL_SEC || "180", 10);

let dexWatchRunning = false;
let dexWatchCount = 0;
let lastDexWatchAt = null;
let lastDexError = null;
let latestDexResults = [];

async function dexWatchOnce() {
  if (dexWatchRunning) return;
  dexWatchRunning = true;
  try {
    const result = await runWatchCycle({ topN: 8 });
    latestDexResults = result.results;
    dexWatchCount++;
    lastDexWatchAt = new Date().toISOString();

    const profitable = result.results.filter((r) => r.profitable);
    if (profitable.length > 0) {
      for (const r of profitable) {
        const liq = [r.cheapPoolLiquidityUsd, r.expensivePoolLiquidityUsd]
          .map((v) => v !== null && v !== undefined ? `$${Math.round(v).toLocaleString()}` : "不明")
          .join(" / ");
        const cappedNote = r.cappedByBudget
          ? `上限$${MAX_TRADE_USD}でキャップ、理論上の最適額は${r.optimalAmountIn.toFixed(4)}`
          : "理論上の最適額のまま";
        console.log(`[DEX] ${r.pairLabel}: 純利益 +$${r.netProfit.toFixed(2)}(価格差${r.priceDiffPercent.toFixed(2)}%、投入額$${r.tradeAmountUsd.toFixed(2)}[${cappedNote}]、両プール流動性=${liq}）`);
      }
    } else {
      console.log(`[DEX] 観測${result.checked}件・記録${result.logged}件・黒字0件`);
    }
  } catch (e) {
    lastDexError = e.message;
    console.error("DEX観測エラー:", e.message);
  } finally {
    dexWatchRunning = false;
  }
}

const PAGE_STYLE = `
body{font-family:-apple-system,sans-serif;background:#0d100c;color:#e8e6d8;margin:0;padding:18px 12px;}
h1{font-size:17px;margin:0 0 4px;} h2{font-size:13px;margin:0 0 10px;font-weight:600;}
.sub{color:#888;font-size:11px;margin-bottom:16px;}
.card{background:#14180f;border:1px solid #2a331d;border-radius:8px;padding:13px;margin-bottom:13px;}
table{width:100%;border-collapse:collapse;font-size:11px;}
th{text-align:left;color:#888;font-weight:500;font-size:9.5px;padding:5px 3px;border-bottom:1px solid #2a331d;}
td{padding:6px 3px;border-bottom:1px solid #1c1c1c;}
.note{font-size:10px;color:#888;line-height:1.6;margin-top:9px;padding-top:9px;border-top:1px solid #222;}
.stat{display:grid;grid-template-columns:repeat(4,1fr);gap:6px;margin-bottom:13px;}
.stat div{background:#14180f;border:1px solid #2a331d;border-radius:8px;padding:11px 4px;text-align:center;}
.stat .v{font-size:17px;font-weight:600;} .stat .l{font-size:8.5px;color:#888;margin-top:2px;}
a{color:#6fae62;}
.footerlink{margin-top:18px;font-size:11px;}
`;

function renderPage() {
  const dexStats = dexLoadStats();
  const persistenceSummary = getPersistenceSummary();
  const onchainLatencyStats = getOnchainLatencyStats();

  const dexRows = latestDexResults.slice(0, 15).map((r, i) => {
    const color = r.profitable ? "#2ecc71" : "#888";
    return `<tr><td>${i+1}</td><td style="font-size:9px;">${r.pairLabel}</td>
    <td style="text-align:right;">${r.priceDiffPercent.toFixed(2)}%</td>
    <td style="text-align:right;color:${color};font-weight:600;">${r.netProfit>=0?'+':''}$${r.netProfit.toFixed(2)}</td></tr>`;
  }).join("") || `<tr><td colspan="4" style="color:#888;">観測データがまだありません(次のサイクルを待機中)</td></tr>`;

  return `<!DOCTYPE html><html lang="ja"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1.0"><meta http-equiv="refresh" content="30">
<title>DEXアービトラージ観測所</title><style>${PAGE_STYLE}</style></head><body>
<h1>🔍 DEXアービトラージ観測所</h1>
<div class="sub">紙上取引のみ(実際の注文は出しません) / DEX観測${dexWatchCount}回 / 1回の取引額は理論上の最適額(上限$${MAX_TRADE_USD})</div>

<div class="card">
  <h2>🔍 DEXアービトラージ観測(Base等)</h2>
  <div class="stat">
    <div><div class="v">${dexStats.totalObserved}</div><div class="l">記録件数</div></div>
    <div><div class="v" style="color:${dexStats.totalProfitableCount>0?'#2ecc71':'#888'};">${dexStats.totalProfitableCount}</div><div class="l">黒字だった件数</div></div>
    <div><div class="v" style="color:${dexStats.cumulativeProfit>=0?'#2ecc71':'#e74c3c'};">${dexStats.cumulativeProfit>=0?'+':''}$${dexStats.cumulativeProfit.toFixed(2)}</div><div class="l">累積純利益(黒字分の合計)</div></div>
    <div><div class="v">${lastDexWatchAt ? new Date(lastDexWatchAt).toLocaleTimeString('ja-JP') : '-'}</div><div class="l">最終観測時刻</div></div>
  </div>
  <table><thead><tr><th>#</th><th>ペア</th><th style="text-align:right;">価格差</th><th style="text-align:right;">純利益</th></tr></thead>
  <tbody>${dexRows}</tbody></table>
  <div class="note">
    prospector.jsが選んだ候補ペアを、DexScreenerのデータで観測 → 理論上の最適投入額(上限$${MAX_TRADE_USD})で取引した想定で、ガス代・手数料込みの純利益を計算して記録。<br>
    記録件数・黒字件数・累積純利益は上限なく増え続ける累計値です(観測ログ本体は容量の都合で直近2000件のみ保持)。<br>
    実際の注文は出していません(紙上観測のみ)。${lastDexError ? `<br><span style="color:#e74c3c;">エラー: ${lastDexError}</span>` : ''}
  </div>
</div>

${persistenceSummary ? `<div class="card">
  <h2>⏱️ 歪みの持続性(最重要データ)</h2>
  <table><thead><tr><th>経過時間</th><th style="text-align:right;">追跡件数</th><th style="text-align:right;">まだ残っていた割合</th></tr></thead>
  <tbody>${persistenceSummary.byDelay.map(d => `<tr><td>${d.delaySec}秒後</td><td style="text-align:right;">${d.total}</td>
    <td style="text-align:right;color:${d.survivalRate!==null && d.survivalRate>50?'#2ecc71':'#e74c3c'};">${d.survivalRate!==null ? d.survivalRate.toFixed(0)+'%' : '-'}</td></tr>`).join('')}</tbody></table>
  <div class="note">
    検知した歪みが、その後も残っていたかを実測(追跡件数${persistenceSummary.trackedCount}件)。<br>
    60秒後の残存率が低ければ、今の3分間隔の観測では間に合わない証拠。高ければ、この間隔でも十分捕まえられる可能性がある。
  </div>
</div>` : ''}

${onchainLatencyStats ? `<div class="card">
  <h2>⚡ オンチェーン反応速度</h2>
  <div class="stat">
    <div><div class="v">${onchainLatencyStats.count}</div><div class="l">反応回数</div></div>
    <div><div class="v">${onchainLatencyStats.medianMs.toFixed(0)}ms</div><div class="l">中央値</div></div>
    <div><div class="v">${onchainLatencyStats.minMs.toFixed(0)}ms</div><div class="l">最速</div></div>
    <div><div class="v">${onchainLatencyStats.maxMs.toFixed(0)}ms</div><div class="l">最遅</div></div>
  </div>
  <div class="note">Syncイベントを検知してから、再評価が完了するまでの実測時間。3分間隔のポーリングと比べ、どれだけ速く反応できているかの指標。</div>
</div>` : ''}

<div class="footerlink"><a href="/about">→ このサイトが集めているデータについて</a></div>
</body></html>`;
}

function renderAboutPage() {
  return `<!DOCTYPE html><html lang="ja"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>収集データについて</title><style>${PAGE_STYLE}</style></head><body>
<h1>📊 このサイトが集めているデータ</h1>
<div class="sub">DEXアービトラージ観測所が、裏で何をしているかの説明ページ</div>

<div class="card">
  <h2>① 候補ペアの選定(1時間ごと)</h2>
  <div class="note">
    DeFiLlamaから全DEXプールのデータを取得し、「同じトークンペアが複数のDEXに存在する組み合わせ」を洗い出します。<br>
    Ethereumはガス代が確実に利益を上回るため除外しています。それ以外の全チェーン(Base, Arbitrum, Optimism, Polygon, Avalanche, BSC, Flare等)が対象です。<br>
    流動性・出来高の少なさからスコアリングして上位60件をキャッシュします(prospector.js)。<br>
    このデータ自体はファイルには保存せず、メモリ上に1時間だけ保持します。
  </div>
</div>

<div class="card">
  <h2>② DEX観測ログ(3分ごと)</h2>
  <div class="note">
    キャッシュした候補を8件ずつ順番に(ローテーションしながら)DexScreenerで価格チェックします。<br>
    「理論上いちばん利益が出る投入額」と「上限$${MAX_TRADE_USD}」の小さい方を実際の投入額として使い、ガス代・取引手数料・スリッページを差し引いた「純利益」を計算して、以下を記録します:
  </div>
  <table><thead><tr><th>項目</th><th>内容</th></tr></thead><tbody>
    <tr><td>日時</td><td>観測した時刻</td></tr>
    <tr><td>ペア・チェーン</td><td>例:USDC-AERO on Base</td></tr>
    <tr><td>DEX(安い方/高い方)</td><td>例:aerodrome → uniswap</td></tr>
    <tr><td>価格差(%)</td><td>2つのDEX間のズレ</td></tr>
    <tr><td>投入額($)</td><td>理論上の最適額(上限$${MAX_TRADE_USD}でキャップ)</td></tr>
    <tr><td>純利益($)</td><td>投入額をもとに、ガス代・手数料・スリッページを引いた後の金額</td></tr>
    <tr><td>両プールの流動性($)</td><td>取引の実現性を判断する材料</td></tr>
  </tbody></table>
  <div class="note">
    観測1件ごとの詳細は永続ディスク(/data)に保存、最大2000件まで(超えた分は古い順に削除)。<br>
    ダッシュボードの記録件数・黒字件数・累積純利益は、この2000件上限とは別に、上限なく増え続ける専用の集計ファイルで管理しています(古い記録が押し出されても数字が減りません)。<br>
    再デプロイしてもデータは消えません。<br>
    以下の場合はデータ不備・異常値として除外しています(観測の時点、および過去に保存されたデータの読み込み時点の両方で適用):<br>
    ・同じDEX名同士(Stable/Volatileプールの取り違えの可能性)<br>
    ・両プールとも流動性が$500,000以上あるのに価格差が1%を超える場合<br>
    ・24時間の出来高が$50未満、または取引件数が3件未満(=事実上稼働停止しているDEXの誤検知)<br>
    ・調査により「見せかけの歪み」と確定したUSDbC・USDC.e・ZipSwap関連
  </div>
</div>

<div class="card">
  <h2>③ 持続性の追跡</h2>
  <div class="note">
    価格差が一定以上(0.1%)見つかった時だけ、5秒後・15秒後・30秒後・60秒後に同じペアを再チェックし、「まだ残っていたか」を記録します。<br>
    他のbotにどれくらいの速さで価格差を埋められているかを見るためのデータです。<br>
    最大500件まで、同じく/dataに保存されます。
  </div>
</div>

<div class="card">
  <h2>④ オンチェーン反応速度</h2>
  <div class="note">
    Base(BASE_WSS_URLを設定している場合のみ)のSyncイベントをリアルタイムで購読し、検知から再評価完了までの時間を計測します。<br>
    このデータはファイルに保存せず、直近200件だけメモリ上に保持します(再起動で消えます)。
  </div>
</div>

<div class="card">
  <h2>⑤ このサイトがやっていないこと</h2>
  <div class="note">
    実際の売買注文は一切出していません。全て「もし取引していたら」の紙上シミュレーションです。<br>
    ウォレットの秘密鍵や資金にアクセスすることもありません。
  </div>
</div>

<div class="footerlink"><a href="/">← 観測所トップに戻る</a></div>
</body></html>`;
}

function startServer() {
  const port = process.env.PORT || 8080;
  http.createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    if (req.url === "/about") {
      res.end(renderAboutPage());
    } else {
      res.end(renderPage());
    }
  }).listen(port, () => console.log(`観測所ページ: ポート${port}`));
}

async function main() {
  console.log("=== DEXアービトラージ観測所 起動 ===");
  startServer();

  dexWatchOnce();
  setInterval(dexWatchOnce, DEX_WATCH_INTERVAL_SEC * 1000);

  startOnchainFeeds(handleOnchainSync);
}

main().catch((e) => { console.error("致命的エラー:", e); process.exit(1); });
