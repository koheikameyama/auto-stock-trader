/**
 * ポジション管理モジュール
 *
 * ポジションのオープン・クローズ・評価を行う
 */

import { prisma } from "../lib/prisma";
import type { TradingConfig, TradingPosition } from "@prisma/client";
import { getBuyingPower } from "./broker-orders";
import { isTachibanaProduction } from "../lib/constants/broker";

/**
 * ポジション単体の確定損益を算出する（粗損益）
 *
 * 手数料・税金はブローカー側で徴収されるため、プログラム側では計算しない。
 * exitPrice が null（void等）の場合は 0 を返す。
 */
export function getPositionPnl(pos: {
  entryPrice: { toNumber?: () => number } | number;
  exitPrice: { toNumber?: () => number } | number | null;
  quantity: number;
}): number {
  if (!pos.exitPrice) return 0;
  const entry = typeof pos.entryPrice === "number" ? pos.entryPrice : Number(pos.entryPrice);
  const exit = typeof pos.exitPrice === "number" ? pos.exitPrice : Number(pos.exitPrice);
  return Math.round((exit - entry) * pos.quantity);
}

/**
 * 全クローズ済みポジションの確定損益を合計する
 */
export async function computeRealizedPnl(): Promise<number> {
  const positions = await prisma.tradingPosition.findMany({
    where: { status: "closed", exitPrice: { not: null } },
    select: { entryPrice: true, exitPrice: true, quantity: true },
  });
  return positions.reduce((sum, pos) => sum + getPositionPnl(pos), 0);
}

/**
 * 実質資金を取得する
 *
 * TACHIBANA_ENV=production: ブローカーAPIの買余力 + 投資中金額
 * それ以外: DBのtotalBudget + 累計確定損益
 */
export async function getEffectiveCapital(config?: TradingConfig | null): Promise<number> {
  if (isTachibanaProduction) {
    const apiBuyingPower = await getBuyingPower();
    if (apiBuyingPower == null) {
      throw new Error("証券APIから買余力を取得できませんでした");
    }
    const investedAmount = await getInvestedAmount();
    return apiBuyingPower + investedAmount;
  }

  const cfg = config ?? await prisma.tradingConfig.findFirst({ orderBy: { createdAt: "desc" } });
  if (!cfg) throw new Error("TradingConfig が設定されていません");
  const realizedPnl = await computeRealizedPnl();
  return Number(cfg.totalBudget) + realizedPnl;
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
      updatedAt: new Date(),
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

  const pnl = getPositionPnl({ entryPrice: position.entryPrice, exitPrice, quantity: position.quantity });

  return prisma.$transaction(async (tx) => {
    const closedPosition = await tx.tradingPosition.update({
      where: { id: positionId },
      data: {
        status: "closed",
        exitPrice,
        exitedAt: new Date(),
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
        reasoning: `ポジション決済（損益: ${pnl >= 0 ? "+" : ""}${pnl.toFixed(0)}円）`,
        positionId,
        updatedAt: new Date(),
      },
    });

    return closedPosition;
  });
}

/**
 * ポジションを無効化する（実取引が確認できない場合）
 *
 * ブローカーに保有が見つからず、約定も確認できないケースで使用する。
 * 損益は計上しない（exitPrice = null のまま）。
 */
export async function voidPosition(
  positionId: string,
  reason: string,
): Promise<TradingPosition> {
  return prisma.tradingPosition.update({
    where: { id: positionId },
    data: {
      status: "closed",
      exitedAt: new Date(),
      exitSnapshot: { exitReason: reason },
    },
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
 * TACHIBANA_ENV=production: ブローカーAPIの買余力（現物買付可能額）を直接返す。
 * それ以外: 実質資金からオープンポジションの取得コスト合計を差し引く。
 */
export async function getCashBalance(): Promise<number> {
  if (isTachibanaProduction) {
    const apiBuyingPower = await getBuyingPower();
    if (apiBuyingPower == null) {
      throw new Error("証券APIから買余力を取得できませんでした");
    }
    return apiBuyingPower;
  }

  const [effectiveCapital, openPositions, pendingBuyOrders] = await Promise.all([
    getEffectiveCapital(),
    prisma.tradingPosition.findMany({ where: { status: "open" } }),
    prisma.tradingOrder.findMany({
      where: { side: "buy", status: "pending" },
      select: { limitPrice: true, quantity: true },
    }),
  ]);

  const investedAmount = openPositions.reduce((sum, pos) => {
    return sum + Number(pos.entryPrice) * pos.quantity;
  }, 0);

  const pendingAmount = pendingBuyOrders.reduce((sum, order) => {
    return sum + Number(order.limitPrice) * order.quantity;
  }, 0);

  return effectiveCapital - investedAmount - pendingAmount;
}

// ========================================
// 内部ヘルパー
// ========================================

/** オープンポジションの投資中金額を計算 */
async function getInvestedAmount(): Promise<number> {
  const openPositions = await prisma.tradingPosition.findMany({ where: { status: "open" } });
  return openPositions.reduce((sum, pos) => sum + Number(pos.entryPrice) * pos.quantity, 0);
}

