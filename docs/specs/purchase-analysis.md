# 購入判断 仕様書

## 概要

ウォッチリスト（気になる）銘柄ごとに buy / stay / avoid の判断を生成する機能です。

## 生成タイミング

取引日の3セッション

## 入力データ

- 財務指標（20以上の指標）
- 3ヶ月分の株価データ（SMA25計算に25営業日以上が必要）
- テクニカル指標（RSI, MACD, 移動平均乖離率）
- ローソク足パターン分析
- チャートパターン（三尊、ダブルボトム等）
- 出来高分析
- トレンドライン
- タイミング補助指標（ギャップアップ率、出来高急増率、売買代金）
- 相対強度（市場/セクター比較）
- 関連ニュース（7日分）
- AI予測（StockAnalysis があれば）
- 日経225のデータ
- セクタートレンド
- 地政学リスク指標（VIX・WTI）
- 決算・配当落ちスケジュール
- 買いシグナル判定コンテキスト（チャート・ファンダメンタルのルールベース判定結果）

## AI出力スキーマ

```json
{
  "marketSignal": "bullish | neutral | bearish",
  "shortTermTrend": "up | neutral | down",
  "shortTermPriceLow": 2300,
  "shortTermPriceHigh": 2600,
  "shortTermText": "短期分析テキスト",
  "midTermTrend": "up | neutral | down",
  "midTermPriceLow": 2200,
  "midTermPriceHigh": 2800,
  "midTermText": "中期分析テキスト",
  "longTermTrend": "up | neutral | down",
  "longTermPriceLow": 2100,
  "longTermPriceHigh": 3000,
  "longTermText": "長期分析テキスト",
  "positives": "良いところ（箇条書き）",
  "concerns": "不安な点（箇条書き）",
  "suitableFor": "こんな人向け",
  "styleAnalyses": {
    "CONSERVATIVE": {
      "recommendation": "buy | stay | avoid",
      "confidence": 0.85,
      "advice": "アドバイステキスト",
      "reason": "推奨理由",
      "caution": "注意点",
      "buyCondition": "stayの時、どうなったら買い時か",
      "suggestedDipPrice": 2300,
      "suggestedExitRate": 0.05,
      "suggestedSellTargetRate": 0.15
    },
    "BALANCED": { "..." : "同上" },
    "AGGRESSIVE": { "..." : "同上" }
  },
  "userFitScore": 78,
  "budgetFit": true,
  "periodFit": true,
  "riskFit": true,
  "personalizedReason": "パーソナライズされた理由"
}
```

## マーケットシールド: 買い凍結

マーケットシールドがアクティブな場合、全スタイルの buy 推奨を stay に強制変更する。Shield中は新規購入を一律凍結し、市場が安定するまで待つ。

- 対象: 全3スタイルの `recommendation == "buy"` の銘柄
- 動作: buy → stay に変更、`buyCondition` に防御モード中の旨を設定
- 補正理由: `market_shield` ルールIDで `correctionExplanation` を生成

## トレンド収束予測（Trend Convergence）

AIが短期/中期/長期トレンドの乖離状態を分析し、収束予測を `trendConvergence` として出力する。

**AI出力スキーマ（trendConvergenceフィールド）**:

```json
{
  "trendConvergence": {
    "divergenceType": "short_down_long_up | short_up_long_down | aligned",
    "estimatedConvergenceDays": 14,
    "confidence": "high | medium | low",
    "waitSuggestion": "短期の押し目が一巡するまで待つのが安全です",
    "keyLevelToWatch": 2350,
    "triggerCondition": "RSIが40を回復し25日線を上抜けたら転換サイン"
  }
}
```

- `divergenceType`: トレンドの乖離タイプ。`aligned` の場合は乖離なし
- `estimatedConvergenceDays`: 収束までの推定日数（null可）
- `confidence`: 予測の確信度
- `waitSuggestion`: 待機に関するアドバイス
- `keyLevelToWatch`: 注目すべき価格水準（null可）
- `triggerCondition`: トレンド転換のトリガー条件

結果は `PurchaseRecommendation.trendConvergence` に JSON として保存される。

## 安全補正ルール（ハードオーバーライド）

AI生成後、全3スタイルの結果に対して以下の安全補正を順に適用する。

