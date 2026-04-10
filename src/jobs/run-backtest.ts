/**
 * 日次バックテスト実行ジョブ
 *
 * cron-job.org から POST /api/cron/run-backtest で呼び出される。
 * 直近12ヶ月のギャップアップ戦略バックテストを実行し、結果をDBに保存する。
 *
 * ※ 2026-04-10: breakout戦略エッジ消失のため、gapup単独に変更
 */

import dayjs from "dayjs";
import { prisma } from "../lib/prisma";
import { GAPUP_BACKTEST_DEFAULTS } from "../backtest/gapup-config";
import {
  precomputeSimData,
} from "../backtest/breakout-simulation";
import { precomputeGapUpDailySignals, runGapUpBacktest } from "../backtest/gapup-simulation";
import { fetchHistoricalFromDB, fetchVixFromDB, fetchIndexFromDB } from "../backtest/data-fetcher";
import { saveBacktestResult } from "../backtest/db-saver";
import { notifyCombinedBacktest } from "../lib/slack";
import type { GapUpBacktestConfig } from "../backtest/types";

export async function main(): Promise<void> {
  const startDate = dayjs().subtract(12, "month").format("YYYY-MM-DD");
  const endDate = dayjs().format("YYYY-MM-DD");
  const budget = 500_000;

  const guConfig: GapUpBacktestConfig = { ...GAPUP_BACKTEST_DEFAULTS, startDate, endDate, initialBudget: budget, verbose: false };

  console.log(`[run-backtest] gapup単独バックテスト実行開始 ${startDate} → ${endDate}`);

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

  const allData = new Map<string, import("../core/technical-analysis").OHLCVData[]>();
  for (const [ticker, bars] of rawData) {
    if (bars.some((b) => b.close <= guConfig.maxPrice && b.close > 0)) {
      allData.set(ticker, bars);
    }
  }
  console.log(`[run-backtest] ${allData.size}銘柄（フィルタ後）`);

  // 事前計算
  const precomputed = precomputeSimData(
    startDate, endDate, allData,
    true, true,
    guConfig.indexTrendSmaPeriod ?? 50,
    indexData.size > 0 ? indexData : undefined,
    false,
    60,
    guConfig.indexTrendOffBufferPct ?? 0,
    guConfig.indexTrendOnBufferPct ?? 0,
  );

  const gapupSignals = precomputeGapUpDailySignals(guConfig, allData, precomputed);

  // シミュレーション実行
  const result = runGapUpBacktest(
    guConfig,
    allData,
    vixData.size > 0 ? vixData : undefined,
    indexData.size > 0 ? indexData : undefined,
    precomputed,
    gapupSignals,
  );

  // DB保存
  try {
    const savedId = await saveBacktestResult(
      {
        config: { startDate, endDate, maxPositions: guConfig.maxPositions, initialBudget: budget },
        trades: result.trades,
        equityCurve: result.equityCurve,
        metrics: result.metrics,
      } as Parameters<typeof saveBacktestResult>[0],
      "gapup",
    );
    console.log(`[run-backtest] 保存完了: ${savedId}`);
  } catch (err) {
    console.error("[run-backtest] DB保存失敗:", err);
    throw err;
  }

  // Slack通知
  try {
    const m = result.metrics;
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
