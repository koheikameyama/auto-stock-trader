# AIレコメンド 仕様書

## 概要

Stock Buddyの中核機能であるAI推奨システムです。3種類の推奨を生成し、結果を追跡して精度を検証します。

## 推奨の種類

### 1. 日次おすすめ（UserDailyRecommendation）

ユーザーごとに1日最大5銘柄をAIが選定。

**生成タイミング**: 取引日の3セッション（朝9時 / 昼12:30 / 夕15:35 JST）

**生成フロー**:
1. 全ユーザーの投資設定を取得
2. ユーザーごとに並列処理（最大3並列）:
   a. 残り予算を計算
   b. 対象銘柄を取得（最新株価データあり）
   c. 緩い予算フィルタ（予算の1.5倍まで）で候補を広めに取得
   d. スコアリング（投資スタイル別重み + ペナルティ + 安全ルールによる除外）
   e. セクター分散フィルタ（1セクター最大5銘柄）
   f. 予算内の銘柄を優先して絞り込み（5件未満なら予算超の銘柄も安い順に追加）
   g. 上位15銘柄をOpenAIに送信（予算超過時はその旨をプロンプトに含める）
   h. AIが5銘柄を選定 + 理由生成
3. `UserDailyRecommendation` テーブルに保存

**スコアリング時の安全ルール除外**:

購入判断で `buy→stay` に強制補正される銘柄はおすすめ候補から除外:
- 危険銘柄（赤字 + ボラティリティ > 50%）
- 急騰銘柄（投資スタイル別閾値）
- 下落トレンド（投資スタイル別閾値）
- 過熱圏（MA乖離率 ≥ 20%、積極派は除外しない）

**2段階の予算フィルタ**:

1. **緩いフィルタ**（スコアリング前）: 予算の1.5倍までの銘柄を候補に含める
2. **最終絞り込み**（スコアリング後）: 予算内の銘柄を優先。5件未満なら予算超の銘柄も安い順に追加し、AIプロンプトに予算超過の旨を含める

**投資テーマ**:
- `短期成長` - 直近の上昇モメンタムが強い銘柄
- `中長期安定成長` - 安定した業績と成長性
- `高配当` - 高い配当利回り
- `割安反発` - PBR/PERが低く反発期待
- `テクニカル好転` - テクニカル指標が買いシグナル
- `安定ディフェンシブ` - 低ボラティリティで守備的

**AI出力スキーマ**:
```json
{
  "marketSignal": "bullish | neutral | bearish",
  "selections": [
    {
      "tickerCode": "銘柄コード",
      "reason": "おすすめ理由（テクニカル・ファンダメンタルの根拠 + スタイル適合理由）",
      "investmentTheme": "短期成長 | 中長期安定成長 | 高配当 | 割安反発 | テクニカル好転 | 安定ディフェンシブ",
      "expectedExitStrategy": {
        "sellTargetRate": 0.15,
        "exitRate": 0.05
      }
    }
  ]
}
```

**出口戦略プレビュー**:

各銘柄に投資スタイル別の推奨売却目標率・撤退ライン率を付与。フロントエンドで「推奨売却目標 +15% / 推奨撤退ライン -5% / リスクリワード 3.0」のようにチラ見せ表示する。

| スタイル | 売却目標率 | 撤退ライン率 |
|----------|--------|----------|
| 慎重派 | 5-15% | 3-7% |
| バランス型 | 10-25% | 5-10% |
| 積極派 | 15-50% | 7-20% |

**プロンプトの評価基準**:

- スタイル適合理由: `reason` に「なぜこのスタイルのユーザーに適しているか」を含める
- セクター偏り制約: 同一セクター最大2銘柄、バリュー/グロース比率をスタイル別に調整
- ニュース優先: 直近24時間以内のネガティブニュースがある銘柄はテクニカルが良くても除外

**投資スタイル別の選定基準**:

