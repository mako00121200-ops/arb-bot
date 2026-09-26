// scripts/woofi-execute.js
//
// **WOOFi と DEX のずれを、実際に送って取る。**(woofi-watch.js が見つけた黒字を受け取る)
//
// [なぜ(2026年9月26日、オーナーの指示「実際の送信を試みながらエラーが出たら修正を繰り返して利益を取れるように」)]
// 9/25〜26 の計測で、WOOFi のずれは平時 $1,000 あたり $0.002〜0.39(1日 $1 前後)、
// まれに価格係の遅れで大きく開く(optimism WBTC +$15.6、約14秒。誰にも取られず価格係の更新で閉じた)。
// 計測だけでは「本当に取れるか」が分からないので、コントラクトに WOOFi の段(FLAG_WOOFI)を足し、送る。
//
// [流れ] 手元の元手は使わない(フラッシュスワップ)。失うのは失敗した時のガス代だけ。
//   1. 経路を組む。1段目は必ず DEX(先に受け取れるのは DEX だけ)。WOOFi は最後の段
//        B「DEX→WOOFi」: 見積もり通貨 →(DEX 1〜2段)→ X →(WOOFi)→ 見積もり通貨
//        A「WOOFi→DEX」: X →(DEX 1〜2段)→ 見積もり通貨 →(WOOFi)→ X(利益は X で残る)
//   2. simulateRoute(eth_call。無料)で、今の状態で最後まで回した結果を受け取る。額は数通り試す
//   3. 利益 − ガス代 が下限以上なら executeRoute を送る。最低利益はガス代分(赤字の成立を防ぐ)
//
// [安全装置]
//   ・コントラクトが FLAG_WOOFI を持たないチェーンでは何もしない(再デプロイ前は自然に止まる)
//   ・1日(日本時間)の損(失敗のガス代 + 赤字の成立)が WOOFI_DAILY_LOSS_USD(既定 $1)を超えたらその日は送らない
//   ・同じ経路は送った後15秒、確認で落ちた後30秒は試さない。チェーンごとに同時1本
//   ・止めるなら WOOFI_SEND=false。送るチェーンを絞るなら WOOFI_SEND_CHAINS=base,arbitrum
//   ・DRY_RUN=false でなければ確認だけして送らない(本体の送信と同じ扱い)

import { ethers } from "ethers";
import { getChainConfig } from "../chain-config.js";
import { callWithRpc, getProviderForChain, readBlockTag } from "./onchain-reserves.js";
import { getSigner, resetNonce, defaultFeeOverrides } from "./execute-opportunity.js";
import { gasUnitsToUsd, weiToUsd, isOpStackChain, readL1FeeFromReceipt } from "./gas-cost.js";
import { getCurrentTradeCapUsd } from "./trade-cap.js";
import { recordRealExecution } from "./real-execution-log.js";
import { loadState, saveState } from "./state-file.js";
import { nowJst } from "./jst.js";

