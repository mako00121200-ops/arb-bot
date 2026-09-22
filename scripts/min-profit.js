// scripts/min-profit.js
//
// **最低利益は「手数料負けするなら見送る」だけ。**
//
// [オーナーの決定(2026年9月21日)]
// 「全ての最低利益を0.00001にして、手数料負けするなら見送る様にすれば解決する気がします」
// → 裁定も清算も、**手で決めた下限をやめる**。
//
// `netProfitUsd` は**すでにガス代を引いた値**なので、
// 「0.00001 を超えていれば送る」= **「粗利がガス代を上回っていれば送る」**。
// これがそのまま「手数料負けするなら見送る」になる。
//
// [私が出した懸念と、オーナーの判断]
// 他者に先を越されて取り消された時も、ガス代はほぼ満額かかる
// (コントラクトが全部の段を回した後に取り消すため)。
// そのため「ガス代 × (1−勝率) ÷ 勝率」を上乗せする案を出したが、
// **オーナーの判断で上乗せはしない**(先越されのガス代は許容する)。
//
// **ただし、効いているかは測る。** 下の `送信の収支` がその数字:
//
//   収支 = 成立した取引で手元に残った額 − 先を越されて失ったガス代
//
// これがマイナスのまま増え続けるなら、上乗せの話をもう一度する材料になる。
//
// [環境変数]
//   MIN_PROFIT_USD          … 絶対の下限(既定 0.00001)
//   MIN_PROFIT_STATE_FILE   … 送信の収支の保存先

import fs from "fs";
import path from "path";

/// **手数料負けの線。** これを超える(= 粗利がガス代を上回る)なら送る。
const ABSOLUTE_MIN_PROFIT_USD = parseFloat(process.env.MIN_PROFIT_USD || "0.00001");

/// 実測を覚えておく上限。超えたら半分にして古い実測の影響を薄める。
const MAX_SAMPLES = 400;

const STATE_FILE = process.env.MIN_PROFIT_STATE_FILE
  || (process.env.POOL_MAP_FILE
      ? path.join(path.dirname(process.env.POOL_MAP_FILE), "send-outcomes.json")
      : "/tmp/send-outcomes.json");

/// チェーン -> { wins, losses, gainedUsd, lostGasUsd }
const outcomes = new Map();

function blank() { return { wins: 0, losses: 0, gainedUsd: 0, lostGasUsd: 0 }; }

function load() {
  try {
    if (!fs.existsSync(STATE_FILE)) return;
    const raw = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
    for (const [chain, v] of Object.entries(raw.chains || {})) {
      const e = blank();
      for (const k of Object.keys(e)) {
        const n = Number(v[k]);
        if (Number.isFinite(n)) e[k] = n;
      }
      outcomes.set(chain, e);
    }
  } catch (e) {
    console.warn(`[送信の収支] 読めません: ${(e.message || "").slice(0, 80)}`);
  }
}
load();

function save() {
  try {
    const chains = {};
    for (const [chain, v] of outcomes) chains[chain] = v;
    fs.writeFileSync(STATE_FILE, JSON.stringify({ chains, savedAt: new Date().toISOString() }));
  } catch (e) {}
}

/// **そのチェーンで送信してよい最低の純利益。**
/// 純利益はガス代を引いた後の値なので、これは「手数料負けしないこと」そのもの。
export function minProfitUsd() { return ABSOLUTE_MIN_PROFIT_USD; }

/// ふるい(価格表を作るかを決める段)の下限。**実行側と同じ。**
/// ここを実行側と揃え忘れると、ふるいで捨てられた経路は価格表が作られず
/// **永久に正確な判定を受けられない**(2026年9月20日に Optimism で経験済み)。
export function screenMinProfitUsd() { return ABSOLUTE_MIN_PROFIT_USD; }

