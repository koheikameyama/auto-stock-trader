# Stock Buddy 仕様書

## サービス概要

**Stock Buddy** は株式投資初心者向けのAI投資アシスタントサービスです。

- **キャッチコピー**: 「任せて学んで、一緒に増やす」
- **ターゲット**: 投資初心者〜トレーダー志望（学びながら成長したい人）
- **対象市場**: 日本株（東証）

AIに判断を任せながら理由を理解できる投資体験を提供します。予算と期間を入れるだけでAIが最適な銘柄を提案し、専門用語も解説付きで学びながら成長できます。

## コアバリュー

| 価値 | 説明 |
|------|------|
| **寄り添う** | AIコーチが毎日優しく声をかける。専門用語には必ず解説を添える |
| **学べる** | テクニカル分析を解説付きで提供。使いながら投資知識が自然と身につく |
| **シンプル** | 質問は最小限（予算と期間）。選択肢を増やして迷わせない |
| **安心** | シミュレーション機能で練習可能。初心者向けスコアで優良銘柄を提案 |

## 設計思想

### AIとルールの役割分担

「危ない株は人間がルールで止め、チャンスの株はAIが見つける」

- **AIの役割**: チャンス発見（おすすめ銘柄、買いシグナル、ポジティブな材料）
- **ルールの役割**: 危険な株の検出・警告（赤字、高ボラティリティ、急落など）

### ルールベースの強制補正

| 条件 | 動作 |
|------|------|
| 急騰銘柄（週間変化率 ≥ 30%） | 買い推奨 → stay に変更 |
| 赤字 + 高ボラティリティ（volatility > 50%） | 買い推奨 → stay に変更 |

## 技術スタック

| カテゴリ | 技術 |
|----------|------|
| フロントエンド | Next.js 14 (App Router), TypeScript, TailwindCSS |
| バックエンド | Next.js API Routes |
| データベース | PostgreSQL (Prisma ORM) |
| AI | OpenAI GPT-4o-mini（分析・推奨）, GPT-4（チャット） |
| 認証 | NextAuth.js |
| デプロイ | Railway（自動デプロイ） |
| バッチ処理 | GitHub Actions + Python スクリプト |
| 通知 | Web Push API |
| 国際化 | next-intl（日本語） |
| ニュース | Tavily API（ニュース取得） |
| 株価データ | yfinance（Python） |

## 制限値

| 項目 | 上限 | 定義場所 |
|------|------|----------|
| ポートフォリオ銘柄数 | 100 | `lib/constants.ts` |
| ウォッチリスト銘柄数 | 100 | `lib/constants.ts` |
| 追跡銘柄数 | 10 | `lib/constants.ts` |
| データ保持期間 | 30日 | バッチ処理で定期削除 |
| DB容量上限 | 500MB | Railway制約 |

## アーキテクチャ概要

```
┌──────────────────────────────────────────────────┐
│                  フロントエンド                      │
│         Next.js App Router (TypeScript)            │
│    Server Components + Client Components           │
│    Suspense + Skeleton Loading                     │
└───────────────┬──────────────────────────────────┘
                │
┌───────────────▼──────────────────────────────────┐
│                  API Routes                        │
│         /api/* (Next.js API Routes)                │
│    認証: NextAuth.js + CRON_SECRET                 │
└───────────────┬──────────────────────────────────┘
                │
┌───────────────▼──────────────────────────────────┐
│               データベース                          │
│         PostgreSQL (Prisma ORM)                    │
│         Railway ホスティング                        │
└──────────────────────────────────────────────────┘
                │
┌───────────────▼──────────────────────────────────┐
│              外部サービス                           │
│  OpenAI API | yfinance | Tavily | Web Push        │
└──────────────────────────────────────────────────┘
                │
┌───────────────▼──────────────────────────────────┐
│             バッチ処理                              │
│  GitHub Actions (Python スクリプト)                 │
│  1日3セッション + 定期メンテナンス                    │
└──────────────────────────────────────────────────┘
```

## データモデル概要

### ユーザー関連

