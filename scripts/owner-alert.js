// scripts/owner-alert.js
//
// オーナーの判断が要る時だけ LINE に通知する。
//
// [なぜ「判断が要る時だけ」なのか]
// 普段の失敗・機会ゼロ・静かな市況は、こちらで対処できるので通知しない。
// 通知が多いと読まれなくなり、本当に必要な1通が埋もれる。
// **オーナーが動かないと解決しないこと**だけを送る。
//
// [LINE Notify は使えない]
// LINE Notify は2025年3月31日に終了した。代わりに Messaging API の
// プッシュメッセージを使う。必要な環境変数は2つ:
//   LINE_CHANNEL_ACCESS_TOKEN … LINE Developers のチャネルアクセストークン
//   LINE_USER_ID              … 送り先(オーナー自身)のユーザーID
// どちらも秘密情報なので Railway の環境変数で管理する。
// 未設定なら何もしない(ログにだけ出す)ので、設定前でも安全に動く。
//
// [無料枠は月200通]
// 同じ用件を何度も送らないよう、用件ごとに冷却時間を置き、1日の上限も設ける。

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const LINE_PUSH_URL = "https://api.line.me/v2/bot/message/push";

/// 同じ用件を送り直すまでの間隔。既定6時間。
const ALERT_COOLDOWN_MS = parseInt(process.env.ALERT_COOLDOWN_MS || String(6 * 60 * 60 * 1000), 10);
/// 1日に送る上限。無料枠(月200通)を守るための歯止め。
const ALERT_MAX_PER_DAY = parseInt(process.env.ALERT_MAX_PER_DAY || "10", 10);
/// 通知そのものを止めたい時に false にする。
const ALERT_ENABLED = process.env.ALERT_ENABLED !== "false";

const lastSentAt = new Map(); // key -> ms
/// この起動中に一度ログへ出した質問の id(同じ文面を流し続けないため)。
const loggedQuestionIds = new Set();
let sentToday = 0;
let todayStamp = new Date().toISOString().slice(0, 10);
const stats = { sent: 0, skippedCooldown: 0, skippedCap: 0, errors: 0, lastError: null };

function isConfigured() {
  return !!(process.env.LINE_CHANNEL_ACCESS_TOKEN && process.env.LINE_USER_ID);
}

function rollDayIfNeeded() {
  const today = new Date().toISOString().slice(0, 10);
  if (today !== todayStamp) {
    todayStamp = today;
    sentToday = 0;
  }
}

