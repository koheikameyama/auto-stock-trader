/**
 * バックテスト実行ジョブ
 *
 * cron-job.org から POST /api/cron/run-backtest で呼び出される。
 * 直近12ヶ月のブレイクアウトバックテストを実行し、結果をDBに保存する。
 */

import dayjs from "dayjs";
import { prisma } from "../lib/prisma";
import { BREAKOUT_BACKTEST_DEFAULTS } from "../backtest/breakout-config";
import { runBreakoutBacktest } from "../backtest/breakout-simulation";
import { fetchHistoricalFromDB, fetchVixFromDB } from "../backtest/data-fetcher";
import { saveBacktestResult } from "../backtest/db-saver";
import { notifyBreakoutBacktest } from "../lib/slack";

export async function main(): Promise<void> {
  const startDate = dayjs().subtract(12, "month").format("YYYY-MM-DD");
  const endDate = dayjs().format("YYYY-MM-DD");

  const config = {
    ...BREAKOUT_BACKTEST_DEFAULTS,
    startDate,
    endDate,
    verbose: false,
  };

  console.log(`[run-backtest] 実行開始 ${startDate} → ${endDate}`);

  // 銘柄一覧取得
  const stocks = await prisma.stock.findMany({
    where: { isDelisted: false, isActive: true, isRestricted: false },
    select: { tickerCode: true },
  });
  const tickerCodes = stocks.map((s) => s.tickerCode);
  console.log(`[run-backtest] ${tickerCodes.length}銘柄`);

  // 日足データ取得
  const allData = await fetchHistoricalFromDB(tickerCodes, startDate, endDate);
  const vixData = await fetchVixFromDB(startDate, endDate);

  // シミュレーション実行
  const result = runBreakoutBacktest(
    config,
    allData,
    vixData.size > 0 ? vixData : undefined,
  );

  // DB保存
  let savedId: string | null = null;
  try {
    savedId = await saveBacktestResult(result);
    console.log(`[run-backtest] 保存完了: ${savedId}`);
  } catch (err) {
    console.error("[run-backtest] DB保存失敗:", err);
    throw err;
  }

  // Slack通知
  try {
    const m = result.metrics;
    await notifyBreakoutBacktest({
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
    // 通知失敗はジョブを失敗させない
  }
}
