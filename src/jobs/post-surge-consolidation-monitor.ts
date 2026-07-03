/**
 * 高騰後押し目（Post-Surge Consolidation）モニタージョブ
 *
 * worker.ts の node-cron から 15:24 に呼ばれる（15:24:00/20/40 の3段リトライ）。
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
import { getSameDayPendingBuyTickers } from "../core/order-executor";
import { notifySlack } from "../lib/slack";
import { TIMEZONE } from "../lib/constants";
import { TRADING_DEFAULTS } from "../lib/constants/trading";
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

  // 時刻チェック: 15:24以降のみ実行
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

  // MarketAssessment 確認（当日確定 → フラグセット）
  const todayAssessment = await prisma.marketAssessment.findUnique({
    where: { date: getTodayForDB() },
  });
  if (!todayAssessment || !todayAssessment.shouldTrade) {
    const reason = `shouldTrade=${todayAssessment?.shouldTrade ?? "未作成"}`;
    console.log(`${tag} スキップ: ${reason}`);
    await notifySlack({
      title: `[PSC] スキャンスキップ`,
      message: reason,
    });
    lastScanDate = today;
    return;
  }

  const watchlist = await getAllWatchlist();
  if (!watchlist.length) {
    console.log(`${tag} スキップ: ウォッチリスト空`);
    await notifySlack({
      title: `[PSC] スキャンスキップ`,
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
    console.log(`${tag} PSCスキャン開始 (breadth=${breadth != null ? (breadth * 100).toFixed(1) + "%" : "N/A"})`);

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
      title: `[PSC] スキャン完了: ${triggers.length}件`,
      message: `スキャン対象: ${quotes.length}銘柄 / breadth: ${breadth != null ? (breadth * 100).toFixed(1) + "%" : "N/A"}\n${triggerLines}`,
      color: triggers.length > 0 ? "good" : undefined,
    });

    // 枠まで複数エントリー（旧「1日1件制限」は撤廃、KOH-505）。
    // 根拠: GU/PSC 単体WFで複数エントリーが頑健（IS/OOS比 ~1.0）、combined 長期BT(2024-03〜)で
    // 複数化により Calmar 7.16→20.31 / MaxDD 10.6%→6.0% と大幅改善。
    // triggers は holdingTickers（保有＋当日pending買い）除外済み・優先度降順ソート済み。
    if (triggers.length === 0) {
      lastScanDate = today;
      return;
    }

    // 当日の空きPSC枠を算出（既存の open/ordered な PSC ポジション分を差し引く）。
    // 同一ループ内の枠超過は slotsLeft の自前カウントで防ぎ、二重建ては holdingTickers 除外で別途担保。
    const pscOpenCount = openPositions.filter((p) => p.strategy === "post-surge-consolidation").length;
    let slotsLeft = TRADING_DEFAULTS.MAX_POSITIONS_PSC - pscOpenCount;
    if (slotsLeft <= 0) {
      console.log(`${tag} PSC枠が既に埋まっています（${pscOpenCount}/${TRADING_DEFAULTS.MAX_POSITIONS_PSC}）`);
      lastScanDate = today;
      return;
    }

    let anyRetryable = false;
    for (const trigger of triggers) {
      if (slotsLeft <= 0) break; // 枠を使い切ったら当日確定
      console.log(
        `${tag} トリガー発火: ${trigger.ticker} 価格=¥${trigger.currentPrice} モメンタム=${(trigger.momentumReturn * 100).toFixed(1)}% 出来高サージ=${trigger.volumeSurgeRatio.toFixed(2)}x`,
      );
      try {
        const result = await executeEntry(trigger, "post-surge-consolidation");
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
        // 銘柄固有の理由（集中率上限・投資比率上限・セクター上限・SLクランプ等）→ 次候補へ
        if (result.retryable) {
          console.log(`${tag} スキップ（次候補へ）: ${trigger.ticker} / ${reason}`);
        } else {
          await notifySlack({
            title: `[PSC] エントリー失敗: ${trigger.ticker}`,
            message: `理由: ${reason}\n価格: ¥${trigger.currentPrice.toLocaleString()} / モメンタム: ${(trigger.momentumReturn * 100).toFixed(1)}%`,
            color: "warning",
          });
        }
      } catch (err) {
        console.error(`${tag} エントリーエラー: ${trigger.ticker}`, err);
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
    // 時価取得や DB クエリ等の例外（フラグ未セット → 次分リトライ）
    console.error(`${tag} スキャンエラー:`, err);
    await notifySlack({
      title: `[PSC] スキャンエラー（リトライ待機）`,
      message: `${err instanceof Error ? err.message : String(err)}`,
      color: "warning",
    });
  }
}

/**
 * PSCシグナル判定に必要な直近履歴データをバッチ取得する
 * - close20DaysAgo: 20営業日前の終値
 * - high20: 直近20営業日の最高終値
 */
async function fetchPSCHistoricalData(tickers: string[]): Promise<Map<string, PSCHistoricalData>> {
  const LOOKBACK_DAYS = 25; // 必要な営業日数（余裕を持たせるため50日分取得）
  const cutoff = dayjs().tz(TIMEZONE).subtract(50, "day").toDate();

  const bars = await prisma.stockDailyBar.findMany({
    where: { tickerCode: { in: tickers }, date: { gte: cutoff } },
    select: { tickerCode: true, close: true },
    orderBy: [{ tickerCode: "asc" }, { date: "asc" }],
  });

  const tickerBars = new Map<string, Array<{ close: number }>>();
  for (const bar of bars) {
    let arr = tickerBars.get(bar.tickerCode);
    if (!arr) {
      arr = [];
      tickerBars.set(bar.tickerCode, arr);
    }
    arr.push({ close: bar.close });
  }

  const result = new Map<string, PSCHistoricalData>();
  for (const [ticker, barList] of tickerBars) {
    if (barList.length < LOOKBACK_DAYS) continue;

    const recent = barList.slice(-LOOKBACK_DAYS); // 直近25営業日
    const close20DaysAgo = recent[recent.length - 20].close; // 20営業日前
    const high20 = Math.max(...recent.slice(-20).map((b) => b.close)); // 直近20日の最高終値

    result.set(ticker, { close20DaysAgo, high20 });
  }

  return result;
}


/**
 * スキャン済みフラグをリセットする（テスト用）
 */
export function resetScanner(): void {
  lastScanDate = null;
}
