import { getAuthUser } from "@/lib/auth-utils"
import { getActiveShield } from "@/lib/market-shield"
import { NextResponse } from "next/server"

export async function GET() {
  const { error } = await getAuthUser()
  if (error) return error

  try {
    const shield = await getActiveShield()
    return NextResponse.json({
      active: shield !== null,
      shield: shield
        ? {
            triggerType: shield.triggerType,
            triggerValue: shield.triggerValue,
            activatedAt: shield.activatedAt,
          }
        : null,
    })
  } catch (e) {
    console.error("マーケットシールド取得エラー:", e)
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 },
    )
  }
}
