# arb-bot 全体図(2026年9月21日時点の現状)

**このファイルは「いま何がどう動いているか」の地図。経緯は `HANDOVER.md`(時系列の記録)にある。**
**コードを直す前に、まずここを読む。** 直したら、ここも直す。

---

## 0. 一段落でいうと

5チェーン(base / optimism / arbitrum / polygon / avalanche)の DEX を監視し、**元手ゼロ**(フラッシュスワップ)で
価格差を取る裁定 bot。Railway で稼働、`main` へのマージで自動デプロイ。

**現状の実力(実測):裁定は1回 $0.005、1日 $0.25〜0.80。** 深いプールは価格差が0bps、浅いプールは
$1〜30しか吸えず、掛け算の答えが常に小さい(競争で価格差そのものが消える)。
**主軸は Aave 清算へ移す方針**(固定ボーナス5〜10%は競争で削れない。base の実測で $1,000超が1日2回)。
清算のコントラクト機能は**書いてあるが未配置**(§8)。

---

## 1. ファイル地図(整理後・2026年9月21日)

| ファイル | 役目 | 行数 |
|---|---|---|
| `index.js` | **中枢。** 起動・周期処理・機会の処理(`handleOpportunity`)・生存ログ・画面(HTTP) | 2,700 |
| `chain-config.js` | 5チェーンの設定(chainId / RPC / コントラクト住所の環境変数名 / explorer)。`ACTIVE_CHAINS` で絞る | 100 |
| `dex-onchain-realtime.js` | WebSocket で Sync/Swap/流動性のイベントを受ける。**住所を指定して購読**(800件ごとに分割)。Base は Flashblocks の押し出し購読 | 630 |
| `contracts/DexArbFlashLoan.sol` | コントラクト。`executeRoute` / `simulateRoute` / `quoteV3` / **`liquidateRoute` / `simulateLiquidate`(未配置)** | 580 |
| `scripts/pool-registry.js` | **プール地図(メモリ)。** 準備量・手数料・`feeProbed` / `feeFromChain` の印。保存/復元 | 560 |
| `scripts/opportunity-scanner.js` | **経路の計算。** 2段/3段の経路を組み、投入額を探索(`findBestAmount`)、粗利を出す。一時除外・惜しさの統計・答え合わせの記録 | 1,220 |
| `scripts/execute-opportunity.js` | **送信の直前から確定まで。** `simulateRoute`(eth_call)→ `estimateGas` → 送信 → 確定。段ごとの答え合わせ。取り消しのセレクタ照合 | 950 |
| `scripts/v3-pools.js` | V3(集中流動性)の価格表(quote table)。補間・信用できる上限(`trustedMax`)・公式Quoterとの検証 | 470 |
| `scripts/onchain-reserves.js` | RPC の窓口(`callWithRpc`、端点の切替、pending タグ)。手数料をスワップの記録から逆算 | 570 |
| `scripts/multicall-reserves.js` | Multicall3 で準備量・トークン情報をまとめて読む | 420 |
| `scripts/pool-fee-onchain.js` | **手数料をプールと工場から直接読む**(Solidly系の `getFee` 等を全部投げる) | 110 |
| `scripts/pool-scout.js` | **プールの発見。** 住所を指定しない `getLogs` で取引のある全プールを見て、上位を採用(6時間ごと)。**枠の歯止め**つき | 380 |
| `scripts/gas-cost.js` | ガス代の見積もり。実測との比(補正比)を学習・保存 | 380 |
| `scripts/trade-cap.js` | 投入額の上限(成功回数で $500→$1,000→$2,000) | 65 |
| `scripts/competitor-check.js` | 失敗した経路を後から見て「誰が取ったか」(他者の裁定/通常取引/誰も触らず)を判定 | 165 |
| `scripts/opportunity-journal.js` | 記録簿。24時間の集計(実際に得た利益 / 取れた可能性 / 幻) | 160 |
| `scripts/big-opportunities.js` | **大物の台帳。** $0.10以上の機会が「どこで捨てられたか」を全経路で記録 | 120 |
| `scripts/real-execution-log.js` | 実際に送った取引の記録 | 110 |
| `scripts/rpc-usage.js` | RPC の枠(月2,000万)の使用量と月末見込 | 150 |
| `scripts/incompatible-pools.js` | **永久に**外すプールの記録(税トークン・詐欺のみ。送信失敗は書かない) | 80 |
| `scripts/borrowable-tokens.js` | 経路の始点に使える通貨の判定(桁数と価格が揃っているか) | 105 |
| `scripts/aave-liquidation.js` | **Aave 清算の第1段(読み取りのみ)。** 名簿・健全度・実績・追跡。市場単位(フォーク対応) | 930 |
| `scripts/liquidation-monitor.js` | **Avalanche の Aave 清算の本体(第2段)。** 60日の名簿・HF の2段階監視・Chainlink 更新の即時再評価・清算する組の決定。**既定は DRY_RUN** | 640 |
| `scripts/liquidation-executor.js` | 清算の**実行**。担保を売る経路探し(地図 + ファクトリー)→ `simulateLiquidation`(eth_call)→ 送信。記録簿は裁定と共通 | 330 |
| `contracts/AaveLiquidator.sol` | **清算コントラクト(裁定とは別)。** `flashLoanSimple` → `liquidationCall` → DEX で売却 → 返済。`simulateLiquidation` | 300 |
| `scripts/liquidator-deploy.js` | 清算コントラクトの配置(`RUN_LIQUIDATOR_DEPLOY`) | 60 |
| `scripts/jst.js` | **画面とログの時刻を日本時間に揃える**(保存は UTC のまま)。`DISPLAY_TIMEZONE` | 50 |
| `scripts/owner-alert.js` | LINE 通知(未設定)。`docs/owner-questions.json` の転送 | 210 |
| `scripts/pool-survey.js` | 手動の調査ツール(`RUN_POOL_SURVEY`)。普段は動かない | 400 |
| `scripts/mainnet-deploy.js` / `compile-contract.js` | コントラクトの配置(`RUN_MAINNET_DEPLOY`)とコンパイル | 110 |

