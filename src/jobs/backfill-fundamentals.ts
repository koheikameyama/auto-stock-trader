/**
 * ファンダメンタルズバックフィル — Fundamentals
 *
 * PER / PBR / EPS / marketCap / isProfitable を全アクティブ銘柄に対して更新する。
 * これらは決算発表（四半期）時にしか本質的に変化しないため、週1実行で十分。
 *
 * 日次の backfill-stock-data はOHLCVと派生テクニカル指標のみ担当。
 */

import { prisma } from "../lib/prisma";
import { YAHOO_FINANCE } from "../lib/constants";
import { yfFetchQuotesBatch, type YfQuoteResult } from "../lib/yfinance-client";
import { sleep, withDbRetry } from "../lib/retry-utils";
import { clampDecimal } from "../lib/decimal-utils";

export async function main() {
  console.log("=== Backfill Fundamentals 開始 ===");

  const allStocks = await withDbRetry(
    () =>
      prisma.stock.findMany({
        where: { isDelisted: false, isActive: true },
      }),
    "stock.findMany",
  );

  if (allStocks.length === 0) {
    console.warn("  ⚠ アクティブな銘柄が0件です。先に jpx-csv-sync を実行してください。");
    return;
  }

  console.log(`  対象銘柄: ${allStocks.length}件`);

  const quoteMap = new Map<string, YfQuoteResult>();
  const totalBatches = Math.ceil(allStocks.length / YAHOO_FINANCE.BATCH_SIZE);
  for (let i = 0; i < allStocks.length; i += YAHOO_FINANCE.BATCH_SIZE) {
    const batchNum = Math.floor(i / YAHOO_FINANCE.BATCH_SIZE) + 1;
    const batch = allStocks.slice(i, i + YAHOO_FINANCE.BATCH_SIZE);
    const tickers = batch.map((s) => s.tickerCode);
    console.log(`  バッチ ${batchNum}/${totalBatches}（${tickers.length}件）`);
    const batchResult = await yfFetchQuotesBatch(tickers);
    for (const result of batchResult) {
      if (result && result.tickerCode) {
        quoteMap.set(result.tickerCode, result);
      }
    }
    if (i + YAHOO_FINANCE.BATCH_SIZE < allStocks.length) {
      await sleep(YAHOO_FINANCE.RATE_LIMIT_DELAY_MS);
    }
  }

  console.log(`  クォート取得: ${quoteMap.size}/${allStocks.length}件`);

  // Stock テーブルをバルク更新（ファンダのみ）
  // ⚠️ update の「データ記述子」を組み立てておき、実際の PrismaPromise は
  // 各バッチ実行時（リトライ時は毎回新規）に生成する。PrismaPromise を使い回して
  // $transaction に再投入すると再試行できないため。
  const updates = allStocks
    .map((stock) => {
      const q = quoteMap.get(stock.tickerCode);
      if (!q) return null;

      const data: Record<string, unknown> = {};
      if (q.per != null) data.per = clampDecimal(q.per, "8,2");
      if (q.pbr != null) data.pbr = clampDecimal(q.pbr, "8,2");
      if (q.eps != null && Number.isFinite(q.eps)) {
        data.eps = q.eps;
        data.isProfitable = q.eps > 0;
      }
      if (q.marketCap != null && Number.isFinite(q.marketCap)) {
        data.marketCap = q.marketCap;
      }

      if (Object.keys(data).length === 0) return null;
      return { id: stock.id, data };
    })
    .filter((op): op is { id: string; data: Record<string, unknown> } => op != null);

  console.log(`  Stock ファンダ更新対象: ${updates.length}件`);

  const STOCK_BATCH = 50;
  for (let i = 0; i < updates.length; i += STOCK_BATCH) {
    const slice = updates.slice(i, i + STOCK_BATCH);
    await withDbRetry(
      () =>
        prisma.$transaction(
          slice.map((u) => prisma.stock.update({ where: { id: u.id }, data: u.data })),
        ),
      `stock.update batch ${i / STOCK_BATCH}`,
    );
    if ((i + STOCK_BATCH) % 500 === 0 || i + STOCK_BATCH >= updates.length) {
      console.log(`    Stock更新: ${Math.min(i + STOCK_BATCH, updates.length)}/${updates.length}件`);
    }
  }

  console.log("=== Backfill Fundamentals 終了 ===");
}

const isDirectRun = process.argv[1]?.includes("backfill-fundamentals");
if (isDirectRun) {
  main()
    .catch((error) => {
      console.error("Backfill Fundamentals エラー:", error);
      process.exit(1);
    })
    .finally(() => prisma.$disconnect());
}
