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

## 実行順序（session-batch.yml 内）

```
Phase 1（並列）: fetch-stock-prices + fetch-news
  ↓ needs
Phase 2: calculate-sector-trends
  ↓ needs
Phase 3（並列）: 全分析ジョブ
  ↓ needs
Phase 4: notify
```

- fetch-stock-prices と fetch-news は互いに依存なし → **並列実行**
- Phase 3 の分析ジョブは全て Phase 2 完了後 → **並列実行**
- セッション条件（close のみ等）は `if:` で制御

## cron-job.org スケジュール

### セッション（session-batch.yml）

| JST | 入力 | 実行ジョブ |
|-----|------|-----------|
| 09:00 | session=morning | news(JP+US), prices, trends, purchase, portfolio, personal, navigator(morning) |
| 12:30 | session=noon | news(JP), prices, trends, purchase, portfolio, personal |
| 15:30 | session=close | news(JP), prices, trends, purchase, portfolio, personal, gainers, snapshots, navigator(evening) |

### 独立バッチ

| JST | ワークフロー |
|-----|------------|
| 06:00 | fetch-earnings |
| 07:00 | fetch-business-descriptions |
| 09:00 / 15:30 | trading-hours-notification |
| 10:00 | check-openai-usage |
| 16:00 | evaluate-outcomes |
| 18:00 | ai-accuracy-report |
