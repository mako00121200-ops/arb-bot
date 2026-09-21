// scripts/jst.js
//
// 画面とログに出す時刻を**日本時間**に揃えるための共通の道具。
//
// [なぜ要るか(2026年9月19日に一度やらかしている)]
// 記録簿の時刻を `toLocaleString('ja-JP')` で出していたが、これは
// **表示の書式だけ**を日本式にするもので、時刻そのものはコンテナの
// タイムゾーン(UTC)のままだった。日本式の書式で9時間ずれた時刻が出ていたため、
// かえって気づきにくかった。**時刻を読むのはオーナーだけなので日本時間に固定する。**
//
// [保存は UTC、表示は日本時間]
// ファイルに書く時刻(`new Date().toISOString()`)は UTC のままにする。
// 保存した値を後から別の場所で読んでも意味が変わらないため。
// **日本時間にするのは「人が読む瞬間」だけ。**
//
// [Railway のログについて]
// Railway が各行の頭に付ける時刻は UTC で、こちらからは変えられない。
// そのため、オーナーが時刻を読む必要のある行(生存ログ・清算の候補や送信)には、
// **行の中に日本時間を持たせる**。

/// 画面とログに出す時刻のタイムゾーン。
export const DISPLAY_TIMEZONE = process.env.DISPLAY_TIMEZONE || "Asia/Tokyo";

/// 表の見出しに出す表記。9時間ずれていても「日本式の書式」では気づけないため、必ず明示する。
export const TZ_LABEL = DISPLAY_TIMEZONE === "Asia/Tokyo" ? "日本時間" : DISPLAY_TIMEZONE;

/// 保存された時刻(ISO文字列や Date)を、画面に出す形(日本時間)に整える。
/// 桁を揃える(2桁固定)。列が狭いiPhoneでも折り返さないよう年は省く。
export function formatJst(value) {
  if (!value) return "-";
  const d = new Date(value);
  if (isNaN(d.getTime())) return "-";
  try {
    return d.toLocaleString("ja-JP", {
      timeZone: DISPLAY_TIMEZONE, hour12: false,
      month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit",
    });
  } catch (e) {
    // タイムゾーンのデータが無い環境では、UTCと明示して出す(黙ってずらさない)。
    return d.toISOString().replace("T", " ").slice(0, 19) + " UTC";
  }
}

/// いまの日本時間。「月/日 時:分:秒」。
export function nowJst() {
  return formatJst(new Date());
}
