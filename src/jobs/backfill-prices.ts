/**
 * 株価データバックフィル
 *
 * 1. 各銘柄の最新クォート（株価・出来高・ファンダメンタルズ）を更新
 * 2. ヒストリカルOHLCVをバッチ取得 → StockDailyBar に保存 + ATR/volatility計算
 * 3. コーポレートイベント更新
 * 4. TradingConfig の設定同期
 *
 * 注: 銘柄マスタ登録は jpx-csv-sync.ts が担当
 */

import dayjs from "dayjs";

import { prisma } from "../lib/prisma";
import { TRADING_DEFAULTS, YAHOO_FINANCE, STOCK_FETCH, TECHNICAL_MIN_DATA, JOB_CONCURRENCY } from "../lib/constants";
import { fetchStockQuotesBatch, fetchHistoricalDataBatch, fetchCorporateEvents } from "../core/market-data";
import { analyzeTechnicals } from "../core/technical-analysis";
import { sleep } from "../lib/retry-utils";
import pLimit from "p-limit";

/** OHLCV保持日数（これより古いバーをpruneする） */
const OHLCV_RETENTION_DAYS = 250;

// Decimal(8,2) の範囲に収める（最大 ±999,999.99、NaN/Infinityはnull）
function clampDecimal8(value: number | null | undefined): number | null {
  if (value == null || !Number.isFinite(value)) return null;
  return Math.max(-999_999.99, Math.min(999_999.99, value));
}

