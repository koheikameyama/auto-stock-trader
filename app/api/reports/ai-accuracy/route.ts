import { NextRequest, NextResponse } from "next/server"
import { auth } from "@/auth"
import { prisma } from "@/lib/prisma"

/**
 * GET /api/reports/ai-accuracy
 * AI精度レポートを取得（直近N日分）
 * クエリパラメータ:
 * - limit: 取得する日数（デフォルト: 30）
 */
export async function GET(request: NextRequest) {
  try {
    const session = await auth()
    if (!session?.user?.id) {
      return NextResponse.json({ error: "認証が必要です" }, { status: 401 })
    }

    const { searchParams } = new URL(request.url)
    const limit = Math.min(parseInt(searchParams.get("limit") || "30"), 90)

    const reports = await prisma.dailyAIReport.findMany({
      orderBy: { date: "desc" },
      take: limit,
    })

    // 最新のレポートを取得
    const latest = reports[0] || null

    // グラフ用に日付順でソート（古い順）
    const chartData = [...reports].reverse().map((r) => ({
      date: r.date,
      daily: {
        count: r.dailyRecommendationCount,
        avgReturn: r.dailyRecommendationAvgReturn
          ? Number(r.dailyRecommendationAvgReturn)
          : null,
        successRate: r.dailyRecommendationSuccessRate
          ? Number(r.dailyRecommendationSuccessRate)
          : null,
      },
      purchase: {
        count: r.purchaseRecommendationCount,
        avgReturn: r.purchaseRecommendationAvgReturn
          ? Number(r.purchaseRecommendationAvgReturn)
          : null,
        successRate: r.purchaseRecommendationSuccessRate
          ? Number(r.purchaseRecommendationSuccessRate)
          : null,
      },
      analysis: {
        count: r.stockAnalysisCount,
        avgReturn: r.stockAnalysisAvgReturn
          ? Number(r.stockAnalysisAvgReturn)
          : null,
        successRate: r.stockAnalysisSuccessRate
          ? Number(r.stockAnalysisSuccessRate)
          : null,
      },
    }))

    // レスポンス
    return NextResponse.json({
      latest: latest
        ? {
            date: latest.date,
            daily: {
              count: latest.dailyRecommendationCount,
              avgReturn: latest.dailyRecommendationAvgReturn
                ? Number(latest.dailyRecommendationAvgReturn)
                : null,
              plusRate: latest.dailyRecommendationPlusRate
                ? Number(latest.dailyRecommendationPlusRate)
                : null,
              successRate: latest.dailyRecommendationSuccessRate
                ? Number(latest.dailyRecommendationSuccessRate)
                : null,
            },
            purchase: {
              count: latest.purchaseRecommendationCount,
              avgReturn: latest.purchaseRecommendationAvgReturn
                ? Number(latest.purchaseRecommendationAvgReturn)
                : null,
              plusRate: latest.purchaseRecommendationPlusRate
                ? Number(latest.purchaseRecommendationPlusRate)
                : null,
              successRate: latest.purchaseRecommendationSuccessRate
                ? Number(latest.purchaseRecommendationSuccessRate)
                : null,
            },
            analysis: {
              count: latest.stockAnalysisCount,
              avgReturn: latest.stockAnalysisAvgReturn
                ? Number(latest.stockAnalysisAvgReturn)
                : null,
              plusRate: latest.stockAnalysisPlusRate
                ? Number(latest.stockAnalysisPlusRate)
                : null,
              successRate: latest.stockAnalysisSuccessRate
                ? Number(latest.stockAnalysisSuccessRate)
                : null,
            },
            details: latest.details,
          }
        : null,
      chartData,
      totalDays: reports.length,
    })
  } catch (error) {
    console.error("Error fetching AI accuracy report:", error)
    return NextResponse.json(
      { error: "AI精度レポートの取得に失敗しました" },
      { status: 500 }
    )
  }
}
