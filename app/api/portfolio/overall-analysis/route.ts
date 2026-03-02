import { NextRequest, NextResponse } from "next/server"
import { auth } from "@/auth"
import { verifyCronOrSession } from "@/lib/cron-auth"
import {
  getPortfolioOverallAnalysis,
  generatePortfolioOverallAnalysis,
} from "@/lib/portfolio-overall-analysis"
import type { NavigatorSession } from "@/lib/portfolio-overall-analysis"

/**
 * GET /api/portfolio/overall-analysis
 * ポートフォリオ総評分析を取得
 */
export async function GET(request: NextRequest) {
  try {
    const session = await auth()

    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }

    const requestedSession = request.nextUrl.searchParams.get("session") as NavigatorSession | null
    const result = await getPortfolioOverallAnalysis(session.user.id, requestedSession ?? undefined)
    return NextResponse.json(result)
  } catch (error) {
    console.error("Error fetching portfolio overall analysis:", error)
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    )
  }
}

/**
 * POST /api/portfolio/overall-analysis
 * ポートフォリオ総評分析をオンデマンドで生成
 */
export async function POST(request: NextRequest) {
  try {
    const session = await auth()
    const authResult = verifyCronOrSession(request, session)

    // 認証失敗の場合はエラーレスポンスを返す
    if (authResult instanceof NextResponse) {
      return authResult
    }

    // CRON経由の場合はリクエストボディからuserIdを取得
    let userId: string
    let navigatorSession: NavigatorSession = "morning"
    if (authResult.isCron) {
      const body = await request.json()
      if (!body.userId) {
        return NextResponse.json({ error: "userId is required for CRON requests" }, { status: 400 })
      }
      userId = body.userId
      if (body.session === "morning" || body.session === "pre-afternoon" || body.session === "evening") {
        navigatorSession = body.session
      }
    } else {
      userId = authResult.userId!
    }

    const result = await generatePortfolioOverallAnalysis(userId, navigatorSession)
    return NextResponse.json(result)
  } catch (error) {
    console.error("Error generating portfolio overall analysis:", error)
    const message = error instanceof Error ? error.message : String(error)
    const stack = error instanceof Error ? error.stack : undefined
    return NextResponse.json(
      { error: "Internal server error", detail: message, stack },
      { status: 500 }
    )
  }
}
