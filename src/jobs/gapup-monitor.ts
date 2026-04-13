/**
 * ギャップアップモニタージョブ
 *
 * worker.tsのnode-cronから15:20-15:25に呼ばれる。
 * ウォッチリストの銘柄をリアルタイム時価でスキャンし、
 * ギャップアップトリガーが検出された場合はエントリーを実行する。
 */

import dayjs from "dayjs";
import utc from "dayjs/plugin/utc.js";
import timezone from "dayjs/plugin/timezone.js";
import { prisma } from "../lib/prisma";
import { getTodayForDB } from "../lib/market-date";
import { tachibanaFetchQuotesBatch } from "../lib/tachibana-price-client";
import { getWatchlist } from "./watchlist-builder";
import { executeEntry } from "../core/breakout/entry-executor";
import { notifySlack } from "../lib/slack";
import { TIMEZONE } from "../lib/constants";
import { GAPUP } from "../lib/constants/gapup";
import { GapUpScanner } from "../core/gapup/gapup-scanner";
import type { GapUpQuoteData } from "../core/gapup/gapup-scanner";

dayjs.extend(utc);
dayjs.extend(timezone);

/** スキャン済みフラグ（1日1回制限） */
let lastScanDate: string | null = null;

/**
 * ギャップアップモニターのメイン処理
 */
export async function main(): Promise<void> {
  const tag = "[gapup-monitor]";

  // 時刻チェック: 15:20以降のみ実行
  const jstNow = dayjs().tz(TIMEZONE);
  const scanStart = jstNow
    .clone()
    .hour(GAPUP.GUARD.SCAN_HOUR)
    .minute(GAPUP.GUARD.SCAN_MINUTE)
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

  // MarketAssessment 確認
  const todayAssessment = await prisma.marketAssessment.findUnique({
    where: { date: getTodayForDB() },
  });
  if (!todayAssessment || !todayAssessment.shouldTrade) {
    console.log(`${tag} スキップ: shouldTrade=${todayAssessment?.shouldTrade ?? "未作成"}`);
    lastScanDate = today;
    return;
  }

  lastScanDate = today;

  const watchlist = await getWatchlist();
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

  if (quotesNonNull.length === 0) {
    console.log(`${tag} スキップ: OHLCV取得0件`);
    return;
  }

  // breadthフィルター
  const livePriceMap = new Map(quotesNonNull.map((q) => [q.tickerCode, q.price]));
  const breadth = await calculateLiveBreadth(tickers, livePriceMap);
  console.log(`${tag} breadth=${(breadth * 100).toFixed(1)}%`);

  if (breadth < GAPUP.MARKET_FILTER.BREADTH_THRESHOLD) {
    console.log(
      `${tag} スキップ: breadth=${(breadth * 100).toFixed(1)}% < ${GAPUP.MARKET_FILTER.BREADTH_THRESHOLD * 100}%`,
    );
    return;
  }

  console.log(`${tag} gapupスキャン開始`);

  const gapupQuotes: GapUpQuoteData[] = quotesNonNull.map((q) => ({
    ticker: q.tickerCode,
    open: q.open,
    price: q.price,
    high: q.high,
    low: q.low,
    volume: q.volume,
  }));

  const gapupScanner = new GapUpScanner(watchlist);
  const gapupTriggers = gapupScanner.scan(gapupQuotes, holdingTickers);

  // トリガーに板情報を付与
  const rawQuoteMap = new Map(quotesNonNull.map((q) => [q.tickerCode, q]));
  for (const t of gapupTriggers) {
    const raw = rawQuoteMap.get(t.ticker);
    if (raw) {
      t.askPrice = raw.askPrice;
      t.bidPrice = raw.bidPrice;
      t.askSize = raw.askSize;
      t.bidSize = raw.bidSize;
    }
  }

  console.log(
    `${tag} スキャン完了: 時価=${gapupQuotes.length} トリガー=${gapupTriggers.length}`,
  );

  const triggerLines =
    gapupTriggers.length > 0
      ? gapupTriggers
          .map((t) => `• ${t.ticker} ¥${t.currentPrice.toLocaleString()} 出来高サージ ${t.volumeSurgeRatio.toFixed(2)}x`)
          .join("\n")
      : "シグナルなし";
  await notifySlack({
    title: `[gapup] スキャン完了: ${gapupTriggers.length}件`,
    message: `スキャン対象: ${gapupQuotes.length}銘柄 / breadth: ${(breadth * 100).toFixed(1)}%\n${triggerLines}`,
    color: gapupTriggers.length > 0 ? "good" : undefined,
  });

  // 1日1件制限: RR降順ソート済みの先頭シグナルのみエントリー（WF検証済み: PF 2.45→2.73）
  const topTriggers = gapupTriggers.slice(0, 1);
  for (const trigger of topTriggers) {
    console.log(
      `${tag} トリガー発火: ${trigger.ticker} 価格=¥${trigger.currentPrice} 出来高サージ=${trigger.volumeSurgeRatio.toFixed(2)}x`,
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
      console.error(`${tag} エントリーエラー: ${trigger.ticker}`, err);
      await notifySlack({
        title: `[gapup] エントリー例外: ${trigger.ticker}`,
        message: `${err instanceof Error ? err.message : String(err)}`,
        color: "danger",
      });
    }
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
