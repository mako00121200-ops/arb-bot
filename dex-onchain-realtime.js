/**
 * オンチェーン Sync イベント リアルタイム購読モジュール
 * ------------------------------------------------------------
 * 取引のたびに発行される Sync イベント(最新の準備量そのもの)を
 * WebSocketで直接受け取る。追加の問い合わせなしで取引直後の正しい
 * 準備量が得られるため、検知から計算までの遅延をほぼゼロにできる。
 *
 * [再接続の暴走を防ぐ]
 * 接続直後に切断される状態(RPCの秒間上限超過など)では、待ち時間を
 * 毎回1秒に戻していたため、1秒ごとに接続と切断を繰り返してクレジットを
 * 無駄に消費した(2026年9月15日、QuickNodeで発生)。
 * 「一定時間つながり続けた」ときだけ待ち時間を初期化する。
 *
 * [健全性の判定]
 * 「接続はできるがイベントが一切届かない」状態では、購読が有効とみなされ
 * 定期読み直しがスキップされ、価格が古いまま固定される危険がある。
 * 一定時間イベントが届かないチェーンは isChainHealthy() が false を返し、
 * 呼び出し側が定期読み直しに切り替える。
 *
 * [1接続1購読]
 * アドレスを指定して購読すると数千件でRPC側の制限に当たるため、
 * チェーン上の全Syncイベントを1つの購読で受け取り、監視対象かどうかは
 * 手元で判定する。
 */

// keccak256("Sync(uint112,uint112)")。
// 以前、末尾の1文字が欠けた63文字の値が書かれており、RPCに
// 「hex string of odd length」と拒否され続けていた。
// 16進64文字(0x込みで66文字)であることが正しさの目印。
const SYNC_TOPIC = "0x1c411e9a96e071241c2f21f7726b17ae89e3cab4c78be50e062b03a9fffbbad1";

const CHAIN_WS_ENV_VARS = {
  base: "BASE_WSS_URL",
  arbitrum: "ARBITRUM_WSS_URL",
  optimism: "OPTIMISM_WSS_URL",
  polygon: "POLYGON_WSS_URL",
  avalanche: "AVALANCHE_WSS_URL",
};

const DATA_TIMEOUT_MS = 60 * 1000;
const PING_INTERVAL_MS = 20 * 1000;
const PING_REQUEST_ID = 999;
const SUBSCRIBE_REQUEST_ID = 1;
// この時間イベントが1件も届かなければ「不健全」とみなす。
const HEALTHY_EVENT_WINDOW_MS = parseInt(process.env.HEALTHY_EVENT_WINDOW_MS || "120000", 10);
// これだけつながり続けたら「安定した接続」とみなし、待ち時間を初期化する。
const STABLE_CONNECTION_MS = 30 * 1000;
const MAX_RECONNECT_DELAY_MS = 5 * 60 * 1000;

