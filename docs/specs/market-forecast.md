# 市場予想（Market Forecast）仕様

## 概要

大引け後に翌営業日の日本株市場見通しをAI（OpenAI gpt-4o-mini）で生成する機能。
既存の市場データ + Google Newsヘッドラインを入力として、自然言語の予想レポートを生成・DB保存・Slack通知・ダッシュボード表示する。

## 実行タイミング

| タイミング | 時刻 | 予測対象 | ワークフロー |
|-----------|------|---------|-------------|
| **朝（morning）** | 8:00 JST | 当日 | `cronjob_morning-analysis.yml` |
| **夕方（evening）** | 15:50 JST | 翌営業日 | `cronjob_end-of-day.yml` → `reusable_market-forecast.yml` |

- 休場日・システム停止時はスキップ
- 朝: news-collect → market-assessment → market-forecast（--morning）の順で実行
- 夕方: end-of-day → news-collect → market-forecast の順で実行

## データフロー

```
fetchMarketData() → 市場指標（VIX, N225, 米国指標, CME先物, USDJPY）
prisma.marketAssessment → 当日のレジーム・センチメント
fetchMarketNews(15) → Google News RSSヘッドライン
StockDailyBar → N225 SMA50（参考情報として表示）
    ↓
OpenAI gpt-4o-mini（JSON mode）
    ↓
prisma.marketForecast.upsert → DB保存
notifyMarketForecast() → Slack通知
```

## 入力データ

### 市場指標（fetchMarketData）

| 指標 | 用途 |
|------|------|
| 日経225 | 終値・前日比% |
| VIX | ボラティリティ水準 |
| S&P500, NASDAQ, ダウ, SOX | 米国市場の前日動向 |
| USD/JPY | 為替動向 |
| CME日経先物 | 翌日ギャップの示唆 |

### 市場評価（MarketAssessment）

当日の `shouldTrade`、`sentiment`、`reasoning` を参照。

### N225 SMA50

SMA50と現値の位置関係を参考情報として表示（「現値はSMA50の上/下」）。トレード可否の判断には使用しない。
※ SMA50フィルターは2026-04-01に廃止。WF検証でbreadth73%+他ゲートで十分と判定。

### ニュースヘッドライン

Google News RSSから最大15件取得。カテゴリ自動分類（地政学/セクター/市場）。

## AI出力フォーマット

```json
{
  "outlook": "bullish | neutral | bearish",
  "confidence": 3,
  "summary": "2〜3文の予想サマリー（日本語）",
  "keyFactors": [
    { "factor": "要因の説明", "impact": "positive | negative | neutral" }
  ],
  "risks": [
    { "risk": "リスクの説明", "severity": "high | medium | low" }
  ],
  "tradingHints": "ブレイクアウト・ギャップアップ戦略へのヒント"
}
```

## データモデル

```prisma
model MarketForecast {
  id          String   @id @default(cuid())
  date        DateTime @db.Date        // 予想対象日（翌営業日）
  generatedAt DateTime @default(now())
  marketData     Json     // MarketSnapshot
  newsHeadlines  Json?    // NewsHeadline[]
  outlook     String      // bullish / neutral / bearish
  confidence  Int         // 1-5
  summary     String   @db.Text
  keyFactors  Json        // [{factor, impact}]
  risks       Json        // [{risk, severity}]
  tradingHints String? @db.Text
  @@unique([date])
  @@index([date(sort: Desc)])
}
```

## ダッシュボード（/forecast）

### 最新予想カード

- outlook バッジ（🟢 bullish / 🟡 neutral / 🔴 bearish）
- 確信度（★☆表示）
- サマリーテキスト
- 注目ポイント（keyFactors）一覧
- リスク要因（risks）一覧
- トレーディングヒント
- ニュースヘッドライン（折りたたみ）

### 過去の予想一覧

日付・outlook・confidence のテーブル形式で履歴表示。

## ニュースページ（/news）

DBに保存されたニュース記事を表示（直近48時間）。
カテゴリバッジ（地政学/セクター/市場）+ タイトル + 日時 + ソース。

## ニュース取得ジョブ（news-collect）

Google News RSSからニュースを取得し `NewsArticle` テーブルに保存する軽量ジョブ。
`contentHash`（SHA-256）で重複排除。market-forecast の前に実行。

## Slack通知

outlook絵文字（🟢🟡🔴）+ 確信度★ + サマリー + 注目ポイント + リスク要因 + VIX/N225/USDJPY フィールド。

## ファイル構成

| ファイル | 役割 |
|---------|------|
| `src/lib/openai.ts` | OpenAI SDK薄ラッパー（gpt-4o-mini、JSON mode） |
| `src/core/news-fetcher.ts` | Google News RSSパーサー + DB保存/読み込み |
| `src/jobs/news-collect.ts` | ニュース取得専用ジョブ |
| `src/jobs/market-forecast.ts` | メインジョブ（morning/evening対応） |
| `src/web/routes/forecast.ts` | /forecast ページ |
| `src/web/routes/news.ts` | /news ページ |
| `.github/workflows/reusable_market-forecast.yml` | GitHub Actions定時実行 |

## API エンドポイント

```
POST /api/cron/market-forecast
```

cron-job.org または GitHub Actions から呼び出し。Bearer CRON_SECRET で認証。
