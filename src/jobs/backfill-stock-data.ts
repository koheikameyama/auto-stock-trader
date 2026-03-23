/**
 * 株価データバックフィル — Stock Data
 *
 * 1. 各銘柄の最新クォート（株価・出来高・ファンダメンタルズ）を取得
 * 2. ヒストリカルOHLCVをバッチ取得 → StockDailyBar に保存 + ATR/volatility計算
 * 3. 古いOHLCVデータのprune
 *
 * 注: 銘柄マスタ登録は jpx-csv-sync.ts が担当
 */

import dayjs from "dayjs";

import { prisma } from "../lib/prisma";
import { YAHOO_FINANCE, STOCK_FETCH, TECHNICAL_MIN_DATA } from "../lib/constants";
import { fetchStockQuotesBatch, fetchHistoricalDataBatch } from "../core/market-data";
import { analyzeTechnicals } from "../core/technical-analysis";
import { sleep } from "../lib/retry-utils";
import { clampDecimal, incrementFailAndMarkDelisted } from "../lib/decimal-utils";

/** OHLCV保持日数（これより古いバーをpruneする） */
const OHLCV_RETENTION_DAYS = 250;

export async function main() {
  console.log("=== Backfill Stock Data 開始 ===");

  const allStocks = await prisma.stock.findMany({
    where: { isDelisted: false, isActive: true },
  });

  if (allStocks.length === 0) {
    console.warn("  ⚠ アクティブな銘柄が0件です。先に jpx-csv-sync を実行してください。");
    return;
  }

  console.log(`  対象銘柄: ${allStocks.length}件`);

  // ================================================================
  // [1/3] クォート更新（バッチ取得）
  // ================================================================
  console.log("[1/3] クォート更新中...");
  const quoteMap = new Map<string, Awaited<ReturnType<typeof fetchStockQuotesBatch>> extends Map<string, infer V> ? V : never>();
  let quotesFailed = 0;

  const totalBatches = Math.ceil(allStocks.length / YAHOO_FINANCE.BATCH_SIZE);
  for (let i = 0; i < allStocks.length; i += YAHOO_FINANCE.BATCH_SIZE) {
    const batchNum = Math.floor(i / YAHOO_FINANCE.BATCH_SIZE) + 1;
    const batch = allStocks.slice(i, i + YAHOO_FINANCE.BATCH_SIZE);
    const tickers = batch.map((s) => s.tickerCode);
    console.log(`  バッチ ${batchNum}/${totalBatches}（${tickers.length}件）`);
    const batchResult = await fetchStockQuotesBatch(tickers);
    for (const [key, value] of batchResult) {
      quoteMap.set(key, value);
    }
    if (i + YAHOO_FINANCE.BATCH_SIZE < allStocks.length) {
      await sleep(YAHOO_FINANCE.RATE_LIMIT_DELAY_MS);
    }
  }

  // クォート失敗銘柄の fetchFailCount を一括更新 & 廃止判定
  const failedStocks = allStocks.filter((s) => {
    const q = quoteMap.get(s.tickerCode);
    return !q || !Number.isFinite(q.price) || q.price <= 0;
  });
  quotesFailed = failedStocks.length;

  // 失敗率が閾値を超えた場合はサイドカー障害（タイムアウト等）とみなす。
  // 全銘柄を誤って廃止候補にしないよう incrementFailAndMarkDelisted をスキップし、ジョブをエラー終了する。
  const failureRate = allStocks.length > 0 ? quotesFailed / allStocks.length : 0;
  if (failureRate >= STOCK_FETCH.QUOTE_FAILURE_THRESHOLD) {
    throw new Error(
      `クォート取得の失敗率が高すぎます（${quotesFailed}/${allStocks.length} = ${(failureRate * 100).toFixed(1)}%）。` +
        `yfinanceサイドカーのタイムアウトまたは接続エラーの可能性があります。`,
    );
  }

  if (failedStocks.length > 0) {
    const currentCounts = new Map(failedStocks.map((s) => [s.id, s.fetchFailCount]));
    await incrementFailAndMarkDelisted(
      failedStocks.map((s) => s.id),
      currentCounts,
    );
  }

  console.log(`  クォート取得: ${quoteMap.size}件, 失敗: ${quotesFailed}件`);

  // クォート成功銘柄のみを対象にする
  const validStocks = allStocks.filter((s) => {
    const q = quoteMap.get(s.tickerCode);
    return q && Number.isFinite(q.price) && q.price > 0;
  });

  // ================================================================
  // [2/3] ヒストリカルOHLCV取得 → StockDailyBar保存 + ATR/volatility計算
  // ================================================================
  console.log("[2/3] ヒストリカルOHLCV取得 + DB保存中...");
  const validTickers = validStocks.map((s) => s.tickerCode);
  const historicalMap = await fetchHistoricalDataBatch(validTickers);

  console.log(`  ヒストリカル取得: ${historicalMap.size}/${validTickers.length}銘柄`);

  // StockDailyBar にバルク保存
  console.log("  [2a] StockDailyBar upsert（最新5日分）...");
  const allUpserts = [];
  const allOlderBars: { tickerCode: string; date: Date; open: number; high: number; low: number; close: number; volume: bigint }[] = [];
  let barsSaved = 0;

  for (const stock of validStocks) {
    const bars = historicalMap.get(stock.tickerCode);
    if (!bars || bars.length === 0) continue;

    // 最新5日分はupsert（株式分割等でデータが修正される場合）
    const recentBars = bars.slice(0, 5); // newest-first なので先頭5個が最新
    for (const bar of recentBars) {
      allUpserts.push(
        prisma.stockDailyBar.upsert({
          where: {
            tickerCode_date: {
              tickerCode: stock.tickerCode,
              date: new Date(bar.date + "T00:00:00Z"),
            },
          },
          update: {
            open: bar.open,
            high: bar.high,
            low: bar.low,
            close: bar.close,
            volume: BigInt(Math.round(bar.volume)),
          },
          create: {
            tickerCode: stock.tickerCode,
            date: new Date(bar.date + "T00:00:00Z"),
            open: bar.open,
            high: bar.high,
            low: bar.low,
            close: bar.close,
            volume: BigInt(Math.round(bar.volume)),
          },
        }),
      );
    }

    // 古いバーは一括で収集
    const olderBars = bars.slice(5);
    for (const bar of olderBars) {
      allOlderBars.push({
        tickerCode: stock.tickerCode,
        date: new Date(bar.date + "T00:00:00Z"),
        open: bar.open,
        high: bar.high,
        low: bar.low,
        close: bar.close,
        volume: BigInt(Math.round(bar.volume)),
      });
    }

    barsSaved += bars.length;
  }

  // upsert を50件ずつトランザクション実行
  const UPSERT_BATCH = 50;
  for (let i = 0; i < allUpserts.length; i += UPSERT_BATCH) {
    await prisma.$transaction(allUpserts.slice(i, i + UPSERT_BATCH));
    if ((i + UPSERT_BATCH) % 500 === 0 || i + UPSERT_BATCH >= allUpserts.length) {
      console.log(`    upsert: ${Math.min(i + UPSERT_BATCH, allUpserts.length)}/${allUpserts.length}件`);
    }
  }

  // 古いバーは一括 createMany（skipDuplicates）
  if (allOlderBars.length > 0) {
    console.log(`  [2b] olderBars一括保存: ${allOlderBars.length}件...`);
    const CREATE_BATCH = 1000;
    for (let i = 0; i < allOlderBars.length; i += CREATE_BATCH) {
      await prisma.stockDailyBar.createMany({
        data: allOlderBars.slice(i, i + CREATE_BATCH),
        skipDuplicates: true,
      });
    }
  }

  console.log(`  StockDailyBar保存完了: 約${barsSaved}バー`);

  // Stock テーブルの ATR/volatility/weekChange を一括更新
  console.log("  [2c] Stock テーブル更新中...");
  const now = new Date();
  const stockUpdateOps = validStocks.map((stock) => {
    const quote = quoteMap.get(stock.tickerCode)!;
    const historical = historicalMap.get(stock.tickerCode);

    let atr14: number | null = null;
    let weekChange: number | null = null;
    let volatility: number | null = null;

    if (historical && historical.length >= TECHNICAL_MIN_DATA.SCANNER_MIN_BARS) {
      const summary = analyzeTechnicals(historical);
      atr14 = summary.atr14;

      if (historical.length >= STOCK_FETCH.WEEKLY_CHANGE_MIN_DAYS) {
        const current = historical[0].close;
        const weekAgo = historical[4].close;
        weekChange = Math.round(((current - weekAgo) / weekAgo) * 10000) / 100;
      }

      if (atr14 && quote.price > 0) {
        volatility = Math.round((atr14 / quote.price) * 10000) / 100;
      }
    }

    return prisma.stock.update({
      where: { id: stock.id },
      data: {
        latestPrice: quote.price,
        latestVolume: BigInt(quote.volume),
        dailyChangeRate: clampDecimal(quote.changePercent, "8,2"),
        weekChangeRate: clampDecimal(weekChange, "8,2"),
        volatility: clampDecimal(volatility, "8,2"),
        atr14,
        latestPriceDate: now,
        priceUpdatedAt: now,
        fetchFailCount: 0,
        // ファンダメンタルズがnull（立花APIなど）の場合は既存DB値を保持
        ...(quote.per != null ? { per: clampDecimal(quote.per, "8,2") } : {}),
        ...(quote.pbr != null ? { pbr: clampDecimal(quote.pbr, "8,2") } : {}),
        ...(quote.eps != null && Number.isFinite(quote.eps) ? { eps: quote.eps, isProfitable: quote.eps > 0 } : {}),
        ...(quote.marketCap != null && Number.isFinite(quote.marketCap) ? { marketCap: quote.marketCap } : {}),
      },
    });
  });

  const STOCK_BATCH = 50;
  for (let i = 0; i < stockUpdateOps.length; i += STOCK_BATCH) {
    await prisma.$transaction(stockUpdateOps.slice(i, i + STOCK_BATCH));
    if ((i + STOCK_BATCH) % 500 === 0 || i + STOCK_BATCH >= stockUpdateOps.length) {
      console.log(`    Stock更新: ${Math.min(i + STOCK_BATCH, stockUpdateOps.length)}/${stockUpdateOps.length}件`);
    }
  }

  // ================================================================
  // [3/3] 古いOHLCVデータのprune
  // ================================================================
  const cutoffDate = dayjs().subtract(OHLCV_RETENTION_DAYS, "day").toDate();
  const pruned = await prisma.stockDailyBar.deleteMany({
    where: { date: { lt: cutoffDate } },
  });
  if (pruned.count > 0) {
    console.log(`  古いOHLCVデータ削除: ${pruned.count}件（${OHLCV_RETENTION_DAYS}日以前）`);
  }

  console.log("=== Backfill Stock Data 終了 ===");
}

const isDirectRun = process.argv[1]?.includes("backfill-stock-data");
if (isDirectRun) {
  main()
    .catch((error) => {
      console.error("Backfill Stock Data エラー:", error);
      process.exit(1);
    })
    .finally(() => prisma.$disconnect());
}
