/**
 * 日次おすすめ銘柄のスコア計算ロジック
 *
 * Pythonスクリプト (generate_personal_recommendations.py) から移植
 */

import { PERSPECTIVE_BONUS } from "@/lib/constants"
import { getSectorScoreBonus, type SectorTrendData } from "@/lib/sector-trend"

// 設定
export const SCORING_CONFIG = {
  MAX_PER_SECTOR: 5,       // 各セクターからの最大銘柄数
  MAX_CANDIDATES_FOR_AI: 15, // AIに渡す最大銘柄数
  MAX_VOLATILITY: 50,      // ボラティリティ上限（%）
}

// 赤字 AND 高ボラティリティ銘柄へのスコアペナルティ（投資スタイル別）
export const RISK_PENALTY: Record<string, number> = {
  AGGRESSIVE: -10,  // アクティブ型: ペナルティ小（リスク許容度高）
  BALANCED: -20,    // 成長投資型: 標準ペナルティ
  CONSERVATIVE: -30, // 安定配当型: ペナルティ大（リスク回避）
}

// 投資スタイル別のスコア配分
type ScoreWeights = {
  weekChangeRate: number
  volumeRatio: number
  volatility: number
  marketCap: number
}

export const SCORE_WEIGHTS: Record<string, ScoreWeights> = {
  // アクティブ型: モメンタム重視、ボラティリティ許容
  AGGRESSIVE: { weekChangeRate: 35, volumeRatio: 30, volatility: 20, marketCap: 15 },
  // 成長投資型: 全要素バランス
  BALANCED: { weekChangeRate: 25, volumeRatio: 25, volatility: 25, marketCap: 25 },
  // 安定配当型: 安定性重視、時価総額（大型株）優先
  CONSERVATIVE: { weekChangeRate: 15, volumeRatio: 15, volatility: 30, marketCap: 40 },
}

