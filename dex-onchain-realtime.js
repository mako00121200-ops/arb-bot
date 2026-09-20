/**
 * オンチェーン イベント リアルタイム購読モジュール
 * ------------------------------------------------------------
 * 取引や流動性の変化をWebSocketで直接受け取る。
 *   V2形式 … Sync(準備量そのもの)
 *   V3形式 … Swap(更新後の価格と流動性) / Mint・Burn(流動性の増減)
 *
 * [監視対象を指定して購読する]
 * 以前はチェーン上の全イベントを購読していた。13,783件のアドレスを400件ずつ
 * 35回に分けて購読したところRPC側の制限に当たったため、全件購読に切り替えた
 * 経緯がある。しかし全件購読では月3,000〜5,000万件のイベントが届き、
 * リクエスト単位で課金されるRPCでは月$200〜500かかってしまう。
 * 監視対象を裁定候補(チェーンあたり数百〜千件)に絞れば、購読は1〜2回で済み
 * 制限にも当たらず、イベント量も1/15になる。
 *
 * [1接続で4種類]
 * eth_subscribe の topics は配列の配列で「いずれか一致」を指定できる。
 * address も配列で複数指定できるため、対象アドレス×4種類のイベントを
 * 1つの購読でまとめて受け取れる。
 *
 * [再接続の暴走を防ぐ]
 * 接続直後に切断される状態では待ち時間を毎回1秒に戻していたため、
 * 接続と切断を繰り返した。一定時間つながり続けたときだけ初期化する。
 *
 * [健全性の判定]
 * 「接続はできるがイベントが届かない」状態では購読が有効とみなされ、
 * 定期読み直しがスキップされて価格が古いまま固定される危険がある。
 */

// 識別子を計算で求めるために読み込む(このファイルで使うのはこれだけ)。
import { ethers } from "ethers";
import { callWithRpc, isPendingReadChain } from "./scripts/onchain-reserves.js";

// 識別子は手で書かない。過去に1文字欠けたまま気づかず、最初期から一度も
// 受信できていなかった。署名の文字列だけを書き、ハッシュは計算させる。
const SYNC_TOPIC = ethers.id("Sync(uint112,uint112)");
const V3_SWAP_TOPIC = ethers.id("Swap(address,address,int256,int256,uint160,uint128,int24)");
const V3_MINT_TOPIC = ethers.id("Mint(address,address,int24,int24,uint128,uint256,uint256)");
const V3_BURN_TOPIC = ethers.id("Burn(address,int24,int24,uint128,uint256,uint256)");

// Algebra系は版によって Swap の引数が増えている(末尾に手数料が付く)。
// 識別子が変わるので、別の識別子として購読しないと1件も受信できない。
// 先頭4つ(amount0, amount1, price, liquidity)の位置は共通なので、
// 中身の読み取りは decodeV3SwapData をそのまま使える。
const ALGEBRA_SWAP_TOPICS = [
  ethers.id("Swap(address,address,int256,int256,uint160,uint128,int24,uint24)"),
  ethers.id("Swap(address,address,int256,int256,uint160,uint128,int24,uint24,uint24)"),
];
const V3_SWAP_TOPICS = new Set([V3_SWAP_TOPIC, ...ALGEBRA_SWAP_TOPICS]);

const ALL_TOPICS = [SYNC_TOPIC, V3_SWAP_TOPIC, ...ALGEBRA_SWAP_TOPICS, V3_MINT_TOPIC, V3_BURN_TOPIC];

const CHAIN_WS_ENV_VARS = {
  base: "BASE_WSS_URL",
  arbitrum: "ARBITRUM_WSS_URL",
  optimism: "OPTIMISM_WSS_URL",
  polygon: "POLYGON_WSS_URL",
  avalanche: "AVALANCHE_WSS_URL",
};

const DATA_TIMEOUT_MS = 120 * 1000;
const PING_INTERVAL_MS = 20 * 1000;
const PING_REQUEST_ID = 999;
const SUBSCRIBE_REQUEST_ID_BASE = 100;
const HEALTHY_EVENT_WINDOW_MS = parseInt(process.env.HEALTHY_EVENT_WINDOW_MS || "300000", 10);
const STABLE_CONNECTION_MS = 30 * 1000;
const MAX_RECONNECT_DELAY_MS = 5 * 60 * 1000;
// 1回の購読に入れるアドレス数。多すぎるとRPCに拒否される。
const ADDRESSES_PER_SUBSCRIPTION = parseInt(process.env.ADDRESSES_PER_SUBSCRIPTION || "800", 10);

