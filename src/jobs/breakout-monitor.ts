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
import { executeEntry } from "../core/breakout/entry-executor";
import { getWatchlist } from "./watchlist-builder";
import { tachibanaFetchQuotesBatch } from "../lib/tachibana-price-client";
import { prisma } from "../lib/prisma";
import { getTodayForDB } from "../lib/date-utils";
import { getEffectiveBrokerMode } from "../core/broker-orders";
import type { QuoteData } from "../core/breakout/breakout-scanner";

dayjs.extend(utc);
dayjs.extend(timezone);

let scanner: BreakoutScanner | null = null;
let lastScanDate: string | null = null;

/**
 * ブレイクアウトモニターのメイン処理（1分間隔で呼ばれる）
 */
export async function main(): Promise<void> {
  const watchlist = getWatchlist();
  if (watchlist.length === 0) {
    return;
  }

  // 日付変更検出 → スキャナーリセット
  const today = dayjs().tz("Asia/Tokyo").format("YYYY-MM-DD");
  if (lastScanDate && lastScanDate !== today) {
    scanner = null;
  }
  lastScanDate = today;

  if (!scanner) {
    scanner = new BreakoutScanner(watchlist);
  }

  // 0. 今日のMarketAssessmentを確認。shouldTrade=falseならスキャンをスキップ
  const todayAssessment = await prisma.marketAssessment.findUnique({
    where: { date: getTodayForDB() },
  });

  if (!todayAssessment || !todayAssessment.shouldTrade) {
    return;
  }

  // 1. 保有中ティッカーを取得
  const openPositions = await prisma.tradingPosition.findMany({
    where: { status: "open" },
    include: { stock: { select: { tickerCode: true } } },
  });
  const holdingTickers = new Set(openPositions.map((p) => p.stock.tickerCode));

  // 2. 本日のエントリー済み件数を取得
  const todayStart = dayjs().tz("Asia/Tokyo").startOf("day").toDate();
  const dailyEntryCount = await prisma.tradingOrder.count({
    where: {
      side: "buy",
      createdAt: { gte: todayStart },
    },
  });

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
    return;
  }

  // 5. スキャン実行
  const now = dayjs().tz("Asia/Tokyo").toDate();
  const triggers = scanner.scan(quotes, now, dailyEntryCount, holdingTickers);

  if (triggers.length === 0) {
    return;
  }

  // 6. ブローカーモード取得
  const brokerMode = await getEffectiveBrokerMode();

  // 7. 各トリガーに対してエントリー実行
  for (const trigger of triggers) {
    console.log(
      `[breakout-monitor] トリガー発火: ${trigger.ticker} 価格=¥${trigger.currentPrice} 出来高サージ=${trigger.volumeSurgeRatio.toFixed(2)}x`,
    );
    try {
      await executeEntry(trigger, brokerMode);
    } catch (err) {
      console.error(
        `[breakout-monitor] エントリーエラー: ${trigger.ticker}`,
        err,
      );
    }
  }
}

/**
 * スキャナーをリセットする（テスト用）
 */
export function resetScanner(): void {
  scanner = null;
}
