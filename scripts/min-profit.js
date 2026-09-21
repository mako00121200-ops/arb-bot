// scripts/min-profit.js
//
// **チェーンごとの最低利益。**
//
// [なぜチェーンごとに分けるか(2026年9月21日、実測 + オーナー了承)]
// 今までは全チェーン一律だった(**本番は環境変数 MIN_PROFIT_USD=$0.002**)。
// しかし**ガス代がチェーンで25倍違う**。
//
//   polygon   ガス中央 $0.0123 / 粗利中央 $0.0123 → **ガスが粗利をちょうど食い切る**
//   avalanche ガス中央 $0.0004 / 粗利中央 $0.0008 → **純利はプラス**なのに捨てていた
//
// 30分で avalanche の115件が「純利プラスだが下限未満」で見送られていた
// (その帯の最良でも純利$0.0017)。
// 一律の下限は、**ガスの安いチェーンには厳しすぎ、高いチェーンには緩すぎる**。
//
// [いくらにするか — 損益分岐から決める]
// 送って負ける(他者に先を越される)と、失うのは**ガス代まるごと**
// (コントラクトは全部の段を回した後に取り消すので、ガスはほぼ満額かかる)。
//
//   損益分岐の勝率 = ガス代 ÷ (最低利益 + ガス代)
//   期待値がプラスになる最低利益 = ガス代 × (1 − 勝率) ÷ 勝率
//
// avalanche: ガス$0.0004 / 最低利益$0.001 → 損益分岐の勝率 **28.6%**。
// 実測の勝率は 成功3 / 先越され2 = 60% なので余裕がある。
//
// **polygon は逆に緩すぎる疑いがある。** ガス$0.0123 に対し下限$0.002 だと
// 損益分岐の勝率は **86%**。勝率60%なら1回あたり −$0.0037 の期待値になる。
// ただし勝率の実測は**まだ5件**しかない。標本を貯めてから判断する(勝手に変えない)。
//
// [見積もりは楽観しない]
// 「115件 × $0.0004 = 1日$2.4」は**先越されとチェーン上の却下を無視した数字**。
// 現実的には**1日$0.3〜0.6**。**効果は実測で確かめる**(生存ログの `低ハードル[…]`)。
//
// [環境変数]
//   MIN_PROFIT_USD           … 全チェーンの既定(コードの既定値は 0.01 だが**本番は 0.002**)
//   MIN_PROFIT_USD_BY_CHAIN  … "avalanche:0.001,optimism:0.005" の形で個別に上書き
//                              既定は "avalanche:0.001"

/// 全チェーンの既定。
const DEFAULT_MIN_PROFIT_USD = parseFloat(process.env.MIN_PROFIT_USD || "0.01");

/// チェーンごとの上書き。**ガスの安いチェーンだけ下げる。**
const BY_CHAIN_RAW = process.env.MIN_PROFIT_USD_BY_CHAIN ?? "avalanche:0.001";

function parseByChain(raw) {
  const out = new Map();
  for (const part of String(raw).split(",").map((v) => v.trim()).filter(Boolean)) {
    const [chain, value] = part.split(":").map((v) => (v || "").trim());
    const usd = parseFloat(value);
    // **上限も下限も決める。** 範囲外は書き間違いとみなして採用しない
    // (0を入れるとガス代割れの取引を延々と送ってしまう)。
    if (!chain || !Number.isFinite(usd) || usd < 0.0001 || usd > 10) {
      console.warn(`[最低利益] 設定を読めません: "${part}"(0.0001〜10 の範囲で指定してください)。無視します`);
      continue;
    }
    out.set(chain.toLowerCase(), usd);
  }
  return out;
}

const BY_CHAIN = parseByChain(BY_CHAIN_RAW);

/// そのチェーンで送信してよい最低の純利益(USD)。
export function minProfitUsd(chain) {
  return BY_CHAIN.get((chain || "").toLowerCase()) ?? DEFAULT_MIN_PROFIT_USD;
}

/// ふるい(価格表を作るかを決める段)の下限。
///
/// **ここを下げ忘れると、実行側を下げても何も変わらない。**
/// ふるいを通らなかった経路は価格表が作られず、**永久に正確な判定を受けられない**
/// (2026年9月20日に Optimism で同じ取りこぼしを起こしている)。
const SCREEN_OVERRIDE = process.env.SPOT_SCREEN_MIN_PROFIT_USD
  ? parseFloat(process.env.SPOT_SCREEN_MIN_PROFIT_USD)
  : null;

export function screenMinProfitUsd(chain) {
  if (SCREEN_OVERRIDE != null && Number.isFinite(SCREEN_OVERRIDE)) return SCREEN_OVERRIDE;
  return minProfitUsd(chain);
}

/// 「チェーン別にしたおかげで取れた」を数えるための境目。
///
/// [コードの既定値を実際の値だと思い込んでいた(2026年9月21日 21:34 JST)]
/// このファイルを書いた時、昔の下限を **$0.01(コードの既定値)** だと思って
/// 固定値で書いていた。しかし起動ログは
///   `[起動] 準備完了 / 取引上限$2000 / 最低利益[既定$0.002 / avalanche$0.001]`
/// で、**本番は環境変数 MIN_PROFIT_USD=$0.002** だった。
/// 固定の $0.01 と比べると、**元から通っていた $0.002〜$0.01 の取引まで
/// 「下げたおかげ」に数えてしまい、効果を大きく見せてしまう。**
///
/// 正しい境目は「そのチェーンだけ下げた分」。つまり**全チェーンの既定**と比べる。
export function defaultMinProfitUsd() { return DEFAULT_MIN_PROFIT_USD; }

/// その機会が「チェーン別に下げたからこそ送れた」ものか。
export function isBelowDefaultFloor(chain, netProfitUsd) {
  const floor = minProfitUsd(chain);
  if (!(floor < DEFAULT_MIN_PROFIT_USD)) return false;   // そのチェーンは下げていない
  return Number(netProfitUsd) < DEFAULT_MIN_PROFIT_USD;
}

/// 起動ログと画面用の説明。
export function describeMinProfit() {
  const parts = [`既定$${DEFAULT_MIN_PROFIT_USD}`];
  for (const [chain, usd] of BY_CHAIN) parts.push(`${chain}$${usd}`);
  return parts.join(" / ");
}