export function decodeSyncData(dataHex) {
  const data = dataHex.startsWith("0x") ? dataHex.slice(2) : dataHex;
  if (data.length < 128) return null;
  try {
    return {
      reserve0: BigInt("0x" + data.slice(0, 64)),
      reserve1: BigInt("0x" + data.slice(64, 128)),
    };
  } catch (e) { return null; }
}

export function decodeV3SwapData(dataHex) {
  const data = dataHex.startsWith("0x") ? dataHex.slice(2) : dataHex;
  if (data.length < 320) return null;
  try {
    const sqrtPriceX96 = BigInt("0x" + data.slice(128, 192));
    const liquidity = BigInt("0x" + data.slice(192, 256));
    if (sqrtPriceX96 <= 0n) return null;
    return { sqrtPriceX96, liquidity };
  } catch (e) { return null; }
}

const chainSockets = {};
const chainReconnectDelays = {};
const chainLastDataAt = {};
const chainLastEventAt = {};
const chainConnectedAt = {};
const chainWatchdogTimers = {};
const chainPingTimers = {};
const chainIntentionalClose = {};
const chainEnabled = new Set();
const chainEventCounts = {};
const chainV2Counts = {};
const chainV3Counts = {};
const chainLiquidityCounts = {};
const chainSubscribeErrors = {};
const chainReconnects = {};
const chainAddresses = {};      // チェーン→購読するアドレスの配列
const chainSubCounts = {};      // チェーン→購読した回数
let globalOnSync = null;
let globalOnV3Swap = null;
let globalOnV3Liquidity = null;

// ===== 確定前(pending)のイベントの取得(2026年9月20日) =====
//
// [なぜ要るか]
// WebSocket の logs 購読はブロック確定(Optimism は2秒)まで届かない。
// Chainstack の Optimism 端点は Flashblocks を「標準 RPC の pending ブロック」として
// 見せる(起動時の確認: pending の取引数が 250ms ごとに増え、eth_getLogs(pending) が
// 1回で取れる)。そこで pending のイベントを一定間隔で取りに行き、確定を待たずに
// 判定へ回す。Optimism は先着順なので、確定前に検知できれば同じブロックの後ろに
// 自分の取引が入る(「1ブロック遅い」の解消)。
//
// [重複の扱い]
// 同じイベントは、pending で複数回(取引が増えるたび)、そして確定後に logs 購読で
// もう一度届く。txHash と logIndex で覚えておき、2回目以降は判定に回さない。
// 確定後に届いた時は「先読みできた時間」(確定より何ms早く見えたか)を記録する。
//
// [RPC の消費]
// 1回の取得 = 1リクエスト。400ms 間隔で 1日約216,000、月約650万(枠2,000万の3割)。
// FLASHBLOCKS_POLL_MS で調整できる。監視対象が無いチェーンや、pending を読まない
// チェーン(FLASHBLOCKS_PENDING_CHAINS に無い)では動かない。
const FLASHBLOCKS_POLL_MS = parseInt(process.env.FLASHBLOCKS_POLL_MS || "400", 10);
const SEEN_LOG_LIMIT = 20000;
const seenLogs = {};           // chain -> Map(key -> pendingSeenAt)
const pendingTimers = {};      // chain -> interval
const pendingInFlight = {};    // chain -> bool
const pendingStats = {};       // chain -> { polls, errors, events, sealedHits, leadTotalMs, leadMaxMs }

function pendingStatsFor(chain) {
  if (!pendingStats[chain]) pendingStats[chain] = { polls: 0, errors: 0, events: 0, sealedHits: 0, leadTotalMs: 0, leadMaxMs: 0 };
  return pendingStats[chain];
}