const ENABLED = process.env.WOOFI_SEND !== "false";
const SEND_CHAINS = (process.env.WOOFI_SEND_CHAINS || "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
const MIN_NET_USD = parseFloat(process.env.WOOFI_MIN_NET_USD || "0.01");
const DAILY_LOSS_USD = parseFloat(process.env.WOOFI_DAILY_LOSS_USD || "1");
/// $1,000 の何倍を試すか(取引上限で頭を押さえる)。WOOFi は額が大きいほど値段が不利になるので、
/// 大きい額が必ず得とは限らない。確認(eth_call)で一番よい額を選ぶ。
const SIZE_MULTS = (process.env.WOOFI_SIZE_MULTS || "0.5,1,2").split(",").map(Number).filter((v) => v > 0);
const SAME_ROUTE_AFTER_SEND_MS = 15 * 1000;
const SAME_ROUTE_AFTER_FAIL_MS = 30 * 1000;
const WAIT_TIMEOUT_MS = 60 * 1000;

// contracts/DexArbFlashLoan.sol の FLAG_* と同じ値
const FLAG_V3 = 1, FLAG_IN_IS_TOKEN0 = 2, FLAG_HAS_QUOTE = 4, FLAG_WOOFI = 8;
const LEG = "(address pool, address tokenOut, uint8 flags, uint16 feeBps)[]";
const IFACE = new ethers.Interface([
  `function executeRoute(address asset, uint256 amount, ${LEG} legs, uint256 minProfit) external`,
  `function simulateRoute(address asset, uint256 amount, ${LEG} legs) external`,
  "function FLAG_WOOFI() view returns (uint8)",
  "error SimulationResult(uint256 returned, uint256 owed)",
  "event RouteExecuted(address indexed asset, uint256 amountIn, uint256 profit, uint8 legCount)",
]);

const support = new Map(); // chain:address -> true/false
const busy = new Set();
const routeUntil = new Map(); // routeKey -> 次に試してよい時刻
const errorSeen = new Map(); // 誤りの文面 -> 最後にログに出した時刻

// ===== 集計(生存ログと保存用) =====
const STATE_NAME = "woofi-send.json";
const STATE_VERSION = 1;
const stats = new Map(); // chain -> { sims, simOk, simPlus, sent, won, lost, netUsd, bestNet, errors }
let lossDay = "", lossUsd = 0;
function st(chain) {
  let s = stats.get(chain);
  if (!s) { s = { sims: 0, simErr: 0, simPlus: 0, sent: 0, won: 0, lost: 0, netUsd: 0, bestSimNet: null }; stats.set(chain, s); }
  return s;
}
(function restore() {
  const d = loadState(STATE_NAME, STATE_VERSION);
  if (!d) return;
  for (const [chain, v] of Object.entries(d.chains || {})) {
    const s = st(chain);
    for (const k of Object.keys(s)) if (Number.isFinite(Number(v?.[k]))) s[k] = Number(v[k]);
  }
  lossDay = d.lossDay || ""; lossUsd = Number(d.lossUsd) || 0;
})();
function persist() {
  try { saveState(STATE_NAME, STATE_VERSION, { chains: Object.fromEntries(stats), lossDay, lossUsd }); } catch (e) {}
}
function jstDay() { return new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10); }
function addLoss(usd) {
  const d = jstDay();
  if (d !== lossDay) { lossDay = d; lossUsd = 0; }
  lossUsd += usd;
}
function lossToday() { return jstDay() === lossDay ? lossUsd : 0; }

function logErrorOnce(key, line) {
  const now = Date.now();
  if (now - (errorSeen.get(key) || 0) < 10 * 60 * 1000) return;
  errorSeen.set(key, now);
  if (errorSeen.size > 500) errorSeen.clear();
  console.warn(line);
}

async function contractSupportsWoofi(chain, address) {
  const k = `${chain}:${address.toLowerCase()}`;
  if (support.has(k)) return support.get(k);
  try {
    const raw = await callWithRpc(chain, (p) => p.call({ to: address, data: IFACE.encodeFunctionData("FLAG_WOOFI", []) }), true);
    const ok = raw && raw !== "0x" && IFACE.decodeFunctionResult("FLAG_WOOFI", raw)[0] === 8n;
    support.set(k, !!ok);
  } catch (e) {
    // 旧版には FLAG_WOOFI が無く fallback が取り消す。RPC の失敗は覚えない
    if (e?.code === "CALL_EXCEPTION") support.set(k, false);
    else return false;
  }
  console.log(`[WOOFi送信] ${chain} ${address}: コントラクトは WOOFi の段に${support.get(k) ? "**対応しています。黒字なら送ります**" : "未対応(旧版)です。再デプロイまで送りません"}`);
  return support.get(k);
}

/// DEX の経路(bestSellQuote の path)と WOOFi の段から、コントラクトに渡す段を組む。
function buildLegs(dexPath, wooPool, wooTokenOut) {
  const legs = dexPath.map((p) => {
    const inIs0 = p.tokenIn.toLowerCase() < p.tokenOut.toLowerCase(); // V2/V3/Solidly とも token0 は住所の小さい方
    let flags = inIs0 ? FLAG_IN_IS_TOKEN0 : 0;
    if (p.kind === "v3") flags |= FLAG_V3;
    else flags |= FLAG_HAS_QUOTE; // Solidly 型はプール自身の getAmountOut を使う(手数料を当てなくてよい)
    return { pool: ethers.getAddress(p.pool), tokenOut: ethers.getAddress(p.tokenOut), flags, feeBps: p.kind === "v3" ? 0 : 30 };
  });
  legs.push({ pool: ethers.getAddress(wooPool), tokenOut: ethers.getAddress(wooTokenOut), flags: FLAG_WOOFI, feeBps: 0 });
  return legs;
}

