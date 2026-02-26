# ポートフォリオ分析 仕様書

## 概要

ポートフォリオ分析はユーザーの保有銘柄全体を評価する機能です。個別銘柄のAI分析と、ポートフォリオ全体の総評を提供します。

**ページパス**: `/portfolio-analysis`

## 分析の種類

### 1. 個別銘柄分析（PortfolioStock単位）

保有銘柄ごとにAIが売買判断を生成します。

**分析に使用するデータ**:
- 株価データ（30日分のOHLCV）
- テクニカル指標（RSI, MACD, 移動平均乖離率）
- チャートパターン（逆三尊、ダブルボトム等）
- 出来高分析
- 財務指標（PER, PBR, ROE, 配当利回り）
- 関連ニュース（7日分）
- セクタートレンド
- 日経225の動向
- ユーザー設定（投資スタイル、売却目標/撤退ライン）

**AI出力スキーマ**:

```json
{
  "marketSignal": "bullish | neutral | bearish",
  "shortTerm": "短期分析テキスト",
  "mediumTerm": "中期分析テキスト",
  "longTerm": "長期分析テキスト",
  "shortTermTrend": "up | neutral | down",
  "shortTermPriceLow": 2300,
  "shortTermPriceHigh": 2600,
  "recommendation": "buy | hold | sell",
  "suggestedSellPrice": 2500,
  "suggestedSellPercent": 50,
  "sellReason": "売却理由",
  "sellCondition": "売却条件",
  "advice": "アドバイステキスト",
  "confidence": 0.85,
  "isCriticalChange": false,
  "reconciliationMessage": null
}
```

**安全補正ルール（AIの判断をルールベースで上書き）**:

| ルール | 条件 | 動作 |
|--------|------|------|
| パニック売り防止 | MA乖離率 ≤ -20% | sell → hold に変更 |
| 急騰銘柄保護 | 週間変化率がスタイル別閾値以上（慎重派+20%/バランス+25%/積極派+50%） | buy → hold に変更 |
| 危険銘柄ブロック | 赤字 + ボラティリティ > 50% | buy → hold に変更 |
| 上場廃止強制 | isDelisted = true | 強制 sell |
| 中長期上昇時のsell抑制 | スタイル別: 慎重派は長期upのみ保護（※含み益+3%以上 + 短期下落予兆時は保護無効化）、バランスは中期or長期up、積極派は保護なし（損失 > -15%の場合のみ） | sell → hold に変更 |
| 直近購入保護 | 購入から7日未満 | sell をブロック（isCriticalChange時のみ許可） |
| 相対強度保護 | 市場比+5%以上のアウトパフォーム | 地合い要因として sell をブロック |
| 利益確定促進 | 含み益あり + 短期下落予兆（shortTermTrend=down）。慎重派: +3%以上、バランス型: +8%以上、積極派: +15%以上 | hold → sell（戻り売り）に変更。慎重派は75%売却、バランス型は50%売却、積極派は25%売却を推奨 |

**投資スタイル別分析（styleAnalyses）**:

AIが1回のAPIコールで3つの投資スタイル（慎重派/バランス型/積極派）ごとに異なる判断（recommendation/confidence/advice/shortTerm/sellReason/sellCondition/suggestedSellPercent）を直接生成します。各スタイルの判断傾向:

| スタイル | 判断傾向 | アドバイスのトーン |
|----------|----------|-------------------|
| 慎重派（CONSERVATIVE） | 早めの売却目標・狭い撤退ライン、suggestedSellPercent は高め（75-100%）。ただしリスク・リワード比1:3以上ならhold継続・反発シナリオを提示。adviceで最大損失率を明示 | 「リスクは限定的です。撤退ラインを厳守しつつ慎重に判断しましょう。」 |
| バランス型（BALANCED） | 中期トレンドで判断、部分売却でバランスを取る。トレンド転換（ゴールデンクロス、RSI回復）を重視 | 「中期的な回復の兆しがあります。標準的なポジションで利益を狙えます。」 |
| 積極派（AGGRESSIVE） | 利益最大化、suggestedSellPercent は低め（25-50%）、買い増しも積極的。モメンタム（出来高急増+高値突破）を重視 | 「勢いに乗りましょう。上値追いのチャンスです。」 |

