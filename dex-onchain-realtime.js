/**
 * オンチェーン Sync イベント リアルタイム購読モジュール
 * ------------------------------------------------------------
 * 取引のたびに発行される Sync イベント(最新の準備量そのもの)を
 * WebSocketで直接受け取る。追加の問い合わせなしで取引直後の正しい
 * 準備量が得られるため、検知から計算までの遅延をほぼゼロにできる。
 *
 * [修正1] 「60秒間イベントが無ければ切断」という誤判定で再接続が頻発した。
 * 定期的なping(eth_blockNumber)で能動的に生存確認する方式に変更済み。
 *
 * [修正2] アドレスを指定して購読する方式をやめた。13,783プールを400件ずつ
 * 35回に分けて購読するとRPC側の購読数制限に当たるため、チェーン上の全Sync
 * イベントを「1つの購読」で受け取り、手元で監視対象かどうかを判定する。
 * 購読は常に1回で済むため制限に当たらず、全プールを漏れなくカバーできる。
 *
 * [修正3] イベント監視用のRPCを、読み取り用とは別に指定できるようにした。
 * 無料枠のノードを複数契約し「ノードAで読み取り、ノードBでイベント監視」と
 * 役割分担させることで、1ノードあたりの制限を回避しつつ速度を保てる。
 *   環境変数: BASE_WSS_URL, ARBITRUM_WSS_URL, OPTIMISM_WSS_URL,
 *             POLYGON_WSS_URL, AVALANCHE_WSS_URL
 */

// keccak256("Sync(uint112,uint112)")。
// 以前、末尾の1文字が欠けた63文字の値が書かれており、RPCに
// 「hex string of odd length」と拒否され続けていた。そのため
// Syncイベントはシステムの最初期から一度も届いていなかった。
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
const chainWatchdogTimers = {};
const chainPingTimers = {};
const chainIntentionalClose = {};
const chainEnabled = new Set();
const chainEventCounts = {};
const chainMatchedCounts = {};
const chainSubscribeErrors = {};
let globalOnSync = null;

/// チェーン上の全Syncイベントを1つの購読で受け取る。
function sendSubscription(chainName) {
  const socket = chainSockets[chainName];
  if (!socket || socket.readyState !== 1) return;
  try {
    socket.send(JSON.stringify({
      jsonrpc: "2.0", id: SUBSCRIBE_REQUEST_ID, method: "eth_subscribe",
      params: ["logs", { topics: [SYNC_TOPIC] }],
    }));
    console.log(`[オンチェーン] ${chainName}: 全Syncイベントを購読しました(1接続1購読)`);
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
          if (msg.id === SUBSCRIBE_REQUEST_ID) {
            if (msg.error) {
              chainSubscribeErrors[chainName] = JSON.stringify(msg.error).slice(0, 120);
              console.warn(`[オンチェーン] ${chainName}: 購読が拒否されました: ${chainSubscribeErrors[chainName]}`);
            } else {
              chainSubscribeErrors[chainName] = null;
              console.log(`[オンチェーン] ${chainName}: 購読が受理されました`);
            }
          }
          return;
        }
        if (msg.method === "eth_subscription" && msg.params?.result) {
          chainLastDataAt[chainName] = receivedAt;
          chainEventCounts[chainName] = (chainEventCounts[chainName] || 0) + 1;
          const log = msg.params.result;
          const decoded = decodeSyncData(log.data);
          if (decoded && globalOnSync) {
            // 監視対象かどうかの判定は受け手(index.js)に任せる。
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

  // 起動時に識別子の長さを検算する(過去、1文字欠けたまま気づかなかったため)。
  if (SYNC_TOPIC.length !== 66) {
    console.error(`[オンチェーン] 致命的: SYNC_TOPICの長さが不正です(${SYNC_TOPIC.length}文字、正しくは66文字)`);
  }

  let anyStarted = false;
  for (const [chainName, envVar] of Object.entries(CHAIN_WS_ENV_VARS)) {
    const wsUrl = process.env[envVar];
    if (!wsUrl) {
      console.log(`[オンチェーン] ${chainName}: ${envVar} 未設定のためスキップ(定期スキャンのみで観測)`);
      continue;
    }
    chainEnabled.add(chainName);
    connectChain(chainName, wsUrl);
    anyStarted = true;
  }
  if (!anyStarted) {
    console.log("[オンチェーン] WebSocket URLが1つも未設定。リアルタイム監視は無効(定期スキャンのみで動作)。");
  }
}

/// 全件購読に変更したため、個別のアドレス登録は不要。呼び出し側の互換のため残す。
export function updatePoolSubscriptions() { /* 全件購読のため何もしない */ }

export function isChainWsEnabled(chainName) {
  return chainEnabled.has(chainName);
}

/// ダッシュボード表示用: チェーンごとの受信件数と、うち監視対象だった件数。
export function getSyncStats() {
  const out = {};
  for (const chain of chainEnabled) {
    out[chain] = {
      received: chainEventCounts[chain] || 0,
      matched: chainMatchedCounts[chain] || 0,
      connected: chainSockets[chain]?.readyState === 1,
      error: chainSubscribeErrors[chain] || null,
    };
  }
  return out;
}
