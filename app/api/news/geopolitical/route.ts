import { NextResponse } from "next/server"
import { getGeopoliticalNews } from "@/lib/news"

export async function GET() {
  try {
    const news = await getGeopoliticalNews(5)
    return NextResponse.json({ news })
  } catch (error) {
    console.error("Failed to fetch geopolitical news:", error)
    return NextResponse.json(
      { error: "Failed to fetch geopolitical news" },
      { status: 500 }
    )
  }
}
