import { NextRequest, NextResponse } from "next/server"
import { getAuthUser } from "@/lib/auth-utils"
import { prisma } from "@/lib/prisma"
import { MAX_TRACKED_STOCKS } from "@/lib/constants"

/**
 * GET /api/tracked-stocks
 * ユーザーの追跡銘柄一覧を取得
 */
export async function GET() {
  const { user, error } = await getAuthUser()
  if (error) return error

  const userId = user.id

  try {
    const trackedStocks = await prisma.trackedStock.findMany({
      where: { userId },
      include: {
        stock: {
          select: {
            id: true,
            tickerCode: true,
            name: true,
            sector: true,
            market: true,
            fetchFailCount: true,
            isDelisted: true,
            nextEarningsDate: true,
            delistingNewsDetectedAt: true,
            delistingNewsReason: true,
            atr14: true,
          },
        },
      },
      orderBy: { createdAt: "desc" },
    })

    // レスポンス整形（株価はクライアント側で非同期取得）
    const response = trackedStocks.map((ts) => ({
      id: ts.id,
      stockId: ts.stockId,
      stock: {
        id: ts.stock.id,
        tickerCode: ts.stock.tickerCode,
        name: ts.stock.name,
        sector: ts.stock.sector,
        market: ts.stock.market,
        fetchFailCount: ts.stock.fetchFailCount,
        isDelisted: ts.stock.isDelisted,
        nextEarningsDate: ts.stock.nextEarningsDate?.toISOString() ?? null,
        delistingNewsDetectedAt: ts.stock.delistingNewsDetectedAt?.toISOString() ?? null,
        delistingNewsReason: ts.stock.delistingNewsReason ?? null,
        atr14: ts.stock.atr14 ? Number(ts.stock.atr14) : null,
      },
      currentPrice: null,
      change: null,
      changePercent: null,
      createdAt: ts.createdAt.toISOString(),
    }))

    return NextResponse.json(response)
  } catch (error) {
    console.error("Error fetching tracked stocks:", error)
    return NextResponse.json(
      { error: "追跡銘柄の取得に失敗しました" },
      { status: 500 }
    )
  }
}

/**
 * POST /api/tracked-stocks
 * 銘柄を追跡リストに追加
 */
export async function POST(request: NextRequest) {
  const { user, error } = await getAuthUser()
  if (error) return error

  const userId = user.id

  try {
    const body = await request.json()
    const { stockId, tickerCode } = body

    // stockIdまたはtickerCodeのいずれかが必要
    if (!stockId && !tickerCode) {
      return NextResponse.json(
        { error: "stockId または tickerCode が必要です" },
        { status: 400 }
      )
    }

    // 銘柄を取得
    let stock
    if (stockId) {
      stock = await prisma.stock.findUnique({
        where: { id: stockId },
        select: { id: true, tickerCode: true, name: true, sector: true, market: true },
      })
    } else {
      stock = await prisma.stock.findUnique({
        where: { tickerCode },
        select: { id: true, tickerCode: true, name: true, sector: true, market: true },
      })
    }

    if (!stock) {
      return NextResponse.json(
        { error: "銘柄が見つかりません" },
        { status: 404 }
      )
    }

    // 既に追跡中かチェック
    const existing = await prisma.trackedStock.findUnique({
      where: {
        userId_stockId: {
          userId,
          stockId: stock.id,
        },
      },
    })

    if (existing) {
      return NextResponse.json(
        { error: "既に追跡中の銘柄です" },
        { status: 400 }
      )
    }

    // 追跡数の制限チェック
    const count = await prisma.trackedStock.count({ where: { userId } })
    if (count >= MAX_TRACKED_STOCKS) {
      return NextResponse.json(
        { error: `追跡銘柄は最大${MAX_TRACKED_STOCKS}件までです` },
        { status: 400 }
      )
    }

    // 追跡銘柄を作成
    const trackedStock = await prisma.trackedStock.create({
      data: {
        userId,
        stockId: stock.id,
      },
      include: {
        stock: {
          select: {
            id: true,
            tickerCode: true,
            name: true,
            sector: true,
            market: true,
          },
        },
      },
    })

    return NextResponse.json({
      id: trackedStock.id,
      stockId: trackedStock.stockId,
      stock: trackedStock.stock,
      createdAt: trackedStock.createdAt.toISOString(),
      message: "追跡銘柄に追加しました",
    }, { status: 201 })
  } catch (error) {
    console.error("Error creating tracked stock:", error)
    return NextResponse.json(
      { error: "追跡銘柄の追加に失敗しました" },
      { status: 500 }
    )
  }
}
