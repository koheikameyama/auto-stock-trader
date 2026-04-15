/**
 * 前場MA押し目スキャナー
 *
 * 前場（9:00-11:30 JST）中に1分ごと呼び出され、ウォッチリスト銘柄の
 * 現在価格が20日MAにタッチ（±2%以内）し、かつ上昇中の場合にシグナルを記録する。
 *
 * リタッチ対応:
 * - 初回タッチ → 新規レコード作成
 * - MAゾーン離脱後の再突入 + 上昇 → 既存レコードを更新（touchCount++, SL再計算）
 * - ゾーン内の小さな上下動はカウントしない（クールダウン制御）
 * - 前回タッチから5分以上経過していること（ノイズ排除）
 */

import pLimit from "p-limit";
import { getGuWatchlist } from "./watchlist-builder";
import { tachibanaFetchQuote } from "../lib/tachibana-price-client";
import { prisma } from "../lib/prisma";
import { getTodayForDB } from "../lib/market-date";
import { notifySlack } from "../lib/slack";
import { MA_PULLBACK } from "../lib/constants/ma-pullback";

const PRICE_FETCH_CONCURRENCY = 5;

/** 直前ポーリング価格を管理するインメモリMap（呼び出し間で保持） */
const prevPriceMap = new Map<string, number>();

/** MAゾーン内かどうかを追跡（ゾーン離脱→再突入でリタッチ判定） */
const inMaZoneMap = new Map<string, boolean>();

/** タッチ後のクールダウン: ゾーン内で連続カウントされるのを防ぐ */
const touchCooldownMap = new Map<string, boolean>();

/** 直近タッチ時刻（最低間隔チェック用） */
const lastTouchTimeMap = new Map<string, number>();

/**
 * 前場MA押し目スキャナーメイン処理
 *
 * 1分ごとに呼び出されることを想定。
 * - ウォッチリスト銘柄を取得し、ma20が存在するもののみ対象
 * - 各銘柄の現在価格を並列取得
 * - MAタッチ + 上昇中 の条件を満たす場合にシグナル記録 & Slack通知
 * - リタッチ: ゾーン離脱後に再突入 + 上昇 + 5分以上間隔 → 既存レコード更新
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

  const ma20Map = new Map<string, number>();
  for (const row of dbRows) {
    if (row.ma20 != null) {
      ma20Map.set(row.tickerCode, row.ma20);
    }
  }

  const atr14Map = new Map<string, number>();
  for (const entry of watchlistEntries) {
    atr14Map.set(entry.ticker, entry.atr14);
  }

  const targetTickers = tickers.filter((t) => ma20Map.has(t));

  if (!targetTickers.length) {
    console.log("[intraday-ma-scanner] ma20が存在する銘柄がありません");
    return;
  }

  // 3. 当日シグナルを事前取得（create vs update 判定用）
  const existingRows = await prisma.intraDayMaPullbackSignal.findMany({
    where: { date: today },
    select: { tickerCode: true, touchCount: true },
  });
  const existingSignalMap = new Map(
    existingRows.map((r) => [r.tickerCode, r.touchCount]),
  );

  // 4. 現在価格を並列取得
  const limit = pLimit(PRICE_FETCH_CONCURRENCY);
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

  // 5. シグナル判定
  const now = Date.now();

  for (const ticker of targetTickers) {
    const currentPrice = priceResults.get(ticker);
    if (currentPrice == null) continue;

    const ma20 = ma20Map.get(ticker)!;
    const atr14 = atr14Map.get(ticker);
    if (atr14 == null) continue;

    const prevPrice = prevPriceMap.get(ticker);

    // MAゾーン判定（±2%以内）
    const maDistance = Math.abs(currentPrice - ma20) / ma20;
    const isInMaZone = maDistance <= MA_PULLBACK.ENTRY.MA_TOUCH_BUFFER;

    // 上昇判定（初回ポーリングは通過させる）
    const isRising = prevPrice === undefined || currentPrice > prevPrice;

    // タッチ判定: ゾーン内 + 上昇中 + クールダウン解除済み
    const isCooledDown = !touchCooldownMap.get(ticker);
    const isTouch = isInMaZone && isRising && isCooledDown;

    // 最低間隔チェック（5分以上）
    const lastTouchTime = lastTouchTimeMap.get(ticker);
    const hasMinInterval =
      lastTouchTime == null ||
      now - lastTouchTime >= MA_PULLBACK.RETOUCH.MIN_INTERVAL_MS;

    if (isTouch && hasMinInterval) {
      const stopLossPrice =
        currentPrice - atr14 * MA_PULLBACK.STOP_LOSS.ATR_MULTIPLIER;
      const existingTouchCount = existingSignalMap.get(ticker);

      if (existingTouchCount == null) {
        // === 初回タッチ: 新規レコード作成 ===
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
          existingSignalMap.set(ticker, 1);
          touchCooldownMap.set(ticker, true);
          lastTouchTimeMap.set(ticker, now);

          await notifySlack({
            title: `MA押し目シグナル: ${ticker}`,
            message: `検知価格: ${currentPrice.toFixed(0)}\nMA20: ${ma20.toFixed(0)}\n仮想SL: ${stopLossPrice.toFixed(0)}`,
            color: "good",
          }).catch((e) =>
            console.error(
              `[intraday-ma-scanner] Slack通知失敗: ${ticker}`,
              e instanceof Error ? e.message : String(e),
            ),
          );
        } catch (createError) {
          console.error(
            `[intraday-ma-scanner] シグナル記録失敗: ${ticker}`,
            createError instanceof Error
              ? createError.message
              : String(createError),
          );
        }
      } else {
        // === リタッチ: 既存レコード更新 ===
        const newTouchCount = existingTouchCount + 1;
        try {
          await prisma.intraDayMaPullbackSignal.updateMany({
            where: { date: today, tickerCode: ticker },
            data: {
              touchCount: newTouchCount,
              lastTouchAt: new Date(),
              lastTouchPrice: currentPrice,
              stopLossPrice,
            },
          });
          existingSignalMap.set(ticker, newTouchCount);
          touchCooldownMap.set(ticker, true);
          lastTouchTimeMap.set(ticker, now);

          await notifySlack({
            title: `MA押し目リタッチ (${newTouchCount}回目): ${ticker}`,
            message: `検知価格: ${currentPrice.toFixed(0)}\nMA20: ${ma20.toFixed(0)}\n更新SL: ${stopLossPrice.toFixed(0)}\nサポート確認中`,
            color: "good",
          }).catch((e) =>
            console.error(
              `[intraday-ma-scanner] Slack通知失敗: ${ticker}`,
              e instanceof Error ? e.message : String(e),
            ),
          );
        } catch (updateError) {
          console.error(
            `[intraday-ma-scanner] リタッチ更新失敗: ${ticker}`,
            updateError instanceof Error
              ? updateError.message
              : String(updateError),
          );
        }
      }
    }

    // ゾーン離脱 → クールダウン解除
    if (!isInMaZone) {
      touchCooldownMap.delete(ticker);
    }

    // 6. 状態更新
    inMaZoneMap.set(ticker, isInMaZone);
    prevPriceMap.set(ticker, currentPrice);
  }
}
