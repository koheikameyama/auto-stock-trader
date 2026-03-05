/**
 * スマートスイッチ: 含み損銘柄の乗り換え提案ロジック
 *
 * 含み損銘柄の「回復スコア」と、ウォッチリスト/おすすめ銘柄の「チャンススコア」を比較し、
 * 乗り換えが有利な場合に提案を生成する。
 */

import { prisma } from "@/lib/prisma"
import { SMART_SWITCH, getSectorGroup } from "@/lib/constants"
import { getTodayForDB } from "@/lib/date-utils"
import { calculatePortfolioFromTransactions } from "@/lib/portfolio-calculator"
import { getSectorTrend } from "@/lib/sector-trend"
import type { NavigatorSession } from "@/lib/portfolio-overall-analysis"

// ── 型定義 ──

interface PortfolioStockWithDetails {
  id: string
  stockId: string
  stock: {
    id: string
    name: string
    tickerCode: string
    sector: string | null
    latestPrice: { toNumber: () => number } | null
  }
  recommendation: string | null
  shortTerm: string | null
  mediumTerm: string | null
  longTerm: string | null
  transactions: Array<{
    type: string
    quantity: number
    price: { toNumber: () => number } | number
    transactionDate: Date
  }>
}

interface BuyCandidate {
  stockId: string
  stockName: string
  tickerCode: string
  sector: string | null
  recommendation: string
  confidence: number
  compositeScore: number | null
  shortTermTrend: string | null
  midTermTrend: string | null
  longTermTrend: string | null
}

interface SwitchProposalData {
  userId: string
  date: Date
  session: string
  sellStockId: string
  sellRecoveryScore: number
  buyStockId: string
  buyOpportunityScore: number
  switchBenefit: number
  reason: string
}

// ── スコア計算 ──

function trendScore(shortTerm: string | null, midTerm: string | null, longTerm: string | null): number {
  const score = (trend: string | null): number => {
    if (!trend) return 50
    if (trend === "up") return 90
    if (trend === "neutral") return 50
    return 10
  }
  return (score(shortTerm) + score(midTerm) + score(longTerm)) / 3
}

function sectorTrendScore(compositeScore: number | null, trendDirection: string | null): number {
  if (compositeScore === null) return 50
  // compositeScore: -100 ~ +100 → 0 ~ 100
  return Math.max(0, Math.min(100, (compositeScore + 100) / 2))
}

/**
 * 含み損銘柄の回復スコアを算出（0-100）
 * スコアが高いほど回復の見込みがある = 売却すべきでない
 */
export function calculateRecoveryScore(params: {
  lossRate: number
  aiRecommendation: string | null
  shortTerm: string | null
  midTerm: string | null
  longTerm: string | null
  sectorCompositeScore: number | null
  sectorTrendDirection: string | null
}): number {
  const w = SMART_SWITCH.RECOVERY_WEIGHTS

  // 含み損率の深さ → スコア（浅い損失=高スコア=回復容易）
  let lossDepthScore: number
  if (params.lossRate > -5) lossDepthScore = 80
  else if (params.lossRate > -15) lossDepthScore = 50
  else lossDepthScore = 20

  // AI分析結果
  let aiScore: number
  if (params.aiRecommendation === "buy") aiScore = 90
  else if (params.aiRecommendation === "hold") aiScore = 50
  else aiScore = 10

  // トレンド方向
  const trendDir = trendScore(params.shortTerm, params.midTerm, params.longTerm)

  // セクタートレンド
  const sectorScore = sectorTrendScore(params.sectorCompositeScore, params.sectorTrendDirection)

  return Math.round(
    lossDepthScore * w.LOSS_DEPTH +
    aiScore * w.AI_RECOMMENDATION +
    trendDir * w.TREND_DIRECTION +
    sectorScore * w.SECTOR_TREND
  )
}

/**
 * 購入候補銘柄のチャンススコアを算出（0-100）
 * スコアが高いほど購入チャンスがある
 */
export function calculateOpportunityScore(params: {
  recommendation: string
  confidence: number
  compositeScore: number | null
  shortTermTrend: string | null
  midTermTrend: string | null
  longTermTrend: string | null
  sectorCompositeScore: number | null
  sectorTrendDirection: string | null
}): number {
  const w = SMART_SWITCH.OPPORTUNITY_WEIGHTS

  // 購入判断結果
  let purchaseScore: number
  if (params.recommendation === "buy" && params.confidence >= 0.7) purchaseScore = 90
  else if (params.recommendation === "buy") purchaseScore = 70
  else purchaseScore = 30

  // compositeScore（銘柄スコア）
  const compScore = params.compositeScore !== null
    ? Math.max(0, Math.min(100, params.compositeScore))
    : 50

  // トレンド方向
  const trendDir = trendScore(params.shortTermTrend, params.midTermTrend, params.longTermTrend)

  // セクタートレンド
  const sectorScore = sectorTrendScore(params.sectorCompositeScore, params.sectorTrendDirection)

  return Math.round(
    purchaseScore * w.PURCHASE_JUDGMENT +
    compScore * w.COMPOSITE_SCORE +
    trendDir * w.TREND_DIRECTION +
    sectorScore * w.SECTOR_TREND
  )
}

