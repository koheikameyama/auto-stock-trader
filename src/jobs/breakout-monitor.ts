/**
 * ブレイクアウトモニタージョブ
 *
 * worker.tsのnode-cronから1分間隔で呼ばれる。
 * ウォッチリストの銘柄をリアルタイム時価でスキャンし、
 * ブレイクアウトトリガーが検出された場合はエントリーを実行する。
 */

import dayjs from "dayjs";
import timezone from "dayjs/plugin/timezone.js";
import utc from "dayjs/plugin/utc.js";
import { BreakoutScanner } from "../core/breakout/breakout-scanner";
import { executeEntry, resizePendingOrders, invalidateStalePendingOrders } from "../core/breakout/entry-executor";
import { getWatchlist } from "./watchlist-builder";
import { tachibanaFetchQuotesBatch } from "../lib/tachibana-price-client";
import { prisma } from "../lib/prisma";
import { getTodayForDB } from "../lib/date-utils";
import { notifySlack } from "../lib/slack";
import { TIMEZONE } from "../lib/constants";
import type { QuoteData } from "../core/breakout/breakout-scanner";
import { GapUpScanner } from "../core/gapup/gapup-scanner";
import type { GapUpQuoteData } from "../core/gapup/gapup-scanner";
import { GAPUP } from "../lib/constants/gapup";

dayjs.extend(utc);
dayjs.extend(timezone);

let scanner: BreakoutScanner | null = null;
let lastScanDate: string | null = null;
/** 保有中ティッカー（直近スキャン時のスナップショット） */
let lastHoldingTickers: Set<string> = new Set();
let gapupScanner: GapUpScanner | null = null;
/** 本日のgapupスキャン実行済みフラグ */
let gapupScannedToday = false;

/**
 * スキャナーの状態を外部から取得する（Web UIで使用）
 * スキャナー未起動時は null を返す
 */
export function getScannerState() {
  if (!scanner) return null;
  return {
    state: scanner.getState(),
    holdingTickers: lastHoldingTickers,
  };
}

/**
 * ブレイクアウトモニターのメイン処理（1分間隔で呼ばれる）
 */
