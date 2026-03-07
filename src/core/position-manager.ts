/**
 * ポジション管理モジュール
 *
 * ポジションのオープン・クローズ・評価を行う
 */

import { prisma } from "../lib/prisma";
import type { TradingPosition } from "@prisma/client";

/**
 * 新規ポジションを建てる
 *
 * ポジションレコードと買い注文（約定済み）をトランザクションで同時に作成する。
 */
export async function openPosition(
  stockId: string,
  strategy: string,
  entryPrice: number,
  quantity: number,
  takeProfitPrice: number,
  stopLossPrice: number,
  entrySnapshot?: object,
): Promise<TradingPosition> {
  return prisma.$transaction(async (tx) => {
    const position = await tx.tradingPosition.create({
      data: {
        stockId,
        strategy,
        entryPrice,
        quantity,
        takeProfitPrice,
        stopLossPrice,
        status: "open",
        entrySnapshot: entrySnapshot ?? undefined,
        maxHighDuringHold: entryPrice,
        minLowDuringHold: entryPrice,
      },
    });

    // 買い注文を約定済みで作成（エントリー記録）
    await tx.tradingOrder.create({
      data: {
        stockId,
        side: "buy",
        orderType: "limit",
        strategy,
        limitPrice: entryPrice,
        quantity,
        status: "filled",
        filledPrice: entryPrice,
        filledAt: new Date(),
        reasoning: `新規ポジション建て（${strategy}）`,
        positionId: position.id,
      },
    });

    return position;
  });
}

/**
 * ポジションを決済する
 *
 * ポジションをクローズし、確定損益を計算して売り注文を作成する。
 */
export async function closePosition(
  positionId: string,
  exitPrice: number,
  exitSnapshot?: object,
): Promise<TradingPosition> {
  const position = await prisma.tradingPosition.findUniqueOrThrow({
    where: { id: positionId },
  });

  const entryPrice = Number(position.entryPrice);
  const realizedPnl = (exitPrice - entryPrice) * position.quantity;

  return prisma.$transaction(async (tx) => {
    const closedPosition = await tx.tradingPosition.update({
      where: { id: positionId },
      data: {
        status: "closed",
        exitPrice,
        exitedAt: new Date(),
        realizedPnl,
        exitSnapshot: exitSnapshot ?? undefined,
      },
    });

    // 売り注文を約定済みで作成（決済記録）
    await tx.tradingOrder.create({
      data: {
        stockId: position.stockId,
        side: "sell",
        orderType: "limit",
        strategy: position.strategy,
        limitPrice: exitPrice,
        quantity: position.quantity,
        status: "filled",
        filledPrice: exitPrice,
        filledAt: new Date(),
        reasoning: `ポジション決済（損益: ${realizedPnl >= 0 ? "+" : ""}${realizedPnl.toFixed(0)}円）`,
        positionId,
      },
    });

    return closedPosition;
  });
}

/**
 * オープン中の全ポジションを取得する
 */
export async function getOpenPositions() {
  return prisma.tradingPosition.findMany({
    where: { status: "open" },
    include: { stock: true },
    orderBy: { createdAt: "desc" },
  });
}

/**
 * ポジションの含み損益を計算する
 */
export function getUnrealizedPnl(
  position: TradingPosition,
  currentPrice: number,
): number {
  const entryPrice = Number(position.entryPrice);
  return (currentPrice - entryPrice) * position.quantity;
}

/**
 * 全ポジションの時価評価額を合計する
 */
export async function getTotalPortfolioValue(
  currentPrices: Map<string, number>,
): Promise<number> {
  const positions = await getOpenPositions();

  let totalValue = 0;
  for (const position of positions) {
    const currentPrice = currentPrices.get(position.stockId);
    if (currentPrice !== undefined) {
      totalValue += currentPrice * position.quantity;
    } else {
      // 現在価格が不明な場合はエントリー価格で評価
      totalValue += Number(position.entryPrice) * position.quantity;
    }
  }

  return totalValue;
}

/**
 * 現金残高を取得する
 *
 * TradingConfig.totalBudget からオープンポジションの取得コスト合計を差し引く。
 */
export async function getCashBalance(): Promise<number> {
  const config = await prisma.tradingConfig.findFirst({
    orderBy: { createdAt: "desc" },
  });

  if (!config) {
    throw new Error("TradingConfig が設定されていません");
  }

  const totalBudget = Number(config.totalBudget);

  const openPositions = await prisma.tradingPosition.findMany({
    where: { status: "open" },
  });

  const investedAmount = openPositions.reduce((sum, pos) => {
    return sum + Number(pos.entryPrice) * pos.quantity;
  }, 0);

  return totalBudget - investedAmount;
}
