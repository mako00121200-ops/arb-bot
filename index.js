import "dotenv/config";
import { ethers } from "ethers";
import { compileFlashArbitrage } from "./compile.js";
import { CHAIN, scanAll } from "./scanner.js";

const RPC_URL = process.env.RPC_URL || "https://arb1.arbitrum.io/rpc";
// フロントランニング対策: トランザクション送信だけは保護されたRPC(MEV Blocker)を経由する。
// 読み取り専用のスキャンには影響しないので、公開RPCのまま高速に動かせる。
const PROTECTED_RPC_URL = process.env.PROTECTED_RPC_URL || "https://rpc.mevblocker.io";
const PRIVATE_KEY = process.env.PRIVATE_KEY;
const MIN_PROFIT_USD = parseFloat(process.env.MIN_PROFIT_USD || "2");
const TRADE_USD = parseFloat(process.env.TRADE_USD || "500");
const SCAN_INTERVAL_SEC = parseInt(process.env.SCAN_INTERVAL_SEC || "60", 10);
const DRY_RUN = (process.env.DRY_RUN || "true").toLowerCase() !== "false";
let CONTRACT_ADDRESS = process.env.CONTRACT_ADDRESS || null;

if (!PRIVATE_KEY) {
  console.error("環境変数 PRIVATE_KEY が設定されていません。Railwayの Variables 画面から設定してください。");
  process.exit(1);
}

// 読み取り専用(スキャン・デプロイ確認用): 高速な公開RPC
const provider = new ethers.JsonRpcProvider(RPC_URL);
const wallet = new ethers.Wallet(PRIVATE_KEY, provider);

// 送信専用(実際のトランザクション送信用): MEV保護RPC経由でフロントランニングを防ぐ
const sendProvider = new ethers.JsonRpcProvider(PROTECTED_RPC_URL);
const sendWallet = new ethers.Wallet(PRIVATE_KEY, sendProvider);

const ABI_FLASH_ARB = [
  "function executeArbitrage(address asset,uint256 amount,address baseToken,bool buyOnUni,uint24 uniFee,uint256 minBaseOut,uint256 minAssetOut) external",
  "event ArbitrageExecuted(address indexed asset, uint256 borrowed, uint256 profit)",
];

async function ensureContractDeployed() {
  if (CONTRACT_ADDRESS) {
    const code = await provider.getCode(CONTRACT_ADDRESS);
    if (code && code !== "0x") {
      console.log(`既存のFlashArbitrageコントラクトを使用します: ${CONTRACT_ADDRESS}`);
      return CONTRACT_ADDRESS;
    }
    console.warn(`CONTRACT_ADDRESS(${CONTRACT_ADDRESS})にコードが見つかりません。再デプロイします。`);
  }

  console.log("FlashArbitrageコントラクトをコンパイルしています…");
  const { abi, bytecode } = compileFlashArbitrage();

  console.log("FlashArbitrageコントラクトをデプロイしています…");
  const factory = new ethers.ContractFactory(abi, bytecode, wallet);
  const contract = await factory.deploy(CHAIN.aavePool, CHAIN.uniRouter, CHAIN.sushiRouter);
  await contract.waitForDeployment();
  const address = await contract.getAddress();

  console.log("========================================");
  console.log(`デプロイ完了: ${address}`);
  console.log("次回以降の再デプロイを避けるため、Railwayの Variables に");
  console.log(`CONTRACT_ADDRESS=${address}`);
  console.log("を追加してください。");
  console.log("========================================");

  CONTRACT_ADDRESS = address;
  return address;
}

async function runOnce(contractAddress) {
  console.log(`[${new Date().toISOString()}] スキャン開始 (${CHAIN.name})`);
  const { opportunities, pairsScanned } = await scanAll(provider, { tradeUSD: TRADE_USD });
  console.log(`スキャン完了。${pairsScanned}ペア中 ${opportunities.length}件で見積もり取得。`);

  const best = opportunities[0];
  if (!best) {
    console.log("有効な見積もりが得られませんでした。");
    return;
  }
  console.log(`最良の機会: ${best.pair} 純利益見込み $${best.netUSD.toFixed(2)}`);

  if (best.netUSD < MIN_PROFIT_USD) {
    console.log(`最低純利益($${MIN_PROFIT_USD})未満のため実行しません。`);
    return;
  }

  if (DRY_RUN) {
    console.log("DRY_RUN=true のため、実行はシミュレートのみです。実際のトランザクションは送信しません。");
    return;
  }

  console.log("実行します(MEV保護RPC経由で送信)…");
  const contract = new ethers.Contract(contractAddress, ABI_FLASH_ARB, sendWallet);
  try {
    const tx = await contract.executeArbitrage(
      best.assetToken,
      ethers.parseUnits(best.tradeUSD.toFixed(best.assetDecimals), best.assetDecimals),
      best.baseToken,
      best.buyOnUni,
      best.uniFee,
      best.minBaseOut,
      best.minAssetOut
    );
    console.log(`Tx送信: ${tx.hash}`);
    const receipt = await tx.wait();
    console.log(`確定しました。ブロック: ${receipt.blockNumber}`);
  } catch (e) {
    console.error("実行に失敗しました:", e.message);
  }
}

async function main() {
  console.log("=== Arbitrageボット起動 ===");
  console.log(`ウォレット: ${wallet.address}`);
  console.log(`DRY_RUN: ${DRY_RUN}`);
  const contractAddress = await ensureContractDeployed();

  while (true) {
    try {
      await runOnce(contractAddress);
    } catch (e) {
      console.error("スキャンサイクルでエラー:", e.message);
    }
    await new Promise((r) => setTimeout(r, SCAN_INTERVAL_SEC * 1000));
  }
}

main().catch((e) => {
  console.error("致命的エラー:", e);
  process.exit(1);
});
