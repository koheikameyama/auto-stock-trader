import { getAuthUser } from "@/lib/auth-utils"
import { NextResponse } from "next/server"
import { prisma } from "@/lib/prisma"
import { fetchStockPrices } from "@/lib/stock-price-fetcher"
import { calculatePortfolioFromTransactions } from "@/lib/portfolio-calculator"
import { Decimal } from "@prisma/client/runtime/library"

export async function GET() {
  const { user: authUser, error } = await getAuthUser()
  if (error) return error

  try {
    const user = await prisma.user.findUnique({
      where: { id: authUser.id },
      select: {
        id: true,
        portfolioStocks: {
          include: {
            stock: true,
            transactions: {
              orderBy: { transactionDate: "asc" },
            },
          },
        },
      },
    })

    if (!user) {
      return NextResponse.json({ error: "User not found" }, { status: 404 })
    }

    if (user.portfolioStocks.length === 0) {
      return NextResponse.json({ summary: null })
    }

    // 保有中の銘柄のティッカーコードを取得（株価取得用）
    const holdingTickers: string[] = []
    for (const ps of user.portfolioStocks) {
      const { quantity } = calculatePortfolioFromTransactions(ps.transactions)
      if (quantity > 0) {
        holdingTickers.push(ps.stock.tickerCode)
      }
    }

    // 現在の株価を取得（保有中の銘柄のみ）
    const { prices } = holdingTickers.length > 0
      ? await fetchStockPrices(holdingTickers)
      : { prices: [] }
    const priceMap = new Map(prices.map((p) => [p.tickerCode, p.currentPrice]))
    const prevCloseMap = new Map(prices.map((p) => [p.tickerCode, p.previousClose]))

    let totalValue = 0
    let totalPrevValue = 0
    let totalCost = 0

    // 確定損益の計算用
    let realizedGain = 0
    let totalRealizedCost = 0
    let winCount = 0
    let loseCount = 0
    const returnRates: number[] = []

    for (const ps of user.portfolioStocks) {
      const { quantity, averagePurchasePrice } = calculatePortfolioFromTransactions(
        ps.transactions
      )

      const buyTransactions = ps.transactions.filter((t) => t.type === "buy")
      const sellTransactions = ps.transactions.filter((t) => t.type === "sell")

      if (quantity > 0) {
        // 保有中: 含み損益の計算
        const currentPrice = priceMap.get(ps.stock.tickerCode)
        if (currentPrice == null) continue

        const prevClose = prevCloseMap.get(ps.stock.tickerCode)
        totalValue += currentPrice * quantity
        if (prevClose != null) {
          totalPrevValue += prevClose * quantity
        }
        totalCost += averagePurchasePrice.toNumber() * quantity

        // 部分売却がある場合: 確定損益も計算
        if (sellTransactions.length > 0 && buyTransactions.length > 0) {
          const totalBuyAmount = buyTransactions.reduce(
            (sum, t) => sum.plus(t.totalAmount),
            new Decimal(0)
          )
          const totalSellAmount = sellTransactions.reduce(
            (sum, t) => sum.plus(t.totalAmount),
            new Decimal(0)
          )
          // 売却分のコスト = 総購入額 - 残りの保有コスト
          const remainingCost = averagePurchasePrice.times(quantity)
          const costOfSold = totalBuyAmount.minus(remainingCost)
          const partialProfit = totalSellAmount.minus(costOfSold).toNumber()

          realizedGain += partialProfit
          totalRealizedCost += costOfSold.toNumber()
        }
      } else {
        // 全量売却済み: 確定損益の計算
        if (buyTransactions.length === 0 || sellTransactions.length === 0) continue

        const totalBuyAmount = buyTransactions.reduce(
          (sum, t) => sum.plus(t.totalAmount),
          new Decimal(0)
        )
        const totalSellAmount = sellTransactions.reduce(
          (sum, t) => sum.plus(t.totalAmount),
          new Decimal(0)
        )

        const profit = totalSellAmount.minus(totalBuyAmount).toNumber()
        const buyAmount = totalBuyAmount.toNumber()

        realizedGain += profit
        totalRealizedCost += buyAmount

        if (profit >= 0) {
          winCount++
        } else {
          loseCount++
        }

        if (buyAmount > 0) {
          returnRates.push((profit / buyAmount) * 100)
        }
      }
    }

    // 保有も売却もない場合
    if (totalCost <= 0 && totalRealizedCost <= 0) {
      return NextResponse.json({ summary: null })
    }

    const dailyChange = totalPrevValue > 0 ? totalValue - totalPrevValue : 0
    const dailyChangePercent = totalPrevValue > 0
      ? (dailyChange / totalPrevValue) * 100
      : 0

    const unrealizedGain = totalValue - totalCost
    const unrealizedGainPercent = totalCost > 0
      ? (unrealizedGain / totalCost) * 100
      : 0

    const totalGain = unrealizedGain + realizedGain
    const totalInvested = totalCost + totalRealizedCost
    const totalGainPercent = totalInvested > 0
      ? (totalGain / totalInvested) * 100
      : 0

    const soldCount = winCount + loseCount
    const winRate = soldCount > 0 ? (winCount / soldCount) * 100 : null
    const averageReturn = returnRates.length > 0
      ? returnRates.reduce((sum, r) => sum + r, 0) / returnRates.length
      : null

    return NextResponse.json({
      summary: {
        totalValue,
        totalCost,
        dailyChange,
        dailyChangePercent,
        unrealizedGain,
        unrealizedGainPercent,
        realizedGain,
        totalGain,
        totalGainPercent,
        winCount,
        loseCount,
        winRate,
        averageReturn,
      },
    })
  } catch (error) {
    console.error("Error fetching portfolio summary:", error)
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    )
  }
}
