import { NextResponse } from "next/server"
import { auth } from "@/auth"
import { prisma } from "@/lib/prisma"
import { getTodayForDB } from "@/lib/date-utils"

/**
 * GET /api/featured-stocks
 * 今日の注目銘柄を取得
 * - あなたへのおすすめ（5件）: UserDailyRecommendation（AIがユーザーごとに生成）
 * - 当日データがなければ最新データを返し、isToday: false を返す
 */
export async function GET() {
  try {
    const session = await auth()
    const userId = session?.user?.id

    if (!userId) {
      return NextResponse.json(
        { error: "認証が必要です" },
        { status: 401 }
      )
    }

    // 日本時間で今日の00:00:00をUTCに変換
    const todayUTC = getTodayForDB()

    // ユーザーの銘柄IDを取得（UserStock.idも含める）
    const [watchlist, allPortfolio, tracked] = await Promise.all([
      prisma.watchlistStock.findMany({
        where: { userId },
        select: { id: true, stockId: true },
      }),
      prisma.portfolioStock.findMany({
        where: { userId },
        select: {
          id: true,
          stockId: true,
          transactions: { select: { type: true, quantity: true } },
        },
      }),
      prisma.trackedStock.findMany({
        where: { userId },
        select: { id: true, stockId: true },
      }),
    ])
    // 保有中 = Transactionから計算して保有数 > 0 の銘柄
    const portfolio = allPortfolio.filter((ps) => {
      const qty = ps.transactions.reduce((sum, t) =>
        sum + (t.type === "buy" ? t.quantity : -t.quantity), 0);
      return qty > 0;
    });
    const portfolioStockIds = portfolio.map((s) => s.stockId)
    const portfolioMap = new Map(portfolio.map((s) => [s.stockId, s.id]))
    // ウォッチリスト = 気になる銘柄
    const watchlistStockIds = watchlist.map((s) => s.stockId)
    const watchlistMap = new Map(watchlist.map((s) => [s.stockId, s.id]))
    // 追跡中
    const trackedStockIds = tracked.map((s) => s.stockId)

    // --- あなたへのおすすめ（ユーザーごとのAI生成） ---
    let personalRecommendations: {
      id: string
      stockId: string
      reason: string
      investmentTheme: string | null
      category: string | null
      isOwned: boolean
      isRegistered: boolean
      isTracked: boolean
      userStockId: string | null // ポートフォリオまたはウォッチリストのID
      stock: {
        id: string
        tickerCode: string
        name: string
        sector: string | null
        currentPrice: number | null
        isProfitable: boolean | null
        volatility: number | null
        weekChangeRate: number | null
      }
    }[] = []

    let isToday = false

    // まず当日データを取得
    let recs = await prisma.userDailyRecommendation.findMany({
      where: {
        userId,
        date: todayUTC,
      },
      include: {
        stock: true,
      },
      orderBy: { position: "asc" },
    })

    if (recs.length > 0) {
      isToday = true
    } else {
      // 当日データがなければ最新データを取得
      const latestRec = await prisma.userDailyRecommendation.findFirst({
        where: { userId },
        select: { date: true },
        orderBy: { date: "desc" },
      })

      if (latestRec) {
        recs = await prisma.userDailyRecommendation.findMany({
          where: {
            userId,
            date: latestRec.date,
          },
          include: {
            stock: true,
          },
          orderBy: { position: "asc" },
        })
      }
    }

    if (recs.length > 0) {
      personalRecommendations = recs.map((r) => ({
        id: r.id,
        stockId: r.stockId,
        reason: r.reason,
        investmentTheme: r.investmentTheme,
        sellTargetRate: r.sellTargetRate,
        exitRate: r.exitRate,
        category: null,
        isOwned: portfolioStockIds.includes(r.stockId),
        isRegistered: watchlistStockIds.includes(r.stockId),
        isTracked: trackedStockIds.includes(r.stockId),
        userStockId: portfolioMap.get(r.stockId) || watchlistMap.get(r.stockId) || null,
        stock: {
          id: r.stock.id,
          tickerCode: r.stock.tickerCode,
          name: r.stock.name,
          sector: r.stock.sector,
          currentPrice: null, // リアルタイム取得で後から設定
          isProfitable: r.stock.isProfitable,
          volatility: r.stock.volatility ? Number(r.stock.volatility) : null,
          weekChangeRate: r.stock.weekChangeRate ? Number(r.stock.weekChangeRate) : null,
          fetchFailCount: r.stock.fetchFailCount,
          isDelisted: r.stock.isDelisted,
        },
      }))
    }

    return NextResponse.json({
      personalRecommendations,
      trendingStocks: [],
      date: recs.length > 0 ? recs[0].date : null,
      isToday,
    }, { status: 200 })
  } catch (error) {
    console.error("Error fetching featured stocks:", error)
    return NextResponse.json(
      { error: "注目銘柄の取得に失敗しました" },
      { status: 500 }
    )
  }
}
