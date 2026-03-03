import { NextRequest, NextResponse } from "next/server"
import { auth } from "@/auth"
import { getNews, getNewsWithRelatedStocks, GetNewsOptions } from "@/lib/news"

export async function GET(request: NextRequest) {
  try {
    const session = await auth()
    const searchParams = request.nextUrl.searchParams
    const limit = parseInt(searchParams.get("limit") || "20", 10)
    const market = (searchParams.get("market") || "ALL") as "JP" | "US" | "ALL"
    const daysAgo = parseInt(searchParams.get("daysAgo") || "7", 10)
    const withRelated = searchParams.get("withRelated") === "true"
    const category = (searchParams.get("category") || undefined) as "impact" | "all" | undefined

    const options: GetNewsOptions = {
      limit,
      market,
      daysAgo,
      category,
    }

    let news

    if (withRelated && session?.user?.id) {
      // 保有銘柄との関連付けあり
      news = await getNewsWithRelatedStocks(session.user.id, options)
    } else {
      // 関連付けなし（全ニュース）
      news = await getNews(options)
    }

    return NextResponse.json({
      success: true,
      news,
    })
  } catch (error) {
    console.error("Failed to fetch news:", error)
    return NextResponse.json(
      { success: false, error: "Failed to fetch news" },
      { status: 500 }
    )
  }
}
