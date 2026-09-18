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

/// 監視対象のアドレスを登録する。接続済みなら購読をやり直す。
export function setWatchedAddresses(chain, addresses) {
  chainAddresses[chain] = addresses.map((a) => a.toLowerCase());
  const socket = chainSockets[chain];
  if (socket && socket.readyState === 1) sendSubscription(chain);
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

        const log = msg.params.result;
        const topic = (log.topics && log.topics[0]) || "";
        const address = log.address.toLowerCase();

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
