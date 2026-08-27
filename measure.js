import { ethers } from "ethers";

/**
 * 実測モジュール
 * ------------------------------------------------------------
 * 観測所が絞り込んだ上位候補ペアについて、実際にオンチェーンから
 * 価格を取得し、以下を測定する:
 *   1. 実際の価格差(手数料・ガス代控除後の純利益)
 *   2. トークンの安全性(売却可能か、送金手数料がないか)
 *   3. 純利益が最大になる取引サイズ
 *
 * 対象は Uniswap V2 系 × Uniswap V3 系のペアに限定(まず1つ確実に動かすため)。
 */

// ============ チェーン設定 ============
export const CHAIN_CONFIG = {
  Ethereum: {
    chainId: 1,
    rpc: "https://eth.llamarpc.com",
    uniV3Quoter: "0x61fFE014bA17989E743c5F6cB21bF9697530B21e",
    uniV3Factory: "0x1F98431c8aD98523631AE4a59f267346ea31F984",
    uniV2Router: "0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D",
    weth: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
    usdc: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
    usdcDecimals: 6,
    gasUnitsPerSwap: 180000n,
  },
  Arbitrum: {
    chainId: 42161,
    rpc: "https://arb1.arbitrum.io/rpc",
    uniV3Quoter: "0x61fFE014bA17989E743c5F6cB21bF9697530B21e",
    uniV3Factory: "0x1F98431c8aD98523631AE4a59f267346ea31F984",
    uniV2Router: "0x4752ba5DBc23f44D87826276BF6Fd6b1C372aD24",
    weth: "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1",
    usdc: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831",
    usdcDecimals: 6,
    gasUnitsPerSwap: 180000n,
  },
  Base: {
    chainId: 8453,
    rpc: "https://mainnet.base.org",
    uniV3Quoter: "0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a",
    uniV3Factory: "0x33128a8fC17869897dcE68Ed026d694621f6FDfD",
    uniV2Router: "0x4752ba5DBc23f44D87826276BF6Fd6b1C372aD24",
    weth: "0x4200000000000000000000000000000000000006",
    usdc: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    usdcDecimals: 6,
    gasUnitsPerSwap: 180000n,
  },
  Optimism: {
    chainId: 10,
    rpc: "https://mainnet.optimism.io",
    uniV3Quoter: "0x61fFE014bA17989E743c5F6cB21bF9697530B21e",
    uniV3Factory: "0x1F98431c8aD98523631AE4a59f267346ea31F984",
    uniV2Router: "0x4A7b5Da61326A6379179b40d00F57E5bbDC962c2",
    weth: "0x4200000000000000000000000000000000000006",
    usdc: "0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85",
    usdcDecimals: 6,
    gasUnitsPerSwap: 180000n,
  },
  Polygon: {
    chainId: 137,
    rpc: "https://polygon-rpc.com",
    uniV3Quoter: "0x61fFE014bA17989E743c5F6cB21bF9697530B21e",
    uniV3Factory: "0x1F98431c8aD98523631AE4a59f267346ea31F984",
    uniV2Router: "0xedf6066a2b290C185783862C7F4776A2C8077AD1",
    weth: "0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270",
    usdc: "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359",
    usdcDecimals: 6,
    gasUnitsPerSwap: 180000n,
  },
};

const FEE_TIERS = [500, 3000, 10000];

const ABI_QUOTER = [
  "function quoteExactInputSingle((address tokenIn,address tokenOut,uint256 amountIn,uint24 fee,uint160 sqrtPriceLimitX96)) returns (uint256 amountOut,uint160,uint32,uint256)",
];
const ABI_V2_ROUTER = [
  "function getAmountsOut(uint256 amountIn, address[] path) view returns (uint256[] amounts)",
];
const ABI_ERC20 = [
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
];

const providers = {};
export function getProvider(chainName) {
  const cfg = CHAIN_CONFIG[chainName];
  if (!cfg) return null;
  if (!providers[chainName]) {
    providers[chainName] = new ethers.JsonRpcProvider(cfg.rpc, cfg.chainId, {
      staticNetwork: true,
    });
  }
  return providers[chainName];
}

const decimalsCache = {};
async function getDecimals(provider, chainName, tokenAddr) {
  const key = `${chainName}:${tokenAddr.toLowerCase()}`;
  if (decimalsCache[key] !== undefined) return decimalsCache[key];
  try {
    const c = new ethers.Contract(tokenAddr, ABI_ERC20, provider);
    const d = Number(await c.decimals());
    decimalsCache[key] = d;
    return d;
  } catch (e) {
    decimalsCache[key] = null;
    return null;
  }
}

