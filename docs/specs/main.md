# Auto Stock System - メイン仕様書

## システム概要

日経225主要銘柄（約90銘柄）を対象とした自動売買シミュレーションシステム。
AIによる市場分析・銘柄選定・売買判断を自動化し、Railway上の常駐Workerで運用する。

## 技術スタック

| 項目 | 技術 |
|------|------|
| ランタイム | Node.js 22 + TypeScript (tsx) |
| ORM | Prisma |
| DB | PostgreSQL (Railway) |
| AI | OpenAI GPT-4o (構造化出力) |
| 株価API | yahoo-finance2 v3 |
| スケジューラ | node-cron (JST) |
| テクニカル分析 | technicalindicators |
| 通知 | Slack Webhook |
| デプロイ | Railway (Docker) |

## ディレクトリ構成

```
src/
  worker.ts              # Railway常駐Worker（node-cronスケジューラ）
  jobs/                  # ジョブスクリプト
    market-scanner.ts    # 市場スキャン
    order-manager.ts     # 注文生成
    position-monitor.ts  # ポジション監視
    end-of-day.ts        # 日次締め
    weekly-review.ts     # 週次レビュー
    backfill-prices.ts   # 株価初期取得
  core/                  # コアモジュール
    market-data.ts       # 市場データ取得
    technical-analysis.ts # テクニカル分析
    ai-decision.ts       # AI判断
    order-executor.ts    # 注文実行
    position-manager.ts  # ポジション管理
    risk-manager.ts      # リスク管理
  prompts/               # AIプロンプト
    market-assessment.ts # 市場評価プロンプト
    stock-selection.ts   # 銘柄選定プロンプト
    trade-decision.ts    # 売買判断プロンプト
  lib/                   # ユーティリティ
    constants.ts         # 定数定義
    prisma.ts            # Prismaクライアント
    slack.ts             # Slack通知
    ticker-utils.ts      # ティッカー変換
    date-utils.ts        # 日付ユーティリティ
prisma/
  schema.prisma          # DBスキーマ
Dockerfile               # Railwayデプロイ用
```

## データモデル概要

| テーブル | 用途 |
|----------|------|
| Stock | 銘柄マスタ（90銘柄、株価・テクニカル指標を保持） |
| MarketAssessment | 日次市場評価（AI判断結果、選定銘柄リスト） |
| TradingConfig | 取引設定（予算、ポジション上限、リスク制限） |
| TradingOrder | 注文（pending→filled/expired/cancelled） |
| TradingPosition | ポジション（open→closed、損益管理） |
| TradingDailySummary | 日次サマリー（勝敗、PnL、ポートフォリオ価値） |

## デイリーデータフロー

```
8:30  market-scanner
      ├─ 市場指標取得（日経225, S&P500, NASDAQ, ダウ, SOX半導体指数, VIX, USD/JPY, CME先物）
      ├─ AI市場評価 → shouldTrade?
      ├─ NO → 保存して終了
      └─ YES → 銘柄スクリーニング → テクニカル分析 → AI銘柄選定
                                                      ↓
9:30  order-manager
      ├─ 選定銘柄ごとにAI売買判断
      ├─ リスクチェック
      └─ 注文生成（pending）
                ↓
9:00-15:00  position-monitor（毎分実行）
      ├─ 期限切れ注文の処理
      ├─ 約定チェック（limit/stop条件）
      ├─ ポジション監視（利確/損切）
      └─ 14:50以降: デイトレード強制決済
                ↓
15:50  end-of-day
      ├─ 残デイトレード強制決済
      ├─ 未約定注文キャンセル
      ├─ 日次サマリー生成
      └─ AI日次レビュー

土曜 10:00  weekly-review
      ├─ 週間集計（勝率、PnL）
      └─ AI戦略レビュー
```

## 環境変数

| 変数名 | 用途 |
|--------|------|
| DATABASE_URL | PostgreSQL接続文字列 |
| OPENAI_API_KEY | OpenAI APIキー |
| SLACK_WEBHOOK_URL | Slack通知用Webhook |

## 仕様書一覧

| 仕様書 | 内容 |
|--------|------|
| [main.md](main.md) | 本書（システム概要） |
| [batch-processing.md](batch-processing.md) | ジョブスケジュール・各ジョブの詳細仕様 |
| [core-modules.md](core-modules.md) | コアモジュール（市場データ、テクニカル分析、AI判断、注文、ポジション、リスク管理） |
| [trading-architecture.md](trading-architecture.md) | トレーディングアーキテクチャ改善（ロジック主導+AI最終審判） |
| [backtest.md](backtest.md) | バックテスト（ロジック層シミュレーション・感度分析） |
| [broker-api-migration.md](broker-api-migration.md) | 立花証券API移行ガイド（シミュレーション → リアル取引） |
