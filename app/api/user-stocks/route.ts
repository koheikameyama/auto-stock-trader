import { NextRequest, NextResponse } from "next/server";
import { getAuthUser } from "@/lib/auth-utils";
import { prisma } from "@/lib/prisma";
import { searchAndAddStock } from "@/lib/stock-fetcher";
import { Decimal } from "@prisma/client/runtime/library";
import { calculatePortfolioFromTransactions } from "@/lib/portfolio-calculator";
import { MAX_WATCHLIST_STOCKS, MAX_PORTFOLIO_STOCKS } from "@/lib/constants";
import { fetchStockPrices } from "@/lib/stock-price-fetcher";
import { executeStockReport } from "@/lib/stock-report-core";
import { executePortfolioAnalysis } from "@/lib/portfolio-analysis-core";
import {
  fetchDefaultTpSlRates,
  createPortfolioStockWithTransaction,
  buildPortfolioStockResponse,
} from "@/lib/portfolio-stock-utils";

// Types
export interface UserStockResponse {
  id: string;
  userId: string;
  stockId: string;
  type: "watchlist" | "portfolio";
  // Portfolio fields (calculated from transactions)
  quantity?: number;
  averagePurchasePrice?: number;
  purchaseDate?: string;
  lastAnalysis?: string | null;
  shortTerm?: string | null;
  mediumTerm?: string | null;
  longTerm?: string | null;
  // リスク評価（Portfolio only）
  riskLevel?: string | null;
  riskFlags?: unknown;
  // 買い時通知（Watchlist only）
  targetBuyPrice?: number | null;
  // 個別設定率（Portfolio only）
  takeProfitRate?: number | null;
  stopLossRate?: number | null;
  // 注目データ経由の情報（Watchlist only）
  highlightType?: string | null;
  highlightReason?: string | null;
  // Transaction data
  transactions?: {
    id: string;
    type: string;
    quantity: number;
    price: number;
    totalAmount: number;
    transactionDate: string;
  }[];
  stock: {
    id: string;
    tickerCode: string;
    name: string;
    sector: string | null;
    market: string;
    currentPrice: number | null;
    atr14?: number | null;
    fetchFailCount?: number;
    isDelisted?: boolean;
    nextEarningsDate?: string | null;
    delistingNewsDetectedAt?: string | null;
    delistingNewsReason?: string | null;
  };
  createdAt: string;
  updatedAt: string;
}

interface CreateUserStockRequest {
  tickerCode: string;
  type: "watchlist" | "portfolio";
  // Portfolio fields
  quantity?: number;
  averagePurchasePrice?: number;
  purchaseDate?: string;
  // 注目データ経由の場合
  highlightType?: string;
  highlightReason?: string;
}

/**
 * GET /api/user-stocks
 * Retrieve all user stocks (both watchlist and portfolio)
 *
 * Query params:
 * - mode: "portfolio" | "watchlist" | "all" (default: "all")
 */
