// scripts/liquidator-deploy.js
//
// 清算コントラクト(contracts/AaveLiquidator.sol)を本番チェーンへデプロイする。
// 仕組みは mainnet-deploy.js と同じ。コンストラクタに Aave V3 Pool の住所を渡す
// (address-book から取る。思い込みで書かない)。
//
// 使い方: 環境変数 RUN_LIQUIDATOR_DEPLOY にチェーン名(avalanche)を入れて起動する。
// デプロイ後、表示されたアドレスを LIQUIDATOR_CONTRACT_ADDRESS_<CHAIN> に設定し、
// RUN_LIQUIDATOR_DEPLOY を false に戻す。

import { ethers } from "ethers";
import { AaveV3Avalanche } from "@aave-dao/aave-address-book";
import { getAnyChainConfig } from "../chain-config.js";
import { compileContract } from "./compile-contract.js";

/// チェーンごとの Aave V3 Pool。今は avalanche だけ。
const AAVE_POOL_BY_CHAIN = {
  avalanche: AaveV3Avalanche.POOL,
};

export function liquidatorAddressEnvVar(chain) {
  return `LIQUIDATOR_CONTRACT_ADDRESS_${(chain || "").toUpperCase()}`;
}

export async function runLiquidatorDeploy(chain) {
  const chainKey = (chain || "").toLowerCase();
  const config = getAnyChainConfig(chainKey);
  const pool = AAVE_POOL_BY_CHAIN[chainKey];
  if (!config || !pool) {
    console.error(`[清算デプロイ] 未対応のチェーン: ${chain}`);
    return null;
  }
  const privateKey = process.env.MAINNET_BOT_PRIVATE_KEY;
  if (!privateKey) {
    console.error("[清算デプロイ] MAINNET_BOT_PRIVATE_KEY が未設定です");
    return null;
  }

  console.log(`[清算デプロイ] ${chainKey} へのデプロイを開始します(Aave Pool ${pool})`);
  const { abi, bytecode } = compileContract("AaveLiquidator");
  console.log(`[清算デプロイ] コンパイル完了: ${(bytecode.length - 2) / 2}バイト`);
  const provider = new ethers.JsonRpcProvider(config.rpcUrl, ethers.Network.from(config.chainId), {
    staticNetwork: ethers.Network.from(config.chainId),
  });
  const wallet = new ethers.Wallet(privateKey, provider);

  const balance = await provider.getBalance(wallet.address);
  console.log(`[清算デプロイ] ウォレット ${wallet.address} の残高: ${ethers.formatEther(balance)}`);
  if (balance === 0n) {
    console.error("[清算デプロイ] 残高が0のためデプロイできません");
    return null;
  }

  const factory = new ethers.ContractFactory(abi, bytecode, wallet);
  const contract = await factory.deploy(pool);
  console.log("[清算デプロイ] 送信しました。確定を待っています…");
  await contract.waitForDeployment();

  const address = await contract.getAddress();
  console.log(`[清算デプロイ] ${chainKey} 完了: ${address}`);
  console.log(`[清算デプロイ] 環境変数 ${liquidatorAddressEnvVar(chainKey)} に上記を設定し、RUN_LIQUIDATOR_DEPLOY を false に戻してください`);
  return address;
}
