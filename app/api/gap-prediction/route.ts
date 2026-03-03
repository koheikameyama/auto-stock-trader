import { NextResponse } from "next/server"
import { auth } from "@/auth"
import { prisma } from "@/lib/prisma"
import { getTodayForDB } from "@/lib/date-utils"
import {
  estimateMarketGap,
  estimateStockGap,
  type PreMarketDataInput,
  type StockGapEstimate,
} from "@/lib/gap-prediction"

/**
 * GET /api/gap-prediction
 *
 * プレマーケットデータからギャップ予測を返す。
 * - 市場全体のギャップ推定（海外市場4指標 + 加重平均推定）
 * - ポートフォリオ銘柄の個別ギャップ推定（ベータ近似 + セクター補正）
 */
export async function GET() {
  try {
    const session = await auth()

    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }

    const today = getTodayForDB()

    // 当日のプレマーケットデータを取得
    const preMarketData = await prisma.preMarketData.findUnique({
      where: { date: today },
    })

    if (!preMarketData) {
      return NextResponse.json({ data: null })
    }

    // PreMarketDataInput に変換
    const input: PreMarketDataInput = {
      nikkeiFutures: preMarketData.nikkeiFuturesClose
        ? { close: Number(preMarketData.nikkeiFuturesClose), changeRate: Number(preMarketData.nikkeiFuturesChangeRate) }
        : null,
      usdjpy: preMarketData.usdjpyClose
        ? { close: Number(preMarketData.usdjpyClose), changeRate: Number(preMarketData.usdjpyChangeRate) }
        : null,
      sp500: preMarketData.sp500Close
        ? { close: Number(preMarketData.sp500Close), changeRate: Number(preMarketData.sp500ChangeRate) }
        : null,
      nasdaq: preMarketData.nasdaqClose
        ? { close: Number(preMarketData.nasdaqClose), changeRate: Number(preMarketData.nasdaqChangeRate) }
        : null,
    }

    // 市場全体のギャップ推定
    const marketGap = estimateMarketGap(input)

    // ポートフォリオ銘柄の個別ギャップ推定
    const portfolioStocks = await prisma.portfolioStock.findMany({
      where: { userId: session.user.id },
      include: {
        stock: true,
      },
    })

    let stocks: StockGapEstimate[] = []

    if (portfolioStocks.length > 0) {
      // 市場平均ボラティリティを計算（Stockモデルに直接格納されている）
      const volatilities = portfolioStocks
        .map((ps) => ps.stock.volatility)
        .filter((v): v is NonNullable<typeof v> => v !== null && v !== undefined)
        .map(Number)

      const averageVolatility = volatilities.length > 0
        ? volatilities.reduce((sum, v) => sum + v, 0) / volatilities.length
        : 30 // デフォルト

      const nasdaqChangeRate = input.nasdaq?.changeRate ?? null
      const usdjpyChangeRate = input.usdjpy?.changeRate ?? null

      stocks = portfolioStocks
        .map((ps) => {
          return estimateStockGap(
            marketGap,
            {
              id: ps.stock.id,
              tickerCode: ps.stock.tickerCode,
              name: ps.stock.name,
              sector: ps.stock.sector,
              latestPrice: ps.stock.latestPrice ? Number(ps.stock.latestPrice) : null,
              volatility: ps.stock.volatility ? Number(ps.stock.volatility) : null,
            },
            averageVolatility,
            nasdaqChangeRate,
            usdjpyChangeRate,
          )
        })
        .filter((s) => s.severity !== "low")
        .sort((a, b) => Math.abs(b.estimatedGapRate) - Math.abs(a.estimatedGapRate))
    }

    return NextResponse.json({
      date: today.toISOString().split("T")[0],
      market: {
        nikkeiFutures: input.nikkeiFutures,
        usdjpy: input.usdjpy,
        sp500: input.sp500,
        nasdaq: input.nasdaq,
        ...marketGap,
      },
      stocks,
    })
  } catch (error) {
    console.error("Error fetching gap prediction:", error)
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    )
  }
}
