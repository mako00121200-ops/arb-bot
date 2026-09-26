# limitless/ — Limitless Exchange の Up/Down 市場(1時間・15分・5分)の観測(第1段階)

**注文は一切出さない。** APIキーも秘密鍵も不要(公開チャネルだけを読む)。
背景と戦略は `../docs/limitless-research.md`。

本番のDEX裁定bot(リポジトリ直下)とは**依存も起動も完全に別**。
このディレクトリに独自の `package.json` があり、Railway では別サービスとして動かす。

## 終盤メイカー(紙上、2026年9月26日〜)

**実際の注文は出さない。** 5分/15分市場の満期90秒前から、TWAPモデル(決済値=満期直前60秒の平均)で
Up/Down どちらかが 99.5% 以上になった側に、postOnly の買い指値を置いたと仮定する。
指値の上限を 0.96 / 0.97 / 0.98 の3通り同時に試し、どれが一番儲かるかを実データで決める。

- 根拠: TWAPモデルの Brier は満期30〜10秒前で 0.001。勝っていた大口 0x6731…19c5 が同じ型(5分市場・満期約21秒前・メイカー)で利益
- 板が逆を向いている時は置かない(モデルと板が食い違う場面では板の方が正しかった)。σ は2倍にして使う
- 約定判定: Base 上の実際の約定で、他人の「同じ側の買い指値」が自分の指値より安く約定していたら価格優先で自分が先(全量)。
  同値やテイカーの売りは待ち行列の半分だけ。指値が有効なのは「置いた時刻+400ms」から「取り消した時刻」まで
- 結果は画面の「終盤メイカー」カード、ログの `[紙上 0.98]` 行、JSONL の `paper` 行(place / cancel / fill / settle)
- 累計は `DATA_DIR/endgame.json` に毎分保存。`ENDGAME=off` で止まる

## 両側買い(紙上、2026年9月26日〜、gabagool 型)

同じ市場で YES と NO を別の時刻に公正価格の3¢下で買い、1組の原価を $0.98 以下にそろえる(そろえば結果に関係なく利益)。
5分/15分市場、1回 $1・1市場 $6 まで、片寄り $2 まで、満期60秒前で停止。約定判定は終盤メイカーと同じ。
結果は画面の「両側買い」カード、ログの `[両側]` 行、JSONL の `pair` 行。累計は `pair.json`。`PAIR=off` で止まる。

## 画面(ダッシュボード)

https://limitless-collector-production.up.railway.app (読み取り専用。`DASHBOARD_TOKEN` を設定すれば `?token=…` が要るようになる)

30秒ごとに `/api/state` を取り直して描く。iPhone 向けの縦並び。

| 区画 | 何が分かるか |
|---|---|
| 上段のタイル | 監視中の市場数、板取得の往復 p50/p95、WS の受信遅れ、24h の確定約定と合計損益 |
| 遅延の推移 | 直近24時間の p50(5分ごと)。注文を送れる速さの代理 |
| 寄り付き5秒の的中率 | 日別に「理論」と「板」のどちらが決済結果を当てていたか。理論 > 板 なら寄り付きに乗る価値がある |
| 乖離の分布 | 今日、理論と板が何¢ずれていた秒数。2¢ 超が多ければテイカーで取れる余地がある |
| 勝者(24h)/ 常連(7日) | Base 上の約定をアドレス別に。**テイカー率・買YES/買NO/売・満期前秒数**が戦術の型。常連は日別トップ10に入った日数順 |
| 監視中の市場 / 最近の決済 / 最近の約定 | 生の状態 |

集計は `DATA_DIR/stats.json` に毎分保存され、再起動しても残る(14日分)。

## 決済ルール(2026年9月25日に市場JSONの説明文で実測)

