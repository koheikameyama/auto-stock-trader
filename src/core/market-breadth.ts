/**
 * 市場Breadth計算（close > SMA25 の銘柄比率）
 *
 * StockDailyBarテーブルに対する単一SQLクエリで計算する。
 * バックテストのbreadth計算ロジックと同一基準（SMA25）。
 */

import { prisma } from "../lib/prisma";
import { getDaysAgoForDB } from "../lib/market-date";

export interface BreadthResult {
  breadth: number; // 0.0 ~ 1.0
  above: number; // SMA25超の銘柄数
  total: number; // 計算対象の銘柄数
}

export async function calculateMarketBreadth(): Promise<BreadthResult> {
  const cutoffDate = getDaysAgoForDB(60); // SMA25に十分なルックバック

  const result = await prisma.$queryRaw<{ above: number; total: number }[]>`
    WITH sma AS (
      SELECT
        "tickerCode",
        close,
        AVG(close) OVER (
          PARTITION BY "tickerCode"
          ORDER BY date
          ROWS 24 PRECEDING
        ) as sma25,
        ROW_NUMBER() OVER (
          PARTITION BY "tickerCode"
          ORDER BY date DESC
        ) as rn,
        COUNT(*) OVER (PARTITION BY "tickerCode") as cnt
      FROM "StockDailyBar"
      WHERE date >= ${cutoffDate}
    )
    SELECT
      COUNT(*) FILTER (WHERE close > sma25)::int as above,
      COUNT(*)::int as total
    FROM sma
    WHERE rn = 1 AND cnt >= 25
  `;

  const row = result[0];
  if (!row || row.total === 0) {
    return { breadth: 0, above: 0, total: 0 };
  }

  return {
    breadth: row.above / row.total,
    above: row.above,
    total: row.total,
  };
}