| # | ルール | 条件 | 動作 |
|---|--------|------|------|
| 1 | テクニカル売りシグナル | RSI/MACD/ローソク足の売りシグナル強度が閾値以上（安定配当型70%/バランス75%/アクティブ型85%） | buy → stay |
| 2 | avoid信頼度ゲート | avoidの場合、confidenceがスタイル別閾値未満（安定配当型0.6/成長投資型0.65/アクティブ型0.75） | avoid → stay |
| 3 | 危険銘柄ロック | 赤字 + ボラティリティ > 50%（おすすめ銘柄はスキップ） | buy → stay |
| 4 | 赤字×急騰 | 赤字企業が週間+20%以上急騰 | buy → stay |
| 5 | ギャップアップ急騰 | ギャップアップ率が閾値以上（安定配当型10%/バランス15%/アクティブ型20%）（おすすめ銘柄はスキップ） | buy → stay |
| 6 | 異常出来高+急騰 | 出来高急増率が極端閾値以上 + ギャップアップ率が警告閾値以上（仕手株リスク） | buy → stay |
| 7 | 市場暴落 | 日経225が暴落中 | buy → stay |
| 8 | 決算直前ブロック | 決算発表まで3日以内 | buy → stay |
| 9 | 短期下降トレンドブロック | AI短期予測トレンドが「down」 | buy → stay |
| 10 | 決算間近ペナルティ | 決算発表まで7日以内 | confidence -0.1 |
| 11 | 下方乖離ボーナス | MA乖離率 ≤ 下限閾値 + 黒字 + 低ボラティリティ | confidence +ボーナス |
| 12 | パニック売り防止 | MA乖離率 ≤ -20% + avoid | avoid → stay |
| 13 | 業績悪化×下落トレンド | 赤字 + 減益トレンド + 週間変化率が閾値以下（安定配当型-3%/成長投資型-5%/アクティブ型-10%） | stay → avoid |
| 14 | テクニカル全面ネガティブ | テクニカル売りシグナル強度が閾値以上（安定配当型60%/成長投資型70%/アクティブ型85%）+ 中期予測down | stay → avoid |
| 15 | 長期下落トレンド | MA乖離率が閾値以下（安定配当型-8%/成長投資型-12%/アクティブ型-18%）+ 週間変化率マイナス | stay → avoid |

※ ルール13-15はパニック売り防止（ルール12）で stay に戻された銘柄には適用されない。
※ ルール13-15で設定された avoid は、style-analysis の売られすぎ逆補正から保護される。

※ おすすめ銘柄（当日のUserDailyRecommendationに含まれる銘柄）は一部のセーフティルールをスキップ。ただし危険銘柄や赤字×急騰などのハードブロックは適用される。

## 買いタイミングロジック

- `dip`（押し目買い）: MA乖離 > 閾値 or RSI > 70 or テクニカル売りシグナル → 下がるまで待つ
- `market`（成り行き）: 上記以外 → すぐ購入OK
- 押し目価格のフォールバックチェーン: AI推奨価格 → SMA25 → SMA75 → ATR14 → ボラティリティ連動

## 投資スタイル別分析（styleAnalyses）

AIが1回のAPIコールで3つの投資スタイル（安定配当型/成長投資型/アクティブ型）ごとに異なる判断（recommendation/confidence/advice/reason/caution）を直接生成します。各スタイルは短期/中期/長期の予測トレンドに対する重み付けとGO条件が異なります:

| スタイル | 重視するトレンド | GOを出す条件 | 判断傾向 | アドバイスのトーン |
|----------|------------------|--------------|----------|-------------------|
| 安定配当型（CONSERVATIVE） | 長期 | 「下値が固まった」時（RSI反発+支持線維持）。リスク・リワード比1:3以上なら損切りをタイトに設定してリバウンド狙いの buy も許可 | 長期下落なら原則 stay/avoid。ただし最大損失を限定できる場合は打診買い可 | 「リスクは限定的です。少額から慎重にエントリーを検討しましょう。」 |
| 成長投資型（BALANCED） | 中期 | 「トレンドが転換した」時（ゴールデンクロス、RSI回復、出来高を伴う反転） | 中期で判断、短期・長期で補正 | 「中期的な回復の兆しがあります。標準的なポジションで利益を狙えます。」 |
| アクティブ型（AGGRESSIVE） | 短期 | 「モメンタム（勢い）が出た」時（出来高急増+直近高値突破） | 短期上昇ならモメンタムを活かして buy | 「勢いに乗りましょう。上値追いのチャンスです。」 |

### 安定配当型のリスク限定型エントリー

- 安定配当型は「損をしたくない」のであって「稼ぎたくない」わけではない
- adviceで「最悪のケースの最大損失率」を明示した上で投資する価値がある理由を説明
- リスク・リワード比1:3以上かつ損切りラインがタイトに設定可能 → 短期リバウンド狙いの buy を許可
- 赤字銘柄でもセクター全体に買いが入っている場合は「地合いを味方につけた短期戦」として提案可能（cautionで業績リスクに必ず言及）

## スタイル依存の安全補正

AI生成後、非スタイル依存の安全補正（テクニカルブレーキ、危険銘柄、市場急落等）を全スタイルに適用し、さらにスタイル依存のセーフティルールを適用:

