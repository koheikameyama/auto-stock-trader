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
import { isTachibanaProduction } from "../lib/constants/broker";

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
    } else if (!result.success) {
      console.error(
        `[broker-sl] Failed to submit SL order for ${params.ticker}: ${result.error}`,
      );
      await notifySlack({
        title: "SL注文発注失敗",
        message: `${params.ticker}: ${result.error}`,
        color: "danger",
      }).catch(() => {});
    }
  } catch (err) {
    console.error(
      `[broker-sl] Error submitting SL for ${params.ticker}:`,
      err,
    );
    await notifySlack({
      title: "SL注文発注エラー",
      message: `${params.ticker}: ${err instanceof Error ? err.message : String(err)}`,
      color: "danger",
    }).catch(() => {});
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

    // 取消結果にかかわらずフィールドをクリア（約定済みの場合も含む）
    await prisma.tradingPosition.update({
      where: { id: positionId },
      data: {
        slBrokerOrderId: null,
        slBrokerBusinessDay: null,
      },
    });

    if (result.success) {
      console.log(
        `[broker-sl] SL order cancelled: ${position.slBrokerOrderId}`,
      );
    } else {
      // 既に約定済み・取消済みの場合はエラーだが、フィールドはクリア済みなので問題なし
      console.warn(
        `[broker-sl] SL cancel returned error (may be already filled/cancelled): ${result.error}`,
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
 */
export async function updateBrokerSL(params: {
  positionId: string;
  ticker: string;
  quantity: number;
  newStopTriggerPrice: number;
  strategy: string;
}): Promise<void> {
  if (!isTachibanaProduction) {
    console.log(`[broker-sl] デモ環境のためupdateBrokerSLをスキップ: ${params.ticker}`);
    return;
  }
  await cancelBrokerSL(params.positionId);
  await submitBrokerSL({
    positionId: params.positionId,
    ticker: params.ticker,
    quantity: params.quantity,
    stopTriggerPrice: params.newStopTriggerPrice,
    strategy: params.strategy,
  });
}
