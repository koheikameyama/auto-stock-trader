/**
 * 株価データバックフィル — Stock Data
 *
 * 1. ヒストリカルOHLCVをバッチ取得（yf.download 一括）
 * 2. 最新バーから price/volume/change% を導出し Stock テーブル更新
 * 3. StockDailyBar にバルク保存 + ATR/volatility/weekChange 計算
 * 4. 古いOHLCVデータのprune
 *
 * 注: 銘柄マスタ登録は jpx-csv-sync.ts が担当
 * 注: ファンダメンタルズ（PER/PBR/EPS/marketCap）は backfill-fundamentals.ts が担当
 */

import dayjs from "dayjs";

import { prisma } from "../lib/prisma";
import { STOCK_FETCH, TECHNICAL_MIN_DATA } from "../lib/constants";
import { fetchHistoricalDataBatch } from "../core/market-data";
import { analyzeTechnicals } from "../core/technical-analysis";
import { clampDecimal, isDecimalOverflow, incrementFailAndMarkDelisted } from "../lib/decimal-utils";

/** OHLCV保持日数（これより古いバーをpruneする）— walk-forward分析に7ウィンドウ(27ヶ月)＋バッファで30ヶ月必要 */
const OHLCV_RETENTION_DAYS = 900;

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
  // [1/3] ヒストリカルOHLCV取得（yf.download 一括）
  // ================================================================
  console.log("[1/3] ヒストリカルOHLCV取得中...");
  const allTickers = allStocks.map((s) => s.tickerCode);
  const historicalMap = await fetchHistoricalDataBatch(allTickers);

  console.log(`  ヒストリカル取得: ${historicalMap.size}/${allTickers.length}銘柄`);

  // 取得失敗銘柄の判定 — 最新バーの close が正の数なら成功
  const failedStocks = allStocks.filter((s) => {
    const bars = historicalMap.get(s.tickerCode);
    return !bars || bars.length === 0 || !(bars[0].close > 0);
  });
  const failureRate = allStocks.length > 0 ? failedStocks.length / allStocks.length : 0;
  if (failureRate >= STOCK_FETCH.QUOTE_FAILURE_THRESHOLD) {
    throw new Error(
      `ヒストリカル取得の失敗率が高すぎます（${failedStocks.length}/${allStocks.length} = ${(failureRate * 100).toFixed(1)}%）。` +
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

  const validStocks = allStocks.filter((s) => {
    const bars = historicalMap.get(s.tickerCode);
    return bars && bars.length > 0 && bars[0].close > 0;
  });

  console.log(`  有効銘柄: ${validStocks.length}件, 失敗: ${failedStocks.length}件`);

  // ================================================================
  // [2/3] StockDailyBar保存 + Stock テーブル更新（ATR/volatility/weekChange/最新価格）
  // ================================================================
  console.log("[2/3] StockDailyBar upsert（最新5日分）+ 古バー一括保存...");
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
    console.log(`  古バー一括保存: ${allOlderBars.length}件...`);
    const CREATE_BATCH = 1000;
    for (let i = 0; i < allOlderBars.length; i += CREATE_BATCH) {
      await prisma.stockDailyBar.createMany({
        data: allOlderBars.slice(i, i + CREATE_BATCH),
        skipDuplicates: true,
      });
    }
  }

  console.log(`  StockDailyBar保存完了: 約${barsSaved}バー`);

  // Stock テーブルを一括更新（最新価格・出来高・ATR/volatility/weekChange）
  console.log("  Stock テーブル更新中...");
  const now = new Date();
  const anomalyStocks: { id: string; fetchFailCount: number }[] = [];
  const stockUpdateOps = validStocks.flatMap((stock) => {
    const historical = historicalMap.get(stock.tickerCode)!;
    const latest = historical[0];
    const prev = historical[1]; // 前日終値（日次変化率計算用）

    const price = latest.close;
    const volume = Math.round(latest.volume);
    const dailyChangePct =
      prev && prev.close > 0 ? ((price - prev.close) / prev.close) * 100 : null;

    let atr14: number | null = null;
    let weekChange: number | null = null;
    let volatility: number | null = null;

    if (historical.length >= TECHNICAL_MIN_DATA.SCANNER_MIN_BARS) {
      const summary = analyzeTechnicals(historical);
      atr14 = summary.atr14;

      if (historical.length >= STOCK_FETCH.WEEKLY_CHANGE_MIN_DAYS) {
        const weekAgo = historical[4].close;
        weekChange = Math.round(((price - weekAgo) / weekAgo) * 10000) / 100;
      }

      if (atr14 && price > 0) {
        volatility = Math.round((atr14 / price) * 10000) / 100;
      }
    }

    // Decimal(12,2) overflow 検知: 壊れた価格データで戦略判断が走るのを防ぐため、
    // 異常値の銘柄はこのバッチで更新せず fetchFailCount をインクリメント。
    // FAIL_THRESHOLD 超過で自動廃止扱いになる。
    if (isDecimalOverflow(price, "12,2") || isDecimalOverflow(atr14, "12,2")) {
      console.warn(
        `  ⚠ 異常値検知 ${stock.tickerCode}: price=${price}, atr14=${atr14} — Stock 更新をスキップ`,
      );
      anomalyStocks.push({ id: stock.id, fetchFailCount: stock.fetchFailCount });
      return [];
    }

    return [
      prisma.stock.update({
        where: { id: stock.id },
        data: {
          latestPrice: clampDecimal(price, "12,2"),
          latestVolume: BigInt(volume),
          dailyChangeRate: clampDecimal(dailyChangePct, "8,2"),
          weekChangeRate: clampDecimal(weekChange, "8,2"),
          volatility: clampDecimal(volatility, "8,2"),
          atr14: clampDecimal(atr14, "12,2"),
          latestPriceDate: now,
          priceUpdatedAt: now,
          fetchFailCount: 0,
        },
      }),
    ];
  });

  const STOCK_BATCH = 50;
  for (let i = 0; i < stockUpdateOps.length; i += STOCK_BATCH) {
    await prisma.$transaction(stockUpdateOps.slice(i, i + STOCK_BATCH));
    if ((i + STOCK_BATCH) % 500 === 0 || i + STOCK_BATCH >= stockUpdateOps.length) {
      console.log(`    Stock更新: ${Math.min(i + STOCK_BATCH, stockUpdateOps.length)}/${stockUpdateOps.length}件`);
    }
  }

  if (anomalyStocks.length > 0) {
    const anomalyCounts = new Map(anomalyStocks.map((s) => [s.id, s.fetchFailCount]));
    await incrementFailAndMarkDelisted(
      anomalyStocks.map((s) => s.id),
      anomalyCounts,
    );
    console.log(`  異常値検知: ${anomalyStocks.length}件の fetchFailCount をインクリメント`);
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
