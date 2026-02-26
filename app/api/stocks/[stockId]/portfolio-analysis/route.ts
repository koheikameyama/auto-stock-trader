import { NextRequest, NextResponse } from "next/server"
import { prisma } from "@/lib/prisma"
import { auth } from "@/auth"
import { verifyCronOrSession } from "@/lib/cron-auth"
import {
  executePortfolioAnalysis,
  AnalysisError,
} from "@/lib/portfolio-analysis-core"
import { fetchStockPrices } from "@/lib/stock-price-fetcher"
import dayjs from "dayjs"
import utc from "dayjs/plugin/utc"
import timezone from "dayjs/plugin/timezone"

dayjs.extend(utc)
dayjs.extend(timezone)

/**
 * GET /api/stocks/[stockId]/portfolio-analysis
 * 指定された銘柄のポートフォリオ分析を取得
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ stockId: string }> }
) {
  const { stockId } = await params

  try {
    // 認証チェック
    const session = await auth()
    if (!session?.user?.id) {
      return NextResponse.json(
        { error: "認証が必要です" },
        { status: 401 }
      )
    }

    const userId = session.user.id

    // ポートフォリオ分析・ユーザー設定を並列取得
    const [portfolioStock, userSettings] = await Promise.all([
      prisma.portfolioStock.findFirst({
        where: {
          userId,
          stockId,
        },
        select: {
          shortTerm: true,
          mediumTerm: true,
          longTerm: true,
          lastAnalysis: true,
          statusType: true,
          marketSignal: true,
          suggestedSellPrice: true,
          suggestedSellPercent: true,
          sellReason: true,
          sellCondition: true,
          sellTiming: true,
          sellTargetPrice: true,
          takeProfitRate: true,
          stopLossRate: true,
          transactions: {
            orderBy: { transactionDate: "asc" },
          },
          stock: {
            select: { tickerCode: true },
          },
        },
      }),
      prisma.userSettings.findUnique({
        where: { userId },
        select: { stopLossRate: true, targetReturnRate: true },
      }),
    ])

    // StockAnalysis: lastAnalysisと同時刻のエントリーを取得（購入判断の結果が混入しないようにする）
    const stockAnalysis = portfolioStock?.lastAnalysis
      ? (await prisma.stockAnalysis.findFirst({
          where: { stockId, analyzedAt: portfolioStock.lastAnalysis },
        })) ??
        (await prisma.stockAnalysis.findFirst({
          where: { stockId },
          orderBy: { analyzedAt: "desc" },
        }))
      : await prisma.stockAnalysis.findFirst({
          where: { stockId },
          orderBy: { analyzedAt: "desc" },
        })

    if (!portfolioStock) {
      return NextResponse.json(
        { error: "この銘柄はポートフォリオに登録されていません" },
        { status: 404 }
      )
    }

    // リアルタイム株価を取得
    let currentPrice: number | null = null
    if (portfolioStock.stock?.tickerCode) {
      const { prices } = await fetchStockPrices([portfolioStock.stock.tickerCode])
      currentPrice = prices[0]?.currentPrice ?? null
    }

    // 買値（平均取得単価）を計算
    let totalBuyCost = 0
    let totalBuyQuantity = 0
    for (const tx of portfolioStock.transactions) {
      if (tx.type === "buy") {
        totalBuyCost += Number(tx.totalAmount)
        totalBuyQuantity += tx.quantity
      }
    }
    const averagePurchasePrice = totalBuyQuantity > 0 ? totalBuyCost / totalBuyQuantity : null

    // 日本時間で今日の00:00:00を取得
    const todayJST = dayjs().tz("Asia/Tokyo").startOf("day")

    // 個別設定を優先、なければユーザー設定をフォールバック
    const targetReturnRate = portfolioStock.takeProfitRate != null
      ? Number(portfolioStock.takeProfitRate)
      : userSettings?.targetReturnRate ?? null
    const stopLossRate = portfolioStock.stopLossRate != null
      ? Number(portfolioStock.stopLossRate)
      : userSettings?.stopLossRate ?? null

    let userTargetPrice: number | null = null
    let userStopLossPrice: number | null = null

    if (averagePurchasePrice) {
      if (targetReturnRate !== null) {
        userTargetPrice = Math.round(averagePurchasePrice * (1 + targetReturnRate / 100))
      }
      if (stopLossRate !== null) {
        userStopLossPrice = Math.round(averagePurchasePrice * (1 + stopLossRate / 100))
      }
    }

    // 分析データがない場合
    if (!portfolioStock.lastAnalysis) {
      return NextResponse.json(
        {
          shortTerm: null,
          mediumTerm: null,
          longTerm: null,
          lastAnalysis: null,
          isToday: false,
          statusType: null,
          marketSignal: null,
          suggestedSellPrice: null,
          suggestedSellPercent: null,
          sellReason: null,
          sellCondition: null,
          sellTiming: null,
          sellTargetPrice: null,
          recommendation: null,
          // 損切りアラート用
          averagePurchasePrice,
          stopLossRate,
          // ユーザー設定に基づく価格
          targetReturnRate,
          userTargetPrice,
          userStopLossPrice,
          // StockAnalysis（価格帯予測）
          currentPrice,
          shortTermTrend: null,
          shortTermPriceLow: null,
          shortTermPriceHigh: null,
          shortTermText: null,
          midTermTrend: null,
          midTermPriceLow: null,
          midTermPriceHigh: null,
          midTermText: null,
          longTermTrend: null,
          longTermPriceLow: null,
          longTermPriceHigh: null,
          longTermText: null,
          advice: null,
          confidence: null,
          limitPrice: null,
          stopLossPrice: null,
          analyzedAt: null,
          // 投資スタイル別分析
          styleAnalyses: null,
        },
        { status: 200 }
      )
    }

    // lastAnalysisが日本時間で当日かどうかを判定
    const lastAnalysisJST = dayjs(portfolioStock.lastAnalysis).tz("Asia/Tokyo").startOf("day")
    const isToday = lastAnalysisJST.isSame(todayJST, "day")

    // レスポンス整形
    const response = {
      shortTerm: portfolioStock.shortTerm,
      mediumTerm: portfolioStock.mediumTerm,
      longTerm: portfolioStock.longTerm,
      lastAnalysis: portfolioStock.lastAnalysis.toISOString(),
      isToday,
      statusType: portfolioStock.statusType,
      marketSignal: portfolioStock.marketSignal,
      suggestedSellPrice: portfolioStock.suggestedSellPrice ? Number(portfolioStock.suggestedSellPrice) : null,
      suggestedSellPercent: portfolioStock.suggestedSellPercent,
      sellReason: portfolioStock.sellReason,
      sellCondition: portfolioStock.sellCondition,
      sellTiming: portfolioStock.sellTiming,
      sellTargetPrice: portfolioStock.sellTargetPrice ? Number(portfolioStock.sellTargetPrice) : null,
      recommendation: stockAnalysis?.recommendation ?? (
        // StockAnalysisがない古いデータ用フォールバック: statusTypeから導出
        portfolioStock.statusType === "warning" ? "sell" :
        portfolioStock.statusType === "good" ? "buy" :
        portfolioStock.statusType ? "hold" : null
      ),
      // 損切りアラート用
      averagePurchasePrice,
      stopLossRate,
      // ユーザー設定に基づく価格
      targetReturnRate,
      userTargetPrice,
      userStopLossPrice,
      // StockAnalysis（価格帯予測）
      currentPrice,
      shortTermTrend: stockAnalysis?.shortTermTrend ?? null,
      shortTermPriceLow: stockAnalysis?.shortTermPriceLow ? Number(stockAnalysis.shortTermPriceLow) : null,
      shortTermPriceHigh: stockAnalysis?.shortTermPriceHigh ? Number(stockAnalysis.shortTermPriceHigh) : null,
      shortTermText: stockAnalysis?.shortTermText ?? null,
      midTermTrend: stockAnalysis?.midTermTrend ?? null,
      midTermPriceLow: stockAnalysis?.midTermPriceLow ? Number(stockAnalysis.midTermPriceLow) : null,
      midTermPriceHigh: stockAnalysis?.midTermPriceHigh ? Number(stockAnalysis.midTermPriceHigh) : null,
      midTermText: stockAnalysis?.midTermText ?? null,
      longTermTrend: stockAnalysis?.longTermTrend ?? null,
      longTermPriceLow: stockAnalysis?.longTermPriceLow ? Number(stockAnalysis.longTermPriceLow) : null,
      longTermPriceHigh: stockAnalysis?.longTermPriceHigh ? Number(stockAnalysis.longTermPriceHigh) : null,
      longTermText: stockAnalysis?.longTermText ?? null,
      advice: stockAnalysis?.advice ?? portfolioStock.shortTerm ?? null,
      confidence: stockAnalysis?.confidence ?? null,
      limitPrice: stockAnalysis?.limitPrice ? Number(stockAnalysis.limitPrice) : null,
      stopLossPrice: stockAnalysis?.stopLossPrice ? Number(stockAnalysis.stopLossPrice) : null,
      analyzedAt: stockAnalysis?.analyzedAt?.toISOString() ?? null,
      // 投資スタイル別分析
      styleAnalyses: stockAnalysis?.styleAnalyses ?? null,
    }

    return NextResponse.json(response, { status: 200 })
  } catch (error) {
    console.error("Error fetching portfolio analysis:", error)
    return NextResponse.json(
      { error: "分析の取得に失敗しました" },
      { status: 500 }
    )
  }
}

/**
 * POST /api/stocks/[stockId]/portfolio-analysis
 * ポートフォリオ銘柄の売買分析をオンデマンドで生成
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ stockId: string }> }
) {
  const session = await auth()
  const authResult = verifyCronOrSession(request, session)

  // 認証失敗の場合はエラーレスポンスを返す
  if (authResult instanceof NextResponse) {
    return authResult
  }

  const { stockId } = await params

  // CRON経由の場合はリクエストボディからuserIdを取得
  let userId: string
  if (authResult.isCron) {
    const body = await request.json()
    if (!body.userId) {
      return NextResponse.json({ error: "userId is required for CRON requests" }, { status: 400 })
    }
    userId = body.userId
  } else {
    userId = authResult.userId!
  }

  try {
    const result = await executePortfolioAnalysis(userId, stockId)
    return NextResponse.json(result)
  } catch (error) {
    if (error instanceof AnalysisError) {
      const statusMap: Record<string, number> = {
        NOT_FOUND: 404,
        STALE_DATA: 400,
        NO_PRICE_DATA: 400,
        INTERNAL: 500,
      }
      return NextResponse.json(
        { error: error.message, code: error.code },
        { status: statusMap[error.code] || 500 }
      )
    }
    console.error("Error generating portfolio analysis:", error)
    return NextResponse.json(
      { error: "分析の生成に失敗しました" },
      { status: 500 }
    )
  }
}
