/**
 * ブローカー約定イベントハンドラ
 *
 * WebSocket EVENT I/F の EC（約定通知）を受信した際に呼ばれる。
 * CLMOrderListDetail で約定詳細を取得し、DB の注文・ポジションを更新する。
 */

import { prisma } from "../lib/prisma";
import { TACHIBANA_ORDER_STATUS } from "../lib/constants/broker";
import { getOrderDetail, submitOrder } from "./broker-orders";
import { fillOrder } from "./order-executor";
import { openPosition, closePosition } from "./position-manager";
import { validateStopLoss } from "./risk-manager";
import { notifyOrderFilled, notifySlack } from "../lib/slack";
import type { ExecutionEvent } from "./broker-event-stream";

// ========================================
// メイン処理
// ========================================

/**
 * ブローカー約定イベントを処理する
 *
 * position-monitor のポーリングとは独立して動作する。
 * DB の brokerStatus を先に更新することで、position-monitor 側での二重処理を防止する。
 */
export async function handleBrokerFill(
  event: ExecutionEvent,
): Promise<void> {
  const { orderNumber, businessDay } = event;

  try {
    // 1. DB で該当注文を検索
    const order = await prisma.tradingOrder.findFirst({
      where: {
        brokerOrderId: orderNumber,
        brokerBusinessDay: businessDay,
      },
      include: { stock: true },
    });

    if (!order) {
      console.log(
        `[broker-fill] Unknown order: ${orderNumber} (day=${businessDay})`,
      );
      return;
    }

    // 既に処理済みの場合はスキップ
    if (order.status === "filled" || order.status === "cancelled") {
      console.log(
        `[broker-fill] Order ${orderNumber} already ${order.status}, skipping`,
      );
      return;
    }

    // 2. CLMOrderListDetail で約定詳細を取得
    const detail = await getOrderDetail(orderNumber, businessDay);
    if (!detail) {
      console.warn(
        `[broker-fill] Failed to get order detail for ${orderNumber}`,
      );
      return;
    }

    // 注文ステータスを確認
    const brokerStatus = String(detail.sOrderStatus ?? "");

    // DB の brokerStatus を即座に更新（position-monitor の二重処理防止）
    await prisma.tradingOrder.update({
      where: { id: order.id },
      data: { brokerStatus },
    });

    // 全部約定でない場合はログのみ
    if (brokerStatus !== TACHIBANA_ORDER_STATUS.FULLY_FILLED) {
      console.log(
        `[broker-fill] Order ${orderNumber} status=${brokerStatus} (not fully filled)`,
      );
      return;
    }

    // 3. 約定価格を取得
    const execList =
      (detail.aYakuzyouSikkouList as Record<string, unknown>[]) ?? [];
    if (execList.length === 0) {
      console.warn(
        `[broker-fill] No execution records for ${orderNumber}`,
      );
      return;
    }

    // 加重平均約定価格を計算（複数回に分けて約定した場合）
    let totalAmount = 0;
    let totalQuantity = 0;
    for (const exec of execList) {
      const price = Number(exec.sYakuzyouPrice ?? exec.sExecPrice ?? 0);
      const qty = Number(
        exec.sYakuzyouSuryou ?? exec.sExecQuantity ?? 0,
      );
      totalAmount += price * qty;
      totalQuantity += qty;
    }

    const filledPrice =
      totalQuantity > 0 ? Math.round(totalAmount / totalQuantity) : 0;

    if (filledPrice <= 0) {
      console.warn(
        `[broker-fill] Invalid filled price for ${orderNumber}`,
      );
      return;
    }

    console.log(
      `[broker-fill] Order ${orderNumber} filled: ${order.stock.tickerCode} ${order.side} @ ¥${filledPrice.toLocaleString()} x ${totalQuantity}`,
    );

    // 4. 注文を約定済みに更新
    await fillOrder(order.id, filledPrice);

    // 5. 買い/売りに応じた後処理
    if (order.side === "buy") {
      await handleBuyFill(order, filledPrice);
    } else {
      await handleSellFill(order, filledPrice);
    }
  } catch (err) {
    console.error(
      `[broker-fill] Error processing fill for ${orderNumber}:`,
      err,
    );
    await notifySlack({
      title: "WebSocket 約定処理エラー",
      message: `注文番号: ${orderNumber}\n${err instanceof Error ? err.message : String(err)}`,
      color: "danger",
    }).catch(() => {});
  }
}

// ========================================
// 買い約定処理
// ========================================

