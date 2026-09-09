// scripts/execute-arb.js
//
// 観測システムが黒字と判定した案件を、実際にコントラクトのexecuteArbへ
// 送信する(またはDRY_RUNならログに記録するだけの)ロジック。
// chain-config.jsに登録済み・ルーター確認済みDEXの組み合わせのみを
// 対象とする(仕様書3.1〜3.2節に対応)。
//
// 実際に送信する金額は、段階的取引上限(scripts/trade-cap.js)で
// さらに絞られる。フラッシュローンなので「借りる金額自体」に
// リスクは無いが、まだ実績のないロジックをいきなり大きな金額で
// 動かすリスクを避けるため。

import { ethers } from "ethers";
import { getRouterAddress } from "../router-addresses.js";
import { getChainConfig } from "../chain-config.js";
import { getCurrentTradeCapUsd, recordExecutionSuccess } from "./trade-cap.js";
import { recordRealExecution } from "./real-execution-log.js";

const ERC20_DECIMALS_ABI = ["function decimals() view returns (uint8)"];
const PAIR_ABI = [
  "function getReserves() view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast)",
  "function token0() view returns (address)",
];
const CONTRACT_ABI = [
  "function executeArb(address asset, uint256 amount, (address routerCheap, address routerExpensive, address tokenX, address tokenY, uint256 minAmountOutStep1, uint256 minAmountOutStep2) params) external",
  "event ArbExecuted(address indexed tokenY, uint256 amountBorrowed, uint256 profit)",
];

const DEX_FEE_BPS_BY_ID = {
  aerodrome: 5,
  uniswap: 30,
  quickswap: 30,
  velodrome: 5,
  traderjoe: 30,
};
function getFeeBpsForDex(dexId) {
  return DEX_FEE_BPS_BY_ID[(dexId || "").toLowerCase()] ?? 30;
}

function getAmountOutBigInt(amountIn, reserveIn, reserveOut, feeBps) {
  const feeRetainNumerator = 10000n - BigInt(feeBps);
  const amountInWithFee = amountIn * feeRetainNumerator;
  const numerator = amountInWithFee * reserveOut;
  const denominator = reserveIn * 10000n + amountInWithFee;
  return denominator === 0n ? 0n : numerator / denominator;
}

const providerCache = new Map();
function getProviderForChain(rpcUrl) {
  if (!providerCache.has(rpcUrl)) {
    providerCache.set(rpcUrl, new ethers.JsonRpcProvider(rpcUrl));
  }
  return providerCache.get(rpcUrl);
}

const decimalsCache = new Map();
async function getTokenDecimals(tokenAddress, provider, chain) {
  const normalizedAddress = ethers.getAddress(tokenAddress);
  const key = `${chain}:${normalizedAddress.toLowerCase()}`;
  if (decimalsCache.has(key)) return decimalsCache.get(key);
  const contract = new ethers.Contract(normalizedAddress, ERC20_DECIMALS_ABI, provider);
  const decimals = Number(await contract.decimals());
  decimalsCache.set(key, decimals);
  return decimals;
}

async function getFreshReserves(pairAddress, tokenXAddress, provider) {
  if (!ethers.isAddress(pairAddress)) {
    throw new Error(`プールアドレスの形式が不正(標準的な20バイトアドレスではない): ${pairAddress}`);
  }
  const normalizedPairAddress = ethers.getAddress(pairAddress);
  const normalizedTokenX = ethers.getAddress(tokenXAddress);
  const pair = new ethers.Contract(normalizedPairAddress, PAIR_ABI, provider);
  const [reserves, token0] = await Promise.all([pair.getReserves(), pair.token0()]);
  const isToken0X = token0.toLowerCase() === normalizedTokenX.toLowerCase();
  return {
    reserveX: isToken0X ? reserves[0] : reserves[1],
    reserveY: isToken0X ? reserves[1] : reserves[0],
  };
}

const SLIPPAGE_TOLERANCE_BPS = 100n;