export async function GET(request: NextRequest) {
  const { user, error } = await getAuthUser();
  if (error) return error;

  try {
    const userId = user.id;
    const { searchParams } = new URL(request.url);
    const mode = searchParams.get("mode") || "all";

    let watchlistStocks: Awaited<
      ReturnType<
        typeof prisma.watchlistStock.findMany<{
          where: { userId: string };
          include: {
            stock: {
              select: {
                id: true;
                tickerCode: true;
                name: true;
                sector: true;
                market: true;
                atr14: true;
                fetchFailCount: true;
                isDelisted: true;
                nextEarningsDate: true;
                delistingNewsDetectedAt: true;
                delistingNewsReason: true;
              };
            };
          };
        }>
      >
    > = [];
    let portfolioStocks: Awaited<
      ReturnType<
        typeof prisma.portfolioStock.findMany<{
          where: { userId: string };
          include: {
            stock: {
              select: {
                id: true;
                tickerCode: true;
                name: true;
                sector: true;
                market: true;
                atr14: true;
                fetchFailCount: true;
                isDelisted: true;
                delistingNewsDetectedAt: true;
                delistingNewsReason: true;
              };
            };
            transactions: { orderBy: { transactionDate: "asc" } };
          };
        }>
      >
    > = [];

    // Fetch based on mode
    if (mode === "watchlist" || mode === "all") {
      watchlistStocks = await prisma.watchlistStock.findMany({
        where: { userId },
        include: {
          stock: {
            select: {
              id: true,
              tickerCode: true,
              name: true,
              sector: true,
              market: true,
              atr14: true,
              fetchFailCount: true,
              isDelisted: true,
              nextEarningsDate: true,
              delistingNewsDetectedAt: true,
              delistingNewsReason: true,
            },
          },
        },
        orderBy: { createdAt: "desc" },
      });
    }

    if (mode === "portfolio" || mode === "all") {
      const allPortfolioStocks = await prisma.portfolioStock.findMany({
        where: { userId },
        include: {
          stock: {
            select: {
              id: true,
              tickerCode: true,
              name: true,
              sector: true,
              market: true,
              atr14: true,
              fetchFailCount: true,
              isDelisted: true,
              delistingNewsDetectedAt: true,
              delistingNewsReason: true,
            },
          },
          transactions: {
            orderBy: { transactionDate: "asc" },
          },
        },
        orderBy: { createdAt: "desc" },
      });
      // Transactionから保有数を計算し、保有中（quantity > 0）のみに絞る
      portfolioStocks = allPortfolioStocks.filter((ps) => {
        const { quantity } = calculatePortfolioFromTransactions(ps.transactions);
        return quantity > 0;
      });
    }

    // Format response (株価はクライアント側で非同期取得)
    const watchlistResponse: UserStockResponse[] = watchlistStocks.map(
      (ws) => ({
        id: ws.id,
        userId: ws.userId,
        stockId: ws.stockId,
        type: "watchlist" as const,
        targetBuyPrice: ws.targetBuyPrice ? Number(ws.targetBuyPrice) : null,
        highlightType: ws.highlightType,
        highlightReason: ws.highlightReason,
        stock: {
          id: ws.stock.id,
          tickerCode: ws.stock.tickerCode,
          name: ws.stock.name,
          sector: ws.stock.sector,
          market: ws.stock.market,
          currentPrice: null, // クライアント側で非同期取得
          atr14: ws.stock.atr14 ? Number(ws.stock.atr14) : null,
          fetchFailCount: ws.stock.fetchFailCount,
          isDelisted: ws.stock.isDelisted,
          nextEarningsDate: ws.stock.nextEarningsDate?.toISOString() ?? null,
          delistingNewsDetectedAt: ws.stock.delistingNewsDetectedAt?.toISOString() ?? null,
          delistingNewsReason: ws.stock.delistingNewsReason ?? null,
        },
        createdAt: ws.createdAt.toISOString(),
        updatedAt: ws.updatedAt.toISOString(),
      }),
    );

    const portfolioResponse: UserStockResponse[] = portfolioStocks.map((ps) => {
      // Calculate from transactions
      const { quantity, averagePurchasePrice } =
        calculatePortfolioFromTransactions(ps.transactions);
      const firstBuyTransaction = ps.transactions.find((t) => t.type === "buy");
      const purchaseDate = firstBuyTransaction?.transactionDate || ps.createdAt;

      return {
        id: ps.id,
        userId: ps.userId,
        stockId: ps.stockId,
        type: "portfolio" as const,
        quantity,
        averagePurchasePrice: averagePurchasePrice.toNumber(),
        purchaseDate: purchaseDate.toISOString(),
        lastAnalysis: ps.lastAnalysis ? ps.lastAnalysis.toISOString() : null,
        shortTerm: ps.shortTerm,
        mediumTerm: ps.mediumTerm,
        longTerm: ps.longTerm,
        takeProfitRate: ps.takeProfitRate != null ? Number(ps.takeProfitRate) : null,
        stopLossRate: ps.stopLossRate != null ? Number(ps.stopLossRate) : null,
        riskLevel: ps.riskLevel,
        riskFlags: ps.riskFlags,
        transactions: ps.transactions.map((t) => ({
          id: t.id,
          type: t.type,
          quantity: t.quantity,
          price: t.price.toNumber(),
          totalAmount: t.totalAmount.toNumber(),
          transactionDate: t.transactionDate.toISOString(),
        })),
        stock: {
          id: ps.stock.id,
          tickerCode: ps.stock.tickerCode,
          name: ps.stock.name,
          sector: ps.stock.sector,
          market: ps.stock.market,
          currentPrice: null, // クライアント側で非同期取得
          atr14: ps.stock.atr14 ? Number(ps.stock.atr14) : null,
          fetchFailCount: ps.stock.fetchFailCount,
          isDelisted: ps.stock.isDelisted,
          delistingNewsDetectedAt: ps.stock.delistingNewsDetectedAt?.toISOString() ?? null,
          delistingNewsReason: ps.stock.delistingNewsReason ?? null,
        },
        createdAt: ps.createdAt.toISOString(),
        updatedAt: ps.updatedAt.toISOString(),
      };
    });

    const response = [...watchlistResponse, ...portfolioResponse];

    return NextResponse.json(response);
  } catch (error) {
    console.error("Error fetching user stocks:", error);
    return NextResponse.json(
      { error: "Failed to fetch user stocks" },
      { status: 500 },
    );
  }
}

