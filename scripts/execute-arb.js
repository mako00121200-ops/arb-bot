// scripts/execute-arb.js
//
// 観測システムが黒字と判定した案件を、実際にコントラクトのexecuteArbへ
// 送信する(またはDRY_RUNならログに記録するだけの)ロジック。
// chain-config.jsに登録済み・ルーター確認済みDEXの組み合わせのみを
// 対象とする(仕様書3.1〜3.2節に対応)。

import { ethers } from "ethers";
import { getRouterAddress } from "../router-addresses.js";
import { getChainConfig } from "../chain-config.js";

const ERC20_DECIMALS_ABI = ["function decimals() view returns (uint8)"];
const PAIR_ABI = [
  "function getReserves() view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast)",
  "function token0() view returns (address)",
];
const CONTRACT_ABI = [
  "function executeArb(address asset, uint256 amount, (address routerCheap, address routerExpensive, address tokenX, address tokenY, uint256 minAmountOutStep1, uint256 minAmountOutStep2) params) external",
];

// index.jsのDEX_DEFAULT_FEE_BY_DEXと揃えた、確認済みDEXの手数料(bps)。
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

// Uniswap V2形式の定数積AMM計算をBigIntで行う(オンチェーンと同じ精度)。
function getAmountOutBigInt(amountIn, reserveIn, reserveOut, feeBps) {
  const feeRetainNumerator = 10000n - BigInt(feeBps);
  const amountInWithFee = amountIn * feeRetainNumerator;
  const numerator = amountInWithFee * reserveOut;
  const denominator = reserveIn * 10000n + amountInWithFee;
  return denominator === 0n ? 0n : numerator / denominator;
}

// チェーンごとにprovider接続を使い回す。
const providerCache = new Map();
function getProviderForChain(rpcUrl) {
  if (!providerCache.has(rpcUrl)) {
    providerCache.set(rpcUrl, new ethers.JsonRpcProvider(rpcUrl));
  }
  return providerCache.get(rpcUrl);
}

// トークンごとの桁数(decimals)は、外部サイトの情報に頼らず、
// ブロックチェーン自身に直接問い合わせて確認する(確実性のため)。
// 複数チェーンで同じトークンアドレスが別物のことがあるため、
// チェーン名も含めてキャッシュする。
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

// 実行直前に、プールの現在の準備量を直接読み直す(観測データは
// 最大3分前のスナップショットのため、実行直前の再確認として必須)。
// Uniswap V4等、通常の20バイトアドレスを持たない方式のプールを
// 事前に弾く。
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

const SLIPPAGE_TOLERANCE_BPS = 100n; // 1%の余裕

// observed: dexWatchOnePairが返す観測結果オブジェクト(profitable===trueのもの)
export async function maybeExecuteArb(observed) {
  const chainConfig = getChainConfig(observed.chain);
  if (!chainConfig) {
    return; // chain-config.jsに未登録のチェーンは対象外。
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

  // tradeAmountInはJSの浮動小数点数のため、精度を保つよう文字列経由でBigIntへ変換する。
  const amountInStr = observed.tradeAmountIn.toFixed(Math.min(decimalsY, 18));
  let amountIn;
  try {
    amountIn = ethers.parseUnits(amountInStr, decimalsY);
  } catch (e) {
    console.warn(`[実行判定] ${observed.pairLabel}: 投入額の変換に失敗、見送り:`, e.message);
    return;
  }

  // 実行直前にプールの現在の状態を直接読み直し、そこから期待される
  // 受取量を計算する。観測時点(最大3分前)からズレていないかの
  // 再確認も兼ねる。
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

  const dryRun = process.env.DRY_RUN !== "false"; // 明示的にfalseにしない限り常に安全側

  console.log(`[実行判定] ${observed.pairLabel}: 投入額=${amountInStr}(${decimalsY}桁) 想定純利益=+$${observed.netProfit.toFixed(2)} minAmountOutStep1=${minAmountOutStep1} minAmountOutStep2=${minAmountOutStep2} DRY_RUN=${dryRun}`);

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
  } catch (e) {
    console.error("[実行] 失敗:", e.message);
  }
}
