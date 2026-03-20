/**
 * 株価データバックフィル — コーポレートイベント更新
 *
 * 各銘柄の決算発表日・配当権利落ち日・配当額を更新
 */

import { prisma } from "../lib/prisma";
import { fetchCorporateEvents } from "../core/market-data";
import pLimit from "p-limit";

export async function main() {
  console.log("=== Backfill Corporate Events 開始 ===");

  const allStocks = await prisma.stock.findMany({
    where: { isDelisted: false, isActive: true },
  });

  if (allStocks.length === 0) {
    console.warn("  ⚠ アクティブな銘柄が0件です。");
    return;
  }

  const eventLimit = pLimit(20);
  const now = new Date();
  const needsUpdateStocks = allStocks.filter((stock) =>
    !stock.nextEarningsDate || stock.nextEarningsDate < now,
  );
  console.log(`  更新対象: ${needsUpdateStocks.length}/${allStocks.length}件`);

  // API取得結果を収集
  const eventResults: { id: string; data: Record<string, unknown> }[] = [];
  let eventProcessed = 0;

  await Promise.all(
    needsUpdateStocks.map((stock) =>
      eventLimit(async () => {
        try {
          const events = await fetchCorporateEvents(stock.tickerCode);
          const updateData: Record<string, unknown> = {};
          if (events.nextEarningsDate !== null) updateData.nextEarningsDate = events.nextEarningsDate;
          if (events.exDividendDate !== null) updateData.exDividendDate = events.exDividendDate;
          if (events.dividendPerShare !== null) updateData.dividendPerShare = events.dividendPerShare;

          if (Object.keys(updateData).length > 0) {
            eventResults.push({ id: stock.id, data: updateData });
          }
        } catch {
          // fetchCorporateEvents 内部でエラーログ済み
        }

        eventProcessed++;
        if (eventProcessed % 100 === 0 || eventProcessed === needsUpdateStocks.length) {
          console.log(`    取得中: ${eventProcessed}/${needsUpdateStocks.length}件`);
        }
      }),
    ),
  );

  // DB更新をバッチ実行
  if (eventResults.length > 0) {
    const EVENT_BATCH = 50;
    for (let i = 0; i < eventResults.length; i += EVENT_BATCH) {
      await prisma.$transaction(
        eventResults.slice(i, i + EVENT_BATCH).map((r) =>
          prisma.stock.update({ where: { id: r.id }, data: r.data }),
        ),
      );
    }
  }

  console.log(`  イベント更新: ${eventResults.length}件`);
  console.log("=== Backfill Corporate Events 終了 ===");
}

const isDirectRun = process.argv[1]?.includes("backfill-corporate-events");
if (isDirectRun) {
  main()
    .catch((error) => {
      console.error("Backfill Corporate Events エラー:", error);
      process.exit(1);
    })
    .finally(() => prisma.$disconnect());
}
