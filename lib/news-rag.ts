import { prisma } from "@/lib/prisma"
import dayjs from "dayjs"
import utc from "dayjs/plugin/utc"

dayjs.extend(utc)

export interface NewsRAGParams {
  stockIds?: string[] // 銘柄ID配列
  tickerCodes?: string[] // 銘柄コード配列（例：["7203", "6758"]）
  sectors?: string[] // セクター配列（例：["自動車", "IT・サービス"]）
  limit?: number // 取得件数（デフォルト: 10）
  daysAgo?: number // 何日前まで（デフォルト: 7）
}

export interface RelatedNews {
  id: string
  title: string
  content: string
  url: string | null
  source: string
  sector: string | null
  sentiment: string | null
  publishedAt: Date
  matchType: "ticker" | "sector" // どの条件でマッチしたか
}

/**
 * 関連ニュースを取得する（ハイブリッド検索）
 *
 * 優先度:
 * 1. tickerCode フィールド直接マッチ（yfinanceで取得した銘柄紐付きニュース）
 * 2. 銘柄コード検索（content LIKE '%7203%'）
 * 3. セクター検索（sector IN (...)）
 */
export async function getRelatedNews(
  params: NewsRAGParams
): Promise<RelatedNews[]> {
  const {
    tickerCodes = [],
    sectors = [],
    limit = 10,
    daysAgo = 7,
  } = params

  try {
    const cutoffDate = dayjs.utc().subtract(daysAgo, "day").startOf("day").toDate()
    const newsMap = new Map<string, RelatedNews>()

    // ステップ1: tickerCode 直接マッチ（yfinance取得分・優先）
    if (tickerCodes.length > 0) {
      const directNews = await prisma.marketNews.findMany({
        where: {
          tickerCode: { in: tickerCodes },
          publishedAt: { gte: cutoffDate },
        },
        orderBy: { publishedAt: "desc" },
        take: limit,
        select: {
          id: true,
          title: true,
          content: true,
          url: true,
          source: true,
          sector: true,
          sentiment: true,
          publishedAt: true,
        },
      })

      for (const n of directNews) {
        if (!newsMap.has(n.id)) {
          newsMap.set(n.id, { ...n, matchType: "ticker" })
        }
      }
    }

    // ステップ2: 銘柄コードをコンテンツ内から検索（フォールバック）
    if (tickerCodes.length > 0 && newsMap.size < limit) {
      for (const tickerCode of tickerCodes) {
        const news = await prisma.marketNews.findMany({
          where: {
            content: {
              contains: tickerCode,
            },
            publishedAt: {
              gte: cutoffDate,
            },
            id: { notIn: Array.from(newsMap.keys()) },
          },
          orderBy: {
            publishedAt: "desc",
          },
          take: limit - newsMap.size,
          select: {
            id: true,
            title: true,
            content: true,
            url: true,
            source: true,
            sector: true,
            sentiment: true,
            publishedAt: true,
          },
        })

        // 重複排除しながらMap に追加
        for (const n of news) {
          if (!newsMap.has(n.id)) {
            newsMap.set(n.id, {
              ...n,
              matchType: "ticker",
            })
          }
        }
      }
    }

    // ステップ2: セクター検索（フォールバック）
    // 銘柄コード検索で十分な件数が取得できていない場合のみ
    if (newsMap.size < limit && sectors.length > 0) {
      const remainingLimit = limit - newsMap.size

      const sectorNews = await prisma.marketNews.findMany({
        where: {
          sector: {
            in: sectors,
          },
          publishedAt: {
            gte: cutoffDate,
          },
          // 既に取得済みのニュースは除外
          id: {
            notIn: Array.from(newsMap.keys()),
          },
        },
        orderBy: {
          publishedAt: "desc",
        },
        take: remainingLimit,
        select: {
          id: true,
          title: true,
          content: true,
          url: true,
          source: true,
          sector: true,
          sentiment: true,
          publishedAt: true,
        },
      })

      for (const n of sectorNews) {
        if (!newsMap.has(n.id)) {
          newsMap.set(n.id, {
            ...n,
            matchType: "sector",
          })
        }
      }
    }

    // Map を配列に変換し、日付順にソート
    const result = Array.from(newsMap.values()).sort((a, b) => {
      return b.publishedAt.getTime() - a.publishedAt.getTime()
    })

    return result.slice(0, limit)
  } catch (error) {
    console.error("Failed to fetch related news:", error)
    // エラー時は空配列を返す（AIチャットは継続可能）
    return []
  }
}

/**
 * ニュース参照リストをフォーマットする
 *
 * 回答の最後に追加する「参考にした情報」セクションを生成
 * GlobalChat.tsx の parseMessage でパースされる形式に合わせる
 */
export function formatNewsReferences(news: RelatedNews[]): string {
  if (news.length === 0) return ""

  // URLがある記事のみ抽出
  const newsWithUrl = news.filter((n) => n.url)
  if (newsWithUrl.length === 0) return ""

  return (
    `\n\n---\n📰 参考にした情報:\n` +
    newsWithUrl
      .map((n) => `• ${n.title}\n  ${n.url}`)
      .join("\n")
  )
}

/**
 * システムプロンプト用にニュース情報をフォーマットする
 * 日付の新しさを強調して、直近のニュースを重視するよう促す
 */
export function formatNewsForPrompt(news: RelatedNews[]): string {
  if (news.length === 0) {
    return "（最新のニュース情報はありません）"
  }

  const now = dayjs.utc()

  return news
    .map((n) => {
      const publishedAt = dayjs(n.publishedAt)
      const daysAgo = now.diff(publishedAt, "day")

      // 日付の重要度を示すラベル
      let freshnessLabel = ""
      if (daysAgo === 0) freshnessLabel = "【本日】"
      else if (daysAgo === 1) freshnessLabel = "【昨日】"
      else if (daysAgo <= 3) freshnessLabel = "【直近3日】"
      else if (daysAgo <= 7) freshnessLabel = "【今週】"
      else freshnessLabel = `【${daysAgo}日前】`

      return `
${freshnessLabel}
- タイトル: ${n.title}
- 日付: ${publishedAt.format("YYYY-MM-DD")}
- センチメント: ${n.sentiment || "不明"}
- 内容: ${n.content.substring(0, 300)}${n.content.length > 300 ? "..." : ""}
- URL: ${n.url || "(URLなし)"}
- 重要度: ${daysAgo <= 3 ? "高（直近のニュースは特に重視してください）" : "通常"}
`
    })
    .join("\n")
}
