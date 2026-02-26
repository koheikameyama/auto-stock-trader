# Daily Market Navigator 設計書

## 概要

既存の「ポートフォリオ総評」を完全に置き換え、「市況 + ポートフォリオ健康診断 + Buddyメッセージ」をセットで提供する新機能。

ユーザーがアプリを開いた瞬間に「今日は市場がこうだから、あなたの持ち株はこう対処すべき」という結論から伝える設計。

### コンセプト

- **市場俯瞰（マクロ）**: 日経平均、セクター騰落率から「今日の地合い」を定義
- **ポートフォリオ照合（ミクロ）**: 全保有銘柄の状態と市場の流れを突き合わせ
- **結論（Buddy）**: 投資スタイルに合わせて「攻める日」か「守る日」か断定

### 差別化

kaviewが「起きたことの記録」なら、Stock Buddyは「起きたこと + あなたへの影響 + 次の一手」をセットで提供する。

---

## データモデル

### PortfolioOverallAnalysis テーブル（改修）

**残すカラム:**
- `id`, `userId`, `analyzedAt`
- `totalValue`, `totalCost`, `unrealizedGain`, `unrealizedGainPercent`
- `portfolioVolatility`, `sectorConcentration`, `sectorCount`

**削除するカラム:**
- `overallSummary`, `overallStatus`, `overallStatusType`
- `metricsAnalysis`, `actionSuggestions`
- `watchlistSimulation`, `dailyCommentary`

**追加するカラム:**

| カラム | 型 | 説明 |
|--------|------|------|
| `marketHeadline` | String | 市況ヘッドライン（1文） |
| `marketTone` | String | `bullish` / `bearish` / `neutral` / `sector_rotation` |
| `marketKeyFactor` | String | 主要因（1-2文） |
| `portfolioStatus` | String | `healthy` / `caution` / `warning` / `critical` |
| `portfolioSummary` | String | ポートフォリオ健康診断（1-2文） |
| `actionPlan` | String | スタイル別アクション提案（1-2文） |
| `buddyMessage` | String | 寄り添いメッセージ（1文） |
| `stockHighlights` | Json | 注目銘柄の値動き詳細 |
| `sectorHighlights` | Json | セクター動向詳細 |

---

## API設計

### エンドポイント

`GET/POST /api/portfolio/overall-analysis`（既存を改修）

### GETレスポンス

```json
{
  "hasAnalysis": true,
  "analyzedAt": "2026-02-26T06:30:00Z",
  "isToday": true,
  "market": {
    "headline": "米ハイテク株安を受け、国内半導体セクターに利益確定売り",
    "tone": "bearish",
    "keyFactor": "米エヌビディアの決算後の反応が鈍く、国内関連銘柄にも波及"
  },
  "portfolio": {
    "status": "caution",
    "summary": "保有3銘柄中2銘柄が逆指値付近に到達しています。",
    "actionPlan": "慎重派設定に基づき、A銘柄の半分利確とB銘柄の損切り準備を優先してください。",
    "metrics": {
      "totalValue": 1500000,
      "totalCost": 1400000,
      "unrealizedGain": 100000,
      "unrealizedGainPercent": 7.14,
      "portfolioVolatility": 25.3,
      "sectorConcentration": 45.2,
      "sectorCount": 3
    }
  },
  "buddyMessage": "今日は無理に動く必要はありません。嵐が過ぎるのを待つのも立派な戦略ですよ。",
  "details": {
    "stockHighlights": [
      {
        "stockName": "トヨタ自動車",
        "tickerCode": "7203",
        "sector": "輸送用機器",
        "dailyChangeRate": -2.3,
        "weekChangeRate": -5.1,
        "analysis": "半導体不足の影響で生産台数減少の見通し"
      }
    ],
    "sectorHighlights": [
      {
        "sector": "半導体",
        "avgDailyChange": -3.2,
        "trendDirection": "down",
        "compositeScore": -45,
        "commentary": "米ハイテク株安の連鎖で大幅下落"
      }
    ]
  }
}
```

---

## AIプロンプト設計

### 渡すコンテキスト

**市場データ（マクロ）:**
- 日経平均（`getNikkei225Data()` - 株価、週間変化率、トレンド方向）
- 全セクタートレンド（`getAllSectorTrends()` - 騰落率、ニューススコア、トレンド方向）

**ポートフォリオデータ（ミクロ）:**
- 保有銘柄の日次・週間変化率、テクニカル指標
- セクター構成、含み損益
- 投資スタイル設定（慎重/バランス/積極）

