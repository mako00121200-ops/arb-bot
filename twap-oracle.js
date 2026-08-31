/**
 * TWAPオラクル観測モジュール
 * ------------------------------------------------------------
 * Polymarketの5分/15分のBTC/ETH市場は、2026年8月7日から
 * 「瞬間価格」ではなく「終了直前30秒(5分市場)/60秒(15分市場)の
 * 平均価格(TWAP)」で決済される方式に変わった。
 *
 * これを踏まえ、単純な「価格が動いたか」ではなく、
 * 「残り時間内に平均が引っくり返る余地がどれだけあるか」を
 * 実際に計算し、市場の表示価格とズレがあれば記録する。
 *
 * 実際の注文は一切出さない(紙上取引での検証のみ)。
 */

const BINANCE_BASE = "https://api.binance.com";
const GAMMA_BASE = "https://gamma-api.polymarket.com";
const CLOB_BASE = "https://clob.polymarket.com";

const SYMBOLS = { BTC: "BTCUSDT", ETH: "ETHUSDT" };

const priceHistory = { BTC: [], ETH: [] };
const MAX_HISTORY_SEC = 20 * 60;

let sampleDiagCounter = 0;
export async function sampleBinancePrices() {
  const now = Date.now();
  sampleDiagCounter++;
  const shouldLog = sampleDiagCounter % 10 === 1;
  for (const [asset, symbol] of Object.entries(SYMBOLS)) {
    try {
      const res = await fetch(`${BINANCE_BASE}/api/v3/ticker/price?symbol=${symbol}`);
      if (!res.ok) {
        console.log(`[診断] Binance ${symbol}: HTTPエラー ${res.status} ${res.statusText}`);
        continue;
      }
      const json = await res.json();
      const price = parseFloat(json.price);
      if (!isFinite(price)) {
        console.log(`[診断] Binance ${symbol}: 価格が数値でない(${JSON.stringify(json)})`);
        continue;
      }
      priceHistory[asset].push({ t: now, p: price });
      if (shouldLog) console.log(`[診断] Binance ${symbol}: 取得成功 $${price}(累計${priceHistory[asset].length}件)`);
    } catch (e) {
      console.log(`[診断] Binance ${symbol}: 例外 ${e.message}`);
    }
  }
  const cutoff = now - MAX_HISTORY_SEC * 1000;
  for (const asset of Object.keys(priceHistory)) {
    priceHistory[asset] = priceHistory[asset].filter((s) => s.t >= cutoff);
  }
}
