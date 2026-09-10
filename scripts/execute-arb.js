// scripts/execute-arb.js
//
// 観測システムが黒字と判定した案件を、実際にコントラクトのexecuteArbへ
// 送信する(またはDRY_RUNならログに記録するだけの)ロジック。
// chain-config.jsに登録済み・ルーター確認済みDEXの組み合わせのみが対象。
//
// ルーターの呼び出し形式(Uniswap V2形式 / Solidly形式)は
// router-addresses.js の kind を見てコントラクトへ明示的に渡す。
// RPCへの接続は onchain-reserves.js の複数RPC対応の仕組みを共用する。

import { ethers } from "ethers";
import { getRouterInfo, ROUTER_KIND_ENUM } from "../router-addresses.js";
import { getChainConfig } from "../chain-config.js";
import { getCurrentTradeCapUsd, recordExecutionSuccess } from "./trade-cap.js";
import { recordRealExecution } from "./real-execution-log.js";
import { isKnownIncompatiblePool, recordIncompatiblePool } from "./incompatible-pools.js";
import { getProviderForChain, fetchOnchainReserves, fetchTokenDecimals } from "./onchain-reserves.js";

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

const SLIPPAGE_TOLERANCE_BPS = 100n;

// index.jsのdexNormalizeChainと同じ変換。DeFiLlamaが "OP Mainnet" のような
// 表記を使うため、chain-config.jsのキーに合わせる必要がある。
function normalizeChain(chain) {
  const map = {
    base: "base",
    arbitrum: "arbitrum",
    optimism: "optimism",
    "op mainnet": "optimism",
    ethereum: "ethereum",
  };
  return map[(chain || "").toLowerCase()] || (chain || "").toLowerCase();
}

export async function maybeExecuteArb(observed) {
  const chain = normalizeChain(observed.chain);
  const chainConfig = getChainConfig(chain);
  if (!chainConfig) return;

  const infoCheap = getRouterInfo(chain, observed.cheapDex);
  const infoExpensive = getRouterInfo(chain, observed.expensiveDex);
  if (!infoCheap || !infoExpensive) {
    console.log(`[実行判定] ${observed.pairLabel}: ルーター未確認のため見送り`);
    return;
  }

  const cheapKnownBad = isKnownIncompatiblePool(chain, observed.cheapPoolAddress);
  const expensiveKnownBad = isKnownIncompatiblePool(chain, observed.expensivePoolAddress);
  if (cheapKnownBad || expensiveKnownBad) {
    console.log(`[実行判定] ${observed.pairLabel}: 既知の非対応プールのため見送り`);
    return;
  }

  const contractAddress = process.env[chainConfig.contractAddressEnvVar];
  if (!contractAddress) {
    console.warn(`[実行判定] ${chainConfig.contractAddressEnvVar}が未設定のため見送り`);
    return;
  }

  let decimalsX, decimalsY;
  try {
    [decimalsX, decimalsY] = await Promise.all([
      fetchTokenDecimals(chain, observed.tokenA),
      fetchTokenDecimals(chain, observed.tokenB),
    ]);
  } catch (e) {
    console.warn(`[実行判定] ${observed.pairLabel}: decimals取得に失敗、見送り:`, e.message);
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

  // 実行直前にプールの現在の状態を読み直す(観測時点から動いていないかの再確認)。
  let cheapReserves, expensiveReserves;
  try {
    cheapReserves = await fetchOnchainReserves({
      chain, pairAddress: observed.cheapPoolAddress, tokenXAddress: observed.tokenA, decimalsX, decimalsY,
    });
  } catch (e) {
    recordIncompatiblePool(chain, observed.cheapPoolAddress, e.message);
    console.warn(`[実行判定] ${observed.pairLabel}: 安い方のプール再確認に失敗、見送り:`, e.message);
    return;
  }
  try {
    expensiveReserves = await fetchOnchainReserves({
      chain, pairAddress: observed.expensivePoolAddress, tokenXAddress: observed.tokenA, decimalsX, decimalsY,
    });
  } catch (e) {
    recordIncompatiblePool(chain, observed.expensivePoolAddress, e.message);
    console.warn(`[実行判定] ${observed.pairLabel}: 高い方のプール再確認に失敗、見送り:`, e.message);
    return;
  }

  // 最低受取量の計算はコントラクトへ渡す生の整数で行う必要があるため、
  // 小数で受け取った準備量を最小単位に戻す。
  const reserveCheapX = ethers.parseUnits(cheapReserves.reserveX.toFixed(Math.min(decimalsX, 18)), decimalsX);
  const reserveCheapY = ethers.parseUnits(cheapReserves.reserveY.toFixed(Math.min(decimalsY, 18)), decimalsY);
  const reserveExpX = ethers.parseUnits(expensiveReserves.reserveX.toFixed(Math.min(decimalsX, 18)), decimalsX);
  const reserveExpY = ethers.parseUnits(expensiveReserves.reserveY.toFixed(Math.min(decimalsY, 18)), decimalsY);

  const xOutExpected = getAmountOutBigInt(amountIn, reserveCheapY, reserveCheapX, infoCheap.feeBps);
  const yOutExpected = getAmountOutBigInt(xOutExpected, reserveExpX, reserveExpY, infoExpensive.feeBps);

  if (yOutExpected <= amountIn) {
    console.log(`[実行判定] ${observed.pairLabel}: 実行直前の再計算で利益が消えていたため見送り`);
    return;
  }

  const minAmountOutStep1 = (xOutExpected * (10000n - SLIPPAGE_TOLERANCE_BPS)) / 10000n;
  const minAmountOutStep2 = (yOutExpected * (10000n - SLIPPAGE_TOLERANCE_BPS)) / 10000n;

  const dryRun = process.env.DRY_RUN !== "false";

  console.log(`[実行判定] ${observed.pairLabel}: 投入額=${amountInStr}(取引上限$${tradeCapUsd}適用後) 想定純利益=+$${observed.netProfit.toFixed(2)} 形式=${infoCheap.kind}→${infoExpensive.kind} DRY_RUN=${dryRun}`);

  if (dryRun) {
    console.log(`[実行判定] DRY_RUNのため送信はスキップします`);
    return;
  }

  const privateKey = process.env.MAINNET_BOT_PRIVATE_KEY;
  if (!privateKey) {
    console.warn("[実行判定] MAINNET_BOT_PRIVATE_KEYが未設定のため見送り");
    return;
  }

  const provider = getProviderForChain(chain);
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
      chain,
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
