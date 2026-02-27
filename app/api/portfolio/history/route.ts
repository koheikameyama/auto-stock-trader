import { getAuthUser } from "@/lib/auth-utils"
import { NextResponse } from "next/server"
import { prisma } from "@/lib/prisma"
import { getDaysAgoForDB } from "@/lib/date-utils"

const PERIOD_DAYS: Record<string, number> = {
  "1m": 30,
  "3m": 90,
  "6m": 180,
  "1y": 365,
}

export async function GET(request: Request) {
  const { user, error } = await getAuthUser()
  if (error) return error

  try {
    const { searchParams } = new URL(request.url)
    const period = searchParams.get("period") || "1m"
    const days = PERIOD_DAYS[period] || 30

    const startDate = getDaysAgoForDB(days)

    const snapshots = await prisma.portfolioSnapshot.findMany({
      where: {
        userId: user.id,
        date: { gte: startDate },
      },
      orderBy: { date: "asc" },
      select: {
        date: true,
        totalValue: true,
        totalCost: true,
        unrealizedGain: true,
        unrealizedGainPercent: true,
        stockCount: true,
        nikkeiClose: true,
      },
    })

    const history = snapshots.map((s) => ({
      date: s.date.toISOString().split("T")[0],
      totalValue: Number(s.totalValue),
      totalCost: Number(s.totalCost),
      unrealizedGain: Number(s.unrealizedGain),
      unrealizedGainPercent: Number(s.unrealizedGainPercent),
      stockCount: s.stockCount,
      nikkeiClose: s.nikkeiClose ? Number(s.nikkeiClose) : null,
    }))

    return NextResponse.json({
      history,
      period,
    })
  } catch (error) {
    console.error("Error fetching portfolio history:", error)
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    )
  }
}
