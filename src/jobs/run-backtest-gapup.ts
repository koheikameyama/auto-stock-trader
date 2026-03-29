/**
 * ギャップアップバックテスト実行ジョブ
 *
 * cron-job.org から POST /api/cron/run-backtest-gapup で呼び出される。
 * 直近12ヶ月のギャップアップバックテストを実行し、結果をDBに保存する。
 */

import dayjs from "dayjs";
import { prisma } from "../lib/prisma";
import { GAPUP_BACKTEST_DEFAULTS } from "../backtest/gapup-config";
import { runGapUpBacktest } from "../backtest/gapup-simulation";
import { fetchHistoricalFromDB, fetchVixFromDB, fetchIndexFromDB } from "../backtest/data-fetcher";
import { saveBacktestResult } from "../backtest/db-saver";
import { notifyGapUpBacktest } from "../lib/slack";

export async function main(): Promise<void> {
  const startDate = dayjs().subtract(12, "month").format("YYYY-MM-DD");
  const endDate = dayjs().format("YYYY-MM-DD");

  const config = {
    ...GAPUP_BACKTEST_DEFAULTS,
    startDate,
    endDate,
    verbose: false,
  };

  console.log(`[run-backtest-gapup] 実行開始 ${startDate} → ${endDate}`);

  // 銘柄一覧取得
  const stocks = await prisma.stock.findMany({
    where: { isDelisted: false, isActive: true, isRestricted: false },
    select: { tickerCode: true },
  });
  const tickerCodes = stocks.map((s) => s.tickerCode);
  console.log(`[run-backtest-gapup] ${tickerCodes.length}銘柄`);

  // 日足データ・VIX・N225取得
  const [allData, vixData, indexData] = await Promise.all([
    fetchHistoricalFromDB(tickerCodes, startDate, endDate),
    fetchVixFromDB(startDate, endDate),
    fetchIndexFromDB("^N225", startDate, endDate),
  ]);

  // シミュレーション実行
  const result = runGapUpBacktest(
    config,
    allData,
    vixData.size > 0 ? vixData : undefined,
    indexData.size > 0 ? indexData : undefined,
  );

  // DB保存
  let savedId: string | null = null;
  try {
    savedId = await saveBacktestResult(result, "gapup");
    console.log(`[run-backtest-gapup] 保存完了: ${savedId}`);
  } catch (err) {
    console.error("[run-backtest-gapup] DB保存失敗:", err);
    throw err;
  }

  // Slack通知
  try {
    const m = result.metrics;
    await notifyGapUpBacktest({
      period: `${startDate} 〜 ${endDate}`,
      profitFactor: m.profitFactor === Infinity ? 9999 : m.profitFactor,
      winRate: m.winRate,
      expectancy: m.expectancy,
      netReturnPct: m.netReturnPct,
      maxDrawdown: m.maxDrawdown,
      totalTrades: m.totalTrades,
    });
  } catch (err) {
    console.error("[run-backtest-gapup] Slack通知失敗:", err);
  }
}
