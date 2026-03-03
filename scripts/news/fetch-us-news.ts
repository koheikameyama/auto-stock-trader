#!/usr/bin/env npx tsx
/**
 * 米国株式関連ニュースを取得してMarketNewsテーブルに保存するスクリプト
 *
 * 機能:
 * - Google News RSSから米国株式関連ニュースを取得
 * - セクター・センチメント分析（ルールベース + AI）
 * - 地政学・マクロニュースの市場インパクト分析
 * - MarketNewsテーブルへの保存（market="US"）
 */

import { PrismaClient } from "@prisma/client"
import OpenAI from "openai"
import Parser from "rss-parser"

const prisma = new PrismaClient()
const parser = new Parser()
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY })

// セクターenum値
const SECTOR_VALUES = [
  "半導体・電子部品",
  "自動車",
  "金融",
  "医薬品",
  "通信",
  "小売",
  "不動産",
  "エネルギー",
  "素材",
  "IT・サービス",
] as const

type SectorValue = (typeof SECTOR_VALUES)[number]

// 米国ニュースソースURL
const RSS_URLS: Record<string, string> = {
  // 主要指数
  google_news_sp500:
    "https://news.google.com/rss/search?q=S%26P500+OR+stock+market+when:2d&hl=en&gl=US&ceid=US:en",
  google_news_nasdaq:
    "https://news.google.com/rss/search?q=NASDAQ+OR+tech+stocks+when:2d&hl=en&gl=US&ceid=US:en",
  // 金融政策
  google_news_fomc:
    "https://news.google.com/rss/search?q=FOMC+OR+Federal+Reserve+interest+rate+when:2d&hl=en&gl=US&ceid=US:en",
  // 半導体（日本株への影響大）
  google_news_semiconductor:
    "https://news.google.com/rss/search?q=semiconductor+stocks+NVIDIA+AMD+Intel+when:2d&hl=en&gl=US&ceid=US:en",
  // 自動車・EV
  google_news_ev:
    "https://news.google.com/rss/search?q=Tesla+OR+EV+stocks+OR+electric+vehicle+when:2d&hl=en&gl=US&ceid=US:en",
  // 決算関連
  google_news_earnings:
    "https://news.google.com/rss/search?q=earnings+report+stocks+when:2d&hl=en&gl=US&ceid=US:en",
  // 地政学リスク
  google_news_geopolitical: `https://news.google.com/rss/search?q=${encodeURIComponent("tariff OR sanctions OR geopolitical OR war OR conflict")}&hl=en-US&gl=US&ceid=US:en`,
  // マクロ経済
  google_news_macro: `https://news.google.com/rss/search?q=${encodeURIComponent("Fed rate OR interest rate OR inflation OR monetary policy")}&hl=en-US&gl=US&ceid=US:en`,
}

// セクター分類キーワード（英語→日本語セクターへのマッピング）
const SECTOR_KEYWORDS: Record<string, string[]> = {
  "半導体・電子部品": [
    "semiconductor",
    "chip",
    "NVIDIA",
    "AMD",
    "Intel",
    "TSMC",
    "memory",
    "DRAM",
    "GPU",
  ],
  自動車: [
    "Tesla",
    "EV",
    "electric vehicle",
    "automotive",
    "car",
    "GM",
    "Ford",
  ],
  金融: [
    "bank",
    "financial",
    "JPMorgan",
    "Goldman",
    "interest rate",
    "Fed",
    "FOMC",
  ],
  医薬品: ["pharma", "drug", "biotech", "FDA", "Pfizer", "Moderna", "vaccine"],
  "IT・サービス": [
    "tech",
    "software",
    "cloud",
    "AI",
    "artificial intelligence",
    "Microsoft",
    "Apple",
    "Google",
    "Meta",
    "Amazon",
  ],
  エネルギー: ["oil", "energy", "gas", "renewable", "solar", "Exxon", "Chevron"],
}

// センチメント分類キーワード
const SENTIMENT_KEYWORDS: Record<string, string[]> = {
  positive: [
    "surge",
    "rally",
    "gain",
    "rise",
    "jump",
    "soar",
    "beat",
    "exceed",
    "bullish",
    "record high",
    "upgrade",
  ],
  negative: [
    "drop",
    "fall",
    "decline",
    "plunge",
    "crash",
    "miss",
    "bearish",
    "downgrade",
    "concern",
    "warning",
    "sell-off",
  ],
  neutral: ["flat", "steady", "unchanged", "mixed", "hold", "wait"],
}

interface RssEntry {
  title: string
  link: string
  contentSnippet?: string
  pubDate?: string
}

interface AIAnalysisResult {
  sector: string | null
  sentiment: string | null
  isStockRelated: boolean
  isMarketImpact: boolean
  category: "stock" | "geopolitical" | "macro"
  impactSectors: SectorValue[]
  impactDirection: "positive" | "negative" | "mixed" | null
  impactSummary: string | null
}

