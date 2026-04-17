/**
 * ギャップアップモニタージョブ
 *
 * worker.tsのnode-cronから15:24に呼ばれる（15:24:00/20/40 の3段リトライ）。
 * ウォッチリストの銘柄をリアルタイム時価でスキャンし、
 * ギャップアップトリガーが検出された場合はエントリーを実行する。
 */

import dayjs from "dayjs";
import utc from "dayjs/plugin/utc.js";
import timezone from "dayjs/plugin/timezone.js";
import { prisma } from "../lib/prisma";
import { getTodayForDB } from "../lib/market-date";
import { tachibanaFetchQuotesBatch } from "../lib/tachibana-price-client";
import { getGuWatchlist } from "./watchlist-builder";
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

  // 時刻チェック: 15:24以降のみ実行
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

  // MarketAssessment 確認（shouldTrade=false は当日確定 → フラグセット）
  const todayAssessment = await prisma.marketAssessment.findUnique({
    where: { date: getTodayForDB() },
  });
  if (!todayAssessment || !todayAssessment.shouldTrade) {
    console.log(`${tag} スキップ: shouldTrade=${todayAssessment?.shouldTrade ?? "未作成"}`);
    lastScanDate = today;
    return;
  }

  const watchlist = await getGuWatchlist();
  if (!watchlist.length) {
    console.log(`${tag} スキップ: ウォッチリスト空`);
    lastScanDate = today;
    return;
  }

  const tickers = watchlist.map((e) => e.ticker);

  try {
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
      // 時価取得ゼロ件（API障害の可能性）→ 次分リトライ待機（フラグ未セット）
      console.log(`${tag} スキップ: OHLCV取得0件（次分リトライ）`);
      return;
    }

    // breadthフィルター（MarketAssessmentの全銘柄SMA25 breadthを使用 — バックテストと同一基準）
    const breadth = todayAssessment.breadth != null ? Number(todayAssessment.breadth) : null;
    console.log(`${tag} breadth=${breadth != null ? (breadth * 100).toFixed(1) + "%" : "N/A"}`);

    if (breadth == null || breadth < GAPUP.MARKET_FILTER.BREADTH_THRESHOLD) {
      console.log(
        `${tag} スキップ: breadth=${breadth != null ? (breadth * 100).toFixed(1) + "%" : "N/A"} < ${GAPUP.MARKET_FILTER.BREADTH_THRESHOLD * 100}%`,
      );
      lastScanDate = today;
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
      title: `[GU] スキャン完了: ${gapupTriggers.length}件`,
      message: `スキャン対象: ${gapupQuotes.length}銘柄 / breadth: ${(breadth * 100).toFixed(1)}%\n${triggerLines}`,
      color: gapupTriggers.length > 0 ? "good" : undefined,
    });

    // 1日1件制限: RR降順ソート済みの先頭シグナルのみエントリー（WF検証済み: PF 2.45→2.73）
    const topTriggers = gapupTriggers.slice(0, 1);

    // トリガー0件 → 当日はシグナルなしで確定 → フラグセット
    if (topTriggers.length === 0) {
      lastScanDate = today;
      return;
    }

    let anyRetryable = false;
    for (const trigger of topTriggers) {
      console.log(
        `${tag} トリガー発火: ${trigger.ticker} 価格=¥${trigger.currentPrice} 出来高サージ=${trigger.volumeSurgeRatio.toFixed(2)}x`,
      );
      try {
        const result = await executeEntry(trigger, "gapup");
        if (!result.success) {
          if (result.retryable) {
            anyRetryable = true;
            console.log(
              `${tag} エントリー失敗（リトライ可能）: ${trigger.ticker} / ${result.reason ?? "不明"}`,
            );
          } else {
            await notifySlack({
              title: `[GU] エントリー失敗: ${trigger.ticker}`,
              message: `理由: ${result.reason ?? "不明"}\n価格: ¥${trigger.currentPrice.toLocaleString()} / 出来高サージ: ${trigger.volumeSurgeRatio.toFixed(2)}x`,
              color: "warning",
            });
          }
        }
      } catch (err) {
        console.error(`${tag} エントリーエラー: ${trigger.ticker}`, err);
        // エントリー処理中の例外はリトライ可能扱い（ネットワーク/DB等の一時障害）
        anyRetryable = true;
      }
    }

    // リトライ不要（成功 or 非リトライエラー）でのみフラグをセット
    if (!anyRetryable) {
      lastScanDate = today;
    } else {
      console.log(`${tag} 発注失敗（リトライ可能）: 次分の cron で再試行します`);
    }
  } catch (err) {
    // 時価取得や breadth 計算等の例外（フラグ未セット → 次分リトライ）
    console.error(`${tag} スキャンエラー:`, err);
    await notifySlack({
      title: `[GU] スキャンエラー（リトライ待機）`,
      message: `${err instanceof Error ? err.message : String(err)}`,
      color: "warning",
    });
  }
}


/**
 * スキャン済みフラグをリセットする（テスト用）
 */
export function resetScanner(): void {
  lastScanDate = null;
}
