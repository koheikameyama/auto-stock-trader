import { getAuthUser } from "@/lib/auth-utils"
import { NextResponse } from "next/server"
import { getSwitchProposals } from "@/lib/smart-switch"

export async function GET() {
  const { user: authUser, error } = await getAuthUser()
  if (error) return error

  try {
    const proposals = await getSwitchProposals(authUser.id)
    return NextResponse.json({ proposals })
  } catch (e) {
    console.error("乗り換え提案取得エラー:", e)
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 },
    )
  }
}
