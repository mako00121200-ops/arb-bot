// scripts/testnet-deploy-check.js
//
// 6節の未確定事項⑥(テストネットでのコントラクト動作検証)に対応するスクリプト。
// RUN_TESTNET_DEPLOY_CHECK=true が設定されている場合のみ、起動時に1回だけ実行される
// (index.js側のフックから呼び出される)。

import { ethers } from "ethers";
import { AaveV3BaseSepolia } from "@aave-dao/aave-address-book";
import { compileContract } from "./compile-contract.js";

export async function runTestnetDeployCheck() {
  console.log("[テストネット検証] 開始: Base Sepoliaへのデプロイ確認");

  const privateKey = process.env.TESTNET_PRIVATE_KEY;
  if (!privateKey) {
    console.warn("[テストネット検証] TESTNET_PRIVATE_KEYが未設定のためスキップします");
    return;
  }

  console.log("[テストネット検証] コンパイル中...");
  const { abi, bytecode } = compileContract();
  console.log("[テストネット検証] コンパイル成功");

  const provider = new ethers.JsonRpcProvider("https://sepolia.base.org");
  const wallet = new ethers.Wallet(privateKey, provider);

  const balance = await provider.getBalance(wallet.address);
  console.log(`[テストネット検証] デプロイ用ウォレット: ${wallet.address} (残高: ${ethers.formatEther(balance)} ETH)`);

  // Aave公式のアドレス帳から、Base SepoliaのPoolAddressesProviderを取得する
  // (手打ちのアドレスを使わないことで、以前のBASE_WSS_URLのような設定ミスを防ぐ)
  const addressesProvider = AaveV3BaseSepolia.POOL_ADDRESSES_PROVIDER;
  console.log(`[テストネット検証] Aave PoolAddressesProvider: ${addressesProvider}`);

  const factory = new ethers.ContractFactory(abi, bytecode, wallet);
  console.log("[テストネット検証] デプロイ送信中...");
  const contract = await factory.deploy(addressesProvider);
  const deployTx = contract.deploymentTransaction();
  console.log(`[テストネット検証] トランザクション送信済み: ${deployTx.hash}`);

  const receipt = await contract.waitForDeployment();
  const deployedAddress = await contract.getAddress();
  const txReceipt = await provider.getTransactionReceipt(deployTx.hash);

  console.log(`[テストネット検証] デプロイ成功: ${deployedAddress}`);
  console.log(`[テストネット検証] 使用ガス: ${txReceipt.gasUsed.toString()} units`);
  console.log(`[テストネット検証] ガス代: ${ethers.formatEther(txReceipt.gasUsed * txReceipt.gasPrice)} ETH`);
  console.log(`[テストネット検証] 確認用: https://sepolia.basescan.org/tx/${deployTx.hash}`);

  // POOLアドレスが正しく取得できているか(コンストラクタ内のgetPool()呼び出しが
  // 成功しているか)を確認する。デプロイ直後はパブリックRPCの状態反映に
  // わずかな遅延があることがあるため、待機時間を伸ばしながら数回リトライする。
  const retryDelaysMs = [1000, 2000, 4000];
  let deployedPool = null;
  for (const delayMs of retryDelaysMs) {
    await new Promise((r) => setTimeout(r, delayMs));
    try {
      deployedPool = await contract.POOL();
      break;
    } catch (e) {
      console.warn(`[テストネット検証] POOL確認コール失敗(${delayMs}ms待機後)、再試行します:`, e.message);
    }
  }

  if (deployedPool) {
    console.log(`[テストネット検証] コントラクトが認識しているAave Poolアドレス: ${deployedPool}`);
  } else {
    console.warn("[テストネット検証] POOL確認コールは最終的に失敗しましたが、デプロイ自体は成功しています");
  }

  console.log("[テストネット検証] 完了: コンパイル・デプロイともに成功しました");
}
