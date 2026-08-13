import "dotenv/config";
import http from "http";
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

const provider = new ethers.JsonRpcProvider(RPC_URL);
const wallet = new ethers.Wallet(PRIVATE_KEY, provider);

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

// 状況確認ページ用の状態(直近の結果をメモリに保持するだけ。データベースは使わない)
const state = {
  startedAt: new Date().toISOString(),
  walletAddress: null,
  contractAddress: null,
  dryRun: DRY_RUN,
  lastScanAt: null,
  lastPairsScanned: 0,
  lastOpportunities: [],
  lastError: null,
  lastExecution: null,
  scanCount: 0,
};

async function runOnce(contractAddress) {
  console.log(`[${new Date().toISOString()}] スキャン開始 (${CHAIN.name})`);
  state.lastError = null;
  let opportunities = [], pairsScanned = 0;
  try {
    const result = await scanAll(provider, { tradeUSD: TRADE_USD });
    opportunities = result.opportunities;
    pairsScanned = result.pairsScanned;
  } catch (e) {
    state.lastError = e.message;
    throw e;
  }
  console.log(`スキャン完了。${pairsScanned}ペア中 ${opportunities.length}件で見積もり取得。`);

  state.lastScanAt = new Date().toISOString();
  state.lastPairsScanned = pairsScanned;
  state.lastOpportunities = opportunities.slice(0, 10).map((o) => ({
    pair: o.pair, buySide: o.buyOnUni ? "Uniswap V3" : "SushiSwap",
    sellSide: o.buyOnUni ? "SushiSwap" : "Uniswap V3", netUSD: o.netUSD,
  }));
  state.scanCount++;

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
    state.lastExecution = { time: new Date().toISOString(), txHash: tx.hash, pair: best.pair, netUSD: best.netUSD };
  } catch (e) {
    console.error("実行に失敗しました:", e.message);
    state.lastError = e.message;
  }
}

function renderStatusPage(balanceEth) {
  const opRows = state.lastOpportunities.length
    ? state.lastOpportunities.map(o => `
        <tr>
          <td>${o.pair}</td>
          <td>${o.buySide} → ${o.sellSide}</td>
          <td style="text-align:right; color:${o.netUSD>=0?'#2ecc71':'#e74c3c'};">${o.netUSD>=0?'+':''}$${o.netUSD.toFixed(2)}</td>
        </tr>`).join("")
    : `<tr><td colspan="3" style="color:#888;">まだ機会は見つかっていません</td></tr>`;

  return `<!DOCTYPE html>
<html lang="ja"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta http-equiv="refresh" content="30">
<title>arb-bot 状況確認</title>
<style>
  body{ font-family:-apple-system,sans-serif; background:#0d100c; color:#e8e6d8; margin:0; padding:20px 16px; }
  h1{ font-size:18px; margin:0 0 4px; }
  .sub{ color:#888; font-size:12px; margin-bottom:20px; }
  .card{ background:#14180f; border:1px solid #2a331d; border-radius:8px; padding:16px; margin-bottom:14px; }
  .row{ display:flex; justify-content:space-between; padding:6px 0; font-size:13px; border-bottom:1px solid #222; }
  .row:last-child{ border-bottom:none; }
  .label{ color:#888; }
  .pill{ display:inline-block; padding:3px 10px; border-radius:12px; font-size:11px; font-weight:600; }
  .pill.dry{ background:#3a2c08; color:#ffb000; }
  .pill.live{ background:#0d3a1a; color:#2ecc71; }
  table{ width:100%; border-collapse:collapse; font-size:12.5px; }
  th{ text-align:left; color:#888; font-weight:500; font-size:11px; padding:6px; border-bottom:1px solid #2a331d; }
  td{ padding:8px 6px; border-bottom:1px solid #1c1c1c; }
</style></head>
<body>
  <h1>🤖 arb-bot 状況確認</h1>
  <div class="sub">30秒ごとに自動更新されます。手動で更新してもOKです。</div>

  <div class="card">
    <div class="row"><span class="label">状態</span><span class="pill ${state.dryRun ? 'dry' : 'live'}">${state.dryRun ? 'DRY RUN(シミュレートのみ)' : '実取引 稼働中'}</span></div>
    <div class="row"><span class="label">対象チェーン</span><span>${CHAIN.name}</span></div>
    <div class="row"><span class="label">ウォレット残高</span><span>${balanceEth} ETH</span></div>
    <div class="row"><span class="label">起動時刻</span><span>${new Date(state.startedAt).toLocaleString('ja-JP')}</span></div>
    <div class="row"><span class="label">最終スキャン</span><span>${state.lastScanAt ? new Date(state.lastScanAt).toLocaleString('ja-JP') : '(まだ)'}</span></div>
    <div class="row"><span class="label">累計スキャン回数</span><span>${state.scanCount}回</span></div>
    <div class="row"><span class="label">前回スキャン対象</span><span>${state.lastPairsScanned}ペア</span></div>
    ${state.lastError ? `<div class="row"><span class="label">直近のエラー</span><span style="color:#e74c3c;">${state.lastError}</span></div>` : ""}
  </div>

  ${state.lastExecution ? `
  <div class="card">
    <div class="row"><span class="label">✅ 直近の実行</span><span>${new Date(state.lastExecution.time).toLocaleString('ja-JP')}</span></div>
    <div class="row"><span class="label">ペア</span><span>${state.lastExecution.pair}</span></div>
    <div class="row"><span class="label">純利益</span><span>$${state.lastExecution.netUSD.toFixed(2)}</span></div>
    <div class="row"><span class="label">Tx</span><span style="word-break:break-all; font-size:11px;">${state.lastExecution.txHash}</span></div>
  </div>` : ""}

  <div class="card">
    <div style="font-size:13px; font-weight:600; margin-bottom:8px;">直近スキャンで見つかった機会(上位10件)</div>
    <table>
      <thead><tr><th>ペア</th><th>買い→売り</th><th style="text-align:right;">純利益</th></tr></thead>
      <tbody>${opRows}</tbody>
    </table>
  </div>
</body></html>`;
}

function startStatusServer() {
  const port = process.env.PORT || 3000;
  http.createServer(async (req, res) => {
    try {
      const balanceWei = await provider.getBalance(wallet.address);
      const balanceEth = ethers.formatEther(balanceWei);
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(renderStatusPage(parseFloat(balanceEth).toFixed(5)));
    } catch (e) {
      res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("エラー: " + e.message);
    }
  }).listen(port, () => {
    console.log(`状況確認ページ: ポート${port}で待機中`);
  });
}

async function main() {
  console.log("=== Arbitrageボット起動 ===");
  console.log(`ウォレット: ${wallet.address}`);
  console.log(`DRY_RUN: ${DRY_RUN}`);
  state.walletAddress = wallet.address;
  startStatusServer();
  const contractAddress = await ensureContractDeployed();
  state.contractAddress = contractAddress;

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