/**
 * POST /api/user-stocks
 * Add stock to watchlist or portfolio
 *
 * Body:
 * - tickerCode: string (required)
 * - type: "watchlist" | "portfolio" (required)
 * - watchlist: addedReason?
 * - portfolio: quantity, averagePurchasePrice, purchaseDate?
 */
export async function POST(request: NextRequest) {
  const { user, error: postError } = await getAuthUser();
  if (postError) return postError;

  try {
    const userId = user.id;
    const body: CreateUserStockRequest = await request.json();
    const { tickerCode, type, quantity, averagePurchasePrice, purchaseDate } =
      body;

    // Validation
    if (!tickerCode) {
      return NextResponse.json(
        { error: "tickerCode is required" },
        { status: 400 },
      );
    }

    if (!type || !["watchlist", "portfolio"].includes(type)) {
      return NextResponse.json(
        { error: "type must be 'watchlist' or 'portfolio'" },
        { status: 400 },
      );
    }

    // Normalize ticker code
    let normalizedTickerCode = tickerCode;
    if (/^\d+$/.test(tickerCode)) {
      normalizedTickerCode = `${tickerCode}.T`;
    }

    // Find stock
    let stock = await prisma.stock.findUnique({
      where: { tickerCode: normalizedTickerCode },
    });

    // マスタにない場合はyfinanceで検索して追加を試みる
    if (!stock) {
      const searchResult = await searchAndAddStock(normalizedTickerCode);

      if (!searchResult.success || !searchResult.stock) {
        return NextResponse.json(
          {
            error:
              searchResult.error ||
              `銘柄 "${normalizedTickerCode}" が見つかりませんでした。銘柄コードが正しいか確認してください。`,
          },
          { status: 404 },
        );
      }

      // 新しく追加された銘柄を取得
      stock = await prisma.stock.findUnique({
        where: { id: searchResult.stock.id },
      });

      if (!stock) {
        return NextResponse.json(
          { error: "銘柄の登録に失敗しました" },
          { status: 500 },
        );
      }
    }

    // Check if stock already exists
    const [existingWatchlist, existingPortfolio, existingPassedStock] =
      await Promise.all([
        prisma.watchlistStock.findUnique({
          where: { userId_stockId: { userId, stockId: stock.id } },
        }),
        prisma.portfolioStock.findUnique({
          where: { userId_stockId: { userId, stockId: stock.id } },
          include: {
            transactions: {
              orderBy: { transactionDate: "asc" },
            },
          },
        }),
        prisma.trackedStock.findFirst({
          where: { userId, stockId: stock.id },
        }),
      ]);

    // ポートフォリオの保有数を計算（保有してた銘柄かどうかの判定用）
    let portfolioQuantity = 0;
    if (existingPortfolio) {
      const { quantity } = calculatePortfolioFromTransactions(
        existingPortfolio.transactions,
      );
      portfolioQuantity = quantity;
    }

    // ポートフォリオに追加しようとしている場合
    if (type === "portfolio" && existingPortfolio) {
      // 保有数 > 0（現在保有中）ならエラー
      if (portfolioQuantity > 0) {
        return NextResponse.json(
          { error: "この銘柄は既にポートフォリオに登録されています" },
          { status: 400 },
        );
      }
      // 保有数 === 0（保有してた銘柄）の場合は、再購入として処理を続行
    }

    // ウォッチリストに追加しようとしている場合
    if (type === "watchlist") {
      // 既にウォッチリストにある場合
      if (existingWatchlist) {
        return NextResponse.json(
          { error: "この銘柄は既にウォッチリストに登録されています" },
          { status: 400 },
        );
      }
      // 保有数 > 0（現在保有中）の場合はエラー
      if (existingPortfolio && portfolioQuantity > 0) {
        return NextResponse.json(
          { error: "すでに保有している銘柄です" },
          { status: 400 },
        );
      }
      // 保有数 === 0（保有してた銘柄）の場合は、WatchlistStock作成を続行
    }

    // Check limit (separate limits for watchlist and portfolio)
    if (type === "watchlist") {
      const watchlistCount = await prisma.watchlistStock.count({
        where: { userId },
      });
      if (watchlistCount >= MAX_WATCHLIST_STOCKS) {
        return NextResponse.json(
          {
            error: `ウォッチリストは最大${MAX_WATCHLIST_STOCKS}銘柄まで登録できます`,
          },
          { status: 400 },
        );
      }
    } else {
      // portfolio の場合（保有中の銘柄のみカウント - Transactionから計算）
      const allPortfolioForCount = await prisma.portfolioStock.findMany({
        where: { userId },
        include: {
          transactions: {
            select: { type: true, quantity: true },
          },
        },
      });
      const portfolioCount = allPortfolioForCount.filter((ps) => {
        const qty = ps.transactions.reduce((sum, t) =>
          sum + (t.type === "buy" ? t.quantity : -t.quantity), 0);
        return qty > 0;
      }).length;
      // ウォッチリストからポートフォリオへの移行の場合は新規追加ではないのでチェック不要
      if (!existingWatchlist && portfolioCount >= MAX_PORTFOLIO_STOCKS) {
        return NextResponse.json(
          {
            error: `ポートフォリオは最大${MAX_PORTFOLIO_STOCKS}銘柄まで登録できます`,
          },
          { status: 400 },
        );
      }
    }

    // ウォッチリストからポートフォリオへの移行の場合、ウォッチリストから削除
    if (type === "portfolio" && existingWatchlist) {
      await prisma.watchlistStock.delete({
        where: { id: existingWatchlist.id },
      });
    }

    // 追跡銘柄から追加する場合、TrackedStockから削除
    if (existingPassedStock) {
      await prisma.trackedStock.delete({
        where: { id: existingPassedStock.id },
      });
    }

    // Create based on type
    if (type === "watchlist") {
      const watchlistStock = await prisma.watchlistStock.create({
        data: {
          userId,
          stockId: stock.id,
          ...(body.highlightType && {
            highlightType: body.highlightType,
          }),
          ...(body.highlightReason && {
            highlightReason: body.highlightReason,
          }),
        },
        include: {
          stock: {
            select: {
              id: true,
              tickerCode: true,
              name: true,
              sector: true,
              market: true,
              atr14: true,
            },
          },
        },
      });

      // 非同期でAI分析（銘柄レポート）を実行（レスポンスをブロックしない）
      executeStockReport(userId, stock.id).catch((error) => {
        console.error("Failed to run stock report analysis:", error);
      });

      // リアルタイム株価を取得
      const { prices } = await fetchStockPrices([
        watchlistStock.stock.tickerCode,
      ]);
      const currentPrice = prices[0]?.currentPrice ?? null;

      const response: UserStockResponse = {
        id: watchlistStock.id,
        userId: watchlistStock.userId,
        stockId: watchlistStock.stockId,
        type: "watchlist",
        stock: {
          id: watchlistStock.stock.id,
          tickerCode: watchlistStock.stock.tickerCode,
          name: watchlistStock.stock.name,
          sector: watchlistStock.stock.sector,
          market: watchlistStock.stock.market,
          currentPrice,
          atr14: watchlistStock.stock.atr14 ? Number(watchlistStock.stock.atr14) : null,
        },
        createdAt: watchlistStock.createdAt.toISOString(),
        updatedAt: watchlistStock.updatedAt.toISOString(),
      };

      return NextResponse.json(response, { status: 201 });
    } else {
      // Portfolio validation
      if (!quantity || quantity <= 0) {
        return NextResponse.json(
          { error: "quantity is required and must be greater than 0" },
          { status: 400 },
        );
      }

      if (!averagePurchasePrice || averagePurchasePrice <= 0) {
        return NextResponse.json(
          {
            error:
              "averagePurchasePrice is required and must be greater than 0",
          },
          { status: 400 },
        );
      }

      const transactionDate = purchaseDate
        ? new Date(purchaseDate)
        : new Date();

      // デフォルト設定（%）から目標価格を自動計算
      const {
        takeProfitRate: takeProfitPriceCalc,
        stopLossRate: stopLossPriceCalc,
      } = await fetchDefaultTpSlRates(userId);

      // 保有してた銘柄の再購入か、新規追加かで処理を分岐
      const isRepurchase = existingPortfolio && portfolioQuantity === 0;

      let result: {
        portfolioStock: Awaited<
          ReturnType<typeof createPortfolioStockWithTransaction>
        >["portfolioStock"] & {
          riskLevel?: string | null;
          riskFlags?: unknown;
        };
        allTransactions: {
          id: string;
          type: string;
          quantity: number;
          price: Decimal;
          totalAmount: Decimal;
          transactionDate: Date;
        }[];
      };

      if (isRepurchase) {
        // 保有してた銘柄への再購入：既存PortfolioStockにトランザクションを追加
        await prisma.transaction.create({
          data: {
            userId,
            stockId: stock.id,
            portfolioStockId: existingPortfolio.id,
            type: "buy",
            quantity,
            price: new Decimal(averagePurchasePrice),
            totalAmount: new Decimal(quantity).times(averagePurchasePrice),
            transactionDate,
          },
        });

        // PortfolioStock の価格設定を更新
        await prisma.portfolioStock.update({
          where: { id: existingPortfolio.id },
          data: {
            takeProfitRate: takeProfitPriceCalc
              ? new Decimal(takeProfitPriceCalc)
              : existingPortfolio.takeProfitRate,
            stopLossRate: stopLossPriceCalc
              ? new Decimal(stopLossPriceCalc)
              : existingPortfolio.stopLossRate,
          },
        });

        // 更新されたPortfolioStockを取得
        const portfolioStock = await prisma.portfolioStock.findUnique({
          where: { id: existingPortfolio.id },
          include: {
            stock: {
              select: {
                id: true,
                tickerCode: true,
                name: true,
                sector: true,
                market: true,
                atr14: true,
              },
            },
            transactions: {
              orderBy: { transactionDate: "asc" },
            },
          },
        });

        if (!portfolioStock) {
          throw new Error("Failed to fetch portfolio stock after repurchase");
        }

        result = {
          portfolioStock,
          allTransactions: portfolioStock.transactions,
        };
      } else {
        // 新規追加：共通関数で PortfolioStock と Transaction を作成
        const txResult = await prisma.$transaction(async (tx) =>
          createPortfolioStockWithTransaction(tx, {
            userId,
            stockId: stock.id,
            quantity,
            averagePurchasePrice,
            transactionDate,
            takeProfitRate: takeProfitPriceCalc,
            stopLossRate: stopLossPriceCalc,
          }),
        );

        result = {
          portfolioStock: txResult.portfolioStock,
          allTransactions: [txResult.transaction],
        };
      }

      // 非同期でAI分析（ポートフォリオ分析）を実行（レスポンスをブロックしない）
      executePortfolioAnalysis(userId, stock.id).catch((error) => {
        console.error("Failed to run portfolio analysis:", error);
      });

      // リアルタイム株価を取得
      const { prices } = await fetchStockPrices([
        result.portfolioStock.stock.tickerCode,
      ]);
      const currentPrice = prices[0]?.currentPrice ?? null;

      // 共通関数でレスポンスを整形
      const response = buildPortfolioStockResponse({
        portfolioStock: result.portfolioStock as Parameters<
          typeof buildPortfolioStockResponse
        >[0]["portfolioStock"],
        transactions: result.allTransactions,
        currentPrice,
      });

      return NextResponse.json(response, { status: 201 });
    }
  } catch (error) {
    console.error("Error creating user stock:", error);
    return NextResponse.json(
      { error: "Failed to create user stock" },
      { status: 500 },
    );
  }
}