// 時間帯別のプロンプト設定
export const SESSION_PROMPTS: Record<string, {
  intro: string
  focus: string
  timeHorizon: string    // 推奨する時間軸
  keySignals: string     // 重視すべきシグナル
  actionContext: string  // どんな行動のための銘柄選定か
  avoidSignals: string   // 避けるべきシグナル
}> = {
  morning: {
    intro: "前日の動きを踏まえた今日のおすすめです。",
    focus: "今日の前場に注目したい銘柄",
    timeHorizon: "今日〜今週",
    keySignals: "出来高急増・モメンタム・前日比の方向感・MA乖離率（過熱していないか）",
    actionContext: "今日の前場でエントリーを検討する銘柄。寄り付き直後は様子見し、方向感が出た30分後を目安にする",
    avoidSignals: "前週比+20%以上の急騰銘柄（過熱感あり）・出来高比0.5倍以下の薄商い銘柄",
  },
  afternoon: {
    intro: "前場の動きを踏まえたおすすめです。",
    focus: "後場に注目したい銘柄",
    timeHorizon: "今日の後場〜明日",
    keySignals: "前場の出来高比・前場の高値/安値からのトレンド継続性・MA乖離率の変化",
    actionContext: "後場のエントリーまたは利確・損切りを検討する銘柄。前場の流れが続くか反転するかの判断材料を提供する",
    avoidSignals: "前場で急騰後に出来高が細っている銘柄（後場に反落リスク）",
  },
  evening: {
    intro: "本日の取引を踏まえた明日へのおすすめです。",
    focus: "明日以降に仕込みたい銘柄",
    timeHorizon: "明日〜来週",
    keySignals: "週間トレンド・決算予定・セクタートレンドの方向性・ファンダメンタルズの強さ",
    actionContext: "明日以降の仕込みを検討する銘柄。今日の動きより中長期の視点で、投資スタイルに合った銘柄を厳選する",
    avoidSignals: "今日大きく動いた銘柄（翌日の反動リスク）・決算直前で不確実性が高い銘柄",
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
  dividendYield: number | null
  pbr: number | null
  per: number | null
  roe: number | null
  revenueGrowth: number | null
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
): ScoredStock[] {
  const style = investmentStyle || "BALANCED"
  const weights = SCORE_WEIGHTS[style] || SCORE_WEIGHTS["BALANCED"]

  // 安定配当型の場合はvolatilityを反転（低い方が良い）
  const isLowRisk = investmentStyle === "CONSERVATIVE"

  const normalized = {
    weekChangeRate: normalizeValues(stocks, "weekChangeRate"),
    volumeRatio: normalizeValues(stocks, "volumeRatio"),
    volatility: normalizeValues(stocks, "volatility", isLowRisk),
    marketCap: normalizeValues(stocks, "marketCap"),
  }

  const penalty = RISK_PENALTY[style] || -20
  const scoredStocks: ScoredStock[] = []

  for (const stock of stocks) {
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

    // 業績不明の銘柄へのペナルティ
    if (stock.isProfitable === null) {
      totalScore -= 5
      scoreBreakdown["unknownEarningsPenalty"] = -5
    }

    // セクタートレンドによるボーナス/ペナルティ
    if (sectorTrends && stock.sector && sectorTrends[stock.sector]) {
      const bonus = getSectorScoreBonus(sectorTrends[stock.sector])
      if (bonus !== 0) {
        totalScore += bonus
        scoreBreakdown["sectorTrendBonus"] = bonus
      }
    }

    // 投資観点に基づくボーナス/ペナルティ
    if (style === "CONSERVATIVE") {
      const pb = PERSPECTIVE_BONUS.CONSERVATIVE
      // 安定配当型: 配当 + バリュー + ディフェンシブ
      if (stock.dividendYield !== null) {
        if (stock.dividendYield >= 4) {
          totalScore += pb.HIGH_DIVIDEND
          scoreBreakdown["dividendBonus"] = pb.HIGH_DIVIDEND
        } else if (stock.dividendYield >= 2) {
          totalScore += pb.NORMAL_DIVIDEND
          scoreBreakdown["dividendBonus"] = pb.NORMAL_DIVIDEND
        } else {
          totalScore += pb.NO_DIVIDEND
          scoreBreakdown["dividendPenalty"] = pb.NO_DIVIDEND
        }
      }
      if (stock.pbr !== null) {
        if (stock.pbr < 1) {
          totalScore += pb.LOW_PBR
          scoreBreakdown["pbrBonus"] = pb.LOW_PBR
        } else if (stock.pbr < 1.5) {
          totalScore += pb.FAIR_PBR
          scoreBreakdown["pbrBonus"] = pb.FAIR_PBR
        } else if (stock.pbr > 3) {
          totalScore += pb.HIGH_PBR
          scoreBreakdown["pbrPenalty"] = pb.HIGH_PBR
        }
      }
      if (stock.per !== null && stock.per > 0 && stock.per < 15) {
        totalScore += pb.LOW_PER
        scoreBreakdown["perBonus"] = pb.LOW_PER
      }
      if (stock.isProfitable === true) {
        totalScore += pb.PROFITABLE
        scoreBreakdown["profitableBonus"] = pb.PROFITABLE
      }
    } else if (style === "BALANCED") {
      const pb = PERSPECTIVE_BONUS.BALANCED
      // 成長投資型: グロース + バリュー
      if (stock.revenueGrowth !== null) {
        if (stock.revenueGrowth >= 20) {
          totalScore += pb.HIGH_GROWTH
          scoreBreakdown["growthBonus"] = pb.HIGH_GROWTH
        } else if (stock.revenueGrowth >= 10) {
          totalScore += pb.MODERATE_GROWTH
          scoreBreakdown["growthBonus"] = pb.MODERATE_GROWTH
        } else if (stock.revenueGrowth < 0) {
          totalScore += pb.NEGATIVE_GROWTH
          scoreBreakdown["growthPenalty"] = pb.NEGATIVE_GROWTH
        }
      }
      if (stock.roe !== null) {
        if (stock.roe >= 15) {
          totalScore += pb.HIGH_ROE
          scoreBreakdown["roeBonus"] = pb.HIGH_ROE
        } else if (stock.roe >= 10) {
          totalScore += pb.GOOD_ROE
          scoreBreakdown["roeBonus"] = pb.GOOD_ROE
        }
      }
      if (stock.pbr !== null && stock.pbr < 1) {
        totalScore += pb.LOW_PBR
        scoreBreakdown["pbrBonus"] = pb.LOW_PBR
      }
      if (stock.per !== null && stock.per >= 15 && stock.per <= 30) {
        totalScore += pb.GROWTH_PER
        scoreBreakdown["perBonus"] = pb.GROWTH_PER
      }
    } else if (style === "AGGRESSIVE") {
      const pb = PERSPECTIVE_BONUS.AGGRESSIVE
      // アクティブ型: グロース + モメンタム
      if (stock.revenueGrowth !== null) {
        if (stock.revenueGrowth >= 20) {
          totalScore += pb.HIGH_GROWTH
          scoreBreakdown["growthBonus"] = pb.HIGH_GROWTH
        } else if (stock.revenueGrowth >= 10) {
          totalScore += pb.MODERATE_GROWTH
          scoreBreakdown["growthBonus"] = pb.MODERATE_GROWTH
        }
      }
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
