import { prisma } from "@/lib/prisma"
import { Prisma } from "@prisma/client"
import { fetchStockPrices } from "@/lib/stock-price-fetcher"
import { calculatePortfolioFromTransactions } from "@/lib/portfolio-calculator"
import { getOpenAIClient } from "@/lib/openai"
import { buildPortfolioOverallAnalysisPrompt } from "@/lib/prompts/portfolio-overall-analysis-prompt"
import { getAllSectorTrends } from "@/lib/sector-trend"
import { getNikkei225Data, getSP500Data, getTrendDescription } from "@/lib/market-index"
import { getTodayForDB, getDaysAgoForDB } from "@/lib/date-utils"
import { getStyleLabel, DAILY_MARKET_NAVIGATOR, getSectorGroup } from "@/lib/constants"
import dayjs from "dayjs"
import utc from "dayjs/plugin/utc"
import timezone from "dayjs/plugin/timezone"

dayjs.extend(utc)
dayjs.extend(timezone)

// ── 新しい型定義 ──

export type MarketTone = "bullish" | "bearish" | "neutral" | "sector_rotation"
export type PortfolioStatus = "healthy" | "caution" | "warning" | "critical"
export type NavigatorSession = "morning" | "pre-afternoon" | "evening"

export interface StockHighlight {
  stockId?: string
  userStockId?: string
  stockName: string
  tickerCode: string
  sector: string
  dailyChangeRate: number
  weekChangeRate: number
  analysis: string
  source: "portfolio" | "watchlist"
}

export interface SectorHighlight {
  sector: string
  avgDailyChange: number
  trendDirection: "up" | "down" | "neutral"
  compositeScore: number | null
  commentary: string
  watchlistStocks?: { stockName: string; tickerCode: string }[]
}

// ── イブニングレビュー型定義 ──

export interface TradeReviewItem {
  stockName: string
  tickerCode: string
  action: "buy" | "sell"
  evaluation: "excellent" | "good" | "neutral" | "questionable"
  comment: string
}

export interface MissedOpportunityItem {
  stockName: string
  tickerCode: string
  dailyChangeRate: number
  source: "watchlist" | "recommendation"
  comment: string
}

export interface EveningReview {
  tradeReview: {
    summary: string
    trades: TradeReviewItem[]
  }
  missedOpportunities: {
    summary: string
    stocks: MissedOpportunityItem[]
  }
  improvementSuggestion: {
    pattern: string
    suggestion: string
    encouragement: string
  }
}

export interface MarketNavigatorResult {
  hasAnalysis: boolean
  analyzedAt?: string
  isToday?: boolean
  session?: NavigatorSession
  market?: {
    headline: string
    tone: MarketTone
    keyFactor: string
  }
  portfolio?: {
    status: PortfolioStatus
    summary: string
    actionPlan: string
    metrics: {
      totalValue: number
      totalCost: number
      unrealizedGain: number
      unrealizedGainPercent: number
      portfolioVolatility: number | null
      sectorConcentration: number | null
      sectorCount: number | null
    }
  }
  buddyMessage?: string
  details?: {
    stockHighlights: StockHighlight[]
    sectorHighlights: SectorHighlight[]
  }
  eveningReview?: EveningReview
  hasPortfolio?: boolean
  portfolioCount?: number
  watchlistCount?: number
}

// ── 内部型 ──

interface SectorBreakdown {
  sector: string
  count: number
  value: number
  percentage: number
}

interface PortfolioStockData {
  stockId: string
  tickerCode: string
  name: string
  sector: string | null
  quantity: number
  averagePrice: number
  currentPrice: number
  value: number
  volatility: number | null
  // 業績データ
  isProfitable: boolean | null
  profitTrend: string | null
  revenueGrowth: number | null
  netIncomeGrowth: number | null
  eps: number | null
  // 日次データ
  dailyChangeRate: number | null
  weekChangeRate: number | null
  maDeviationRate: number | null
  volumeRatio: number | null
  nextEarningsDate: Date | null
}

/**
 * セクター構成を計算
 */
function calculateSectorBreakdown(stocks: PortfolioStockData[]): SectorBreakdown[] {
  const sectorMap = new Map<string, { count: number; value: number }>()
  const totalValue = stocks.reduce((sum, s) => sum + s.value, 0)

  for (const stock of stocks) {
    const sector = getSectorGroup(stock.sector) || stock.sector || "その他"
    const current = sectorMap.get(sector) || { count: 0, value: 0 }
    sectorMap.set(sector, {
      count: current.count + 1,
      value: current.value + stock.value,
    })
  }

  return Array.from(sectorMap.entries())
    .map(([sector, data]) => ({
      sector,
      count: data.count,
      value: data.value,
      percentage: totalValue > 0 ? (data.value / totalValue) * 100 : 0,
    }))
    .sort((a, b) => b.percentage - a.percentage)
}

/**
 * ポートフォリオ全体のボラティリティを計算（加重平均）
 */
function calculatePortfolioVolatility(stocks: PortfolioStockData[]): number | null {
  const totalValue = stocks.reduce((sum, s) => sum + s.value, 0)
  if (totalValue <= 0) return null

  let weightedVolatility = 0
  let hasVolatility = false

  for (const stock of stocks) {
    if (stock.volatility != null) {
      const weight = stock.value / totalValue
      weightedVolatility += stock.volatility * weight
      hasVolatility = true
    }
  }

  return hasVolatility ? weightedVolatility : null
}

/**
 * 現在のセッション（朝/夜）を判定
 * JST 15時以降は evening、それ以前は morning
 */
export function getCurrentSession(): NavigatorSession {
  const jst = dayjs().tz("Asia/Tokyo")
  const hour = jst.hour()
  const minute = jst.minute()
  if (hour >= DAILY_MARKET_NAVIGATOR.EVENING_SESSION_START_HOUR) return "evening"
  if (hour > 11 || (hour === 11 && minute >= 40)) return "pre-afternoon"
  return "morning"
}

/**
 * 当日の分析結果をDBから読み込んでテキスト化する
 */
