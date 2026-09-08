// scripts/testnet-deploy-check.js
//
// 6節の未確定事項⑥(テストネットでのコントラクト動作検証)に対応するスクリプト。
// RUN_TESTNET_DEPLOY_CHECK=true が設定されている場合のみ、起動時に1回だけ実行される
// (index.js側のフックから呼び出される)。
//
// 現時点で確認するのは「コンパイルが通るか」「Base Sepoliaへ実際にデプロイできるか」
// 「デプロイの実際のガス代はいくらか」の3点。DEXルーターを使った実際のアービトラージ
// 実行テスト(トークン・プールの準備が別途必要)は、次の段階で扱う。

import fs from "fs";
import { fileURLToPath } from "url";
import path from "path";
import solc from "solc";
import { ethers } from "ethers";
import { AaveV3BaseSepolia } from "@aave-dao/aave-address-book";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function compileContract() {
  const contractPath = path.join(__dirname, "..", "contracts", "DexArbFlashLoan.sol");
  const source = fs.readFileSync(contractPath, "utf8");

  const input = {
    language: "Solidity",
    sources: {
      "DexArbFlashLoan.sol": { content: source },
    },
    settings: {
      optimizer: { enabled: true, runs: 200 },
      outputSelection: {
        "*": { "*": ["abi", "evm.bytecode.object"] },
      },
    },
  };

  const output = JSON.parse(solc.compile(JSON.stringify(input)));

  const errors = (output.errors || []).filter((e) => e.severity === "error");
  if (errors.length > 0) {
    console.error("[テストネット検証] コンパイルエラー:");
    for (const e of errors) console.error(e.formattedMessage);
    throw new Error("コンパイル失敗");
  }
  const warnings = (output.errors || []).filter((e) => e.severity === "warning");
  for (const w of warnings) console.warn("[テストネット検証] コンパイル警告:", w.formattedMessage);

  const compiled = output.contracts["DexArbFlashLoan.sol"]["DexArbFlashLoan"];
  return { abi: compiled.abi, bytecode: "0x" + compiled.evm.bytecode.object };
}

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
  // 成功しているか)を確認する
  const deployedPool = await contract.POOL();
  console.log(`[テストネット検証] コントラクトが認識しているAave Poolアドレス: ${deployedPool}`);

  console.log("[テストネット検証] 完了: コンパイル・デプロイともに成功しました");
}