| 基準 | 保守的 | バランス | 積極的 |
|------|--------|----------|--------|
| 時価総額 | 大型中心 | 混合 | 小〜中型含む |
| ボラティリティ | 低 | 中 | 高も許容 |
| 黒字必須 | 必須 | 基本的に黒字 | 赤字も許容 |
| モメンタム重視 | 低 | 中 | 高 |

**API**: `POST /api/recommendations/generate-daily`

**認証**: CRON_SECRET

### 2. 購入判断（PurchaseRecommendation）

ウォッチリスト銘柄ごとに buy / stay / avoid の判断を生成。

**生成タイミング**: 取引日の3セッション

**入力データ**:
- 財務指標（20以上の指標）
- 30日分の株価データ
- テクニカル指標（RSI, MACD）
- ローソク足パターン分析
- チャートパターン（三尊、ダブルボトム等）
- 出来高分析
- 相対強度（市場/セクター比較）
- 関連ニュース（7日分）
- AI予測（StockAnalysis があれば）
- 日経225のデータ
- セクタートレンド

**AI出力スキーマ**:
```json
{
  "marketSignal": "bullish | neutral | bearish",
  "statusType": "即時売却 | 戻り売り | ホールド | 押し目買い | 全力買い",
  "recommendation": "buy | stay | avoid",
  "confidence": 0.85,
  "reason": "推奨理由",
  "caution": "注意点",
  "positives": "良いところ（箇条書き）",
  "concerns": "不安な点（箇条書き）",
  "suitableFor": "こんな人向け",
  "buyCondition": "stayの時、どうなったら買い時か",
  "buyTiming": "market | dip",
  "dipTargetPrice": 2300,
  "userFitScore": 78,
  "budgetFit": true,
  "periodFit": true,
  "riskFit": true,
  "personalizedReason": "パーソナライズされた理由"
}
```

**安全補正ルール（ハードオーバーライド）**:

| # | ルール | 条件 | 動作 |
|---|--------|------|------|
| 1 | テクニカル売りシグナル | RSI/MACD/ローソク足の70%以上が売り | buy → stay |
| 2 | avoid信頼度ゲート | avoidの場合、confidence < 0.8 | avoid → stay |
| 3 | 下落トレンドロック | 週間下落 ≥ -7% | buy → stay |
| 4 | 急騰ロック | 週間上昇 ≥ 30% | buy → stay |
| 5 | 危険銘柄ロック | 赤字 + ボラティリティ > 50% | buy → stay |
| 6 | 市場暴落 | 日経225が暴落中 | buy → stay |
| 7 | 過熱チェック | MA乖離率 > +25% | buy → stay |
| 8 | パニック売り防止 | MA乖離率 < -5% + avoid | avoid → stay |

**買いタイミングロジック**:
- `dip`（押し目買い）: RSI > 70 or MA乖離 > 15% → 下がるまで待つ
- `market`（成り行き）: 上記以外 → すぐ購入OK

**投資スタイル別分析（styleAnalyses）**:

AIが1回のAPIコールで3つの投資スタイル（慎重派/バランス型/積極派）ごとに異なる判断（recommendation/confidence/advice/reason/caution/statusType）を直接生成します。各スタイルは短期/中期/長期の予測トレンドに対する重み付けが異なります:

| スタイル | 重視するトレンド | 判断傾向 |
|----------|------------------|----------|
| 慎重派（CONSERVATIVE） | 長期 | 長期下落なら原則 stay/avoid |
| バランス型（BALANCED） | 中期 | 中期で判断、短期・長期で補正 |
| 積極派（AGGRESSIVE） | 短期 | 短期上昇ならモメンタムを活かして buy |

AI生成後、非スタイル依存の安全補正（テクニカルブレーキ、危険銘柄、市場急落等）を全スタイルに適用し、さらにスタイル依存のセーフティルールを適用:

| スタイル依存補正 | 条件（スタイルにより閾値が異なる） | 動作 |
|------------------|--------------------------------------|------|
| 下落トレンドロック | `isInDecline(weekChangeRate, style)` | buy → stay |
| 急騰ロック | `isSurgeStock(weekChangeRate, style)` | buy → stay |
| 過熱チェック | `isOverheated(deviationRate, style)` | buy → stay |

結果は `PurchaseRecommendation.styleAnalyses` と `StockAnalysis.styleAnalyses` に JSON として保存。フロントエンドでタブ切り替えにより3スタイルの結果を比較表示できます。

**API**: `POST /api/stocks/[stockId]/purchase-recommendation`

### 3. ポートフォリオ分析（StockAnalysis）

保有銘柄の売買判断。詳細は [portfolio-analysis.md](portfolio-analysis.md) を参照。

## 結果追跡（RecommendationOutcome）

すべての推奨の結果を追跡し、AI精度を検証します。

**追跡データ**:

| カラム | 説明 |
|--------|------|
| type | daily / purchase / analysis |
| recommendationId | 元の推奨レコードID |
| stockId / tickerCode / sector | 銘柄情報 |
| recommendedAt | 推奨日時 |
| priceAtRec | 推奨時の株価 |
| prediction | buy / stay / remove / up / down / neutral |
| confidence | 信頼度 |
| volatility / marketCap | 推奨時点の指標 |
| sectorTrendScore / Direction | セクタートレンド |
| returnAfter1Day | 1日後のリターン(%) |
| returnAfter3Days | 3日後のリターン(%) |
| returnAfter7Days | 7日後のリターン(%) |
| returnAfter14Days | 14日後のリターン(%) |
| benchmarkReturn7Days | 7日後の日経225リターン(%) |

**成功基準**（prediction別）:

| prediction | 成功条件 |
|------------|----------|
| buy | リターン > -3%（大損を避ける） |
| stay | リターン ≤ 5%（見送って正解） |
| remove | リターン < 3%（除外して正解） |
| up | リターン > -3%（方向概ね正しい） |
| down | リターン < 3%（方向概ね正しい） |
| neutral | リターン ±5%以内（安定予測） |

**評価タイミング**: 毎営業日16:00 JST（市場終了後）

**API**: `POST /api/reports/recommendation-outcomes`

## AI設定

| 推奨タイプ | モデル | Temperature | 出力形式 |
|-----------|--------|-------------|----------|
| 日次おすすめ | GPT-4o-mini | 0.4 | JSON Schema |
| 購入判断 | GPT-4o-mini | 0.4 | JSON Schema |
| ポートフォリオ分析 | GPT-4o-mini | 0.3 | JSON Schema |

## プロンプト設計原則

- **ハルシネーション防止**: 提供されたニュース以外を引用しない明示的指示
- **初心者向け言語**: 専門用語 + 必ず解説を付与
- **エビデンス必須**: すべての判断に根拠を引用
- **安全優先**: AI予測よりも安全ルールを優先
- **パーソナライズ**: ユーザーの投資スタイル・予算に合わせた文脈

## 関連ファイル

- `app/api/recommendations/generate-daily/route.ts` - 日次おすすめ生成
- `app/api/featured-stocks/route.ts` - おすすめ銘柄取得
- `lib/purchase-recommendation-core.ts` - 購入判断ロジック
- `lib/style-analysis.ts` - 投資スタイル別セーフティルール
- `lib/recommendation-scoring.ts` - スコアリング
- `lib/stock-safety-rules.ts` - 安全ルール
- `lib/outcome-utils.ts` - 結果追跡ユーティリティ
- `lib/prompts/daily-recommendation-prompt.ts` - 日次おすすめプロンプト
- `lib/prompts/purchase-recommendation-prompt.ts` - 購入判断プロンプト
- `lib/prompts/portfolio-analysis-prompt.ts` - ポートフォリオ分析プロンプト