/// 見たことのあるイベントか。初見なら覚えて false、既知なら true。
function rememberLog(chainName, log, seenAt, source) {
  if (!log?.transactionHash || log.logIndex == null) return false;
  const key = `${log.transactionHash}:${log.logIndex}`;
  let map = seenLogs[chainName];
  if (!map) { map = new Map(); seenLogs[chainName] = map; }
  const prev = map.get(key);
  if (prev != null) {
    if (source === "sealed" && prev.source === "pending" && !prev.sealedAt) {
      prev.sealedAt = seenAt;
      const st = pendingStatsFor(chainName);
      const lead = seenAt - prev.at;
      st.sealedHits++;
      st.leadTotalMs += lead;
      if (lead > st.leadMaxMs) st.leadMaxMs = lead;
    }
    return true;
  }
  map.set(key, { at: seenAt, source, sealedAt: null });
  if (map.size > SEEN_LOG_LIMIT) {
    // 古い順に半分捨てる(Map は挿入順)。
    let n = 0;
    for (const k of map.keys()) { map.delete(k); if (++n >= SEEN_LOG_LIMIT / 2) break; }
  }
  return false;
}

/// 1件のイベントを判定へ回す。source は "sealed"(確定後の購読)か "pending"(確定前の取得)。
function dispatchLog(chainName, log, receivedAt, source) {
  if (rememberLog(chainName, log, receivedAt, source)) return;
  const topic = (log.topics && log.topics[0]) || "";
  const address = (log.address || "").toLowerCase();
  if (!address) return;
  if (source === "pending") pendingStatsFor(chainName).events++;

  if (topic === SYNC_TOPIC) {
    chainV2Counts[chainName] = (chainV2Counts[chainName] || 0) + 1;
    const decoded = decodeSyncData(log.data);
    if (decoded && globalOnSync) {
      globalOnSync(chainName, address, decoded.reserve0, decoded.reserve1, receivedAt);
    }
  } else if (V3_SWAP_TOPICS.has(topic)) {
    chainV3Counts[chainName] = (chainV3Counts[chainName] || 0) + 1;
    const decoded = decodeV3SwapData(log.data);
    if (decoded && globalOnV3Swap) {
      globalOnV3Swap(chainName, address, decoded.sqrtPriceX96, decoded.liquidity, receivedAt);
    }
  } else if (topic === V3_MINT_TOPIC || topic === V3_BURN_TOPIC) {
    chainLiquidityCounts[chainName] = (chainLiquidityCounts[chainName] || 0) + 1;
    if (globalOnV3Liquidity) {
      globalOnV3Liquidity(chainName, address, topic === V3_MINT_TOPIC ? "mint" : "burn");
    }
  }
}

/// pending のイベントを一定間隔で取りに行く。監視対象が決まった後に始める。
function startPendingPolling(chainName) {
  if (!isPendingReadChain(chainName) || pendingTimers[chainName]) return;
  if (!(FLASHBLOCKS_POLL_MS > 0)) return;
  console.log(`[Flashblocks/pending] ${chainName}: 確定前のイベントを ${FLASHBLOCKS_POLL_MS}ms ごとに取りに行きます`);
  pendingTimers[chainName] = setInterval(async () => {
    if (pendingInFlight[chainName]) return;
    const addresses = chainAddresses[chainName] || [];
    if (addresses.length === 0) return;
    pendingInFlight[chainName] = true;
    const st = pendingStatsFor(chainName);
    try {
      st.polls++;
      const logs = await callWithRpc(chainName, (p) =>
        p.send("eth_getLogs", [{ fromBlock: "pending", toBlock: "pending", address: addresses, topics: [ALL_TOPICS] }]), true);
      const receivedAt = Date.now();
      if (Array.isArray(logs) && logs.length > 0) {
        chainLastEventAt[chainName] = receivedAt;
        for (const log of logs) dispatchLog(chainName, log, receivedAt, "pending");
      }
    } catch (e) {
      st.errors++;
      if (st.errors <= 3 || st.errors % 100 === 0) {
        console.warn(`[Flashblocks/pending] ${chainName}: 取得に失敗(通算${st.errors}回): ${(e.message || "").slice(0, 80)}`);
      }
    } finally {
      pendingInFlight[chainName] = false;
    }
  }, FLASHBLOCKS_POLL_MS);
}

/// 先読みの統計(生存ログ用)。
export function getPendingStats() {
  const out = {};
  for (const [chain, st] of Object.entries(pendingStats)) {
    out[chain] = { ...st, leadAvgMs: st.sealedHits ? Math.round(st.leadTotalMs / st.sealedHits) : null };
  }
  return out;
}