| テーブル | 説明 |
|----------|------|
| `User` | ユーザー情報（認証、ロール、課金プラン） |
| `UserSettings` | 投資スタイル、予算、売却目標/撤退ライン |
| `Account` / `Session` | NextAuth.js 認証情報 |
| `PushSubscription` | プッシュ通知購読情報 |

### 銘柄管理

| テーブル | 説明 |
|----------|------|
| `Stock` | 銘柄マスタ（株価、財務指標、業績データ） |
| `PortfolioStock` | ポートフォリオ（保有銘柄 + AI分析結果） |
| `WatchlistStock` | ウォッチリスト（気になる銘柄 + 買い時通知） |
| `TrackedStock` | 追跡銘柄（株価のみ追跡、AI分析なし） |
| `Transaction` | 取引履歴（買い/売り） |

### AI分析

| テーブル | 説明 |
|----------|------|
| `StockAnalysis` | 銘柄分析（短期/中期/長期予測、売買推奨） |
| `PurchaseRecommendation` | 購入判断（buy/stay/avoid） |
| `UserDailyRecommendation` | ユーザー別日次おすすめ（5銘柄） |
| `PortfolioOverallAnalysis` | ポートフォリオ総評 |
| `RecommendationOutcome` | AI推奨の結果追跡（精度検証用） |

### 市場データ

| テーブル | 説明 |
|----------|------|
| `MarketNews` | マーケットニュース（JP/US） |
| `SectorTrend` | セクタートレンド（ニュース + 株価統合スコア） |
| `DailyFeaturedStock` | 今日の注目銘柄（全ユーザー共通） |
| `DailyMarketMover` | 日次上昇/下落ランキング |
| `PortfolioSnapshot` | 資産スナップショット（日次記録） |

### レポート

| テーブル | 説明 |
|----------|------|
| `DailyAIReport` | 日次AI精度レポート |
| `WeeklyAIReport` | 週次AI精度レポート |

### その他

| テーブル | 説明 |
|----------|------|
| `Notification` | アプリ内通知 |
| `StockRequest` | 銘柄追加リクエスト |

## 機能一覧

| 機能 | 仕様書 | 説明 |
|------|--------|------|
| ダッシュボード | [dashboard.md](dashboard.md) | ポートフォリオ概要、日経225、おすすめ銘柄、セクタートレンド |
| マイ株 | [my-stocks.md](my-stocks.md) | ポートフォリオ・ウォッチリスト・追跡銘柄・売却済み管理 |
| ポートフォリオ分析 | [portfolio-analysis.md](portfolio-analysis.md) | 資産推移グラフ、損益分析、AI総評 |
| 銘柄詳細 | [stock-detail.md](stock-detail.md) | チャート、テクニカル分析、財務指標、ニュース |
| AIレコメンド | [ai-recommendations.md](ai-recommendations.md) | 日次おすすめ、購入判断、ポートフォリオ分析 |
| 市場ランキング | [market-movers.md](market-movers.md) | 日次上昇/下落ランキング + AI原因分析 |
| ニュース | [news.md](news.md) | JP/USマーケットニュース、セクタートレンド |
| AIレポート | [ai-report.md](ai-report.md) | AI精度レポート、推奨結果追跡 |
| AIチャット | [ai-chat.md](ai-chat.md) | ツール連携AIチャット |
| 通知 | [notifications.md](notifications.md) | プッシュ通知、アプリ内通知 |
| 設定・認証 | [settings.md](settings.md) | 投資スタイル、予算、通知設定 |
| バッチ処理 | [batch-processing.md](batch-processing.md) | GitHub Actions定期実行、データパイプライン |
| 管理画面 | [admin.md](admin.md) | 銘柄マスタ管理、上場廃止管理 |

## 日付の取り扱い

- **DB保存**: UTC形式
- **日付境界**: JST 00:00:00（日本時間の深夜0時）
- **日付操作**: dayjs + timezone プラグイン
- **共通ユーティリティ**: `lib/date-utils.ts`（`getTodayForDB()`, `getDaysAgoForDB()`）

## 認証方式

- NextAuth.js によるセッションベース認証
- ロール: `user`（一般）/ `admin`（管理者）
- CRON認証: `CRON_SECRET` ヘッダーによるバッチ処理認証
- 利用規約/プライバシーポリシーの同意管理
