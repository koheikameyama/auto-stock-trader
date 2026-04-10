/**
 * ブレイクアウトモニタージョブ
 *
 * worker.tsのnode-cronから1分間隔で呼ばれる。
 * ウォッチリストの銘柄をリアルタイム時価でスキャンし、
 * ブレイクアウトトリガーが検出された場合はエントリーを実行する。
 */

import { BreakoutScanner } from "../core/breakout/breakout-scanner";
import { executeEntry, resizePendingOrders, invalidateStalePendingOrders } from "../core/breakout/entry-executor";
import { getCashBalance } from "../core/position-manager";
import { getWatchlist } from "./watchlist-builder";
import { tachibanaFetchQuotesBatch } from "../lib/tachibana-price-client";
import { prisma } from "../lib/prisma";
import { getTodayForDB } from "../lib/market-date";
import { notifySlack } from "../lib/slack";
import { TIMEZONE } from "../lib/constants";
import { BREAKOUT } from "../lib/constants/breakout";
import { STOP_LOSS } from "../lib/constants";
import dayjs from "dayjs";
import timezone from "dayjs/plugin/timezone.js";
import utc from "dayjs/plugin/utc.js";
import type { QuoteData } from "../core/breakout/breakout-scanner";
import { getContrarianHistoryBatch, calculateContinuousContrarianBonus } from "../core/contrarian-analyzer";

dayjs.extend(utc);
dayjs.extend(timezone);


