// scripts/mainnet-deploy.js
//
// テストネットで検証済みの同じコントラクトを、実際のBase mainnetにデプロイする。
// RUN_MAINNET_DEPLOY=true が設定されている場合のみ、起動時に1回だけ実行される
// (index.js側のフックから呼び出される)。
//
// bot専用ウォレット(取引資金ではなくガス代の備蓄のみを保有)から実行する。

import { ethers } from "ethers";
import { AaveV3Base } from "@aave-dao/aave-address-book";
import { compileContract } from "./compile-contract.js";

export async function runMainnetDeploy() {
  console.log("[本番デプロイ] 開始: Base mainnetへのデプロイ");

  const privateKey = process.env.MAINNET_BOT_PRIVATE_KEY;
  if (!privateKey) {
    console.warn("[本番デプロイ] MAINNET_BOT_PRIVATE_KEYが未設定のためスキップします");
    return;
  }

  console.log("[本番デプロイ] コンパイル中...");
  const { abi, bytecode } = compileContract();
  console.log("[本番デプロイ] コンパイル成功");

  const provider = new ethers.JsonRpcProvider("https://mainnet.base.org");
  const wallet = new ethers.Wallet(privateKey, provider);

  const balance = await provider.getBalance(wallet.address);
  console.log(`[本番デプロイ] デプロイ用ウォレット: ${wallet.address} (残高: ${ethers.formatEther(balance)} ETH)`);

  // Aave公式のアドレス帳から、Base mainnetのPoolAddressesProviderを取得する
  // (手打ちのアドレスを使わないことで設定ミスを防ぐ)
  const addressesProvider = AaveV3Base.POOL_ADDRESSES_PROVIDER;
  console.log(`[本番デプロイ] Aave PoolAddressesProvider: ${addressesProvider}`);

  const factory = new ethers.ContractFactory(abi, bytecode, wallet);
  console.log("[本番デプロイ] デプロイ送信中...");
  const contract = await factory.deploy(addressesProvider);
  const deployTx = contract.deploymentTransaction();
  console.log(`[本番デプロイ] トランザクション送信済み: ${deployTx.hash}`);

  await contract.waitForDeployment();
  const deployedAddress = await contract.getAddress();
  const txReceipt = await provider.getTransactionReceipt(deployTx.hash);

  console.log(`[本番デプロイ] デプロイ成功: ${deployedAddress}`);
  console.log(`[本番デプロイ] 使用ガス: ${txReceipt.gasUsed.toString()} units`);
  console.log(`[本番デプロイ] ガス代: ${ethers.formatEther(txReceipt.gasUsed * txReceipt.gasPrice)} ETH`);
  console.log(`[本番デプロイ] 確認用: https://basescan.org/tx/${deployTx.hash}`);

  const retryDelaysMs = [1000, 2000, 4000];
  let deployedPool = null;
  for (const delayMs of retryDelaysMs) {
    await new Promise((r) => setTimeout(r, delayMs));
    try {
      deployedPool = await contract.POOL();
      break;
    } catch (e) {
      console.warn(`[本番デプロイ] POOL確認コール失敗(${delayMs}ms待機後)、再試行します:`, e.message);
    }
  }

  if (deployedPool) {
    console.log(`[本番デプロイ] コントラクトが認識しているAave Poolアドレス: ${deployedPool}`);
  }

  console.log(`[本番デプロイ] === 重要: このアドレスを記録してください === ${deployedAddress}`);
  console.log("[本番デプロイ] 完了");
}
