/**
 * リアルタイム価格フィード(WebSocket版) v3
 * ------------------------------------------------------------
 * v2からの変更点(重要な修正):
 *   1. 強制再接続時に、close イベント側でも重複して再接続予約が
 *      走ってしまうバグを修正(意図的なcloseかどうかをフラグで判定)。
 *   2. OKXの ping/pong の向きが逆だった。OKXの仕様ではサーバーからの
 *      pingを待つだけでなく、クライアント側からも能動的にpingを
 *      送る必要があるため、Bybit同様の定期ping送信を追加。
 */

const OKX_WS_URL = "wss://ws.okx.com:8443/ws/v5/public";
const BYBIT_WS_URL = "wss://stream.bybit.com/v5/public/spot";
const POLYMARKET_WS_URL = "wss://ws-subscriptions-clob.polymarket.com/ws/market";

const OKX_INSTRUMENTS = { "BTC-USDT": "BTC", "ETH-USDT": "ETH" };
const BYBIT_INSTRUMENTS = { "BTCUSDT": "BTC", "ETHUSDT": "ETH" };

const DATA_TIMEOUT_MS = 60 * 1000;

// ============ OKXのリアルタイム価格ストリーム ============
let okxSocket = null;
let okxReconnectDelay = 1000;
let okxLastDataAt = Date.now();
let okxWatchdogTimer = null;
let okxPingTimer = null;
let okxIntentionalClose = false;

export function startOkxFeed(onTick) {
  function connect() {
    let socket;
    try {
      socket = new WebSocket(OKX_WS_URL);
      okxSocket = socket;
    } catch (e) {
      console.log(`[診断] OKX WebSocket接続失敗: ${e.message}`);
      scheduleReconnect();
      return;
    }

    socket.addEventListener("open", () => {
      okxReconnectDelay = 1000;
      okxLastDataAt = Date.now();
      const args = Object.keys(OKX_INSTRUMENTS).map((instId) => ({ channel: "tickers", instId }));
      socket.send(JSON.stringify({ op: "subscribe", args }));
      console.log("[OKX WebSocket] 接続完了・購読開始");

      if (okxPingTimer) clearInterval(okxPingTimer);
      okxPingTimer = setInterval(() => {
        if (okxSocket?.readyState === 1) okxSocket.send("ping");
      }, 20000);
    });

    socket.addEventListener("message", (event) => {
      okxLastDataAt = Date.now();
      if (event.data === "ping") {
        socket.send("pong");
        return;
      }
      if (event.data === "pong") return;
      try {
        const msg = JSON.parse(event.data);
        if (msg.event) return;
        const instId = msg.arg?.instId;
        const asset = OKX_INSTRUMENTS[instId];
        if (!asset || !msg.data?.[0]) return;
        const price = parseFloat(msg.data[0].last);
        if (!isFinite(price)) return;
        onTick(asset, price, Date.now());
      } catch (e) {}
    });

    socket.addEventListener("close", () => {
      if (okxIntentionalClose) {
        okxIntentionalClose = false;
        return;
      }
      console.log("[OKX WebSocket] 切断。再接続します…");
      if (okxPingTimer) clearInterval(okxPingTimer);
      scheduleReconnect();
    });

    socket.addEventListener("error", () => {});
  }

  function scheduleReconnect() {
    setTimeout(connect, okxReconnectDelay);
    okxReconnectDelay = Math.min(okxReconnectDelay * 1.5, 30000);
  }

  if (okxWatchdogTimer) clearInterval(okxWatchdogTimer);
  okxWatchdogTimer = setInterval(() => {
    if (Date.now() - okxLastDataAt > DATA_TIMEOUT_MS) {
      console.log("[OKX WebSocket] 無応答を検知。強制再接続します…");
      okxIntentionalClose = true;
      if (okxPingTimer) clearInterval(okxPingTimer);
      try { okxSocket?.close(); } catch (e) {}
      okxLastDataAt = Date.now();
      connect();
    }
  }, 15000);

  connect();
}

// ============ Bybitのリアルタイム価格ストリーム ============
let bybitSocket = null;
let bybitReconnectDelay = 1000;
let bybitLastDataAt = Date.now();
let bybitWatchdogTimer = null;
let bybitPingTimer = null;
let bybitIntentionalClose = false;

export function startBybitFeed(onTick) {
  function connect() {
    let socket;
    try {
      socket = new WebSocket(BYBIT_WS_URL);
      bybitSocket = socket;
    } catch (e) {
      console.log(`[診断] Bybit WebSocket接続失敗: ${e.message}`);
      scheduleReconnect();
      return;
    }

    socket.addEventListener("open", () => {
      bybitReconnectDelay = 1000;
      bybitLastDataAt = Date.now();
      const args = Object.keys(BYBIT_INSTRUMENTS).map((s) => `tickers.${s}`);
      socket.send(JSON.stringify({ op: "subscribe", args }));
      console.log("[Bybit WebSocket] 接続完了・購読開始");

      if (bybitPingTimer) clearInterval(bybitPingTimer);
      bybitPingTimer = setInterval(() => {
        if (bybitSocket?.readyState === 1) bybitSocket.send(JSON.stringify({ op: "ping" }));
      }, 20000);
    });

    socket.addEventListener("message", (event) => {
      bybitLastDataAt = Date.now();
      try {
        const msg = JSON.parse(event.data);
        if (msg.op === "pong" || msg.op === "ping" || msg.success !== undefined) return;
        const symbol = msg.data?.symbol;
        const asset = BYBIT_INSTRUMENTS[symbol];
        const price = parseFloat(msg.data?.lastPrice);
        if (!asset || !isFinite(price)) return;
        onTick(asset, price, Date.now());
      } catch (e) {}
    });

    socket.addEventListener("close", () => {
      if (bybitIntentionalClose) {
        bybitIntentionalClose = false;
        return;
      }
      console.log("[Bybit WebSocket] 切断。再接続します…");
      if (bybitPingTimer) clearInterval(bybitPingTimer);
      scheduleReconnect();
    });

    socket.addEventListener("error", () => {});
  }

  function scheduleReconnect() {
    setTimeout(connect, bybitReconnectDelay);
    bybitReconnectDelay = Math.min(bybitReconnectDelay * 1.5, 30000);
  }

  if (bybitWatchdogTimer) clearInterval(bybitWatchdogTimer);
  bybitWatchdogTimer = setInterval(() => {
    if (Date.now() - bybitLastDataAt > DATA_TIMEOUT_MS) {
      console.log("[Bybit WebSocket] 無応答を検知。強制再接続します…");
      bybitIntentionalClose = true;
      if (bybitPingTimer) clearInterval(bybitPingTimer);
      try { bybitSocket?.close(); } catch (e) {}
      bybitLastDataAt = Date.now();
      connect();
    }
  }, 15000);

  connect();
}