**慎重派のリスク限定型判断**:
- adviceで「最悪のケースの最大損失率・概算損失額」を明示した上で保有継続・売却の判断理由を説明
- リスク・リワード比1:3以上かつ支持線が維持されている → 含み損でもhold継続を許容し反発シナリオを提示
- 赤字銘柄でもセクター全体に買いが入っていれば「地合いを味方につけた短期戦」としてhold継続を提案可能（cautionで業績リスクに必ず言及）

AI生成後、非スタイル依存の安全補正（上記テーブルの大半）を全スタイルに適用し、さらにスタイル依存のセーフティルールを適用:

| スタイル依存補正 | 条件（スタイルにより閾値が異なる） | 動作 |
|------------------|--------------------------------------|------|
| 急騰銘柄の買い増し抑制 | `isSurgeStock(weekChangeRate, style)` | buy → hold に変更 |

スタイル別の結果は `StockAnalysis.styleAnalyses` に JSON として保存され、フロントエンドでタブ切り替えにより比較表示できます。ユーザーの設定した投資スタイルがデフォルトタブとして表示されます。

シミュレーション分析（`executeSimulatedPortfolioAnalysis`）でも同様に投資スタイル別分析を生成し、`styleAnalyses` としてレスポンスに含めます（DBには保存しません）。

### 2. Daily Market Navigator（ポートフォリオ総評）

ポートフォリオ全体を市場の流れと照合して、今日何をすべきかを断定するカード型UIです。「ポートフォリオ総評」を完全に置き換えたコア機能です。

**前提条件**: ポートフォリオ + ウォッチリスト合計3銘柄以上

**表示場所**:
- `/dashboard` の最上部
- `/portfolio-analysis`（専用ページ）

**分析に使用するデータ**:
- セクター構成・集中率
- 含み損益・総資産額・投資額
- ポートフォリオ全体のボラティリティ（加重平均）
- 業績状況（黒字銘柄数、増益/減益傾向）
- 銘柄別の日次値動き（前日比・週間変化率・MA乖離・出来高比）
- 本日の売却取引
- ポートフォリオ内セクターのセクタートレンド
- 今後7日間の決算予定銘柄
- ユーザーの投資スタイル

**3ステップ思考ロジック**:

| ステップ | 内容 |
|---------|------|
| STEP 1: 市場の流れを定義 | セクタートレンド・値動きデータから今日の地合いを `bullish / bearish / neutral / sector_rotation` の1つに定義 |
| STEP 2: ポートフォリオとの照合 | 保有銘柄と市場の流れを突き合わせ、逆行銘柄・リスク水準・要注意銘柄を特定 |
| STEP 3: 結論（アクション） | 投資スタイルに合わせて「攻める日」か「守る日」かを断定。曖昧な表現を避け具体的なアクションを提示 |

**AI出力スキーマ**:

```json
{
  "marketHeadline": "市況を1文で要約したテキスト",
  "marketTone": "bullish | bearish | neutral | sector_rotation",
  "marketKeyFactor": "市場の主要因（1〜2文）",
  "portfolioStatus": "healthy | caution | warning | critical",
  "portfolioSummary": "ポートフォリオの状態（1〜2文）",
  "actionPlan": "投資スタイルに基づく具体的なアクション（1〜2文）",
  "buddyMessage": "親しみやすい口調で初心者を勇気づける1文",
  "stockHighlights": [
    {
      "stockName": "銘柄名",
      "tickerCode": "7203.T",
      "sector": "輸送用機器",
      "dailyChangeRate": -2.3,
      "weekChangeRate": 1.5,
      "analysis": "値動きの分析テキスト"
    }
  ],
  "sectorHighlights": [
    {
      "sector": "半導体",
      "avgDailyChange": -3.1,
      "trendDirection": "up | down | neutral",
      "compositeScore": -25,
      "commentary": "セクター動向のコメント"
    }
  ]
}
```

**バッジの色分け**:

| 種類 | 値 | 色 |
|------|----|----|
| tone（市場トーン） | `bullish` | 緑（green） |
| tone（市場トーン） | `bearish` | 赤（red） |
| tone（市場トーン） | `neutral` | グレー（gray） |
| tone（市場トーン） | `sector_rotation` | 琥珀（amber） |
| status（ポートフォリオ状態） | `healthy` | 緑（green） |
| status（ポートフォリオ状態） | `caution` | 琥珀（amber） |
| status（ポートフォリオ状態） | `warning` | オレンジ（orange） |
| status（ポートフォリオ状態） | `critical` | 赤（red） |

