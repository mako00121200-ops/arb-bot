/**
 * 論理矛盾チェッカー
 * ------------------------------------------------------------
 * 「AがBを含むなら、Aの確率はBの確率以上のはず」といった、
 * 算数として成り立つべき関係が崩れているペアを検出する。
 *
 * 自動でこの関係を発見するのは(質問文の意味理解が必要なため)
 * 現実的でないので、関係が分かっているペアを手動で登録する方式にする。
 * 見つけた歪みは記録し、実際にどれくらいの頻度・大きさで、
 * どれくらいの時間で解消するかを観測する(取引はしない)。
 */

const GAMMA_BASE = "https://gamma-api.polymarket.com";

export const WATCHED_PAIRS = [
  // 例(実際のスラッグは都度確認して置き換える必要がある):
  // { label: "共和党 vs トランプ氏", slugA: "republican-wins-2028", slugB: "trump-wins-2028", relation: "A>=B" },
];

async function fetchMarketPrice(slug) {
  try {
    const res = await fetch(`${GAMMA_BASE}/markets?slug=${encodeURIComponent(slug)}`);
    if (!res.ok) return null;
    const arr = await res.json();
    const m = arr?.[0];
    if (!m) return null;
    const prices = m.outcomePrices ? JSON.parse(m.outcomePrices) : null;
    const yesPrice = prices ? parseFloat(prices[0]) : null;
    return { slug, question: m.question, yesPrice, volume: m.volume, closed: m.closed };
  } catch (e) {
    return null;
  }
}

export async function checkLogicalConstraints() {
  const results = [];
  for (const pair of WATCHED_PAIRS) {
    const [a, b] = await Promise.all([fetchMarketPrice(pair.slugA), fetchMarketPrice(pair.slugB)]);
    if (!a || !b || a.yesPrice === null || b.yesPrice === null) continue;
    if (a.closed || b.closed) continue;

    let violated = false;
    let magnitude = 0;
    if (pair.relation === "A>=B") {
      violated = a.yesPrice < b.yesPrice;
      magnitude = b.yesPrice - a.yesPrice;
    } else if (pair.relation === "A<=B") {
      violated = a.yesPrice > b.yesPrice;
      magnitude = a.yesPrice - b.yesPrice;
    }

    results.push({
      label: pair.label, relation: pair.relation,
      marketA: a, marketB: b, violated, magnitude,
      measuredAt: new Date().toISOString(),
    });
  }
  return results;
}

export async function searchCandidatePairs(keyword) {
  try {
    const res = await fetch(`${GAMMA_BASE}/markets?closed=false&limit=30&order=volume24hr&ascending=false&_q=${encodeURIComponent(keyword)}`);
    if (!res.ok) return [];
    const markets = await res.json();
    return markets.map((m) => ({ slug: m.slug, question: m.question, volume: m.volume }));
  } catch (e) {
    return [];
  }
}