// ============ Polymarketのリアルタイム価格ストリーム ============
let polySocket = null;
let polyReconnectDelay = 1000;
let currentSubscribedTokens = [];
let polyOnUpdateCallback = null;
let polyOnBookCallback = null;
let polyLastDataAt = Date.now();
let polyPingTimer = null;
let polyWatchdogTimer = null;
let polyIntentionalClose = false;

function sendPolySubscription() {
  if (!polySocket || polySocket.readyState !== 1) return;
  if (currentSubscribedTokens.length === 0) return;
  polySocket.send(JSON.stringify({ assets_ids: currentSubscribedTokens, type: "market", custom_feature_enabled: true }));
}

export function startPolymarketFeed(onUpdate, onBook) {
  polyOnUpdateCallback = onUpdate;
  polyOnBookCallback = onBook;

  function connect() {
    let socket;
    try {
      socket = new WebSocket(POLYMARKET_WS_URL);
      polySocket = socket;
    } catch (e) {
      console.log(`[診断] Polymarket WebSocket接続失敗: ${e.message}`);
      scheduleReconnect();
      return;
    }

    socket.addEventListener("open", () => {
      polyReconnectDelay = 1000;
      polyLastDataAt = Date.now();
      console.log("[Polymarket WebSocket] 接続完了");
      sendPolySubscription();

      if (polyPingTimer) clearInterval(polyPingTimer);
      polyPingTimer = setInterval(() => {
        if (polySocket?.readyState === 1) polySocket.send("PING");
      }, 10000);
    });

    socket.addEventListener("message", (event) => {
      polyLastDataAt = Date.now();
      if (event.data === "PONG" || event.data === "pong") return;
      try {
        const messages = JSON.parse(event.data);
        const arr = Array.isArray(messages) ? messages : [messages];
        for (const msg of arr) {
          if (msg.event_type === "price_change" || msg.event_type === "last_trade_price") {
            const tokenId = msg.asset_id;
            const price = parseFloat(msg.price ?? msg.last_trade_price);
            if (tokenId && isFinite(price) && polyOnUpdateCallback) {
              polyOnUpdateCallback(tokenId, price, Date.now());
            }
          }
          if (msg.event_type === "book" && polyOnBookCallback) {
            const tokenId = msg.asset_id;
            const bestBid = msg.bids?.length ? parseFloat(msg.bids[msg.bids.length - 1].price) : null;
            const bestAsk = msg.asks?.length ? parseFloat(msg.asks[msg.asks.length - 1].price) : null;
            if (tokenId) polyOnBookCallback(tokenId, bestBid, bestAsk);
          }
          if (msg.event_type === "best_bid_ask" && polyOnBookCallback) {
            const tokenId = msg.asset_id;
            const bestBid = msg.best_bid !== undefined ? parseFloat(msg.best_bid) : null;
            const bestAsk = msg.best_ask !== undefined ? parseFloat(msg.best_ask) : null;
            if (tokenId) polyOnBookCallback(tokenId, bestBid, bestAsk);
          }
        }
      } catch (e) {}
    });

    socket.addEventListener("close", () => {
      if (polyIntentionalClose) {
        polyIntentionalClose = false;
        return;
      }
      console.log("[Polymarket WebSocket] 切断。再接続します…");
      if (polyPingTimer) clearInterval(polyPingTimer);
      scheduleReconnect();
    });

    socket.addEventListener("error", () => {});
  }

  function scheduleReconnect() {
    setTimeout(connect, polyReconnectDelay);
    polyReconnectDelay = Math.min(polyReconnectDelay * 1.5, 30000);
  }

  if (polyWatchdogTimer) clearInterval(polyWatchdogTimer);
  polyWatchdogTimer = setInterval(() => {
    if (Date.now() - polyLastDataAt > DATA_TIMEOUT_MS) {
      console.log("[Polymarket WebSocket] 無応答を検知。強制再接続します…");
      polyIntentionalClose = true;
      if (polyPingTimer) clearInterval(polyPingTimer);
      try { polySocket?.close(); } catch (e) {}
      polyLastDataAt = Date.now();
      connect();
    }
  }, 15000);

  connect();
}

export function updatePolymarketSubscription(tokenIds) {
  const unique = [...new Set(tokenIds)].filter(Boolean);
  const changed = JSON.stringify(unique.sort()) !== JSON.stringify([...currentSubscribedTokens].sort());
  if (!changed) return;
  currentSubscribedTokens = unique;
  sendPolySubscription();
}
