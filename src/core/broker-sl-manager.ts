/**
 * ブローカーSL注文ライフサイクル管理
 *
 * SL（逆指値）注文の発注・更新・取消をブローカーAPIと連携し、
 * TradingPosition.slBrokerOrderId/Day で追跡する。
 *
 * cancel+resubmit 方式: 立花API の CLMKabuCorrectOrder が逆指値トリガー価格の
 * 訂正に対応しているか不明なため、更新時は取消→再発注で確実に動作させる。
 */

import dayjs from "dayjs";
import { prisma } from "../lib/prisma";
import { TIME_STOP } from "../lib/constants";
import { adjustToTradingDay } from "../lib/market-date";
import {
  submitOrder,
  cancelOrder,
} from "./broker-orders";
import { notifySlack } from "../lib/slack";

// ========================================
// 通知throttle（同一エラー連続時のSlackスパム防止）
// ========================================
const SL_NOTIFY_THROTTLE_MS = 30 * 60 * 1000; // 30分
const lastSLNotifiedAt = new Map<string, number>();
function shouldNotifySLError(key: string): boolean {
  const now = Date.now();
  const last = lastSLNotifiedAt.get(key);
  if (last && now - last < SL_NOTIFY_THROTTLE_MS) return false;
  lastSLNotifiedAt.set(key, now);
  return true;
}

// ========================================
// SL 注文発注
// ========================================

/**
 * SL逆指値注文を新規発注し、ポジションに紐付ける
 */
export async function submitBrokerSL(params: {
  positionId: string;
  ticker: string;
  quantity: number;
  stopTriggerPrice: number;
  strategy: string;
}): Promise<void> {
  try {
    // SL注文の期限: タイムストップ上限+1日（非営業日なら直後の営業日に調整）
    const rawExpire = dayjs()
      .add(TIME_STOP.MAX_EXTENDED_HOLDING_DAYS + 1, "day")
      .toDate();
    const expireDay = dayjs(adjustToTradingDay(rawExpire)).format("YYYYMMDD");

    const result = await submitOrder({
      ticker: params.ticker,
      side: "sell",
      quantity: params.quantity,
      limitPrice: null,
      stopTriggerPrice: params.stopTriggerPrice,
      stopOrderPrice: undefined, // 成行
      expireDay,
    });

    if (result.success && result.orderNumber) {
      await prisma.tradingPosition.update({
        where: { id: params.positionId },
        data: {
          slBrokerOrderId: result.orderNumber,
          slBrokerBusinessDay: result.businessDay ?? null,
        },
      });
      console.log(
        `[broker-sl] SL order submitted: ${result.orderNumber} @ trigger ¥${params.stopTriggerPrice} (${params.ticker})`,
      );

      // 通知用にポジション詳細を取得
      const pos = await prisma.tradingPosition.findUnique({
        where: { id: params.positionId },
        select: {
          entryPrice: true,
          stock: { select: { name: true } },
        },
      }).catch(() => null);

      const entryPrice = pos ? Number(pos.entryPrice) : null;
      const lossPct = entryPrice
        ? ((params.stopTriggerPrice - entryPrice) / entryPrice * 100).toFixed(2)
        : null;
      const lossAmt = entryPrice
        ? Math.round((params.stopTriggerPrice - entryPrice) * params.quantity)
        : null;
      const stockName = pos?.stock?.name ?? "";
      const nameLabel = stockName ? ` ${stockName}` : "";

      const fields: Array<{ title: string; value: string; short: boolean }> = [
        { title: "エントリー", value: entryPrice ? `¥${entryPrice.toLocaleString()}` : "N/A", short: true },
        { title: "SLトリガー", value: `¥${params.stopTriggerPrice.toLocaleString()}`, short: true },
        { title: "損失率", value: lossPct ? `${lossPct}%` : "N/A", short: true },
        { title: "想定損失額", value: lossAmt != null ? `¥${lossAmt.toLocaleString()}` : "N/A", short: true },
        { title: "数量", value: `${params.quantity}株`, short: true },
        { title: "戦略", value: params.strategy, short: true },
        { title: "注文番号", value: result.orderNumber, short: true },
        { title: "有効期限", value: `${expireDay.slice(0, 4)}/${expireDay.slice(4, 6)}/${expireDay.slice(6)}`, short: true },
      ];

      await notifySlack({
        title: `✅ SL注文発注: ${params.ticker}${nameLabel}`,
        message: `逆指値 ¥${params.stopTriggerPrice.toLocaleString()} で売り注文を発注しました`,
        color: "good",
        fields,
      }).catch(() => {});
    } else if (!result.success) {
      console.error(
        `[broker-sl] Failed to submit SL order for ${params.ticker}: ${result.error}`,
      );
      if (shouldNotifySLError(`submit:${params.ticker}:${result.error}`)) {
        await notifySlack({
          title: "SL注文発注失敗",
          message: `${params.ticker}: ${result.error}`,
          color: "danger",
        }).catch(() => {});
      }
    }
  } catch (err) {
    console.error(
      `[broker-sl] Error submitting SL for ${params.ticker}:`,
      err,
    );
    const msg = err instanceof Error ? err.message : String(err);
    if (shouldNotifySLError(`error:${params.ticker}:${msg}`)) {
      await notifySlack({
        title: "SL注文発注エラー",
        message: `${params.ticker}: ${msg}`,
        color: "danger",
      }).catch(() => {});
    }
  }
}

