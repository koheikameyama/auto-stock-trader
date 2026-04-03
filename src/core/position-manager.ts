/**
 * ポジション管理モジュール
 *
 * ポジションのオープン・クローズ・評価を行う
 */

import { prisma } from "../lib/prisma";
import type { TradingConfig, TradingPosition } from "@prisma/client";
import { calculateTradeCosts } from "./trading-costs";
import { getBuyingPower } from "./broker-orders";
import { isTachibanaProduction } from "../lib/constants/broker";

/**
 * 全クローズ済みポジションの確定損益を合計する
 */
export async function computeRealizedPnl(): Promise<number> {
  const result = await prisma.tradingPosition.aggregate({
    where: { status: "closed" },
    _sum: { realizedPnl: true },
  });
  return Number(result._sum.realizedPnl ?? 0);
}

/**
 * 実質資金 = 入金額 + 累計確定損益（ポジション履歴から計算）
 *
 * TACHIBANA_ENV=production の場合はブローカーAPIから買余力を取得し、
 * 投資中金額を加算して実質資金を算出する。取得値はDBにも同期する。
 * API失敗時はDBフォールバック。
 */
export async function getEffectiveCapital(config?: TradingConfig | null): Promise<number> {
  if (isTachibanaProduction) {
    const apiBuyingPower = await getBuyingPower();
    if (apiBuyingPower != null) {
      const investedAmount = await getInvestedAmount();
      const effectiveCapital = apiBuyingPower + investedAmount;
      await syncTotalBudget(effectiveCapital);
      return effectiveCapital;
    }
    // API失敗時はDBフォールバック
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
        updatedAt: new Date(),
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
 * TACHIBANA_ENV=production: ブローカーAPIの買余力（現物買付可能額）を直接返す。
 * それ以外: 実質資金からオープンポジションの取得コスト合計を差し引く。
 */
export async function getCashBalance(): Promise<number> {
  if (isTachibanaProduction) {
    const apiBuyingPower = await getBuyingPower();
    if (apiBuyingPower != null) return apiBuyingPower;
    // API失敗時はDBフォールバック
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

/** ブローカーから取得した実質資金をDBに同期 */
async function syncTotalBudget(effectiveCapital: number): Promise<void> {
  try {
    const realizedPnl = await computeRealizedPnl();
    const totalBudget = effectiveCapital - realizedPnl;
    const config = await prisma.tradingConfig.findFirst({ orderBy: { createdAt: "desc" } });
    if (config) {
      await prisma.tradingConfig.update({
        where: { id: config.id },
        data: { totalBudget },
      });
    }
  } catch (err) {
    console.warn("[position-manager] totalBudget同期失敗:", err);
  }
}
