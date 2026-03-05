import { Suspense } from "react";
import { auth } from "@/auth";
import { redirect } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { getTodayForDB } from "@/lib/date-utils";
import { calculatePortfolioFromTransactions } from "@/lib/portfolio-calculator";
import { fetchStockPrices } from "@/lib/stock-price-fetcher";
import { getSectorTrend } from "@/lib/sector-trend";
import { getSectorGroup } from "@/lib/constants";
import { Decimal } from "@prisma/client/runtime/library";
import AuthenticatedLayout from "@/app/components/AuthenticatedLayout";
import StockDetailClient from "./StockDetailClient";
import { StockDetailSkeleton } from "@/components/skeletons";

export default async function StockDetailPage({
  params,
}: {
  params: Promise<{ stockId: string }>;
}) {
  const session = await auth();
  const { stockId } = await params;

  if (!session?.user?.email) {
    redirect("/login");
  }

  const user = await prisma.user.findUnique({
    where: { email: session.user.email },
  });

  if (!user) {
    redirect("/login");
  }

  return (
    <AuthenticatedLayout maxWidth="6xl">
      <Suspense fallback={<StockDetailSkeleton />}>
        <StockDetailContent stockId={stockId} userId={user.id} />
      </Suspense>
    </AuthenticatedLayout>
  );
}

