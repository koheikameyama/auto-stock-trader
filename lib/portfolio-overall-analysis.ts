import { prisma } from "@/lib/prisma"
import { Prisma } from "@prisma/client"
import { fetchStockPrices } from "@/lib/stock-price-fetcher"
import { calculatePortfolioFromTransactions } from "@/lib/portfolio-calculator"
import { getOpenAIClient } from "@/lib/openai"
import { buildPortfolioOverallAnalysisPrompt } from "@/lib/prompts/portfolio-overall-analysis-prompt"
import { getAllSectorTrends } from "@/lib/sector-trend"
import { getNikkei225Data, getSP500Data, getTrendDescription } from "@/lib/market-index"
import { getTodayForDB, getDaysAgoForDB } from "@/lib/date-utils"
import { getStyleLabel, DAILY_MARKET_NAVIGATOR } from "@/lib/constants"
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
    const sector = stock.sector || "その他"
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
    portfolioCount: portfolioStocks.length,
    totalValue,
    totalCost,
    unrealizedGain,
    unrealizedGainPercent,
    portfolioVolatility,
    sectorBreakdownText,
    portfolioStocksText,
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
    },
    required: ["sector", "avgDailyChange", "trendDirection", "compositeScore", "commentary"] as const,
    additionalProperties: false as const,
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
          properties: {
            marketHeadline: { type: "string" },
            marketTone: { type: "string", enum: ["bullish", "bearish", "neutral", "sector_rotation"] },
            marketKeyFactor: { type: "string" },
            portfolioStatus: { type: "string", enum: ["healthy", "caution", "warning", "critical"] },
            portfolioSummary: { type: "string" },
            actionPlan: { type: "string" },
            buddyMessage: { type: "string" },
            stockHighlights: {
              type: "array",
              items: stockHighlightSchema,
            },
            sectorHighlights: {
              type: "array",
              items: sectorHighlightSchema,
            },
          },
          required: ["marketHeadline", "marketTone", "marketKeyFactor", "portfolioStatus", "portfolioSummary", "actionPlan", "buddyMessage", "stockHighlights", "sectorHighlights"],
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
  }
}

/**
 * ユーザーのポートフォリオ総評分析を取得
 */
export async function getPortfolioOverallAnalysis(userId: string, session?: NavigatorSession): Promise<MarketNavigatorResult> {
  const resolvedSession = session ?? getCurrentSession()

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
  const totalCount = portfolioCount + watchlistCount

  // 最小銘柄数未満の場合
  if (totalCount < DAILY_MARKET_NAVIGATOR.MIN_STOCKS) {
    return {
      hasAnalysis: false,
      portfolioCount,
      watchlistCount,
    }
  }

  // 既存の分析があるか確認（複合ユニークキーで直接取得）
  const analysis = await prisma.portfolioOverallAnalysis.findUnique({
    where: { userId_session: { userId, session: resolvedSession } },
  })

  if (analysis) {
    const todayJST = dayjs().tz("Asia/Tokyo").startOf("day")
    const analysisJST = dayjs(analysis.analyzedAt).tz("Asia/Tokyo").startOf("day")
    const isToday = analysisJST.isSame(todayJST, "day")

    return {
      hasAnalysis: true,
      analyzedAt: analysis.analyzedAt.toISOString(),
      isToday,
      session: resolvedSession,
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
    }
  }

  // 分析がない場合
  return {
    hasAnalysis: false,
    portfolioCount,
    watchlistCount,
  }
}

/**
 * ポートフォリオ総評分析を生成
 */
export async function generatePortfolioOverallAnalysis(userId: string, session: NavigatorSession = "morning"): Promise<MarketNavigatorResult> {
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
  const totalCount = portfolioCount + watchlistCount

  // 最小銘柄数未満の場合
  if (totalCount < DAILY_MARKET_NAVIGATOR.MIN_STOCKS) {
    return {
      hasAnalysis: false,
      portfolioCount,
      watchlistCount,
    }
  }

  // 投資スタイルのラベルを取得
  const investmentStyleLabel = getStyleLabel(user.settings?.investmentStyle ?? null)

  // 株価を取得
  const allTickerCodes = [
    ...user.portfolioStocks.map(ps => ps.stock.tickerCode),
    ...user.watchlistStocks.map(ws => ws.stock.tickerCode),
  ]
  const { prices } = await fetchStockPrices(allTickerCodes)
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

  const todaySellTransactions = await prisma.transaction.findMany({
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

  // セクタートレンドを取得（ポートフォリオ内のセクターに絞り込み）
  const portfolioSectors = new Set(portfolioStocksData.map(s => s.sector || "その他"))
  const { trends: allSectorTrends } = await getAllSectorTrends()
  const relevantSectorTrends = allSectorTrends.filter(t => portfolioSectors.has(t.sector))

  const sectorTrendsText = relevantSectorTrends.length > 0
    ? relevantSectorTrends.map(t => {
        const daily = t.avgDailyChangeRate != null ? `日次平均 ${t.avgDailyChangeRate >= 0 ? "+" : ""}${t.avgDailyChangeRate.toFixed(1)}%` : ""
        const score = t.compositeScore != null ? `総合スコア ${t.compositeScore >= 0 ? "+" : ""}${t.compositeScore.toFixed(0)}` : ""
        const arrow = t.trendDirection === "up" ? "↑" : t.trendDirection === "down" ? "↓" : "→"
        return `- ${t.sector} ${arrow}: ${[daily, score].filter(Boolean).join(", ")}`
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
      select: { nasdaqClose: true, nasdaqChangeRate: true },
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
  if (preMarketData?.nasdaqClose) {
    const nasdaqChange = Number(preMarketData.nasdaqChangeRate)
    marketParts.push(`- NASDAQ: $${Number(preMarketData.nasdaqClose).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} / 前日比: ${nasdaqChange >= 0 ? "+" : ""}${nasdaqChange.toFixed(1)}%`)
  }
  if (marketParts.length > 0) {
    marketOverviewText = marketParts.join("\n")
  }

  // === ベンチマーク比較データ ===
  const benchmarkSnapshots = await prisma.portfolioSnapshot.findMany({
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
      portfolioAnalysisText,
      purchaseRecommendationText,
      soldStocksText,
      sectorTrendsText,
      upcomingEarningsText,
      benchmarkText,
      marketOverviewText,
    }
  )

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
    stockHighlights: aiResult.stockHighlights as unknown as Prisma.InputJsonValue,
    sectorHighlights: aiResult.sectorHighlights as unknown as Prisma.InputJsonValue,
  }
  await prisma.portfolioOverallAnalysis.upsert({
    where: { userId_session: { userId, session } },
    create: { userId, session, ...upsertData },
    update: upsertData,
  })

  return {
    hasAnalysis: true,
    analyzedAt: now.toISOString(),
    isToday: true,
    session,
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
      stockHighlights: aiResult.stockHighlights,
      sectorHighlights: aiResult.sectorHighlights,
    },
  }
}