/**
 * テンプレートベースの乗り換え理由を生成
 */
function generateSwitchReason(params: {
  sellStockName: string
  buyStockName: string
  lossRate: number
  recoveryScore: number
  opportunityScore: number
  sellSector: string | null
  buySector: string | null
}): string {
  const parts: string[] = []

  // 売却側の状況
  if (params.lossRate <= -15) {
    parts.push(`${params.sellStockName}は含み損が${params.lossRate.toFixed(1)}%と大きく、回復に時間がかかりそうです。`)
  } else {
    parts.push(`${params.sellStockName}は含み損${params.lossRate.toFixed(1)}%で、回復の勢いが弱まっています。`)
  }

  // 購入側の魅力
  if (params.opportunityScore >= 70) {
    parts.push(`一方、${params.buyStockName}は買いシグナルが出ており、上昇の勢いがあります。`)
  } else {
    parts.push(`一方、${params.buyStockName}には投資チャンスの兆しが見えています。`)
  }

  // セクター違いの場合
  if (params.sellSector && params.buySector && params.sellSector !== params.buySector) {
    parts.push(`セクターも${params.sellSector}から${params.buySector}へ移すことで、分散効果も期待できます。`)
  }

  parts.push("塩漬けの資金を動かすことで、リターン改善の可能性があります。")

  return parts.join("")
}

/**
 * ユーザーの乗り換え提案を生成
 */
