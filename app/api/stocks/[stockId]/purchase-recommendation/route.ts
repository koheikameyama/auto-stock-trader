import { NextRequest, NextResponse } from "next/server"
import { prisma } from "@/lib/prisma"
import { auth } from "@/auth"
import { verifyCronOrSession } from "@/lib/cron-auth"
import { fetchStockPrices } from "@/lib/stock-price-fetcher"
import { getDaysAgoForDB } from "@/lib/date-utils"
import {
  executePurchaseRecommendation,
} from "@/lib/purchase-recommendation-core"
import { AnalysisError } from "@/lib/portfolio-analysis-core"

/**
 * GET /api/stocks/[stockId]/purchase-recommendation
 * 指定された銘柄の最新の購入判断を取得
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ stockId: string }> }
) {
  const { stockId } = await params

  try {
    // 銘柄情報を取得
    const stock = await prisma.stock.findUnique({
      where: { id: stockId },
      select: {
        id: true,
        tickerCode: true,
        name: true,
      },
    })

    if (!stock) {
      return NextResponse.json(
        { error: "銘柄が見つかりません" },
        { status: 404 }
      )
    }

    // セッションからユーザーの投資スタイルを取得
    const session = await auth()
    let userStyle = "BALANCED"
    if (session?.user?.id) {
      const userSettings = await prisma.userSettings.findUnique({
        where: { userId: session.user.id },
        select: { investmentStyle: true },
      })
      if (userSettings?.investmentStyle) {
        userStyle = userSettings.investmentStyle
      }
    }

    // 最新の購入判断を取得（過去7日以内）
    const sevenDaysAgo = getDaysAgoForDB(7)

    const recommendation = await prisma.purchaseRecommendation.findFirst({
      where: {
        stockId,
        date: { gte: sevenDaysAgo },
      },
      orderBy: { date: "desc" },
    })

    if (!recommendation) {
      return NextResponse.json(
        { error: "購入判断データがまだ生成されていません" },
        { status: 404 }
      )
    }

    // StockAnalysis: PurchaseRecommendation.updatedAtと同時刻のエントリーを取得（ポートフォリオ分析の結果が混入しないようにする）
    const analysis =
      (await prisma.stockAnalysis.findFirst({
        where: { stockId, analyzedAt: recommendation.updatedAt },
      })) ??
      (await prisma.stockAnalysis.findFirst({
        where: { stockId },
        orderBy: { analyzedAt: "desc" },
      }))

    // リアルタイム株価を取得
    const { prices: realtimePrices } = await fetchStockPrices([stock.tickerCode])
    const currentPrice = realtimePrices[0]?.currentPrice ?? null

    // ユーザーの投資スタイルに合った結果をstyleAnalysesから取得
    const styleAnalyses = recommendation.styleAnalyses as Record<string, Record<string, unknown>> | null
    const styleData = styleAnalyses?.[userStyle] as Record<string, unknown> | undefined

    // レスポンス整形（styleDataがあればユーザースタイルの結果でオーバーライド）
    const response = {
      stockId: stock.id,
      stockName: stock.name,
      tickerCode: stock.tickerCode,
      currentPrice,
      marketSignal: recommendation.marketSignal,
      recommendation: (styleData?.recommendation as string) ?? recommendation.recommendation,
      confidence: (styleData?.confidence as number) ?? recommendation.confidence,
      reason: (styleData?.reason as string) ?? recommendation.reason,
      caution: (styleData?.caution as string) ?? recommendation.caution,
      // B. 深掘り評価
      positives: recommendation.positives,
      concerns: recommendation.concerns,
      suitableFor: recommendation.suitableFor,
      // C. 買い時条件
      buyCondition: (styleData?.buyCondition as string | null) ?? recommendation.buyCondition,
      buyTiming: (styleData?.buyTiming as string | null) ?? recommendation.buyTiming,
      dipTargetPrice: styleData?.dipTargetPrice != null
        ? Number(styleData.dipTargetPrice)
        : recommendation.dipTargetPrice ? Number(recommendation.dipTargetPrice) : null,
      sellTiming: (styleData?.sellTiming as string | null) ?? recommendation.sellTiming,
      sellTargetPrice: styleData?.sellTargetPrice != null
        ? Number(styleData.sellTargetPrice)
        : recommendation.sellTargetPrice ? Number(recommendation.sellTargetPrice) : null,
      // D. パーソナライズ
      userFitScore: recommendation.userFitScore,
      budgetFit: recommendation.budgetFit,
      periodFit: recommendation.periodFit,
      riskFit: recommendation.riskFit,
      personalizedReason: recommendation.personalizedReason,
      analyzedAt: recommendation.updatedAt.toISOString(),
      // 価格帯予測（StockAnalysisから）
      shortTermTrend: analysis?.shortTermTrend ?? null,
      shortTermPriceLow: analysis?.shortTermPriceLow ? Number(analysis.shortTermPriceLow) : null,
      shortTermPriceHigh: analysis?.shortTermPriceHigh ? Number(analysis.shortTermPriceHigh) : null,
      shortTermText: analysis?.shortTermText ?? null,
      midTermTrend: analysis?.midTermTrend ?? null,
      midTermPriceLow: analysis?.midTermPriceLow ? Number(analysis.midTermPriceLow) : null,
      midTermPriceHigh: analysis?.midTermPriceHigh ? Number(analysis.midTermPriceHigh) : null,
      midTermText: analysis?.midTermText ?? null,
      longTermTrend: analysis?.longTermTrend ?? null,
      longTermPriceLow: analysis?.longTermPriceLow ? Number(analysis.longTermPriceLow) : null,
      longTermPriceHigh: analysis?.longTermPriceHigh ? Number(analysis.longTermPriceHigh) : null,
      longTermText: analysis?.longTermText ?? null,
      advice: (styleData?.advice as string | null) ?? analysis?.advice ?? null,
      // AI推奨価格（StockAnalysisから）
      limitPrice: analysis?.limitPrice ? Number(analysis.limitPrice) : null,
      stopLossPrice: analysis?.stopLossPrice ? Number(analysis.stopLossPrice) : null,
      // 投資スタイル別分析
      styleAnalyses: styleAnalyses ?? (analysis?.styleAnalyses as Record<string, unknown> | null) ?? null,
    }

    return NextResponse.json(response, { status: 200 })
  } catch (error) {
    console.error("Error fetching purchase recommendation:", error)
    return NextResponse.json(
      { error: "購入判断の取得に失敗しました" },
      { status: 500 }
    )
  }
}

/**
 * POST /api/stocks/[stockId]/purchase-recommendation
 * 銘柄の購入判断をオンデマンドで生成
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

  const { userId } = authResult
  const { stockId } = await params

  try {
    const result = await executePurchaseRecommendation(userId, stockId)
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
    console.error("Error generating purchase recommendation:", error)
    return NextResponse.json(
      { error: "購入判断の生成に失敗しました" },
      { status: 500 }
    )
  }
}
