import { NextResponse } from "next/server"
import { getGeopoliticalNews } from "@/lib/news"
import { prisma } from "@/lib/prisma"
import { getTodayForDB } from "@/lib/date-utils"
import { assessGeopoliticalRisk } from "@/lib/stock-safety-rules"

export async function GET() {
  try {
    const news = await getGeopoliticalNews(5)

    // リスクスコア算出
    const todayForDB = getTodayForDB()
    const preMarketData = await prisma.preMarketData.findFirst({
      where: { date: todayForDB },
      select: { vixClose: true, vixChangeRate: true, wtiChangeRate: true },
    })
    const negativeCount = news.filter(
      (n: { sentiment?: string | null; impactDirection?: string | null }) =>
        n.sentiment === "negative" || n.impactDirection === "negative"
    ).length
    const riskAssessment = assessGeopoliticalRisk({
      vixClose: preMarketData?.vixClose ? Number(preMarketData.vixClose) : null,
      vixChangeRate: preMarketData?.vixChangeRate ? Number(preMarketData.vixChangeRate) : null,
      wtiChangeRate: preMarketData?.wtiChangeRate ? Number(preMarketData.wtiChangeRate) : null,
      negativeGeoNewsCount: negativeCount,
    })

    return NextResponse.json({
      news,
      riskLevel: riskAssessment.level,
      riskScore: riskAssessment.score,
      riskFactors: riskAssessment.factors,
    })
  } catch (error) {
    console.error("Failed to fetch geopolitical news:", error)
    return NextResponse.json(
      { error: "Failed to fetch geopolitical news" },
      { status: 500 }
    )
  }
}
