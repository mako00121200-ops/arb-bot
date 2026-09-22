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
import { AaveV3Avalanche, AaveV3Polygon, AaveV3Arbitrum, AaveV3Optimism, AaveV3Base } from "@aave-dao/aave-address-book";
import { getAnyChainConfig } from "../chain-config.js";
import { compileContract } from "./compile-contract.js";

/// チェーンごとの Aave V3 Pool。**住所は思い込みで書かず address-book から取る。**
///
/// [avalanche 以外を足した(2026年9月22日)]
/// 計測だけしている他チェーンの方に清算の実績があった:
///   optimism 62.1日で392回(1日6.3回) / arbitrum 7.1日で48回(1日6.8回)
///   polygon  38.4日で117回(1日3.0回)
/// 一方 avalanche は契約を置いて見張っているのに、候補が一度も出ていない。
///
/// **ただしデプロイしただけでは動かない。**
/// 見張り(liquidation-monitor.js)と実行(liquidation-executor.js)は
/// `CHAIN = "avalanche"` 固定で、中継通貨も WAVAX/USDt/WETHe/BTCb、
/// V2のファクトリーも LFJ と、avalanche 専用に書かれている。
/// 契約はどちらにせよ先に要るので、**置ける状態にだけ**しておく。
const AAVE_POOL_BY_CHAIN = {
  avalanche: AaveV3Avalanche.POOL,
  polygon: AaveV3Polygon.POOL,
  arbitrum: AaveV3Arbitrum.POOL,
  optimism: AaveV3Optimism.POOL,
  base: AaveV3Base.POOL,
};

export function liquidatorAddressEnvVar(chain) {
  return `LIQUIDATOR_CONTRACT_ADDRESS_${(chain || "").toUpperCase()}`;
}

/// 複数チェーンをまとめてデプロイする。**再起動の回数を減らすため。**
/// 1チェーンずつだと、チェーンの数だけ再デプロイが要り、そのたびに
/// 裁定側の計測(取引量・収支の標本)が消える。
/// 途中で失敗しても残りは続ける(どれが置けてどれが置けなかったかを全部出す)。
export async function runLiquidatorDeploy(chains) {
  const list = String(chains || "").split(",").map((c) => c.trim().toLowerCase()).filter(Boolean);
  if (list.length === 0) return null;
  const done = {};
  for (const c of list) {
    try {
      done[c] = await deployOne(c);
    } catch (e) {
      done[c] = null;
      console.error(`[清算デプロイ] ${c} で失敗: ${(e.message || "").slice(0, 160)}`);
    }
  }
  const ok = Object.entries(done).filter(([, v]) => v);
  if (ok.length > 0) {
    console.log("[清算デプロイ] まとめ: 下の環境変数を設定し、RUN_LIQUIDATOR_DEPLOY を false に戻してください");
    for (const [c, addr] of ok) console.log(`  ${liquidatorAddressEnvVar(c)} = ${addr}`);
  }
  const failed = Object.entries(done).filter(([, v]) => !v).map(([c]) => c);
  if (failed.length > 0) console.error(`[清算デプロイ] 置けなかったチェーン: ${failed.join(",")}`);
  return done;
}

async function deployOne(chain) {
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
