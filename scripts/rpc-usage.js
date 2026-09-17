// scripts/rpc-usage.js
//
// RPCの月間使用量を数えて、枠の残りを把握する。
//
// [なぜ必要か]
// Chainstack Growth は月2,000万リクエストで、Extra usage をオフにしている
// ため、超えるとRPCが止まる = botも止まる。監視する銘柄やDEXを増やすと
// 使用量は増えるので、「あとどれだけ増やせるか」を知らずに広げるのは危ない。
//
// [数える対象: 2種類ある]
//   ① RPC呼び出し … callWithRpc を通る全て(onchain-reserves.js が計上)。
//      Multicall3で束ねた場合は、束ねた1回が1リクエスト。
//   ② WebSocketの受信イベント … 購読で届くログ1件ごとに課金される
//      (dex-onchain-realtime.js の冒頭にある通り、全件購読で月3,000〜5,000万件)。
// ②を数え落とすと実態と大きくずれるため、両方を足して月間合計とする。
//
// [プロセスの再起動をまたぐ]
// onchain-reserves.js と dex-onchain-realtime.js のカウンタはプロセス内の
// 通算で、再起動でゼロに戻る。ここでは前回見た値との差分を足し込み、
// ファイルに保存することで、再起動をまたいだ月間の累計にする。
// 再起動でカウンタがゼロに戻ると差分が負になるため、その場合は
// 「新しいプロセスが始まった」とみなして現在値をそのまま足す。
//
// [月が変わったら0に戻す]
// Chainstackの枠は月単位なので、月が変わったら累計をリセットする。
// 区切りはUTC。請求の締めと厳密に一致しない可能性があるため、
// 目安として使い、正確な残量はChainstackの管理画面で確認する。

import fs from "fs";

const RPC_USAGE_FILE = process.env.RPC_USAGE_FILE || "/tmp/rpc-usage.json";
/// 月間のリクエスト上限(Chainstack Growth)。プランを変えたらここも変える。
const MONTHLY_QUOTA = parseInt(process.env.RPC_MONTHLY_QUOTA || "20000000", 10);

/// プロセス内カウンタの「前回見た値」。差分を取るために覚えておく。
let lastSeenCalls = 0;
let lastSeenEvents = 0;

function currentMonth() {
  return new Date().toISOString().slice(0, 7); // 例: "2026-09"
}

function load() {
  try {
    if (fs.existsSync(RPC_USAGE_FILE)) {
      const data = JSON.parse(fs.readFileSync(RPC_USAGE_FILE, "utf8"));
      if (data && typeof data.total === "number") return data;
    }
  } catch (e) {}
  return { month: currentMonth(), total: 0, calls: 0, events: 0, startedAt: new Date().toISOString() };
}

function save(data) {
  try {
    const tmp = RPC_USAGE_FILE + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(data));
    fs.renameSync(tmp, RPC_USAGE_FILE);
  } catch (e) {
    console.warn("[RPC使用量] 保存に失敗:", e.message);
  }
}

/// プロセス内カウンタの現在値を受け取り、前回との差分を月間累計に足す。
/// @param calls  RPC呼び出しの通算(getRpcCallTotals().total)
/// @param events WebSocket受信の通算(全チェーン合計)
/// @returns 月間の集計結果
export function updateRpcUsage(calls, events) {
  const data = load();
  const month = currentMonth();

  // 月が変わったら累計をリセットする。
  if (data.month !== month) {
    console.log(`[RPC使用量] 月が替わりました(${data.month} → ${month})。累計${data.total.toLocaleString()}件でリセットします`);
    data.month = month;
    data.total = 0;
    data.calls = 0;
    data.events = 0;
    data.startedAt = new Date().toISOString();
  }

  // 再起動でプロセス内カウンタがゼロに戻った場合は、差分ではなく現在値を足す。
  const dCalls = calls >= lastSeenCalls ? calls - lastSeenCalls : calls;
  const dEvents = events >= lastSeenEvents ? events - lastSeenEvents : events;
  lastSeenCalls = calls;
  lastSeenEvents = events;

  data.calls += dCalls;
  data.events += dEvents;
  data.total += dCalls + dEvents;
  data.updatedAt = new Date().toISOString();
  save(data);
  return summarize(data);
}

/// 月末の見込みを出すのに必要な最低の計測時間。
/// 計測を始めた直後は分母が小さく、毎分の速度が跳ね上がって
/// 「枠超過」の誤警報になるため、これを超えるまで見込みは出さない。
const MIN_MEASURE_MINUTES = 30;

function summarize(data) {
  const elapsedMs = Date.now() - new Date(data.startedAt).getTime();
  const elapsedMin = Math.max(1, elapsedMs / 60000);
  const perMinute = data.total / elapsedMin;
  const reliable = elapsedMin >= MIN_MEASURE_MINUTES;

  // 今月の残り日数から、このままの速度で使い切るかを見積もる。
  const now = new Date();
  const monthEnd = Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1);
  const remainingMin = Math.max(0, (monthEnd - now.getTime()) / 60000);
  const projected = data.total + perMinute * remainingMin;

  return {
    month: data.month,
    total: data.total,
    calls: data.calls,
    events: data.events,
    quota: MONTHLY_QUOTA,
    remaining: Math.max(0, MONTHLY_QUOTA - data.total),
    percent: (data.total / MONTHLY_QUOTA) * 100,
    perMinute,
    projected,
    projectedPercent: (projected / MONTHLY_QUOTA) * 100,
    // 見込みが信頼できるだけの時間を計測できたか。
    reliable,
    elapsedMin,
    // 計測はこのファイルが出来てからの分だけ。それ以前の使用は含まれない。
    measuredFrom: data.startedAt,
  };
}

/// 保存済みの集計を、カウンタを更新せずに読む(ダッシュボード表示用)。
export function getRpcUsageSummary() {
  return summarize(load());
}

/// 生存ログ用の1行。枠に対する位置づけが一目で分かる形にする。
export function formatRpcUsageLine(s) {
  const pct = s.percent.toFixed(2);
  const head = `枠[${s.total.toLocaleString()}/${s.quota.toLocaleString()} ${pct}% 内訳 呼${s.calls.toLocaleString()}+受${s.events.toLocaleString()}`;
  // 計測時間が短いうちは、毎分の速度も月末の見込みも当てにならない。
  if (!s.reliable) return `${head} 月末見込は計測中(あと${Math.ceil(MIN_MEASURE_MINUTES - s.elapsedMin)}分)]`;
  // このままの速度で今月末に枠を超える見込みなら警告を付ける。
  const warn = s.projectedPercent >= 100 ? " ※このままだと枠超過" : "";
  return `${head} 毎分${Math.round(s.perMinute)} 月末見込${s.projectedPercent.toFixed(0)}%${warn}]`;
}
