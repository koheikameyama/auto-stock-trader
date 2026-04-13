/**
 * 週足レンジブレイクモニタージョブ
 *
 * 週末最終営業日の15:20に実行。
 * ウォッチリスト銘柄のリアルタイム時価 + 日足→週足変換で
 * 週足レンジブレイクシグナルを検出し、エントリーを実行する。
 */

import dayjs from "dayjs";
import utc from "dayjs/plugin/utc.js";
import timezone from "dayjs/plugin/timezone.js";
import { prisma } from "../lib/prisma";
import { getTodayForDB, countNonTradingDaysAhead } from "../lib/market-date";
import { tachibanaFetchQuotesBatch } from "../lib/tachibana-price-client";
import { getGuWatchlist } from "./watchlist-builder";
import { executeEntry } from "../core/breakout/entry-executor";
import { getEffectiveCapital } from "../core/position-manager";
import { notifySlack } from "../lib/slack";
import { TIMEZONE } from "../lib/constants";
import { WEEKLY_BREAK } from "../lib/constants/weekly-break";
import {
  WeeklyBreakScanner,
  groupDailyBarsByTicker,
  buildWeeklyBarsFromDaily,
} from "../core/weekly-break/weekly-break-scanner";
import type { GapUpQuoteData } from "../core/gapup/gapup-scanner";

dayjs.extend(utc);
dayjs.extend(timezone);

/** スキャン済みフラグ（1日1回制限） */
let lastScanDate: string | null = null;

/**
 * 週足レンジブレイクモニターのメイン処理
 */
