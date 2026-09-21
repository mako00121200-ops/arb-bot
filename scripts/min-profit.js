// scripts/min-profit.js
//
// **「手数料負けするなら見送る」を、実測の勝率から自動で決める。**
//
// [オーナーの指示(2026年9月21日)]
// 「全ての最低利益を0.00001にして、手数料負けするなら見送る様にすれば解決する気がします」
//
// 方向は正しい。**手で数字を決めるのをやめる**のが本質。
// ただし、そのままだと1つ穴がある。
//
// [穴:負けた時もガス代は満額かかる]
// `netProfitUsd` は**すでにガス代を引いた値**なので、下限を 0.00001 にすると
// 「粗利がガス代をわずかでも上回れば送る」という意味になる。
// しかし**他者に先を越されて取り消された時も、ガス代はほぼ満額かかる**
// (コントラクトは全部の段を回した後に取り消すため)。
//
//   期待値 = 勝率 × 手元に残る利益 − (1−勝率) × ガス代
//
// polygon(ガス$0.0123)で下限$0.00001 なら、損益分岐の勝率は **99.9%**。
// 実測の勝率は60%なので、**送るほど損をする**。
//
// [正しい形:必要な利益をガス代と勝率から出す]
//
//   必要な最低利益 = ガス代 × (1 − 勝率) ÷ 勝率
//
// 勝率50%ならガス代と同額、勝率60%ならガス代の0.67倍、80%なら0.25倍。
// **これが「手数料負けするなら見送る」を、失敗時の手数料まで含めて正確にした式。**
// チェーンごとに勝率とガス代が違っても、式ひとつで自動的に合う。
// 手で $0.001 や $0.002 と決める必要がなくなる。
//
// [標本が少ないうちは慎重に]
// 勝率は実測(成功した送信 / 先を越された送信)から取る。まだ数件しかない時に
// 実測をそのまま使うと、たまたま3連勝しただけで下限が下がってしまう。
// 事前分布(勝2・負2 = 勝率50%)を足して、標本が増えるほど実測に寄せる。
// **最初は「勝率50% = 必要な利益はガス代と同額」から始まる。**
//
// [止まりっぱなしにしない]
// 負けが込むと必要な利益が際限なく上がり、そのチェーンで一度も送らなくなる。
// すると**新しい実測が取れず、二度と回復できない**(前にも同じ形の
// 「逆向きのラチェット」を2件作ってしまった)。
// 必要な利益はガス代の **4倍まで**で頭打ちにして、大きい機会は拾い続ける。
//
// [環境変数]
//   MIN_PROFIT_USD        … 絶対の下限(既定 0.00001)。普段は効かない。
//                           上の式がガス代から決めた値の方が必ず大きくなるため
//   MIN_PROFIT_GAS_MAX    … ガス代の何倍まで要求してよいか(既定 4)
//   MIN_PROFIT_STATE_FILE … 勝率の実測の保存先

import fs from "fs";
import path from "path";

/// 絶対の下限。**オーナーの指示で 0.00001。** 普段はガス代から決まる方が勝つ。
const ABSOLUTE_MIN_PROFIT_USD = parseFloat(process.env.MIN_PROFIT_USD || "0.00001");

/// 必要な利益の上限(ガス代の何倍まで)。**止まりっぱなしを防ぐための頭打ち。**
const MAX_GAS_MULTIPLE = parseFloat(process.env.MIN_PROFIT_GAS_MAX || "4");

/// 勝率の事前分布。標本が少ないうちは勝率50%(= 必要な利益はガス代と同額)から。
const PRIOR_WINS = 2;
const PRIOR_LOSSES = 2;

/// 実測を覚えておく上限。超えたら半分にして**古い実測の影響を薄める**
/// (相場も競争相手も変わるので、1か月前の勝率を同じ重さで使わない)。
const MAX_SAMPLES = 200;

const STATE_FILE = process.env.MIN_PROFIT_STATE_FILE
  || (process.env.POOL_MAP_FILE
      ? path.join(path.dirname(process.env.POOL_MAP_FILE), "send-outcomes.json")
      : "/tmp/send-outcomes.json");