/// 監視対象のアドレスを登録する。接続済みなら購読をやり直す。
export function setWatchedAddresses(chain, addresses) {
  chainAddresses[chain] = addresses.map((a) => a.toLowerCase());
  const socket = chainSockets[chain];
  if (socket && socket.readyState === 1) sendSubscription(chain);
  // pending を読むチェーンは、監視対象が決まったら確定前のイベントも取りに行く。
  if (chainAddresses[chain].length > 0) startPendingPolling(chain);
}

function sendSubscription(chainName) {
  const socket = chainSockets[chainName];
  if (!socket || socket.readyState !== 1) return;
  const addresses = chainAddresses[chainName] || [];
  if (addresses.length === 0) {
    console.log(`[オンチェーン] ${chainName}: 監視対象が0件のため購読しません`);
    return;
  }
  let sent = 0;
  for (let i = 0; i < addresses.length; i += ADDRESSES_PER_SUBSCRIPTION) {
    const chunk = addresses.slice(i, i + ADDRESSES_PER_SUBSCRIPTION);
    try {
      socket.send(JSON.stringify({
        jsonrpc: "2.0", id: SUBSCRIBE_REQUEST_ID_BASE + sent, method: "eth_subscribe",
        params: ["logs", { address: chunk, topics: [ALL_TOPICS] }],
      }));
      sent++;
    } catch (e) { break; }
  }
  chainSubCounts[chainName] = sent;
  console.log(`[オンチェーン] ${chainName}: ${addresses.length}プールを${sent}回の購読で監視します`);
}

function sendPing(chainName) {
  const socket = chainSockets[chainName];
  if (!socket || socket.readyState !== 1) return;
  try {
    socket.send(JSON.stringify({ jsonrpc: "2.0", id: PING_REQUEST_ID, method: "eth_blockNumber", params: [] }));
  } catch (e) {}
}

function connectChain(chainName, wsUrl) {
  function connect() {
    let socket;
    try {
      socket = new WebSocket(wsUrl);
      chainSockets[chainName] = socket;
    } catch (e) {
      console.log(`[診断] ${chainName} WebSocket接続失敗: ${e.message}`);
      scheduleReconnect();
      return;
    }

    socket.addEventListener("open", () => {
      chainConnectedAt[chainName] = Date.now();
      chainLastDataAt[chainName] = Date.now();
      sendSubscription(chainName);
      if (chainPingTimers[chainName]) clearInterval(chainPingTimers[chainName]);
      chainPingTimers[chainName] = setInterval(() => sendPing(chainName), PING_INTERVAL_MS);
    });

    socket.addEventListener("message", (event) => {
      const receivedAt = Date.now();
      try {
        const msg = JSON.parse(event.data);
        if (msg.id !== undefined) {
          chainLastDataAt[chainName] = receivedAt;
          if (msg.id >= SUBSCRIBE_REQUEST_ID_BASE && msg.error) {
            chainSubscribeErrors[chainName] = JSON.stringify(msg.error).slice(0, 120);
            console.warn(`[オンチェーン] ${chainName}: 購読が拒否されました: ${chainSubscribeErrors[chainName]}`);
          }
          return;
        }
        if (msg.method !== "eth_subscription" || !msg.params?.result) return;

        chainLastDataAt[chainName] = receivedAt;
        chainLastEventAt[chainName] = receivedAt;
        chainEventCounts[chainName] = (chainEventCounts[chainName] || 0) + 1;

        dispatchLog(chainName, msg.params.result, receivedAt, "sealed");
      } catch (e) {}
    });

    socket.addEventListener("close", () => {
      if (chainPingTimers[chainName]) clearInterval(chainPingTimers[chainName]);
      if (chainIntentionalClose[chainName]) {
        chainIntentionalClose[chainName] = false;
        return;
      }
      const lived = Date.now() - (chainConnectedAt[chainName] || 0);
      if (lived >= STABLE_CONNECTION_MS) chainReconnectDelays[chainName] = 1000;
      scheduleReconnect(lived);
    });

    socket.addEventListener("error", () => {});
  }

  function scheduleReconnect(lived = 0) {
    const delay = chainReconnectDelays[chainName] || 1000;
    chainReconnects[chainName] = (chainReconnects[chainName] || 0) + 1;
    if (chainReconnects[chainName] <= 3 || chainReconnects[chainName] % 20 === 0) {
      console.log(`[オンチェーン] ${chainName}: 切断(接続${Math.round(lived / 1000)}秒)。${Math.round(delay / 1000)}秒後に再接続します(通算${chainReconnects[chainName]}回)`);
    }
    setTimeout(connect, delay);
    chainReconnectDelays[chainName] = Math.min(delay * 2, MAX_RECONNECT_DELAY_MS);
  }

  if (chainWatchdogTimers[chainName]) clearInterval(chainWatchdogTimers[chainName]);
  chainWatchdogTimers[chainName] = setInterval(() => {
    const last = chainLastDataAt[chainName] ?? Date.now();
    if (Date.now() - last > DATA_TIMEOUT_MS) {
      console.log(`[オンチェーン] ${chainName}: 無応答を検知。強制再接続します…`);
      chainIntentionalClose[chainName] = true;
      try { chainSockets[chainName]?.close(); } catch (e) {}
      chainLastDataAt[chainName] = Date.now();
      connect();
    }
  }, 20000);

  connect();
}

