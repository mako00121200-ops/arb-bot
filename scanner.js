import { ethers } from "ethers";

// Arbitrum One の設定
export const CHAIN = {
  name: "Arbitrum One",
  chainId: 42161,
  weth: "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1",
  usdc: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831",
  usdcDecimals: 6,
  uniQuoterV2: "0x61fFE014bA17989E743c5F6cB21bF9697530B21e",
  uniRouter: "0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45",
  uniFactory: "0x1F98431c8aD98523631AE4a59f267346ea31F984",
  sushiRouter: "0xd9e1cE17f2641f24aE83637ab66a2cca9C378B9F",
  aavePool: "0x794a61358D6845594F94dc1DB02A252b5b4814aD",
  tokens: {
    WETH: { address: "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1", decimals: 18, stable: false },
    USDC: { address: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831", decimals: 6, stable: true },
    USDT: { address: "0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9", decimals: 6, stable: true },
    DAI: { address: "0xDA10009cBd5D07dd0CeCc66161FC93D7c9000da1", decimals: 18, stable: true },
    WBTC: { address: "0x2f2a2543B76A4166549F7aaB2e75Bef0aefC5B0f", decimals: 8, stable: false },
    LINK: { address: "0xf97f4df75117a78c1A5a0DBb814Af92458539FB4", decimals: 18, stable: false },
    ARB: { address: "0x912CE59144191C1204E64559FE8253a0e49E6548", decimals: 18, stable: false },
  },
};

const FEE_TIERS = [500, 3000, 10000];
const STABLE_SYMBOLS = new Set(["USDC", "USDT", "DAI", "FRAX", "LUSD", "TUSD", "USDP", "GUSD", "SUSD", "BUSD", "USDC.E", "USDBC"]);

const ABI_QUOTER_V2 = [
  "function quoteExactInputSingle((address tokenIn,address tokenOut,uint256 amountIn,uint24 fee,uint160 sqrtPriceLimitX96)) returns (uint256 amountOut,uint160 sqrtPriceX96After,uint32 initializedTicksCrossed,uint256 gasEstimate)",
];
const ABI_SUSHI_ROUTER = [
  "function getAmountsOut(uint256 amountIn, address[] calldata path) view returns (uint256[] memory amounts)",
];

let tokenListCache = null;
async function fetchTokenList() {
  if (tokenListCache) return tokenListCache;
  try {
    const res = await fetch("https://tokens.uniswap.org");
    const json = await res.json();
    tokenListCache = json.tokens || [];
  } catch (e) {
    console.error("トークンリスト取得失敗:", e.message);
    tokenListCache = [];
  }
  return tokenListCache;
}

export async function buildTokenMap(maxTokens = 150) {
  const map = { ...CHAIN.tokens };
  const list = await fetchTokenList();
  const filtered = list.filter((t) => t.chainId === CHAIN.chainId);
  let added = 0;
  for (const t of filtered) {
    if (added >= maxTokens) break;
    if (!t.address || !t.decimals || map[t.symbol]) continue;
    map[t.symbol] = { address: t.address, decimals: t.decimals, stable: STABLE_SYMBOLS.has((t.symbol || "").toUpperCase()) };
    added++;
  }
  return map;
}

function buildPairs(tokenMap, primaryStableSym = "USDC") {
  const pairs = [];
  for (const sym of Object.keys(tokenMap)) {
    if (sym === primaryStableSym) continue;
    pairs.push({ baseSym: sym, quoteSym: primaryStableSym });
  }
  return pairs;
}

async function bestUniV3Quote(provider, tokenIn, tokenOut, amountIn, feeTiers = FEE_TIERS) {
  const quoter = new ethers.Contract(CHAIN.uniQuoterV2, ABI_QUOTER_V2, provider);
  let best = null;
  for (const fee of feeTiers) {
    try {
      const r = await quoter.quoteExactInputSingle.staticCall({ tokenIn, tokenOut, amountIn, fee, sqrtPriceLimitX96: 0n });
      if (!best || r[0] > best.amountOut) best = { amountOut: r[0], fee };
    } catch (e) {}
  }
  return best;
}

async function sushiQuote(provider, tokenIn, tokenOut, amountIn) {
  const router = new ethers.Contract(CHAIN.sushiRouter, ABI_SUSHI_ROUTER, provider);
  try {
    const amounts = await router.getAmountsOut(amountIn, [tokenIn, tokenOut]);
    return amounts[amounts.length - 1];
  } catch (e) {
    return null;
  }
}

export async function scanAll(provider, { tradeUSD = 100, gasUnitsTwoLegs = 400000n } = {}) {
  const tokenMap = await buildTokenMap();
  const pairs = buildPairs(tokenMap, "USDC");

  const oneEth = ethers.parseUnits("1", 18);
  const ethQuote = await bestUniV3Quote(provider, CHAIN.weth, CHAIN.usdc, oneEth);
  if (!ethQuote) throw new Error("ETH価格の取得に失敗");
  const ethPriceUSD = parseFloat(ethers.formatUnits(ethQuote.amountOut, CHAIN.usdcDecimals));

  const feeData = await provider.getFeeData();
  const gasPriceWei = feeData.gasPrice ?? 0n;
  const gasCostUSD = parseFloat(ethers.formatUnits(gasPriceWei * gasUnitsTwoLegs, 18)) * ethPriceUSD;

  const candidates = [];
  const BATCH = 15;
  for (let i = 0; i < pairs.length; i += BATCH) {
    const batch = pairs.slice(i, i + BATCH);
    const results = await Promise.all(
      batch.map(async ({ baseSym, quoteSym }) => {
        try {
          const base = tokenMap[baseSym], quote = tokenMap[quoteSym];
          const amountIn = ethers.parseUnits(tradeUSD.toFixed(quote.decimals), quote.decimals);
          const uni = await bestUniV3Quote(provider, quote.address, base.address, amountIn, [3000]);
          const sushi = await sushiQuote(provider, quote.address, base.address, amountIn);
          if (!uni || !sushi) return null;
          const diff = uni.amountOut > sushi ? uni.amountOut - sushi : sushi - uni.amountOut;
          const smaller = uni.amountOut > sushi ? sushi : uni.amountOut;
          if (smaller === 0n) return null;
          const skewPct = Number((diff * 10000n) / smaller) / 100;
          return { baseSym, quoteSym, skewPct };
        } catch (e) {
          return null;
        }
      })
    );
    for (const r of results) if (r && r.skewPct > 0.15) candidates.push(r);
  }
  candidates.sort((a, b) => b.skewPct - a.skewPct);
  const shortlist = candidates.slice(0, 40);

  const opportunities = [];
  for (const { baseSym, quoteSym } of shortlist) {
    try {
      const base = tokenMap[baseSym], quote = tokenMap[quoteSym];
      const amountIn = ethers.parseUnits(tradeUSD.toFixed(quote.decimals), quote.decimals);
      const uni = await bestUniV3Quote(provider, quote.address, base.address, amountIn);
      const sushi = await sushiQuote(provider, quote.address, base.address, amountIn);
      if (!uni || !sushi) continue;

      const buyOnUni = uni.amountOut > sushi;
      const buyAmount = buyOnUni ? uni.amountOut : sushi;
      const backOut = buyOnUni
        ? await sushiQuote(provider, base.address, quote.address, buyAmount)
        : (await bestUniV3Quote(provider, base.address, quote.address, buyAmount))?.amountOut;
      if (!backOut) continue;

      const grossUSD = parseFloat(ethers.formatUnits(backOut, quote.decimals)) - tradeUSD;
      const netUSD = grossUSD - gasCostUSD;

      opportunities.push({
        pair: `${baseSym}/${quoteSym}`,
        baseToken: base.address,
        assetToken: quote.address,
        assetDecimals: quote.decimals,
        buyOnUni,
        uniFee: uni.fee,
        tradeUSD,
        minBaseOut: (buyAmount * 995n) / 1000n,
        minAssetOut: (backOut * 995n) / 1000n,
        grossUSD,
        gasCostUSD,
        netUSD,
      });
    } catch (e) {}
  }

  opportunities.sort((a, b) => b.netUSD - a.netUSD);
  return { opportunities, pairsScanned: pairs.length, candidatesFound: candidates.length };
}