function detectSectorByKeywords(text: string): string | null {
  const textLower = text.toLowerCase()

  for (const [sector, keywords] of Object.entries(SECTOR_KEYWORDS)) {
    for (const keyword of keywords) {
      if (textLower.includes(keyword.toLowerCase())) {
        return sector
      }
    }
  }

  return null
}

function detectSentimentByKeywords(text: string): string | null {
  const textLower = text.toLowerCase()

  for (const [sentiment, keywords] of Object.entries(SENTIMENT_KEYWORDS)) {
    for (const keyword of keywords) {
      if (textLower.includes(keyword.toLowerCase())) {
        return sentiment
      }
    }
  }

  return null
}

async function analyzeWithOpenAI(
  title: string,
  content: string
): Promise<AIAnalysisResult> {
  const defaultResult: AIAnalysisResult = {
    sector: null,
    sentiment: null,
    isStockRelated: true,
    isMarketImpact: false,
    category: "stock",
    impactSectors: [],
    impactDirection: null,
    impactSummary: null,
  }

  try {
    if (!process.env.OPENAI_API_KEY) {
      console.log("OPENAI_API_KEY not found, skipping AI analysis")
      return defaultResult
    }

    const prompt = `Analyze the following US market news.

Title: ${title}
Content: ${content}

Determine the following items:
1. is_stock_related: Whether this news is related to stocks, investments, or financial markets (true/false)
   - News about stock prices, corporate earnings, market trends, economic indicators, monetary policy → true
   - News about sports, entertainment, crime, weather, etc. unrelated to stock markets → false
2. sector (Japanese): 半導体・電子部品, 自動車, 金融, 医薬品, 通信, 小売, 不動産, エネルギー, 素材, IT・サービス, or null
3. sentiment: positive, neutral, negative, or null
4. is_market_impact: Whether this news could impact the overall stock market (true/false)
   - Geopolitical risks (tariffs, sanctions, war, conflict, US-China tensions) → true
   - Macroeconomic news (monetary policy, rate hikes/cuts, inflation, GDP) → true
   - Individual company earnings or performance only → false
   - News affecting overall market trends → true
5. category: Classification of the news
   - "stock": News about individual stocks or sectors
   - "geopolitical": Geopolitical risk news (tariffs, sanctions, war, conflict, diplomacy)
   - "macro": Macroeconomic news (monetary policy, exchange rates, interest rates, economic indicators)
6. impact_sectors: If there is market impact, array of affected sectors (in Japanese)
   - Sector values: 半導体・電子部品, 自動車, 金融, 医薬品, 通信, 小売, 不動産, エネルギー, 素材, IT・サービス
   - Empty array [] if no impact or unknown
7. impact_direction: Direction of market impact
   - "positive": Positive impact on stock prices
   - "negative": Negative impact on stock prices
   - "mixed": Both positive and negative impacts
   - null: Unknown or not applicable
8. impact_summary: Explanation of market impact (in Japanese, 1-2 sentences)
   - Only fill in when is_market_impact=true
   - Example: "米中関税引き上げにより、輸出関連セクター（自動車・半導体）に下落圧力。"
   - null when is_market_impact=false`

    const sectorEnumValues = [...SECTOR_VALUES, null]

    const response = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: prompt }],
      temperature: 0.3,
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "news_analysis",
          strict: true,
          schema: {
            type: "object",
            properties: {
              is_stock_related: { type: "boolean" },
              sector: {
                type: ["string", "null"],
                enum: sectorEnumValues,
              },
              sentiment: {
                type: ["string", "null"],
                enum: ["positive", "neutral", "negative", null],
              },
              is_market_impact: { type: "boolean" },
              category: {
                type: "string",
                enum: ["stock", "geopolitical", "macro"],
              },
              impact_sectors: {
                type: "array",
                items: {
                  type: "string",
                  enum: [...SECTOR_VALUES],
                },
              },
              impact_direction: {
                type: ["string", "null"],
                enum: ["positive", "negative", "mixed", null],
              },
              impact_summary: { type: ["string", "null"] },
            },
            required: [
              "is_stock_related",
              "sector",
              "sentiment",
              "is_market_impact",
              "category",
              "impact_sectors",
              "impact_direction",
              "impact_summary",
            ],
            additionalProperties: false,
          },
        },
      },
    })

    const result = JSON.parse(response.choices[0].message.content || "{}")
    return {
      sector: result.sector || null,
      sentiment: result.sentiment || null,
      isStockRelated: result.is_stock_related ?? true,
      isMarketImpact: result.is_market_impact ?? false,
      category: result.category ?? "stock",
      impactSectors: Array.isArray(result.impact_sectors) ? result.impact_sectors : [],
      impactDirection: result.impact_direction ?? null,
      impactSummary: result.impact_summary ?? null,
    }
  } catch (error) {
    console.log(`OpenAI API error: ${error}`)
    return defaultResult
  }
}

async function fetchRssFeed(url: string): Promise<RssEntry[]> {
  try {
    console.log(`Fetching RSS from ${url}`)
    const feed = await parser.parseURL(url)

    const entries: RssEntry[] = feed.items.map((item) => ({
      title: item.title || "",
      link: item.link || "",
      contentSnippet: item.contentSnippet || "",
      pubDate: item.pubDate || "",
    }))

    console.log(`Fetched ${entries.length} entries`)
    return entries
  } catch (error) {
    console.log(`Error fetching RSS: ${error}`)
    return []
  }
}