async function handleBuyFill(
  order: {
    id: string;
    stockId: string;
    strategy: string;
    quantity: number;
    takeProfitPrice: unknown;
    stopLossPrice: unknown;
    entrySnapshot: unknown;
    stock: { tickerCode: string; name: string };
  },
  filledPrice: number,
): Promise<void> {
  // 同一銘柄のopenポジションが既にあれば注文キャンセル（多重防御）
  const existingPosition = await prisma.tradingPosition.findFirst({
    where: { stockId: order.stockId, status: "open" },
  });
  if (existingPosition) {
    console.log(
      `[broker-fill] ${order.stock.tickerCode}: duplicate open position, cancelling`,
    );
    await prisma.tradingOrder.update({
      where: { id: order.id },
      data: { status: "cancelled" },
    });
    return;
  }

  // entrySnapshot から ATR を取得
  const entryAtr = extractAtrFromSnapshot(order.entrySnapshot);

  // 約定価格ベースで TP/SL を再計算
  const orderTP = order.takeProfitPrice
    ? Number(order.takeProfitPrice)
    : null;
  const orderSL = order.stopLossPrice
    ? Number(order.stopLossPrice)
    : null;
  const { takeProfitPrice, stopLossPrice } = recalculateExitPrices(
    filledPrice,
    orderTP,
    orderSL,
    entryAtr,
  );

  // ポジションオープン
  const position = await openPosition(
    order.stockId,
    order.strategy,
    filledPrice,
    order.quantity,
    takeProfitPrice,
    stopLossPrice,
    order.entrySnapshot as object | undefined,
    entryAtr,
  );

  // ポジションIDを注文に紐付け
  await prisma.tradingOrder.update({
    where: { id: order.id },
    data: { positionId: position.id },
  });

  // TP/SL 注文をブローカーに発注
  try {
    // SL 逆指値注文（成行）
    const slResult = await submitOrder({
      ticker: order.stock.tickerCode,
      side: "sell",
      quantity: order.quantity,
      limitPrice: null,
      stopTriggerPrice: stopLossPrice,
      stopOrderPrice: undefined, // 成行
    });

    if (slResult.success && slResult.orderNumber) {
      console.log(
        `[broker-fill] SL order submitted: ${slResult.orderNumber} @ trigger ¥${stopLossPrice}`,
      );
    }
  } catch (err) {
    console.error(
      `[broker-fill] Failed to submit SL order for ${order.stock.tickerCode}:`,
      err,
    );
  }

  // Slack 通知
  await notifyOrderFilled({
    tickerCode: order.stock.tickerCode,
    name: order.stock.name,
    side: "buy",
    filledPrice,
    quantity: order.quantity,
  });
}

// ========================================
// 売り約定処理
// ========================================

async function handleSellFill(
  order: {
    id: string;
    positionId: string | null;
    stock: { tickerCode: string; name: string };
    quantity: number;
  },
  filledPrice: number,
): Promise<void> {
  let pnl = 0;

  if (order.positionId) {
    // ポジションをクローズ
    const exitSnapshot = {
      exitReason: "ブローカー約定（WebSocket）",
      exitPrice: filledPrice,
      marketContext: null,
    };

    const closed = await closePosition(
      order.positionId,
      filledPrice,
      exitSnapshot as object,
    );
    pnl = closed.realizedPnl ? Number(closed.realizedPnl) : 0;
  }

  // Slack 通知
  await notifyOrderFilled({
    tickerCode: order.stock.tickerCode,
    name: order.stock.name,
    side: "sell",
    filledPrice,
    quantity: order.quantity,
    pnl,
  });
}

// ========================================
// ユーティリティ
// ========================================

function extractAtrFromSnapshot(snapshot: unknown): number | null {
  if (!snapshot || typeof snapshot !== "object") return null;
  const s = snapshot as Record<string, unknown>;
  const technicals = s.technicals as Record<string, unknown> | undefined;
  return technicals?.atr14 != null ? Number(technicals.atr14) : null;
}

/**
 * 約定価格ベースで TP/SL を再検証する
 */
function recalculateExitPrices(
  filledPrice: number,
  orderTP: number | null,
  orderSL: number | null,
  entryAtr: number | null,
): { takeProfitPrice: number; stopLossPrice: number } {
  const DEFAULT_TP_RATIO = 1.05;
  const DEFAULT_SL_RATIO = 0.97;

  let takeProfitPrice =
    orderTP ?? Math.round(filledPrice * DEFAULT_TP_RATIO);
  let stopLossPrice =
    orderSL ?? Math.round(filledPrice * DEFAULT_SL_RATIO);

  // SL を約定価格ベースで再検証
  const slValidation = validateStopLoss(
    filledPrice,
    stopLossPrice,
    entryAtr,
    [],
  );
  if (slValidation.wasOverridden) {
    stopLossPrice = Math.round(slValidation.validatedPrice);

    // ATR ベースで TP も再計算
    if (entryAtr) {
      const atrBasedTP = filledPrice + entryAtr * 1.5;
      takeProfitPrice = Math.round(
        Math.max(takeProfitPrice, atrBasedTP),
      );
    }

    // RR >= 1.5 を確保
    const risk = filledPrice - stopLossPrice;
    const reward = takeProfitPrice - filledPrice;
    if (risk > 0 && reward / risk < 1.5) {
      takeProfitPrice = Math.round(filledPrice + risk * 1.5);
    }
  }

  return { takeProfitPrice, stopLossPrice };
}
