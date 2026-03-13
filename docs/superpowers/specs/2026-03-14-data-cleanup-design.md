# データクリーンアップ設計

## 背景

Railway DB容量上限は500MB。現在の年間データ増加量は約104MBで、既存のクリーンアップはNewsArticle/NewsAnalysis（90日保持）のみ。ScoringRecord（62MB/年）をはじめ、大半のテーブルにリテンションポリシーがなく、3〜5年で容量上限に達する見込み。

## 目的

全テーブルのリテンションポリシーを一元管理する週次クリーンアップジョブを新設し、DB容量を予防的に管理する。

## リテンションポリシー

| テーブル | 保持期間 | 日付カラム | 年間削減量 | 備考 |
|---------|---------|-----------|-----------|------|
| ScoringRecord | 90日 | date | ~47MB | scoring-accuracy-reportの30日ルックバックに余裕 |
| BacktestDailyResult | 180日 | date | ~6MB | モデルチューニング分析に半年分 |
| MarketAssessment | 90日 | date | ~0.5MB | 日次スナップショット |
| NewsArticle | 90日 | publishedAt | ~15MB | news-collectorから移管 |
| NewsAnalysis | 90日 | date | ~0.4MB | news-collectorから移管 |
| TradingDailySummary | 365日 | date | ~0.1MB | P&L分析に1年分 |
| StockStatusLog | 180日 | createdAt | ~0.3MB | 監査ログ |
| CorporateEventLog | 365日 | eventDate | ~0.05MB | 配当・分割イベント |
| DefensiveExitFollowUp | 90日 | exitDate | ~0.05MB | isComplete済みのみ削除対象 |
| UnfilledOrderFollowUp | 90日 | orderDate | ~0.05MB | isComplete済みのみ削除対象 |

**対象外:**
- TradingOrder / TradingPosition — トレード履歴は永続保持（年間6.25MBと小さい）
- Stock / TradingConfig — マスタデータ

**年間削減合計: 約70MB**（104MB → 約34MB/年に抑制）

## 実装構成

### 新規ファイル

```
src/lib/constants/retention.ts           ← リテンションポリシー定数
src/jobs/data-cleanup.ts                 ← クリーンアップ実行ロジック
.github/workflows/data-cleanup.yml       ← GA週次cron
scripts/run_data_cleanup.py              ← GA用Pythonスクリプト
```

### 変更ファイル

```
src/web/routes/cron.ts                   ← data-cleanup ジョブ登録
src/jobs/news-collector.ts               ← クリーンアップ処理を削除
src/lib/constants/news.ts                ← NEWS_RETENTION定数を削除
docs/specs/batch-processing.md           ← data-cleanup追記
```

## 詳細設計

### 1. リテンション定数（`src/lib/constants/retention.ts`）

```typescript
export const DATA_RETENTION = {
  SCORING_RECORD_DAYS: 90,
  BACKTEST_DAILY_RESULT_DAYS: 180,
  MARKET_ASSESSMENT_DAYS: 90,
  NEWS_ARTICLE_DAYS: 90,
  NEWS_ANALYSIS_DAYS: 90,
  TRADING_DAILY_SUMMARY_DAYS: 365,
  STOCK_STATUS_LOG_DAYS: 180,
  CORPORATE_EVENT_LOG_DAYS: 365,
  DEFENSIVE_EXIT_FOLLOWUP_DAYS: 90,
  UNFILLED_ORDER_FOLLOWUP_DAYS: 90,
} as const;
```

### 2. クリーンアップジョブ（`src/jobs/data-cleanup.ts`）

既存の news-collector クリーンアップと同じパターンで、`deleteMany` を使用。

```typescript
export async function runDataCleanup(): Promise<DataCleanupResult> {
  // 各テーブルの保持期間超過データを deleteMany
  // DefensiveExitFollowUp / UnfilledOrderFollowUp は isComplete=true のみ削除
  // 削除件数をテーブルごとに集計して返却
}
```

戻り値:

```typescript
interface DataCleanupResult {
  deletedCounts: Record<string, number>;
  totalDeleted: number;
}
```

### 3. cronルート登録（`src/web/routes/cron.ts`）

既存の cronルーティングに `data-cleanup` ジョブを追加。既存パターンと同じBearerトークン認証。

### 4. GA Workflow（`.github/workflows/data-cleanup.yml`）

- スケジュール: 毎週日曜 18:00 UTC（JST 月曜 3:00）
- Pythonスクリプトで `/api/cron/data-cleanup` を呼び出し
- 成功/失敗のSlack通知

### 5. news-collectorからの移管

`src/jobs/news-collector.ts` の `[3/3] クリーンアップ中...` セクション（NewsArticle/NewsAnalysis の deleteMany）を削除。`NEWS_RETENTION` 定数は `DATA_RETENTION.NEWS_ARTICLE_DAYS` / `DATA_RETENTION.NEWS_ANALYSIS_DAYS` に統合。

## データフロー

```
GA cron (毎週日曜 18:00 UTC)
  → scripts/run_data_cleanup.py
    → POST /api/cron/data-cleanup (CRON_SECRET認証)
      → runDataCleanup()
        → 各テーブル deleteMany (リテンション期間超過)
        → 削除件数サマリ返却
      → レスポンス返却
  → Slack通知（成功/失敗）
```

## 注意事項

- DefensiveExitFollowUp / UnfilledOrderFollowUp は `isComplete: true` のレコードのみ削除（進行中のフォローアップは保持）
- クリーンアップは週1回なので、リテンション期間は最大7日の誤差がある（許容範囲）
- news-collectorの日次クリーンアップが週次に変わるが、90日保持なので7日の差は無視できる
