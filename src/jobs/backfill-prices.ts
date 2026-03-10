/**
 * 株価データバックフィル
 *
 * 1. 各銘柄の最新株価・出来高を更新
 * 2. TradingConfig の設定同期
 *
 * 注: 銘柄マスタ登録は jpx-csv-sync.ts が担当
 */

import { prisma } from "../lib/prisma";
import { TRADING_DEFAULTS, YAHOO_FINANCE, STOCK_FETCH, TECHNICAL_MIN_DATA, JOB_CONCURRENCY } from "../lib/constants";
import { fetchStockQuotesBatch, fetchHistoricalData, fetchCorporateEvents } from "../core/market-data";
import { analyzeTechnicals } from "../core/technical-analysis";
import pLimit from "p-limit";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Decimal(8,2) の範囲に収める（最大 ±999,999.99、NaN/Infinityはnull）
function clampDecimal8(value: number | null | undefined): number | null {
  if (value == null || !Number.isFinite(value)) return null;
  return Math.max(-999_999.99, Math.min(999_999.99, value));
}

export async function main() {
  console.log("=== Backfill Prices 開始 ===");

  // 1. 株価データ更新（バッチクォート + ヒストリカル並列取得）
  console.log("[1/2] 株価データ更新中...");
  const allStocks = await prisma.stock.findMany({
    where: { isDelisted: false, isActive: true },
  });

  if (allStocks.length === 0) {
    console.warn("  ⚠ アクティブな銘柄が0件です。先に jpx-csv-sync を実行してください。");
    return;
  }
  const limit = pLimit(JOB_CONCURRENCY.MARKET_SCANNER);
  let updated = 0;
  let failed = 0;

  for (let i = 0; i < allStocks.length; i += YAHOO_FINANCE.BATCH_SIZE) {
    const batch = allStocks.slice(i, i + YAHOO_FINANCE.BATCH_SIZE);
    const tickers = batch.map((s) => s.tickerCode);

    // バッチで一括クォート取得（1リクエスト）
    const quoteMap = await fetchStockQuotesBatch(tickers);

    // ヒストリカルデータは並列取得
    await Promise.all(
      batch.map((stock) =>
        limit(async () => {
          try {
            const quote = quoteMap.get(stock.tickerCode);
            // 取得失敗 or 異常値（廃止銘柄の可能性）→ failCountを加算
            if (!quote || !Number.isFinite(quote.price) || quote.price <= 0) {
              failed++;
              await prisma.stock.update({
                where: { id: stock.id },
                data: {
                  fetchFailCount: stock.fetchFailCount + 1,
                  isDelisted: stock.fetchFailCount + 1 >= STOCK_FETCH.FAIL_THRESHOLD,
                },
              });
              return;
            }

            // ヒストリカルデータからATRを計算
            let atr14: number | null = null;
            let weekChange: number | null = null;
            let volatility: number | null = null;

            const historical = await fetchHistoricalData(stock.tickerCode);
            if (historical && historical.length >= TECHNICAL_MIN_DATA.SCANNER_MIN_BARS) {
              const summary = analyzeTechnicals(historical);
              atr14 = summary.atr14;

              // 週間変化率
              if (historical.length >= STOCK_FETCH.WEEKLY_CHANGE_MIN_DAYS) {
                const current = historical[0].close;
                const weekAgo = historical[4].close;
                weekChange =
                  Math.round(((current - weekAgo) / weekAgo) * 10000) / 100;
              }

              // ボラティリティ（ATR / 株価 %）
              if (atr14 && quote.price > 0) {
                volatility =
                  Math.round((atr14 / quote.price) * 10000) / 100;
              }
            }

            // コーポレートイベント（決算日・配当落ち日）が過去 or 未設定の場合のみ更新（API負荷軽減）
            let corporateEventUpdate: Record<string, unknown> = {};
            const now = new Date();
            const needsCorporateUpdate =
              !stock.nextEarningsDate ||
              stock.nextEarningsDate < now ||
              !stock.exDividendDate ||
              stock.exDividendDate < now;

            if (needsCorporateUpdate) {
              const events = await fetchCorporateEvents(stock.tickerCode);
              if (events.nextEarningsDate !== null) {
                corporateEventUpdate.nextEarningsDate = events.nextEarningsDate;
              }
              if (events.exDividendDate !== null) {
                corporateEventUpdate.exDividendDate = events.exDividendDate;
              }
              if (events.dividendPerShare !== null) {
                corporateEventUpdate.dividendPerShare = events.dividendPerShare;
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
                // ファンダメンタルズ
                per: clampDecimal8(quote.per),
                pbr: clampDecimal8(quote.pbr),
                eps: quote.eps != null && Number.isFinite(quote.eps) ? quote.eps : null,
                marketCap: quote.marketCap != null && Number.isFinite(quote.marketCap) ? quote.marketCap : null,
                isProfitable: quote.eps != null ? quote.eps > 0 : null,
                // コーポレートイベント（取得した場合のみ更新）
                ...corporateEventUpdate,
              },
            });

            updated++;
            console.log(
              `  ✓ ${stock.tickerCode} ${stock.name}: ¥${quote.price.toLocaleString()}`,
            );
          } catch (error) {
            failed++;
            console.error(`  ✗ ${stock.tickerCode}: ${error}`);
          }
        }),
      ),
    );

    if (i + YAHOO_FINANCE.BATCH_SIZE < allStocks.length) {
      await sleep(YAHOO_FINANCE.RATE_LIMIT_DELAY_MS);
    }
  }

  console.log(`  更新: ${updated}件, 失敗: ${failed}件`);

  // 2. TradingConfig 初期設定
  console.log("[2/2] TradingConfig 確認...");
  const config = await prisma.tradingConfig.findFirst();

  if (!config) {
    await prisma.tradingConfig.create({
      data: {
        totalBudget: TRADING_DEFAULTS.TOTAL_BUDGET,
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
        totalBudget: TRADING_DEFAULTS.TOTAL_BUDGET,
        maxPositions: TRADING_DEFAULTS.MAX_POSITIONS,
        maxPositionPct: TRADING_DEFAULTS.MAX_POSITION_PCT,
        maxDailyLossPct: TRADING_DEFAULTS.MAX_DAILY_LOSS_PCT,
      },
    });
    console.log(
      `  TradingConfig更新: 予算¥${TRADING_DEFAULTS.TOTAL_BUDGET.toLocaleString()}, 最大保有数=${TRADING_DEFAULTS.MAX_POSITIONS}, 最大比率=${TRADING_DEFAULTS.MAX_POSITION_PCT}%`,
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
