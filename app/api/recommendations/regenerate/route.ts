import { NextResponse } from "next/server"
import { auth } from "@/auth"
import { prisma } from "@/lib/prisma"
import { getTodayForDB } from "@/lib/date-utils"

/**
 * POST /api/recommendations/regenerate
 * ログインユーザーのおすすめ銘柄を再生成する
 * 内部で generate-daily を呼び出し、結果を返す
 */
export async function POST() {
  try {
    const session = await auth()
    const userId = session?.user?.id

    if (!userId) {
      return NextResponse.json(
        { error: "認証が必要です" },
        { status: 401 }
      )
    }

    const cronSecret = process.env.CRON_SECRET
    if (!cronSecret) {
      console.error("CRON_SECRET is not set")
      return NextResponse.json(
        { error: "Server configuration error" },
        { status: 500 }
      )
    }

    const baseUrl = process.env.NEXTAUTH_URL || "http://localhost:3000"

    // 今日の既存おすすめを削除（再生成で件数が減った場合に古いデータが残らないようにする）
    await prisma.userDailyRecommendation.deleteMany({
      where: { userId, date: getTodayForDB() },
    })

    // generate-daily を単一ユーザーで呼び出し
    const response = await fetch(
      `${baseUrl}/api/recommendations/generate-daily`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${cronSecret}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ userId }),
      }
    )

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}))
      console.error("generate-daily failed:", response.status, errorData)
      return NextResponse.json(
        { error: "おすすめの再生成に失敗しました" },
        { status: 500 }
      )
    }

    const result = await response.json()
    return NextResponse.json({
      success: true,
      message: "おすすめを再生成しました",
      ...result,
    })
  } catch (error) {
    console.error("Error in regenerate:", error)
    return NextResponse.json(
      { error: "おすすめの再生成に失敗しました" },
      { status: 500 }
    )
  }
}
