import { GAP_PREDICTION } from "@/lib/constants"

export type GapDirection = "up" | "down" | "flat"
export type GapSeverity = "high" | "medium" | "low"

export interface PreMarketIndicator {
  close: number
  changeRate: number
}

export interface PreMarketDataInput {
  nikkeiFutures: PreMarketIndicator | null
  usdjpy: PreMarketIndicator | null
  sp500: PreMarketIndicator | null
  nasdaq: PreMarketIndicator | null
}

export interface MarketGapEstimate {
  estimatedGapRate: number
  gapDirection: GapDirection
  severity: GapSeverity
}

export interface StockGapEstimate extends MarketGapEstimate {
  stockId: string
  tickerCode: string
  name: string
  sector: string | null
  latestPrice: number | null
  betaFactor: number
}

/**
 * 市場全体のギャップ率を推定
 *
 * 重み付け:
 * - CME日経先物: 50%（最も直接的な指標）
 * - S&P 500: 25%（米国全体の影響）
 * - NASDAQ: 15%（テック寄りの影響）
 * - USD/JPY: 10%（為替影響）
 */
export function estimateMarketGap(data: PreMarketDataInput): MarketGapEstimate {
  let totalWeight = 0
  let weightedSum = 0

  if (data.nikkeiFutures) {
    weightedSum += data.nikkeiFutures.changeRate * GAP_PREDICTION.NIKKEI_FUTURES_WEIGHT
    totalWeight += GAP_PREDICTION.NIKKEI_FUTURES_WEIGHT
  }

  if (data.sp500) {
    weightedSum += data.sp500.changeRate * GAP_PREDICTION.SP500_WEIGHT
    totalWeight += GAP_PREDICTION.SP500_WEIGHT
  }

  if (data.nasdaq) {
    weightedSum += data.nasdaq.changeRate * GAP_PREDICTION.NASDAQ_WEIGHT
    totalWeight += GAP_PREDICTION.NASDAQ_WEIGHT
  }

  if (data.usdjpy) {
    // 円安（changeRate > 0）は日本株にプラス
    const fxImpact = data.usdjpy.changeRate * GAP_PREDICTION.USDJPY_IMPACT_FACTOR
    weightedSum += fxImpact * GAP_PREDICTION.USDJPY_WEIGHT
    totalWeight += GAP_PREDICTION.USDJPY_WEIGHT
  }

  // データがない場合は推定不能
  if (totalWeight === 0) {
    return { estimatedGapRate: 0, gapDirection: "flat", severity: "low" }
  }

  // 利用可能なデータの重みで正規化
  const estimatedGapRate = Math.round((weightedSum / totalWeight) * 100) / 100

  return {
    estimatedGapRate,
    gapDirection: getGapDirection(estimatedGapRate),
    severity: getGapSeverity(estimatedGapRate),
  }
}

/**
 * 銘柄個別のギャップ率を推定
 *
 * 市場全体のギャップ推定値にベータ近似値を乗じる。
 * セクター補正（NASDAQ重み上乗せ + 為替感応度）も適用。
 */
export function estimateStockGap(
  marketGap: MarketGapEstimate,
  stock: {
    id: string
    tickerCode: string
    name: string
    sector: string | null
    latestPrice: number | null
    volatility: number | null
  },
  averageVolatility: number,
  nasdaqChangeRate: number | null,
  usdjpyChangeRate: number | null,
): StockGapEstimate {
  // ベータ近似 = 銘柄ボラティリティ / 市場平均ボラティリティ
  let betaFactor = 1.0
  if (stock.volatility && averageVolatility > 0) {
    betaFactor = stock.volatility / averageVolatility
    betaFactor = Math.max(GAP_PREDICTION.BETA_MIN, Math.min(GAP_PREDICTION.BETA_MAX, betaFactor))
  }

  let stockGapRate = marketGap.estimatedGapRate * betaFactor

  // セクター補正: NASDAQ感応度
  if (stock.sector && nasdaqChangeRate !== null) {
    const nasdaqBonus = GAP_PREDICTION.SECTOR_NASDAQ_BONUS[stock.sector] ?? 0
    if (nasdaqBonus !== 0) {
      stockGapRate += nasdaqChangeRate * nasdaqBonus
    }
  }

  // セクター補正: 為替感応度
  if (stock.sector && usdjpyChangeRate !== null) {
    const fxSensitivity = GAP_PREDICTION.SECTOR_FX_SENSITIVITY[stock.sector] ?? 1.0
    // デフォルト感応度(1.0)との差分のみ補正
    const fxAdjustment = usdjpyChangeRate * GAP_PREDICTION.USDJPY_IMPACT_FACTOR * (fxSensitivity - 1.0)
    stockGapRate += fxAdjustment * GAP_PREDICTION.USDJPY_WEIGHT
  }

  stockGapRate = Math.round(stockGapRate * 100) / 100

  return {
    stockId: stock.id,
    tickerCode: stock.tickerCode,
    name: stock.name,
    sector: stock.sector,
    latestPrice: stock.latestPrice,
    betaFactor: Math.round(betaFactor * 100) / 100,
    estimatedGapRate: stockGapRate,
    gapDirection: getGapDirection(stockGapRate),
    severity: getGapSeverity(stockGapRate),
  }
}

function getGapDirection(gapRate: number): GapDirection {
  if (gapRate > 0.1) return "up"
  if (gapRate < -0.1) return "down"
  return "flat"
}

function getGapSeverity(gapRate: number): GapSeverity {
  const absRate = Math.abs(gapRate)
  if (absRate >= GAP_PREDICTION.HIGH_SEVERITY_THRESHOLD) return "high"
  if (absRate >= GAP_PREDICTION.MEDIUM_SEVERITY_THRESHOLD) return "medium"
  return "low"
}