async function buildAnalysisResultsContext(userId: string): Promise<{
  portfolioAnalysisText: string
  purchaseRecommendationText: string
}> {
  const todayForDB = getTodayForDB()

  // ポートフォリオ銘柄の分析結果（AI分析済みのもの）
  const portfolioStocks = await prisma.portfolioStock.findMany({
    where: { userId, lastAnalysis: { not: null } },
    select: {
      recommendation: true,
      shortTerm: true,
      sellReason: true,
      stock: { select: { name: true, tickerCode: true, sector: true } },
    },
  })

  const portfolioAnalysisLines = portfolioStocks.map(ps => {
    const rec = ps.recommendation ?? "不明"
    const short = ps.shortTerm ?? ""
    const sell = ps.sellReason ?? ""
    const detail = [short, sell].filter(Boolean).join(" / ")
    return `- ${ps.stock.name}（${ps.stock.tickerCode}）[${ps.stock.sector ?? "その他"}]: 推奨=${rec}${detail ? ` — ${detail}` : ""}`
  })

  const portfolioAnalysisText = portfolioAnalysisLines.length > 0
    ? portfolioAnalysisLines.join("\n")
    : "ポートフォリオ分析データなし（未分析）"

  // 購入判断の分析結果（当日分）
  const purchaseRecs = await prisma.purchaseRecommendation.findMany({
    where: { date: todayForDB },
    select: {
      recommendation: true,
      confidence: true,
      reason: true,
      stock: { select: { name: true, tickerCode: true } },
    },
  })

  const purchaseRecLines = purchaseRecs.map(pr => {
    const conf = Math.round(pr.confidence * 100)
    return `- ${pr.stock.name}（${pr.stock.tickerCode}）: ${pr.recommendation}（確信度${conf}%） — ${pr.reason}`
  })

  const purchaseRecommendationText = purchaseRecLines.length > 0
    ? purchaseRecLines.join("\n")
    : "購入判断データなし（未分析）"

  return { portfolioAnalysisText, purchaseRecommendationText }
}

/**
 * OpenAI APIで Daily Market Navigator 分析を生成
 */
