import { prisma } from "@/lib/prisma"
import { getDaysAgoForDB } from "@/lib/date-utils"
import { calculatePortfolioFromTransactions } from "@/lib/portfolio-calculator"
import dayjs from "dayjs"
import utc from "dayjs/plugin/utc"
import timezone from "dayjs/plugin/timezone"

dayjs.extend(utc)
dayjs.extend(timezone)

export type { NewsItem } from "@/lib/news-utils"
export { getRelativeTime, getMarketFlag } from "@/lib/news-utils"
import type { NewsItem } from "@/lib/news-utils"

export interface GetNewsOptions {
  limit?: number
  market?: "JP" | "US" | "ALL"
  userId?: string // 保有銘柄との関連付け用
  daysAgo?: number
  category?: "impact" | "all"
}

// セクターマッピング（米国→日本）
const US_TO_JP_SECTOR_MAP: Record<string, string[]> = {
  "半導体・電子部品": ["半導体・電子部品", "Technology", "Semiconductor"],
  自動車: ["自動車", "Automotive", "EV"],
  金融: ["金融", "Financial", "Banking"],
  医薬品: ["医薬品", "Healthcare", "Pharma"],
  "IT・サービス": ["IT・サービス", "Technology", "Software"],
  エネルギー: ["エネルギー", "Energy"],
  通信: ["通信", "Telecom"],
  小売: ["小売", "Retail"],
  不動産: ["不動産", "Real Estate"],
  素材: ["素材", "Materials"],
}

/**
 * ニュース一覧を取得する
 */
export async function getNews(options: GetNewsOptions = {}): Promise<NewsItem[]> {
  const { limit = 20, market = "ALL", daysAgo = 7, category } = options

  const cutoffDate = dayjs().subtract(daysAgo, "day").toDate()

  const whereClause: Record<string, unknown> = {
    publishedAt: {
      gte: cutoffDate,
    },
  }

  if (market !== "ALL") {
    whereClause.market = market
  }

  if (category === "impact") {
    whereClause.category = { in: ["geopolitical", "macro"] }
  }

  const news = await prisma.marketNews.findMany({
    where: whereClause,
    orderBy: {
      publishedAt: "desc",
    },
    take: limit,
  })

  return news.map((n) => ({
    id: n.id,
    title: n.title,
    content: n.content,
    url: n.url,
    source: n.source,
    sector: n.sector,
    sentiment: n.sentiment,
    publishedAt: n.publishedAt,
    market: n.market,
    region: n.region,
    category: n.category,
    impactSectors: n.impactSectors,
    impactDirection: n.impactDirection,
    impactSummary: n.impactSummary,
  }))
}

/**
 * ユーザーの保有銘柄に関連するニュースを取得する
 */