function filterRecentEntries(
  entries: RssEntry[],
  days: number = 2
): RssEntry[] {
  const cutoffDate = new Date()
  cutoffDate.setDate(cutoffDate.getDate() - days)

  return entries.filter((entry) => {
    if (!entry.pubDate) return false
    const entryDate = new Date(entry.pubDate)
    return entryDate >= cutoffDate
  })
}

async function main(): Promise<void> {
  console.log("=".repeat(60))
  console.log("US Market News Fetch Script")
  console.log("=".repeat(60))

  const newsToSave: {
    title: string
    content: string
    url: string
    source: string
    sector: string | null
    sentiment: string | null
    publishedAt: Date
    market: string
    region: string
    category: string
    impactSectors: string | null
    impactDirection: string | null
    impactSummary: string | null
  }[] = []

  let ruleBasedCount = 0
  let aiBasedCount = 0
  let skippedCount = 0
  let marketImpactCount = 0

  try {
    // 各RSSフィードを取得
    for (const [feedName, url] of Object.entries(RSS_URLS)) {
      console.log(`\nProcessing feed: ${feedName}`)
      const entries = await fetchRssFeed(url)

      // 直近2日間のエントリのみを対象
      const recentEntries = filterRecentEntries(entries, 2)
      console.log(`Recent entries (last 2 days): ${recentEntries.length}`)

      for (const entry of recentEntries) {
        const text = `${entry.title} ${entry.contentSnippet || ""}`

        // 重複チェック
        const existing = await prisma.marketNews.findFirst({
          where: {
            title: entry.title,
            url: entry.link,
          },
        })

        if (existing) continue

        // セクター・センチメント分析（ルールベース）
        let sector = detectSectorByKeywords(text)
        let sentiment = detectSentimentByKeywords(text)

        // AI分析結果を保持（新フィールド用）
        let aiResult: AIAnalysisResult | null = null

        // ルールベースで判定できなかった場合はAI分析
        if (sector === null || sentiment === null) {
          aiResult = await analyzeWithOpenAI(
            entry.title,
            entry.contentSnippet || ""
          )

          // セクターがルールベースで検出できず、AIも株式関連でなく、市場インパクトもない場合はスキップ
          if (sector === null && !aiResult.isStockRelated && !aiResult.isMarketImpact) {
            skippedCount++
            console.log(`  Skipped (not stock-related, no market impact): ${entry.title}`)
            continue
          }

          if (sector === null) sector = aiResult.sector
          if (sentiment === null) sentiment = aiResult.sentiment
          aiBasedCount++

          if (aiResult.isMarketImpact) {
            marketImpactCount++
            console.log(`  Market impact (${aiResult.category}): ${entry.title}`)
          }
        } else {
          ruleBasedCount++
        }

        // 保存用データに追加
        const publishedAt = entry.pubDate ? new Date(entry.pubDate) : new Date()

        newsToSave.push({
          title: entry.title,
          content: entry.contentSnippet || "",
          url: entry.link,
          source: "google_news_us",
          sector,
          sentiment,
          publishedAt,
          market: "US",
          region: "米国",
          category: aiResult?.category ?? "stock",
          impactSectors: aiResult?.impactSectors?.length ? JSON.stringify(aiResult.impactSectors) : null,
          impactDirection: aiResult?.impactDirection ?? null,
          impactSummary: aiResult?.impactSummary ?? null,
        })
      }
    }

    // ニュースをデータベースに保存
    if (newsToSave.length > 0) {
      console.log(`\nSaving ${newsToSave.length} new entries...`)
      console.log(`  Rule-based: ${ruleBasedCount} entries`)
      console.log(`  AI-based: ${aiBasedCount} entries`)
      console.log(`  Market impact: ${marketImpactCount} entries`)
      console.log(`  Skipped (not stock-related, no market impact): ${skippedCount} entries`)

      // バッチ作成
      const created = await prisma.marketNews.createMany({
        data: newsToSave,
        skipDuplicates: true,
      })

      console.log(`Saved ${created.count} US news to database`)
      console.log(`  Category breakdown:`)
      console.log(`    stock: ${newsToSave.filter((n) => n.category === "stock").length}`)
      console.log(`    geopolitical: ${newsToSave.filter((n) => n.category === "geopolitical").length}`)
      console.log(`    macro: ${newsToSave.filter((n) => n.category === "macro").length}`)
    } else {
      console.log("\nNo new US news to save")
    }

    // 結果を表示
    console.log(`\n${"=".repeat(60)}`)
    console.log("Summary")
    console.log("=".repeat(60))
    console.log(`Total new entries: ${newsToSave.length}`)
  } catch (error) {
    console.error(`Error: ${error}`)
    process.exit(1)
  } finally {
    await prisma.$disconnect()
  }
}

main()

export {}
