/**
 * 前場MA押し目スキャナー
 *
 * 前場（9:00-11:30 JST）中に1分ごと呼び出され、ウォッチリスト銘柄の
 * 現在価格が20日MAにタッチ（±2%以内）し、かつ上昇中の場合にシグナルを記録する。
 */

import pLimit from "p-limit";
import { getGuWatchlist } from "./watchlist-builder";
import { tachibanaFetchQuote } from "../lib/tachibana-price-client";
import { prisma } from "../lib/prisma";
import { getTodayForDB } from "../lib/market-date";
import { notifySlack } from "../lib/slack";
import { MA_PULLBACK } from "../lib/constants/ma-pullback";

/** 直前ポーリング価格を管理するインメモリMap（呼び出し間で保持） */
const prevPriceMap = new Map<string, number>();

/**
 * 前場MA押し目スキャナーメイン処理
 *
 * 1分ごとに呼び出されることを想定。
 * - ウォッチリスト銘柄を取得し、ma20が存在するもののみ対象
 * - 各銘柄の現在価格を並列取得（concurrency 5）
 * - MAタッチ + 上昇中 + 当日未検知 の条件を満たす場合にシグナル記録 & Slack通知
 */
export async function main(): Promise<void> {
  const today = getTodayForDB();

  // 1. ウォッチリスト取得
  const watchlistEntries = await getGuWatchlist();

  if (!watchlistEntries.length) {
    console.log("[intraday-ma-scanner] ウォッチリストが空です");
    return;
  }

  // 2. DBからma20を取得
  const tickers = watchlistEntries.map((e) => e.ticker);
  const dbRows = await prisma.watchlistEntry.findMany({
    where: {
      date: today,
      tickerCode: { in: tickers },
      ma20: { not: null },
    },
    select: {
      tickerCode: true,
      ma20: true,
    },
  });

  // ma20がnullの銘柄を除外したマップを作成
  const ma20Map = new Map<string, number>();
  for (const row of dbRows) {
    if (row.ma20 != null) {
      ma20Map.set(row.tickerCode, row.ma20);
    }
  }

  // atr14マップ
  const atr14Map = new Map<string, number>();
  for (const entry of watchlistEntries) {
    atr14Map.set(entry.ticker, entry.atr14);
  }

  // ma20が存在するティッカーのみを対象とする
  const targetTickers = tickers.filter((t) => ma20Map.has(t));

  if (!targetTickers.length) {
    console.log("[intraday-ma-scanner] ma20が存在する銘柄がありません");
    return;
  }

  // 3. 現在価格を並列取得（concurrency 5）
  const limit = pLimit(5);
  const priceResults = new Map<string, number>();

  await Promise.all(
    targetTickers.map((ticker) =>
      limit(async () => {
        try {
          const quote = await tachibanaFetchQuote(ticker);
          priceResults.set(ticker, quote.price);
        } catch (error) {
          console.warn(
            `[intraday-ma-scanner] 価格取得失敗: ${ticker}`,
            error instanceof Error ? error.message : String(error),
          );
        }
      }),
    ),
  );

  // 4. シグナル判定
  for (const ticker of targetTickers) {
    const currentPrice = priceResults.get(ticker);
    if (currentPrice == null) {
      // 価格取得失敗済みのためスキップ（prevPriceMapは更新しない）
      continue;
    }

    const ma20 = ma20Map.get(ticker);
    if (ma20 == null || ma20 <= 0) continue;

    const atr14 = atr14Map.get(ticker);
    if (atr14 == null) continue;

    const prevPrice = prevPriceMap.get(ticker);

    // 条件1: MAタッチ（±2%以内）
    const maDistance = Math.abs(currentPrice - ma20) / ma20;
    const isMaTouch = maDistance <= MA_PULLBACK.ENTRY.MA_TOUCH_BUFFER;

    // 条件2: 上昇中（初回ポーリングは条件を通過させる）
    const isRising = prevPrice === undefined || currentPrice > prevPrice;

    if (isMaTouch && isRising) {
      // 条件3: 当日未検知
      try {
        const existing = await prisma.intraDayMaPullbackSignal.findFirst({
          where: {
            date: today,
            tickerCode: ticker,
          },
        });

        if (!existing) {
          const stopLossPrice = currentPrice - atr14 * MA_PULLBACK.STOP_LOSS.ATR_MULTIPLIER;

          // シグナル記録
          try {
            await prisma.intraDayMaPullbackSignal.create({
              data: {
                date: today,
                tickerCode: ticker,
                detectedAt: new Date(),
                ma20,
                detectedPrice: currentPrice,
                stopLossPrice,
                atr14,
              },
            });
          } catch (createError) {
            console.error(
              `[intraday-ma-scanner] シグナル記録失敗: ${ticker}`,
              createError instanceof Error ? createError.message : String(createError),
            );
          }

          // Slack通知
          try {
            await notifySlack({
              title: `MA押し目シグナル: ${ticker}`,
              message: `検知価格: ${currentPrice}\nMA20: ${ma20}\n仮想SL: ${stopLossPrice.toFixed(0)}`,
              color: "good",
            });
          } catch (slackError) {
            console.error(
              `[intraday-ma-scanner] Slack通知失敗: ${ticker}`,
              slackError instanceof Error ? slackError.message : String(slackError),
            );
          }
        }
      } catch (dbError) {
        console.error(
          `[intraday-ma-scanner] DB検索失敗: ${ticker}`,
          dbError instanceof Error ? dbError.message : String(dbError),
        );
      }
    }

    // 5. 直前価格を更新
    prevPriceMap.set(ticker, currentPrice);
  }
}