export async function main(): Promise<void> {
  const tag = "[breakout-monitor]";
  const watchlist = await getWatchlist();
  if (!watchlist.length) {
    console.log(`${tag} スキップ: ウォッチリスト空`);
    return;
  }

  // 日付変更検出 → スキャナーリセット
  const today = dayjs().tz(TIMEZONE).format("YYYY-MM-DD");
  if (lastScanDate && lastScanDate !== today) {
    scanner = null;
    gapupScanner = null;
    gapupScannedToday = false;
  }
  lastScanDate = today;

  if (!scanner) {
    scanner = new BreakoutScanner(watchlist);
  }

  if (!gapupScanner) {
    gapupScanner = new GapUpScanner(watchlist);
  }

  // 0-2. MarketAssessment・保有ポジションを並列取得
  const [todayAssessment, openPositions] = await Promise.all([
    prisma.marketAssessment.findUnique({
      where: { date: getTodayForDB() },
    }),
    prisma.tradingPosition.findMany({
      where: { status: "open" },
      include: { stock: { select: { tickerCode: true } } },
    }),
  ]);

  if (!todayAssessment) {
    console.log(`${tag} スキップ: MarketAssessment未作成`);
    return;
  }
  if (!todayAssessment.shouldTrade) {
    console.log(`${tag} スキップ: shouldTrade=false（sentiment: ${todayAssessment.sentiment}）`);
    return;
  }

  const holdingTickers = new Set(openPositions.map((p) => p.stock.tickerCode));
  lastHoldingTickers = holdingTickers;

  // 3. スキャン対象ティッカーを取得（ウォッチリスト全銘柄）
  const tickers = watchlist.map((e) => e.ticker);

  // 4. リアルタイム時価を一括取得
  const quotesRaw = await tachibanaFetchQuotesBatch(tickers);

  // YfQuoteResult[] を QuoteData[] に変換（nullはスキップ）
  const quotes: QuoteData[] = quotesRaw
    .filter((q): q is NonNullable<typeof q> => q !== null)
    .map((q) => ({
      ticker: q.tickerCode,
      price: q.price,
      volume: q.volume,
    }));

  if (quotes.length === 0) {
    console.log(`${tag} スキップ: 時価取得0件（対象: ${tickers.length}銘柄）`);
    return;
  }

  // 5. スキャン実行
  const now = dayjs().tz(TIMEZONE).toDate();
  const triggers = scanner.scan(quotes, now, holdingTickers);

  console.log(
    `${tag} スキャン完了: WL=${watchlist.length} 時価=${quotes.length} 保有=${holdingTickers.size} トリガー=${triggers.length}`,
  );

  if (triggers.length > 0) {
    // 6. 既存pending注文の株数チェック（資金変動対応）
    await resizePendingOrders();

    // 6.5 ブレイクアウト前提崩壊チェック（出来高萎縮・高値割り込み）
    await invalidateStalePendingOrders(
      quotes,
      scanner.getState().lastSurgeRatios,
    );

    // 7. 各トリガーに対してエントリー実行（優先順位順に直列）
    // scanner が volumeSurgeRatio 降順でソート済み。
    // 直列実行により各 executeEntry が最新の残高を参照し、レースコンディションを防ぐ。
    for (const trigger of triggers) {
      console.log(
        `[breakout-monitor] トリガー発火: ${trigger.ticker} 価格=¥${trigger.currentPrice} 出来高サージ=${trigger.volumeSurgeRatio.toFixed(2)}x`,
      );
      try {
        const result = await executeEntry(trigger);
        if (!result.success) {
          // 一時的な理由で却下 → 再トリガーを許可
          if (result.retryable && scanner) {
            scanner.removeFromTriggeredToday(trigger.ticker);
            console.log(
              `[breakout-monitor] ${trigger.ticker} 再トリガー許可（理由: ${result.reason}）`,
            );
          }
          await notifySlack({
            title: `エントリー失敗: ${trigger.ticker}`,
            message: `理由: ${result.reason ?? "不明"}\n価格: ¥${trigger.currentPrice.toLocaleString()} / 出来高サージ: ${trigger.volumeSurgeRatio.toFixed(2)}x${result.retryable ? "\n※ 再トリガー対象" : ""}`,
            color: "warning",
          });
        }
      } catch (err) {
        console.error(
          `[breakout-monitor] エントリーエラー: ${trigger.ticker}`,
          err,
        );
        await notifySlack({
          title: `エントリー例外: ${trigger.ticker}`,
          message: `${err instanceof Error ? err.message : String(err)}\n価格: ¥${trigger.currentPrice.toLocaleString()}`,
          color: "danger",
        });
      }
    }
  }

  // ========================================
  // gapupスキャン（14:50以降、1日1回）
  // ========================================
  const jstNow = dayjs().tz(TIMEZONE);
  const currentMinutes = jstNow.hour() * 60 + jstNow.minute();
  const gapupScanTime = GAPUP.GUARD.SCAN_HOUR * 60 + GAPUP.GUARD.SCAN_MINUTE;

  if (!gapupScannedToday && currentMinutes >= gapupScanTime && gapupScanner) {
    gapupScannedToday = true;

    // breadthフィルター（バックテストの marketTrendFilter と同等）
    const livePriceMap = new Map(
      quotesRaw.filter((q): q is NonNullable<typeof q> => q !== null).map((q) => [q.tickerCode, q.price]),
    );
    const breadth = await calculateLiveBreadth(tickers, livePriceMap);
    console.log(`${tag} [gapup] breadth=${(breadth * 100).toFixed(1)}%`);

    if (breadth < GAPUP.MARKET_FILTER.BREADTH_THRESHOLD) {
      console.log(
        `${tag} [gapup] スキップ: breadth=${(breadth * 100).toFixed(1)}% < ${GAPUP.MARKET_FILTER.BREADTH_THRESHOLD * 100}%`,
      );
      return;
    }

    console.log(`${tag} [gapup] 14:50 gapupスキャン開始`);

    // quotesRawは既に取得済み（上のbreakoutスキャンで使った全銘柄OHLCVデータ）
    // YfQuoteResult には open, high, low, price, volume が全て含まれている
    const gapupQuotes: GapUpQuoteData[] = quotesRaw
      .filter((q): q is NonNullable<typeof q> => q !== null && q.open > 0 && q.volume > 0)
      .map((q) => ({
        ticker: q.tickerCode,
        open: q.open,
        price: q.price,
        high: q.high,
        low: q.low,
        volume: q.volume,
      }));

    if (gapupQuotes.length > 0) {
      const gapupTriggers = gapupScanner.scan(gapupQuotes, holdingTickers);
      console.log(
        `${tag} [gapup] スキャン完了: 時価=${gapupQuotes.length} トリガー=${gapupTriggers.length}`,
      );

      for (const trigger of gapupTriggers) {
        console.log(
          `${tag} [gapup] トリガー発火: ${trigger.ticker} 価格=¥${trigger.currentPrice} 出来高サージ=${trigger.volumeSurgeRatio.toFixed(2)}x`,
        );
        try {
          const result = await executeEntry(trigger, "gapup");
          if (!result.success) {
            await notifySlack({
              title: `[gapup] エントリー失敗: ${trigger.ticker}`,
              message: `理由: ${result.reason ?? "不明"}\n価格: ¥${trigger.currentPrice.toLocaleString()} / 出来高サージ: ${trigger.volumeSurgeRatio.toFixed(2)}x`,
              color: "warning",
            });
          }
        } catch (err) {
          console.error(`${tag} [gapup] エントリーエラー: ${trigger.ticker}`, err);
          await notifySlack({
            title: `[gapup] エントリー例外: ${trigger.ticker}`,
            message: `${err instanceof Error ? err.message : String(err)}`,
            color: "danger",
          });
        }
      }
    } else {
      console.log(`${tag} [gapup] スキップ: OHLCV取得0件`);
    }
  }
}