// ============ 見積もり取得 ============
async function quoteV3(cfg, provider, tokenIn, tokenOut, amountIn) {
  const quoter = new ethers.Contract(cfg.uniV3Quoter, ABI_QUOTER, provider);
  let best = null;
  for (const fee of FEE_TIERS) {
    try {
      const r = await quoter.quoteExactInputSingle.staticCall({
        tokenIn, tokenOut, amountIn, fee, sqrtPriceLimitX96: 0n,
      });
      if (r[0] > 0n && (!best || r[0] > best.amountOut)) best = { amountOut: r[0], fee };
    } catch (e) {}
  }
  return best;
}

async function quoteV2(cfg, provider, tokenIn, tokenOut, amountIn) {
  try {
    const router = new ethers.Contract(cfg.uniV2Router, ABI_V2_ROUTER, provider);
    const amounts = await router.getAmountsOut(amountIn, [tokenIn, tokenOut]);
    const out = amounts[amounts.length - 1];
    return out > 0n ? out : null;
  } catch (e) {
    return null;
  }
}

// ============ ネイティブトークンのUSD価格(ガス代算出用) ============
const nativePriceCache = {};
async function getNativePriceUSD(cfg, provider, chainName) {
  const cached = nativePriceCache[chainName];
  if (cached && Date.now() - cached.at < 5 * 60 * 1000) return cached.price;
  try {
    const oneUnit = ethers.parseUnits("1", 18);
    const q = await quoteV3(cfg, provider, cfg.weth, cfg.usdc, oneUnit);
    if (!q) return cached?.price ?? null;
    const price = parseFloat(ethers.formatUnits(q.amountOut, cfg.usdcDecimals));
    nativePriceCache[chainName] = { price, at: Date.now() };
    return price;
  } catch (e) {
    return cached?.price ?? null;
  }
}

// ============ 安全性チェック ============
export async function checkTokenSafety(cfg, provider, tokenA, tokenB, decA) {
  const result = { sellable: null, roundTripLoss: null, warnings: [] };
  try {
    const probe = 10n ** BigInt(decA);

    const [buyV2, buyV3] = await Promise.all([
      quoteV2(cfg, provider, tokenA, tokenB, probe),
      quoteV3(cfg, provider, tokenA, tokenB, probe),
    ]);
    const buyOut = buyV3 && (!buyV2 || buyV3.amountOut > buyV2) ? buyV3.amountOut : buyV2;
    if (!buyOut) {
      result.warnings.push("購入方向の見積もりが取得できない");
      return result;
    }

    const [sellV2, sellV3] = await Promise.all([
      quoteV2(cfg, provider, tokenB, tokenA, buyOut),
      quoteV3(cfg, provider, tokenB, tokenA, buyOut),
    ]);
    const sellOut = sellV3 && (!sellV2 || sellV3.amountOut > sellV2) ? sellV3.amountOut : sellV2;
    if (!sellOut) {
      result.sellable = false;
      result.warnings.push("売却方向の見積もりが取得できない(ハニーポットの可能性)");
      return result;
    }
    result.sellable = true;

    const start = Number(probe) / 10 ** decA;
    const back = Number(sellOut) / 10 ** decA;
    const lossPct = ((start - back) / start) * 100;
    result.roundTripLoss = lossPct;

    if (lossPct > 5) {
      result.warnings.push(`往復で${lossPct.toFixed(1)}%が消失(送金手数料付きトークンの疑い)`);
    } else if (lossPct < -1) {
      result.warnings.push(`往復で利益が出る異常値(${(-lossPct).toFixed(1)}%)。検証が必要`);
    }
  } catch (e) {
    result.warnings.push(`安全性チェック失敗: ${e.message}`);
  }
  return result;
}

