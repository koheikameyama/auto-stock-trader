/**
 * 注文シミュレーションモジュール
 *
 * 指値・逆指値注文の約定判定と注文ステータス更新を行う
 */

import { prisma } from "../lib/prisma";
import type { TradingOrder } from "@prisma/client";

/**
 * 買い指値注文の約定判定（純粋関数）
 *
 * 安値が指値以下なら約定。ギャップダウン時は寄り付き値で約定（買い手に有利）。
 * バックテストと本番で同一ロジックを共有する。
 *
 * @returns 約定価格（約定しない場合は null）
 */
export function checkBuyLimitFill(
  limitPrice: number,
  barLow: number,
  barOpen: number,
): number | null {
  if (barLow <= limitPrice) {
    return barOpen < limitPrice ? barOpen : limitPrice;
  }
  return null;
}

/**
 * 注文約定チェック
 *
 * - 買い指値: 安値が指値以下なら約定（指値で約定）
 * - 売り指値（利確）: 高値が指値以上なら約定（指値で約定）
 * - 逆指値（損切り）: 安値が逆指値以下なら約定（逆指値で約定）
 *
 * @returns 約定価格（約定しない場合は null）
 */
export function checkOrderFill(
  order: TradingOrder,
  currentHigh: number,
  currentLow: number,
  currentOpen?: number,
): number | null {
  const limitPrice = order.limitPrice ? Number(order.limitPrice) : null;
  const stopPrice = order.stopPrice ? Number(order.stopPrice) : null;

  // 買い指値注文
  if (order.side === "buy" && limitPrice !== null) {
    return checkBuyLimitFill(limitPrice, currentLow, currentOpen ?? currentLow);
  }

  // 売り指値注文（利確）: 高値が指値以上なら約定
  if (
    order.side === "sell" &&
    limitPrice !== null &&
    order.orderType !== "stop_limit"
  ) {
    if (currentHigh >= limitPrice) {
      // ギャップアップで寄り付いた場合、寄り付き値で約定（売り手に有利）
      if (currentOpen != null && currentOpen > limitPrice) {
        return currentOpen;
      }
      return limitPrice;
    }
  }

  // 逆指値注文（損切り）: 安値が逆指値以下なら約定
  if (order.side === "sell" && stopPrice !== null) {
    if (currentLow <= stopPrice) {
      // ギャップダウンで逆指値を突き抜けた場合、寄り付き値で約定（スリッページ）
      if (currentOpen != null && currentOpen < stopPrice) {
        return currentOpen;
      }
      return stopPrice;
    }
  }

  return null;
}

/**
 * 注文を約定済みに更新する
 */
export async function fillOrder(
  orderId: string,
  filledPrice: number,
): Promise<TradingOrder> {
  return prisma.tradingOrder.update({
    where: { id: orderId },
    data: {
      status: "filled",
      filledPrice,
      filledAt: new Date(),
    },
  });
}

/**
 * 期限切れ注文をキャンセルする
 */
export async function expireOrders(): Promise<number> {
  const now = new Date();
  const result = await prisma.tradingOrder.updateMany({
    where: {
      status: "pending",
      expiresAt: { lte: now },
    },
    data: { status: "expired" },
  });
  return result.count;
}

/**
 * 未約定の注文を取得する
 */
export async function getPendingOrders() {
  return prisma.tradingOrder.findMany({
    where: { status: "pending" },
    include: { stock: true },
    orderBy: { createdAt: "asc" },
  });
}