| 市場 | 決済ソース | 行使価格 | 同値 |
|---|---|---|---|
| 1時間 `-hourly-p-` | **Binance BTC/USDT の1時間足** の終値 ≥ 始値 | `metadata.openPrice`(足の始値) | Up |
| 5分・15分 `-N-min-` | **Chainlink 60秒TWAP** の満期値 ≥ 開始時の値。ちょうどの時刻のレポートが無ければ5秒以内の最初の観測値 | `metadata.openPrice`(開始時のTWAP) | Up |

`oraclePriceData`(`source: "chainlink"`)は5分/15分市場の決済値そのもの。1時間市場の参照は Binance の約定(`cex`)を優先する。

## 何を貯めるか(`DATA_DIR/YYYY-MM-DD.jsonl`、1行1レコード)

| type | 内容 |
|---|---|
| `market` | 市場の基本情報。**`openPrice`(始値=行使価格)**、満期、オラクル情報、LP報酬パラメータ |
| `book` | 板(上位 `BOOK_DEPTH` 段)。REST初回 + WSの更新ごと |
| `oracle` | Limitless WS の `oraclePriceData`(決済に使われる価格そのもの)。**流れるかどうか自体が要確認** |
| `pyth` | Pyth Hermes(予備の参照価格) |
| `cex` | Binance の約定(秒に1回。σの材料) |
| `theo` | 毎秒の理論価格 `pTheo = Φ(ln(S/K)/(σ√τ))` と板の乖離(`edgeBuyYes` / `edgeSellYes`) |
| `summary` | 市場が決済されるたびに1件。寄り付き5/30/120秒時点の乖離・板・理論価格と結果 |
| `fill` | **Base 上の約定(OrderFilled)**。maker/taker のアドレス、価格、数量、手数料、満期までの秒数、市場。`BASE_RPC_URL` が要る |
| `redeem` | Base 上の払い戻し(PayoutRedemption)。アドレスごとの確定損益の材料 |
| `chain_topics` | 5分ごとの、コントラクト×イベント署名の件数。**署名が Polymarket 系と同じかの確認用**(違えば `raw_sample` の `chain:unknown:…` に生データが残る) |
| `mevent` | 公開の市場イベント `/markets/{slug}/events`(ORDER_PLACED 等)。中身は生のまま |
| `latency` / `heartbeat.latency` | HTTP往復(`http_orderbook` 等)、WS受信遅れ(`ws_oracle_lag` / `ws_book_lag`)、Binance受信遅れ、RPC往復の p50/p95 |
| `leaderboard` | 1時間ごと(起動10分後から)。直近24時間で損益が確定した約定をアドレス別に集計し、損益上位10・出来高上位を `[勝者 24h]` としてログにも出す |
| `raw_sample` | 各イベント種別の**最初の1件の生データ**。受信形式の確認用 |
| `error` / `ws` / `heartbeat` | 運用ログ |

ログ(標準出力)にも `[要約]` 行が出るので、Volume が無くても Railway のログだけで戦略Aの当否は読める。

```
[要約] btc-up-or-down-hourly-1785049200 結果=Up 始値=100000.00 寄付5s: 乖離=+7.9bps z=0.19 理論=0.574 板中値=0.500 | 30s 理論=... 板=... | 理論5sが正解側=true 板5sが正解側=false
```

## Railway での動かし方(別サービス)

1. 同じプロジェクトに **New Service → GitHub Repo(このリポジトリ)** を追加
2. Settings → **Root Directory** を `limitless` にする(これで本番botとは別のビルドになる)
3. Start Command は自動で `npm start`(= `node collector.js`)
4. **Volume** を追加してマウント先を `/data` にし、環境変数 `DATA_DIR=/data` を設定
   - Volume を付けないと再デプロイのたびに JSONL が消える。ログの `[要約]` 行だけで良ければ無くても動く
   - 記録量は約150MB/日(当日分は非圧縮、前日以前はgzipで約1/10)。500MBのVolumeなら `KEEP_DAYS=14` で収まる。もっと残したければダッシュボードでVolumeを拡張する(MCPからは容量変更できない)