**2026年9月21日に削除したもの:** `verified-pairs.js`(一度も書き込まれないファイルを読むだけだった)、
`pool-discovery.js`(その死んだ種からしか呼ばれなかった)、および呼ばれていない書き出し関数19件。合計460行。

---

## 2. 1本の取引が通る道

```
[イベント] Sync / Swap を WebSocket で受信(dex-onchain-realtime)
    ↓ 地図の準備量を更新(pool-registry)
[経路計算] そのプールを含む2段・3段の経路を組み直す(opportunity-scanner.scanForChangedPool)
    ├ 一時除外中のプールを含む → 捨てる(飛ばした経路として数える)
    ├ V3を1段も含まない → 捨てる(V2だけの経路は判定しない)
    ├ 投入額を探索(findBestAmount。上限は 取引上限 と 価格表の信用できる範囲 の小さい方)
    └ 粗利プラスなら handleOpportunity へ
[handleOpportunity](index.js) — 捨てる道は7つ、**全て大物の台帳に記録される**
    ① 無効なプール(永久 or 一時)  ② 税トークン  ③ 冷却中  ④ 罠(利回り20%超)
    ⑤ 最低利益未満($0.01)         ⑥ 同じ経路を送信中  ⑦ 同じプールが使用中/同時送信の上限(3本)
    ↓
[executeOpportunity](execute-opportunity)
    1. simulateRoute(eth_call)と estimateGas を**同時に**投げる
       ├ 取り消しの中身が SimulationResult → returned/owed が分かる
       ├ K() 等 → 手数料の前提が低い → 手数料を直読み(pool-fee-onchain)し直す
       └ 赤字 → 段ごとの答え合わせ(公式Quoter と突き合わせ)→ 表の上限を学習 / 責任の判定
    2. 実測ガスで純利益を**確かめ直し**(下回れば送らない)
    3. 送信 → 確定待ち
       ├ 成立 → 記録簿・成功回数(取引上限が上がる)
       └ wait で取り消し = **他人に先を越された**(失敗には数えない)
```

**チェーン上の守り(最後の砦):** コントラクトが `returned >= owed + minProfit` を要求する。
ここを通らなければ取引ごと取り消され、失うのはガス代だけ。全段の受取量は残高の差で測る(税トークンでも壊れない)。

---

## 3. 起動の順序(`main()`)

1. HTTP 画面を起動
2. `RUN_MAINNET_DEPLOY` / `RUN_POOL_SURVEY` が設定されていればその作業(普段は無い)
3. 記録簿を読む → 生存ログ開始 → ガス代を取得
4. **WebSocket の購読開始**(`startOnchainFeeds`)
5. **プール地図の準備**(`preparePoolMap`: 保存から復元 → 各チェーンの準備量・桁数・価格)
6. コントラクトの版を確認(`checkContractVersions`。`simulateRoute` が返るかを実測)
7. optimism / base で pending(Flashblocks)の可否を実測
8. 周期処理を全て開始(§4)
9. Aave の Pool が応答するチェーンだけ清算の見張り開始
10. 10秒後に全経路のスキャン開始

