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

export function getStats(strategy = null) {
  const rows = strategy ? state.resolved.filter((r) => r.strategy === strategy) : state.resolved;
  if (rows.length === 0) {
    return { count: 0, wins: 0, winRate: 0, totalNetPnl: 0, avgNetPnl: 0, avgEdgeAtEntry: null };
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
  };
}

export function getOpenCount() { return state.open.length; }
export function getRecentResolved(n = 20) { return state.resolved.slice(-n).reverse(); }
