/**
 * データクリーンアップジョブ（週次）
 *
 * 各テーブルのリテンション期間超過データを削除する。
 * GA schedule cron で毎週日曜に実行。
 */

import { prisma } from "../lib/prisma";
import { getDaysAgoForDB } from "../lib/date-utils";
import { DATA_RETENTION } from "../lib/constants";

interface DataCleanupResult {
  deletedCounts: Record<string, number>;
  totalDeleted: number;
}

export async function runDataCleanup(): Promise<DataCleanupResult> {
  console.log("=== データクリーンアップ開始 ===");

  const deletedCounts: Record<string, number> = {};

  // ScoringRecord (365日)
  const scoringResult = await prisma.scoringRecord.deleteMany({
    where: { date: { lt: getDaysAgoForDB(DATA_RETENTION.SCORING_RECORD_DAYS) } },
  });
  deletedCounts.scoringRecord = scoringResult.count;

  // BacktestDailyResult (365日)
  const backtestResult = await prisma.backtestDailyResult.deleteMany({
    where: { date: { lt: getDaysAgoForDB(DATA_RETENTION.BACKTEST_DAILY_RESULT_DAYS) } },
  });
  deletedCounts.backtestDailyResult = backtestResult.count;

  // MarketAssessment (90日)
  const marketResult = await prisma.marketAssessment.deleteMany({
    where: { date: { lt: getDaysAgoForDB(DATA_RETENTION.MARKET_ASSESSMENT_DAYS) } },
  });
  deletedCounts.marketAssessment = marketResult.count;

  // NewsArticle (90日)
  const articleResult = await prisma.newsArticle.deleteMany({
    where: { publishedAt: { lt: getDaysAgoForDB(DATA_RETENTION.NEWS_ARTICLE_DAYS) } },
  });
  deletedCounts.newsArticle = articleResult.count;

  // NewsAnalysis (90日)
  const analysisResult = await prisma.newsAnalysis.deleteMany({
    where: { date: { lt: getDaysAgoForDB(DATA_RETENTION.NEWS_ANALYSIS_DAYS) } },
  });
  deletedCounts.newsAnalysis = analysisResult.count;

  // TradingDailySummary (365日)
  const summaryResult = await prisma.tradingDailySummary.deleteMany({
    where: { date: { lt: getDaysAgoForDB(DATA_RETENTION.TRADING_DAILY_SUMMARY_DAYS) } },
  });
  deletedCounts.tradingDailySummary = summaryResult.count;

  // StockStatusLog (180日)
  const statusLogResult = await prisma.stockStatusLog.deleteMany({
    where: { createdAt: { lt: getDaysAgoForDB(DATA_RETENTION.STOCK_STATUS_LOG_DAYS) } },
  });
  deletedCounts.stockStatusLog = statusLogResult.count;

  // CorporateEventLog (365日)
  const eventLogResult = await prisma.corporateEventLog.deleteMany({
    where: { eventDate: { lt: getDaysAgoForDB(DATA_RETENTION.CORPORATE_EVENT_LOG_DAYS) } },
  });
  deletedCounts.corporateEventLog = eventLogResult.count;

  // DefensiveExitFollowUp (90日, isComplete=true のみ)
  const defensiveResult = await prisma.defensiveExitFollowUp.deleteMany({
    where: {
      exitDate: { lt: getDaysAgoForDB(DATA_RETENTION.DEFENSIVE_EXIT_FOLLOWUP_DAYS) },
      isComplete: true,
    },
  });
  deletedCounts.defensiveExitFollowUp = defensiveResult.count;

  // UnfilledOrderFollowUp (90日, isComplete=true のみ)
  const unfilledResult = await prisma.unfilledOrderFollowUp.deleteMany({
    where: {
      orderDate: { lt: getDaysAgoForDB(DATA_RETENTION.UNFILLED_ORDER_FOLLOWUP_DAYS) },
      isComplete: true,
    },
  });
  deletedCounts.unfilledOrderFollowUp = unfilledResult.count;

  const totalDeleted = Object.values(deletedCounts).reduce((a, b) => a + b, 0);

  // ログ出力
  for (const [table, count] of Object.entries(deletedCounts)) {
    if (count > 0) {
      console.log(`  ${table}: ${count}件削除`);
    }
  }
  console.log(`  合計: ${totalDeleted}件削除`);
  console.log("=== データクリーンアップ終了 ===");

  return { deletedCounts, totalDeleted };
}

// main エクスポート（cron.ts から呼び出し用）
export async function main(): Promise<void> {
  await runDataCleanup();
}

// 直接実行サポート
const isDirectRun = process.argv[1]?.includes("data-cleanup");
if (isDirectRun) {
  main()
    .catch((error) => {
      console.error("データクリーンアップエラー:", error);
      process.exit(1);
    })
    .finally(() => prisma.$disconnect());
}