### 思考ロジック

```
【STEP 1: 市場の流れを定義】
日経平均・セクタートレンドデータから、今日の地合いを定義：
- bullish: リスクオン（買いが買いを呼ぶ展開）
- bearish: リスクオフ（利益確定・パニック売りが先行）
- neutral: 方向感なし（様子見ムード）
- sector_rotation: セクターローテーション（資金移動中）

【STEP 2: ポートフォリオとの照合】
- 市場と逆行している銘柄の指摘
- スタイル設定に対して適切なリスク水準かチェック
- 注意すべき銘柄の特定

【STEP 3: 結論（アクション）】
投資スタイルに合わせて「攻める日」か「守る日」か断定
```

### 構造化出力（JSON Schema）

OpenAI `response_format` で構造化出力を使用。全フィールドをrequiredにして確実に生成。

---

## UIコンポーネント設計

### アプローチ: 統合カード型

ダッシュボード最上部（日経サマリーの上）に1つの大きなカードとして配置。

### カード構成

```
┌─────────────────────────────────────────────┐
│ Daily Market Navigator            2/26 15:30│
│                                              │
│ ┌──────────────────────────────────────────┐ │
│ │ [bearish badge]                          │ │
│ │ 米ハイテク株安を受け、国内半導体セクター │ │
│ │ に利益確定売り                           │ │
│ │ 米エヌビディアの決算後の反応が鈍く...    │ │
│ └──────────────────────────────────────────┘ │
│                                              │
│ ┌──────────────────────────────────────────┐ │
│ │ あなたのポートフォリオ  [caution]        │ │
│ │ 保有3銘柄中2銘柄が逆指値付近に到達。    │ │
│ │                                          │ │
│ │ 慎重派設定に基づき、A銘柄の半分利確     │ │
│ │ とB銘柄の損切り準備を優先してください    │ │
│ └──────────────────────────────────────────┘ │
│                                              │
│ ┌──────────────────────────────────────────┐ │
│ │ 今日は無理に動く必要はありません。       │ │
│ │ 嵐が過ぎるのを待つのも立派な戦略です     │ │
│ └──────────────────────────────────────────┘ │
│                                              │
│ ▼ 詳細を見る                                │
│   [注目銘柄] [セクター動向]                  │
└─────────────────────────────────────────────┘
```

### バッジの色分け

**Market Tone:**

| tone | 表示 | 色 |
|------|------|-----|
| `bullish` | リスクオン | green |
| `bearish` | リスクオフ | red |
| `neutral` | 様子見 | gray |
| `sector_rotation` | セクターローテーション | amber |

**Portfolio Status:**

| status | 表示 | 色 |
|--------|------|-----|
| `healthy` | 好調 | green |
| `caution` | 注意 | amber |
| `warning` | 警戒 | orange |
| `critical` | 要対応 | red |

### 表示条件

- ポートフォリオ + ウォッチリスト 3銘柄以上で表示
- 分析未生成時はスケルトン表示
- 詳細セクション（銘柄・セクターハイライト）は折りたたみ、デフォルト閉じ

---

## バッチ処理

既存のスケジュール（15:30 JST）をそのまま利用。

- **トリガー**: `POST /api/portfolio/overall-analysis`（CRON認証）
- **依存**: 株価更新・セクタートレンド計算後に実行
- **変更点**: プロンプトとレスポンス構造のみ。生成タイミングは変更なし

---

## 影響範囲

| ファイル | 変更内容 |
|----------|----------|
| `prisma/schema.prisma` | PortfolioOverallAnalysisテーブルのカラム変更 |
| `lib/portfolio-overall-analysis.ts` | 生成ロジック全面改修 |
| `lib/prompts/portfolio-overall-analysis-prompt.ts` | プロンプト全面改修 |
| `app/api/portfolio/overall-analysis/route.ts` | レスポンス構造変更 |
| `app/dashboard/PortfolioOverallAnalysis.tsx` → `DailyMarketNavigator.tsx` | UI全面書き換え |
| `app/dashboard/page.tsx` | 配置変更（最上部へ） |
| `messages/ja.json` | 翻訳キー追加 |
| `docs/specs/portfolio-analysis.md` | 仕様書更新 |
| `docs/specs/dashboard.md` | 仕様書更新 |

---

## スコープ外（今回は実装しない）

- 「もしも」シミュレーション（未来の市場予測）
- リアルタイム更新（ザラ場中のプッシュ通知）
- ウォッチリストシミュレーション（既存機能を一旦廃止）
