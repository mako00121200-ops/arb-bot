/**
 * オンチェーン Sync イベント リアルタイム購読モジュール
 * ------------------------------------------------------------
 * 対象プールの「Sync」イベント(取引のたびに発行される、最新の準備量そのもの)を
 * WebSocketで直接購読する。追加の問い合わせなしで取引直後の正しい準備量が
 * そのまま得られるため、検知から計算までの遅延をほぼゼロにできる。
 *
 * 環境変数: BASE_WSS_URL, ARBITRUM_WSS_URL, OPTIMISM_WSS_URL,
 *           POLYGON_WSS_URL, AVALANCHE_WSS_URL
 * 未設定のチェーンは自動的にスキップされる。
 *
 * [修正1] 「60秒間Syncイベントが無ければ切断」という誤判定で再接続が頻発した。
 * 定期的なping(eth_blockNumber)で能動的に生存確認する方式に変更済み。
 *
 * [修正2] 購読アドレスが数千件になるとRPC側が1回の要求を拒否するため、
 * 一定数ごとに分割して複数の購読に分ける。
 */

const SYNC_TOPIC = "0x1c411e9a96e071241c2f21f7726b17ae89e3cab4c78be50e062b03a9fffbbad";

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
// 1回の購読要求に含めるアドレス数の上限。多すぎるとRPC側が拒否する。
const ADDRESSES_PER_SUBSCRIPTION = 400;

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
const chainSubscribedPools = {};
const chainWatchdogTimers = {};
const chainPingTimers = {};
const chainIntentionalClose = {};
let globalOnSync = null;

/// 購読アドレスを分割して、複数の eth_subscribe に分けて送る。
function sendSubscription(chainName) {
  const socket = chainSockets[chainName];
  if (!socket || socket.readyState !== 1) return;
  const pools = [...(chainSubscribedPools[chainName] || [])];
  if (pools.length === 0) return;

  let requestId = 100;
  for (let i = 0; i < pools.length; i += ADDRESSES_PER_SUBSCRIPTION) {
    const chunk = pools.slice(i, i + ADDRESSES_PER_SUBSCRIPTION);
    try {
      socket.send(JSON.stringify({
        jsonrpc: "2.0", id: requestId++, method: "eth_subscribe",
        params: ["logs", { address: chunk, topics: [SYNC_TOPIC] }],
      }));
    } catch (e) { break; }
  }
  console.log(`[オンチェーン] ${chainName}: ${pools.length}プールを${Math.ceil(pools.length / ADDRESSES_PER_SUBSCRIPTION)}回に分けて購読`);
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
      chainReconnectDelays[chainName] = 1000;
      chainLastDataAt[chainName] = Date.now();
      console.log(`[オンチェーン] ${chainName}: WebSocket接続完了`);
      sendSubscription(chainName);
      if (chainPingTimers[chainName]) clearInterval(chainPingTimers[chainName]);
      chainPingTimers[chainName] = setInterval(() => sendPing(chainName), PING_INTERVAL_MS);
    });

    socket.addEventListener("message", (event) => {
      const receivedAt = Date.now();
      try {
        const msg = JSON.parse(event.data);
        if (msg.id !== undefined) {
          // 購読確認・pingの返事は「接続が生きている」証拠として扱う。
          chainLastDataAt[chainName] = receivedAt;
          return;
        }
        if (msg.method === "eth_subscription" && msg.params?.result) {
          chainLastDataAt[chainName] = receivedAt;
          const log = msg.params.result;
          const decoded = decodeSyncData(log.data);
          if (decoded && globalOnSync) {
            globalOnSync(chainName, log.address.toLowerCase(), decoded.reserve0, decoded.reserve1, receivedAt);
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
      console.log(`[オンチェーン] ${chainName}: 切断。再接続します…`);
      scheduleReconnect();
    });

    socket.addEventListener("error", () => {});
  }

  function scheduleReconnect() {
    const delay = chainReconnectDelays[chainName] || 1000;
    setTimeout(connect, delay);
    chainReconnectDelays[chainName] = Math.min(delay * 1.5, 30000);
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
  let anyStarted = false;
  for (const [chainName, envVar] of Object.entries(CHAIN_WS_ENV_VARS)) {
    const wsUrl = process.env[envVar];
    if (!wsUrl) {
      console.log(`[オンチェーン] ${chainName}: ${envVar} 未設定のためスキップ(定期スキャンのみで観測)`);
      continue;
    }
    chainSubscribedPools[chainName] = new Set();
    connectChain(chainName, wsUrl);
    anyStarted = true;
  }
  if (!anyStarted) {
    console.log("[オンチェーン] WebSocket URLが1つも未設定。リアルタイム監視は無効(定期スキャンのみで動作)。");
  }
}

/// 購読対象を追加する。既に接続済みなら、購読し直す。
export function updatePoolSubscriptions(chainName, poolAddresses) {
  if (!chainSubscribedPools[chainName]) return;
  const before = chainSubscribedPools[chainName].size;
  for (const addr of poolAddresses) {
    if (addr) chainSubscribedPools[chainName].add(addr.toLowerCase());
  }
  if (chainSubscribedPools[chainName].size !== before) sendSubscription(chainName);
}

export function isChainWsEnabled(chainName) {
  return chainSubscribedPools[chainName] !== undefined;
}

export function getSubscriptionCounts() {
  const out = {};
  for (const [chain, set] of Object.entries(chainSubscribedPools)) out[chain] = set.size;
  return out;
}
