import { NextRequest, NextResponse } from "next/server"
import { prisma } from "@/lib/prisma"
import { getDaysAgoForDB } from "@/lib/date-utils"

/**
 * 成功基準の判定
 */
function isSuccess(prediction: string, returnValue: number | null): boolean | null {
  if (returnValue === null) return null

  switch (prediction) {
    case "buy":
      return returnValue > 0
    case "stay":
      return returnValue <= 2
    case "remove":
      return returnValue < 0
    case "up":
      return returnValue > 0
    case "down":
      return returnValue < 0
    case "neutral":
      return returnValue >= -3 && returnValue <= 3
    default:
      return null
  }
}

/**
 * 信頼度のバケットを判定
 */
function getConfidenceBucket(confidence: number | null): string {
  if (confidence === null) return "unknown"
  if (confidence < 0.3) return "低 (0-0.3)"
  if (confidence < 0.6) return "中 (0.3-0.6)"
  return "高 (0.6-1.0)"
}

/**
 * GET /api/reports/recommendation-outcomes/analysis
 * 条件別分析データの取得
 */
export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url)
  const days = parseInt(searchParams.get("days") || "30")

  try {
    const sinceDate = getDaysAgoForDB(days)

    // 7日後リターンが評価済みのOutcomeを取得
    const outcomes = await prisma.recommendationOutcome.findMany({
      where: {
        recommendedAt: { gte: sinceDate },
        returnAfter7Days: { not: null },
      },
      select: {
        type: true,
        sector: true,
        prediction: true,
        confidence: true,
        volatility: true,
        marketCap: true,
        returnAfter1Day: true,
        returnAfter3Days: true,
        returnAfter7Days: true,
        returnAfter14Days: true,
        benchmarkReturn7Days: true,
        sectorTrendDirection: true,
        recommendedAt: true,
      },
    })

    if (outcomes.length === 0) {
      return NextResponse.json({
        byConfidence: [],
        bySector: [],
        bySectorTrend: [],
        byPrediction: [],
        byTimeHorizon: [],
        benchmark: [],
        byMarketCondition: [],
        byStockCharacteristics: { byMarketCap: [], byVolatility: [] },
        cumulativeReturn: [],
        message: "評価済みのデータがまだありません",
      })
    }

    // 信頼度別分析
    const confidenceBuckets: Record<string, { count: number; successes: number; totalReturn: number }> = {}

    for (const o of outcomes) {
      const bucket = getConfidenceBucket(o.confidence ? Number(o.confidence) : null)
      if (!confidenceBuckets[bucket]) {
        confidenceBuckets[bucket] = { count: 0, successes: 0, totalReturn: 0 }
      }

      const ret7 = Number(o.returnAfter7Days)
      confidenceBuckets[bucket].count++
      confidenceBuckets[bucket].totalReturn += ret7

      if (isSuccess(o.prediction, ret7)) {
        confidenceBuckets[bucket].successes++
      }
    }

    const byConfidence = Object.entries(confidenceBuckets).map(([bucket, data]) => ({
      bucket,
      count: data.count,
      successRate: Math.round((data.successes / data.count) * 100),
      avgReturn: Math.round((data.totalReturn / data.count) * 100) / 100,
    }))

    // セクター別分析
    const sectorGroups: Record<string, {
      count: number
      successes: number
      totalReturn: number
      totalBenchmark: number
      benchmarkCount: number
    }> = {}

    for (const o of outcomes) {
      const sector = o.sector || "その他"
      if (!sectorGroups[sector]) {
        sectorGroups[sector] = { count: 0, successes: 0, totalReturn: 0, totalBenchmark: 0, benchmarkCount: 0 }
      }

      const ret7 = Number(o.returnAfter7Days)
      sectorGroups[sector].count++
      sectorGroups[sector].totalReturn += ret7

      if (isSuccess(o.prediction, ret7)) {
        sectorGroups[sector].successes++
      }

      if (o.benchmarkReturn7Days !== null) {
        sectorGroups[sector].totalBenchmark += Number(o.benchmarkReturn7Days)
        sectorGroups[sector].benchmarkCount++
      }
    }

    const bySector = Object.entries(sectorGroups)
      .map(([sector, data]) => ({
        sector,
        count: data.count,
        successRate: Math.round((data.successes / data.count) * 100),
        avgReturn: Math.round((data.totalReturn / data.count) * 100) / 100,
        excessReturn: data.benchmarkCount > 0
          ? Math.round(((data.totalReturn / data.count) - (data.totalBenchmark / data.benchmarkCount)) * 100) / 100
          : null,
      }))
      .sort((a, b) => b.count - a.count)

    // セクタートレンド別分析
    const sectorTrendGroups: Record<string, { count: number; successes: number; totalReturn: number }> = {}

    for (const o of outcomes) {
      const direction = o.sectorTrendDirection || "unknown"
      if (!sectorTrendGroups[direction]) {
        sectorTrendGroups[direction] = { count: 0, successes: 0, totalReturn: 0 }
      }

      const ret7 = Number(o.returnAfter7Days)
      sectorTrendGroups[direction].count++
      sectorTrendGroups[direction].totalReturn += ret7

      if (isSuccess(o.prediction, ret7)) {
        sectorTrendGroups[direction].successes++
      }
    }

    const directionLabels: Record<string, string> = { up: "追い風", down: "逆風", neutral: "中立", unknown: "不明" }
    const bySectorTrend = Object.entries(sectorTrendGroups).map(([direction, data]) => ({
      direction,
      label: directionLabels[direction] || direction,
      count: data.count,
      successRate: Math.round((data.successes / data.count) * 100),
      avgReturn: Math.round((data.totalReturn / data.count) * 100) / 100,
    }))

    // 予測種類別分析
    const predictionGroups: Record<string, { count: number; successes: number; totalReturn: number }> = {}

    for (const o of outcomes) {
      const pred = o.prediction
      if (!predictionGroups[pred]) {
        predictionGroups[pred] = { count: 0, successes: 0, totalReturn: 0 }
      }

      const ret7 = Number(o.returnAfter7Days)
      predictionGroups[pred].count++
      predictionGroups[pred].totalReturn += ret7

      if (isSuccess(pred, ret7)) {
        predictionGroups[pred].successes++
      }
    }

    const byPrediction = Object.entries(predictionGroups).map(([prediction, data]) => ({
      prediction,
      count: data.count,
      successRate: Math.round((data.successes / data.count) * 100),
      avgReturn: Math.round((data.totalReturn / data.count) * 100) / 100,
    }))

    // 時間枠別分析
    const timeHorizons = [
      { horizon: "1日後", field: "returnAfter1Day" },
      { horizon: "3日後", field: "returnAfter3Days" },
      { horizon: "7日後", field: "returnAfter7Days" },
      { horizon: "14日後", field: "returnAfter14Days" },
    ]

    const byTimeHorizon = timeHorizons.map(({ horizon, field }) => {
      const validOutcomes = outcomes.filter(o => (o as Record<string, unknown>)[field] !== null)
      if (validOutcomes.length === 0) {
        return { horizon, count: 0, successRate: null, avgReturn: null }
      }

      let successes = 0
      let totalReturn = 0

      for (const o of validOutcomes) {
        const ret = Number((o as Record<string, unknown>)[field])
        totalReturn += ret

        if (isSuccess(o.prediction, ret)) {
          successes++
        }
      }

      return {
        horizon,
        count: validOutcomes.length,
        successRate: Math.round((successes / validOutcomes.length) * 100),
        avgReturn: Math.round((totalReturn / validOutcomes.length) * 100) / 100,
      }
    })

    // ベンチマーク比較（期間別）
    const periods = [
      { period: "直近1週間", daysBack: 7 },
      { period: "直近2週間", daysBack: 14 },
      { period: "直近4週間", daysBack: 28 },
    ]

    const now = new Date()
    const benchmark = periods.map(({ period, daysBack }) => {
      const periodStart = new Date(now.getTime() - daysBack * 24 * 60 * 60 * 1000)
      const periodOutcomes = outcomes.filter(o => {
        // このレコードのrecommendedAtは取得できないのでreturnAfter7Daysがnullでないものを使う
        return o.benchmarkReturn7Days !== null
      })

      if (periodOutcomes.length === 0) {
        return { period, aiReturn: null, benchmarkReturn: null, excess: null }
      }

      let aiTotalReturn = 0
      let benchmarkTotalReturn = 0

      for (const o of periodOutcomes) {
        aiTotalReturn += Number(o.returnAfter7Days)
        benchmarkTotalReturn += Number(o.benchmarkReturn7Days)
      }

      const aiAvg = aiTotalReturn / periodOutcomes.length
      const benchmarkAvg = benchmarkTotalReturn / periodOutcomes.length

      return {
        period,
        aiReturn: Math.round(aiAvg * 100) / 100,
        benchmarkReturn: Math.round(benchmarkAvg * 100) / 100,
        excess: Math.round((aiAvg - benchmarkAvg) * 100) / 100,
      }
    })

    // 市況別分析（benchmarkReturn7Daysで市況を分類）
    const marketConditionGroups: Record<string, { count: number; successes: number; totalReturn: number }> = {
      bullish: { count: 0, successes: 0, totalReturn: 0 },
      neutral: { count: 0, successes: 0, totalReturn: 0 },
      bearish: { count: 0, successes: 0, totalReturn: 0 },
    }

    for (const o of outcomes) {
      if (o.benchmarkReturn7Days === null) continue
      const bm = Number(o.benchmarkReturn7Days)
      const condition = bm > 2 ? "bullish" : bm < -2 ? "bearish" : "neutral"
      const ret7 = Number(o.returnAfter7Days)

      marketConditionGroups[condition].count++
      marketConditionGroups[condition].totalReturn += ret7
      if (isSuccess(o.prediction, ret7)) {
        marketConditionGroups[condition].successes++
      }
    }

    const conditionLabels: Record<string, string> = {
      bullish: "強気相場（日経+2%以上）",
      neutral: "中立相場",
      bearish: "弱気相場（日経-2%以下）",
    }

    const byMarketCondition = (["bullish", "neutral", "bearish"] as const).map((condition) => {
      const data = marketConditionGroups[condition]
      return {
        condition,
        label: conditionLabels[condition],
        count: data.count,
        successRate: data.count > 0 ? Math.round((data.successes / data.count) * 100) : 0,
        avgReturn: data.count > 0 ? Math.round((data.totalReturn / data.count) * 100) / 100 : 0,
      }
    }).filter(d => d.count > 0)

    // 銘柄特性別分析
    const marketCapGroups: Record<string, { count: number; successes: number; totalReturn: number }> = {
      large: { count: 0, successes: 0, totalReturn: 0 },
      mid: { count: 0, successes: 0, totalReturn: 0 },
      small: { count: 0, successes: 0, totalReturn: 0 },
      unknown: { count: 0, successes: 0, totalReturn: 0 },
    }

    const volatilityGroups: Record<string, { count: number; successes: number; totalReturn: number }> = {
      low: { count: 0, successes: 0, totalReturn: 0 },
      mid: { count: 0, successes: 0, totalReturn: 0 },
      high: { count: 0, successes: 0, totalReturn: 0 },
    }

    for (const o of outcomes) {
      const ret7 = Number(o.returnAfter7Days)
      const success = isSuccess(o.prediction, ret7)

      // 時価総額区分（円単位: 大型>5000億, 中型500億-5000億, 小型<500億）
      const mcapKey = o.marketCap === null
        ? "unknown"
        : Number(o.marketCap) > 500_000_000_000
          ? "large"
          : Number(o.marketCap) > 50_000_000_000
            ? "mid"
            : "small"

      marketCapGroups[mcapKey].count++
      marketCapGroups[mcapKey].totalReturn += ret7
      if (success) marketCapGroups[mcapKey].successes++

      // ボラティリティ区分
      if (o.volatility !== null) {
        const vol = Number(o.volatility)
        const volKey = vol < 20 ? "low" : vol <= 40 ? "mid" : "high"
        volatilityGroups[volKey].count++
        volatilityGroups[volKey].totalReturn += ret7
        if (success) volatilityGroups[volKey].successes++
      }
    }

    const marketCapLabels: Record<string, string> = {
      large: "大型株（5000億円超）",
      mid: "中型株（500億〜5000億）",
      small: "小型株（500億未満）",
      unknown: "不明",
    }
    const volatilityLabels: Record<string, string> = {
      low: "低ボラ（<20%）",
      mid: "中ボラ（20-40%）",
      high: "高ボラ（>40%）",
    }

    const byStockCharacteristics = {
      byMarketCap: (["large", "mid", "small", "unknown"] as const)
        .map((category) => {
          const data = marketCapGroups[category]
          return {
            category,
            label: marketCapLabels[category],
            count: data.count,
            successRate: data.count > 0 ? Math.round((data.successes / data.count) * 100) : 0,
            avgReturn: data.count > 0 ? Math.round((data.totalReturn / data.count) * 100) / 100 : 0,
          }
        })
        .filter(d => d.count > 0),
      byVolatility: (["low", "mid", "high"] as const)
        .map((category) => {
          const data = volatilityGroups[category]
          return {
            category,
            label: volatilityLabels[category],
            count: data.count,
            successRate: data.count > 0 ? Math.round((data.successes / data.count) * 100) : 0,
            avgReturn: data.count > 0 ? Math.round((data.totalReturn / data.count) * 100) / 100 : 0,
          }
        })
        .filter(d => d.count > 0),
    }

    // 累積リターンシミュレーション（prediction="buy" の週次平均リターン）
    const buyOutcomes = outcomes
      .filter(o => o.prediction === "buy" && o.returnAfter7Days !== null)
      .sort((a, b) => a.recommendedAt.getTime() - b.recommendedAt.getTime())

    const weeklyBuckets: Record<string, { aiReturns: number[]; benchmarkReturns: number[]; weekStart: Date }> = {}

    for (const o of buyOutcomes) {
      const d = o.recommendedAt
      // 週の開始日（月曜日）を計算
      const dayOfWeek = d.getDay()
      const daysToMonday = dayOfWeek === 0 ? 6 : dayOfWeek - 1
      const monday = new Date(d.getTime() - daysToMonday * 24 * 60 * 60 * 1000)
      monday.setHours(0, 0, 0, 0)
      const key = monday.toISOString().slice(0, 10)

      if (!weeklyBuckets[key]) {
        weeklyBuckets[key] = { aiReturns: [], benchmarkReturns: [], weekStart: monday }
      }

      weeklyBuckets[key].aiReturns.push(Number(o.returnAfter7Days))
      if (o.benchmarkReturn7Days !== null) {
        weeklyBuckets[key].benchmarkReturns.push(Number(o.benchmarkReturn7Days))
      }
    }

    let cumAI = 100
    let cumNikkei = 100

    const cumulativeReturn = Object.keys(weeklyBuckets)
      .sort()
      .map((key) => {
        const bucket = weeklyBuckets[key]
        const weeklyAI = bucket.aiReturns.reduce((sum, r) => sum + r, 0) / bucket.aiReturns.length
        const weeklyNikkei = bucket.benchmarkReturns.length > 0
          ? bucket.benchmarkReturns.reduce((sum, r) => sum + r, 0) / bucket.benchmarkReturns.length
          : null

        cumAI = cumAI * (1 + weeklyAI / 100)
        if (weeklyNikkei !== null) {
          cumNikkei = cumNikkei * (1 + weeklyNikkei / 100)
        }

        const weekEnd = new Date(bucket.weekStart.getTime() + 6 * 24 * 60 * 60 * 1000)
        const fmt = (d: Date) => `${d.getMonth() + 1}/${d.getDate()}`

        return {
          weekLabel: `${fmt(bucket.weekStart)}〜${fmt(weekEnd)}`,
          count: bucket.aiReturns.length,
          weeklyAI: Math.round(weeklyAI * 100) / 100,
          weeklyNikkei: weeklyNikkei !== null ? Math.round(weeklyNikkei * 100) / 100 : null,
          cumAI: Math.round(cumAI * 100) / 100,
          cumNikkei: Math.round(cumNikkei * 100) / 100,
        }
      })

    return NextResponse.json({
      byConfidence,
      bySector,
      bySectorTrend,
      byPrediction,
      byTimeHorizon,
      benchmark,
      byMarketCondition,
      byStockCharacteristics,
      cumulativeReturn,
    })
  } catch (error) {
    console.error("Error fetching recommendation outcome analysis:", error)
    return NextResponse.json(
      { error: "分析データの取得に失敗しました" },
      { status: 500 }
    )
  }
}