export async function main() {
  console.log("=== Backfill Prices 開始 ===");

  const allStocks = await prisma.stock.findMany({
    where: { isDelisted: false, isActive: true },
  });

  if (allStocks.length === 0) {
    console.warn("  ⚠ アクティブな銘柄が0件です。先に jpx-csv-sync を実行してください。");
    return;
  }

  console.log(`  対象銘柄: ${allStocks.length}件`);

  // ================================================================
  // [1/4] クォート更新（バッチ取得）
  // ================================================================
  console.log("[1/4] クォート更新中...");
  const quoteMap = new Map<string, Awaited<ReturnType<typeof fetchStockQuotesBatch>> extends Map<string, infer V> ? V : never>();
  let quotesFailed = 0;

  for (let i = 0; i < allStocks.length; i += YAHOO_FINANCE.BATCH_SIZE) {
    const batch = allStocks.slice(i, i + YAHOO_FINANCE.BATCH_SIZE);
    const tickers = batch.map((s) => s.tickerCode);
    const batchResult = await fetchStockQuotesBatch(tickers);
    for (const [key, value] of batchResult) {
      quoteMap.set(key, value);
    }
    if (i + YAHOO_FINANCE.BATCH_SIZE < allStocks.length) {
      await sleep(YAHOO_FINANCE.RATE_LIMIT_DELAY_MS);
    }
  }

  // クォート失敗銘柄の fetchFailCount を更新
  for (const stock of allStocks) {
    const quote = quoteMap.get(stock.tickerCode);
    if (!quote || !Number.isFinite(quote.price) || quote.price <= 0) {
      quotesFailed++;
      await prisma.stock.update({
        where: { id: stock.id },
        data: {
          fetchFailCount: stock.fetchFailCount + 1,
          isDelisted: stock.fetchFailCount + 1 >= STOCK_FETCH.FAIL_THRESHOLD,
        },
      });
    }
  }

  console.log(`  クォート取得: ${quoteMap.size}件, 失敗: ${quotesFailed}件`);

  // クォート成功銘柄のみを対象にする
  const validStocks = allStocks.filter((s) => {
    const q = quoteMap.get(s.tickerCode);
    return q && Number.isFinite(q.price) && q.price > 0;
  });

  // ================================================================
  // [2/4] ヒストリカルOHLCV取得 → StockDailyBar保存 + ATR/volatility計算
  // ================================================================
  console.log("[2/4] ヒストリカルOHLCV取得 + DB保存中...");
  const validTickers = validStocks.map((s) => s.tickerCode);
  const historicalMap = await fetchHistoricalDataBatch(validTickers);

  console.log(`  ヒストリカル取得: ${historicalMap.size}/${validTickers.length}銘柄`);

  // StockDailyBar にバルク保存
  let barsSaved = 0;
  for (const stock of validStocks) {
    const bars = historicalMap.get(stock.tickerCode);
    if (!bars || bars.length === 0) continue;

    // 最新5日分はupsert（株式分割等でデータが修正される場合）
    const recentBars = bars.slice(0, 5); // newest-first なので先頭5個が最新
    const olderBars = bars.slice(5);

    for (const bar of recentBars) {
      await prisma.stockDailyBar.upsert({
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
      });
    }

    // 古いバーは新規のみ追加（skipDuplicates）
    if (olderBars.length > 0) {
      await prisma.stockDailyBar.createMany({
        data: olderBars.map((bar) => ({
          tickerCode: stock.tickerCode,
          date: new Date(bar.date + "T00:00:00Z"),
          open: bar.open,
          high: bar.high,
          low: bar.low,
          close: bar.close,
          volume: BigInt(Math.round(bar.volume)),
        })),
        skipDuplicates: true,
      });
    }

    barsSaved += bars.length;
  }

  console.log(`  StockDailyBar保存完了: 約${barsSaved}バー`);

  // Stock テーブルの ATR/volatility/weekChange を更新
  let stockUpdated = 0;
  for (const stock of validStocks) {
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

    await prisma.stock.update({
      where: { id: stock.id },
      data: {
        latestPrice: quote.price,
        latestVolume: BigInt(quote.volume),
        dailyChangeRate: clampDecimal8(quote.changePercent),
        weekChangeRate: clampDecimal8(weekChange),
        volatility: clampDecimal8(volatility),
        atr14,
        latestPriceDate: new Date(),
        priceUpdatedAt: new Date(),
        fetchFailCount: 0,
        per: clampDecimal8(quote.per),
        pbr: clampDecimal8(quote.pbr),
        eps: quote.eps != null && Number.isFinite(quote.eps) ? quote.eps : null,
        marketCap: quote.marketCap != null && Number.isFinite(quote.marketCap) ? quote.marketCap : null,
        isProfitable: quote.eps != null ? quote.eps > 0 : null,
      },
    });
    stockUpdated++;
  }

  console.log(`  Stock更新: ${stockUpdated}件`);

  // ================================================================
  // [3/4] コーポレートイベント更新
  // ================================================================
  console.log("[3/4] コーポレートイベント更新中...");
  const limit = pLimit(JOB_CONCURRENCY.MARKET_SCANNER);
  let eventsUpdated = 0;

  await Promise.all(
    allStocks.map((stock) =>
      limit(async () => {
        const now = new Date();
        const needsUpdate =
          !stock.nextEarningsDate ||
          stock.nextEarningsDate < now ||
          !stock.exDividendDate ||
          stock.exDividendDate < now;

        if (!needsUpdate) return;

        try {
          const events = await fetchCorporateEvents(stock.tickerCode);
          const updateData: Record<string, unknown> = {};
          if (events.nextEarningsDate !== null) updateData.nextEarningsDate = events.nextEarningsDate;
          if (events.exDividendDate !== null) updateData.exDividendDate = events.exDividendDate;
          if (events.dividendPerShare !== null) updateData.dividendPerShare = events.dividendPerShare;

          if (Object.keys(updateData).length > 0) {
            await prisma.stock.update({
              where: { id: stock.id },
              data: updateData,
            });
            eventsUpdated++;
          }
        } catch {
          // fetchCorporateEvents 内部でエラーログ済み
        }
      }),
    ),
  );

  console.log(`  イベント更新: ${eventsUpdated}件`);

  // ================================================================
  // [3.5] 古いOHLCVデータのprune
  // ================================================================
  const cutoffDate = dayjs().subtract(OHLCV_RETENTION_DAYS, "day").toDate();
  const pruned = await prisma.stockDailyBar.deleteMany({
    where: { date: { lt: cutoffDate } },
  });
  if (pruned.count > 0) {
    console.log(`  古いOHLCVデータ削除: ${pruned.count}件（${OHLCV_RETENTION_DAYS}日以前）`);
  }

  // ================================================================
  // [4/4] TradingConfig 初期設定
  // ================================================================
  console.log("[4/4] TradingConfig 確認...");
  const config = await prisma.tradingConfig.findFirst();

  if (!config) {
    await prisma.tradingConfig.create({
      data: {
        totalBudget: TRADING_DEFAULTS.TOTAL_BUDGET,
        realizedPnl: 0,
        maxPositions: TRADING_DEFAULTS.MAX_POSITIONS,
        maxPositionPct: TRADING_DEFAULTS.MAX_POSITION_PCT,
        maxDailyLossPct: TRADING_DEFAULTS.MAX_DAILY_LOSS_PCT,
        isActive: true,
      },
    });
    console.log(
      `  TradingConfig作成: 予算¥${TRADING_DEFAULTS.TOTAL_BUDGET.toLocaleString()}`,
    );
  } else {
    await prisma.tradingConfig.update({
      where: { id: config.id },
      data: {
        maxPositions: TRADING_DEFAULTS.MAX_POSITIONS,
        maxPositionPct: TRADING_DEFAULTS.MAX_POSITION_PCT,
        maxDailyLossPct: TRADING_DEFAULTS.MAX_DAILY_LOSS_PCT,
      },
    });
    console.log(
      `  TradingConfig更新: 最大保有数=${TRADING_DEFAULTS.MAX_POSITIONS}, 最大比率=${TRADING_DEFAULTS.MAX_POSITION_PCT}%`,
    );
  }

  console.log("=== Backfill Prices 終了 ===");
}

const isDirectRun = process.argv[1]?.includes("backfill-prices");
if (isDirectRun) {
  main()
    .catch((error) => {
      console.error("Backfill Prices エラー:", error);
      process.exit(1);
    })
    .finally(() => prisma.$disconnect());
}
