# バッチ処理 仕様書

## 概要

GitHub Actionsで定期実行されるバッチ処理群です。株価データ取得、AI分析生成、データメンテナンスを自動化します。

## 日次データフロー

```
SESSION (09:00 / 12:30 / 15:30 JST) ── session-batch.yml

  Phase 1: データ取得（並列）
  ├─ fetch-news（朝: JP+US / 昼・引け: JP）
  └─ fetch-stock-prices（全銘柄の株価更新）

  Phase 2: セクタートレンド計算
  └─ calculate-sector-trends（Phase 1 完了後）

  Phase 3: 分析ジョブ群（並列、Phase 2 完了後）
  ├─ purchase-recommendations（常に）
  ├─ portfolio-analysis（常に）
  ├─ personal-recommendations（常に）
  ├─ gainers-losers（引けのみ）
  ├─ portfolio-snapshots（引けのみ）
  └─ daily-market-navigator（朝・引けのみ）

  Phase 4: 通知
  └─ notify（プッシュ通知 + Slack）

独立バッチ（セッション外）
├─ 06:00: 業績データ取得（7日ローテーション）
├─ 07:00: 事業内容取得（30日ローテーション）
├─ 09:00/15:30: 取引時間通知
├─ 10:00: OpenAI使用量チェック
├─ 16:00: 推奨結果評価
└─ 18:00: AI精度レポート生成

WEEKLY
└─ 日曜 03:00: 古いデータ削除

MONTHLY
└─ 1日 09:00: JPX銘柄マスタ同期
```

## cron-job.org スケジュール

セッション系は3トリガーに集約:

| JST | ワークフロー | 入力 |
|-----|------------|------|
| 09:00 | session-batch | session=morning |
| 12:30 | session-batch | session=noon |
| 15:30 | session-batch | session=close |

## ワークフロー一覧

### 1. 株価分析オーケストレーター（session-batch.yml）

cron-job.org から `workflow_dispatch` でセッション（morning/noon/close）を指定してトリガー。

**実行フロー（`needs` で順序保証）**:

```
fetch-news + fetch-stock-prices（並列）
  → calculate-sector-trends
    → 分析ジョブ群（並列）
      → notify
```

**子ワークフロー一覧**:

| ワークフロー | 処理 | セッション条件 |
|-------------|------|--------------|
| `session-fetch-news.yml` | ニュース取得 | 常に（朝: JP+US / 昼・引け: JP） |
| `session-fetch-stock-prices.yml` | 株価更新 | 常に |
| `session-calculate-sector-trends.yml` | セクタートレンド計算 | 常に |
| `session-purchase-recommendations.yml` | 購入判断生成 | 常に |
| `session-portfolio-analysis.yml` | ポートフォリオ分析 | 常に |
| `session-personal-recommendations.yml` | おすすめ銘柄生成 | 常に |
| `session-gainers-losers.yml` | 市場ランキング生成 | close のみ |
| `session-portfolio-snapshots.yml` | 資産スナップショット | close のみ |
| `session-daily-market-navigator.yml` | ポートフォリオ総評 | morning + close |

各ワークフローは `workflow_dispatch` で単独実行も可能。

### 2. 業績データ取得（fetch-earnings.yml）

| スケジュール | JST |
|-------------|-----|
| `0 21 * * *` | 06:00 |

**ローテーション**: 全銘柄を7日で分割取得（1日あたり約200-300銘柄）

**取得項目**: 売上高、純利益、EPS、成長率、黒字/赤字、利益トレンド、次回決算日

### 3. 事業内容取得（fetch-business-descriptions.yml）

| スケジュール | JST |
|-------------|-----|
| `0 22 * * *` | 07:00 |

**ローテーション**: 全銘柄を30日で分割（1日あたり約150銘柄）

**処理**: yfinanceで英語取得 → OpenAIで日本語翻訳（Producer-Consumerパイプライン）

### 4. 株価アラート（price-alerts.yml）

| スケジュール | JST |
|-------------|-----|
| 15分間隔（`0,15,30,45 0-6 * * 1-5`） | 09:00-15:30 |

**監視項目**:
- 急騰: +5%
- 急落: -5%
- 目標価格到達
- 撤退ライン到達

**除外**: 昼休み（11:30-12:30）、取引時間外

### 5. 推奨結果評価（evaluate-outcomes.yml）

| スケジュール | JST |
|-------------|-----|
| `0 7 * * 1-5` | 16:00 |

**評価内容**: 過去の推奨に対して1日/3日/7日/14日後のリターンを計算

### 6. AI精度レポート（ai-accuracy-report.yml）

| スケジュール | JST |
|-------------|-----|
| `0 9 * * 1-5` | 18:00 |

**内容**: 過去7日間の推奨精度を集計、OpenAIで改善提案を生成

### 7. データクリーンアップ（cleanup-old-data.yml）

| スケジュール | JST |
|-------------|-----|
| `0 18 * * 6` | 日曜 03:00 |

**対象テーブル（30日以上のデータを削除）**:
- StockAnalysis
- PurchaseRecommendation
- UserDailyRecommendation
- MarketNews
- SectorTrend

**後処理**: VACUUM（ディスク容量回収）

**目的**: Railway DB容量上限（500MB）の管理