// ===== Flashblocks(OP Stack の確定前ブロック配信)の対応確認(2026年9月20日) =====
//
// Optimism / Base のシーケンサーは 200〜250ms ごとに「確定前の部分ブロック」を配る。
// これを受ければ、ブロック確定(2秒)を待たずに判定でき、「1ブロック遅い」が解消する。
// 対応した端点では eth_subscribe("newFlashblocks") が通り、非対応なら失敗する。
// 起動時に別の接続で一度だけ試し、結果と配信間隔をログに出す(判定には使わない)。
// 試す URL は <CHAIN>_FLASHBLOCKS_WSS_URL があればそれ、無ければ通常の WSS。
const FLASHBLOCKS_CHAINS = new Set(["optimism", "base"]);
const FLASHBLOCKS_PROBE_TIMEOUT_MS = 20 * 1000;
const flashblocksStatus = {}; // chain -> { supported, url, intervalsMs, error }

export function getFlashblocksStatus() { return { ...flashblocksStatus }; }

function probeFlashblocks(chainName, wsUrl) {
  return new Promise((resolve) => {
    let socket;
    const arrivals = [];
    let subId = null;
    let finished = false;
    // 購読の名前は提供元で違う(Chainstack: newFlashblocks / Alchemy: newFlashblockTransactions)。
    // 順に試し、通った名前を記録する。
    // 最後の newHeads は Flashblocks ではなく、比較用(通常の新ブロック通知の間隔を測る)。
    const methods = ["newFlashblocks", "newFlashblockTransactions", "newHeads"];
    let tried = 0;
    const finish = (subscribed, error) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      const intervals = arrivals.slice(1).map((t, i) => t - arrivals[i]);
      const supported = subscribed && methods[tried] !== "newHeads";
      flashblocksStatus[chainName] = { supported, method: subscribed ? methods[tried] : null, url: wsUrl.replace(/\/[^/]*$/, "/…"), intervalsMs: intervals, error: error || null };
      if (supported) {
        console.log(`[Flashblocks] ${chainName}: 対応あり(${methods[tried]} を購読できました)。配信間隔 ${intervals.length ? intervals.join("/") + "ms" : "計測できず"}`);
      } else if (subscribed) {
        console.log(`[Flashblocks] ${chainName}: Flashblocks の購読は拒否(標準の pending タグで読む)。比較用 newHeads の間隔 ${intervals.length ? intervals.join("/") + "ms" : "計測できず"}`);
      } else {
        console.log(`[Flashblocks] ${chainName}: 対応なし(${error})。Chainstack で Flashblocks 対応の端点にすると使えます`);
      }
      try { if (subId && socket && socket.readyState === 1) socket.send(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "eth_unsubscribe", params: [subId] })); } catch (e) {}
      try { socket && socket.close(); } catch (e) {}
      resolve();
    };
    const timer = setTimeout(() => finish(subId != null, subId != null ? null : "20秒以内に応答なし"), FLASHBLOCKS_PROBE_TIMEOUT_MS);
    try {
      socket = new WebSocket(wsUrl);
    } catch (e) { finish(false, e.message); return; }
    // 購読の名前は提供元で違う(Chainstack: newFlashblocks / Alchemy: newFlashblockTransactions)。
    // 順に試し、通った名前を記録する。
    const trySubscribe = () => {
      try { socket.send(JSON.stringify({ jsonrpc: "2.0", id: 10 + tried, method: "eth_subscribe", params: [methods[tried]] })); } catch (e) { finish(false, e.message); }
    };
    socket.addEventListener("open", trySubscribe);
    socket.addEventListener("message", (event) => {
      try {
        const msg = JSON.parse(event.data);
        if (msg.id === 10 + tried && subId == null) {
          if (msg.error) {
            const reason = (msg.error.message || "購読を拒否").slice(0, 80);
            tried++;
            if (tried < methods.length) return trySubscribe();
            return finish(false, reason);
          }
          subId = msg.result;
          return;
        }
        if (msg.method === "eth_subscription" && msg.params?.subscription === subId) {
          arrivals.push(Date.now());
          if (arrivals.length >= 6) finish(true, null);
        }
      } catch (e) {}
    });
    socket.addEventListener("error", () => finish(false, "接続に失敗"));
    socket.addEventListener("close", () => finish(subId != null, subId != null ? null : "接続が閉じられた"));
  });
}

