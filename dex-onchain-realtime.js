/**
 * オンチェーン Sync イベント リアルタイム購読モジュール
 * ------------------------------------------------------------
 * DexScreenerを3分おきにポーリングする方式から、対象プールの
 * 「Sync」イベント(取引のたびに発行される、最新の準備量そのもの)を
 * WebSocketで直接購読する方式に切り替えるための土台。
 *
 * Sync イベントには、追加の問い合わせなしで「取引直後の正しい準備量」が
 * そのまま含まれているため、検知から計算までの遅延をほぼゼロにできる。
 *
 * 利用には、無料のRPCプロバイダー(Chainstack等)で発行した
 * WebSocketエンドポイントのURLが必要。Railwayの環境変数に
 * 以下の名前で設定する:
 *   BASE_WSS_URL, ARBITRUM_WSS_URL, OPTIMISM_WSS_URL,
 *   ETHEREUM_WSS_URL, POLYGON_WSS_URL
 * 設定されていないチェーンは、自動的にスキップされる(エラーにはしない)。
 */

const SYNC_TOPIC = "0x1c411e9a96e071241c2f21f7726b17ae89e3cab4c78be50e062b03a9fffbbad";

const CHAIN_WS_ENV_VARS = {
  base: "BASE_WSS_URL",
  arbitrum: "ARBITRUM_WSS_URL",
  optimism: "OPTIMISM_WSS_URL",
  ethereum: "ETHEREUM_WSS_URL",
  polygon: "POLYGON_WSS_URL",
};

const DATA_TIMEOUT_MS = 60 * 1000;

export function decodeSyncData(dataHex) {
  const data = dataHex.startsWith("0x") ? dataHex.slice(2) : dataHex;
  if (data.length < 128) return null;
  const reserve0Hex = data.slice(0, 64);
  const reserve1Hex = data.slice(64, 128);
  return {
    reserve0: BigInt("0x" + reserve0Hex),
    reserve1: BigInt("0x" + reserve1Hex),
  };
}

const chainSockets = {};
const chainReconnectDelays = {};
const chainLastDataAt = {};
const chainSubscribedPools = {};
const chainWatchdogTimers = {};
const chainIntentionalClose = {};
let globalOnSync = null;

function sendSubscription(chainName) {
  const socket = chainSockets[chainName];
  if (!socket || socket.readyState !== 1) return;
  const pools = [...(chainSubscribedPools[chainName] || [])];
  if (pools.length === 0) return;
  socket.send(JSON.stringify({
    jsonrpc: "2.0", id: 1, method: "eth_subscribe",
    params: ["logs", { address: pools, topics: [SYNC_TOPIC] }],
  }));
}

function connectChain(chainName, wsUrl) {
  function connect() {
    let socket;
    try {
      socket = new WebSocket(wsUrl);
      chainSockets[chainName] = socket;
    } catch (e) {
      console.log(`[診断] ${chainName} オンチェーンWebSocket接続失敗: ${e.message}`);
      scheduleReconnect();
      return;
    }

    socket.addEventListener("open", () => {
      chainReconnectDelays[chainName] = 1000;
      chainLastDataAt[chainName] = Date.now();
      console.log(`[オンチェーン] ${chainName}: WebSocket接続完了`);
      sendSubscription(chainName);
    });

    socket.addEventListener("message", (event) => {
      const receivedAt = Date.now();
      chainLastDataAt[chainName] = receivedAt;
      try {
        const msg = JSON.parse(event.data);
        if (msg.id !== undefined) return;
        if (msg.method === "eth_subscription" && msg.params?.result) {
          const log = msg.params.result;
          const decoded = decodeSyncData(log.data);
          if (decoded && globalOnSync) {
            globalOnSync(chainName, log.address.toLowerCase(), decoded.reserve0, decoded.reserve1, receivedAt);
          }
        }
      } catch (e) {}
    });

    socket.addEventListener("close", () => {
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
      console.log(`[オンチェーン] ${chainName}: ${envVar} が未設定のためスキップ(引き続きDexScreenerのポーリングのみで観測)`);
      continue;
    }
    chainSubscribedPools[chainName] = new Set();
    connectChain(chainName, wsUrl);
    anyStarted = true;
  }
  if (!anyStarted) {
    console.log("[オンチェーン] どのチェーンもWebSocket URLが未設定。オンチェーンのリアルタイム監視は無効(DexScreenerのポーリングのみで動作します)。");
  }
}

export function updatePoolSubscriptions(chainName, poolAddresses) {
  if (!chainSubscribedPools[chainName]) return;
  const before = chainSubscribedPools[chainName].size;
  for (const addr of poolAddresses) {
    if (addr) chainSubscribedPools[chainName].add(addr.toLowerCase());
  }
  if (chainSubscribedPools[chainName].size !== before) {
    sendSubscription(chainName);
  }
}

export function isChainWsEnabled(chainName) {
  return chainSubscribedPools[chainName] !== undefined;
}
