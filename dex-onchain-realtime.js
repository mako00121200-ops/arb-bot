/**
 * オンチェーン イベント リアルタイム購読モジュール
 * ------------------------------------------------------------
 * 取引や流動性の変化をWebSocketで直接受け取る。
 *   V2形式 … Sync(準備量そのもの)
 *   V3形式 … Swap(更新後の価格と流動性) / Mint・Burn(流動性の増減)
 *
 * [Mint・Burnも見る理由]
 * V3の流動性はSwap以外でも変わる。誰かが価格帯に流動性を足したり抜いたり
 * すると、Swapが起きていなくても受取量の計算結果が変わる。これを見ないと
 * 古い流動性で計算し続け、幻の機会や見逃しが生まれる。
 * Mint・Burnのデータには更新後の流動性が入っていないため、これらが届いた
 * プールは「読み直しが必要」として呼び出し側に知らせる。
 *
 * [4種類を1接続で]
 * eth_subscribe の topics は配列の配列で「いずれか一致」を指定できる。
 * 4種類をまとめて1つの購読で受け取り、接続数を増やさない。
 *
 * [再接続の暴走を防ぐ]
 * 接続直後に切断される状態では待ち時間を毎回1秒に戻していたため、
 * 接続と切断を繰り返した。一定時間つながり続けたときだけ初期化する。
 *
 * [健全性の判定]
 * 「接続はできるがイベントが届かない」状態では購読が有効とみなされ、
 * 定期読み直しがスキップされて価格が古いまま固定される危険がある。
 */

// keccak256("Sync(uint112,uint112)") — Uniswap V2形式
const SYNC_TOPIC = "0x1c411e9a96e071241c2f21f7726b17ae89e3cab4c78be50e062b03a9fffbbad1";
// keccak256("Swap(address,address,int256,int256,uint160,uint128,int24)") — V3
const V3_SWAP_TOPIC = "0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67";
// keccak256("Mint(address,address,int24,int24,uint128,uint256,uint256)") — V3
const V3_MINT_TOPIC = "0x7a53080ba414158be7ec69b987b5fb7d07dee101fe85488f0853ae16239d0bde";
// keccak256("Burn(address,int24,int24,uint128,uint256,uint256)") — V3
const V3_BURN_TOPIC = "0x0c396cd989a39f4459b5fa1aed6a9a8dcdbc45908acfd67e028cd568da98982c";

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
const HEALTHY_EVENT_WINDOW_MS = parseInt(process.env.HEALTHY_EVENT_WINDOW_MS || "120000", 10);
const STABLE_CONNECTION_MS = 30 * 1000;
const MAX_RECONNECT_DELAY_MS = 5 * 60 * 1000;

/// V2のSyncデータ: (uint112 reserve0, uint112 reserve1)
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

/// V3のSwapデータ: (int256 amount0, int256 amount1, uint160 sqrtPriceX96,
///                  uint128 liquidity, int24 tick)
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
const chainMatchedCounts = {};
const chainSubscribeErrors = {};
const chainReconnects = {};
let globalOnSync = null;        // V2用
let globalOnV3Swap = null;      // V3のSwap用
let globalOnV3Liquidity = null; // V3のMint・Burn用(読み直しが必要な合図)

function sendSubscription(chainName) {
  const socket = chainSockets[chainName];
  if (!socket || socket.readyState !== 1) return;
  try {
    socket.send(JSON.stringify({
      jsonrpc: "2.0", id: SUBSCRIBE_REQUEST_ID, method: "eth_subscribe",
      params: ["logs", { topics: [[SYNC_TOPIC, V3_SWAP_TOPIC, V3_MINT_TOPIC, V3_BURN_TOPIC]] }],
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
              console.log(`[オンチェーン] ${chainName}: V2のSyncとV3のSwap・Mint・Burnを1つの購読で受け取ります`);
            }
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
        let matched = false;

        if (topic === SYNC_TOPIC) {
          chainV2Counts[chainName] = (chainV2Counts[chainName] || 0) + 1;
          const decoded = decodeSyncData(log.data);
          if (decoded && globalOnSync) {
            matched = globalOnSync(chainName, address, decoded.reserve0, decoded.reserve1, receivedAt);
          }
        } else if (topic === V3_SWAP_TOPIC) {
          chainV3Counts[chainName] = (chainV3Counts[chainName] || 0) + 1;
          const decoded = decodeV3SwapData(log.data);
          if (decoded && globalOnV3Swap) {
            matched = globalOnV3Swap(chainName, address, decoded.sqrtPriceX96, decoded.liquidity, receivedAt);
          }
        } else if (topic === V3_MINT_TOPIC || topic === V3_BURN_TOPIC) {
          // 流動性が変わった。データに更新後の値が無いため、読み直しを依頼する。
          chainLiquidityCounts[chainName] = (chainLiquidityCounts[chainName] || 0) + 1;
          if (globalOnV3Liquidity) {
            matched = globalOnV3Liquidity(chainName, address, topic === V3_MINT_TOPIC ? "mint" : "burn");
          }
        }

        if (matched) chainMatchedCounts[chainName] = (chainMatchedCounts[chainName] || 0) + 1;
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
  }, 15000);

  connect();
}

/// onSync        … V2のSync受信時 (chain, address, reserve0, reserve1, receivedAt)
/// onV3Swap      … V3のSwap受信時 (chain, address, sqrtPriceX96, liquidity, receivedAt)
/// onV3Liquidity … V3のMint・Burn受信時 (chain, address, "mint"|"burn")
/// いずれも「監視対象だったか」を真偽値で返す。
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
