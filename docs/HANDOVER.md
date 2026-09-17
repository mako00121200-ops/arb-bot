# arb-bot 引き継ぎ資料(2026年9月17日時点)

## 目的と方針(オーナーが決めたこと)
- DEX内で完結する原子的裁定bot。フラッシュスワップ+自作コントラクト。CEX裁定は対象外
- オーナーはiPhoneのみで操作。撤退は考えておらず、実測に基づいて段階的に改善し利益を伸ばす
- Ethereum本体は対象外。チェーンは「同じロジックで全部」ではなく、チェーンごとに攻め方を作って1つずつ増やす
- 推測で決めない。アドレス・手数料・ガス代・イベント識別子は必ず実測または公式資料で確認する
- 修正は「実装が目的」にならないよう、利益への効果を先に説明する
- 作業は1つずつ提案する

## 稼働環境
- GitHub: mako00121200-ops/arb-bot(main にMergeするとRailwayが自動デプロイ)
- Railway: プロジェクトID f9a69c7e-b52c-4e06-bd1b-9863019619bc / サービスID d47495c6-84bb-4228-9f87-bc2f2f9a9ddb(secure-amazement)/ 環境 production
- ダッシュボード: https://secure-amazement-production-5364.up.railway.app
- RPC: Chainstack Growth(月2,000万リクエスト、Extra usageオフ=超過で停止)。PolygonのみChainstackのHTTP+WSS。Arbitrum/Avalancheは公開RPCの定期読み直し
- 稼働チェーン: ACTIVE_CHAINS=polygon,arbitrum,avalanche(Base/Optimismは停止、設定は残してある)
- botウォレット: 0x9D926340a8F14D3351470997684bD8C4767131f1
- コントラクト(simulateRoute方式、2026年9月17日デプロイ): Polygon/Avalanche 0xD2D45cC99AAe1AF7302b067d116fEEA8d7ceAca1、Arbitrum 0x2139C1497F7C8c3291e51639ccc978Ffe7a73E18
- コントラクトの再デプロイは環境変数 RUN_MAINNET_DEPLOY=<チェーン名> で起動時に実行し、完了後に MAINNET_CONTRACT_ADDRESS_<チェーン> を設定して RUN_MAINNET_DEPLOY=false に戻す

## 現在の仕組み
- V2のSync/V3のSwapをWebSocketで受信し、メモリ上の地図で経路(2〜3段)を即判定
- 監視対象はV3プールと「両トークンがV3プールに含まれるV2プール」だけ。V3を含まない経路は判定しない
- V3は公式QuoterV2で作った価格表から補間(Multicall3で束ねて作成)
- 送信は「simulateRoute(eth_call)で正確な利益を確認 → executeRoute送信」。受取量はコントラクトが実行時の準備量で計算
- 送信直前に赤字と分かった経路は、プールの状態が変わるまで再判定しない
- 30秒後に「誰が取ったか」(自分/他者の裁定/通常取引/誰も触らず)を記録簿に残す

## 実績
- 2026年9月17日に初の自動売買成功。午前中に4件成功・失敗0件、確定利益合計+$0.118
- 4件ともPolygonの2段で「V2でずれた直後にV3(0.05%)で戻す」型、確認時の粗利+40〜50bps、検知から送信準備0.18〜0.52秒
- 他者に先を越されたのは0件。一方で約1.5時間黒字判定が0件の時間帯があり、課題は速度より機会の数

## 確定した実測値
- Aerodrome/Velodromeのvolatileプール手数料は約1%
- ガス代目安: avalanche≒$0.001 / polygon≒$0.012〜0.017(2段) / arbitrum≒$0.015
- 「投入$2で利益$24」のような価格差はハニーポット。本物は投入額の0.1〜0.5%程度
- Polygon V2だけの経路の黒字は税トークンか極小案件ばかりだった
- PolygonのDEX出来高(30日): Uniswap約51%、RamsesX約16%、Metric約14%、QuickSwap約12%
- AvalancheのDEX出来高(30日): Pharaoh約78%、Uniswap約6%、Blackhole約5%、LFJ約2%

## 過去の誤り(再発防止)
- イベント識別子を手書きして1文字欠け、最初期から一度も受信できていなかった → ethers.id()で計算する
- RPCにタイムアウトが無く14時間凍結 → 全呼び出しに上限を設けている
- GitHubのコントラクトが修正前の版のままデプロイされ、全取引が必ず失敗していた → デプロイ前に中身を確認する
- V3価格表がWebSocketの無いチェーンで作り直されず、幻の黒字を毎分出していた
- 背景の手数料実測が必ず失敗するループでRPC枠を浪費していた
- 各段5bpsの安全余裕とbot側の見積もり誤差で、本物の機会を赤字と判定していた

## 進行中の計画
1. Polygon上のV3型プールをDEX(ファクトリー)別に数える調査(RamsesX・QuickSwap V3の実在と取引量の確認)
2. Ramses系・Algebra系CL DEXへの対応: 名前を問わないコールバック受付、自前コントラクトでの見積もり、Swapイベントからのプール発見(PolygonのRamsesXとAvalancheのPharaohに同時に効く)
3. 2番目のチェーンはAvalanche(Pharaoh対応が前提)かArbitrum(WebSocket受信+シーケンサー直結送信)で未決。オーナーはAvalancheを先にしたい考え

## 後回しにした対策
- 速度: nonce/ガス価格の事前取得、ガス見積もり省略、Arbitrumシーケンサー直結送信とフィード購読、RailwayをUS Eastへ、Chainstack Trader Node
- 範囲: 始点トークン拡張、4段経路、BNB追加、Polygon FastLane入札
- 利益: 投入額の最適化、コントラクトのガス削減、取引上限の引き上げ
- 守り: 私設送信、コントラクトからの利益の引き出し、異常の通知