async function generateAnalysisWithAI(
  session: NavigatorSession,
  portfolioStocks: PortfolioStockData[],
  sectorBreakdown: SectorBreakdown[],
  totalValue: number,
  totalCost: number,
  unrealizedGain: number,
  unrealizedGainPercent: number,
  portfolioVolatility: number | null,
  investmentStyle: string,
  dailyContext: {
    portfolioAnalysisText: string
    purchaseRecommendationText: string
    soldStocksText: string
    sectorTrendsText: string
    upcomingEarningsText: string
    benchmarkText: string
    marketOverviewText: string
    watchlistStocksText: string
    hasPortfolio: boolean
    watchlistCount: number
    // evening review用データ
    todayBuyTransactionsText?: string
    missedOpportunityText?: string
    behavioralPatternText?: string
  }
): Promise<{
  marketHeadline: string
  marketTone: MarketTone
  marketKeyFactor: string
  portfolioStatus: PortfolioStatus
  portfolioSummary: string
  actionPlan: string
  buddyMessage: string
  stockHighlights: StockHighlight[]
  sectorHighlights: SectorHighlight[]
  eveningReview?: EveningReview
}> {
  const openai = getOpenAIClient()

  const sectorBreakdownText = sectorBreakdown
    .map(s => `${s.sector}: ${s.percentage.toFixed(1)}%（${s.count}銘柄）`)
    .join("\n")

  const formatEarningsInfo = (s: { isProfitable: boolean | null; profitTrend: string | null; netIncomeGrowth: number | null; eps: number | null }) => {
    if (s.isProfitable === null) return ""
    const status = s.isProfitable ? "黒字" : "⚠️赤字"
    const trend = s.profitTrend === "increasing" ? "増益" : s.profitTrend === "decreasing" ? "減益" : "横ばい"
    const growth = s.netIncomeGrowth !== null ? `${s.netIncomeGrowth >= 0 ? "+" : ""}${s.netIncomeGrowth.toFixed(1)}%` : ""
    const epsInfo = s.eps !== null ? `EPS: ¥${s.eps.toFixed(2)}` : ""
    return `【業績: ${status}・${trend}${growth ? `（前年比${growth}）` : ""}${epsInfo ? ` / ${epsInfo}` : ""}】`
  }

  // リスクフィルタリング: 赤字銘柄を特定
  const unprofitablePortfolioStocks = portfolioStocks.filter(s => s.isProfitable === false)

  const portfolioStocksText = portfolioStocks
    .map(s => `- ${s.name}（${s.tickerCode}）: ${s.sector || "その他"}、評価額 ¥${Math.round(s.value).toLocaleString()} ${formatEarningsInfo(s)}`)
    .join("\n")

  // 業績サマリー
  const profitableCount = portfolioStocks.filter(s => s.isProfitable === true).length
  const increasingCount = portfolioStocks.filter(s => s.profitTrend === "increasing").length
  const decreasingCount = portfolioStocks.filter(s => s.profitTrend === "decreasing").length
  const hasEarningsData = portfolioStocks.some(s => s.isProfitable !== null)

  const prompt = buildPortfolioOverallAnalysisPrompt({
    session,
    hasPortfolio: dailyContext.hasPortfolio,
    portfolioCount: portfolioStocks.length,
    watchlistCount: dailyContext.watchlistCount,
    totalValue,
    totalCost,
    unrealizedGain,
    unrealizedGainPercent,
    portfolioVolatility,
    sectorBreakdownText,
    portfolioStocksText,
    watchlistStocksText: dailyContext.watchlistStocksText,
    hasEarningsData,
    profitableCount,
    increasingCount,
    decreasingCount,
    unprofitablePortfolioNames: unprofitablePortfolioStocks.map(s => s.name),
    investmentStyle,
    portfolioAnalysisText: dailyContext.portfolioAnalysisText,
    purchaseRecommendationText: dailyContext.purchaseRecommendationText,
    soldStocksText: dailyContext.soldStocksText,
    sectorTrendsText: dailyContext.sectorTrendsText,
    upcomingEarningsText: dailyContext.upcomingEarningsText,
    benchmarkText: dailyContext.benchmarkText,
    marketOverviewText: dailyContext.marketOverviewText,
    todayBuyTransactionsText: dailyContext.todayBuyTransactionsText,
    missedOpportunityText: dailyContext.missedOpportunityText,
    behavioralPatternText: dailyContext.behavioralPatternText,
  })

  // StockHighlight のスキーマ定義
  const stockHighlightSchema = {
    type: "object" as const,
    properties: {
      stockName: { type: "string" as const },
      tickerCode: { type: "string" as const },
      sector: { type: "string" as const },
      dailyChangeRate: { type: "number" as const },
      weekChangeRate: { type: "number" as const },
      analysis: { type: "string" as const },
      source: { type: "string" as const, enum: ["portfolio", "watchlist"] },
    },
    required: ["stockName", "tickerCode", "sector", "dailyChangeRate", "weekChangeRate", "analysis", "source"] as const,
    additionalProperties: false as const,
  }

  // SectorHighlight のスキーマ定義
  const sectorHighlightSchema = {
    type: "object" as const,
    properties: {
      sector: { type: "string" as const },
      avgDailyChange: { type: "number" as const },
      trendDirection: { type: "string" as const, enum: ["up", "down", "neutral"] },
      compositeScore: { type: ["number", "null"] as const },
      commentary: { type: "string" as const },
      watchlistStocks: {
        type: "array" as const,
        items: {
          type: "object" as const,
          properties: {
            stockName: { type: "string" as const },
            tickerCode: { type: "string" as const },
          },
          required: ["stockName", "tickerCode"] as const,
          additionalProperties: false as const,
        },
      },
    },
    required: ["sector", "avgDailyChange", "trendDirection", "compositeScore", "commentary", "watchlistStocks"] as const,
    additionalProperties: false as const,
  }

  // Evening Review スキーマ（evening セッション限定）
  const eveningReviewSchema = {
    type: "object" as const,
    properties: {
      tradeReview: {
        type: "object" as const,
        properties: {
          summary: { type: "string" as const },
          trades: {
            type: "array" as const,
            items: {
              type: "object" as const,
              properties: {
                stockName: { type: "string" as const },
                tickerCode: { type: "string" as const },
                action: { type: "string" as const, enum: ["buy", "sell"] },
                evaluation: { type: "string" as const, enum: ["excellent", "good", "neutral", "questionable"] },
                comment: { type: "string" as const },
              },
              required: ["stockName", "tickerCode", "action", "evaluation", "comment"] as const,
              additionalProperties: false as const,
            },
          },
        },
        required: ["summary", "trades"] as const,
        additionalProperties: false as const,
      },
      missedOpportunities: {
        type: "object" as const,
        properties: {
          summary: { type: "string" as const },
          stocks: {
            type: "array" as const,
            items: {
              type: "object" as const,
              properties: {
                stockName: { type: "string" as const },
                tickerCode: { type: "string" as const },
                dailyChangeRate: { type: "number" as const },
                source: { type: "string" as const, enum: ["watchlist", "recommendation"] },
                comment: { type: "string" as const },
              },
              required: ["stockName", "tickerCode", "dailyChangeRate", "source", "comment"] as const,
              additionalProperties: false as const,
            },
          },
        },
        required: ["summary", "stocks"] as const,
        additionalProperties: false as const,
      },
      improvementSuggestion: {
        type: "object" as const,
        properties: {
          pattern: { type: "string" as const },
          suggestion: { type: "string" as const },
          encouragement: { type: "string" as const },
        },
        required: ["pattern", "suggestion", "encouragement"] as const,
        additionalProperties: false as const,
      },
    },
    required: ["tradeReview", "missedOpportunities", "improvementSuggestion"] as const,
    additionalProperties: false as const,
  }

  const baseProperties: Record<string, unknown> = {
    marketHeadline: { type: "string" },
    marketTone: { type: "string", enum: ["bullish", "bearish", "neutral", "sector_rotation"] },
    marketKeyFactor: { type: "string" },
    portfolioStatus: { type: "string", enum: ["healthy", "caution", "warning", "critical"] },
    portfolioSummary: { type: "string" },
    actionPlan: { type: "string" },
    buddyMessage: { type: "string" },
    stockHighlights: { type: "array", items: stockHighlightSchema },
    sectorHighlights: { type: "array", items: sectorHighlightSchema },
  }
  const baseRequired = ["marketHeadline", "marketTone", "marketKeyFactor", "portfolioStatus", "portfolioSummary", "actionPlan", "buddyMessage", "stockHighlights", "sectorHighlights"]

  if (session === "evening") {
    baseProperties.eveningReview = eveningReviewSchema
    baseRequired.push("eveningReview")
  }

  const response = await openai.chat.completions.create({
    model: DAILY_MARKET_NAVIGATOR.OPENAI_MODEL,
    messages: [
      {
        role: "system",
        content: session === "evening"
          ? `あなたはStock Buddyの「アナリスト兼コーチ」です。
投資初心者のパートナーとして、今日の市場を振り返り、ユーザーのポートフォリオを点検し、明日の準備を手伝ってください。

【重要】提供されたデータのみを使用し、ニュースや決算情報など提供されていない情報は創作しないでください。`
          : `あなたはStock Buddyの「Daily Market Navigator」です。
投資初心者のパートナーとして、市場の流れとユーザーのポートフォリオを分析し、今日何をすべきかを結論から伝えてください。

【重要】提供されたデータのみを使用し、ニュースや決算情報など提供されていない情報は創作しないでください。`,
      },
      {
        role: "user",
        content: prompt,
      },
    ],
    temperature: DAILY_MARKET_NAVIGATOR.OPENAI_TEMPERATURE,
    response_format: {
      type: "json_schema",
      json_schema: {
        name: "daily_market_navigator",
        strict: true,
        schema: {
          type: "object",
          properties: baseProperties,
          required: baseRequired,
          additionalProperties: false,
        },
      },
    },
  })

  const content = response.choices[0]?.message?.content
  if (!content) {
    throw new Error("OpenAI response is empty")
  }

  const result = JSON.parse(content)

  return {
    marketHeadline: result.marketHeadline,
    marketTone: result.marketTone,
    marketKeyFactor: result.marketKeyFactor,
    portfolioStatus: result.portfolioStatus,
    portfolioSummary: result.portfolioSummary,
    actionPlan: result.actionPlan,
    buddyMessage: result.buddyMessage,
    stockHighlights: result.stockHighlights || [],
    sectorHighlights: result.sectorHighlights || [],
    eveningReview: session === "evening" ? result.eveningReview : undefined,
  }
}

/**
 * ユーザーのポートフォリオ総評分析を取得
 */
