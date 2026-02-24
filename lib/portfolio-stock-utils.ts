/**
 * lib/portfolio-stock-utils.ts
 *
 * PortfolioStock 関連の共通ユーティリティ
 * POST /api/user-stocks と PATCH /api/user-stocks/[id] で共有される処理を集約
 */

import { Decimal } from "@prisma/client/runtime/library";
import { prisma } from "@/lib/prisma";
import { calculatePortfolioFromTransactions } from "@/lib/portfolio-calculator";
import type { UserStockResponse } from "@/app/api/user-stocks/route";

// ──────────────────────────────────────────────
// 型定義
// ──────────────────────────────────────────────

/** Prismaトランザクションクライアントの型 */
type PrismaTransactionClient = Parameters<
  Parameters<typeof prisma.$transaction>[0]
>[0];

/** PortfolioStock 作成結果 */
export interface CreatePortfolioStockResult {
  portfolioStock: {
    id: string;
    userId: string;
    stockId: string;
    lastAnalysis: Date | null;
    shortTerm: string | null;
    mediumTerm: string | null;
    longTerm: string | null;
    takeProfitRate: Decimal | null;
    stopLossRate: Decimal | null;
    statusType: string | null;
    suggestedSellPrice: Decimal | null;
    sellCondition: string | null;
    createdAt: Date;
    updatedAt: Date;
    stock: {
      id: string;
      tickerCode: string;
      name: string;
      sector: string | null;
      market: string;
    };
  };
  transaction: {
    id: string;
    type: string;
    quantity: number;
    price: Decimal;
    totalAmount: Decimal;
    transactionDate: Date;
  };
}

// ──────────────────────────────────────────────
// ① ユーザー設定（TP/SL%）の取得
// ──────────────────────────────────────────────

/**
 * ユーザーのデフォルト TP/SL 設定を取得する
 * UserSettings.targetReturnRate / UserSettings.stopLossRate をそのまま返す
 */
export async function fetchDefaultTpSlRates(userId: string): Promise<{
  takeProfitRate: number | null;
  stopLossRate: number | null;
}> {
  try {
    const userSettings = await prisma.userSettings.findUnique({
      where: { userId },
    });

    if (!userSettings) {
      return { takeProfitRate: null, stopLossRate: null };
    }

    const takeProfitRate =
      userSettings.targetReturnRate && userSettings.targetReturnRate > 0
        ? userSettings.targetReturnRate
        : null;

    const stopLossRate =
      userSettings.stopLossRate && userSettings.stopLossRate < 0
        ? userSettings.stopLossRate
        : null;

    return { takeProfitRate, stopLossRate };
  } catch (err) {
    console.error(
      "Failed to fetch user settings for default TP/SL calculation:",
      err,
    );
    return { takeProfitRate: null, stopLossRate: null };
  }
}

// ──────────────────────────────────────────────
// ② PortfolioStock + Transaction の作成（トランザクション内）
// ──────────────────────────────────────────────

/**
 * Prismaトランザクション内で PortfolioStock と Transaction を同時作成する
 *
 * @param tx - Prisma トランザクションクライアント
 * @param params - 作成に必要なパラメータ
 */
export async function createPortfolioStockWithTransaction(
  tx: PrismaTransactionClient,
  params: {
    userId: string;
    stockId: string;
    quantity: number;
    averagePurchasePrice: number;
    transactionDate: Date;
    takeProfitRate: number | null;
    stopLossRate: number | null;
  },
): Promise<CreatePortfolioStockResult> {
  const {
    userId,
    stockId,
    quantity,
    averagePurchasePrice,
    transactionDate,
    takeProfitRate,
    stopLossRate,
  } = params;

  const portfolioStock = await tx.portfolioStock.create({
    data: {
      userId,
      stockId,
      takeProfitRate: takeProfitRate ? new Decimal(takeProfitRate) : null,
      stopLossRate: stopLossRate ? new Decimal(stopLossRate) : null,
    },
    include: {
      stock: {
        select: {
          id: true,
          tickerCode: true,
          name: true,
          sector: true,
          market: true,
        },
      },
    },
  });

  const transaction = await tx.transaction.create({
    data: {
      userId,
      stockId,
      portfolioStockId: portfolioStock.id,
      type: "buy",
      quantity,
      price: new Decimal(averagePurchasePrice),
      totalAmount: new Decimal(quantity).times(averagePurchasePrice),
      transactionDate,
    },
  });

  return { portfolioStock, transaction };
}

// ──────────────────────────────────────────────
// ③ PortfolioStock レスポンス整形
// ──────────────────────────────────────────────

type TransactionLike = {
  id: string;
  type: string;
  quantity: number;
  price: Decimal | number;
  totalAmount: Decimal | number;
  transactionDate: Date | string;
};

/**
 * PortfolioStock のデータを UserStockResponse 形式に整形する
 */
export function buildPortfolioStockResponse(params: {
  portfolioStock: CreatePortfolioStockResult["portfolioStock"];
  transactions: TransactionLike[];
  currentPrice: number | null;
}): UserStockResponse {
  const { portfolioStock, transactions, currentPrice } = params;

  const { quantity, averagePurchasePrice } =
    calculatePortfolioFromTransactions(transactions);

  const firstBuyTx = transactions.find((t) => t.type === "buy");
  const purchaseDate = firstBuyTx?.transactionDate || portfolioStock.createdAt;

  return {
    id: portfolioStock.id,
    userId: portfolioStock.userId,
    stockId: portfolioStock.stockId,
    type: "portfolio",
    quantity,
    averagePurchasePrice: averagePurchasePrice.toNumber(),
    purchaseDate:
      purchaseDate instanceof Date ? purchaseDate.toISOString() : purchaseDate,
    lastAnalysis: portfolioStock.lastAnalysis
      ? portfolioStock.lastAnalysis.toISOString()
      : null,
    shortTerm: portfolioStock.shortTerm,
    mediumTerm: portfolioStock.mediumTerm,
    longTerm: portfolioStock.longTerm,
    takeProfitRate: portfolioStock.takeProfitRate != null
      ? Number(portfolioStock.takeProfitRate)
      : null,
    stopLossRate: portfolioStock.stopLossRate != null
      ? Number(portfolioStock.stopLossRate)
      : null,
    statusType: portfolioStock.statusType,
    suggestedSellPrice: portfolioStock.suggestedSellPrice
      ? Number(portfolioStock.suggestedSellPrice)
      : null,
    sellCondition: portfolioStock.sellCondition,
    transactions: transactions.map((t) => ({
      id: t.id,
      type: t.type,
      quantity: t.quantity,
      price: t.price instanceof Decimal ? t.price.toNumber() : Number(t.price),
      totalAmount:
        t.totalAmount instanceof Decimal
          ? t.totalAmount.toNumber()
          : Number(t.totalAmount),
      transactionDate:
        t.transactionDate instanceof Date
          ? t.transactionDate.toISOString()
          : t.transactionDate,
    })),
    stock: {
      id: portfolioStock.stock.id,
      tickerCode: portfolioStock.stock.tickerCode,
      name: portfolioStock.stock.name,
      sector: portfolioStock.stock.sector,
      market: portfolioStock.stock.market,
      currentPrice,
    },
    createdAt: portfolioStock.createdAt.toISOString(),
    updatedAt: portfolioStock.updatedAt.toISOString(),
  };
}
