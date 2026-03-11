/**
 * ニュースフェッチャー
 *
 * NewsAPI, Google News RSS, Yahoo Finance から
 * 日本株関連ニュースを取得する
 */

import { createHash } from "crypto";
import YahooFinance from "yahoo-finance2";
import pLimit from "p-limit";
import {
  NEWS_SOURCES,
  NEWS_KEYWORDS,
  NEWS_RSS_FEEDS,
  NEWS_CONCURRENCY,
} from "../lib/constants";
import { throttledYahooRequest } from "../lib/yahoo-finance-throttle";

// ========================================
// 共通インターフェース
// ========================================

export interface RawNewsItem {
  source: "newsapi" | "google_rss" | "yahoo_finance";
  title: string;
  url: string;
  publishedAt: Date;
  category: "geopolitical" | "sector" | "stock";
  tickerCode?: string;
  sector?: string;
}

// ========================================
// 重複排除用ハッシュ生成
// ========================================

export function generateContentHash(title: string, url: string): string {
  return createHash("sha256").update(`${title}|${url}`).digest("hex");
}

// ========================================
// カテゴリ自動判定（タイトルベース）
// ========================================

const GEO_KEYWORDS = [
  "金利", "日銀", "fed", "frb", "円安", "円高", "関税", "制裁",
  "地政学", "選挙", "政策", "中東", "戦争", "ウクライナ", "制裁",
  "利上げ", "利下げ", "金融政策", "中央銀行",
];

const SECTOR_KEYWORDS = [
  "半導体", "自動車", "銀行", "エネルギー", "ai", "ev",
  "医薬品", "不動産", "商社", "通信", "原油", "電力",
];

function categorizeArticle(title: string): "geopolitical" | "sector" | "stock" {
  const lower = title.toLowerCase();

  if (GEO_KEYWORDS.some((k) => lower.includes(k))) {
    return "geopolitical";
  }
  if (SECTOR_KEYWORDS.some((k) => lower.includes(k))) {
    return "sector";
  }
  return "stock";
}

// ========================================
// 1. NewsAPI
// ========================================

export async function fetchFromNewsAPI(): Promise<RawNewsItem[]> {
  const apiKey = process.env.NEWSAPI_API_KEY;
  if (!apiKey) {
    console.log("[news-fetcher] NEWSAPI_API_KEY not set, skipping NewsAPI");
    return [];
  }

  const items: RawNewsItem[] = [];
  const queries = [
    NEWS_KEYWORDS.GEOPOLITICAL[0], // "日銀 金利"
    NEWS_KEYWORDS.MARKET[0],       // "日経平均 株式市場"
  ];

  for (const query of queries) {
    const url = `${NEWS_SOURCES.NEWSAPI.BASE_URL}/everything?q=${encodeURIComponent(query)}&language=${NEWS_SOURCES.NEWSAPI.LANGUAGE}&sortBy=${NEWS_SOURCES.NEWSAPI.SORT_BY}&pageSize=${NEWS_SOURCES.NEWSAPI.MAX_RESULTS}&apiKey=${apiKey}`;

    try {
      const response = await fetch(url);
      const data = await response.json() as {
        articles?: Array<{
          title: string;
          url: string;
          publishedAt: string;
        }>;
      };

      if (data.articles) {
        for (const article of data.articles) {
          if (!article.title || !article.url) continue;
          items.push({
            source: "newsapi",
            title: article.title,
            url: article.url,
            publishedAt: new Date(article.publishedAt),
            category: categorizeArticle(article.title),
          });
        }
      }
    } catch (error) {
      console.error(`[news-fetcher] NewsAPI error for "${query}":`, error);
    }
  }

  return items;
}

// ========================================
// 2. Google News RSS
// ========================================

export async function fetchFromGoogleRSS(): Promise<RawNewsItem[]> {
  const items: RawNewsItem[] = [];

  const feeds: Array<{ query: string; defaultCategory: "geopolitical" | "sector" | "stock" }> = [
    ...NEWS_RSS_FEEDS.GEOPOLITICAL.map((q) => ({ query: q, defaultCategory: "geopolitical" as const })),
    ...NEWS_RSS_FEEDS.MARKET.map((q) => ({ query: q, defaultCategory: "stock" as const })),
    ...NEWS_RSS_FEEDS.SECTOR.map((q) => ({ query: q, defaultCategory: "sector" as const })),
  ];

  for (const feed of feeds) {
    const url = `${NEWS_SOURCES.GOOGLE_RSS.BASE_URL}?q=${encodeURIComponent(feed.query)}&hl=ja&gl=JP&ceid=JP:ja`;

    try {
      const response = await fetch(url);
      const xml = await response.text();

      const itemMatches = xml.matchAll(/<item>([\s\S]*?)<\/item>/g);
      let count = 0;

      for (const match of itemMatches) {
        if (count >= NEWS_SOURCES.GOOGLE_RSS.MAX_RESULTS) break;
        const itemXml = match[1];

        const titleMatch = itemXml.match(/<title>([\s\S]*?)<\/title>/);
        const linkMatch = itemXml.match(/<link>([\s\S]*?)<\/link>/);
        const pubDateMatch = itemXml.match(/<pubDate>([\s\S]*?)<\/pubDate>/);

        if (titleMatch && linkMatch) {
          const title = titleMatch[1].replace(/<!\[CDATA\[|\]\]>/g, "").trim();
          items.push({
            source: "google_rss",
            title,
            url: linkMatch[1].trim(),
            publishedAt: pubDateMatch ? new Date(pubDateMatch[1]) : new Date(),
            category: categorizeArticle(title) || feed.defaultCategory,
          });
          count++;
        }
      }
    } catch (error) {
      console.error(`[news-fetcher] Google RSS error for "${feed.query}":`, error);
    }
  }

  return items;
}

// ========================================
// 3. Yahoo Finance News（銘柄別）
// ========================================

export async function fetchFromYahooFinance(
  tickerCodes: string[],
): Promise<RawNewsItem[]> {
  const yahooFinance = new YahooFinance({ suppressNotices: ["yahooSurvey"] });
  const limit = pLimit(NEWS_CONCURRENCY.YAHOO_STOCK_NEWS);

  const results = await Promise.all(
    tickerCodes.map((ticker) =>
      limit(async (): Promise<RawNewsItem[]> => {
        try {
          const result = await throttledYahooRequest(() =>
            yahooFinance.search(ticker, {
              newsCount: NEWS_SOURCES.YAHOO_FINANCE.MAX_RESULTS,
            }),
          );

          if (!result.news || result.news.length === 0) return [];

          return result.news
            .filter((n) => n.title && n.link)
            .map((n) => ({
              source: "yahoo_finance" as const,
              title: n.title,
              url: n.link,
              publishedAt: n.providerPublishTime
                ? new Date(n.providerPublishTime)
                : new Date(),
              category: "stock" as const,
              tickerCode: ticker,
            }));
        } catch (error) {
          console.error(`[news-fetcher] Yahoo Finance error for ${ticker}:`, error);
          return [];
        }
      }),
    ),
  );

  return results.flat();
}

// ========================================
// 重複排除
// ========================================

export function deduplicateNews(items: RawNewsItem[]): RawNewsItem[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    const hash = generateContentHash(item.title, item.url);
    if (seen.has(hash)) return false;
    seen.add(hash);
    return true;
  });
}
