# データクリーンアップ設計

## 背景

Railway DB容量上限は500MB。現在の年間データ増加量は約104MBで、既存のクリーンアップはNewsArticle/NewsAnalysis（90日保持）のみ。ScoringRecord（62MB/年）をはじめ、大半のテーブルにリテンションポリシーがなく、3〜5年で容量上限に達する見込み。

## 目的

全テーブルのリテンションポリシーを一元管理する週次クリーンアップジョブを新設し、DB容量を予防的に管理する。

## リテンションポリシー

| テーブル | 保持期間 | 日付カラム | 年間削減量 | 備考 |
|---------|---------|-----------|-----------|------|
| ScoringRecord | 365日 | date | ~0MB（初年度なし） | バックテスト `LOOKBACK_MONTHS: 12` に必要。contrarian analyzerの90日ルックバックにも余裕 |
| BacktestDailyResult | 365日 | date | ~0MB（初年度なし） | 市場サイクル分析に1年分。追加コスト約3MB vs 180日 |
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

**年間削減合計: 約17MB**（初年度。2年目以降はScoringRecord/BacktestDailyResultの超過分も削除され約85MB削減）

## 実装構成

### 新規ファイル

```
src/lib/constants/retention.ts                ← リテンションポリシー定数
src/jobs/data-cleanup.ts                      ← クリーンアップ実行ロジック
.github/workflows/scheduled_data-cleanup.yml  ← GA週次cron（npm run直接実行）
```

### 変更ファイル

```
src/web/routes/cron.ts                   ← data-cleanup ジョブ登録（requiresMarketDay: false）※手動実行用
src/jobs/news-collector.ts               ← クリーンアップ処理を削除
src/lib/constants/news.ts                ← NEWS_RETENTION定数を削除
src/lib/constants/index.ts               ← retention.ts のバレルエクスポート追加
package.json                             ← "data-cleanup" スクリプト追加
docs/specs/batch-processing.md           ← data-cleanup追記
```

## 詳細設計

### 1. リテンション定数（`src/lib/constants/retention.ts`）

```typescript
export const DATA_RETENTION = {
  SCORING_RECORD_DAYS: 365,
  BACKTEST_DAILY_RESULT_DAYS: 365,
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

`src/lib/constants/index.ts` に `export * from "./retention"` を追加。

### 2. クリーンアップジョブ（`src/jobs/data-cleanup.ts`）

既存の news-collector クリーンアップと同じパターンで、`deleteMany` を使用。

```typescript
export async function runDataCleanup(): Promise<DataCleanupResult> {
  // 各テーブルの保持期間超過データを deleteMany
  // 削除条件: date < retentionDate（strictly less than で境界日を保持）
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

**削除条件の注意**: `lt`（strictly less than）を使い、リテンション境界日のデータは保持する。これにより contrarian analyzer（90日ルックバック）等が境界日のデータを参照できる。

### 3. cronルート登録（`src/web/routes/cron.ts`）— 手動実行用

既存の cronルーティングに `data-cleanup` ジョブを追加。GA workflowからは `npm run data-cleanup` で直接実行するため、このルートは手動テスト・将来のcron-job.org移行用。

```typescript
"data-cleanup": { fn: runDataCleanup, requiresMarketDay: false }
```

`requiresMarketDay: false` により、市場休日・システム非アクティブ時でも実行される。

### 4. GA Workflow（`.github/workflows/scheduled_data-cleanup.yml`）

既存のGA-cronジョブ（`scheduled_weekly-review.yml`, `scheduled_jpx-delisting-sync.yml`）と同じ直接実行パターンを使用。

- スケジュール: 毎週日曜 18:00 UTC（JST 月曜 3:00）
- `npm ci` → `npx prisma generate` → `npm run data-cleanup`
- concurrency group: `data-cleanup`（重複実行防止）
- 成功/失敗のSlack通知

`package.json` に追加:
```json
"data-cleanup": "tsx src/jobs/data-cleanup.ts"
```

### 5. news-collectorからの移管

- `src/jobs/news-collector.ts` の `[3/3] クリーンアップ中...` セクション（L276-292のNewsArticle/NewsAnalysis deleteMany）を削除
- `src/lib/constants/news.ts` から `NEWS_RETENTION` 定数を削除
- `news-collector.ts` のimport文から `NEWS_RETENTION` を削除（クリーンアップコード自体がなくなるため代替importは不要。`getDaysAgoForDB` は重複チェック（L96）で引き続き使用するため残す）

## データフロー

```
GA cron (毎週日曜 18:00 UTC / JST 月曜 3:00)
  → checkout, npm ci, prisma generate
  → npm run data-cleanup
    → runDataCleanup()
      → 各テーブル deleteMany (date < retentionDate)
      → 削除件数をログ出力
  → Slack通知（成功/失敗）
```

## 注意事項

- DefensiveExitFollowUp / UnfilledOrderFollowUp は `isComplete: true` のレコードのみ削除（進行中のフォローアップは保持）
- クリーンアップは週1回なので、リテンション期間は最大7日の誤差がある（許容範囲）
- news-collectorの日次クリーンアップが週次に変わるが、90日保持なので7日の差は無視できる
- 削除条件は `lt`（strictly less than）を使用し、境界日のデータを保持する
- ScoringRecord は最大テーブル（62MB/年）だが、バックテスト `LOOKBACK_MONTHS: 12` の要件により365日保持が必須
- 大量削除時のDB負荷は週1回の実行頻度では問題にならない（最大で1週間分の超過データのみ削除）
