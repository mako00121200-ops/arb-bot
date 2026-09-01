import fs from "fs";

/**
 * 紙上取引(ペーパートレード)エンジン
 * ------------------------------------------------------------
 * TWAPオラクル観測・論理矛盾チェッカーが「歪みがある」と判定した瞬間を、
 * 実際には注文を出さずに「もしここで賭けていたら」として記録する。
 * 市場が確定した後、実際の結果と突き合わせて勝率・利益(手数料控除後)を計算する。
 *
 * これにより、「本当に勝てる戦略か」を、資金をリスクに晒さずに検証できる。
 */

const FILE = process.env.PAPER_TRADE_FILE || "/tmp/paper-trades.json";

// Polymarketの想定コスト(手数料自体は0%だが、スプレッド・ガス代で実質的なコストが発生する)
const ASSUMED_ROUNDTRIP_COST_PCT = 0.02; // 2%(保守的な見積もり。スプレッド+ガス+スリッページ)

function load() {
  try {
    if (fs.existsSync(FILE)) return JSON.parse(fs.readFileSync(FILE, "utf8"));
  } catch (e) {}
  return { open: [], resolved: [] };
}
function save(data) {
  try {
    if (data.resolved.length > 500) data.resolved = data.resolved.slice(-500);
    fs.writeFileSync(FILE, JSON.stringify(data));
  } catch (e) { console.warn("紙上取引の保存失敗:", e.message); }
}

const state = load();

export function recordSignal(strategy, side, entryPrice, resolveAtMs, meta = {}) {
  const id = `${strategy}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  state.open.push({ id, strategy, side, entryPrice, resolveAtMs, meta, recordedAt: new Date().toISOString() });
  save(state);
  return id;
}

export async function resolveOpenPositions(resolver) {
  const now = Date.now();
  const stillOpen = [];
  for (const pos of state.open) {
    if (pos.resolveAtMs > now) { stillOpen.push(pos); continue; }
    try {
      const { outcome } = await resolver(pos);
      if (outcome === null) { stillOpen.push(pos); continue; }

      const won = outcome === pos.side;
      const grossPnl = won ? (1 - pos.entryPrice) : -pos.entryPrice;
      const cost = ASSUMED_ROUNDTRIP_COST_PCT;
      const netPnl = grossPnl - cost;

      state.resolved.push({ ...pos, outcome, won, grossPnl, netPnl, resolvedAt: new Date().toISOString() });
    } catch (e) {
      stillOpen.push(pos);
    }
  }
  state.open = stillOpen;
  save(state);
}

/**
 * Brierスコア: 予測確率と実際の結果の差を二乗して平均したもの。
 * 0に近いほど精度が高い。0.25=当てずっぽう、0.20=まずまず、0.12〜0.18=予測市場の集合知レベル。
 * 単純な勝率と違い、「どれだけ自信を持って正しく当てたか」を評価できる。
 *
 * 予測確率は meta.confidence(UP方向の確信度)を使い、実際にUPだったかで採点する。
 */
function calcBrierScore(rows) {
  const scored = rows.filter((r) => r.meta?.confidence !== undefined && r.meta?.confidence !== null);
  if (scored.length === 0) return null;
  const sum = scored.reduce((s, r) => {
    const predictedUp = r.side === "UP" ? r.meta.confidence : 1 - r.meta.confidence;
    const actualUp = r.outcome === "UP" ? 1 : 0;
    return s + (predictedUp - actualUp) ** 2;
  }, 0);
  return sum / scored.length;
}

/**
 * ズレの大きさ(edge)ごとに区分けして勝率を集計する。
 * 「ズレが大きいほど勝率も高い」という関係が実際に見えるかを確認するため。
 * もし見えなければ、推定ロジック自体を見直す必要がある。
 */
function calcBucketedStats(rows, keyFn, buckets) {
  const result = buckets.map((b) => ({ ...b, count: 0, wins: 0 }));
  for (const r of rows) {
    const val = keyFn(r);
    if (val === undefined || val === null) continue;
    const bucket = result.find((b) => val >= b.min && val < b.max);
    if (!bucket) continue;
    bucket.count++;
    if (r.won) bucket.wins++;
  }
  return result.map((b) => ({ ...b, winRate: b.count > 0 ? (b.wins / b.count) * 100 : null }));
}

const EDGE_BUCKETS = [
  { label: "5-10pt", min: 0.05, max: 0.10 },
  { label: "10-20pt", min: 0.10, max: 0.20 },
  { label: "20pt+", min: 0.20, max: Infinity },
];
const TIME_BUCKETS = [
  { label: "0-10秒", min: 0, max: 10 },
  { label: "10-30秒", min: 10, max: 30 },
  { label: "30秒+", min: 30, max: Infinity },
];

/** 戦略ごとの累積成績(勝率・純利益・Brierスコア・区分別勝率)を計算する */
export function getStats(strategy = null) {
  const rows = strategy ? state.resolved.filter((r) => r.strategy === strategy) : state.resolved;
  if (rows.length === 0) {
    return {
      count: 0, wins: 0, winRate: 0, totalNetPnl: 0, avgNetPnl: 0, avgEdgeAtEntry: null,
      brierScore: null, edgeBuckets: [], timeBuckets: [],
    };
  }
  const wins = rows.filter((r) => r.won).length;
  const totalNetPnl = rows.reduce((s, r) => s + r.netPnl, 0);
  const edges = rows.map((r) => r.meta?.edge).filter((e) => e !== undefined && e !== null);
  return {
    count: rows.length,
    wins,
    winRate: (wins / rows.length) * 100,
    totalNetPnl,
    avgNetPnl: totalNetPnl / rows.length,
    avgEdgeAtEntry: edges.length ? edges.reduce((s, e) => s + Math.abs(e), 0) / edges.length : null,
    brierScore: calcBrierScore(rows),
    edgeBuckets: calcBucketedStats(rows, (r) => Math.abs(r.meta?.edge), EDGE_BUCKETS),
    timeBuckets: calcBucketedStats(rows, (r) => r.meta?.remainingSecAtEntry, TIME_BUCKETS),
  };
}

export function getOpenCount() { return state.open.length; }
export function getRecentResolved(n = 20) { return state.resolved.slice(-n).reverse(); }