export async function getPortfolioOverallAnalysis(userId: string, session?: NavigatorSession): Promise<MarketNavigatorResult> {
  // ポートフォリオとウォッチリストを取得
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      portfolioStocks: {
        include: {
          stock: true,
          transactions: {
            orderBy: { transactionDate: "asc" },
          },
        },
      },
      watchlistStocks: {
        include: {
          stock: true,
        },
      },
    },
  })

  if (!user) {
    return { hasAnalysis: false }
  }

  const portfolioCount = user.portfolioStocks.filter((ps) => {
    const { quantity } = calculatePortfolioFromTransactions(ps.transactions)
    return quantity > 0
  }).length
  const watchlistCount = user.watchlistStocks.length
  const hasPortfolio = portfolioCount > 0

  // sessionが指定されている場合はそのセッションのデータを取得
  // 指定なしの場合は当日の最新分析を取得
  let analysis
  if (session) {
    analysis = await prisma.portfolioOverallAnalysis.findUnique({
      where: { userId_session: { userId, session } },
    })
  } else {
    analysis = await prisma.portfolioOverallAnalysis.findFirst({
      where: { userId },
      orderBy: { analyzedAt: "desc" },
    })
  }

  if (analysis) {
    const todayJST = dayjs().tz("Asia/Tokyo").startOf("day")
    const analysisJST = dayjs(analysis.analyzedAt).tz("Asia/Tokyo").startOf("day")
    const isToday = analysisJST.isSame(todayJST, "day")

    return {
      hasAnalysis: true,
      analyzedAt: analysis.analyzedAt.toISOString(),
      isToday,
      session: analysis.session as NavigatorSession,
      portfolioCount,
      watchlistCount,
      market: {
        headline: analysis.marketHeadline,
        tone: analysis.marketTone as MarketTone,
        keyFactor: analysis.marketKeyFactor,
      },
      portfolio: {
        status: analysis.portfolioStatus as PortfolioStatus,
        summary: analysis.portfolioSummary,
        actionPlan: analysis.actionPlan,
        metrics: {
          totalValue: analysis.totalValue ? Number(analysis.totalValue) : 0,
          totalCost: analysis.totalCost ? Number(analysis.totalCost) : 0,
          unrealizedGain: analysis.unrealizedGain ? Number(analysis.unrealizedGain) : 0,
          unrealizedGainPercent: analysis.unrealizedGainPercent ? Number(analysis.unrealizedGainPercent) : 0,
          portfolioVolatility: analysis.portfolioVolatility ? Number(analysis.portfolioVolatility) : null,
          sectorConcentration: analysis.sectorConcentration ? Number(analysis.sectorConcentration) : null,
          sectorCount: analysis.sectorCount,
        },
      },
      buddyMessage: analysis.buddyMessage,
      details: {
        stockHighlights: analysis.stockHighlights as unknown as StockHighlight[],
        sectorHighlights: analysis.sectorHighlights as unknown as SectorHighlight[],
      },
      eveningReview: analysis.eveningReview
        ? analysis.eveningReview as unknown as EveningReview
        : undefined,
      hasPortfolio,
    }
  }

  // 分析がない場合
  return {
    hasAnalysis: false,
    hasPortfolio,
    portfolioCount,
    watchlistCount,
  }
}

/**
 * ポートフォリオ総評分析を生成
 */
