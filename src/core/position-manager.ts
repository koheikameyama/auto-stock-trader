/**
 * ポジション管理モジュール
 *
 * ポジションのオープン・クローズ・評価を行う
 */

import { prisma } from "../lib/prisma";
import type { TradingConfig, TradingPosition } from "@prisma/client";
import { calculateTradeCosts } from "./trading-costs";

/**
 * 実質資金 = 入金額 + 累計確定損益
 */
export function getEffectiveCapital(config: TradingConfig): number {
  return Number(config.totalBudget) + Number(config.realizedPnl);
}

/**
 * 新規ポジションを建てる
 *
 * ポジションレコードを作成する。
 * 注文レコードはposition-monitorで元の注文にpositionIdを紐づけるため、ここでは作成しない。
 */
export async function openPosition(
  stockId: string,
  strategy: string,
  entryPrice: number,
  quantity: number,
  takeProfitPrice: number,
  stopLossPrice: number,
  entrySnapshot?: object,
  entryAtr?: number | null,
): Promise<TradingPosition> {
  return prisma.tradingPosition.create({
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
      trailingStopPrice: null,
      entryAtr: entryAtr ?? null,
    },
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
  const costs = calculateTradeCosts(entryPrice, exitPrice, position.quantity);
  const realizedPnl = costs.netPnl;

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

    // 確定損益をrealizedPnlに加算（複利運用）
    const config = await tx.tradingConfig.findFirst({
      orderBy: { createdAt: "desc" },
    });
    if (config) {
      await tx.tradingConfig.update({
        where: { id: config.id },
        data: {
          realizedPnl: Number(config.realizedPnl) + realizedPnl,
        },
      });
    }

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
 * 実質資金（入金額 + 確定損益）からオープンポジションの取得コスト合計を差し引く。
 */
export async function getCashBalance(): Promise<number> {
  const config = await prisma.tradingConfig.findFirst({
    orderBy: { createdAt: "desc" },
  });

  if (!config) {
    throw new Error("TradingConfig が設定されていません");
  }

  const effectiveCapital = getEffectiveCapital(config);

  const openPositions = await prisma.tradingPosition.findMany({
    where: { status: "open" },
  });

  const investedAmount = openPositions.reduce((sum, pos) => {
    return sum + Number(pos.entryPrice) * pos.quantity;
  }, 0);

  return effectiveCapital - investedAmount;
}
