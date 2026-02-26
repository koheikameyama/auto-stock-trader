# バッチ処理 仕様書

## 概要

GitHub Actionsで定期実行されるバッチ処理群です。株価データ取得、AI分析生成、データメンテナンスを自動化します。

## 日次データフロー

```
MORNING (07:00-09:00 JST)
├─ 07:00: 業績データ取得（7日ローテーション）
├─ 07:00: 事業内容取得（30日ローテーション）
├─ 07:30: ニュース取得（JP + US）
└─ 09:00: 取引開始通知

SESSION 1: 朝 (09:00 JST)
├─ 株価更新
├─ セクタートレンド計算
├─ 購入判断生成（ウォッチリスト）
├─ ポートフォリオ分析
└─ 日次おすすめ生成

SESSION 2: 昼 (12:30 JST)
├─ 株価更新
├─ セクタートレンド計算
├─ 購入判断生成（ウォッチリスト）
├─ ポートフォリオ分析
└─ 日次おすすめ生成

SESSION 3: 引け (15:30 JST)
├─ 株価更新
├─ セクタートレンド計算
├─ 購入判断生成（ウォッチリスト）
├─ ポートフォリオ分析
├─ ポートフォリオ総評（引けのみ）
├─ 市場ランキング生成（引けのみ）
├─ 資産スナップショット（引けのみ）
└─ 日次おすすめ生成

16:00 JST: 推奨結果評価
18:00 JST: AI精度レポート生成

WEEKLY
└─ 日曜 03:00 JST: 古いデータ削除

MONTHLY
└─ 1日 09:00 JST: JPX銘柄マスタ同期
```

## ワークフロー一覧

### 1. 注目銘柄生成（featured-stocks.yml）

| スケジュール | JST |
|-------------|-----|
| `0 0 * * 1-5` | 09:00 |
| `30 3 * * 1-5` | 12:30 |
| `35 6 * * 1-5` | 15:35 |

**ジョブ構成**:
1. `determine-session` - JST時刻からセッション判定
2. `fetch-stock-prices` - 全銘柄の株価更新（yfinance一括）
3. `personal-recommendations` - ユーザー別おすすめ生成
4. `notify` - Slack通知

**呼び出しAPI**: `POST /api/recommendations/generate-daily`

### 2. 株価分析（stock-predictions.yml）

| スケジュール | JST |
|-------------|-----|
| `0 0 * * 1-5` | 09:00 |
| `30 3 * * 1-5` | 12:30 |
| `30 6 * * 1-5` | 15:30 |

**ジョブ構成**:
1. `determine-time` - JST時刻判定
2. `calculate-sector-trends` - セクタートレンド計算
3. `purchase-recommendations` - ウォッチリスト購入判断
4. `portfolio-analysis` - ポートフォリオ銘柄分析
5. `portfolio-overall`（引けのみ）- ポートフォリオ総評
6. `gainers-losers`（引けのみ）- 市場ランキング
7. `portfolio-snapshots`（引けのみ）- 資産スナップショット
8. `notify` - プッシュ通知 + Slack通知

### 3. 業績データ取得（fetch-earnings.yml）

| スケジュール | JST |
|-------------|-----|
| `0 21 * * *` | 06:00 |

**ローテーション**: 全銘柄を7日で分割取得（1日あたり約200-300銘柄）

**取得項目**: 売上高、純利益、EPS、成長率、黒字/赤字、利益トレンド、次回決算日

### 4. ニュース取得（fetch-news.yml）

| スケジュール | JST | 対象 |
|-------------|-----|------|
| `30 22 * * *` | 07:30 | JP + US |
| `0 3 * * 1-5` | 12:00 | JP のみ |

### 5. 事業内容取得（fetch-business-descriptions.yml）

| スケジュール | JST |
|-------------|-----|
| `0 22 * * *` | 07:00 |

**ローテーション**: 全銘柄を30日で分割（1日あたり約150銘柄）

**処理**: yfinanceで英語取得 → OpenAIで日本語翻訳（Producer-Consumerパイプライン）

### 6. 株価アラート（price-alerts.yml）

| スケジュール | JST |
|-------------|-----|
| 15分間隔（`0,15,30,45 0-6 * * 1-5`） | 09:00-15:30 |

**監視項目**:
- 急騰: +5%
- 急落: -5%
- 目標価格到達
- 撤退ライン到達

**除外**: 昼休み（11:30-12:30）、取引時間外

### 7. 推奨結果評価（evaluate-outcomes.yml）

| スケジュール | JST |
|-------------|-----|
| `0 7 * * 1-5` | 16:00 |

**評価内容**: 過去の推奨に対して1日/3日/7日/14日後のリターンを計算

### 8. AI精度レポート（recommendation-report.yml）

| スケジュール | JST |
|-------------|-----|
| `0 9 * * 1-5` | 18:00 |

**内容**: 過去7日間の推奨精度を集計、OpenAIで改善提案を生成

### 9. データクリーンアップ（cleanup-old-data.yml）

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

### 10. JPX銘柄マスタ更新（jpx-stock-update.yml）

| スケジュール | JST |
|-------------|-----|
| `0 1 * * 1` | 毎週月曜 10:00 |

**内容**: JPXサイトから最新銘柄リストをスクレイピング → 銘柄マスタ更新

### 11. JPX銘柄マスタ月次同期（sync-jpx-master.yml）

| スケジュール | JST |
|-------------|-----|
| `0 0 1 * *` | 毎月1日 09:00 |

### 12. OpenAI使用量チェック（check-openai-usage.yml）

| スケジュール | JST |
|-------------|-----|
| `0 1 * * *` | 10:00 |

**内容**: OpenAI API使用量を確認、予算上限に近づいたらSlackアラート

### 13. 取引時間通知（trading-hours-notification.yml）

| スケジュール | JST |
|-------------|-----|
| `0 0 * * 1-5` | 09:00（開場通知） |
| `30 6 * * 1-5` | 15:30（引け通知） |

### 14. CI/CD（ci.yml）

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

## Slack通知

全ワークフローに成功/失敗のSlack通知を設定。

- **成功時**: 緑色（`good`）、処理結果サマリー
- **失敗時**: 赤色（`danger`）、エラー情報
- **アクション**: `rtCamp/action-slack-notify@v2`
- **Webhook**: `secrets.SLACK_WEBHOOK_URL`

## DB操作の影響テーブル

| ワークフロー | 操作テーブル |
|-------------|-------------|
| 注目銘柄生成 | UserDailyRecommendation |
| 株価分析 | PurchaseRecommendation, StockAnalysis, DailyMarketMover, PortfolioSnapshot |
| 業績データ | Stock（業績カラム群） |
| ニュース | MarketNews, SectorTrend |
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