async function simulate(chain, contract, from, asset, amount, legs) {
  const data = IFACE.encodeFunctionData("simulateRoute", [asset, amount, legs]);
  try {
    await callWithRpc(chain, (p) => p.call({ to: contract, from, data, blockTag: readBlockTag(chain) }), true);
    return { error: "結果が返りませんでした" };
  } catch (e) {
    const d = e?.data ?? e?.info?.error?.data ?? e?.error?.data ?? null;
    if (typeof d === "string" && d.startsWith("0x")) {
      try {
        const parsed = IFACE.parseError(d);
        if (parsed?.name === "SimulationResult") return { returned: parsed.args.returned, owed: parsed.args.owed };
      } catch (inner) {}
      if (d.startsWith("0x08c379a0")) {
        try { return { error: ethers.AbiCoder.defaultAbiCoder().decode(["string"], "0x" + d.slice(10))[0] }; } catch (inner) {}
      }
      if (d.length >= 10) return { error: `取り消し(セレクタ${d.slice(0, 10)})` };
    }
    return { error: (e?.shortMessage || e?.message || "").slice(0, 160) };
  }
}

/// woofi-watch.js から、黒字の経路を見つけた時に呼ぶ。待たずに呼んでよい(中で直列にする)。
/// cand = { chain, key, dir: "A"|"B", wooPool, quote, qDec, base: { addr, symbol, dec }, x(見積もり通貨の額), got(A の時 WOOFi で買えた X の量), dexPath, netUsd(計測の純利) }
export async function tryWoofiSend(cand) {
  if (!ENABLED || !cand?.dexPath?.length) return;
  const { chain } = cand;
  if (SEND_CHAINS.length && !SEND_CHAINS.includes(chain)) return;
  if (busy.has(chain)) return;
  const routeKey = `${chain}|${cand.key}`;
  if ((routeUntil.get(routeKey) || 0) > Date.now()) return;
  const cfg = getChainConfig(chain);
  const contract = cfg ? process.env[cfg.contractAddressEnvVar] : null;
  const privateKey = process.env.MAINNET_BOT_PRIVATE_KEY;
  if (!contract || !privateKey) return;
  if (lossToday() >= DAILY_LOSS_USD) {
    logErrorOnce("loss-cap", `[WOOFi送信] 今日(日本時間)の損が$${lossToday().toFixed(3)}で上限$${DAILY_LOSS_USD}に届いたので、日付が変わるまで送りません`);
    return;
  }
  busy.add(chain);
  try {
    if (!(await contractSupportsWoofi(chain, contract))) return;
    const s = st(chain);
    const { wallet, signer } = getSigner(chain, privateKey);

    // 1. 経路を組み、額を数通り試す(eth_call。無料)
    const isB = cand.dir === "B";
    const asset = ethers.getAddress(isB ? cand.quote : cand.base.addr);
    const baseAmount = isB ? cand.x : cand.got;
    const legs = buildLegs(cand.dexPath, cand.wooPool, asset);
    // 資産1単位のドル換算: 見積もり通貨はステーブル。X は「$SIZE で WOOFi から買えた量」から逆算
    const assetDec = isB ? cand.qDec : cand.base.dec;
    const usdPerUnit = isB ? 1 : (Number(cand.x) / 10 ** cand.qDec) / (Number(cand.got) / 10 ** assetDec);
    const capUsd = getCurrentTradeCapUsd();
    const sizeUsd = Number(cand.x) / 10 ** cand.qDec;
    let best = null;
    for (const m of SIZE_MULTS) {
      if (sizeUsd * m > capUsd) continue;
      const amount = (baseAmount * BigInt(Math.round(m * 1000))) / 1000n;
      if (amount <= 0n) continue;
      s.sims++;
      const r = await simulate(chain, contract, wallet.address, asset, amount, legs);
      if (r.error) {
        s.simErr++;
        logErrorOnce(`${chain}|${r.error}`, `[WOOFi送信/確認で失敗 ${nowJst()}] ${chain} ${cand.key} ×${m}: ${r.error}(段 ${legs.map((l) => `${l.pool.slice(0, 8)}:${l.flags}`).join("→")})`);
        continue;
      }
      const profit = r.returned - r.owed;
      const profitUsd = Number(profit) / 10 ** assetDec * usdPerUnit;
      if (!best || profitUsd > best.profitUsd) best = { amount, profit, profitUsd, m };
    }
    if (!best) { routeUntil.set(routeKey, Date.now() + SAME_ROUTE_AFTER_FAIL_MS); return; }
    if (best.profit <= 0n) {
      console.log(`[WOOFi送信] ${chain} ${cand.key}: チェーン上の確認では赤字($${best.profitUsd.toFixed(4)}、計測は+$${cand.netUsd.toFixed(3)})。送りません`);
      routeUntil.set(routeKey, Date.now() + SAME_ROUTE_AFTER_FAIL_MS);
      return;
    }

    // 2. ガス量を見積もり、純利で判断する
    let gasUnits;
    try {
      gasUnits = await getProviderForChain(chain).estimateGas({ from: wallet.address, to: contract, data: IFACE.encodeFunctionData("executeRoute", [asset, best.amount, legs, 0n]) });
    } catch (e) {
      logErrorOnce(`${chain}|gas|${(e.shortMessage || e.message || "").slice(0, 60)}`, `[WOOFi送信] ${chain} ${cand.key}: ガス量の見積もりで拒否: ${(e.shortMessage || e.message || "").slice(0, 140)}`);
      routeUntil.set(routeKey, Date.now() + SAME_ROUTE_AFTER_FAIL_MS);
      return;
    }
    const gasUsd = (await gasUnitsToUsd(chain, gasUnits).catch(() => null)) ?? 0.05;
    const net = best.profitUsd - gasUsd;
    s.simPlus++;
    if (s.bestSimNet == null || net > s.bestSimNet) s.bestSimNet = net;
    if (net < MIN_NET_USD) {
      console.log(`[WOOFi送信] ${chain} ${cand.key}: 確認は黒字 粗利$${best.profitUsd.toFixed(4)}(×${best.m}) − ガス$${gasUsd.toFixed(4)} = $${net.toFixed(4)} で下限$${MIN_NET_USD}未満。送りません`);
      routeUntil.set(routeKey, Date.now() + SAME_ROUTE_AFTER_FAIL_MS);
      return;
    }
    if (process.env.DRY_RUN !== "false") {
      console.log(`[WOOFi送信] ${chain} ${cand.key}: 純利$${net.toFixed(4)}の見込み。DRY_RUN のため送りません`);
      return;
    }

    // 3. 送る。最低利益はガス代ぶん(成立したら必ずガス代を上回る。届かなければ取り消し)
    const gasInAsset = BigInt(Math.floor((gasUsd / usdPerUnit) * 10 ** assetDec));
    const minProfit = gasInAsset > 0n && gasInAsset < best.profit ? gasInAsset : 1n;
    const { extraPerGas, ...fee } = await defaultFeeOverrides(chain);
    const c = new ethers.Contract(contract, IFACE, signer);
    console.log(`[WOOFi送信 ${nowJst()}] ${chain} ${cand.key}: **送信します** 投入$${(sizeUsd * best.m).toFixed(0)} 粗利$${best.profitUsd.toFixed(4)} ガス$${gasUsd.toFixed(4)} 見込み純利$${net.toFixed(4)}(DEX ${cand.label || ""})`);
    let tx;
    try {
      tx = await c.executeRoute(asset, best.amount, legs, minProfit, { gasLimit: (gasUnits * 130n) / 100n, ...fee });
    } catch (e) {
      resetNonce(chain);
      console.warn(`[WOOFi送信] ${chain}: 送信に失敗: ${(e.shortMessage || e.message || "").slice(0, 160)}`);
      routeUntil.set(routeKey, Date.now() + SAME_ROUTE_AFTER_FAIL_MS);
      return;
    }
    s.sent++;
    routeUntil.set(routeKey, Date.now() + SAME_ROUTE_AFTER_SEND_MS);
    const sentAt = Date.now();
    let receipt = null;
    try {
      receipt = await Promise.race([tx.wait(), new Promise((_, rej) => setTimeout(() => rej(new Error("確定待ちが60秒を超えた")), WAIT_TIMEOUT_MS))]);
    } catch (e) {
      resetNonce(chain);
      receipt = e?.receipt ?? (await getProviderForChain(chain).getTransactionReceipt(tx.hash).catch(() => null));
    }
    let gasPaidUsd = null;
    if (receipt) {
      try {
        let l1 = 0n;
        if (isOpStackChain(chain)) l1 = await readL1FeeFromReceipt(chain, tx.hash).catch(() => 0n);
        gasPaidUsd = await weiToUsd(chain, receipt.gasUsed * (receipt.gasPrice ?? receipt.effectiveGasPrice ?? 0n) + l1);
      } catch (e) {}
    }
    let profitUsd = null;
    if (receipt?.status === 1) {
      for (const log of receipt.logs || []) {
        try {
          const p = IFACE.parseLog({ topics: log.topics, data: log.data });
          if (p?.name === "RouteExecuted") { profitUsd = Number(p.args.profit) / 10 ** assetDec * usdPerUnit; break; }
        } catch (e) {}
      }
    }
    const realNet = (profitUsd ?? 0) - (gasPaidUsd ?? gasUsd);
    if (receipt?.status === 1 && realNet > 0) s.won++; else s.lost++;
    s.netUsd += realNet;
    if (realNet < 0) addLoss(-realNet);
    const explorer = cfg.explorerTxUrl ? cfg.explorerTxUrl(tx.hash) : tx.hash;
    console.log(`[WOOFi送信/結果 ${nowJst()}] ${chain} ${cand.key}: ${receipt?.status === 1 ? "**成立**" : receipt ? "**取り消し(先を越されたか値段が動いた)**" : "確定を確認できず"}`
      + ` 粗利$${(profitUsd ?? 0).toFixed(4)} ガス$${(gasPaidUsd ?? gasUsd).toFixed(4)} 純利$${realNet.toFixed(4)}(送ってから${Date.now() - sentAt}ms) ${explorer}`);
    try {
      recordRealExecution({
        timestamp: new Date().toISOString(), pairLabel: `woofi ${chain} ${cand.key}`, kind: "woofi", chain,
        txHash: tx.hash, explorerUrl: explorer, tradeAmountUsd: sizeUsd * best.m, predictedProfitUsd: net,
        actualProfitUsd: profitUsd, actualGasCostUsd: gasPaidUsd, actualNetProfitUsd: realNet,
        gasUsed: receipt?.gasUsed?.toString() ?? null, gasCostUsd: gasUsd,
      });
    } catch (e) {}
  } catch (e) {
    logErrorOnce(`${chain}|x|${(e.message || "").slice(0, 60)}`, `[WOOFi送信] ${chain} ${cand.key}: 想定外の失敗: ${(e.shortMessage || e.message || "").slice(0, 160)}`);
  } finally {
    busy.delete(chain);
    persist();
  }
}

/// 生存ログ用。
export function formatWoofiSendLine() {
  if (!ENABLED) return " WOOFi送信[停止中]";
  const parts = [];
  for (const [chain, s] of stats) {
    if (!s.sims && !s.sent) continue;
    parts.push(`${chain} 確認${s.sims}(失敗${s.simErr} 黒字${s.simPlus}${s.bestSimNet != null ? ` 最良$${s.bestSimNet.toFixed(3)}` : ""}) 送信${s.sent} 勝${s.won}/負${s.lost} ${s.netUsd >= 0 ? "+" : ""}$${s.netUsd.toFixed(4)}`);
  }
  return parts.length ? ` WOOFi送信[${parts.join(" / ")} 今日の損$${lossToday().toFixed(3)}/上限$${DAILY_LOSS_USD}]` : "";
}

/// 画面用。チェーンごとの集計(確認・送信・勝敗・純利)と今日の損。
export function getWoofiSendStats() {
  const chains = {};
  for (const [chain, s] of stats) chains[chain] = { ...s };
  return { enabled: ENABLED, chains, lossTodayUsd: lossToday(), dailyLossCapUsd: DAILY_LOSS_USD };
}