/// 送信の結果を1件記録する。**これが「効いているか」の唯一の証拠。**
/// @param won   true = 成立 / false = 先を越されて取り消された
/// @param usd   成立なら手元に残った純利益、負けなら失ったガス代(どちらも正の数)
export function noteSendOutcome(chain, won, usd = 0) {
  const key = (chain || "").toLowerCase();
  if (!key) return;
  const v = outcomes.get(key) || blank();
  const amount = Number.isFinite(Number(usd)) ? Math.abs(Number(usd)) : 0;
  if (won) { v.wins++; v.gainedUsd += amount; }
  else { v.losses++; v.lostGasUsd += amount; }
  // 件数も金額も半分にする(比率と収支の向きは保たれる)。
  if (v.wins + v.losses > MAX_SAMPLES) {
    for (const k of ["wins", "losses", "gainedUsd", "lostGasUsd"]) v[k] = v[k] / 2;
    v.wins = Math.round(v.wins);
    v.losses = Math.round(v.losses);
  }
  outcomes.set(key, v);
  save();
}

/// **優先手数料を積んでよい上限(純利益に対する割合)を、実測から出す。**
///
/// [なぜ要るか(2026年9月22日)]
/// `PRIORITY_FEE_SHARE` は全チェーン一律 0.30 で入れた。だが積んでよい額には
/// **チェーンごとに天井がある**。入札で取り返せるのは「今負けている分」だけで、
/// それを超えて払えば、勝率がいくら上がっても差し引きで損をする。
///
///   入札で取り返せる最大値 = (1 − 勝率) × (平均利益 + 平均ガス代)   … 勝率が100%になった場合
///   入札にかかる費用       = 勝率 × share × 平均利益
///
/// 等号で解くと **share = (1 − 勝率) × (平均利益 + 平均ガス代) ÷ 平均利益**。
/// これが損益分岐で、**ここに等しく払うと儲けはゼロ**。だから実際に使うときは
/// この半分以下に留める。
///
/// [この3つの値は、すでにこのファイルが保存している]
/// wins / losses / gainedUsd / lostGasUsd。**測っているのに使っていなかった。**
/// 今は数字を出すだけで、入札額はまだ変えていない(オーナーの判断待ち)。
///
/// @returns { share, wins, losses, avgGainUsd, avgGasUsd } / 勝ちが無ければ null
export function breakEvenPriorityShare(chain) {
  const v = outcomes.get((chain || "").toLowerCase());
  if (!v || v.wins <= 0 || v.losses <= 0) return null;
  const avgGainUsd = v.gainedUsd / v.wins;
  const avgGasUsd = v.lostGasUsd / v.losses;
  if (!(avgGainUsd > 0)) return null;
  const winRate = v.wins / (v.wins + v.losses);
  const share = ((1 - winRate) * (avgGainUsd + avgGasUsd)) / avgGainUsd;
  return { share, wins: v.wins, losses: v.losses, avgGainUsd, avgGasUsd };
}

/// 生存ログ用。**チェーンごとの実際の収支。**
/// 「取った額 − 先越されで失ったガス代」がプラスかどうかが全て。
///
/// [得/損を分けて出す理由(2026年9月22日)]
/// 差額しか出していなかったので、**平均利益も平均ガス代も読み取れなかった**。
/// この2つが無いと上の `breakEvenPriorityShare` が手計算できず、
/// 「優先手数料をいくら積むべきか」を推定でしか語れない。
export function formatSendBalanceLine() {
  if (outcomes.size === 0) return "";
  const parts = [];
  for (const [chain, v] of outcomes) {
    const net = v.gainedUsd - v.lostGasUsd;
    let s = `${chain} 勝${v.wins}/負${v.losses} ${net >= 0 ? "+" : "-"}$${Math.abs(net).toFixed(4)}`;
    s += `(得$${v.gainedUsd.toFixed(4)}/損$${v.lostGasUsd.toFixed(4)}`;
    const be = breakEvenPriorityShare(chain);
    if (be) s += ` 1回 得$${be.avgGainUsd.toFixed(5)}/損$${be.avgGasUsd.toFixed(5)} 入札上限${be.share.toFixed(2)}`;
    s += ")";
    parts.push(s);
  }
  return ` 送信の収支[${parts.join(" ")}]`;
}

/// 起動ログ用。
export function describeMinProfit() {
  return `$${ABSOLUTE_MIN_PROFIT_USD}(手数料負けするなら見送る)`;
}

/// 画面・診断用。
export function getSendBalanceStats() {
  const out = {};
  for (const [chain, v] of outcomes) out[chain] = { ...v, netUsd: v.gainedUsd - v.lostGasUsd };
  return out;
}