export async function maybeExecuteArb(observed) {
  const chainConfig = getChainConfig(observed.chain);
  if (!chainConfig) {
    return;
  }

  const routerCheap = getRouterAddress(observed.chain, observed.cheapDex);
  const routerExpensive = getRouterAddress(observed.chain, observed.expensiveDex);
  if (!routerCheap || !routerExpensive) {
    console.log(`[実行判定] ${observed.pairLabel}: ルーター未確認のため見送り`);
    return;
  }

  const contractAddress = process.env[chainConfig.contractAddressEnvVar];
  if (!contractAddress) {
    console.warn(`[実行判定] ${chainConfig.contractAddressEnvVar}が未設定のため見送り`);
    return;
  }

  const provider = getProviderForChain(chainConfig.rpcUrl);

  let decimalsY;
  try {
    decimalsY = await getTokenDecimals(observed.tokenB, provider, observed.chain);
  } catch (e) {
    console.warn(`[実行判定] ${observed.pairLabel}: トークンのdecimals取得に失敗、見送り:`, e.message);
    return;
  }

  const tradeCapUsd = getCurrentTradeCapUsd();
  let effectiveTradeAmountIn = observed.tradeAmountIn;
  if (observed.tradeAmountUsd > tradeCapUsd) {
    const priceUsdPerUnit = observed.tradeAmountUsd / observed.tradeAmountIn;
    effectiveTradeAmountIn = tradeCapUsd / priceUsdPerUnit;
  }

  const amountInStr = effectiveTradeAmountIn.toFixed(Math.min(decimalsY, 18));
  let amountIn;
  try {
    amountIn = ethers.parseUnits(amountInStr, decimalsY);
  } catch (e) {
    console.warn(`[実行判定] ${observed.pairLabel}: 投入額の変換に失敗、見送り:`, e.message);
    return;
  }

  let minAmountOutStep1, minAmountOutStep2;
  try {
    const [cheapReserves, expensiveReserves] = await Promise.all([
      getFreshReserves(observed.cheapPoolAddress, observed.tokenA, provider),
      getFreshReserves(observed.expensivePoolAddress, observed.tokenA, provider),
    ]);

    const feeBpsCheap = getFeeBpsForDex(observed.cheapDex);
    const feeBpsExpensive = getFeeBpsForDex(observed.expensiveDex);

    const xOutExpected = getAmountOutBigInt(amountIn, cheapReserves.reserveY, cheapReserves.reserveX, feeBpsCheap);
    const yOutExpected = getAmountOutBigInt(xOutExpected, expensiveReserves.reserveX, expensiveReserves.reserveY, feeBpsExpensive);

    if (yOutExpected <= amountIn) {
      console.log(`[実行判定] ${observed.pairLabel}: 実行直前の再計算で利益が消えていたため見送り(投入額と同等以下の受取見込み)`);
      return;
    }

    minAmountOutStep1 = (xOutExpected * (10000n - SLIPPAGE_TOLERANCE_BPS)) / 10000n;
    minAmountOutStep2 = (yOutExpected * (10000n - SLIPPAGE_TOLERANCE_BPS)) / 10000n;
  } catch (e) {
    console.warn(`[実行判定] ${observed.pairLabel}: プール状態の再確認に失敗、見送り:`, e.message);
    return;
  }

  const dryRun = process.env.DRY_RUN !== "false";

  console.log(`[実行判定] ${observed.pairLabel}: 投入額=${amountInStr}(${decimalsY}桁、取引上限$${tradeCapUsd}適用後) 想定純利益=+$${observed.netProfit.toFixed(2)} minAmountOutStep1=${minAmountOutStep1} minAmountOutStep2=${minAmountOutStep2} DRY_RUN=${dryRun}`);

  if (dryRun) {
    console.log(`[実行判定] DRY_RUNのため送信はスキップします(routerCheap=${routerCheap}, routerExpensive=${routerExpensive})`);
    return;
  }

  const privateKey = process.env.MAINNET_BOT_PRIVATE_KEY;
  if (!privateKey) {
    console.warn("[実行判定] MAINNET_BOT_PRIVATE_KEYが未設定のため見送り");
    return;
  }
  const wallet = new ethers.Wallet(privateKey, provider);
  const contract = new ethers.Contract(contractAddress, CONTRACT_ABI, wallet);

  try {
    const tx = await contract.executeArb(observed.tokenB, amountIn, {
      routerCheap,
      routerExpensive,
      tokenX: observed.tokenA,
      tokenY: observed.tokenB,
      minAmountOutStep1,
      minAmountOutStep2,
    });
    console.log(`[実行] トランザクション送信: ${tx.hash}`);
    const receipt = await tx.wait();
    console.log(`[実行] 完了: ブロック${receipt.blockNumber}, ガス使用量=${receipt.gasUsed.toString()}`);

    // コントラクトが発したArbExecutedイベントから、実際に確定した利益を
    // 直接読み取る(私たちの事前予測ではなく、オンチェーンの確定値)。
    let actualProfitTokens = null;
    try {
      for (const log of receipt.logs) {
        try {
          const parsed = contract.interface.parseLog({ topics: log.topics, data: log.data });
          if (parsed && parsed.name === "ArbExecuted") {
            actualProfitTokens = parseFloat(ethers.formatUnits(parsed.args.profit, decimalsY));
            break;
          }
        } catch (inner) { /* このログは別のイベント */ }
      }
    } catch (e) {
      console.warn("[実行] 利益イベントの読み取りに失敗:", e.message);
    }

    // Yトークン建ての利益を、観測時点のUSD換算レートでドルに直す。
    const priceUsdPerUnit = observed.tradeAmountUsd / observed.tradeAmountIn;
    const actualProfitUsd = actualProfitTokens !== null ? actualProfitTokens * priceUsdPerUnit : null;
    const gasCostUsd = null; // ネイティブトークンのUSD価格が必要なため、現時点では未算出

    if (actualProfitUsd !== null) {
      console.log(`[実行] 実際に確定した利益: +$${actualProfitUsd.toFixed(4)}(${actualProfitTokens} トークン)`);
    }

    recordRealExecution({
      timestamp: new Date().toISOString(),
      pairLabel: observed.pairLabel,
      chain: observed.chain,
      txHash: tx.hash,
      explorerUrl: chainConfig.explorerTxUrl(tx.hash),
      tradeAmountUsd: Math.min(observed.tradeAmountUsd, tradeCapUsd),
      predictedProfitUsd: observed.netProfit,
      actualProfitUsd,
      gasUsed: receipt.gasUsed.toString(),
      gasCostUsd,
    });

    recordExecutionSuccess();
  } catch (e) {
    console.error("[実行] 失敗:", e.message);
  }
}
