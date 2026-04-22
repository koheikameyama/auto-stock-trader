/**
 * 市場Breadth計算（close > SMA25 の銘柄比率）
 *
 * JP市場のみを対象とする（StockDailyBarは US/INDEX も含むため明示フィルタ必須）。
 * asOfDate を指定するとその日のbreadthを返し、未指定なら60日以内で最も新しい JP 営業日を自動採用する。
 * 該当日にデータが無い場合は Error を throw する（silent に古いデータを返すと呼び出し側が気づけないため）。
 */

import dayjs from "dayjs";
import { prisma } from "../lib/prisma";
import { getTodayForDB, jstDateAsUTC } from "../lib/market-date";

export interface BreadthResult {
  breadth: number; // 0.0 ~ 1.0
  above: number; // SMA25超の銘柄数
  total: number; // 計算対象の銘柄数
  asOfDate: Date; // 計算に使った JP 営業日
}

export async function calculateMarketBreadth(asOfDate?: Date): Promise<BreadthResult> {
  const upperBound = asOfDate ?? getTodayForDB();
  const cutoffDate = jstDateAsUTC(dayjs(upperBound).utc().subtract(60, "day"));

  // asOfDate 未指定時は、lookback 範囲内で最も新しい JP 営業日を採用する
  let targetDate: Date;
  if (asOfDate) {
    targetDate = asOfDate;
  } else {
    const latest = await prisma.stockDailyBar.findFirst({
      where: {
        market: "JP",
        date: { gte: cutoffDate, lte: upperBound },
      },
      orderBy: { date: "desc" },
      select: { date: true },
    });
    if (!latest) {
      throw new Error(
        "Market breadth cannot be calculated: no JP StockDailyBar data found in last 60 days",
      );
    }
    targetDate = latest.date;
  }

  const result = await prisma.$queryRaw<{ above: number; total: number }[]>`
    WITH windowed AS (
      SELECT
        "tickerCode",
        date,
        close,
        AVG(close) OVER (
          PARTITION BY "tickerCode"
          ORDER BY date
          ROWS 24 PRECEDING
        ) as sma25,
        COUNT(*) OVER (
          PARTITION BY "tickerCode"
          ORDER BY date
          ROWS 24 PRECEDING
        ) as window_count
      FROM "StockDailyBar"
      WHERE market = 'JP'
        AND date >= ${cutoffDate}
        AND date <= ${targetDate}
    )
    SELECT
      COUNT(*) FILTER (WHERE close > sma25)::int as above,
      COUNT(*)::int as total
    FROM windowed
    WHERE date = ${targetDate}
      AND window_count >= 25
  `;

  const row = result[0];
  if (!row || row.total === 0) {
    throw new Error(
      `Market breadth cannot be calculated for ${dayjs(targetDate).format("YYYY-MM-DD")}: no JP StockDailyBar bars with 25+ SMA history on that date`,
    );
  }

  return {
    breadth: row.above / row.total,
    above: row.above,
    total: row.total,
    asOfDate: targetDate,
  };
}
