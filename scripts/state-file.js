// scripts/state-file.js
//
// **再デプロイで計測が消えないようにする、共通の保存先。**
//
// [なぜ要るか(2026年9月22日、オーナーの提案)]
// 1日に4回デプロイした結果、UniswapX の計測と大物の台帳が**毎回ゼロに戻っていた**。
// 「1時間測っても有効な数字が出ない」の原因の一つがこれだった。
// プール地図・送信の収支・清算の名簿は元から保存されていて無事だったが、
// **あとから足した計測だけが、メモリの上にしか無かった**。
//
// [置き場所]
// Railway のボリューム(`POOL_MAP_FILE` と同じディレクトリ)。`/tmp` は再デプロイで消える。
// 既存の保存(send-outcomes.json 等)と同じ決め方に合わせてある。
//
// [壊れたファイルで起動を止めない]
// 読めなければ「無かったこと」にして空から始める。**計測のために本体を止めない。**

import fs from "fs";
import path from "path";

/// ボリューム上の保存先を決める。`POOL_MAP_FILE` が無ければ /tmp(消えるが動く)。
export function stateFilePath(name) {
  const dir = process.env.POOL_MAP_FILE ? path.dirname(process.env.POOL_MAP_FILE) : "/tmp";
  return path.join(dir, name);
}

/// 読み込む。無い・壊れている・版が違う → null(呼ぶ側は空から始める)。
///
/// @param version 形を変えた時に上げる番号。**違えば読まない。**
///   (古い形を新しいコードで読むと、静かに変な値が入る)
export function loadState(name, version) {
  const file = stateFilePath(name);
  try {
    if (!fs.existsSync(file)) return null;
    const raw = JSON.parse(fs.readFileSync(file, "utf8"));
    if (raw?.version !== version) {
      console.log(`[保存] ${name}: 形が変わったので読み飛ばします(保存${raw?.version} ≠ 今${version})`);
      return null;
    }
    return raw.data ?? null;
  } catch (e) {
    console.warn(`[保存] ${name}: 読めません(空から始めます) ${(e.message || "").slice(0, 80)}`);
    return null;
  }
}

/// 書き出す。**途中で落ちても壊れないように、別名で書いてから置き換える。**
/// (そのまま上書きすると、書いている最中の再起動で中身が半分のファイルが残る)
export function saveState(name, version, data) {
  const file = stateFilePath(name);
  const tmp = `${file}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify({ version, savedAt: new Date().toISOString(), data }));
    fs.renameSync(tmp, file);
    return true;
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch (inner) {}
    return false; // 保存できなくても本体は止めない
  }
}

/// 書きすぎないための間引き。前回から minMs 経っていなければ書かない。
/// @returns 実際に書いたら true
export function saveStateThrottled(name, version, dataFn, minMs, lastSavedAt) {
  if (lastSavedAt != null && Date.now() - lastSavedAt < minMs) return false;
  return saveState(name, version, dataFn());
}