// ============ 実際の価格差の測定 ============
export async function measureSpread(chainName, tokenA, tokenB, { tradeUSD = 1000 } = {}) {
  const cfg = CHAIN_CONFIG[chainName];
  if (!cfg) return null;
  const provider = getProvider(chainName);
  if (!provider) return null;

  const [decA, decB, nativePrice] = await Promise.all([
    getDecimals(provider, chainName, tokenA),
    getDecimals(provider, chainName, tokenB),
    getNativePriceUSD(cfg, provider, chainName),
  ]);
  if (decA === null || decB === null) return null;

  const amountIn = 10n ** BigInt(decA);

  const [v2Out, v3Out] = await Promise.all([
    quoteV2(cfg, provider, tokenA, tokenB, amountIn),
    quoteV3(cfg, provider, tokenA, tokenB, amountIn),
  ]);
  if (!v2Out || !v3Out) return null;

  const buyOnV3 = v3Out.amountOut > v2Out;
  const buyAmount = buyOnV3 ? v3Out.amountOut : v2Out;
  const sellBack = buyOnV3
    ? await quoteV2(cfg, provider, tokenB, tokenA, buyAmount)
    : (await quoteV3(cfg, provider, tokenB, tokenA, buyAmount))?.amountOut;
  if (!sellBack) return null;

  const startAmt = Number(amountIn) / 10 ** decA;
  const endAmt = Number(sellBack) / 10 ** decA;
  const grossPct = ((endAmt - startAmt) / startAmt) * 100;

  let gasCostUSD = null;
  try {
    const feeData = await provider.getFeeData();
    const gasPrice = feeData.gasPrice ?? 0n;
    const gasWei = (gasPrice * cfg.gasUnitsPerSwap * 2n * 130n) / 100n;
    if (nativePrice) {
      gasCostUSD = parseFloat(ethers.formatUnits(gasWei, 18)) * nativePrice;
    }
  } catch (e) {}

  const flashFeePct = 0.05;
  const netPctBeforeGas = grossPct - flashFeePct;

  return {
    chain: chainName, tokenA, tokenB, decA, decB,
    buyOn: buyOnV3 ? "uniswap-v3" : "uniswap-v2",
    sellOn: buyOnV3 ? "uniswap-v2" : "uniswap-v3",
    uniFee: buyOnV3 ? v3Out.fee : null,
    grossPct,
    flashFeePct,
    netPctBeforeGas,
    gasCostUSD,
    nativePrice,
    measuredAt: new Date().toISOString(),
  };
}

// ============ 最適な取引サイズの推定 ============
export async function findOptimalSize(chainName, tokenA, tokenB, { maxUSD = 20000, gasCostUSD = 0.5 } = {}) {
  const cfg = CHAIN_CONFIG[chainName];
  const provider = getProvider(chainName);
  if (!cfg || !provider) return null;

  const decA = await getDecimals(provider, chainName, tokenA);
  if (decA === null) return null;

  let tokenAPriceUSD = null;
  if (tokenA.toLowerCase() === cfg.usdc.toLowerCase()) {
    tokenAPriceUSD = 1;
  } else {
    const oneUnit = 10n ** BigInt(decA);
    const q = await quoteV3(cfg, provider, tokenA, cfg.usdc, oneUnit)
      || { amountOut: await quoteV2(cfg, provider, tokenA, cfg.usdc, oneUnit) };
    if (q?.amountOut) {
      tokenAPriceUSD = parseFloat(ethers.formatUnits(q.amountOut, cfg.usdcDecimals));
    }
  }
  if (!tokenAPriceUSD || tokenAPriceUSD <= 0) return null;

  const sizes = [];
  for (let usd = 100; usd <= maxUSD; usd *= 2) sizes.push(usd);

  let best = null;
  const curve = [];
  for (const usd of sizes) {
    try {
      const tokenAmount = usd / tokenAPriceUSD;
      const amountIn = ethers.parseUnits(tokenAmount.toFixed(decA), decA);
      if (amountIn === 0n) continue;

      const [v2Out, v3Out] = await Promise.all([
        quoteV2(cfg, provider, tokenA, tokenB, amountIn),
        quoteV3(cfg, provider, tokenA, tokenB, amountIn),
      ]);
      if (!v2Out || !v3Out) continue;

      const buyOnV3 = v3Out.amountOut > v2Out;
      const buyAmount = buyOnV3 ? v3Out.amountOut : v2Out;
      const sellBack = buyOnV3
        ? await quoteV2(cfg, provider, tokenB, tokenA, buyAmount)
        : (await quoteV3(cfg, provider, tokenB, tokenA, buyAmount))?.amountOut;
      if (!sellBack) continue;

      const startUSD = usd;
      const endUSD = (Number(sellBack) / 10 ** decA) * tokenAPriceUSD;
      const grossUSD = endUSD - startUSD;
      const flashFeeUSD = startUSD * 0.0005;
      const netUSD = grossUSD - flashFeeUSD - gasCostUSD;

      curve.push({ sizeUSD: usd, netUSD });
      if (!best || netUSD > best.netUSD) {
        best = { sizeUSD: usd, netUSD, grossUSD, flashFeeUSD, gasCostUSD, buyOn: buyOnV3 ? "v3" : "v2" };
      } else if (best.netUSD > 0 && netUSD < best.netUSD * 0.5) {
        break;
      }
    } catch (e) {}
  }

  return best ? { ...best, tokenAPriceUSD, curve } : null;
}