**UIの構成（統合カード型）**:

| セクション | 内容 |
|-----------|------|
| Section 1: 市場 | `marketHeadline` + `marketTone` バッジ + `marketKeyFactor` |
| Section 2: ポートフォリオ | `portfolioStatus` バッジ + `portfolioSummary` + `actionPlan`（青背景） |
| Section 3: バディメッセージ | `buddyMessage`（紫背景の吹き出し） |
| Section 4: 詳細（折りたたみ） | `stockHighlights`（銘柄ハイライト）+ `sectorHighlights`（セクターハイライト） |
| フッター | 分析日時 |

## API仕様

### 個別銘柄分析

#### `GET /api/stocks/[stockId]/portfolio-analysis`

最新の分析結果を取得。

#### `POST /api/stocks/[stockId]/portfolio-analysis`

新しい分析を生成。

**認証**: セッション認証 or CRON_SECRET

### Daily Market Navigator

#### `GET /api/portfolio/overall-analysis`

キャッシュされた Daily Market Navigator の分析を取得。

**レスポンス**:

```json
{
  "hasAnalysis": true,
  "analyzedAt": "2026-02-26T10:00:00.000Z",
  "isToday": true,
  "portfolioCount": 3,
  "watchlistCount": 2,
  "market": {
    "headline": "半導体セクターが相場を牽引、全体的にリスクオンの展開",
    "tone": "bullish",
    "keyFactor": "外国人投資家の買い越しが続き、輸出関連銘柄に追い風"
  },
  "portfolio": {
    "status": "healthy",
    "summary": "保有銘柄の多くが市場と同じ方向に動いており、ポートフォリオは好調です",
    "actionPlan": "現在のポジションを維持しつつ、次の押し目買いのタイミングを狙ってください",
    "metrics": {
      "totalValue": 1500000,
      "totalCost": 1200000,
      "unrealizedGain": 300000,
      "unrealizedGainPercent": 25.0,
      "portfolioVolatility": 28.5,
      "sectorConcentration": 40.0,
      "sectorCount": 3
    }
  },
  "buddyMessage": "今日の市場は追い風です。焦らず、計画通りに進めましょう！",
  "details": {
    "stockHighlights": [
      {
        "stockName": "トヨタ自動車",
        "tickerCode": "7203.T",
        "sector": "輸送用機器",
        "dailyChangeRate": -2.3,
        "weekChangeRate": 1.5,
        "analysis": "円安一服を受けて利益確定売りが先行"
      }
    ],
    "sectorHighlights": [
      {
        "sector": "半導体",
        "avgDailyChange": 3.1,
        "trendDirection": "up",
        "compositeScore": 25,
        "commentary": "AI関連需要の拡大期待で買いが続く"
      }
    ]
  }
}
```

#### `POST /api/portfolio/overall-analysis`

Daily Market Navigator の分析を再生成。

**認証**: セッション認証 or CRON_SECRET

### ポートフォリオサマリー

#### `GET /api/portfolio/summary`

ポートフォリオの数値指標を取得。

**レスポンス**:
```json
{
  "totalValue": 1500000,
  "totalCost": 1200000,
  "unrealizedGain": 300000,
  "unrealizedGainPercent": 25.0,
  "realizedGain": 50000,
  "totalGain": 350000,
  "totalGainPercent": 29.2,
  "winCount": 3,
  "loseCount": 1,
  "winRate": 75.0,
  "averageReturn": 12.5
}
```

### ポートフォリオ構成

#### `GET /api/portfolio/composition`

**レスポンス**:
```json
{
  "byStock": [
    {
      "stockId": "xxx",
      "tickerCode": "7203.T",
      "name": "トヨタ自動車",
      "sector": "輸送用機器",
      "value": 500000,
      "cost": 400000,
      "percent": 33.3,
      "color": "#3B82F6"
    }
  ],
  "bySector": [
    {
      "sector": "輸送用機器",
      "value": 500000,
      "percent": 33.3,
      "stockCount": 1,
      "color": "#F97316"
    }
  ]
}
```

### 資産推移

#### `GET /api/portfolio/history?period={1m|3m|6m|1y}`

PortfolioSnapshot テーブルからの時系列データ。

## AI設定

### 個別銘柄分析

| 項目 | 値 |
|------|-----|
| モデル | OpenAI GPT-4o-mini |
| Temperature | 0.3（分析的） |
| レスポンス形式 | JSON Schema（strict mode） |
| 最大トークン | 800 |