/// チェーン -> { wins, losses }
const outcomes = new Map();

function load() {
  try {
    if (!fs.existsSync(STATE_FILE)) return;
    const raw = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
    for (const [chain, v] of Object.entries(raw.chains || {})) {
      const wins = Number(v.wins), losses = Number(v.losses);
      if (Number.isFinite(wins) && Number.isFinite(losses) && wins >= 0 && losses >= 0) {
        outcomes.set(chain, { wins, losses });
      }
    }
  } catch (e) {
    console.warn(`[最低利益] 勝率の実測を読めません: ${(e.message || "").slice(0, 80)}`);
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

/// 送信の結果を1件記録する。
/// @param won true = 成立 / false = 先を越されて取り消された(ガス代を失った)
export function noteSendOutcome(chain, won) {
  const key = (chain || "").toLowerCase();
  if (!key) return;
  const v = outcomes.get(key) || { wins: 0, losses: 0 };
  if (won) v.wins++; else v.losses++;
  // 古い実測の影響を薄める(件数を半分にする。比率は保たれる)。
  if (v.wins + v.losses > MAX_SAMPLES) {
    v.wins = Math.round(v.wins / 2);
    v.losses = Math.round(v.losses / 2);
  }
  outcomes.set(key, v);
  save();
}

/// そのチェーンで「送って成立する」割合(事前分布を含む)。
export function winRate(chain) {
  const v = outcomes.get((chain || "").toLowerCase()) || { wins: 0, losses: 0 };
  return (v.wins + PRIOR_WINS) / (v.wins + v.losses + PRIOR_WINS + PRIOR_LOSSES);
}

/// **そのガス代で送ってよい最低の純利益。**
///
/// 負けた時に失うガス代を、勝った時の利益で取り返せる水準。
/// ガス代が分からない時は絶対の下限だけを返す(判断材料が無いのに高くしない)。
export function requiredMinProfitUsd(chain, gasCostUsd) {
  const gas = Number(gasCostUsd);
  if (!Number.isFinite(gas) || gas <= 0) return ABSOLUTE_MIN_PROFIT_USD;
  const w = winRate(chain);
  const needed = gas * (1 - w) / w;
  const capped = Math.min(needed, gas * MAX_GAS_MULTIPLE);
  return Math.max(ABSOLUTE_MIN_PROFIT_USD, capped);
}

/// ふるい(価格表を作るかを決める段)の下限。**実行側と同じ規則を使う。**
///
/// ここを実行側と揃え忘れると、ふるいで捨てられた経路は価格表が作られず、
/// **永久に正確な判定を受けられない**
/// (2026年9月20日に Optimism で同じ取りこぼしを起こしている)。
export function screenMinProfitUsd(chain, gasCostUsd) {
  return requiredMinProfitUsd(chain, gasCostUsd);
}

/// 生存ログ用。チェーンごとの勝率と「ガス代の何倍を要求しているか」。
export function formatMinProfitLine() {
  if (outcomes.size === 0) return "";
  const parts = [];
  for (const [chain, v] of outcomes) {
    const w = winRate(chain);
    const mult = Math.min((1 - w) / w, MAX_GAS_MULTIPLE);
    parts.push(`${chain} 勝${v.wins}/負${v.losses}→ガス×${mult.toFixed(2)}`);
  }
  return ` 手数料負けの線[${parts.join(" ")}]`;
}

/// 起動ログ用。
export function describeMinProfit() {
  return `絶対$${ABSOLUTE_MIN_PROFIT_USD} + 実測の勝率からガス代×(1−勝率)÷勝率(上限ガス代×${MAX_GAS_MULTIPLE})`;
}

/// 画面・診断用。
export function getSendOutcomeStats() {
  const out = {};
  for (const [chain, v] of outcomes) {
    out[chain] = { ...v, winRate: winRate(chain) };
  }
  return out;
}
