/**
 * 日次おすすめ銘柄のスコア計算ロジック
 *
 * Pythonスクリプト (generate_personal_recommendations.py) から移植
 */

import { MA_DEVIATION, MOMENTUM, MARKET_DEFENSIVE_MODE, EARNINGS_SAFETY } from "@/lib/constants"
import { getSectorScoreBonus, type SectorTrendData } from "@/lib/sector-trend"
import {
  isDangerousStock,
  isInDecline,
  isOverheated,
  isSurgeStock,
} from "@/lib/stock-safety-rules"

// 設定
export const SCORING_CONFIG = {
  MAX_PER_SECTOR: 5,       // 各セクターからの最大銘柄数
  MAX_CANDIDATES_FOR_AI: 15, // AIに渡す最大銘柄数
  MAX_VOLATILITY: 50,      // ボラティリティ上限（%）
}

// 赤字 AND 高ボラティリティ銘柄へのスコアペナルティ（投資スタイル別）
export const RISK_PENALTY: Record<string, number> = {
  AGGRESSIVE: -10,  // 積極派: ペナルティ小（リスク許容度高）
  BALANCED: -20,    // バランス型: 標準ペナルティ
  CONSERVATIVE: -30, // 慎重派: ペナルティ大（リスク回避）
}

// 投資スタイル別のスコア配分
type ScoreWeights = {
  weekChangeRate: number
  volumeRatio: number
  volatility: number
  marketCap: number
}

export const SCORE_WEIGHTS: Record<string, ScoreWeights> = {
  // 積極派: モメンタム重視、ボラティリティ許容
  AGGRESSIVE: { weekChangeRate: 35, volumeRatio: 30, volatility: 20, marketCap: 15 },
  // バランス型: 全要素バランス
  BALANCED: { weekChangeRate: 25, volumeRatio: 25, volatility: 25, marketCap: 25 },
  // 慎重派: 安定性重視、時価総額（大型株）優先
  CONSERVATIVE: { weekChangeRate: 15, volumeRatio: 15, volatility: 30, marketCap: 40 },
}

// 時間帯別のプロンプト設定
export const SESSION_PROMPTS: Record<string, { intro: string; focus: string }> = {
  morning: {
    intro: "前日の動きを踏まえた今日のおすすめです。",
    focus: "今日注目したい銘柄",
  },
  afternoon: {
    intro: "前場の動きを踏まえたおすすめです。",
    focus: "後場に注目したい銘柄",
  },
  evening: {
    intro: "本日の取引を踏まえた明日へのおすすめです。",
    focus: "明日以降に注目したい銘柄",
  },
}

export interface StockForScoring {
  id: string
  tickerCode: string
  name: string
  sector: string | null
  latestPrice: number | null
  weekChangeRate: number | null
  volatility: number | null
  volumeRatio: number | null
  marketCap: number | null
  isProfitable: boolean | null
  maDeviationRate: number | null
  nextEarningsDate: Date | null
}

export interface ScoredStock extends StockForScoring {
  score: number
  scoreBreakdown: Record<string, number>
}

/**
 * 指標を0-100に正規化する
 */
function normalizeValues(
  stocks: StockForScoring[],
  key: keyof StockForScoring,
  reverse: boolean = false
): Map<string, number> {
  const values: Array<{ id: string; value: number }> = []

  for (const stock of stocks) {
    const val = stock[key]
    if (typeof val === "number" && val !== null) {
      values.push({ id: stock.id, value: val })
    }
  }

  if (values.length === 0) return new Map()

  const vals = values.map(v => v.value)
  const minVal = Math.min(...vals)
  const maxVal = Math.max(...vals)

  if (maxVal === minVal) {
    return new Map(values.map(v => [v.id, 50]))
  }

  const result = new Map<string, number>()
  for (const { id, value } of values) {
    let score = ((value - minVal) / (maxVal - minVal)) * 100
    if (reverse) score = 100 - score
    result.set(id, score)
  }

  return result
}

/**
 * 投資スタイルに基づいてスコアを計算
 */