// ========================================
// SL 注文取消
// ========================================

/**
 * SL注文を取消す（再発注なし）
 */
export async function cancelBrokerSL(positionId: string): Promise<void> {
  try {
    const position = await prisma.tradingPosition.findUnique({
      where: { id: positionId },
      select: { slBrokerOrderId: true, slBrokerBusinessDay: true, stock: { select: { tickerCode: true } } },
    });

    if (!position?.slBrokerOrderId || !position?.slBrokerBusinessDay) {
      return; // SL注文が紐付いていない
    }

    const result = await cancelOrder(
      position.slBrokerOrderId,
      position.slBrokerBusinessDay,
      `${position.stock.tickerCode}: SL注文取消`,
    );

    // 立花側で注文が既に消えているケース（約定済み・取消済み）も成功扱い
    const alreadyGone = result.error
      ? /約定|取消|執行済み|消化|既に/.test(result.error)
      : false;

    if (result.success || alreadyGone) {
      // 立花側で注文が存在しないことが確認できた場合のみ DB クリア
      await prisma.tradingPosition.update({
        where: { id: positionId },
        data: {
          slBrokerOrderId: null,
          slBrokerBusinessDay: null,
        },
      });
      console.log(
        `[broker-sl] SL order cancelled (DBクリア): ${position.slBrokerOrderId}${alreadyGone ? " [already gone]" : ""}`,
      );
    } else {
      // 取消失敗 = 立花側に注文が残っている可能性 → DB は維持して次サイクルで再試行
      console.warn(
        `[broker-sl] SL cancel failed (DB維持): ${result.error}`,
      );
    }
  } catch (err) {
    console.error(`[broker-sl] Error cancelling SL for ${positionId}:`, err);
    await notifySlack({
      title: "SL注文取消エラー",
      message: `positionId: ${positionId}: ${err instanceof Error ? err.message : String(err)}`,
      color: "danger",
    }).catch(() => {});
  }
}

// ========================================
// SL 注文更新（cancel + resubmit）
// ========================================

/**
 * 既存のSL注文を取消し、新しい価格で再発注する
 *
 * cancel が失敗（立花側に旧注文が残存）している場合、DB は維持されているので
 * submit をスキップして重複発注を防ぐ。次サイクルで Phase 1.5 が整合を取る。
 */
export async function updateBrokerSL(params: {
  positionId: string;
  ticker: string;
  quantity: number;
  newStopTriggerPrice: number;
  strategy: string;
}): Promise<void> {
  await cancelBrokerSL(params.positionId);

  // cancelBrokerSL の結果をDBから確認: slBrokerOrderId が残っている = cancel失敗
  const post = await prisma.tradingPosition.findUnique({
    where: { id: params.positionId },
    select: { slBrokerOrderId: true },
  });
  if (post?.slBrokerOrderId) {
    console.warn(
      `[broker-sl] cancel失敗のため再発注スキップ (${params.ticker}): 立花側に旧SL注文が残存、次サイクルで再試行`,
    );
    return;
  }

  await submitBrokerSL({
    positionId: params.positionId,
    ticker: params.ticker,
    quantity: params.quantity,
    stopTriggerPrice: params.newStopTriggerPrice,
    strategy: params.strategy,
  });
}