5. 環境変数は全て任意(既定値で動く)。秘密情報は無い

| 変数 | 既定 | 用途 |
|---|---|---|
| `DATA_DIR` | `./data` | JSONL 保存先 |
| `ASSETS` | `btc,eth,xrp,solana,doge,bnb` | 対象(XRP 以降は1時間市場のみ) |
| `HOURLY_SLUG_PATTERN` | `^(btc\|eth)-up-or-down-(hourly-p\|hourly\|\d+-min)-(\d+)$` | 2026年9月25日の実測では 1時間市場は `-hourly-p-<ミリ秒>`、5分/15分市場は `-5-min-<秒>`。合わなかった「それっぽい」slugは `raw_sample` に残る |
| `THEO_INTERVAL_MS` | `1000` | 理論価格の記録間隔。容量が気になれば `2000` |
| `BOOK_DEPTH` | `5` | 板の記録段数 |
| `BINANCE_WS_URL` | `wss://data-stream.binance.vision/stream` | 空文字で無効 |
| `SIGMA_FALLBACK_1H` | `0.0045` | σ推定が育つまでの仮の1時間σ(0.45%) |
| `KEEP_DAYS` | `7` | JSONLを何日分残すか。前日分は自動でgzip、それより古いものは削除 |
| `MIN_FREE_MB` | `50` | Volumeの空きがこれを下回ったら記録を止める(ログ出力は続く) |
| `PYTH_HERMES_URL` | (無効) | 2026年9月25日に401(キー必須)を確認。URLを入れると有効 |
| `BASE_RPC_URL` | (無効) | Base の RPC。Railway では本番サービスの値を `${{secure-amazement.BASE_RPC_URL}}` で参照。設定すると約定・払い戻しを読む |
| `EVENTS_INTERVAL_MS` | `20000` | 公開の市場イベントの取得間隔。0 で無効 |
| `LATENCY_PROBE_MS` | `15000` | HTTP往復の計測間隔 |
| `LEADER_REPORT_MS` | `3600000` | `[勝者 24h]` の出力間隔 |

## 「勝っている人の注文を覗く」ための材料

板には誰が出したかが無いが、**約定は全て Base 上で決済される**ので、`fill` 行に maker/taker のアドレス・価格・数量・満期までの秒数が残る。
これをアドレスごとに集計し、`redeem`(払い戻し)と突き合わせれば「どのアドレスが、満期の何秒前に、どちら側を、いくらで取り、いくら回収したか」が分かる。
既存 DEX bot の competitor-check.js(誰が取ったか)と同じ発想。集計スクリプトは数日分たまってから作る。

## 「注文を送れる速さ」の見積もり(実弾なし)

`[遅延]` 行の `http_orderbook` の p50 が、この Railway リージョン(sfo)から Limitless API への往復時間。注文は署名付き POST なので実測はこれより少し遅い。
`ws_oracle_lag` / `ws_book_lag` は「出来事が起きてから自分に届くまで」。メイカーとして指値を引く猶予は、テイカー・ディレイ(未計測、注文が要る)からこの値を引いたもの。

## 起動して最初の10分で確認すること

1. ログに `[WS] Limitless 接続` が出る
2. `[市場] 発見 btc-up-or-down-hourly-…` が出る。出なければ `raw_sample` の `slug:…` 行で実際の命名を見て `HOURLY_SLUG_PATTERN` を直す
3. `[生データ] ws:oraclePriceData` が出るか。**出なければ決済価格は Limitless からは流れておらず、`pyth`(Hermes)が参照価格になる**
4. `[生データ] hermes:update` と `binance:aggTrade` の形が想定通りか(価格が桁違いなら解釈を直す)
5. `[生存]` 行の σ1h が「推定中」から数値に変わる(約2分後)

## ローカルでの自己診断(ネットワーク不要)

```
cd limitless && npm install && npm run selftest
```