/// WebSocketを開始する。監視対象は後から setWatchedAddresses() で渡す。
export function startOnchainFeeds(onSync, onV3Swap, onV3Liquidity) {
  globalOnSync = onSync;
  globalOnV3Swap = onV3Swap;
  globalOnV3Liquidity = onV3Liquidity;

  for (const [name, topic] of [["Sync", SYNC_TOPIC], ["Swap", V3_SWAP_TOPIC], ["Mint", V3_MINT_TOPIC], ["Burn", V3_BURN_TOPIC]]) {
    if (topic.length !== 66) {
      console.error(`[オンチェーン] 致命的: ${name}の識別子の長さが不正です(${topic.length}文字、66文字であるべき)`);
    }
  }

  let anyStarted = false;
  for (const [chainName, envVar] of Object.entries(CHAIN_WS_ENV_VARS)) {
    const wsUrl = process.env[envVar];
    if (!wsUrl) {
      console.log(`[オンチェーン] ${chainName}: ${envVar} 未設定のためスキップ(定期読み直しで観測)`);
      continue;
    }
    chainEnabled.add(chainName);
    chainLastEventAt[chainName] = Date.now();
    connectChain(chainName, wsUrl);
    anyStarted = true;
    // OP Stack のチェーンは、Flashblocks に対応した端点かを別接続で一度だけ確かめる。
    if (FLASHBLOCKS_CHAINS.has(chainName) && process.env.FLASHBLOCKS_PROBE !== "false") {
      const probeUrl = process.env[`${chainName.toUpperCase()}_FLASHBLOCKS_WSS_URL`] || wsUrl;
      probeFlashblocks(chainName, probeUrl).catch(() => {});
    }
  }
  if (!anyStarted) {
    console.log("[オンチェーン] WebSocket URLが1つも未設定。定期読み直しのみで動作します。");
  }
}

export function updatePoolSubscriptions() { /* setWatchedAddresses を使う */ }

export function isChainWsEnabled(chainName) {
  return chainEnabled.has(chainName);
}

export function isChainHealthy(chainName) {
  if (!chainEnabled.has(chainName)) return false;
  const last = chainLastEventAt[chainName];
  if (!last) return false;
  return Date.now() - last < HEALTHY_EVENT_WINDOW_MS;
}

export function getSyncStats() {
  const out = {};
  for (const chain of chainEnabled) {
    const last = chainLastEventAt[chain];
    out[chain] = {
      received: chainEventCounts[chain] || 0,
      v2: chainV2Counts[chain] || 0,
      v3: chainV3Counts[chain] || 0,
      liquidity: chainLiquidityCounts[chain] || 0,
      watched: (chainAddresses[chain] || []).length,
      subscriptions: chainSubCounts[chain] || 0,
      connected: chainSockets[chain]?.readyState === 1,
      healthy: isChainHealthy(chain),
      lastEventAgoSec: last ? Math.round((Date.now() - last) / 1000) : null,
      reconnects: chainReconnects[chain] || 0,
      error: chainSubscribeErrors[chain] || null,
    };
  }
  return out;
}