---

## 4. 周期的な処理

| 処理 | 周期 | 何をするか |
|---|---|---|
| 生存ログ | 1分 | §6 の1行 |
| ガス代 | 1分 | 単価の取得、補正比の学習 |
| 手数料の実測(記録から) | 1秒 | 未実測のV2プールをスワップの記録から逆算 |
| **手数料の直読み** | 15秒・2件 | 記録から測れなかった/K()で拒否されたプールを工場に聞く |
| 古い準備量の更新 | 60秒 | しばらくイベントの無いプールを読み直す |
| V3 の状態更新 | 20秒 | |
| 価格表の作成 | 5秒 | **要求されたものだけ**作る(作り置きは停止) |
| **V3検証** | 2分・1プール | 公式Quoterと突き合わせ。**使っているプールを優先**。過大なら上限を下げる |
| トークン価格 | 5分 | |
| 保存(地図・価格表・補正比) | 定期 | ボリュームへ |
| 質問の転送 | 10分 | LINE 未設定なら何もしない |
| 清算の名簿と健全度 | 10分 | 60秒ごとに危ない人だけ再確認 |
| **プールの発見** | 6時間 | 取引のある全プールを見て、新しいペアの上位50を採用。枠70%超で停止 |
| コントラクト残高 | 10分 | |
| 全経路スキャン | 30秒 | |

---

## 5. 保存しているもの(ボリューム)

**全て `POOL_MAP_FILE` と同じディレクトリ。`/tmp` は再デプロイで消える(2026年9月21日に5箇所を移した)。**

| ファイル | 中身 | 消えると何が起きるか |
|---|---|---|
| `pool-map.json` | プール地図 | 地図を作り直す(数分) |
| `quote-tables.json` | V3 の価格表 | 要求されたものから作り直す |
| `gas-price-ratio.json` | ガス単価の補正比 | 補正なしに戻る(6時間で無効) |
| `execution-success-count.json` | 成功回数 | 取引上限が $500 に戻る |
| `incompatible-pools.json` | **永久に**外したプール(税・詐欺のみ) | 同じ失敗を1回ずつ学び直す |
| `opportunity-journal.jsonl` / `real-executions.json` | 記録簿 | 履歴が消える |
| `aave-borrowers.json` | 清算の名簿と実績 | 名簿を作り直す(数時間) |
| `owner-questions-sent.json` | 送信済みの質問の id | 同じ質問が再送される |
| `rpc-usage.json` | 枠の使用量 | 月末見込が測り直しになる |

---

## 6. 生存ログの読み方(1分ごと)

```
実行N/M        … 成立N件 / 失敗M件(このデプロイの通算)
内訳[…]        … 捨てた理由(無効/冷却/罠/下限/送信中/見送)
失敗段階[…]    … simulate / feeMismatch(K検算) / wait(先を越された) / estimateGas …
受信[…]        … WebSocket で届いたイベント数(**枠に課金される**)
先読み[…]      … Flashblocks の先行(base は押し出し、optimism は取得)
手数料N(残M 直読みK 読めずJ 学習I) … V2手数料の実測状況
枠[…毎分N 月末見込M%]  … RPC の枠。**受が7割**。70%で発見が自動停止
V3表[確認N 上限制限M(今K本) …] … 価格表の検証と上限
一時除外[のべN 今M 飛ばした経路K] … 責任を問われたプール(**模型の誤り**だけ。価格の動きは問わない)
手数料実測[判明N 取引なしで保留M …]
外した[永久N 一時M 先越されK]   … 先越され = 競争に負けた(失敗ではない)
大物[検知N 成立M 得た$X 逃した見込み$Y] … $0.10以上の機会の行方
清算[名簿N 見張りM 見つけたK 他者J 回復I 実績L件(小口p% 極小q%)]
```

---

## 7. お金と枠を守る仕組み(一覧)