export function calculateStockScores(
  stocks: StockForScoring[],
  investmentStyle: string | null,
  sectorTrends?: Record<string, SectorTrendData>,
  isMarketPanic?: boolean,
): ScoredStock[] {
  const style = investmentStyle || "BALANCED"
  const weights = SCORE_WEIGHTS[style] || SCORE_WEIGHTS["BALANCED"]

  // 慎重派の場合はvolatilityを反転（低い方が良い）
  const isLowRisk = investmentStyle === "CONSERVATIVE"

  const normalized = {
    weekChangeRate: normalizeValues(stocks, "weekChangeRate"),
    volumeRatio: normalizeValues(stocks, "volumeRatio"),
    volatility: normalizeValues(stocks, "volatility", isLowRisk),
    marketCap: normalizeValues(stocks, "marketCap"),
  }

  const penalty = RISK_PENALTY[style] || -20
  const scoredStocks: ScoredStock[] = []

  const isAggressive = investmentStyle === "AGGRESSIVE"

  for (const stock of stocks) {
    // 異常な急騰（週間+50%超）は除外（積極派は+80%超のみ除外）
    const extremeSurgeLimit = isAggressive ? 80 : 50
    if (stock.weekChangeRate !== null && stock.weekChangeRate > extremeSurgeLimit) {
      continue
    }

    // 購入判断で強制補正（buy→stay）される銘柄を除外
    const volatilityNum = stock.volatility !== null ? Number(stock.volatility) : null
    const weekChange = stock.weekChangeRate !== null ? Number(stock.weekChangeRate) : null
    const maDeviation = stock.maDeviationRate !== null ? Number(stock.maDeviationRate) : null
    if (
      isDangerousStock(stock.isProfitable, volatilityNum) ||
      isSurgeStock(weekChange, style) ||
      isInDecline(weekChange, style) ||
      isOverheated(maDeviation, style)
    ) {
      continue
    }

    // 決算3日前以内の銘柄を除外（決算ギャンブル防止）
    if (stock.nextEarningsDate) {
      const now = new Date()
      const diffMs = new Date(stock.nextEarningsDate).getTime() - now.getTime()
      const diffDays = diffMs / (1000 * 60 * 60 * 24)
      if (diffDays >= 0 && diffDays <= EARNINGS_SAFETY.PRE_EARNINGS_BLOCK_DAYS) {
        continue
      }
    }

    let totalScore = 0
    const scoreBreakdown: Record<string, number> = {}

    // 各指標のスコアを計算
    for (const [weightKey, weight] of Object.entries(weights)) {
      const normalizedMap = normalized[weightKey as keyof typeof normalized]
      const val = normalizedMap.get(stock.id)
      const componentScore = (val !== undefined ? val : 50) * (weight / 100)
      totalScore += componentScore
      scoreBreakdown[weightKey] = Math.round(componentScore * 10) / 10
    }

    // 赤字 AND 高ボラティリティの場合はペナルティ
    const isHighRiskStock = (
      stock.isProfitable === false &&
      stock.volatility !== null &&
      stock.volatility > SCORING_CONFIG.MAX_VOLATILITY
    )
    if (isHighRiskStock && penalty !== 0) {
      totalScore += penalty
      scoreBreakdown["riskPenalty"] = penalty
    }

    // 急騰銘柄へのペナルティ（投資スタイル別）
    if (stock.weekChangeRate !== null) {
      if (isAggressive) {
        // 積極派: 急騰ペナルティなし（モメンタム重視）
      } else if (stock.weekChangeRate >= 30) {
        totalScore -= 20
        scoreBreakdown["surgePenalty"] = -20
      } else if (stock.weekChangeRate >= 20) {
        totalScore -= 10
        scoreBreakdown["surgePenalty"] = -10
      }
    }

    // 下落トレンドへのペナルティ（投資スタイル別）
    if (stock.weekChangeRate !== null) {
      const declineThreshold =
        investmentStyle === "CONSERVATIVE"
          ? MOMENTUM.CONSERVATIVE_DECLINE_THRESHOLD
          : investmentStyle === "AGGRESSIVE"
            ? MOMENTUM.AGGRESSIVE_DECLINE_THRESHOLD
            : MOMENTUM.BALANCED_DECLINE_THRESHOLD

      if (stock.weekChangeRate <= declineThreshold) {
        totalScore += MOMENTUM.STRONG_DECLINE_SCORE_PENALTY
        scoreBreakdown["declinePenalty"] = MOMENTUM.STRONG_DECLINE_SCORE_PENALTY
      } else if (stock.weekChangeRate <= declineThreshold + 3) {
        // 閾値付近（閾値+3%まで）は軽めのペナルティ
        totalScore += MOMENTUM.DECLINE_SCORE_PENALTY
        scoreBreakdown["declinePenalty"] = MOMENTUM.DECLINE_SCORE_PENALTY
      }
    }

    // 業績不明の銘柄へのペナルティ
    if (stock.isProfitable === null) {
      totalScore -= 5
      scoreBreakdown["unknownEarningsPenalty"] = -5
    }

    // 移動平均乖離率によるペナルティ/ボーナス
    if (stock.maDeviationRate !== null) {
      if (stock.maDeviationRate >= MA_DEVIATION.UPPER_THRESHOLD && !isAggressive) {
        // 積極派は過熱圏ペナルティをスキップ（モメンタム重視）
        totalScore += MA_DEVIATION.SCORE_PENALTY
        scoreBreakdown["maDeviationPenalty"] = MA_DEVIATION.SCORE_PENALTY
      } else if (
        stock.maDeviationRate <= MA_DEVIATION.LOWER_THRESHOLD &&
        stock.isProfitable === true &&
        stock.volatility !== null &&
        stock.volatility <= MA_DEVIATION.LOW_VOLATILITY_THRESHOLD
      ) {
        totalScore += MA_DEVIATION.SCORE_BONUS
        scoreBreakdown["maDeviationBonus"] = MA_DEVIATION.SCORE_BONUS
      }
    }

    // セクタートレンドによるボーナス/ペナルティ
    if (sectorTrends && stock.sector && sectorTrends[stock.sector]) {
      const bonus = getSectorScoreBonus(sectorTrends[stock.sector])
      if (bonus !== 0) {
        totalScore += bonus
        scoreBreakdown["sectorTrendBonus"] = bonus
      }
    }

    // 市場パニック時の一律ペナルティ
    if (isMarketPanic) {
      totalScore += MARKET_DEFENSIVE_MODE.SCORE_PENALTY
      scoreBreakdown["marketPanicPenalty"] = MARKET_DEFENSIVE_MODE.SCORE_PENALTY
    }

    scoredStocks.push({
      ...stock,
      score: Math.round(totalScore * 100) / 100,
      scoreBreakdown,
    })
  }

  // スコア順にソート
  scoredStocks.sort((a, b) => b.score - a.score)
  return scoredStocks
}

