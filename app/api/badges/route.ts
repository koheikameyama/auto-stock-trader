import { NextRequest, NextResponse } from "next/server"
import { getAuthUser } from "@/lib/auth-utils"
import { prisma } from "@/lib/prisma"
import { calculatePortfolioFromTransactions } from "@/lib/portfolio-calculator"

export async function GET(request: NextRequest) {
  const { user, error } = await getAuthUser()
  if (error) return error

  try {
    const userId = user.id

    // クエリパラメータから最終閲覧時刻を取得
    const searchParams = request.nextUrl.searchParams
    const dashboardLastSeen = searchParams.get("dashboard")
    const myStocksLastSeen = searchParams.get("my-stocks")
    const newsLastSeen = searchParams.get("news")
    const aiReportLastSeen = searchParams.get("ai-report")

    // 並列でバッジカウントを取得
    const [
      dashboardBadge,
      myStocksBadge,
      newsBadge,
      aiReportBadge,
    ] = await Promise.all([
      // ホーム: 新しいおすすめ銘柄
      getDashboardBadge(userId, dashboardLastSeen),
      // マイ銘柄: 新しい分析
      getMyStocksBadge(userId, myStocksLastSeen),
      // ニュース: 新しいニュース
      getNewsBadge(newsLastSeen),
      // AI精度レポート: 更新あり
      getAIReportBadge(aiReportLastSeen),
    ])

    return NextResponse.json({
      dashboard: dashboardBadge,
      "my-stocks": myStocksBadge,
      news: newsBadge,
      "ai-report": aiReportBadge,
      // その他タブ用
      menu: aiReportBadge,
    })
  } catch (error) {
    console.error("Error fetching badges:", error)
    return NextResponse.json(
      { error: "Failed to fetch badges" },
      { status: 500 }
    )
  }
}

// ホーム: 新しいおすすめ銘柄があるか
async function getDashboardBadge(
  userId: string,
  lastSeen: string | null
): Promise<boolean> {
  if (!lastSeen) return false

  const lastSeenDate = new Date(lastSeen)

  // ユーザー向けおすすめが更新されているか
  const userRec = await prisma.userDailyRecommendation.findFirst({
    where: {
      userId,
      createdAt: { gt: lastSeenDate },
    },
    select: { id: true },
  })

  return !!userRec
}

// マイ銘柄: 新しい分析があるか
async function getMyStocksBadge(
  userId: string,
  lastSeen: string | null
): Promise<boolean> {
  if (!lastSeen) return false

  const lastSeenDate = new Date(lastSeen)

  // ユーザーの保有銘柄・気になる銘柄のIDを取得
  const [portfolioStocks, watchlistStocks] = await Promise.all([
    prisma.portfolioStock.findMany({
      where: { userId },
      select: {
        stockId: true,
        transactions: {
          select: { type: true, quantity: true, price: true },
        },
      },
    }),
    prisma.watchlistStock.findMany({
      where: { userId },
      select: { stockId: true },
    }),
  ])

  // 保有数が0の銘柄を除外
  const activePortfolioStocks = portfolioStocks.filter((ps) => {
    const { quantity } = calculatePortfolioFromTransactions(ps.transactions);
    return quantity > 0;
  })

  const stockIds = [
    ...activePortfolioStocks.map((p) => p.stockId),
    ...watchlistStocks.map((w) => w.stockId),
  ]

  if (stockIds.length === 0) return false

  // これらの銘柄に新しい分析があるか
  const newAnalysis = await prisma.stockAnalysis.findFirst({
    where: {
      stockId: { in: stockIds },
      analyzedAt: { gt: lastSeenDate },
    },
    select: { id: true },
  })

  return !!newAnalysis
}

// ニュース: 新しいニュースがあるか
async function getNewsBadge(lastSeen: string | null): Promise<boolean> {
  if (!lastSeen) return false

  const lastSeenDate = new Date(lastSeen)

  const newNews = await prisma.marketNews.findFirst({
    where: {
      createdAt: { gt: lastSeenDate },
    },
    select: { id: true },
  })

  return !!newNews
}

// AI精度レポート: 更新があるか
async function getAIReportBadge(lastSeen: string | null): Promise<boolean> {
  if (!lastSeen) return false

  const lastSeenDate = new Date(lastSeen)

  const report = await prisma.weeklyAIReport.findFirst({
    where: {
      createdAt: { gt: lastSeenDate },
    },
    orderBy: { createdAt: "desc" },
    select: { id: true },
  })

  return !!report
}