| 層 | 仕組み | 値 |
|---|---|---|
| チェーン上 | `returned >= owed + minProfit` | 最後の砦 |
| 送信前 | `simulateRoute` + `estimateGas` を同時に | 赤字なら送らない |
| 送信前 | 実測ガスで純利益を確かめ直す | `MIN_PROFIT_USD=0.01` |
| 判定 | 罠(利回り20%超は幻) | `MAX_SANE_RETURN_RATIO=0.20` |
| 判定 | 税トークン(手数料100bps超は永久除外) | `TAX_TOKEN_FEE_BPS=100` |
| 判定 | 価格表の信用できる上限(過大が20bps超で投入額を制限) | `VERIFY_DROP_TABLE_BPS=20` / `LEARN_CAP_BPS=20` |
| 失敗後 | 冷却(同じ経路を10分) | `FAILURE_COOLDOWN_MS` |
| 失敗後 | **一時**無効(本物の失敗が30分に3回で60分)。**先を越された(wait)は数えない** | `FAILURE_WINDOW_MS` / `FAILURE_DISABLE_MS` |
| 失敗後 | 一時除外(**地図の誤り**が30bps超、6時間に2回で60分) | `BLAME_MIN_BPS=30` |
| 枠 | 月末見込70%で新しいプールの採用を止める | `SCOUT_QUOTA_STOP_PCT=70` |
| 投入額 | 成功回数で上限を段階的に上げる | `trade-cap.js` |

**永久に外してよいのは「性質として変わらないもの」(税・詐欺)だけ。** 送信失敗や価格の動きは永久の理由にしない。

---

## 8. 進行中と未決(2026年9月21日時点)

| | 状態 | 次に要るもの |
|---|---|---|
| **Aave 清算 第1段** | 4チェーンで測定中(avalanche は第2段へ移した)。base で $1,000超が1日2回 | 1〜3日の実測 |
| **Aave 清算 第2段(avalanche)** | 監視・コントラクト・実行の道筋を**入れた**(DRY_RUN)。監視はログで動作確認済み | `RUN_LIQUIDATOR_DEPLOY=avalanche` → 住所を設定 → DRY_RUN で `[清算AVAX/確認]` の数字を確認 → **本番はオーナー了承** |
| **清算のコントラクト** | `liquidateRoute` / `simulateLiquidate` を**書いてコンパイル済み**。**未配置** | bot 側の呼び出し・借入額の計算・経路探索・フォーク試験 → **再デプロイ(立ち会い)** |
| LINE 通知 | 未設定 | オーナーが `LINE_CHANNEL_ACCESS_TOKEN` / `LINE_USER_ID` を Railway に設定 |
| プール採用の拡大 | 上位50(新しいものの中で)に広げた | 枠と成立件数を見て100へ |
| 2チェーン間の非原子裁定 | 提案のみ | 元手 $2,000〜5,000(オーナーの判断) |

---

## 9. 直す前の確認リスト(2026年9月21日のミスから)

今日1日で自分の変更に起因するミスを**9件**直した。全て同じ数種類の型だった。**直す前にこの表を見る。**

| 型 | 実際に起きたこと | 確認すること |
|---|---|---|
| **実物を読まずに書く** | `getFeeProbeStats()` の項目名を推測で書いて存在しなかった | 使う関数の**戻り値の形を grep してから**書く |
| **1行関数を範囲で消す** | 「次の `}`」を探す切り出しが、隣の生きた関数63行を巻き込みかけた | 消す範囲は**波括弧を数えて**決め、先頭と末尾を目で見る |
| **符号を無視した閾値** | `Math.abs(bps) > 50` で過大と過小を同じ扱い | 閾値の前に「符号に意味は無いか」を問う |
| **測っているのに使っていない** | 5件(補正比・実測ガス・価格表のずれ・答え合わせの分解・…) | 新しく測ったら「どこで使うか」を同時に決める |
| **同じ物を書く仕組みが2つ** | 定期検証が学習した上限を緩めた / 直読みの値を推測が上書きした | 2つ目を作る時に「どちらが強いか」を決める |
| **「失敗」と「負け」の混同** | 先を越された取引で永久追放 / 価格の動きでプールの責任 | 捨てる理由が「壊れている」か「競争に負けた」かを分ける |
| **`/tmp` に保存** | 5箇所が再デプロイで消えていた | 保存先は `POOL_MAP_FILE` のディレクトリ |
| **文字列で外部の失敗を見分ける** | `'K'` の文字列判定が custom error `K()` に一度も当たらなかった | セレクタ(4バイト)で見分ける。読めなくても生データを残す |
| **当て推量に一次情報の印** | 読めなかった50bpsに `feeFromChain` を付けて訂正不能にした | 印は本当に読んだ値にだけ |
| **少しずつ進む作り** | 名簿の遡りが「完了まで85日」だった | 進捗を出したら**いつ終わるか**も割り算する |

**そして:1つ直したら、同じ型の場所を全部探す。** `grep` は速い。

