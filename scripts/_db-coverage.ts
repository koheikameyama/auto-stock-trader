/**
 * StockDailyBar の本番DBカバレッジを確認する一時スクリプト
 */

import { prisma } from "../src/lib/prisma";

async function main() {
  const oldest = await prisma.stockDailyBar.findFirst({
    where: { market: "JP" },
    orderBy: { date: "asc" },
    select: { date: true },
  });
  const newest = await prisma.stockDailyBar.findFirst({
    where: { market: "JP" },
    orderBy: { date: "desc" },
    select: { date: true },
  });

  const stats = await prisma.$queryRaw<
    { year: number; count: bigint; distinct_tickers: bigint; distinct_dates: bigint }[]
  >`
    SELECT
      EXTRACT(YEAR FROM date)::int as year,
      COUNT(*) as count,
      COUNT(DISTINCT "tickerCode") as distinct_tickers,
      COUNT(DISTINCT date) as distinct_dates
    FROM "StockDailyBar"
    WHERE market = 'JP'
    GROUP BY EXTRACT(YEAR FROM date)
    ORDER BY year ASC
  `;

  const totalRows = await prisma.stockDailyBar.count({ where: { market: "JP" } });

  console.log("==== StockDailyBar JP カバレッジ ====");
  console.log(`最古: ${oldest?.date.toISOString().slice(0, 10) ?? "なし"}`);
  console.log(`最新: ${newest?.date.toISOString().slice(0, 10) ?? "なし"}`);
  console.log(`総行数: ${totalRows.toLocaleString()}`);
  console.log("");
  console.log("年別:");
  for (const r of stats) {
    console.log(
      `  ${r.year}: ${Number(r.count).toLocaleString()}行 / ${r.distinct_tickers}銘柄 / ${r.distinct_dates}営業日`,
    );
  }

  // 各銘柄の最古日分布（古い順から最大何年遡れるか）
  const oldestByTicker = await prisma.$queryRaw<{ years_back: number; count: bigint }[]>`
    WITH ticker_oldest AS (
      SELECT "tickerCode", MIN(date) as oldest_date
      FROM "StockDailyBar"
      WHERE market = 'JP'
      GROUP BY "tickerCode"
    )
    SELECT
      EXTRACT(YEAR FROM oldest_date)::int as years_back,
      COUNT(*) as count
    FROM ticker_oldest
    GROUP BY EXTRACT(YEAR FROM oldest_date)
    ORDER BY years_back ASC
  `;
  console.log("");
  console.log("銘柄ごとの最古年:");
  for (const r of oldestByTicker) {
    console.log(`  ${r.years_back}年〜開始: ${r.count}銘柄`);
  }

  await prisma.$disconnect();
}

main().catch((e) => { console.error(e); process.exit(1); });