/**
 * ウォッチリスト銘柄のSMA25上回り比率（breadth）を計算する。
 * バックテストの marketTrendFilter と同等のロジック。
 */
async function calculateLiveBreadth(
  tickers: string[],
  livePrices: Map<string, number>,
): Promise<number> {
  const SMA_LEN = 25;
  const cutoff = dayjs().tz(TIMEZONE).subtract(45, "day").toDate();
  const bars = await prisma.stockDailyBar.findMany({
    where: { tickerCode: { in: tickers }, date: { gte: cutoff } },
    select: { tickerCode: true, close: true },
    orderBy: [{ tickerCode: "asc" }, { date: "asc" }],
  });

  const tickerCloses = new Map<string, number[]>();
  for (const bar of bars) {
    let arr = tickerCloses.get(bar.tickerCode);
    if (!arr) {
      arr = [];
      tickerCloses.set(bar.tickerCode, arr);
    }
    arr.push(bar.close);
  }

  let above = 0;
  let total = 0;
  for (const ticker of tickers) {
    const historical = tickerCloses.get(ticker);
    const livePrice = livePrices.get(ticker);
    if (!historical || !livePrice || historical.length < SMA_LEN - 1) continue;

    const closes = [...historical.slice(-(SMA_LEN - 1)), livePrice];
    const sma = closes.reduce((s, c) => s + c, 0) / closes.length;
    total++;
    if (livePrice > sma) above++;
  }
  return total > 0 ? above / total : 0;
}

/**
 * スキャナーをリセットする（テスト用）
 */
export function resetScanner(): void {
  scanner = null;
  gapupScanner = null;
  gapupScannedToday = false;
}
