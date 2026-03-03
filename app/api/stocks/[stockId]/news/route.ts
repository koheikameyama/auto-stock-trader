import { NextRequest, NextResponse } from "next/server"
import { auth } from "@/auth"
import { prisma } from "@/lib/prisma"
import { getRelatedNews } from "@/lib/news-rag"

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ stockId: string }> }
) {
  try {
    const session = await auth()
    if (!session?.user?.email) {
      return NextResponse.json({ error: "認証が必要です" }, { status: 401 })
    }

    const { stockId } = await params

    const stock = await prisma.stock.findUnique({
      where: { id: stockId },
      select: {
        tickerCode: true,
        sector: true,
      },
    })

    if (!stock) {
      return NextResponse.json(
        { error: "銘柄が見つかりません" },
        { status: 404 }
      )
    }

    const tickerCode = stock.tickerCode.replace(".T", "")
    const news = await getRelatedNews({
      tickerCodes: [tickerCode],
      sectors: stock.sector ? [stock.sector] : [],
      limit: 10,
      daysAgo: 14,
    })

    return NextResponse.json({
      news: news.map((n) => ({
        id: n.id,
        title: n.title,
        url: n.url,
        source: n.source,
        sentiment: n.sentiment,
        publishedAt: n.publishedAt,
        matchType: n.matchType,
      })),
    })
  } catch (error) {
    console.error("Error fetching stock news:", error)
    return NextResponse.json(
      { error: "ニュースの取得に失敗しました" },
      { status: 500 }
    )
  }
}