async function StockDetailContent({
  stockId,
  userId,
}: {
  stockId: string;
  userId: string;
}) {
  // Fetch stock and related data
  const [
    stock,
    personalRec,
    featuredStock,
    watchlistEntry,
    trackedEntry,
    portfolioEntry,
    latestRecommendation,
    latestAnalysis,
  ] = await Promise.all([
    prisma.stock.findUnique({
      where: { id: stockId },
    }),
    // Get today's personal recommendation for this user
    prisma.userDailyRecommendation.findFirst({
      where: { stockId, userId, date: getTodayForDB() },
    }),
    // Get today's featured stock (if this is from "みんなが注目")
    prisma.dailyFeaturedStock.findFirst({
      where: { stockId, date: getTodayForDB() },
    }),
    // Check if user has this stock in watchlist
    prisma.watchlistStock.findFirst({
      where: { stockId, userId },
    }),
    // Check if user has this stock in tracked
    prisma.trackedStock.findFirst({
      where: { stockId, userId },
    }),
    // Get portfolio entry with transactions (for sold stock info)
    prisma.portfolioStock.findFirst({
      where: { stockId, userId },
      include: {
        transactions: {
          orderBy: { transactionDate: "asc" },
        },
      },
    }),
    // Get latest purchase recommendation for marketSignal
    prisma.purchaseRecommendation.findFirst({
      where: { stockId },
      orderBy: { date: "desc" },
      select: { marketSignal: true },
    }),
    // Get latest stock analysis for trendConvergence
    prisma.stockAnalysis.findFirst({
      where: { stockId },
      orderBy: { analyzedAt: "desc" },
      select: { trendConvergence: true },
    }),
  ]);

  if (!stock) {
    redirect("/dashboard");
  }

  // セクター平均データを取得（相対評価用）
  const stockSectorGroup = getSectorGroup(stock.sector)
  const sectorTrend = stockSectorGroup ? await getSectorTrend(stockSectorGroup) : null
  const sectorAvg = sectorTrend ? {
    avgPER: sectorTrend.avgPER,
    avgPBR: sectorTrend.avgPBR,
    avgROE: sectorTrend.avgROE,
    compositeScore: sectorTrend.compositeScore,
    trendDirection: sectorTrend.trendDirection,
  } : null

  const stockData = {
    id: stock.id,
    tickerCode: stock.tickerCode,
    name: stock.name,
    sector: stock.sector,
    market: stock.market,
    currentPrice: null,
    fiftyTwoWeekHigh: stock.fiftyTwoWeekHigh
      ? Number(stock.fiftyTwoWeekHigh)
      : null,
    fiftyTwoWeekLow: stock.fiftyTwoWeekLow
      ? Number(stock.fiftyTwoWeekLow)
      : null,
    pbr: stock.pbr ? Number(stock.pbr) : null,
    per: stock.per ? Number(stock.per) : null,
    roe: stock.roe ? Number(stock.roe) : null,
    operatingCF: stock.operatingCF ? Number(stock.operatingCF) : null,
    freeCF: stock.freeCF ? Number(stock.freeCF) : null,
    isProfitable: stock.isProfitable,
    profitTrend: stock.profitTrend,
    revenueGrowth: stock.revenueGrowth ? Number(stock.revenueGrowth) : null,
    netIncomeGrowth: stock.netIncomeGrowth
      ? Number(stock.netIncomeGrowth)
      : null,
    eps: stock.eps ? Number(stock.eps) : null,
    latestRevenue: stock.latestRevenue ? Number(stock.latestRevenue) : null,
    latestNetIncome: stock.latestNetIncome
      ? Number(stock.latestNetIncome)
      : null,
    debtEquityRatio: stock.debtEquityRatio ? Number(stock.debtEquityRatio) : null,
    currentRatio: stock.currentRatio ? Number(stock.currentRatio) : null,
    dividendGrowthRate: stock.dividendGrowthRate ? Number(stock.dividendGrowthRate) : null,
    payoutRatio: stock.payoutRatio ? Number(stock.payoutRatio) : null,
    volatility: stock.volatility ? Number(stock.volatility) : null,
    weekChangeRate: stock.weekChangeRate ? Number(stock.weekChangeRate) : null,
    gapUpRate: stock.gapUpRate ? Number(stock.gapUpRate) : null,
    volumeSpikeRate: stock.volumeSpikeRate ? Number(stock.volumeSpikeRate) : null,
    turnoverValue: stock.turnoverValue ? Number(stock.turnoverValue) : null,
    fetchFailCount: stock.fetchFailCount,
    isDelisted: stock.isDelisted,
    nextEarningsDate: stock.nextEarningsDate?.toISOString() ?? null,
  };

  // 売却済み情報を計算
  let soldStockInfo = null;
  if (portfolioEntry) {
    const { quantity } = calculatePortfolioFromTransactions(
      portfolioEntry.transactions,
    );

    // quantity === 0 の場合は売却済み
    if (quantity === 0) {
      const buyTransactions = portfolioEntry.transactions.filter(
        (t) => t.type === "buy",
      );
      const sellTransactions = portfolioEntry.transactions.filter(
        (t) => t.type === "sell",
      );

      if (buyTransactions.length > 0 && sellTransactions.length > 0) {
        const totalBuyAmount = buyTransactions.reduce(
          (sum, t) => sum.plus(t.totalAmount),
          new Decimal(0),
        );
        const totalSellAmount = sellTransactions.reduce(
          (sum, t) => sum.plus(t.totalAmount),
          new Decimal(0),
        );
        const totalBuyQuantity = buyTransactions.reduce(
          (sum, t) => sum + t.quantity,
          0,
        );
        const totalProfit = totalSellAmount.minus(totalBuyAmount);
        const profitPercent = totalBuyAmount.gt(0)
          ? totalProfit.div(totalBuyAmount).times(100).toNumber()
          : 0;

        // 現在価格を取得
        let currentPrice: number | null = null;
        let hypotheticalProfit: number | null = null;
        let hypotheticalProfitPercent: number | null = null;

        try {
          const { prices } = await fetchStockPrices([stock.tickerCode]);
          if (prices.length > 0) {
            currentPrice = prices[0].currentPrice;
            const hypotheticalValue = currentPrice * totalBuyQuantity;
            hypotheticalProfit = hypotheticalValue - totalBuyAmount.toNumber();
            hypotheticalProfitPercent = totalBuyAmount.gt(0)
              ? (hypotheticalProfit / totalBuyAmount.toNumber()) * 100
              : 0;
          }
        } catch (error) {
          console.error("Error fetching current price:", error);
        }

        soldStockInfo = {
          lastSellDate:
            sellTransactions[
              sellTransactions.length - 1
            ].transactionDate.toISOString(),
          totalBuyQuantity,
          totalBuyAmount: totalBuyAmount.toNumber(),
          totalSellAmount: totalSellAmount.toNumber(),
          totalProfit: totalProfit.toNumber(),
          profitPercent,
          currentPrice,
          hypotheticalProfit,
          hypotheticalProfitPercent,
        };
      }
    }
  }

  // Determine which recommendation to use (personal takes priority)
  const recommendation = personalRec
    ? {
        type: "personal" as const,
        category: null,
        reason: personalRec.reason,
        date: personalRec.date.toISOString(),
      }
    : featuredStock
      ? {
          type: "featured" as const,
          category: featuredStock.category,
          reason: featuredStock.reason,
          date: featuredStock.date.toISOString(),
        }
      : null;

  return (
    <StockDetailClient
      stock={stockData}
      recommendation={recommendation}
      isInWatchlist={!!watchlistEntry}
      isTracked={!!trackedEntry}
      isInPortfolio={
        !!portfolioEntry &&
        calculatePortfolioFromTransactions(portfolioEntry.transactions)
          .quantity > 0
      }
      portfolioDetails={
        portfolioEntry
          ? (() => {
              const p = calculatePortfolioFromTransactions(
                portfolioEntry.transactions,
              );
              const latestPrice = stockData.currentPrice || 0;
              const avgPrice = p.averagePurchasePrice.toNumber();
              const totalCost = avgPrice * p.quantity;
              return {
                quantity: p.quantity,
                averagePurchasePrice: avgPrice,
                profit: latestPrice * p.quantity - totalCost,
                profitPercent:
                  totalCost > 0
                    ? ((latestPrice * p.quantity - totalCost) / totalCost) * 100
                    : 0,
              };
            })()
          : undefined
      }
      trackedStockId={trackedEntry?.id}
      soldStockInfo={soldStockInfo}
      sectorAvg={sectorAvg}
      marketSignal={portfolioEntry?.marketSignal ?? latestRecommendation?.marketSignal ?? null}
      trendConvergence={latestAnalysis?.trendConvergence as Record<string, unknown> | null | undefined}
    />
  );
}
