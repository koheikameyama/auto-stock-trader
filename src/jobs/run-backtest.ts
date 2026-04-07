/**
 * 統合バックテスト実行ジョブ
 *
 * cron-job.org から POST /api/cron/run-backtest で呼び出される。
 * 直近12ヶ月の統合バックテスト（Breakout + GapUp 共有資金プール）を実行し、結果をDBに保存する。
 */

import dayjs from "dayjs";
import { prisma } from "../lib/prisma";
import { BREAKOUT_BACKTEST_DEFAULTS } from "../backtest/breakout-config";
import { GAPUP_BACKTEST_DEFAULTS } from "../backtest/gapup-config";
import {
  precomputeSimData,
  precomputeDailySignals,
} from "../backtest/breakout-simulation";
import { precomputeGapUpDailySignals } from "../backtest/gapup-simulation";
import { fetchHistoricalFromDB, fetchVixFromDB, fetchIndexFromDB } from "../backtest/data-fetcher";
import { saveBacktestResult } from "../backtest/db-saver";
import { notifyCombinedBacktest } from "../lib/slack";
import { runCombinedSimulation } from "../backtest/combined-simulation";
import type { BreakoutBacktestConfig, GapUpBacktestConfig } from "../backtest/types";

export async function main(): Promise<void> {
  const startDate = dayjs().subtract(12, "month").format("YYYY-MM-DD");
  const endDate = dayjs().format("YYYY-MM-DD");
  const budget = 500_000;

  const boConfig: BreakoutBacktestConfig = { ...BREAKOUT_BACKTEST_DEFAULTS, startDate, endDate, verbose: false };
  const guConfig: GapUpBacktestConfig = { ...GAPUP_BACKTEST_DEFAULTS, startDate, endDate, verbose: false };

  console.log(`[run-backtest] 実行開始 ${startDate} → ${endDate}`);

  // 銘柄一覧取得
  const stocks = await prisma.stock.findMany({
    where: { isDelisted: false, isActive: true, isRestricted: false },
    select: { tickerCode: true },
  });
  const tickerCodes = stocks.map((s) => s.tickerCode);
  console.log(`[run-backtest] ${tickerCodes.length}銘柄`);

  // データ取得
  const [rawData, vixData, indexData] = await Promise.all([
    fetchHistoricalFromDB(tickerCodes, startDate, endDate),
    fetchVixFromDB(startDate, endDate),
    fetchIndexFromDB("^N225", startDate, endDate),
  ]);

  const maxPrice = Math.max(boConfig.maxPrice, guConfig.maxPrice);
  const allData = new Map<string, import("../core/technical-analysis").OHLCVData[]>();
  for (const [ticker, bars] of rawData) {
    if (bars.some((b) => b.close <= maxPrice && b.close > 0)) {
      allData.set(ticker, bars);
    }
  }
  console.log(`[run-backtest] ${allData.size}銘柄（フィルタ後）`);

  // 事前計算
  const precomputed = precomputeSimData(
    startDate, endDate, allData,
    true, true,
    boConfig.indexTrendSmaPeriod ?? 50,
    indexData.size > 0 ? indexData : undefined,
    boConfig.indexMomentumFilter ?? false,
    boConfig.indexMomentumDays ?? 60,
    boConfig.indexTrendOffBufferPct ?? 0,
    boConfig.indexTrendOnBufferPct ?? 0,
  );

  const breakoutSignals = precomputeDailySignals(boConfig, allData, precomputed);
  const gapupSignals = precomputeGapUpDailySignals(guConfig, allData, precomputed);

  // シミュレーション実行
  const result = runCombinedSimulation(
    { boConfig, guConfig, budget, verbose: false, allData, precomputed, breakoutSignals, gapupSignals, vixData: vixData.size > 0 ? vixData : undefined, monthlyAddAmount: 0, equityCurveSmaPeriod: 20 },
    boConfig.maxPositions,
  );

  // DB保存
  try {
    const savedId = await saveBacktestResult(
      {
        config: { startDate, endDate, maxPositions: boConfig.maxPositions, initialBudget: budget },
        trades: result.allTrades,
        equityCurve: result.equityCurve,
        metrics: result.totalMetrics,
      } as Parameters<typeof saveBacktestResult>[0],
      "combined",
    );
    console.log(`[run-backtest] 保存完了: ${savedId}`);
  } catch (err) {
    console.error("[run-backtest] DB保存失敗:", err);
    throw err;
  }

  // Slack通知
  try {
    const m = result.totalMetrics;
    await notifyCombinedBacktest({
      period: `${startDate} 〜 ${endDate}`,
      profitFactor: m.profitFactor === Infinity ? 9999 : m.profitFactor,
      winRate: m.winRate,
      expectancy: m.expectancy,
      netReturnPct: m.netReturnPct,
      maxDrawdown: m.maxDrawdown,
      totalTrades: m.totalTrades,
    });
  } catch (err) {
    console.error("[run-backtest] Slack通知失敗:", err);
  }
}