export async function getNewsWithRelatedStocks(
  userId: string,
  options: GetNewsOptions = {}
): Promise<NewsItem[]> {
  const { limit = 10, market = "ALL", daysAgo = 7, category } = options

  // ユーザーの保有銘柄を取得
  const portfolioStocks = await prisma.portfolioStock.findMany({
    where: { userId },
    include: {
      stock: true,
      transactions: {
        select: { type: true, quantity: true, price: true },
      },
    },
  })

  // ウォッチリストも取得
  const watchlistStocks = await prisma.watchlistStock.findMany({
    where: { userId },
    include: {
      stock: true,
    },
  })

  // 保有数が0の銘柄を除外
  const activePortfolioStocks = portfolioStocks.filter((ps) => {
    const { quantity } = calculatePortfolioFromTransactions(ps.transactions);
    return quantity > 0;
  })

  // 全銘柄のセクターを収集
  const userStocks = [
    ...activePortfolioStocks.map((ps) => ps.stock),
    ...watchlistStocks.map((w) => w.stock),
  ]

  const userSectors = new Set<string>()
  const userTickerCodes = new Set<string>()

  for (const stock of userStocks) {
    if (stock.sector) {
      userSectors.add(stock.sector)
    }
    userTickerCodes.add(stock.tickerCode)
  }

  // ニュースを取得
  const cutoffDate = dayjs().subtract(daysAgo, "day").toDate()

  const whereClause: Record<string, unknown> = {
    publishedAt: {
      gte: cutoffDate,
    },
  }

  if (market !== "ALL") {
    whereClause.market = market
  }

  if (category === "impact") {
    whereClause.category = { in: ["geopolitical", "macro"] }
  }

  const allNews = await prisma.marketNews.findMany({
    where: whereClause,
    orderBy: {
      publishedAt: "desc",
    },
    take: limit * 3, // 多めに取得してフィルタリング
  })

  // ニュースと銘柄の関連付け
  const newsWithRelations: NewsItem[] = []

  for (const news of allNews) {
    const relatedStocks: { id: string; name: string; tickerCode: string }[] = []

    // 1. 日本ニュース：銘柄コードで直接マッチ
    if (news.market === "JP") {
      for (const stock of userStocks) {
        if (news.content.includes(stock.tickerCode)) {
          relatedStocks.push({
            id: stock.id,
            name: stock.name,
            tickerCode: stock.tickerCode,
          })
        }
      }
    }

    // 2. 米国ニュース：セクターでマッチ
    if (news.market === "US" && news.sector) {
      // 米国セクターを日本セクターにマッピング
      const matchedJpSectors: string[] = []
      for (const [jpSector, usSectors] of Object.entries(US_TO_JP_SECTOR_MAP)) {
        if (usSectors.some((s) => news.sector?.includes(s))) {
          matchedJpSectors.push(jpSector)
        }
      }

      // ユーザーの銘柄でセクターが一致するものを検索
      for (const stock of userStocks) {
        if (stock.sector && matchedJpSectors.includes(stock.sector)) {
          relatedStocks.push({
            id: stock.id,
            name: stock.name,
            tickerCode: stock.tickerCode,
          })
        }
      }
    }

    // セクターでのマッチ（日本ニュース）
    if (news.market === "JP" && news.sector && relatedStocks.length === 0) {
      for (const stock of userStocks) {
        if (stock.sector === news.sector) {
          relatedStocks.push({
            id: stock.id,
            name: stock.name,
            tickerCode: stock.tickerCode,
          })
        }
      }
    }

    newsWithRelations.push({
      id: news.id,
      title: news.title,
      content: news.content,
      url: news.url,
      source: news.source,
      sector: news.sector,
      sentiment: news.sentiment,
      publishedAt: news.publishedAt,
      market: news.market,
      region: news.region,
      category: news.category,
      impactSectors: news.impactSectors,
      impactDirection: news.impactDirection,
      impactSummary: news.impactSummary,
      relatedStocks: relatedStocks.length > 0 ? relatedStocks : undefined,
    })
  }

  // 関連銘柄があるニュースを優先してソート
  newsWithRelations.sort((a, b) => {
    const aHasRelation = a.relatedStocks ? 1 : 0
    const bHasRelation = b.relatedStocks ? 1 : 0
    if (aHasRelation !== bHasRelation) {
      return bHasRelation - aHasRelation
    }
    return b.publishedAt.getTime() - a.publishedAt.getTime()
  })

  return newsWithRelations.slice(0, limit)
}

/**
 * ダッシュボード用のニュースを取得（関連銘柄付き）
 */
export async function getDashboardNews(
  userId: string,
  limit: number = 5
): Promise<NewsItem[]> {
  return getNewsWithRelatedStocks(userId, {
    limit,
    market: "ALL",
    daysAgo: 3,
  })
}

/**
 * ダッシュボード用の地政学・マクロニュースを取得
 */
export async function getGeopoliticalNews(limit: number = 5): Promise<NewsItem[]> {
  const cutoffDate = getDaysAgoForDB(3)

  const news = await prisma.marketNews.findMany({
    where: {
      category: { in: ["geopolitical", "macro"] },
      publishedAt: { gte: cutoffDate },
    },
    select: {
      id: true,
      title: true,
      sentiment: true,
      category: true,
      impactSectors: true,
      impactDirection: true,
      impactSummary: true,
      publishedAt: true,
      market: true,
    },
    orderBy: {
      publishedAt: "desc",
    },
    take: limit,
  })

  return news.map((n) => ({
    id: n.id,
    title: n.title,
    content: "",
    url: null,
    source: "",
    sector: null,
    sentiment: n.sentiment,
    publishedAt: n.publishedAt,
    market: n.market,
    region: null,
    category: n.category,
    impactSectors: n.impactSectors,
    impactDirection: n.impactDirection,
    impactSummary: n.impactSummary,
  }))
}