let scanner: BreakoutScanner | null = null;
let lastScanDate: string | null = null;
/** 保有中ティッカー（直近スキャン時のスナップショット） */
let lastHoldingTickers: Set<string> = new Set();
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
  }
  lastScanDate = today;

  if (!scanner) {
    scanner = new BreakoutScanner(watchlist);
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
  const quotesNonNull = quotesRaw.filter((q): q is NonNullable<typeof q> => q !== null);
  const quotes: QuoteData[] = quotesNonNull.map((q) => ({
    ticker: q.tickerCode,
    price: q.price,
    volume: q.volume,
  }));

  // 板情報付きの raw quote を ticker でルックアップ（トリガーに板情報を載せる用）
  const rawQuoteMap = new Map(quotesNonNull.map((q) => [q.tickerCode, q]));

  if (quotes.length === 0) {
    console.log(`${tag} スキップ: 時価取得0件（対象: ${tickers.length}銘柄）`);
    return;
  }

  // 4.5 前提崩壊チェック → キャンセル済み注文の triggeredToday を解除（前提崩壊は除外）
  const premiseCollapsedTickers = await invalidateStalePendingOrders(
    quotes,
    scanner.getState().lastSurgeRatios,
  );
  // 前提崩壊銘柄をScannerの永続Setに記録（当日中は再エントリー禁止）
  for (const ticker of premiseCollapsedTickers) {
    scanner.addPremiseCollapsed(ticker);
  }
  await reactivateCancelledTriggers(scanner);

  // 5. スキャン実行（breakoutエントリーが無効の場合はスキップ）
  if (!BREAKOUT.ENTRY_ENABLED) {
    console.log(`${tag} breakoutエントリー無効（ENTRY_ENABLED=false）→ スキャンスキップ`);
  }
  const now = dayjs().tz(TIMEZONE).toDate();
  const triggers = BREAKOUT.ENTRY_ENABLED ? scanner.scan(quotes, now, holdingTickers) : [];

  // トリガーに板情報を付与（スキャン時の raw quote から転写）
  for (const t of triggers) {
    const raw = rawQuoteMap.get(t.ticker);
    if (raw) {
      t.askPrice = raw.askPrice;
      t.bidPrice = raw.bidPrice;
      t.askSize = raw.askSize;
      t.bidSize = raw.bidSize;
    }
  }

  console.log(
    `${tag} スキャン完了: WL=${watchlist.length} 時価=${quotes.length} 保有=${holdingTickers.size} トリガー=${triggers.length}`,
  );

  if (triggers.length > 0) {
    // 5.5 RR・SL%を事前計算し、優先順位ソート
    const slAtrMul = BREAKOUT.STOP_LOSS.ATR_MULTIPLIER;
    const priorityMap = new Map<string, { rr: number; slPct: number }>();
    for (const t of triggers) {
      const rawSL = t.currentPrice - t.atr14 * slAtrMul;
      const maxSL = t.currentPrice * (1 - STOP_LOSS.MAX_LOSS_PCT);
      const sl = Math.max(rawSL, maxSL);
      const risk = t.currentPrice - sl;
      const reward = t.atr14 * 5.0;
      priorityMap.set(t.ticker, {
        rr: risk > 0 ? reward / risk : 0,
        slPct: risk / t.currentPrice,
      });
    }

    // 逆行ボーナス取得（第3キーのタイブレーカーとして使用）
    const triggerTickers = triggers.map((t) => t.ticker);
    const contrarianMap = await getContrarianHistoryBatch(triggerTickers);
    const bonusMap = new Map<string, number>();
    for (const [ticker, history] of contrarianMap) {
      const bonus = calculateContinuousContrarianBonus(history.wins, history.totalNoTradeDays);
      if (bonus !== 0) bonusMap.set(ticker, bonus);
    }

    // 優先順位ソート: RR降順 → SL%昇順 → 出来高サージ降順（逆行ボーナス付き）
    triggers.sort((a, b) => {
      const pa = priorityMap.get(a.ticker)!;
      const pb = priorityMap.get(b.ticker)!;

      // 第1キー: RR降順（差0.1未満は同等とみなす）
      if (Math.abs(pb.rr - pa.rr) >= 0.1) return pb.rr - pa.rr;

      // 第2キー: SL%昇順 — ストップが浅い方がリスク効率が良い
      if (Math.abs(pa.slPct - pb.slPct) >= 0.001) return pa.slPct - pb.slPct;

      // 第3キー: 出来高サージ降順（近い場合は逆行ボーナスで調整）
      const aBonus = bonusMap.get(a.ticker) ?? 0;
      const bBonus = bonusMap.get(b.ticker) ?? 0;
      if (Math.abs(a.volumeSurgeRatio - b.volumeSurgeRatio) < 0.5) {
        if (aBonus !== bBonus) return bBonus - aBonus;
      }
      return b.volumeSurgeRatio - a.volumeSurgeRatio;
    });

    for (const t of triggers) {
      const p = priorityMap.get(t.ticker)!;
      const bonus = bonusMap.get(t.ticker);
      const bonusStr = bonus ? ` 逆行${bonus > 0 ? "+" : ""}${bonus}` : "";
      console.log(
        `${tag} 優先順位: ${t.ticker} RR=${p.rr.toFixed(1)} SL%=${(p.slPct * 100).toFixed(1)}% サージ=${t.volumeSurgeRatio.toFixed(2)}x${bonusStr}`,
      );
    }

    // 6. 既存pending注文の株数チェック（資金変動対応）
    await resizePendingOrders();

    // 6.7 残高プリチェック: 残高0以下なら全トリガーをスキップ（無駄なDB操作・通知を防止）
    const preCash = await getCashBalance();
    if (preCash <= 0) {
      console.log(
        `${tag} 全トリガースキップ: 残高なし（¥${preCash.toLocaleString()}）`,
      );
      return;
    }

    // 7. 各トリガーに対してエントリー実行（優先順位順に直列）
    // RR降順 → SL%昇順 → 出来高サージ降順（逆行ボーナス付き）でソート済み。
    // 直列実行により各 executeEntry が最新の残高を参照し、レースコンディションを防ぐ。
    for (const trigger of triggers) {
      console.log(
        `[breakout-monitor] トリガー発火: ${trigger.ticker} 価格=¥${trigger.currentPrice} 出来高サージ=${trigger.volumeSurgeRatio.toFixed(2)}x`,
      );
      try {
        const result = await executeEntry(trigger);
        if (!result.success) {
          if (result.retryable && scanner) {
            // 一時的な理由（残高不足等）→ triggeredTodayから外して次スキャンで再試行
            scanner.removeFromTriggeredToday(trigger.ticker);
            console.log(
              `[breakout-monitor] ${trigger.ticker} スキップ（次スキャンで再試行, 理由: ${result.reason}）`,
            );
          } else {
            // 恒久的な理由 → Slack通知
            await notifySlack({
              title: `エントリー失敗: ${trigger.ticker}`,
              message: `理由: ${result.reason ?? "不明"}\n価格: ¥${trigger.currentPrice.toLocaleString()} / 出来高サージ: ${trigger.volumeSurgeRatio.toFixed(2)}x`,
              color: "warning",
            });
          }
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

}

/**
 * triggeredToday に残っている銘柄のうち、本日の buy 注文が全てキャンセル済みの場合に
 * triggeredToday から除去して再エントリーを可能にする。
 *
 * ブローカー発注失敗・出来高萎縮・手動など、理由に関わらずキャンセルされた注文は
 * 再度ブレイクアウト条件が整えば再エントリーできるようにする。
 */
export async function reactivateCancelledTriggers(
  scanner: BreakoutScanner,
): Promise<void> {
  const { triggeredToday, premiseCollapsedToday } = scanner.getState();
  const triggeredTickers = [...triggeredToday];
  if (!triggeredTickers.length) return;

  const orders = await prisma.tradingOrder.findMany({
    where: {
      side: "buy",
      createdAt: { gte: getTodayForDB() },
      stock: { tickerCode: { in: triggeredTickers } },
    },
    select: {
      status: true,
      stock: { select: { tickerCode: true } },
    },
  });

  // ticker ごとに注文をグループ化
  const ordersByTicker = new Map<string, string[]>();
  for (const order of orders) {
    const ticker = order.stock.tickerCode;
    const statuses = ordersByTicker.get(ticker) ?? [];
    statuses.push(order.status);
    ordersByTicker.set(ticker, statuses);
  }

  for (const ticker of triggeredTickers) {
    const statuses = ordersByTicker.get(ticker) ?? [];
    // 前提崩壊キャンセルは当日再エントリー禁止（Scannerの永続Setで判定）
    if (premiseCollapsedToday.has(ticker)) continue;
    // 本日注文が存在し、全てキャンセル済みなら再アクティベート
    if (statuses.length > 0 && statuses.every((s) => s === "cancelled")) {
      scanner.removeFromTriggeredToday(ticker);
      console.log(
        `[breakout-monitor] ${ticker} 本日注文が全キャンセル済みのため triggeredToday から除去（再エントリー可能）`,
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