/**
 * セクター分散を適用（各セクターから最大N銘柄）
 */
export function applySectorDiversification(stocks: ScoredStock[]): ScoredStock[] {
  const sectorCounts: Record<string, number> = {}
  const diversified: ScoredStock[] = []

  for (const stock of stocks) {
    const sector = stock.sector || "その他"
    const count = sectorCounts[sector] || 0

    if (count < SCORING_CONFIG.MAX_PER_SECTOR) {
      diversified.push(stock)
      sectorCounts[sector] = count + 1
    }
  }

  return diversified
}

/** 予算の1.5倍までの緩いフィルタ（スコアリング前の候補絞り込み用） */
const BUDGET_MARGIN = 1.5

export function filterByLooseBudget(
  stocks: StockForScoring[],
  budget: number | null
): StockForScoring[] {
  if (!budget) return stocks
  const looseBudget = budget * BUDGET_MARGIN
  return stocks.filter(s =>
    s.latestPrice !== null && s.latestPrice * 100 <= looseBudget
  )
}

/**
 * スコアリング後の最終予算絞り込み
 * 予算内の銘柄を優先し、5件未満なら予算超の銘柄も安い順に追加
 */
const MIN_RECOMMENDATIONS = 5

export function narrowByBudget(
  stocks: ScoredStock[],
  budget: number | null
): { stocks: ScoredStock[]; isBudgetExceeded: boolean } {
  if (!budget) return { stocks, isBudgetExceeded: false }

  const withinBudget = stocks.filter(s =>
    s.latestPrice !== null && s.latestPrice * 100 <= budget
  )

  if (withinBudget.length >= MIN_RECOMMENDATIONS) {
    return { stocks: withinBudget, isBudgetExceeded: false }
  }

  // 予算内が5件未満: 予算超の銘柄を安い順に追加
  const overBudgetIds = new Set(withinBudget.map(s => s.id))
  const overBudget = stocks
    .filter(s => !overBudgetIds.has(s.id) && s.latestPrice !== null)
    .sort((a, b) => (a.latestPrice ?? Infinity) - (b.latestPrice ?? Infinity))

  const combined = [...withinBudget, ...overBudget].slice(0, SCORING_CONFIG.MAX_CANDIDATES_FOR_AI)
  return { stocks: combined, isBudgetExceeded: combined.some(s => s.latestPrice !== null && s.latestPrice * 100 > budget) }
}
