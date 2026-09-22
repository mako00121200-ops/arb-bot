// scripts/solana-parse.js
//
// **DexScreener が返すペア情報を読む部分だけを切り出したもの。**
//
// [なぜ別ファイルか]
// uniswapx-parse.js と同じ理由。**外部が形を決めているデータ**はいちばん間違えやすく、
// 間違えると「放置された機会がある」と嘘をつく。ここは依存ゼロにして単体テストできるようにする。
// (solana-probe.js 側は fetch を持つので手元で気軽に試せない)

/// 数として読めるものだけ返す。読めなければ null(**0 で埋めない**)。
/// 0 で埋めると「流動性0のプール」と「流動性が不明なプール」が区別できなくなり、
/// ふるいが壊れる。
export function num(v) {
  if (v == null) return null;
  const n = typeof v === "number" ? v : parseFloat(String(v));
  return Number.isFinite(n) ? n : null;
}

/// 1件のペアから、必要な項目だけ取り出す。欠けていれば null(**数えない**)。
export function readPair(p) {
  const base = p?.baseToken?.address;
  const quote = p?.quoteToken?.address;
  const price = num(p?.priceUsd);
  const dexId = p?.dexId;
  if (!base || !quote || !dexId || !(price > 0)) return null;
  return {
    dexId: String(dexId),
    pairAddress: p?.pairAddress ? String(p.pairAddress) : null,
    base: String(base), quote: String(quote),
    baseSymbol: p?.baseToken?.symbol ? String(p.baseToken.symbol) : String(base).slice(0, 6),
    quoteSymbol: p?.quoteToken?.symbol ? String(p.quoteToken.symbol) : String(quote).slice(0, 6),
    priceUsd: price,
    // **価格差の計算にはこちらを使う**(2026年9月22日の初回計測で判明)。
    //
    // [なぜ priceUsd では駄目だったか]
    // 初回の計測で**対照群の SOL/USDC が 32.1bps** を示した。Solana でいちばん
    // 流動的なペアに32bpsが残るはずがなく、**測り方が壊れている**証拠だった
    // (この対照群はまさにそれを捕まえるために入れてあった)。
    // `priceUsd` は「base の quote建て価格 × quote の USD価格」で**導出**された値で、
    // プールごとに更新時刻も換算経路も違う。差の中に**古さと換算誤差が混ざる**。
    // `priceNative`(同じペア内の base/quote 比)なら USD換算が挟まらないので、
    // 同じ(base, quote)どうしの比較が**そのまま同じ土俵**になる。
    priceNative: num(p?.priceNative),
    // 流動性と出来高は「不明」を許す。呼ぶ側が足切りに使うので、
    // **不明を0扱いにすると本物を落とす**し、大きい扱いにすると幻を通す。
    liquidityUsd: num(p?.liquidity?.usd),
    volumeH24: num(p?.volume?.h24),
  };
}

/// DexScreener の応答からペアの配列を取り出す。
/// 版によって `{pairs:[...]}` だったり配列そのものだったりするので、両方受ける。
export function readPairs(body) {
  const list = Array.isArray(body) ? body : (Array.isArray(body?.pairs) ? body.pairs : null);
  if (!list) return [];
  const out = [];
  for (const p of list) {
    const r = readPair(p);
    if (r) out.push(r);
  }
  return out;
}

/// 同じ(base, quote)の組を、DEX ごとにまとめて価格差を出す。
///
/// [足切りの意味]
/// minLiquidityUsd … 薄い方のプールがこれ未満なら、価格差が見えても取れない
/// minVolumeH24    … **両方**に出来高が要る。片方が死んでいれば「価格が取り残されている」
///                   だけで、売り抜ける相手が居ない
///
/// @returns [{ key, baseSymbol, quoteSymbol, low, high, spreadBps, thinLiquidityUsd, volumeUsd }]
export function findSpreads(pairs, { minLiquidityUsd = 5000, minVolumeH24 = 1000 } = {}) {
  const groups = new Map();
  for (const p of pairs) {
    // 流動性・出来高が**不明なものは使わない**(推測しない)。
    if (p.liquidityUsd == null || p.volumeH24 == null) continue;
    if (p.liquidityUsd < minLiquidityUsd || p.volumeH24 < minVolumeH24) continue;
    // **priceNative が無いペアは比較に使えない**(USD建てで比べると導出誤差が混ざる)。
    if (!(p.priceNative > 0)) continue;
    const key = `${p.base}|${p.quote}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(p);
  }

  const out = [];
  for (const [key, list] of groups) {
    if (list.length < 2) continue; // 比べる相手が要る
    // **比較は priceNative(同じペア内の base/quote 比)で行う。** 理由は readPair の注記。
    let low = list[0], high = list[0];
    for (const p of list) {
      if (p.priceNative < low.priceNative) low = p;
      if (p.priceNative > high.priceNative) high = p;
    }
    if (low.dexId === high.dexId && low.pairAddress === high.pairAddress) continue;
    if (!(low.priceNative > 0)) continue;
    const spreadBps = ((high.priceNative - low.priceNative) / low.priceNative) * 10000;
    if (!(spreadBps > 0)) continue;
    out.push({
      key, baseSymbol: low.baseSymbol, quoteSymbol: low.quoteSymbol,
      low: { dexId: low.dexId, priceUsd: low.priceUsd },
      high: { dexId: high.dexId, priceUsd: high.priceUsd },
      spreadBps,
      // **取れる量を決めるのは薄い方。** 深い方を見ると幻になる。
      thinLiquidityUsd: Math.min(low.liquidityUsd, high.liquidityUsd),
      volumeUsd: Math.min(low.volumeH24, high.volumeH24),
    });
  }
  out.sort((a, b) => b.spreadBps - a.spreadBps);
  return out;
}
