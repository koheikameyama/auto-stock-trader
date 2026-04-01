/**
 * バックテスト結果をDBに保存する
 */

import { prisma } from "../lib/prisma";
import { BACKTEST_RUN_MAX_COUNT } from "../lib/constants";
import type { BreakoutBacktestResult, GapUpBacktestResult } from "./types";

type BacktestStrategy = "breakout" | "gapup" | "combined";

interface BacktestResultCommon {
  config: { startDate: string; endDate: string };
  trades: object;
  equityCurve: object;
  metrics: {
    totalTrades: number;
    wins: number;
    losses: number;
    winRate: number;
    profitFactor: number;
    maxDrawdown: number;
    sharpeRatio: number | null;
    expectancy: number;
    riskRewardRatio: number;
    netReturnPct: number;
    totalNetPnl: number;
    avgHoldingDays: number;
  };
}

/**
 * バックテスト結果を BacktestRun テーブルに保存する。
 * 保存後、同一戦略で件数が BACKTEST_RUN_MAX_COUNT を超えた分を古い順に削除する。
 */
export async function saveBacktestResult(
  result: BreakoutBacktestResult | GapUpBacktestResult,
  strategy: BacktestStrategy = "breakout",
): Promise<string> {
  const { config, trades, equityCurve, metrics } = result as BacktestResultCommon;

  const pf = metrics.profitFactor === Infinity ? 9999 : metrics.profitFactor;

  const run = await prisma.backtestRun.create({
    data: {
      strategy,
      runAt: new Date(),
      startDate: config.startDate,
      endDate: config.endDate,
      totalTrades: metrics.totalTrades,
      wins: metrics.wins,
      losses: metrics.losses,
      winRate: metrics.winRate,
      profitFactor: pf,
      maxDrawdown: metrics.maxDrawdown,
      sharpeRatio: metrics.sharpeRatio ?? null,
      expectancy: metrics.expectancy,
      riskRewardRatio: metrics.riskRewardRatio,
      netReturnPct: metrics.netReturnPct,
      totalNetPnl: metrics.totalNetPnl,
      avgHoldingDays: metrics.avgHoldingDays,
      metricsJson: metrics as object,
      equityCurveJson: equityCurve as object,
      tradesJson: trades as object,
      configJson: config as object,
    },
    select: { id: true },
  });

  // 同一戦略の件数超過分を削除（古い順）
  const allRuns = await prisma.backtestRun.findMany({
    where: { strategy },
    orderBy: { runAt: "desc" },
    select: { id: true },
    skip: BACKTEST_RUN_MAX_COUNT,
  });
  if (allRuns.length > 0) {
    await prisma.backtestRun.deleteMany({
      where: { id: { in: allRuns.map((r) => r.id) } },
    });
  }

  return run.id;
}