### 8. JPX銘柄マスタ週次更新（jpx-weekly-scrape.yml）

| スケジュール | JST |
|-------------|-----|
| `0 1 * * 1` | 毎週月曜 10:00 |

**内容**: JPXサイトから最新銘柄リストをスクレイピング → 銘柄マスタ更新

### 9. JPX銘柄マスタ月次同期（jpx-monthly-sync.yml）

| スケジュール | JST |
|-------------|-----|
| `0 0 1 * *` | 毎月1日 09:00 |

### 10. OpenAI使用量チェック（check-openai-usage.yml）

| スケジュール | JST |
|-------------|-----|
| `0 1 * * *` | 10:00 |

**内容**: OpenAI API使用量を確認、予算上限に近づいたらSlackアラート

### 11. 取引時間通知（trading-hours-notification.yml）

| スケジュール | JST |
|-------------|-----|
| `0 0 * * 1-5` | 09:00（開場通知） |
| `30 6 * * 1-5` | 15:30（引け通知） |

### 12. CI/CD（ci.yml）

**トリガー**: main/develop ブランチへのプッシュ

**内容**: lint, 型チェック, ビルド

## Pythonスクリプト一覧

| スクリプト | 処理 | 並列化 |
|-----------|------|--------|
| `fetch_stock_prices.py` | 株価一括更新 | yf.download（バッチ） |
| `generate_personal_recommendations.py` | 日次おすすめ生成 | API呼び出し |
| `generate_purchase_recommendations.py` | 購入判断生成 | 逐次処理 |
| `generate_portfolio_analysis.py` | ポートフォリオ分析 | API呼び出し |
| `generate_portfolio_overall_analysis.py` | ポートフォリオ総評 | API呼び出し |
| `generate_gainers_losers_analysis.py` | 市場ランキング生成 | バッチ処理 |
| `generate_portfolio_snapshots.py` | 資産スナップショット | バッチINSERT |
| `fetch_earnings_data.py` | 業績データ取得 | 7日ローテーション |
| `fetch_business_descriptions.py` | 事業内容取得+翻訳 | Producer-Consumer（5スレッド） |
| `cleanup_old_data.py` | 古いデータ削除 | 単一トランザクション |
| `check_price_alerts.py` | 株価アラート監視 | DBクエリ |
| `evaluate_recommendation_outcomes.py` | 推奨結果評価 | バッチ価格取得+更新 |
| `generate_recommendation_report.py` | AI精度レポート | ThreadPool |
| `check_openai_usage.py` | API使用量チェック | HTTP呼び出し |


### 補助指標（タイミング判断用）

`fetch_stock_prices.py` で株価取得時に以下の補助指標を算出・保存する。

| 指標 | DBカラム | 計算式 |
|------|---------|--------|
| 始値 | `latestOpen` | yfinance Open値 |
| ギャップアップ率 | `gapUpRate` | (当日始値 - 前日終値) / 前日終値 × 100 |
| 出来高急増率 | `volumeSpikeRate` | 当日出来高 / 過去平均出来高 |
| 売買代金 | `turnoverValue` | 出来高 × 終値 |
| ATR(14) | `atr` | 14日間の平均真の値幅（Average True Range） |
| チャートデータ有無 | `hasChartData` | データポイント数 ≥ `MIN_CHART_DATA_POINTS`（20） |

### チャートデータ品質フィルタ

`fetch_stock_prices.py` で株価データ取得時に、ヒストリカルデータのポイント数が `MIN_CHART_DATA_POINTS`（20）未満の銘柄は `hasChartData = false` に設定される。
取得失敗した銘柄も `hasChartData = false` になる。

`hasChartData = false` の銘柄は以下の処理から除外される:
- 日次おすすめ生成（`generate-daily`）
- 市場ランキング生成（`gainers-losers`）
- 購入判断生成（`generate_purchase_recommendations.py`）
- ポートフォリオ分析（`generate_portfolio_analysis.py`）

## Slack通知

全ワークフローに成功/失敗のSlack通知を設定。

- **成功時**: 緑色（`good`）、処理結果サマリー
- **失敗時**: 赤色（`danger`）、エラー情報
- **アクション**: `rtCamp/action-slack-notify@v2`
- **Webhook**: `secrets.SLACK_WEBHOOK_URL`

## DB操作の影響テーブル

| ワークフロー | 操作テーブル |
|-------------|-------------|
| session-batch（統合） | Stock（価格）, MarketNews, SectorTrend, PurchaseRecommendation, StockAnalysis, UserDailyRecommendation, DailyMarketMover, PortfolioSnapshot, PortfolioOverallAnalysis |
| 業績データ | Stock（業績カラム群） |
| 事業内容 | Stock.businessDescription |
| クリーンアップ | StockAnalysis, PurchaseRecommendation, UserDailyRecommendation, MarketNews, SectorTrend |
| 精度レポート | DailyAIReport |
| 結果評価 | RecommendationOutcome |
| JPX更新 | Stock（マスタカラム） |

## 関連ファイル

- `.github/workflows/` - ワークフロー定義
- `scripts/github-actions/` - Python実行スクリプト
- `scripts/lib/` - 共有ユーティリティ（DB接続、日付処理）
- `scripts/jpx/` - JPX銘柄マスタ処理
- `scripts/news/` - ニュース取得処理
