/**
 * 高騰後押し目（Post-Surge Consolidation）モニタージョブ
 *
 * worker.ts の node-cron から 15:20-15:25 に呼ばれる。
 * ウォッチリストの銘柄をリアルタイム時価でスキャンし、
 * PSC トリガーが検出された場合はエントリーを実行する。
 */

import dayjs from "dayjs";
import utc from "dayjs/plugin/utc.js";
import timezone from "dayjs/plugin/timezone.js";
import { prisma } from "../lib/prisma";
import { getTodayForDB } from "../lib/market-date";
import { tachibanaFetchQuotesBatch } from "../lib/tachibana-price-client";
import { getAllWatchlist } from "./watchlist-builder";
import { executeEntry } from "../core/breakout/entry-executor";
import { notifySlack } from "../lib/slack";
import { TIMEZONE } from "../lib/constants";
import { GAPUP } from "../lib/constants/gapup";
import { POST_SURGE_CONSOLIDATION } from "../lib/constants/post-surge-consolidation";
import { PostSurgeConsolidationScanner } from "../core/post-surge-consolidation/psc-scanner";
import type { PSCHistoricalData } from "../core/post-surge-consolidation/psc-scanner";

dayjs.extend(utc);
dayjs.extend(timezone);

/** スキャン済みフラグ（1日1回制限） */
let lastScanDate: string | null = null;

/**
 * PSCモニターのメイン処理
 */
export async function main(): Promise<void> {
  const tag = "[psc-monitor]";

  if (!POST_SURGE_CONSOLIDATION.ENTRY_ENABLED) {
    return;
  }

  // 時刻チェック: 15:20以降のみ実行
  const jstNow = dayjs().tz(TIMEZONE);
  const scanStart = jstNow.clone().hour(GAPUP.GUARD.SCAN_HOUR).minute(GAPUP.GUARD.SCAN_MINUTE).second(0).millisecond(0);
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

  const watchlist = await getAllWatchlist();
  if (!watchlist.length) {
    console.log(`${tag} スキップ: ウォッチリスト空`);
    return;
  }

  const tickers = watchlist.map((e) => e.ticker);

  // 保有・注文中ポジション取得（二重発注防止のため ordered も除外）
  const openPositions = await prisma.tradingPosition.findMany({
    where: { status: { in: ["open", "ordered"] } },
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

  // breadthフィルター（gapupと同一ロジック）
  const livePriceMap = new Map(quotesNonNull.map((q) => [q.tickerCode, q.price]));
  const breadth = await calculateLiveBreadth(tickers, livePriceMap);
  console.log(`${tag} breadth=${(breadth * 100).toFixed(1)}%`);

  if (breadth < GAPUP.MARKET_FILTER.BREADTH_THRESHOLD) {
    console.log(`${tag} スキップ: breadth=${(breadth * 100).toFixed(1)}% < ${GAPUP.MARKET_FILTER.BREADTH_THRESHOLD * 100}%`);
    return;
  }

  // PSC用履歴データをバッチ取得（直近25営業日分）
  const historicalMap = await fetchPSCHistoricalData(tickers);

  console.log(`${tag} PSCスキャン開始`);

  const quotes = quotesNonNull.map((q) => ({
    ticker: q.tickerCode,
    open: q.open,
    price: q.price,
    volume: q.volume,
  }));

  const scanner = new PostSurgeConsolidationScanner(watchlist);
  const triggers = scanner.scan(quotes, historicalMap, holdingTickers);

  // トリガーに板情報を付与
  const rawQuoteMap = new Map(quotesNonNull.map((q) => [q.tickerCode, q]));
  for (const t of triggers) {
    const raw = rawQuoteMap.get(t.ticker);
    if (raw) {
      t.askPrice = raw.askPrice;
      t.bidPrice = raw.bidPrice;
      t.askSize = raw.askSize;
      t.bidSize = raw.bidSize;
    }
  }

  console.log(`${tag} スキャン完了: 時価=${quotes.length} トリガー=${triggers.length}`);

  const triggerLines =
    triggers.length > 0
      ? triggers
          .map((t) => `• ${t.ticker} ¥${t.currentPrice.toLocaleString()} モメンタム ${(t.momentumReturn * 100).toFixed(1)}% 出来高サージ ${t.volumeSurgeRatio.toFixed(2)}x`)
          .join("\n")
      : "シグナルなし";
  await notifySlack({
    title: `[psc] スキャン完了: ${triggers.length}件`,
    message: `スキャン対象: ${quotes.length}銘柄 / breadth: ${(breadth * 100).toFixed(1)}%\n${triggerLines}`,
    color: triggers.length > 0 ? "good" : undefined,
  });

  // 1日1件制限
  const topTriggers = triggers.slice(0, 1);
  for (const trigger of topTriggers) {
    console.log(
      `${tag} トリガー発火: ${trigger.ticker} 価格=¥${trigger.currentPrice} モメンタム=${(trigger.momentumReturn * 100).toFixed(1)}% 出来高サージ=${trigger.volumeSurgeRatio.toFixed(2)}x`,
    );
    try {
      const result = await executeEntry(trigger, "post-surge-consolidation");
      if (!result.success) {
        await notifySlack({
          title: `[psc] エントリー失敗: ${trigger.ticker}`,
          message: `理由: ${result.reason ?? "不明"}\n価格: ¥${trigger.currentPrice.toLocaleString()} / モメンタム: ${(trigger.momentumReturn * 100).toFixed(1)}%`,
          color: "warning",
        });
      }
    } catch (err) {
      console.error(`${tag} エントリーエラー: ${trigger.ticker}`, err);
      await notifySlack({
        title: `[psc] エントリー例外: ${trigger.ticker}`,
        message: `${err instanceof Error ? err.message : String(err)}`,
        color: "danger",
      });
    }
  }
}

/**
 * PSCシグナル判定に必要な直近履歴データをバッチ取得する
 * - close20DaysAgo: 20営業日前の終値
 * - high20: 直近20営業日の最高終値
 * - prevVolume: 前日出来高
 */
async function fetchPSCHistoricalData(tickers: string[]): Promise<Map<string, PSCHistoricalData>> {
  const LOOKBACK_DAYS = 25; // 必要な営業日数（余裕を持たせるため50日分取得）
  const cutoff = dayjs().tz(TIMEZONE).subtract(50, "day").toDate();

  const bars = await prisma.stockDailyBar.findMany({
    where: { tickerCode: { in: tickers }, date: { gte: cutoff } },
    select: { tickerCode: true, close: true, volume: true },
    orderBy: [{ tickerCode: "asc" }, { date: "asc" }],
  });

  const tickerBars = new Map<string, Array<{ close: number; volume: number }>>();
  for (const bar of bars) {
    let arr = tickerBars.get(bar.tickerCode);
    if (!arr) {
      arr = [];
      tickerBars.set(bar.tickerCode, arr);
    }
    arr.push({ close: bar.close, volume: Number(bar.volume) });
  }

  const result = new Map<string, PSCHistoricalData>();
  for (const [ticker, barList] of tickerBars) {
    if (barList.length < LOOKBACK_DAYS) continue;

    const recent = barList.slice(-LOOKBACK_DAYS); // 直近25営業日
    const prevVolume = recent[recent.length - 1].volume; // 最終バー = 昨日
    const close20DaysAgo = recent[recent.length - 20].close; // 20営業日前
    const high20 = Math.max(...recent.slice(-20).map((b) => b.close)); // 直近20日の最高終値

    result.set(ticker, { close20DaysAgo, high20, prevVolume });
  }

  return result;
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
