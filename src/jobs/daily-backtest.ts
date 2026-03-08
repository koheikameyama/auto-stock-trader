/**
 * 日次バックテスト（16:30 JST / 平日）
 *
 * 1. ScoringRecordからS/Aランク銘柄を選定
 * 2. 6ヶ月のヒストリカルデータを取得
 * 3. 4つの予算ティアでバックテスト実行
 * 4. 結果をDB保存
 * 5. Slackサマリー通知
 */

import { prisma } from "../lib/prisma";
import { getTodayForDB } from "../lib/date-utils";
import { notifyBacktestResult } from "../lib/slack";
import { runDailyBacktest } from "../backtest/daily-runner";

export async function main() {
  console.log("=== Daily Backtest 開始 ===");
  const startTime = Date.now();

  // 1. バックテスト実行
  const result = await runDailyBacktest();

  // 2. DB保存（upsert で冪等）
  console.log("[daily-backtest] DB保存中...");
  const today = getTodayForDB();

  for (const tr of result.tierResults) {
    const pf =
      tr.metrics.profitFactor === Infinity ? 999.99 : tr.metrics.profitFactor;

    await prisma.backtestDailyResult.upsert({
      where: {
        date_budgetTier: {
          date: today,
          budgetTier: tr.tier.label,
        },
      },
      create: {
        date: today,
        budgetTier: tr.tier.label,
        initialBudget: tr.tier.budget,
        maxPrice: tr.tier.maxPrice,
        maxPositions: tr.tier.maxPositions,
        tickerCount: tr.tickerCount,
        totalTrades: tr.metrics.totalTrades,
        wins: tr.metrics.wins,
        losses: tr.metrics.losses,
        winRate: tr.metrics.winRate,
        profitFactor: pf,
        maxDrawdown: tr.metrics.maxDrawdown,
        sharpeRatio: tr.metrics.sharpeRatio,
        totalPnl: tr.metrics.totalPnl,
        totalReturnPct: tr.metrics.totalReturnPct,
        avgHoldingDays: tr.metrics.avgHoldingDays,
        byRank: tr.metrics.byRank as object,
        fullResult: tr.metrics as object,
        periodStart: result.periodStart,
        periodEnd: result.periodEnd,
        executionTimeMs: tr.executionTimeMs,
      },
      update: {
        initialBudget: tr.tier.budget,
        maxPrice: tr.tier.maxPrice,
        maxPositions: tr.tier.maxPositions,
        tickerCount: tr.tickerCount,
        totalTrades: tr.metrics.totalTrades,
        wins: tr.metrics.wins,
        losses: tr.metrics.losses,
        winRate: tr.metrics.winRate,
        profitFactor: pf,
        maxDrawdown: tr.metrics.maxDrawdown,
        sharpeRatio: tr.metrics.sharpeRatio,
        totalPnl: tr.metrics.totalPnl,
        totalReturnPct: tr.metrics.totalReturnPct,
        avgHoldingDays: tr.metrics.avgHoldingDays,
        byRank: tr.metrics.byRank as object,
        fullResult: tr.metrics as object,
        periodStart: result.periodStart,
        periodEnd: result.periodEnd,
        executionTimeMs: tr.executionTimeMs,
      },
    });
  }

  // 3. Slack通知
  console.log("[daily-backtest] Slack通知中...");
  await notifyBacktestResult({
    tickers: result.tickers.length,
    period: `${result.periodStart} ~ ${result.periodEnd}`,
    dataFetchTimeMs: result.dataFetchTimeMs,
    totalTimeMs: Date.now() - startTime,
    tierResults: result.tierResults.map((tr) => ({
      label: tr.tier.label,
      winRate: tr.metrics.winRate,
      profitFactor: tr.metrics.profitFactor,
      totalReturnPct: tr.metrics.totalReturnPct,
      totalPnl: tr.metrics.totalPnl,
      totalTrades: tr.metrics.totalTrades,
      maxDrawdown: tr.metrics.maxDrawdown,
    })),
  });

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`=== Daily Backtest 完了 (${elapsed}秒) ===`);
}

const isDirectRun = process.argv[1]?.includes("daily-backtest");
if (isDirectRun) {
  main()
    .catch((error) => {
      console.error("Daily Backtest エラー:", error);
      process.exit(1);
    })
    .finally(() => prisma.$disconnect());
}
