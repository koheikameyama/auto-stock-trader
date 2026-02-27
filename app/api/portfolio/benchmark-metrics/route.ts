import { getAuthUser } from "@/lib/auth-utils"
import { NextResponse } from "next/server"
import { prisma } from "@/lib/prisma"
import { getDaysAgoForDB } from "@/lib/date-utils"
import { BENCHMARK_METRICS } from "@/lib/constants"

export async function GET(request: Request) {
  const { user, error } = await getAuthUser()
  if (error) return error

  try {
    const { searchParams } = new URL(request.url)
    const period = searchParams.get("period") || "3m"
    const days: Record<string, number> = { "1m": 30, "3m": 90, "6m": 180, "1y": 365 }
    const periodDays = days[period] || 90

    const startDate = getDaysAgoForDB(periodDays)

    const snapshots = await prisma.portfolioSnapshot.findMany({
      where: {
        userId: user.id,
        date: { gte: startDate },
        nikkeiClose: { not: null },
      },
      orderBy: { date: "asc" },
      select: {
        date: true,
        totalValue: true,
        nikkeiClose: true,
      },
    })

    // データ不足チェック
    if (snapshots.length < BENCHMARK_METRICS.MIN_DATA_POINTS) {
      return NextResponse.json({
        hasMetrics: false,
        reason: "insufficient_data",
        dataPoints: snapshots.length,
        required: BENCHMARK_METRICS.MIN_DATA_POINTS,
      })
    }

    // 日次リターン率を計算
    const portfolioReturns: number[] = []
    const nikkeiReturns: number[] = []

    for (let i = 1; i < snapshots.length; i++) {
      const prevValue = Number(snapshots[i - 1].totalValue)
      const currValue = Number(snapshots[i].totalValue)
      const prevNikkei = Number(snapshots[i - 1].nikkeiClose)
      const currNikkei = Number(snapshots[i].nikkeiClose)

      if (prevValue > 0 && prevNikkei > 0) {
        portfolioReturns.push((currValue - prevValue) / prevValue)
        nikkeiReturns.push((currNikkei - prevNikkei) / prevNikkei)
      }
    }

    if (portfolioReturns.length === 0) {
      return NextResponse.json({ hasMetrics: false, reason: "no_returns" })
    }

    // 期間リターン（累積）
    const firstValue = Number(snapshots[0].totalValue)
    const lastValue = Number(snapshots[snapshots.length - 1].totalValue)
    const firstNikkei = Number(snapshots[0].nikkeiClose)
    const lastNikkei = Number(snapshots[snapshots.length - 1].nikkeiClose)

    const portfolioReturn = firstValue > 0
      ? ((lastValue - firstValue) / firstValue) * 100
      : 0
    const nikkeiReturn = firstNikkei > 0
      ? ((lastNikkei - firstNikkei) / firstNikkei) * 100
      : 0
    const excessReturn = portfolioReturn - nikkeiReturn

    // ベータ値: Cov(Rp, Rm) / Var(Rm)
    const n = portfolioReturns.length
    const avgPortfolio = portfolioReturns.reduce((a, b) => a + b, 0) / n
    const avgNikkei = nikkeiReturns.reduce((a, b) => a + b, 0) / n

    let covariance = 0
    let nikkeiVariance = 0
    for (let i = 0; i < n; i++) {
      const dp = portfolioReturns[i] - avgPortfolio
      const dn = nikkeiReturns[i] - avgNikkei
      covariance += dp * dn
      nikkeiVariance += dn * dn
    }
    covariance /= n
    nikkeiVariance /= n

    const beta = nikkeiVariance > 0 ? covariance / nikkeiVariance : null

    // シャープレシオ: (Rp - Rf) / σp
    const dailyRiskFreeRate = BENCHMARK_METRICS.RISK_FREE_RATE_ANNUAL / 100 / 252
    const excessDailyReturns = portfolioReturns.map(r => r - dailyRiskFreeRate)
    const avgExcessReturn = excessDailyReturns.reduce((a, b) => a + b, 0) / n
    const portfolioStdDev = Math.sqrt(
      excessDailyReturns.reduce((sum, r) => sum + (r - avgExcessReturn) ** 2, 0) / n
    )
    const sharpeRatio = portfolioStdDev > 0
      ? (avgExcessReturn / portfolioStdDev) * Math.sqrt(252)
      : null

    return NextResponse.json({
      hasMetrics: true,
      period,
      dataPoints: snapshots.length,
      portfolioReturn: Math.round(portfolioReturn * 100) / 100,
      nikkeiReturn: Math.round(nikkeiReturn * 100) / 100,
      excessReturn: Math.round(excessReturn * 100) / 100,
      beta: beta !== null ? Math.round(beta * 100) / 100 : null,
      sharpeRatio: sharpeRatio !== null ? Math.round(sharpeRatio * 100) / 100 : null,
    })
  } catch (error) {
    console.error("Error calculating benchmark metrics:", error)
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    )
  }
}