export async function generateSwitchProposals(
  userId: string,
  session: NavigatorSession,
): Promise<SwitchProposalData[]> {
  const today = getTodayForDB()

  // 1. 含み損の保有銘柄を取得
  const portfolioStocks = await prisma.portfolioStock.findMany({
    where: { userId },
    include: {
      stock: true,
      transactions: {
        orderBy: { transactionDate: "asc" },
      },
    },
  })

  // 含み損銘柄を抽出
  const lossingStocks: Array<PortfolioStockWithDetails & { lossRate: number; currentPrice: number }> = []

  for (const ps of portfolioStocks) {
    const latestPrice = ps.stock.latestPrice ? Number(ps.stock.latestPrice) : null
    if (!latestPrice) continue

    const portfolio = calculatePortfolioFromTransactions(
      ps.transactions.map(t => ({
        type: t.type,
        quantity: t.quantity,
        price: t.price,
        transactionDate: t.transactionDate,
      }))
    )
    if (portfolio.quantity <= 0) continue

    const avgPrice = Number(portfolio.averagePurchasePrice)
    if (avgPrice <= 0) continue

    const lossRate = ((latestPrice - avgPrice) / avgPrice) * 100
    if (lossRate <= SMART_SWITCH.MIN_LOSS_RATE) {
      lossingStocks.push({
        ...ps as unknown as PortfolioStockWithDetails,
        lossRate,
        currentPrice: latestPrice,
      })
    }
  }

  if (lossingStocks.length === 0) return []

  // 2. ウォッチリストのbuy判定銘柄を取得
  const watchlistStocks = await prisma.watchlistStock.findMany({
    where: { userId },
    select: { stockId: true },
  })
  const watchlistStockIds = watchlistStocks.map(w => w.stockId)

  if (watchlistStockIds.length === 0) return []

  const buyRecommendations = await prisma.purchaseRecommendation.findMany({
    where: {
      stockId: { in: watchlistStockIds },
      date: today,
      recommendation: "buy",
    },
    include: {
      stock: true,
    },
  })

  if (buyRecommendations.length === 0) return []

  // 3. 各銘柄のセクタートレンドを取得（一括）
  const allSectors = new Set<string>()
  for (const ps of lossingStocks) {
    const sg = getSectorGroup(ps.stock.sector)
    if (sg) allSectors.add(sg)
  }
  for (const rec of buyRecommendations) {
    const sg = getSectorGroup(rec.stock.sector)
    if (sg) allSectors.add(sg)
  }

  const sectorTrends = new Map<string, { compositeScore: number | null; trendDirection: string }>()
  for (const sector of Array.from(allSectors)) {
    const trend = await getSectorTrend(sector)
    if (trend) {
      sectorTrends.set(sector, {
        compositeScore: trend.compositeScore,
        trendDirection: trend.trendDirection,
      })
    }
  }

  // 4. 最新のStockAnalysisを含み損銘柄ごとに取得
  const stockAnalyses = await prisma.stockAnalysis.findMany({
    where: {
      stockId: { in: lossingStocks.map(s => s.stockId) },
    },
    orderBy: { analyzedAt: "desc" },
    distinct: ["stockId"],
  })
  const analysisMap = new Map(stockAnalyses.map(a => [a.stockId, a]))

  // 5. スコア計算 + マッチング
  const proposals: SwitchProposalData[] = []

  for (const sellStock of lossingStocks) {
    const sellSectorGroup = getSectorGroup(sellStock.stock.sector)
    const sellSectorTrend = sellSectorGroup ? sectorTrends.get(sellSectorGroup) : null
    const sellAnalysis = analysisMap.get(sellStock.stockId)

    const recoveryScore = calculateRecoveryScore({
      lossRate: sellStock.lossRate,
      aiRecommendation: sellStock.recommendation,
      shortTerm: sellAnalysis?.shortTermTrend ?? null,
      midTerm: sellAnalysis?.midTermTrend ?? null,
      longTerm: sellAnalysis?.longTermTrend ?? null,
      sectorCompositeScore: sellSectorTrend?.compositeScore ?? null,
      sectorTrendDirection: sellSectorTrend?.trendDirection ?? null,
    })

    // 回復スコアが高い（回復見込みあり）ならスキップ
    if (recoveryScore >= 70) continue

    // 最適な購入候補を見つける
    let bestCandidate: { rec: typeof buyRecommendations[0]; score: number } | null = null

    for (const rec of buyRecommendations) {
      // 同じ銘柄はスキップ
      if (rec.stockId === sellStock.stockId) continue

      const buySectorGroup = getSectorGroup(rec.stock.sector)
      const buySectorTrend = buySectorGroup ? sectorTrends.get(buySectorGroup) : null

      // styleAnalysesからトレンド情報を取得
      const analysis = await prisma.stockAnalysis.findFirst({
        where: { stockId: rec.stockId },
        orderBy: { analyzedAt: "desc" },
      })

      const opportunityScore = calculateOpportunityScore({
        recommendation: rec.recommendation,
        confidence: rec.confidence,
        compositeScore: rec.userFitScore,
        shortTermTrend: analysis?.shortTermTrend ?? null,
        midTermTrend: analysis?.midTermTrend ?? null,
        longTermTrend: analysis?.longTermTrend ?? null,
        sectorCompositeScore: buySectorTrend?.compositeScore ?? null,
        sectorTrendDirection: buySectorTrend?.trendDirection ?? null,
      })

      const benefit = opportunityScore - recoveryScore
      if (benefit >= SMART_SWITCH.MIN_SWITCH_BENEFIT) {
        if (!bestCandidate || opportunityScore > bestCandidate.score) {
          bestCandidate = { rec, score: opportunityScore }
        }
      }
    }

    if (bestCandidate) {
      const buySectorGroup = getSectorGroup(bestCandidate.rec.stock.sector)

      proposals.push({
        userId,
        date: today,
        session,
        sellStockId: sellStock.stockId,
        sellRecoveryScore: recoveryScore,
        buyStockId: bestCandidate.rec.stockId,
        buyOpportunityScore: bestCandidate.score,
        switchBenefit: bestCandidate.score - recoveryScore,
        reason: generateSwitchReason({
          sellStockName: sellStock.stock.name,
          buyStockName: bestCandidate.rec.stock.name,
          lossRate: sellStock.lossRate,
          recoveryScore,
          opportunityScore: bestCandidate.score,
          sellSector: sellSectorGroup,
          buySector: buySectorGroup,
        }),
      })
    }
  }

  // 6. 上位N件に制限してDB保存
  const topProposals = proposals
    .sort((a, b) => b.switchBenefit - a.switchBenefit)
    .slice(0, SMART_SWITCH.MAX_PROPOSALS_PER_DAY)

  for (const p of topProposals) {
    await prisma.switchProposal.upsert({
      where: {
        userId_date_sellStockId: {
          userId: p.userId,
          date: p.date,
          sellStockId: p.sellStockId,
        },
      },
      create: p,
      update: {
        session: p.session,
        buyStockId: p.buyStockId,
        sellRecoveryScore: p.sellRecoveryScore,
        buyOpportunityScore: p.buyOpportunityScore,
        switchBenefit: p.switchBenefit,
        reason: p.reason,
      },
    })
  }

  return topProposals
}

/**
 * ユーザーの当日の乗り換え提案を取得
 */
export async function getSwitchProposals(userId: string) {
  const today = getTodayForDB()
  return prisma.switchProposal.findMany({
    where: { userId, date: today },
    orderBy: { switchBenefit: "desc" },
  })
}
