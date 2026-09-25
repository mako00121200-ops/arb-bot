// scripts/chain-move-survey.js
//
// **一晩で大きく値が動いたチェーンを探す**(読み取りのみ・送信しない・お金は動かない)。
//
// [なぜ(2026年9月25日、オーナーの指示)]
// 9/25 06:29〜07:59 JST、avalanche で大きな値動きがあり、裁定が1.5時間で +$4.00(普段の20日分)を取った
// (docs/HANDOVER.md の最上段)。オーナーの考え:「この動きさえあれば、このボットは利益を取れる。
// 今のチェーン以外で一晩のうちに大きな動きのあったチェーンを精査し、そこを対象にしていけば日々の利益拡大を狙える」。
//
// [何を測るか] GeckoTerminal の公開 API(鍵不要)で、チェーンごとに
//   1. 取引量の多いプール上位20の 24時間取引量の合計と、流動性$10万以上のプールがある DEX の数(= 取引所が分かれているか)
//   2. 取引量上位3プールの1時間足(24本)から、1時間の値幅 (高値−安値)/始値 の最大と合計
//      → **値幅が大きく、DEX が多く分かれているチェーンほど、avalanche の夜と同じことが起きやすい**
//   3. 9/24 19:00〜23:00 UTC(avalanche の大きな動きがあった時間)の最大値幅も別に出す
// avalanche を物差しとして一緒に出す。
//
// 使い方: RUN_CHAIN_MOVE_SURVEY=true(終わったら空に戻す)

const BASE = "https://api.geckoterminal.com/api/v2";
const HEADERS = { Accept: "application/json;version=20230302" };
const PAUSE_MS = 2300; // 公開 API は毎分30回まで
const EVENT_FROM = Date.parse(process.env.CHAIN_MOVE_EVENT_FROM || "2026-09-24T19:00:00Z") / 1000;
const EVENT_TO = Date.parse(process.env.CHAIN_MOVE_EVENT_TO || "2026-09-24T23:00:00Z") / 1000;

