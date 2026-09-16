// scripts/mainnet-deploy.js
//
// 本番チェーンへコントラクトをデプロイする。
//
// [変更] フラッシュスワップ方式に変えたため、Aaveのアドレスを渡す必要が
// なくなった。コンストラクタは引数なしになっている。
//
// 使い方: 環境変数 RUN_MAINNET_DEPLOY にチェーン名を入れて起動する。
// デプロイ後、表示されたアドレスを MAINNET_CONTRACT_ADDRESS_<CHAIN> に
// 設定し、RUN_MAINNET_DEPLOY を false に戻す。

import { ethers } from "ethers";
import { getChainConfig } from "../chain-config.js";
import { compileContract } from "./compile-contract.js";

export async function runMainnetDeploy(chain) {
  const chainKey = (chain || "").toLowerCase();
  const config = getChainConfig(chainKey);
  if (!config) {
    console.error(`[本番デプロイ] 未対応のチェーン: ${chain}`);
    return null;
  }

  const privateKey = process.env.MAINNET_BOT_PRIVATE_KEY;
  if (!privateKey) {
    console.error("[本番デプロイ] MAINNET_BOT_PRIVATE_KEY が未設定です");
    return null;
  }

  console.log(`[本番デプロイ] ${chainKey} へのデプロイを開始します`);

  const { abi, bytecode } = await compileContract();
  const provider = new ethers.JsonRpcProvider(config.rpcUrl, ethers.Network.from(config.chainId), {
    staticNetwork: ethers.Network.from(config.chainId),
  });
  const wallet = new ethers.Wallet(privateKey, provider);

  const balance = await provider.getBalance(wallet.address);
  console.log(`[本番デプロイ] ウォレット ${wallet.address} の残高: ${ethers.formatEther(balance)}`);
  if (balance === 0n) {
    console.error("[本番デプロイ] 残高が0のためデプロイできません");
    return null;
  }

  const factory = new ethers.ContractFactory(abi, bytecode, wallet);
  // フラッシュスワップ方式のため、コンストラクタに引数はない。
  const contract = await factory.deploy();
  console.log(`[本番デプロイ] 送信しました。確定を待っています…`);
  await contract.waitForDeployment();

  const address = await contract.getAddress();
  console.log(`[本番デプロイ] ${chainKey} 完了: ${address}`);
  console.log(`[本番デプロイ] 環境変数 ${config.contractAddressEnvVar} に上記を設定し、RUN_MAINNET_DEPLOY を false に戻してください`);
  return address;
}
