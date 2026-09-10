// scripts/execute-arb.js
//
// 観測システムが黒字と判定した案件を、実際にコントラクトのexecuteArbへ
// 送信する(またはDRY_RUNならログに記録するだけの)ロジック。
// chain-config.jsに登録済み・ルーター確認済みDEXの組み合わせのみが対象。
//
// ルーターの呼び出し形式(Uniswap V2形式 / Solidly形式)は
// router-addresses.js の kind を見てコントラクトへ明示的に渡す。
// 以前はすべてUniswap V2形式と仮定していたため、Aerodrome・Velodromeが
// 絡む案件は必ず失敗していた。

import { ethers } from "ethers";
import { getRouterInfo, ROUTER_KIND_ENUM } from "../router-addresses.js";
import { getChainConfig } from "../chain-config.js";
import { getCurrentTradeCapUsd, recordExecutionSuccess } from "./trade-cap.js";
import { recordRealExecution } from "./real-execution-log.js";
import { isKnownIncompatiblePool, recordIncompatiblePool } from "./incompatible-pools.js";

const ERC20_DECIMALS_ABI = ["function decimals() view returns (uint8)"];
const PAIR_ABI = [
  "function getReserves() view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast)",
  "function token0() view returns (address)",
];
const CONTRACT_ABI = [
  "function executeArb(address asset, uint256 amount, (address routerCheap, address routerExpensive, address tokenX, address tokenY, uint256 minAmountOutStep1, uint256 minAmountOutStep2, uint8 kindCheap, uint8 kindExpensive) params) external",
  "event ArbExecuted(address indexed tokenY, uint256 amountBorrowed, uint256 profit)",
];

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
  if (!chainConfig) return;

  const infoCheap = getRouterInfo(observed.chain, observed.cheapDex);
  const infoExpensive = getRouterInfo(observed.chain, observed.expensiveDex);
  if (!infoCheap || !infoExpensive) {
    console.log(`[実行判定] ${observed.pairLabel}: ルーター未確認のため見送り`);
    return;
  }

  const cheapKnownBad = isKnownIncompatiblePool(observed.chain, observed.cheapPoolAddress);
  const expensiveKnownBad = isKnownIncompatiblePool(observed.chain, observed.expensivePoolAddress);
  if (cheapKnownBad || expensiveKnownBad) {
    console.log(`[実行判定] ${observed.pairLabel}: 既知の非対応プールのため見送り(${(cheapKnownBad || expensiveKnownBad).reason})`);
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

  let cheapReserves, expensiveReserves;
  try {
    cheapReserves = await getFreshReserves(observed.cheapPoolAddress, observed.tokenA, provider);
  } catch (e) {
    recordIncompatiblePool(observed.chain, observed.cheapPoolAddress, e.message);
    console.warn(`[実行判定] ${observed.pairLabel}: 安い方のプール状態の再確認に失敗、見送り:`, e.message);
    return;
  }
  try {
    expensiveReserves = await getFreshReserves(observed.expensivePoolAddress, observed.tokenA, provider);
  } catch (e) {
    recordIncompatiblePool(observed.chain, observed.expensivePoolAddress, e.message);
    console.warn(`[実行判定] ${observed.pairLabel}: 高い方のプール状態の再確認に失敗、見送り:`, e.message);
    return;
  }

  const xOutExpected = getAmountOutBigInt(amountIn, cheapReserves.reserveY, cheapReserves.reserveX, infoCheap.feeBps);
  const yOutExpected = getAmountOutBigInt(xOutExpected, expensiveReserves.reserveX, expensiveReserves.reserveY, infoExpensive.feeBps);

  if (yOutExpected <= amountIn) {
    console.log(`[実行判定] ${observed.pairLabel}: 実行直前の再計算で利益が消えていたため見送り(投入額と同等以下の受取見込み)`);
    return;
  }

  const minAmountOutStep1 = (xOutExpected * (10000n - SLIPPAGE_TOLERANCE_BPS)) / 10000n;
  const minAmountOutStep2 = (yOutExpected * (10000n - SLIPPAGE_TOLERANCE_BPS)) / 10000n;

  const dryRun = process.env.DRY_RUN !== "false";

  console.log(`[実行判定] ${observed.pairLabel}: 投入額=${amountInStr}(${decimalsY}桁、取引上限$${tradeCapUsd}適用後) 想定純利益=+$${observed.netProfit.toFixed(2)} 形式=${infoCheap.kind}→${infoExpensive.kind} DRY_RUN=${dryRun}`);

  if (dryRun) {
    console.log(`[実行判定] DRY_RUNのため送信はスキップします(routerCheap=${infoCheap.address}, routerExpensive=${infoExpensive.address})`);
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
      routerCheap: infoCheap.address,
      routerExpensive: infoExpensive.address,
      tokenX: observed.tokenA,
      tokenY: observed.tokenB,
      minAmountOutStep1,
      minAmountOutStep2,
      kindCheap: ROUTER_KIND_ENUM[infoCheap.kind],
      kindExpensive: ROUTER_KIND_ENUM[infoExpensive.kind],
    });
    console.log(`[実行] トランザクション送信: ${tx.hash}`);
    const receipt = await tx.wait();
    console.log(`[実行] 完了: ブロック${receipt.blockNumber}, ガス使用量=${receipt.gasUsed.toString()}`);

    let actualProfitTokens = null;
    for (const log of receipt.logs) {
      try {
        const parsed = contract.interface.parseLog({ topics: log.topics, data: log.data });
        if (parsed && parsed.name === "ArbExecuted") {
          actualProfitTokens = parseFloat(ethers.formatUnits(parsed.args.profit, decimalsY));
          break;
        }
      } catch (inner) { /* このログは別のイベント */ }
    }

    const priceUsdPerUnit = observed.tradeAmountUsd / observed.tradeAmountIn;
    const actualProfitUsd = actualProfitTokens !== null ? actualProfitTokens * priceUsdPerUnit : null;

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
      gasCostUsd: null,
    });

    recordExecutionSuccess();
  } catch (e) {
    console.error("[実行] 失敗:", e.message);
  }
}