### Daily Market Navigator

| 項目 | 値 |
|------|-----|
| モデル | OpenAI GPT-4o-mini（`DAILY_MARKET_NAVIGATOR.OPENAI_MODEL`） |
| Temperature | 0.3（`DAILY_MARKET_NAVIGATOR.OPENAI_TEMPERATURE`） |
| レスポンス形式 | JSON Schema（strict mode） |
| 最小銘柄数 | 3銘柄（ポートフォリオ＋ウォッチリスト合計、`DAILY_MARKET_NAVIGATOR.MIN_STOCKS`） |

## データモデル

### PortfolioOverallAnalysis（Daily Market Navigator）

ユーザーごとに1レコードを upsert で保存（`userId` ユニーク）。

| カラム | 型 | 説明 |
|--------|-----|------|
| userId | String | ユーザーID（ユニーク） |
| analyzedAt | DateTime | 分析日時 |
| sectorConcentration | Decimal? | 最大セクター比率(%) |
| sectorCount | Int? | セクター数 |
| totalValue | Decimal? | 総資産額 |
| totalCost | Decimal? | 総投資額 |
| unrealizedGain | Decimal? | 含み損益 |
| unrealizedGainPercent | Decimal? | 含み損益率(%) |
| portfolioVolatility | Decimal? | ポートフォリオ全体のボラティリティ(%) |
| marketHeadline | Text | 市場ヘッドライン（AI生成） |
| marketTone | String | bullish / bearish / neutral / sector_rotation |
| marketKeyFactor | Text | 市場の主要因（AI生成） |
| portfolioStatus | String | healthy / caution / warning / critical |
| portfolioSummary | Text | ポートフォリオ総評（AI生成） |
| actionPlan | Text | アクションプラン（AI生成） |
| buddyMessage | Text | バディメッセージ（AI生成） |
| stockHighlights | Json | 銘柄ハイライト（`StockHighlight[]`） |
| sectorHighlights | Json | セクターハイライト（`SectorHighlight[]`） |

**StockHighlight JSON構造**:

```json
{
  "stockName": "銘柄名",
  "tickerCode": "7203.T",
  "sector": "輸送用機器",
  "dailyChangeRate": -2.3,
  "weekChangeRate": 1.5,
  "analysis": "値動きの分析テキスト"
}
```

**SectorHighlight JSON構造**:

```json
{
  "sector": "半導体",
  "avgDailyChange": -3.1,
  "trendDirection": "up | down | neutral",
  "compositeScore": -25,
  "commentary": "セクター動向のコメント"
}
```

### PortfolioSnapshot

| カラム | 型 | 説明 |
|--------|-----|------|
| userId | String | ユーザーID |
| date | Date | スナップショット日付 |
| totalValue | Decimal | 総資産額 |
| totalCost | Decimal | 総投資額 |
| unrealizedGain | Decimal | 含み損益 |
| unrealizedGainPercent | Decimal | 損益率(%) |
| stockCount | Int | 保有銘柄数 |
| sectorBreakdown | Json? | セクター別内訳 |
| stockBreakdown | Json? | 銘柄別内訳 |

## 関連ファイル

- `app/portfolio-analysis/` - ポートフォリオ分析ページ（Daily Market Navigator を表示）
- `app/dashboard/DailyMarketNavigator.tsx` - Daily Market Navigator コンポーネント
- `app/portfolio-analysis/PortfolioAnalysisClient.tsx` - ポートフォリオ分析ページクライアント
- `app/api/portfolio/overall-analysis/route.ts` - Daily Market Navigator API
- `app/api/portfolio/summary/route.ts` - サマリー API
- `app/api/portfolio/composition/route.ts` - 構成比率 API
- `app/api/portfolio/history/route.ts` - 資産推移 API
- `lib/portfolio-overall-analysis.ts` - Daily Market Navigator ロジック（型定義・生成・取得）
- `lib/portfolio-analysis-core.ts` - 個別銘柄分析ロジック
- `lib/portfolio-calculator.ts` - 計算ロジック
- `lib/style-analysis.ts` - 投資スタイル別セーフティルール
- `lib/prompts/portfolio-analysis-prompt.ts` - 個別分析プロンプト
- `lib/prompts/portfolio-overall-analysis-prompt.ts` - Daily Market Navigator プロンプト
