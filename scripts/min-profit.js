// scripts/min-profit.js
//
// **チェーンごとの最低利益。**
//
// [なぜチェーンごとに分けるか(2026年9月21日、実測 + オーナー了承)]
// 今までは全チェーン一律 $0.01 だった。しかし**ガス代がチェーンで25倍違う**。
//
//   polygon   ガス中央 $0.0123 / 粗利中央 $0.0123 → **ガスが粗利をちょうど食い切る**
//   avalanche ガス中央 $0.0004 / 粗利中央 $0.0008 → **純利はプラス**なのに $0.01 で捨てていた
//
// 30分で avalanche の115件が「純利プラスだが$0.01未満」で見送られていた。
// 一律の下限は、ガスの安いチェーンほど理不尽に厳しくなる。
//
// [いくらにするか — 損益分岐から決める]
// 送って負ける(他者に先を越される)と、失うのは**ガス代**。だから
//
//   損益分岐の勝率 = ガス代 ÷ (最低利益 + ガス代)
//
// avalanche でガス$0.0004、最低利益$0.001 なら **28.6%**。
// 実測の勝率は 成功3 / 先越され2 = **60%** なので、余裕がある。
// polygon はガスが粗利と同じなので**下げない**($0.01のまま)。
//
// [見積もりは楽観しない]
// 「115件 × $0.0004 = 1日$2.4」は**先越されとチェーン上の却下を無視した数字**で、
// 実際はもっと小さい。$0.001 を超えるのは115件の一部(最良でも$0.0017)。
// **効果は実測で確かめる**(生存ログの `低ハードル[…]`)。
//
// [環境変数]
//   MIN_PROFIT_USD           … 全チェーンの既定(未設定なら 0.01)
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

/// 「下限を下げたおかげで取れた」を数えるための境目。
/// 昔の一律の下限。これを下回る利益で成立したものが、今回の変更の成果。
export const LEGACY_FLOOR_USD = 0.01;

/// 起動ログと画面用の説明。
export function describeMinProfit() {
  const parts = [`既定$${DEFAULT_MIN_PROFIT_USD}`];
  for (const [chain, usd] of BY_CHAIN) parts.push(`${chain}$${usd}`);
  return parts.join(" / ");
}
