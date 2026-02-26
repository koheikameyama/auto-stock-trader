import { fetchHistoricalPrices } from "@/lib/stock-price-fetcher"
import { MARKET_INDEX } from "@/lib/constants"

export interface MarketIndexData {
  currentPrice: number
  weekChangeRate: number
  trend: "up" | "down" | "neutral"
  isMarketCrash: boolean
  isMarketPanic: boolean
}

/**
 * 日経平均のトレンドデータを取得
 * @returns MarketIndexData または取得失敗時は null
 */
export async function getNikkei225Data(): Promise<MarketIndexData | null> {
  try {
    // yfinanceで日経平均を取得（^N225）
    // 1ヶ月分のデータを取得して直近のデータを使用
    const prices = await fetchHistoricalPrices("^N225", "1m")

    if (prices.length < 2) {
      console.warn("日経平均の価格データが不足しています")
      return null
    }

    // 最新と1週間前の終値（古い順にソートされているので末尾が最新）
    const latestPrice = prices[prices.length - 1].close
    const weekAgoPrice = prices[Math.max(0, prices.length - 5)].close

    // 週間変化率を計算
    const weekChangeRate = ((latestPrice - weekAgoPrice) / weekAgoPrice) * 100

    // トレンド判定
    let trend: "up" | "down" | "neutral"
    if (weekChangeRate >= MARKET_INDEX.UP_TREND_THRESHOLD) {
      trend = "up"
    } else if (weekChangeRate <= MARKET_INDEX.DOWN_TREND_THRESHOLD) {
      trend = "down"
    } else {
      trend = "neutral"
    }

    // 急落判定
    const isMarketCrash = weekChangeRate <= MARKET_INDEX.CRASH_THRESHOLD

    // パニック判定（防御モード発動）
    const isMarketPanic = weekChangeRate <= MARKET_INDEX.PANIC_THRESHOLD

    return {
      currentPrice: latestPrice,
      weekChangeRate,
      trend,
      isMarketCrash,
      isMarketPanic,
    }
  } catch (error) {
    console.error("日経平均データの取得に失敗:", error)
    return null
  }
}

/**
 * トレンドを日本語に変換
 */
export function getTrendDescription(trend: "up" | "down" | "neutral"): string {
  switch (trend) {
    case "up":
      return "上昇傾向"
    case "down":
      return "下落傾向"
    case "neutral":
      return "横ばい"
  }
}