/// オーナーの判断が要る用件を通知する。
///
/// @param key   用件の種類(冷却の単位)。例 "gas-balance:polygon"
/// @param title 1行の見出し。例 "ガス残高が足りません"
/// @param body  詳しい内容。何をすればよいかまで書く
/// @returns 送ったら true
export async function alertOwner(key, title, body, { quiet = false } = {}) {
  if (!ALERT_ENABLED) return false;
  rollDayIfNeeded();

  // 送れる状態かに関わらず、まずログに残す(設定前でも見落とさないため)。
  // quiet は「同じ文面を繰り返し流さない」ための指定(質問の再試行など)。
  if (!quiet) console.warn(`[要判断] ${title} / ${body}`);

  if (!isConfigured()) return false;

  const now = Date.now();
  const prev = lastSentAt.get(key) || 0;
  if (now - prev < ALERT_COOLDOWN_MS) {
    stats.skippedCooldown++;
    return false;
  }
  if (sentToday >= ALERT_MAX_PER_DAY) {
    stats.skippedCap++;
    return false;
  }

  const text = `⚠️ ${title}\n\n${body}\n\n(判断が必要な時だけ送っています)`;
  try {
    const res = await fetch(LINE_PUSH_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.LINE_CHANNEL_ACCESS_TOKEN}`,
      },
      body: JSON.stringify({
        to: process.env.LINE_USER_ID,
        messages: [{ type: "text", text: text.slice(0, 4900) }],
      }),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new Error(`${res.status} ${detail.slice(0, 120)}`);
    }
    lastSentAt.set(key, now);
    sentToday++;
    stats.sent++;
    console.log(`[要判断/通知] LINEに送りました: ${title}(本日${sentToday}通目)`);
    return true;
  } catch (e) {
    stats.errors++;
    stats.lastError = (e.message || "").slice(0, 120);
    console.warn(`[要判断/通知] LINEに送れませんでした: ${stats.lastError}`);
    return false;
  }
}

/// 画面と生存ログ用。
export function getAlertStats() {
  rollDayIfNeeded();
  return { ...stats, configured: isConfigured(), enabled: ALERT_ENABLED, sentToday };
}

// ===== Claude からの質問を転送する(2026年9月21日) =====
//
// [なぜこの形なのか]
// Claude の作業環境からは api.line.me に届かない(外向き通信が遮断されている)。
// Railway のアプリ用ドメインにも届かないので、HTTPで直接渡す経路も無い。
// そこで**リポジトリをメールボックスにする**。Claude が
// docs/owner-questions.json に書いてコミットすると、そのデプロイでこの bot に
// ファイルごと届き、ここが LINE へ転送する。
//
// 新しい秘密情報も外部サービスも増えない。質問がリポジトリに残るので、
// 後から経緯を追えるという利点もある。
//
// [一度送った質問は二度と送らない]
// 送信済みの id をボリュームに記録する。再デプロイのたびに送り直すと、
// 無料枠(月200通)をすぐ使い切り、何より読まれなくなる。

// 起動時の作業ディレクトリに依存しないよう、このファイルの位置から求める。
const QUESTIONS_FILE = process.env.OWNER_QUESTIONS_FILE
  || path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "docs", "owner-questions.json");
/// 送信済みの id の記録先。プール地図と同じ場所(ボリューム)に置く。
const SENT_FILE = process.env.OWNER_QUESTIONS_SENT_FILE
  || (process.env.POOL_MAP_FILE
      ? path.join(path.dirname(process.env.POOL_MAP_FILE), "owner-questions-sent.json")
      : "/tmp/owner-questions-sent.json");

function loadSentIds() {
  try {
    if (!fs.existsSync(SENT_FILE)) return new Set();
    const data = JSON.parse(fs.readFileSync(SENT_FILE, "utf8"));
    return new Set(Array.isArray(data.ids) ? data.ids : []);
  } catch (e) {
    return new Set();
  }
}

function saveSentIds(ids) {
  try {
    const tmp = SENT_FILE + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify({ ids: [...ids], updatedAt: new Date().toISOString() }));
    fs.renameSync(tmp, SENT_FILE);
  } catch (e) {
    console.warn(`[Claudeからの質問] 送信済みの記録に失敗: ${(e.message || "").slice(0, 80)}`);
  }
}

/// docs/owner-questions.json にある未送信の質問を LINE へ転送する。
/// 起動時と、念のため定期的に呼ぶ。
export async function sendPendingQuestions() {
  let parsed;
  try {
    if (!fs.existsSync(QUESTIONS_FILE)) return 0;
    parsed = JSON.parse(fs.readFileSync(QUESTIONS_FILE, "utf8"));
  } catch (e) {
    console.warn(`[Claudeからの質問] ファイルを読めません: ${(e.message || "").slice(0, 80)}`);
    return 0;
  }
  const list = Array.isArray(parsed?.questions) ? parsed.questions : [];
  if (list.length === 0) return 0;

  const sent = loadSentIds();
  let count = 0;
  for (const q of list) {
    const id = String(q?.id || "").trim();
    if (!id || sent.has(id)) continue;
    // **片付いた質問は送らない**(2026年9月21日に実際の不具合で判明)。
    //
    // Base の再デプロイの依頼を入れた直後に、オーナーが再デプロイしてくれた。
    // ところが LINE が未設定で「未送信」のままだったため、**解決済みの依頼が
    // 10分ごとに再試行され続けた**。このまま LINE を設定すれば、済んだことの
    // 依頼がいきなり届く。誤報は1通でも通知の信用を落とす。
    // 質問は経緯を残すために消さないので、片付いた印を付けて飛ばす。
    if (q?.resolved) continue;
    const title = String(q?.title || "Claudeからの質問").slice(0, 200);
    const body = String(q?.body || "").slice(0, 4000);

    // 用件ごとの冷却は使わない(id が違えば別の質問なので)。
    // 送れなかった場合は記録せず、次の機会に再試行する。
    // ただしログは1回だけにする(10分ごとに同じ文面が流れると、他が読めない)。
    const quiet = loggedQuestionIds.has(id);
    loggedQuestionIds.add(id);
    const ok = await alertOwner(`question:${id}`, `判断をお願いします: ${title}`, body, { quiet });
    if (ok) {
      sent.add(id);
      count++;
    } else if (!isConfigured()) {
      // LINE が未設定なら、何度も試しても意味がない。ログには alertOwner が出している。
      break;
    }
  }
  if (count > 0) saveSentIds(sent);
  return count;
}
