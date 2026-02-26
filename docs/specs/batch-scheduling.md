# バッチ起動順序・データ依存関係

## データ依存グラフ

```
[fetch-news]          [fetch-earnings]     [fetch-business-descriptions]
  ↓ MarketNews           ↓ Stock(業績)        ↓ Stock(事業内容)
  │                      │(独立)              │(独立)
  │    [fetch-stock-prices]
  │      ↓ Stock(価格・変化率・出来高・ATR)
  │      │
  ├──────┤
  ↓      ↓
[calculate-sector-trends]
  ↓ SectorTrend
  │
  ├─────────────────────────────────────────────────────┐
  ↓                                                     ↓
[purchase-recommendations]  [portfolio-analysis]    [daily-market-navigator]
  ↓ PurchaseRecommendation    ↓ StockAnalysis         ↓ PortfolioOverallAnalysis

[gainers-losers]           [personal-recommendations]  [portfolio-snapshots]
  ↓ DailyMarketMover         ↓ UserDailyRecommendation  ↓ PortfolioSnapshot
```

**全て session-batch.yml 内で `needs` により順序保証。**
**セッションごとに実行するジョブが異なる（`if:` で制御）。**

## テーブル別の依存関係

| テーブル | 書き込み元 | 読み取り元 |
|---------|-----------|-----------|
| **Stock（価格）** | fetch-stock-prices | ほぼ全バッチ |
| **Stock（業績）** | fetch-earnings | おすすめスコアリング、AI分析 |
| **MarketNews** | fetch-news | calculate-sector-trends, gainers-losers |
| **SectorTrend** | calculate-sector-trends | daily-market-navigator, おすすめプロンプト |
| **PurchaseRecommendation** | purchase-recommendations | フロント表示 |
| **StockAnalysis** | portfolio-analysis | フロント表示 |
| **DailyMarketMover** | gainers-losers | フロント表示 |
| **UserDailyRecommendation** | personal-recommendations | フロント表示 |
| **PortfolioOverallAnalysis** | daily-market-navigator | フロント表示 |
| **PortfolioSnapshot** | portfolio-snapshots | ポートフォリオ履歴 |

## セッション別の実行内容

| セッション | JST | 実行ジョブ |
|-----------|-----|-----------|
| pre-morning | 08:00 | news(JP+US), trends, navigator(morning) |
| morning | 09:10 | purchase, portfolio, personal |
| mid-morning | 10:10 | purchase, portfolio, personal |
| pre-afternoon | 11:40 | news(JP), prices, trends |
| afternoon | 12:40 | purchase, portfolio, personal |
| mid-afternoon | 13:40 | purchase, portfolio, personal |
| close | 15:40 | prices, trends, purchase, portfolio, personal, gainers, snapshots |
| post-close | 17:00 | navigator(evening) |

### ジョブ実行条件

| ジョブ | pre-morning | morning | mid-morning | pre-afternoon | afternoon | mid-afternoon | close | post-close |
|--------|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|
| fetch-news | JP+US | - | - | JP | - | - | - | - |
| fetch-stock-prices | - | - | - | o | - | - | o | - |
| calculate-sector-trends | o | - | - | o | - | - | o | - |
| purchase-recommendations | - | o | o | - | o | o | o | - |
| portfolio-analysis | - | o | o | - | o | o | o | - |
| personal-recommendations | - | o | o | - | o | o | o | - |
| gainers-losers | - | - | - | - | - | - | o | - |
| portfolio-snapshots | - | - | - | - | - | - | o | - |
| navigator | morning | - | - | - | - | - | - | evening |
| notify | o | o | o | o | o | o | o | o |

### 設計意図

- **pre-morning**: 最新ニュース取得 → セクタートレンド再計算 → 開場前ナビゲーター生成
- **morning / afternoon**: 分析ジョブ群（ニュースは pre セッションで取得済み）
- **mid-morning / mid-afternoon**: 分析ジョブのみ（データ更新なし）
- **pre-afternoon**: 昼の株価・セクタートレンドを更新（afternoon の分析で使用）
- **close**: 終値取得 → 全分析 + ランキング + スナップショット
- **post-close**: 夕方ナビゲーター生成（close完了後のデータを使用）

## 独立バッチ（cron-job.org）

| JST | ワークフロー |
|-----|------------|
| 06:00 | fetch-earnings |
| 07:00 | fetch-business-descriptions |
| 09:00 / 15:30 | trading-hours-notification |
| 10:00 | check-openai-usage |
| 16:00 | evaluate-outcomes |
| 18:00 | ai-accuracy-report |
