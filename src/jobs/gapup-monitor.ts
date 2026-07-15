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
import { getSameDayPendingBuyTickers, countSameDayPendingBuys } from "../core/order-executor";
import { notifySlack } from "../lib/slack";
import { TIMEZONE } from "../lib/constants";
import { TRADING_DEFAULTS } from "../lib/constants/trading";
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
    const reason = `shouldTrade=${todayAssessment?.shouldTrade ?? "未作成"}`;
    console.log(`${tag} スキップ: ${reason}`);
    await notifySlack({
      title: `[GU] スキャンスキップ`,
      message: reason,
    });
    lastScanDate = today;
    return;
  }

  const watchlist = await getGuWatchlist();
  if (!watchlist.length) {
    console.log(`${tag} スキップ: ウォッチリスト空`);
    await notifySlack({
      title: `[GU] スキャンスキップ`,
      message: "ウォッチリスト空",
    });
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
    // 約定前は TradingPosition が無いため、当日の pending 買い注文（全戦略横断）も保有扱いで除外。
    // 先行する GU/PSC が出した未約定注文を検知できず同一銘柄に二重建てする事故を防ぐ（Issue #322）。
    for (const t of await getSameDayPendingBuyTickers()) holdingTickers.add(t);

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

    // breadthフィルターはmarket-assessmentのshouldTradeに統合済み

    const breadth = todayAssessment.breadth != null ? Number(todayAssessment.breadth) : null;
    console.log(`${tag} gapupスキャン開始 (breadth=${breadth != null ? (breadth * 100).toFixed(1) + "%" : "N/A"})`);

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
      message: `スキャン対象: ${gapupQuotes.length}銘柄 / breadth: ${breadth != null ? (breadth * 100).toFixed(1) + "%" : "N/A"}\n${triggerLines}`,
      color: gapupTriggers.length > 0 ? "good" : undefined,
    });

    // 枠まで複数エントリー（旧「1日1件制限」は撤廃、KOH-505）。
    // 根拠: GU/PSC 単体WFで複数エントリーが頑健（IS/OOS比 ~1.0）、combined 長期BT(2024-03〜)で
    // 複数化により Calmar 7.16→20.31 / MaxDD 10.6%→6.0% と大幅改善。首位が集中率上限等で
    // 弾かれても次候補を拾えるようになり、機会の取りこぼしを防ぐ。
    // gapupTriggers は holdingTickers（保有＋当日pending買い）除外済み・gapPct×volumeSurge 降順ソート済み。
    if (gapupTriggers.length === 0) {
      lastScanDate = today;
      return;
    }

    // 当日の空きGU枠を算出。保有中の GU ポジションに加えて「当日発注済みで未約定の GU 買い注文」も
    // 枠を消費しているものとして数える。TradingPosition は約定時（15:30）にしか作られないため、
    // 発注中の注文を数えないと 15:24:00/20/40 のリトライ tick ごとに slotsLeft が満タンに復活し、
    // 上限を超えて発注される（KOH-553）。
    // 同一ループ内の枠超過は slotsLeft の自前カウントで防ぎ、二重建ては holdingTickers 除外で別途担保。
    const guOpenCount = openPositions.filter((p) => p.strategy === "gapup").length;
    const guPendingCount = await countSameDayPendingBuys("gapup");
    const guUsedSlots = guOpenCount + guPendingCount;
    let slotsLeft = TRADING_DEFAULTS.MAX_POSITIONS_GU - guUsedSlots;
    if (slotsLeft <= 0) {
      console.log(
        `${tag} GU枠が既に埋まっています（保有 ${guOpenCount} + 発注中 ${guPendingCount} / ${TRADING_DEFAULTS.MAX_POSITIONS_GU}）`,
      );
      lastScanDate = today;
      return;
    }

    let anyRetryable = false;
    for (const trigger of gapupTriggers) {
      if (slotsLeft <= 0) break; // 枠を使い切ったら当日確定
      console.log(
        `${tag} トリガー発火: ${trigger.ticker} 価格=¥${trigger.currentPrice} 出来高サージ=${trigger.volumeSurgeRatio.toFixed(2)}x`,
      );
      try {
        const result = await executeEntry(trigger, "gapup");
        if (result.success) {
          slotsLeft--;
          continue;
        }
        const reason = result.reason ?? "不明";
        // 当日これ以上どの銘柄も建てられない構造的理由 → 打ち止め（当日確定）
        if (/最大同時保有数|現金残高不足|予算不足|日次損失制限/.test(reason)) {
          console.log(`${tag} 当日打ち止め: ${trigger.ticker} / ${reason}`);
          break;
        }
        // executeEntry が retryable=true を返すのは一時障害（ブローカーのネットワーク/セッション障害・
        // 流動性不足など）。次候補は試しつつ、当日フラグを立てず次分の cron で全体を再スキャンさせる
        // （約定済みは holdingTickers で除外されるため二重建てにならない）。
        // retryable=false は銘柄固有の構造的リジェクト（集中率上限・投資比率上限・セクター上限等）→
        // Slack warning を出して次候補へ（当日確定でよい）。
        if (result.retryable) {
          anyRetryable = true;
          console.log(`${tag} リトライ待機（次候補も試行）: ${trigger.ticker} / ${reason}`);
        } else {
          await notifySlack({
            title: `[GU] エントリー失敗: ${trigger.ticker}`,
            message: `理由: ${reason}\n価格: ¥${trigger.currentPrice.toLocaleString()} / 出来高サージ: ${trigger.volumeSurgeRatio.toFixed(2)}x`,
            color: "warning",
          });
        }
      } catch (err) {
        console.error(`${tag} エントリーエラー: ${trigger.ticker}`, err);
        // エントリー処理中の例外はリトライ可能扱い（ネットワーク/DB等の一時障害）
        anyRetryable = true;
      }
    }

    // 一時障害が無ければ（成功 or 銘柄固有スキップ or 枠/資金の打ち止め）当日確定
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
