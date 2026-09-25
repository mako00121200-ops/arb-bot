# limitless/ — Limitless Exchange の Up/Down 市場(1時間・15分・5分)の観測(第1段階)

**注文は一切出さない。** APIキーも秘密鍵も不要(公開チャネルだけを読む)。
背景と戦略は `../docs/limitless-research.md`。

本番のDEX裁定bot(リポジトリ直下)とは**依存も起動も完全に別**。
このディレクトリに独自の `package.json` があり、Railway では別サービスとして動かす。

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
| `ASSETS` | `btc,eth` | 対象 |
| `HOURLY_SLUG_PATTERN` | `^(btc\|eth)-up-or-down-(hourly-p\|hourly\|\d+-min)-(\d+)$` | 2026年9月25日の実測では 1時間市場は `-hourly-p-<ミリ秒>`、5分/15分市場は `-5-min-<秒>`。合わなかった「それっぽい」slugは `raw_sample` に残る |
| `THEO_INTERVAL_MS` | `1000` | 理論価格の記録間隔。容量が気になれば `2000` |
| `BOOK_DEPTH` | `5` | 板の記録段数 |
| `BINANCE_WS_URL` | `wss://data-stream.binance.vision/stream` | 空文字で無効 |
| `SIGMA_FALLBACK_1H` | `0.0045` | σ推定が育つまでの仮の1時間σ(0.45%) |
| `KEEP_DAYS` | `14` | JSONLを何日分残すか。前日分は自動でgzip、それより古いものは削除 |
| `MIN_FREE_MB` | `50` | Volumeの空きがこれを下回ったら記録を止める(ログ出力は続く) |
| `PYTH_HERMES_URL` | (無効) | 2026年9月25日に401(キー必須)を確認。URLを入れると有効 |

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