| スタイル依存補正 | 条件（スタイルにより閾値が異なる） | 動作 |
|------------------|--------------------------------------|------|
| 極端な急騰ブロック | 週間変化率 ≥ 50%（skipSafetyRulesでもブロック） | buy → stay |
| 極端な過熱ブロック | MA乖離率 ≥ 50%（skipSafetyRulesでもブロック） | buy → stay |
| 下落トレンドロック | `isInDecline(weekChangeRate, style)` 安定配当-10%/成長-15%/アクティブ-20% | buy → stay |
| 急騰ロック | `isSurgeStock(weekChangeRate, style)` 安定配当+20%/成長+25%/アクティブ+50% | buy → stay |
| 過熱チェック | `isOverheated(deviationRate, style)` MA乖離率 ≥ 20%（アクティブ型はスキップ） | buy → stay |
| 市場パニック | 市場パニック時 | confidence低下 |

## アクティブ型リバウンド狙い逆転ロジック

上記のセーフティルールでアクティブ型が `stay` に補正された場合でも、以下の条件を満たす銘柄はアクティブ型のみ `buy`（押し目買い）に再昇格する:

| 条件 | 閾値 |
|------|------|
| 引けにかけて強い | ローソク足が買いシグナル かつ 強度 ≥ 55% |
| 出来高が伴っている | 出来高急増率（20日平均比）≥ 1.5倍 |
| ギャップアップモメンタム | 小幅ギャップアップ(2-5%) + 引け強い(70%以上) + 出来高(1.3倍以上) の2条件以上 |

- 上記のいずれかを満たせばリバウンド昇格の対象
- 両方が揃った場合は confidence をより高く設定（0.65）
- ハードセーフティ（危険銘柄、赤字×急騰、市場暴落、仕手株リスク）は逆転しない
- 既に `buy` のアクティブ型に対しても、引け強い/出来高ありの場合は confidence を +0.05 ブースト

## ATRベースの撤退ライン最低保証

AIが生成した撤退ライン率（suggestedExitRate）をそのまま使用し、ATRベースの最低幅を保証する。短期予測価格による上書きは行わない（予測値が近すぎて寄り付きで刺さる問題の対策）。

- ATR14 × スタイル別係数（安定配当型1.5x / 成長投資型2.5x / アクティブ型4.0x）で最低撤退ライン率を算出
- AIの率がATRベースより広い場合はAIの率を採用
- ATRが利用できない場合はフォールバック値（安定5% / 成長8% / アクティブ12%）を適用
- 売却目標率: リスクリワード比1:3の最低保証（売却目標率 >= 撤退ライン率 × 3）
- 撤退ライン率がスタイル別上限（安定10% / 成長15% / アクティブ20%）を超えた場合、buy → stay に降格

## トレンド乖離（ねじれ）検出

短期トレンドと長期トレンドの方向が異なる場合（例: 短期上昇＋長期下落）、乖離の種類を検出してスタイル別の解説を付与。リバウンド警戒（下降トレンド中の一時的な反発）の場合は buy → stay に補正。

## スタイル間合意度によるconfidence補正

全ての推奨変更ロジック完了後、3スタイルのうち買い推奨の数に応じてconfidenceを調整:
- 1/3のみbuy: confidence -0.15
- 2/3がbuy: confidence -0.05
- ペナルティ後のconfidenceが0.6未満の場合: buy → stay に変更

結果は `PurchaseRecommendation.styleAnalyses` と `StockAnalysis.styleAnalyses` に JSON として保存。フロントエンドでタブ切り替えにより3スタイルの結果を比較表示できます。

## AI設定

| モデル | Temperature | 出力形式 |
|--------|-------------|----------|
| GPT-4o-mini | 0.4 | JSON Schema |

## プロンプト設計原則

- **ハルシネーション防止**: 提供されたニュース以外を引用しない明示的指示
- **初心者向け言語**: 専門用語 + 必ず解説を付与
- **エビデンス必須**: すべての判断に根拠を引用
- **安全優先**: AI予測よりも安全ルールを優先
- **パーソナライズ**: ユーザーの投資スタイル・予算に合わせた文脈

## API

| エンドポイント | 認証 | 説明 |
|---------------|------|------|
| `POST /api/stocks/[stockId]/purchase-recommendation` | - | 購入判断生成 |

## 関連ファイル

- `lib/purchase-recommendation-core.ts` - 購入判断ロジック（安全補正・タイミング判定・期間分析）
- `lib/style-analysis.ts` - 投資スタイル別セーフティルール
- `lib/stock-safety-rules.ts` - 安全ルール（おすすめ・購入共通）
- `lib/correction-explanation.ts` - 補正理由の解説テキスト生成
- `lib/trend-divergence.ts` - トレンド乖離（ねじれ）検出
- `lib/prompts/purchase-recommendation-prompt.ts` - 購入判断プロンプト
- `lib/recommendation-buy-filter.ts` - 買いシグナル判定（チャート・ファンダメンタル）
- `lib/stock-analysis-context.ts` - 分析コンテキスト生成（`buildBuySignalContext`含む）
- `lib/market-shield.ts` - マーケットシールド（発動・解除・状態確認）
