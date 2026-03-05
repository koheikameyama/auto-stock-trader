import { getAuthUser } from "@/lib/auth-utils"
import { prisma } from "@/lib/prisma"
import { NextRequest, NextResponse } from "next/server"

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { user: authUser, error } = await getAuthUser()
  if (error) return error

  const { id } = await params

  try {
    const body = await request.json()
    const action = body.action as string

    if (!["accepted", "rejected", "ignored"].includes(action)) {
      return NextResponse.json(
        { error: "Invalid action" },
        { status: 400 },
      )
    }

    // 自分の提案のみ更新可能
    const proposal = await prisma.switchProposal.findFirst({
      where: { id, userId: authUser.id },
    })

    if (!proposal) {
      return NextResponse.json(
        { error: "Not found" },
        { status: 404 },
      )
    }

    await prisma.switchProposal.update({
      where: { id },
      data: { userAction: action },
    })

    return NextResponse.json({ success: true })
  } catch (e) {
    console.error("乗り換え提案アクションエラー:", e)
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 },
    )
  }
}
