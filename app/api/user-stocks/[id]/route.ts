import { NextRequest, NextResponse } from "next/server";
import { getAuthUser } from "@/lib/auth-utils";
import { prisma } from "@/lib/prisma";
import { calculatePortfolioFromTransactions } from "@/lib/portfolio-calculator";
import { UserStockResponse } from "../route";
import { fetchStockPrices } from "@/lib/stock-price-fetcher";
import {
  fetchDefaultTpSlRates,
  createPortfolioStockWithTransaction,
  buildPortfolioStockResponse,
} from "@/lib/portfolio-stock-utils";

interface UpdateUserStockRequest {
  type?: "watchlist" | "portfolio";
  // Watchlist fields
  targetBuyPrice?: number | null;
  // Portfolio fields
  takeProfitRate?: number | null;
  stopLossRate?: number | null;
}

interface ConvertRequest {
  convertTo: "watchlist" | "portfolio";
  // Portfolio fields (when converting to portfolio)
  quantity?: number;
  averagePurchasePrice?: number;
  purchaseDate?: string;
}

/**
 * PATCH /api/user-stocks/[id]
 * Update or convert stock between watchlist and portfolio
 */
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const { user, error } = await getAuthUser();
  if (error) return error;

  try {
    const userId = user.id;
    const body = await request.json();

    // Check if this is a conversion request
    if ("convertTo" in body) {
      return handleConversion(id, userId, body as ConvertRequest);
    }

    // Regular update
    return handleUpdate(id, userId, body as UpdateUserStockRequest);
  } catch (error) {
    console.error("Error updating user stock:", error);
    return NextResponse.json(
      { error: "Failed to update user stock" },
      { status: 500 },
    );
  }
}