export function decodeSyncData(dataHex) {
  const data = dataHex.startsWith("0x") ? dataHex.slice(2) : dataHex;
  if (data.length < 128) return null;
  return {
    reserve0: BigInt("0x" + data.slice(0, 64)),
    reserve1: BigInt("0x" + data.slice(64, 128)),
  };
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
const chainMatchedCounts = {};
const chainSubscribeErrors = {};
const chainReconnects = {};
let globalOnSync = null;

function sendSubscription(chainName) {
  const socket = chainSockets[chainName];
  if (!socket || socket.readyState !== 1) return;
  try {
    socket.send(JSON.stringify({
      jsonrpc: "2.0", id: SUBSCRIBE_REQUEST_ID, method: "eth_subscribe",
      params: ["logs", { topics: [SYNC_TOPIC] }],
    }));
  } catch (e) {}
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
          if (msg.id === SUBSCRIBE_REQUEST_ID) {
            if (msg.error) {
              chainSubscribeErrors[chainName] = JSON.stringify(msg.error).slice(0, 120);
              console.warn(`[オンチェーン] ${chainName}: 購読が拒否されました: ${chainSubscribeErrors[chainName]}`);
            } else if (chainSubscribeErrors[chainName] !== null) {
              chainSubscribeErrors[chainName] = null;
              console.log(`[オンチェーン] ${chainName}: 購読が受理されました`);
            }
          }
          return;
        }
        if (msg.method === "eth_subscription" && msg.params?.result) {
          chainLastDataAt[chainName] = receivedAt;
          chainLastEventAt[chainName] = receivedAt;
          chainEventCounts[chainName] = (chainEventCounts[chainName] || 0) + 1;
          const log = msg.params.result;
          const decoded = decodeSyncData(log.data);
          if (decoded && globalOnSync) {
            const matched = globalOnSync(chainName, log.address.toLowerCase(), decoded.reserve0, decoded.reserve1, receivedAt);
            if (matched) chainMatchedCounts[chainName] = (chainMatchedCounts[chainName] || 0) + 1;
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
      // つながっていた時間が短ければ、相手に拒まれている可能性が高い。
      // 待ち時間を伸ばして、接続と切断の繰り返しを避ける。
      const lived = Date.now() - (chainConnectedAt[chainName] || 0);
      if (lived >= STABLE_CONNECTION_MS) chainReconnectDelays[chainName] = 1000;
      scheduleReconnect(lived);
    });

    socket.addEventListener("error", () => {});
  }

  function scheduleReconnect(lived = 0) {
    const delay = chainReconnectDelays[chainName] || 1000;
    chainReconnects[chainName] = (chainReconnects[chainName] || 0) + 1;
    // 短時間で切れ続けている間だけログを間引く(1秒ごとの大量出力を避ける)。
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
  }, 15000);

  connect();
}

export function startOnchainFeeds(onSync) {
  globalOnSync = onSync;

  if (SYNC_TOPIC.length !== 66) {
    console.error(`[オンチェーン] 致命的: SYNC_TOPICの長さが不正です(${SYNC_TOPIC.length}文字、正しくは66文字)`);
  }

  let anyStarted = false;
  for (const [chainName, envVar] of Object.entries(CHAIN_WS_ENV_VARS)) {
    const wsUrl = process.env[envVar];
    if (!wsUrl) {
      console.log(`[オンチェーン] ${chainName}: ${envVar} 未設定のためスキップ(定期読み直しで観測)`);
      continue;
    }
    chainEnabled.add(chainName);
    chainLastEventAt[chainName] = Date.now(); // 起動直後は猶予を与える
    chainSubscribeErrors[chainName] = undefined;
    connectChain(chainName, wsUrl);
    anyStarted = true;
  }
  if (!anyStarted) {
    console.log("[オンチェーン] WebSocket URLが1つも未設定。定期読み直しのみで動作します。");
  }
}

export function updatePoolSubscriptions() { /* 全件購読のため何もしない */ }

export function isChainWsEnabled(chainName) {
  return chainEnabled.has(chainName);
}

/// 購読が実際に機能しているか。一定時間イベントが届かなければ false。
/// 呼び出し側はこれを見て、定期読み直しに切り替える。
export function isChainHealthy(chainName) {
  if (!chainEnabled.has(chainName)) return false;
  const last = chainLastEventAt[chainName];
  if (!last) return false;
  return Date.now() - last < HEALTHY_EVENT_WINDOW_MS;
}

/// ダッシュボード表示用。
export function getSyncStats() {
  const out = {};
  for (const chain of chainEnabled) {
    const last = chainLastEventAt[chain];
    out[chain] = {
      received: chainEventCounts[chain] || 0,
      matched: chainMatchedCounts[chain] || 0,
      connected: chainSockets[chain]?.readyState === 1,
      healthy: isChainHealthy(chain),
      lastEventAgoSec: last ? Math.round((Date.now() - last) / 1000) : null,
      reconnects: chainReconnects[chain] || 0,
      error: chainSubscribeErrors[chain] || null,
    };
  }
  return out;
}