export async function generatePortfolioOverallAnalysis(userId: string, session: NavigatorSession = "morning"): Promise<MarketNavigatorResult> {
  // morningセッション開始時にマーケットシールドの期限切れを自動解除
  if (session === "morning") {
    try {
      const { autoDeactivateExpiredShields } = await import("@/lib/market-shield")
      await autoDeactivateExpiredShields()
    } catch (e) {
      console.error("マーケットシールド自動解除エラー:", e)
    }
  }

  // ポートフォリオ、ウォッチリスト、ユーザー設定を取得
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      portfolioStocks: {
        include: {
          stock: true,
          transactions: {
            orderBy: { transactionDate: "asc" },
          },
        },
      },
      watchlistStocks: {
        include: {
          stock: true,
        },
      },
      settings: {
        select: {
          investmentStyle: true,
        },
      },
    },
  })

  if (!user) {
    return { hasAnalysis: false }
  }

  const portfolioCount = user.portfolioStocks.filter((ps) => {
    const { quantity } = calculatePortfolioFromTransactions(ps.transactions)
    return quantity > 0
  }).length
  const watchlistCount = user.watchlistStocks.length
  const hasPortfolio = portfolioCount > 0

  // 投資スタイルのラベルを取得
  const investmentStyleLabel = getStyleLabel(user.settings?.investmentStyle ?? null)

  // 株価を取得（銘柄がある場合のみ）
  const allTickerCodes = [
    ...user.portfolioStocks.map(ps => ps.stock.tickerCode),
    ...user.watchlistStocks.map(ws => ws.stock.tickerCode),
  ]
  const prices = allTickerCodes.length > 0 ? (await fetchStockPrices(allTickerCodes)).prices : []
  const priceMap = new Map(prices.map(p => [p.tickerCode, p.currentPrice]))

  // ポートフォリオデータを構築
  const portfolioStocksData: PortfolioStockData[] = []
  let totalValue = 0
  let totalCost = 0

  for (const ps of user.portfolioStocks) {
    const { quantity, averagePurchasePrice } = calculatePortfolioFromTransactions(ps.transactions)
    if (quantity <= 0) continue

    const currentPrice = priceMap.get(ps.stock.tickerCode) ?? 0
    const value = currentPrice * quantity
    const cost = averagePurchasePrice.toNumber() * quantity

    portfolioStocksData.push({
      stockId: ps.stockId,
      tickerCode: ps.stock.tickerCode,
      name: ps.stock.name,
      sector: ps.stock.sector,
      quantity,
      averagePrice: averagePurchasePrice.toNumber(),
      currentPrice,
      value,
      volatility: ps.stock.volatility ? Number(ps.stock.volatility) : null,
      isProfitable: ps.stock.isProfitable ?? null,
      profitTrend: ps.stock.profitTrend ?? null,
      revenueGrowth: ps.stock.revenueGrowth ? Number(ps.stock.revenueGrowth) : null,
      netIncomeGrowth: ps.stock.netIncomeGrowth ? Number(ps.stock.netIncomeGrowth) : null,
      eps: ps.stock.eps ? Number(ps.stock.eps) : null,
      dailyChangeRate: ps.stock.dailyChangeRate ? Number(ps.stock.dailyChangeRate) : null,
      weekChangeRate: ps.stock.weekChangeRate ? Number(ps.stock.weekChangeRate) : null,
      maDeviationRate: ps.stock.maDeviationRate ? Number(ps.stock.maDeviationRate) : null,
      volumeRatio: ps.stock.volumeRatio ? Number(ps.stock.volumeRatio) : null,
      nextEarningsDate: ps.stock.nextEarningsDate ?? null,
    })

    totalValue += value
    totalCost += cost
  }

  // 指標を計算
  const sectorBreakdown = calculateSectorBreakdown(portfolioStocksData)
  const portfolioVolatility = calculatePortfolioVolatility(portfolioStocksData)
  const unrealizedGain = totalValue - totalCost
  const unrealizedGainPercent = totalCost > 0 ? (unrealizedGain / totalCost) * 100 : 0
  const maxSectorConcentration = sectorBreakdown.length > 0 ? sectorBreakdown[0].percentage : 0

  // === 日次コメンタリー用データ収集 ===

  // 本日の売却取引を取得
  const todayForDB = getTodayForDB()
  const tomorrowForDB = new Date(todayForDB.getTime() + 86400000)

  const todaySellTransactions = !hasPortfolio ? [] : await prisma.transaction.findMany({
    where: {
      portfolioStock: { userId },
      type: "sell",
      transactionDate: {
        gte: todayForDB,
        lt: tomorrowForDB,
      },
    },
    include: {
      stock: true,
      portfolioStock: {
        include: {
          transactions: {
            orderBy: { transactionDate: "asc" },
          },
        },
      },
    },
  })

  // 分析結果をDBから取得（集約型ナビゲーター用）
  const { portfolioAnalysisText, purchaseRecommendationText } = await buildAnalysisResultsContext(userId)

  const soldStocksText = todaySellTransactions.length > 0
    ? todaySellTransactions.map(tx => {
        const avgPrice = tx.portfolioStock
          ? calculatePortfolioFromTransactions(tx.portfolioStock.transactions).averagePurchasePrice.toNumber()
          : 0
        const sellPrice = Number(tx.price)
        const profitLoss = avgPrice > 0 ? ((sellPrice - avgPrice) / avgPrice * 100).toFixed(1) : "不明"
        const firstBuy = tx.portfolioStock?.transactions.find(t => t.type === "buy")
        const holdingDays = firstBuy
          ? Math.round((tx.transactionDate.getTime() - firstBuy.transactionDate.getTime()) / 86400000)
          : 0
        return `- ${tx.stock.name}（${tx.stock.tickerCode}）: 売却価格 ¥${sellPrice.toLocaleString()}, 平均取得 ¥${avgPrice.toLocaleString()}, 損益 ${profitLoss}%, 保有日数 ${holdingDays}日, ${tx.quantity}株`
      }).join("\n")
    : "本日の売却取引はありません"

  // === イブニングレビュー用データ（evening セッション限定） ===
  let todayBuyTransactionsText: string | undefined
  let missedOpportunityText: string | undefined
  let behavioralPatternText: string | undefined

  if (session === "evening") {
    // 本日の買い取引
    const todayBuyTransactions = !hasPortfolio ? [] : await prisma.transaction.findMany({
      where: {
        portfolioStock: { userId },
        type: "buy",
        transactionDate: { gte: todayForDB, lt: tomorrowForDB },
      },
      include: { stock: true },
    })

    todayBuyTransactionsText = todayBuyTransactions.length > 0
      ? todayBuyTransactions.map(tx =>
          `- ${tx.stock.name}（${tx.stock.tickerCode}）: ¥${Number(tx.price).toLocaleString()} x ${tx.quantity}株`
        ).join("\n")
      : "本日の買い取引はありません"

    // 機会損失データ: 気になるリストの急騰銘柄
    const portfolioStockIds = new Set(user.portfolioStocks.map(ps => ps.stockId))
    const watchlistMoves = user.watchlistStocks
      .filter(ws => {
        const dailyChange = ws.stock.dailyChangeRate ? Number(ws.stock.dailyChangeRate) : 0
        return dailyChange >= DAILY_MARKET_NAVIGATOR.MISSED_OPPORTUNITY_DAILY_CHANGE_THRESHOLD
      })
      .map(ws => `- ${ws.stock.name}（${ws.stock.tickerCode}）: 日次+${Number(ws.stock.dailyChangeRate).toFixed(1)}%${ws.stock.weekChangeRate ? `（週間${Number(ws.stock.weekChangeRate) >= 0 ? "+" : ""}${Number(ws.stock.weekChangeRate).toFixed(1)}%）` : ""}`)
      .slice(0, DAILY_MARKET_NAVIGATOR.MAX_MISSED_OPPORTUNITY_STOCKS)

    // AI推奨したが未購入の銘柄（直近7日間）
    const recentBuyRecs = await prisma.userDailyRecommendation.findMany({
      where: {
        userId,
        date: { gte: getDaysAgoForDB(DAILY_MARKET_NAVIGATOR.MISSED_OPPORTUNITY_REC_LOOKBACK_DAYS) },
        purchaseJudgment: "buy",
      },
      include: { stock: true },
    })
    const missedRecs = recentBuyRecs
      .filter(rec => !portfolioStockIds.has(rec.stockId))
      .filter(rec => {
        const dailyChange = rec.stock.dailyChangeRate ? Number(rec.stock.dailyChangeRate) : 0
        return dailyChange > 0
      })
      .map(rec => `- ${rec.stock.name}（${rec.stock.tickerCode}）: AI推奨（buy）→ 現在日次+${Number(rec.stock.dailyChangeRate).toFixed(1)}%`)
      .slice(0, DAILY_MARKET_NAVIGATOR.MAX_MISSED_OPPORTUNITY_STOCKS)

    const missedParts: string[] = []
    if (watchlistMoves.length > 0) missedParts.push(`気になるリストの急騰銘柄（本日+${DAILY_MARKET_NAVIGATOR.MISSED_OPPORTUNITY_DAILY_CHANGE_THRESHOLD}%以上）:\n${watchlistMoves.join("\n")}`)
    if (missedRecs.length > 0) missedParts.push(`AI推奨したが未購入の上昇銘柄:\n${missedRecs.join("\n")}`)
    missedOpportunityText = missedParts.length > 0 ? missedParts.join("\n\n") : "該当する機会損失銘柄はありません"

    // 行動パターン統計（全売却済み銘柄）
    let winCount = 0, loseCount = 0
    const holdingDaysList: number[] = []
    const returnRates: number[] = []
    const earlyProfitCases: string[] = []
    const lateStopLossCases: string[] = []

    for (const ps of user.portfolioStocks) {
      const { quantity } = calculatePortfolioFromTransactions(ps.transactions)
      if (quantity > 0) continue

      const buyTxs = ps.transactions.filter(t => t.type === "buy")
      const sellTxs = ps.transactions.filter(t => t.type === "sell")
      if (buyTxs.length === 0 || sellTxs.length === 0) continue

      const totalBuyAmount = buyTxs.reduce((sum, t) => sum + Number(t.totalAmount), 0)
      const totalSellAmount = sellTxs.reduce((sum, t) => sum + Number(t.totalAmount), 0)
      const profit = totalSellAmount - totalBuyAmount
      const returnRate = totalBuyAmount > 0 ? (profit / totalBuyAmount) * 100 : 0

      if (profit >= 0) winCount++
      else loseCount++
      returnRates.push(returnRate)

      const firstBuyDate = buyTxs[0].transactionDate
      const lastSellDate = sellTxs[sellTxs.length - 1].transactionDate
      const days = Math.round((lastSellDate.getTime() - firstBuyDate.getTime()) / 86400000)
      holdingDaysList.push(days)

      // 早期利確検出
      if (returnRate > 0 && returnRate < DAILY_MARKET_NAVIGATOR.EARLY_PROFIT_TAKING_THRESHOLD) {
        const currentPrice = priceMap.get(ps.stock.tickerCode) ?? 0
        const lastSellPrice = Number(sellTxs[sellTxs.length - 1].price)
        if (currentPrice > lastSellPrice * DAILY_MARKET_NAVIGATOR.EARLY_PROFIT_TAKING_CONTINUED_RISE) {
          earlyProfitCases.push(ps.stock.name)
        }
      }

      // 損切り遅延検出
      if (returnRate < DAILY_MARKET_NAVIGATOR.LATE_STOP_LOSS_THRESHOLD) {
        lateStopLossCases.push(ps.stock.name)
      }
    }

    const soldCount = winCount + loseCount
    if (soldCount > 0) {
      const winRate = ((winCount / soldCount) * 100).toFixed(0)
      const avgReturn = (returnRates.reduce((a, b) => a + b, 0) / returnRates.length).toFixed(1)
      const avgHoldingDays = holdingDaysList.length > 0
        ? Math.round(holdingDaysList.reduce((a, b) => a + b, 0) / holdingDaysList.length)
        : 0

      const patternParts = [
        `- 勝敗: ${winCount}勝${loseCount}敗（勝率${winRate}%）`,
        `- 平均リターン: ${avgReturn}%`,
        `- 平均保有日数: ${avgHoldingDays}日`,
      ]
      if (earlyProfitCases.length > 0) patternParts.push(`- 利確が早い傾向の銘柄（小幅利益で売却後、さらに上昇）: ${earlyProfitCases.join("、")}`)
      if (lateStopLossCases.length > 0) patternParts.push(`- 損切りが遅い傾向の銘柄（${DAILY_MARKET_NAVIGATOR.LATE_STOP_LOSS_THRESHOLD}%以上の損失）: ${lateStopLossCases.join("、")}`)
      behavioralPatternText = patternParts.join("\n")
    } else {
      behavioralPatternText = "売却済み銘柄がないため、行動パターンの分析はできません"
    }
  }

  // 気になるリストをセクター別にグルーピング
  const watchlistBySector = new Map<string, { name: string; tickerCode: string }[]>()
  for (const ws of user.watchlistStocks) {
    const sector = getSectorGroup(ws.stock.sector) || ws.stock.sector || "その他"
    if (!watchlistBySector.has(sector)) watchlistBySector.set(sector, [])
    watchlistBySector.get(sector)!.push({ name: ws.stock.name, tickerCode: ws.stock.tickerCode })
  }

  // 気になるリスト銘柄のテキスト
  const watchlistStocksText = user.watchlistStocks.length > 0
    ? user.watchlistStocks.map(ws => {
        const price = priceMap.get(ws.stock.tickerCode)
        const dailyChange = ws.stock.dailyChangeRate ? Number(ws.stock.dailyChangeRate) : null
        const weekChange = ws.stock.weekChangeRate ? Number(ws.stock.weekChangeRate) : null
        return `- ${ws.stock.name}（${ws.stock.tickerCode}）: ${ws.stock.sector || "その他"}${price ? `, ¥${Math.round(price).toLocaleString()}` : ""}${dailyChange !== null ? `, 日次${dailyChange >= 0 ? "+" : ""}${dailyChange.toFixed(1)}%` : ""}${weekChange !== null ? `, 週間${weekChange >= 0 ? "+" : ""}${weekChange.toFixed(1)}%` : ""}`
      }).join("\n")
    : "気になるリスト銘柄なし"

  // セクタートレンドを取得（ポートフォリオセクター＋注目セクター）
  const portfolioSectors = new Set(portfolioStocksData.map(s => getSectorGroup(s.sector) || s.sector || "その他"))
  const { trends: allSectorTrends } = await getAllSectorTrends()
  const relevantSectorTrends = hasPortfolio
    ? allSectorTrends.filter(t =>
        portfolioSectors.has(t.sector) ||
        (t.compositeScore !== null && Math.abs(t.compositeScore) >= 20)
      ).slice(0, DAILY_MARKET_NAVIGATOR.MAX_SECTOR_TRENDS_FOR_AI)
    : allSectorTrends.slice(0, DAILY_MARKET_NAVIGATOR.MAX_SECTOR_TRENDS_FOR_AI)

  const sectorTrendsText = relevantSectorTrends.length > 0
    ? relevantSectorTrends.map(t => {
        const daily = t.avgDailyChangeRate != null ? `日次平均 ${t.avgDailyChangeRate >= 0 ? "+" : ""}${t.avgDailyChangeRate.toFixed(1)}%` : ""
        const score = t.compositeScore != null ? `総合スコア ${t.compositeScore >= 0 ? "+" : ""}${t.compositeScore.toFixed(0)}` : ""
        const arrow = t.trendDirection === "up" ? "↑" : t.trendDirection === "down" ? "↓" : "→"
        const watchlistInSector = watchlistBySector.get(t.sector)
        const watchlistNote = watchlistInSector
          ? ` [気になるリスト: ${watchlistInSector.map(s => s.name).join("、")}]`
          : ""
        return `- ${t.sector} ${arrow}: ${[daily, score].filter(Boolean).join(", ")}${watchlistNote}`
      }).join("\n")
    : "セクタートレンドデータなし"

  // 今後7日間の決算予定
  const sevenDaysLater = new Date(todayForDB.getTime() + 7 * 86400000)
  const allStocksWithEarnings = [
    ...portfolioStocksData.map(s => ({ name: s.name, tickerCode: s.tickerCode, nextEarningsDate: s.nextEarningsDate })),
    ...user.watchlistStocks
      .filter(ws => ws.stock.nextEarningsDate != null)
      .map(ws => ({ name: ws.stock.name, tickerCode: ws.stock.tickerCode, nextEarningsDate: ws.stock.nextEarningsDate })),
  ]
  const upcomingEarnings = allStocksWithEarnings.filter(
    s => s.nextEarningsDate && s.nextEarningsDate >= todayForDB && s.nextEarningsDate <= sevenDaysLater
  )
  const upcomingEarningsText = upcomingEarnings.length > 0
    ? upcomingEarnings.map(s => `- ${s.name}（${s.tickerCode}）: ${dayjs(s.nextEarningsDate).format("MM/DD")}`).join("\n")
    : "今後7日間に決算予定の銘柄はありません"

  // === 市場概況データ（日経・NY市場） ===
  const [nikkeiData, sp500Data, preMarketData] = await Promise.all([
    getNikkei225Data(),
    getSP500Data(),
    prisma.preMarketData.findFirst({
      where: { date: todayForDB },
      select: {
        nikkeiFuturesClose: true, nikkeiFuturesChangeRate: true,
        nasdaqClose: true, nasdaqChangeRate: true,
        vixClose: true, vixChangeRate: true,
        wtiClose: true, wtiChangeRate: true,
      },
    }),
  ])

  let marketOverviewText = "データなし"
  const marketParts: string[] = []
  if (nikkeiData) {
    marketParts.push(`- 日経225: ¥${Math.round(nikkeiData.currentPrice).toLocaleString()} / 週間変動: ${nikkeiData.weekChangeRate >= 0 ? "+" : ""}${nikkeiData.weekChangeRate.toFixed(1)}% / トレンド: ${getTrendDescription(nikkeiData.trend)}`)
  }
  if (sp500Data) {
    marketParts.push(`- S&P 500: $${sp500Data.currentPrice.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} / 週間変動: ${sp500Data.weekChangeRate >= 0 ? "+" : ""}${sp500Data.weekChangeRate.toFixed(1)}% / トレンド: ${getTrendDescription(sp500Data.trend)}`)
  }
  if (preMarketData?.nikkeiFuturesClose) {
    const futuresChange = Number(preMarketData.nikkeiFuturesChangeRate)
    const futuresSignal = futuresChange >= 1.0 ? "（強い強気シグナル）" : futuresChange >= 0.3 ? "（強気シグナル）" : futuresChange <= -1.0 ? "（強い弱気シグナル）" : futuresChange <= -0.3 ? "（弱気シグナル）" : ""
    marketParts.push(`- CME日経先物: $${Number(preMarketData.nikkeiFuturesClose).toLocaleString()} / 前日比: ${futuresChange >= 0 ? "+" : ""}${futuresChange.toFixed(1)}%${futuresSignal}`)
  }
  if (preMarketData?.nasdaqClose) {
    const nasdaqChange = Number(preMarketData.nasdaqChangeRate)
    marketParts.push(`- NASDAQ: $${Number(preMarketData.nasdaqClose).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} / 前日比: ${nasdaqChange >= 0 ? "+" : ""}${nasdaqChange.toFixed(1)}%`)
  }
  if (preMarketData?.vixClose) {
    const vixChange = Number(preMarketData.vixChangeRate)
    const vixLevel = Number(preMarketData.vixClose) >= 30 ? "(高リスク)" : Number(preMarketData.vixClose) >= 25 ? "(やや高リスク)" : Number(preMarketData.vixClose) >= 20 ? "(通常)" : "(低リスク)"
    marketParts.push(`- VIX（恐怖指数）: ${Number(preMarketData.vixClose).toFixed(2)} ${vixLevel} / 前日比: ${vixChange >= 0 ? "+" : ""}${vixChange.toFixed(1)}%`)
  }
  if (preMarketData?.wtiClose) {
    const wtiChange = Number(preMarketData.wtiChangeRate)
    marketParts.push(`- WTI原油: $${Number(preMarketData.wtiClose).toFixed(2)}/バレル / 前日比: ${wtiChange >= 0 ? "+" : ""}${wtiChange.toFixed(1)}%`)
  }
  if (marketParts.length > 0) {
    marketOverviewText = marketParts.join("\n")
  }

  // === ベンチマーク比較データ ===（ポートフォリオがある場合のみ）
  const benchmarkSnapshots = !hasPortfolio ? [] : await prisma.portfolioSnapshot.findMany({
    where: {
      userId,
      date: { gte: getDaysAgoForDB(30) },
      nikkeiClose: { not: null },
    },
    orderBy: { date: "asc" },
    select: { totalValue: true, nikkeiClose: true, sp500Close: true },
  })

  let benchmarkText = "データなし"
  if (benchmarkSnapshots.length >= 2) {
    const firstValue = Number(benchmarkSnapshots[0].totalValue)
    const lastValue = Number(benchmarkSnapshots[benchmarkSnapshots.length - 1].totalValue)
    const firstNikkei = Number(benchmarkSnapshots[0].nikkeiClose)
    const lastNikkei = Number(benchmarkSnapshots[benchmarkSnapshots.length - 1].nikkeiClose)

    if (firstValue > 0 && firstNikkei > 0) {
      const portfolioReturn = ((lastValue - firstValue) / firstValue) * 100
      const nikkeiReturn = ((lastNikkei - firstNikkei) / firstNikkei) * 100
      const excessReturn = portfolioReturn - nikkeiReturn

      // ベータ値計算
      const dailyPortfolioReturns: number[] = []
      const dailyNikkeiReturns: number[] = []
      for (let i = 1; i < benchmarkSnapshots.length; i++) {
        const pv = Number(benchmarkSnapshots[i - 1].totalValue)
        const cv = Number(benchmarkSnapshots[i].totalValue)
        const pn = Number(benchmarkSnapshots[i - 1].nikkeiClose)
        const cn = Number(benchmarkSnapshots[i].nikkeiClose)
        if (pv > 0 && pn > 0) {
          dailyPortfolioReturns.push((cv - pv) / pv)
          dailyNikkeiReturns.push((cn - pn) / pn)
        }
      }

      let beta: number | null = null
      if (dailyPortfolioReturns.length >= 10) {
        const n = dailyPortfolioReturns.length
        const avgP = dailyPortfolioReturns.reduce((a, b) => a + b, 0) / n
        const avgN = dailyNikkeiReturns.reduce((a, b) => a + b, 0) / n
        let cov = 0, varN = 0
        for (let i = 0; i < n; i++) {
          cov += (dailyPortfolioReturns[i] - avgP) * (dailyNikkeiReturns[i] - avgN)
          varN += (dailyNikkeiReturns[i] - avgN) ** 2
        }
        beta = varN > 0 ? (cov / n) / (varN / n) : null
      }

      const benchmarkLines = [
        `- 日経225リターン（直近1ヶ月）: ${nikkeiReturn >= 0 ? "+" : ""}${nikkeiReturn.toFixed(1)}%`,
        `- ポートフォリオリターン（直近1ヶ月）: ${portfolioReturn >= 0 ? "+" : ""}${portfolioReturn.toFixed(1)}%`,
        `- 超過リターン（vs日経225）: ${excessReturn >= 0 ? "+" : ""}${excessReturn.toFixed(1)}%（日経平均を${excessReturn >= 0 ? "上回って" : "下回って"}いる）`,
        beta !== null ? `- ベータ値: ${beta.toFixed(2)}（${beta < 1 ? "市場より穏やかに変動" : "市場より激しく変動"}）` : null,
      ]

      // S&P 500ベンチマーク比較
      const sp500WithData = benchmarkSnapshots.filter(s => s.sp500Close !== null)
      if (sp500WithData.length >= 2) {
        const firstSP500 = Number(sp500WithData[0].sp500Close)
        const lastSP500 = Number(sp500WithData[sp500WithData.length - 1].sp500Close)
        if (firstSP500 > 0) {
          const sp500Return = ((lastSP500 - firstSP500) / firstSP500) * 100
          benchmarkLines.push(`- S&P 500リターン（直近1ヶ月）: ${sp500Return >= 0 ? "+" : ""}${sp500Return.toFixed(1)}%`)
        }
      }

      benchmarkText = benchmarkLines.filter(Boolean).join("\n")
    }
  }

  // AI分析を生成
  const aiResult = await generateAnalysisWithAI(
    session,
    portfolioStocksData,
    sectorBreakdown,
    totalValue,
    totalCost,
    unrealizedGain,
    unrealizedGainPercent,
    portfolioVolatility,
    investmentStyleLabel,
    {
      portfolioAnalysisText: hasPortfolio ? portfolioAnalysisText : "ポートフォリオ未登録",
      purchaseRecommendationText,
      soldStocksText: hasPortfolio ? soldStocksText : "ポートフォリオ未登録のため売却データなし",
      sectorTrendsText,
      upcomingEarningsText,
      benchmarkText: hasPortfolio ? benchmarkText : "ポートフォリオ未登録のためベンチマーク比較なし",
      marketOverviewText,
      watchlistStocksText,
      hasPortfolio,
      watchlistCount,
      todayBuyTransactionsText,
      missedOpportunityText,
      behavioralPatternText,
    }
  )

  // stockHighlightsにstockId・userStockIdを付与
  const tickerToStockId = new Map<string, string>()
  const tickerToUserStockId = new Map<string, string>()
  for (const ps of user.portfolioStocks) {
    tickerToStockId.set(ps.stock.tickerCode, ps.stockId)
    tickerToUserStockId.set(ps.stock.tickerCode, ps.id)
  }
  for (const ws of user.watchlistStocks) {
    tickerToStockId.set(ws.stock.tickerCode, ws.stockId)
    tickerToUserStockId.set(ws.stock.tickerCode, ws.id)
  }
  const enrichedStockHighlights = aiResult.stockHighlights.map(sh => ({
    ...sh,
    stockId: tickerToStockId.get(sh.tickerCode),
    userStockId: tickerToUserStockId.get(sh.tickerCode),
  }))

  // マーケットシールド: トリガーチェック＆発動
  try {
    const { checkMarketShieldTriggers, activateMarketShield, isMarketShieldActive } = await import("@/lib/market-shield")
    const trigger = await checkMarketShieldTriggers()
    if (trigger) {
      await activateMarketShield(trigger.type, trigger.value)
      console.log(`⚠️ マーケットシールド発動: ${trigger.description}`)
    }
    // Shield発動中はmarketToneをbearishに強制、actionPlanに防御メッセージを追加
    if (await isMarketShieldActive()) {
      aiResult.marketTone = "bearish"
      aiResult.actionPlan = `⚠️ マーケットシールド発動中: 市場急変が検知されました。新規購入推奨は一時停止し、撤退ラインを引き上げています。\n\n${aiResult.actionPlan}`
    }
  } catch (e) {
    console.error("マーケットシールドチェックエラー:", e)
  }

  // DBに保存
  const now = dayjs().toDate()
  const upsertData = {
    analyzedAt: now,
    sectorConcentration: maxSectorConcentration,
    sectorCount: sectorBreakdown.length,
    totalValue,
    totalCost,
    unrealizedGain,
    unrealizedGainPercent,
    portfolioVolatility,
    marketHeadline: aiResult.marketHeadline,
    marketTone: aiResult.marketTone,
    marketKeyFactor: aiResult.marketKeyFactor,
    portfolioStatus: aiResult.portfolioStatus,
    portfolioSummary: aiResult.portfolioSummary,
    actionPlan: aiResult.actionPlan,
    buddyMessage: aiResult.buddyMessage,
    stockHighlights: enrichedStockHighlights as unknown as Prisma.InputJsonValue,
    sectorHighlights: aiResult.sectorHighlights as unknown as Prisma.InputJsonValue,
    ...(session === "evening" && aiResult.eveningReview
      ? { eveningReview: aiResult.eveningReview as unknown as Prisma.InputJsonValue }
      : {}),
  }
  await prisma.portfolioOverallAnalysis.upsert({
    where: { userId_session: { userId, session } },
    create: { userId, session, ...upsertData },
    update: upsertData,
  })

  // スマートスイッチ: 乗り換え提案を生成
  try {
    const { generateSwitchProposals } = await import("@/lib/smart-switch")
    await generateSwitchProposals(userId, session)
  } catch (e) {
    console.error("スマートスイッチ生成エラー:", e)
  }

  return {
    hasAnalysis: true,
    analyzedAt: now.toISOString(),
    isToday: true,
    session,
    hasPortfolio,
    portfolioCount,
    watchlistCount,
    market: {
      headline: aiResult.marketHeadline,
      tone: aiResult.marketTone,
      keyFactor: aiResult.marketKeyFactor,
    },
    portfolio: {
      status: aiResult.portfolioStatus,
      summary: aiResult.portfolioSummary,
      actionPlan: aiResult.actionPlan,
      metrics: {
        totalValue,
        totalCost,
        unrealizedGain,
        unrealizedGainPercent,
        portfolioVolatility,
        sectorConcentration: maxSectorConcentration,
        sectorCount: sectorBreakdown.length,
      },
    },
    buddyMessage: aiResult.buddyMessage,
    details: {
      stockHighlights: enrichedStockHighlights,
      sectorHighlights: aiResult.sectorHighlights,
    },
    eveningReview: aiResult.eveningReview,
  }
}
