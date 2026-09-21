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

const LINE_PUSH_URL = "https://api.line.me/v2/bot/message/push";

/// 同じ用件を送り直すまでの間隔。既定6時間。
const ALERT_COOLDOWN_MS = parseInt(process.env.ALERT_COOLDOWN_MS || String(6 * 60 * 60 * 1000), 10);
/// 1日に送る上限。無料枠(月200通)を守るための歯止め。
const ALERT_MAX_PER_DAY = parseInt(process.env.ALERT_MAX_PER_DAY || "10", 10);
/// 通知そのものを止めたい時に false にする。
const ALERT_ENABLED = process.env.ALERT_ENABLED !== "false";

const lastSentAt = new Map(); // key -> ms
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
export async function alertOwner(key, title, body) {
  if (!ALERT_ENABLED) return false;
  rollDayIfNeeded();

  // 送れる状態かに関わらず、まずログに残す(設定前でも見落とさないため)。
  console.warn(`[要判断] ${title} / ${body}`);

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