async function handleConversion(
  id: string,
  userId: string,
  body: ConvertRequest,
) {
  const { convertTo, quantity, averagePurchasePrice, purchaseDate } = body;

  // Find in both tables
  const [watchlistStock, portfolioStock] = await Promise.all([
    prisma.watchlistStock.findUnique({
      where: { id },
      include: { stock: true },
    }),
    prisma.portfolioStock.findUnique({
      where: { id },
      include: {
        stock: true,
        transactions: { orderBy: { transactionDate: "asc" } },
      },
    }),
  ]);

  const existingStock = watchlistStock || portfolioStock;
  if (!existingStock) {
    return NextResponse.json({ error: "Stock not found" }, { status: 404 });
  }

  if (existingStock.userId !== userId) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  if (convertTo === "portfolio" && watchlistStock) {
    // Watchlist → Portfolio
    if (!quantity || quantity <= 0) {
      return NextResponse.json(
        { error: "quantity is required and must be greater than 0" },
        { status: 400 },
      );
    }

    if (!averagePurchasePrice || averagePurchasePrice <= 0) {
      return NextResponse.json(
        {
          error: "averagePurchasePrice is required and must be greater than 0",
        },
        { status: 400 },
      );
    }

    const transactionDate = purchaseDate ? new Date(purchaseDate) : new Date();

    // デフォルト設定（%）から目標価格を自動計算
    const {
      takeProfitRate: takeProfitPriceCalc,
      stopLossRate: stopLossPriceCalc,
    } = await fetchDefaultTpSlRates(userId);

    // ウォッチリストを削除し、ポートフォリオ作成（共通関数）をトランザクション内で実行
    const result = await prisma.$transaction(async (tx) => {
      await tx.watchlistStock.delete({ where: { id } });
      return createPortfolioStockWithTransaction(tx, {
        userId,
        stockId: watchlistStock.stockId,
        quantity,
        averagePurchasePrice,
        transactionDate,
        takeProfitRate: takeProfitPriceCalc,
        stopLossRate: stopLossPriceCalc,
      });
    });

    // リアルタイム株価を取得
    const { prices } = await fetchStockPrices([
      result.portfolioStock.stock.tickerCode,
    ]);
    const currentPrice = prices[0]?.currentPrice ?? null;

    // 共通関数でレスポンスを整形
    const response = buildPortfolioStockResponse({
      portfolioStock: result.portfolioStock,
      transactions: [result.transaction],
      currentPrice,
    });

    return NextResponse.json(response);
  } else if (convertTo === "watchlist" && portfolioStock) {
    // Portfolio → Watchlist
    // Delete portfolio and its transactions
    await prisma.$transaction(async (tx) => {
      // Delete transactions
      await tx.transaction.deleteMany({
        where: { portfolioStockId: id },
      });
      await tx.portfolioStock.delete({ where: { id } });
    });

    const newWatchlistStock = await prisma.watchlistStock.create({
      data: {
        userId,
        stockId: portfolioStock.stockId,
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

    // リアルタイム株価を取得
    const { prices: watchlistPrices } = await fetchStockPrices([
      newWatchlistStock.stock.tickerCode,
    ]);
    const watchlistCurrentPrice = watchlistPrices[0]?.currentPrice ?? null;

    const response: UserStockResponse = {
      id: newWatchlistStock.id,
      userId: newWatchlistStock.userId,
      stockId: newWatchlistStock.stockId,
      type: "watchlist",
      stock: {
        id: newWatchlistStock.stock.id,
        tickerCode: newWatchlistStock.stock.tickerCode,
        name: newWatchlistStock.stock.name,
        sector: newWatchlistStock.stock.sector,
        market: newWatchlistStock.stock.market,
        currentPrice: watchlistCurrentPrice,
      },
      createdAt: newWatchlistStock.createdAt.toISOString(),
      updatedAt: newWatchlistStock.updatedAt.toISOString(),
    };

    return NextResponse.json(response);
  } else {
    return NextResponse.json(
      { error: "Invalid conversion request" },
      { status: 400 },
    );
  }
}

async function handleUpdate(
  id: string,
  userId: string,
  body: UpdateUserStockRequest,
) {
  // Find in both tables
  const [watchlistStock, portfolioStock] = await Promise.all([
    prisma.watchlistStock.findUnique({
      where: { id },
      include: { stock: true },
    }),
    prisma.portfolioStock.findUnique({
      where: { id },
      include: {
        stock: true,
        transactions: { orderBy: { transactionDate: "asc" } },
      },
    }),
  ]);

  const existingStock = watchlistStock || portfolioStock;
  if (!existingStock) {
    return NextResponse.json({ error: "Stock not found" }, { status: 404 });
  }

  if (existingStock.userId !== userId) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  if (watchlistStock) {
    // Update targetBuyPrice if provided
    const updateData: { targetBuyPrice?: number | null } = {};
    if ("targetBuyPrice" in body) {
      updateData.targetBuyPrice = body.targetBuyPrice;
    }

    const updated =
      Object.keys(updateData).length > 0
        ? await prisma.watchlistStock.update({
            where: { id },
            data: updateData,
            include: { stock: true },
          })
        : watchlistStock;

    // リアルタイム株価を取得
    const { prices: watchlistPrices } = await fetchStockPrices([
      updated.stock.tickerCode,
    ]);
    const watchlistCurrentPrice = watchlistPrices[0]?.currentPrice ?? null;

    const response: UserStockResponse = {
      id: updated.id,
      userId: updated.userId,
      stockId: updated.stockId,
      type: "watchlist",
      targetBuyPrice: updated.targetBuyPrice
        ? Number(updated.targetBuyPrice)
        : null,
      stock: {
        id: updated.stock.id,
        tickerCode: updated.stock.tickerCode,
        name: updated.stock.name,
        sector: updated.stock.sector,
        market: updated.stock.market,
        currentPrice: watchlistCurrentPrice,
      },
      createdAt: updated.createdAt.toISOString(),
      updatedAt: updated.updatedAt.toISOString(),
    };

    return NextResponse.json(response);
  } else if (portfolioStock) {
    // リアルタイム株価を取得
    const { prices: portfolioPrices } = await fetchStockPrices([
      portfolioStock.stock.tickerCode,
    ]);
    const portfolioCurrentPrice = portfolioPrices[0]?.currentPrice ?? null;

    // Update individual TP/SL rates if provided
    const updateData: {
      takeProfitRate?: number | null;
      stopLossRate?: number | null;
    } = {};
    let hasUpdates = false;

    if ("takeProfitRate" in body) {
      updateData.takeProfitRate = body.takeProfitRate;
      hasUpdates = true;
    }
    if ("stopLossRate" in body) {
      updateData.stopLossRate = body.stopLossRate;
      hasUpdates = true;
    }

    const updated = hasUpdates
      ? await prisma.portfolioStock.update({
          where: { id },
          data: updateData,
          include: {
            stock: true,
            transactions: { orderBy: { transactionDate: "asc" } },
          },
        })
      : portfolioStock;

    // Calculate from transactions
    const { quantity, averagePurchasePrice } =
      calculatePortfolioFromTransactions(updated.transactions);
    const firstBuyTransaction = updated.transactions.find(
      (t) => t.type === "buy",
    );
    const purchaseDate =
      firstBuyTransaction?.transactionDate || updated.createdAt;

    const response: UserStockResponse = {
      id: updated.id,
      userId: updated.userId,
      stockId: updated.stockId,
      type: "portfolio",
      quantity,
      averagePurchasePrice: averagePurchasePrice.toNumber(),
      purchaseDate: purchaseDate.toISOString(),
      lastAnalysis: updated.lastAnalysis
        ? updated.lastAnalysis.toISOString()
        : null,
      shortTerm: updated.shortTerm,
      mediumTerm: updated.mediumTerm,
      longTerm: updated.longTerm,
      takeProfitRate: updated.takeProfitRate != null
        ? Number(updated.takeProfitRate)
        : null,
      stopLossRate: updated.stopLossRate != null ? Number(updated.stopLossRate) : null,
      transactions: updated.transactions.map((t) => ({
        id: t.id,
        type: t.type,
        quantity: t.quantity,
        price: t.price.toNumber(),
        totalAmount: t.totalAmount.toNumber(),
        transactionDate: t.transactionDate.toISOString(),
      })),
      stock: {
        id: updated.stock.id,
        tickerCode: updated.stock.tickerCode,
        name: updated.stock.name,
        sector: updated.stock.sector,
        market: updated.stock.market,
        currentPrice: portfolioCurrentPrice,
      },
      createdAt: updated.createdAt.toISOString(),
      updatedAt: updated.updatedAt.toISOString(),
    };

    return NextResponse.json(response);
  }

  return NextResponse.json({ error: "Invalid request" }, { status: 400 });
}

/**
 * DELETE /api/user-stocks/[id]
 * Remove stock from watchlist or portfolio
 */
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const { user: deleteUser, error: deleteError } = await getAuthUser();
  if (deleteError) return deleteError;

  try {
    const userId = deleteUser.id;

    // Find in both tables
    const [watchlistStock, portfolioStock] = await Promise.all([
      prisma.watchlistStock.findUnique({
        where: { id },
        include: { stock: true },
      }),
      prisma.portfolioStock.findUnique({
        where: { id },
        include: { stock: true },
      }),
    ]);

    const existingStock = watchlistStock || portfolioStock;
    if (!existingStock) {
      return NextResponse.json({ error: "Stock not found" }, { status: 404 });
    }

    if (existingStock.userId !== userId) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    // Delete from appropriate table
    if (watchlistStock) {
      await prisma.watchlistStock.delete({ where: { id } });
    } else if (portfolioStock) {
      // Delete transactions and portfolio
      await prisma.$transaction(async (tx) => {
        await tx.transaction.deleteMany({
          where: { portfolioStockId: id },
        });
        await tx.portfolioStock.delete({ where: { id } });
      });
    }

    return NextResponse.json({
      success: true,
      message: `Stock ${existingStock.stock.name} (${existingStock.stock.tickerCode}) removed successfully`,
    });
  } catch (error) {
    console.error("Error deleting user stock:", error);
    return NextResponse.json(
      { error: "Failed to delete user stock" },
      { status: 500 },
    );
  }
}