/// 候補(GeckoTerminal の network id)。実在しない id は一覧と突き合わせて飛ばす。
/// 今の5チェーン(物差し)+ EVM で DEX が複数あるチェーン。
const CANDIDATES = [
  "avax", "polygon_pos", "arbitrum", "optimism", "base",
  "eth", "bsc", "sonic", "hyperevm", "unichain", "linea", "scroll", "mantle", "blast", "zksync",
  "celo", "xdai", "berachain", "sei-evm", "ink", "soneium", "cronos", "core", "abstract", "ftm",
  "moonbeam", "kava", "metis", "mode", "taiko", "flare", "plasma", "monad", "katana", "apechain",
  "world-chain", "zora-network", "bob-network", "fraxtal", "manta-pacific", "rootstock", "iotex", "telos",
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function get(path) {
  for (let i = 0; i < 3; i++) {
    try {
      const res = await fetch(`${BASE}${path}`, { headers: HEADERS });
      if (res.status === 429) { await sleep(15_000); continue; }
      if (!res.ok) return { error: `HTTP ${res.status}` };
      return await res.json();
    } catch (e) {
      if (i === 2) return { error: (e.message || "").slice(0, 60) };
      await sleep(3000);
    } finally {
      await sleep(PAUSE_MS);
    }
  }
  return { error: "429 が続いた" };
}

export function chainMoveSurveyEnabled() {
  return process.env.RUN_CHAIN_MOVE_SURVEY === "true";
}

/// 1時間足から値幅を計算する(テストしやすいよう純粋関数)。
/// @param ohlcv [[ts, o, h, l, c, v], ...]
export function rangeStats(ohlcv, from = EVENT_FROM, to = EVENT_TO) {
  let max = 0, sum = 0, eventMax = 0, n = 0;
  for (const [ts, o, h, l] of ohlcv || []) {
    const O = Number(o), H = Number(h), L = Number(l);
    if (!(O > 0) || !(H >= L)) continue;
    const r = (H - L) / O;
    max = Math.max(max, r); sum += r; n++;
    if (ts >= from && ts < to) eventMax = Math.max(eventMax, r);
  }
  return { max, sum, eventMax, n };
}

async function surveyNetwork(net) {
  const pools = await get(`/networks/${net}/pools?page=1`);
  if (pools.error || !Array.isArray(pools.data)) return { net, error: pools.error || "プールなし" };
  const list = pools.data.slice(0, 20).map((p) => ({
    address: p.attributes?.address,
    name: p.attributes?.name,
    dex: p.relationships?.dex?.data?.id,
    reserve: Number(p.attributes?.reserve_in_usd || 0),
    vol24: Number(p.attributes?.volume_usd?.h24 || 0),
    h24: Number(p.attributes?.price_change_percentage?.h24 || 0),
  }));
  const vol24 = list.reduce((s, p) => s + p.vol24, 0);
  const dexes = new Set(list.filter((p) => p.reserve >= 100_000).map((p) => p.dex));
  // 取引量上位3プールの1時間足
  const top = [...list].sort((a, b) => b.vol24 - a.vol24).slice(0, 3);
  let max = 0, sum = 0, eventMax = 0;
  const detail = [];
  for (const p of top) {
    const o = await get(`/networks/${net}/pools/${p.address}/ohlcv/hour?aggregate=1&limit=24`);
    const st = rangeStats(o?.data?.attributes?.ohlcv_list);
    max = Math.max(max, st.max); sum = Math.max(sum, st.sum); eventMax = Math.max(eventMax, st.eventMax);
    detail.push(`${p.name}(${p.dex}) 最大${(st.max * 100).toFixed(1)}%`);
  }
  return { net, vol24, dexCount: dexes.size, dexes: [...dexes].slice(0, 6), max, sum, eventMax, detail };
}

const pct = (x) => `${(x * 100).toFixed(1)}%`;
const usdM = (x) => `$${(x / 1e6).toFixed(1)}M`;

export async function runChainMoveSurvey() {
  if (!chainMoveSurveyEnabled()) return;
  const P = "[チェーン値動き調査]";
  console.log(`${P} 開始(読み取りのみ)。GeckoTerminal で ${CANDIDATES.length} チェーンの上位プールと1時間足を読みます`);
  // 実在する network id だけに絞る
  const known = new Set();
  for (let page = 1; page <= 10; page++) {
    const r = await get(`/networks?page=${page}`);
    if (r.error || !Array.isArray(r.data) || r.data.length === 0) break;
    for (const n of r.data) known.add(n.id);
  }
  const targets = known.size ? CANDIDATES.filter((c) => known.has(c)) : CANDIDATES;
  const missing = CANDIDATES.filter((c) => known.size && !known.has(c));
  if (missing.length) console.log(`${P} 一覧に無かった id(飛ばす): ${missing.join(", ")}`);
  const rows = [];
  for (const net of targets) {
    const r = await surveyNetwork(net);
    rows.push(r);
    if (r.error) console.log(`${P} ${net}: 読めない(${r.error})`);
    else console.log(`${P} ${net}: 24h取引量(上位20) ${usdM(r.vol24)} DEX${r.dexCount}個[${r.dexes.join(",")}] 1時間の値幅 最大${pct(r.max)}・24h合計${pct(r.sum)}・avalanche の夜(04:00〜08:00 JST)の最大${pct(r.eventMax)} | ${r.detail.join(" / ")}`);
  }
  const ok = rows.filter((r) => !r.error);
  const ref = ok.find((r) => r.net === "avax");
  // 並べ方: 値幅(24h合計)× DEX の数(分かれているほど価格差が残る)。取引量が極端に小さいものは下げる
  const score = (r) => r.sum * Math.min(r.dexCount, 6) * (r.vol24 >= 1e6 ? 1 : 0.3);
  ok.sort((a, b) => score(b) - score(a));
  console.log(`${P} 順位(値幅の24h合計 × DEXの数。物差し avalanche: 値幅合計${ref ? pct(ref.sum) : "?"}・DEX${ref?.dexCount ?? "?"}個・取引量${ref ? usdM(ref.vol24) : "?"}):`);
  ok.slice(0, 15).forEach((r, i) => console.log(`${P}  ${i + 1}. ${r.net} 値幅合計${pct(r.sum)} 最大${pct(r.max)} 夜の最大${pct(r.eventMax)} DEX${r.dexCount} 取引量${usdM(r.vol24)}${["avax", "polygon_pos", "arbitrum", "optimism", "base"].includes(r.net) ? "(稼働中)" : ""}`));
  console.log(`${P} 終了。RUN_CHAIN_MOVE_SURVEY を空に戻してください`);
}