export async function main(): Promise<void> {
  const tag = "[weekly-break-monitor]";

  // ENTRY_ENABLED チェック
  if (!WEEKLY_BREAK.ENTRY_ENABLED) {
    return;
  }

  // 時刻チェック: 15:20以降のみ実行
  const jstNow = dayjs().tz(TIMEZONE);
  const scanStart = jstNow
    .clone()
    .hour(WEEKLY_BREAK.GUARD.SCAN_HOUR)
    .minute(WEEKLY_BREAK.GUARD.SCAN_MINUTE)
    .second(0)
    .millisecond(0);
  if (jstNow.isBefore(scanStart)) {
    return;
  }

  // 1日1回制限
  const today = jstNow.format("YYYY-MM-DD");
  if (lastScanDate === today) {
    return;
  }

  // 週末最終営業日チェック
  const nonTradingDaysAhead = countNonTradingDaysAhead();
  const isLastDayOfWeek = nonTradingDaysAhead >= 2;
  if (!isLastDayOfWeek) {
    lastScanDate = today; // 非週末日はスキップ記録して以降呼ばれても即リターン
    return;
  }

  // MarketAssessment 確認
  const todayAssessment = await prisma.marketAssessment.findUnique({
    where: { date: getTodayForDB() },
  });
  if (!todayAssessment || !todayAssessment.shouldTrade) {
    console.log(`${tag} スキップ: shouldTrade=${todayAssessment?.shouldTrade ?? "未作成"}`);
    lastScanDate = today;
    return;
  }

  console.log(`${tag} 週末最終営業日: WBスキャン開始`);
  lastScanDate = today;

  const watchlist = await getGuWatchlist();
  if (!watchlist.length) {
    console.log(`${tag} スキップ: ウォッチリスト空`);
    return;
  }

  const tickers = watchlist.map((e) => e.ticker);

  // 保有ポジション取得
  const openPositions = await prisma.tradingPosition.findMany({
    where: { status: "open" },
    include: { stock: { select: { tickerCode: true } } },
  });
  const holdingTickers = new Set(openPositions.map((p) => p.stock.tickerCode));

  // リアルタイム時価を一括取得
  const quotesRaw = await tachibanaFetchQuotesBatch(tickers);
  const quotesNonNull = quotesRaw.filter(
    (q): q is NonNullable<typeof q> => q !== null && q.open > 0 && q.volume > 0,
  );

  const quoteData: GapUpQuoteData[] = quotesNonNull.map((q) => ({
    ticker: q.tickerCode,
    open: q.open,
    price: q.price,
    high: q.high,
    low: q.low,
    volume: q.volume,
  }));

  if (quoteData.length === 0) {
    console.log(`${tag} スキップ: OHLCV取得0件`);
    return;
  }

  // breadthフィルター
  const livePriceMap = new Map(quotesNonNull.map((q) => [q.tickerCode, q.price]));
  const breadth = await calculateLiveBreadth(tickers, livePriceMap);
  console.log(`${tag} breadth=${(breadth * 100).toFixed(1)}%`);

  if (breadth < WEEKLY_BREAK.MARKET_FILTER.BREADTH_THRESHOLD) {
    console.log(
      `${tag} スキップ: breadth=${(breadth * 100).toFixed(1)}% < ${WEEKLY_BREAK.MARKET_FILTER.BREADTH_THRESHOLD * 100}%`,
    );
    return;
  }

  try {
    // 1. 日足データ一括フェッチ（過去100日）
    const cutoff = dayjs().tz(TIMEZONE).subtract(100, "day").format("YYYY-MM-DD");
    const dailyBars = await prisma.stockDailyBar.findMany({
      where: { tickerCode: { in: tickers }, date: { gte: new Date(cutoff) } },
      select: {
        tickerCode: true,
        date: true,
        open: true,
        high: true,
        low: true,
        close: true,
        volume: true,
      },
      orderBy: [{ tickerCode: "asc" }, { date: "asc" }],
    });

    // 2. 銘柄別に日足→週足変換（volume: bigint → number）
    const dailyBarsNormalized = dailyBars.map((b) => ({
      ...b,
      volume: Number(b.volume),
    }));
    const tickerDaily = groupDailyBarsByTicker(dailyBarsNormalized);
    const tickerWeekly = buildWeeklyBarsFromDaily(tickerDaily);

    // 3. スキャン
    const effectiveCap = await getEffectiveCapital();
    const wbScanner = new WeeklyBreakScanner(watchlist, tickerWeekly);
    const wbTriggers = wbScanner.scan(quoteData, holdingTickers, effectiveCap);

    // 4. トリガーに板情報を付与
    const rawQuoteMap = new Map(quotesNonNull.map((q) => [q.tickerCode, q]));
    for (const t of wbTriggers) {
      const raw = rawQuoteMap.get(t.ticker);
      if (raw) {
        t.askPrice = raw.askPrice;
        t.bidPrice = raw.bidPrice;
        t.askSize = raw.askSize;
        t.bidSize = raw.bidSize;
      }
    }

    console.log(
      `${tag} スキャン完了: 対象=${quoteData.length} トリガー=${wbTriggers.length}`,
    );

    const triggerLines =
      wbTriggers.length > 0
        ? wbTriggers
            .map(
              (t) =>
                `• ${t.ticker} ¥${t.currentPrice.toLocaleString()} 週高値¥${t.weeklyHigh.toLocaleString()} サージ${t.volumeSurgeRatio.toFixed(2)}x`,
            )
            .join("\n")
        : "シグナルなし";
    await notifySlack({
      title: `[weekly-break] スキャン完了: ${wbTriggers.length}件`,
      message: `スキャン対象: ${quoteData.length}銘柄 / breadth: ${(breadth * 100).toFixed(1)}%\n${triggerLines}`,
      color: wbTriggers.length > 0 ? "good" : undefined,
    });

    // 5. エントリー実行
    for (const trigger of wbTriggers) {
      console.log(
        `${tag} トリガー発火: ${trigger.ticker} 価格=¥${trigger.currentPrice} 週高値=¥${trigger.weeklyHigh} サージ=${trigger.volumeSurgeRatio.toFixed(2)}x`,
      );
      try {
        const result = await executeEntry(trigger, "weekly-break");
        if (!result.success) {
          await notifySlack({
            title: `[weekly-break] エントリー失敗: ${trigger.ticker}`,
            message: `理由: ${result.reason ?? "不明"}\n価格: ¥${trigger.currentPrice.toLocaleString()} / 出来高サージ: ${trigger.volumeSurgeRatio.toFixed(2)}x`,
            color: "warning",
          });
        }
      } catch (err) {
        console.error(`${tag} エントリーエラー: ${trigger.ticker}`, err);
        await notifySlack({
          title: `[weekly-break] エントリー例外: ${trigger.ticker}`,
          message: `${err instanceof Error ? err.message : String(err)}`,
          color: "danger",
        });
      }
    }
  } catch (err) {
    console.error(`${tag} スキャンエラー:`, err);
    await notifySlack({
      title: `[weekly-break] スキャンエラー`,
      message: `${err instanceof Error ? err.message : String(err)}`,
      color: "danger",
    });
  }
}

/**
 * ウォッチリスト銘柄のSMA25上回り比率（breadth）を計算する
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
 * スキャン済みフラグをリセットする（テスト用）
 */
export function resetScanner(): void {
  lastScanDate = null;
}
