/**
 * ニュースコレクター（8:00 JST / 平日）
 *
 * 1. 3ソースからニュースをフェッチ・重複排除・DB保存・AI分析
 * 2. 上場廃止ニュース検知
 */

import dayjs from "dayjs";
import { prisma } from "../lib/prisma";
import { getTodayForDB, getDaysAgoForDB } from "../lib/date-utils";
import { OPENAI_CONFIG, NEWS_AI_MAX_ARTICLES, DELISTING_NEWS_KEYWORDS } from "../lib/constants";
import { getTracedOpenAIClient } from "../lib/openai";
import { flushLangfuse } from "../lib/langfuse";
import {
  fetchFromNewsAPI,
  fetchFromGoogleRSS,
  fetchFromYahooFinance,
  deduplicateNews,
  generateContentHash,
} from "../core/news-fetcher";
import {
  NEWS_ANALYSIS_SYSTEM_PROMPT,
  NEWS_ANALYSIS_SCHEMA,
} from "../prompts/news-analysis";
import { notifySlack } from "../lib/slack";

// AI分析結果の型
export interface NewsAnalysisResult {
  geopoliticalRiskLevel: number;
  geopoliticalSummary: string;
  marketImpact: "positive" | "neutral" | "negative";
  marketImpactSummary: string;
  sectorImpacts: Array<{
    sector: string;
    impact: "positive" | "neutral" | "negative";
    summary: string;
  }>;
  stockCatalysts: Array<{
    tickerCode: string;
    type: "positive_catalyst" | "negative_catalyst" | "earnings" | "regulatory";
    summary: string;
  }>;
  keyEvents: string;
}

/**
 * ニュース収集 + AI分析を実行する
 *
 * 1. 3ソースからニュースをフェッチ（NewsAPI, Google RSS, Yahoo Finance）
 * 2. 重複排除
 * 3. DB保存（既存ハッシュとの重複スキップ）
 * 4. AI分析（カテゴリ別テキスト構築 → OpenAI → NewsAnalysis upsert）
 */
export async function collectAndAnalyzeNews(): Promise<{
  newArticleCount: number;
  analysis: NewsAnalysisResult | null;
}> {
  // 1. ニュースフェッチ（3ソース並列）
  console.log("  ニュースフェッチ中...");

  // Yahoo Finance用: 主要銘柄を取得
  const stocks = await prisma.stock.findMany({
    where: { isDelisted: false },
    select: { tickerCode: true },
    take: 20,
  });
  const tickerCodes = stocks.map((s) => s.tickerCode);

  const [newsapiItems, googleItems, yahooItems] = await Promise.all([
    fetchFromNewsAPI(),
    fetchFromGoogleRSS(),
    fetchFromYahooFinance(tickerCodes),
  ]);

  console.log(
    `  NewsAPI: ${newsapiItems.length}件, Google RSS: ${googleItems.length}件, Yahoo: ${yahooItems.length}件`,
  );

  // 2. 重複排除
  console.log("  重複排除中...");
  const allItems = deduplicateNews([
    ...newsapiItems,
    ...googleItems,
    ...yahooItems,
  ]);
  console.log(`  重複排除後: ${allItems.length}件`);

  // 3. DB保存（既存ハッシュとの重複スキップ）
  console.log("  DB保存中...");

  const existingHashes = new Set(
    (
      await prisma.newsArticle.findMany({
        where: { publishedAt: { gte: getDaysAgoForDB(3) } },
        select: { contentHash: true },
      })
    ).map((a) => a.contentHash),
  );

  const newItems = allItems.filter((item) => {
    const hash = generateContentHash(item.title, item.url);
    return !existingHashes.has(hash);
  });

  let savedCount = 0;
  if (newItems.length > 0) {
    const result = await prisma.newsArticle.createMany({
      data: newItems.map((item) => ({
        source: item.source,
        title: item.title,
        url: item.url,
        publishedAt: item.publishedAt,
        category: item.category,
        tickerCode: item.tickerCode ?? null,
        sector: item.sector ?? null,
        contentHash: generateContentHash(item.title, item.url),
      })),
      skipDuplicates: true,
    });
    savedCount = result.count;
  }
  console.log(`  新規保存: ${savedCount}件`);

  // 4. AI分析
  console.log("  AI分析中...");

  const oneDayAgo = dayjs().subtract(1, "day").toDate();
  const recentArticles = await prisma.newsArticle.findMany({
    where: { publishedAt: { gte: oneDayAgo } },
    orderBy: { publishedAt: "desc" },
    take: NEWS_AI_MAX_ARTICLES,
  });

  if (recentArticles.length === 0) {
    console.log("  分析対象のニュースがありません");
    return { newArticleCount: 0, analysis: null };
  }

  // ニュースをカテゴリ別に整理してAI入力テキスト構築
  const geoNews = recentArticles.filter((a) => a.category === "geopolitical");
  const sectorNews = recentArticles.filter((a) => a.category === "sector");
  const stockNews = recentArticles.filter((a) => a.category === "stock");

  const newsText = `【地政学・マクロ関連ニュース（${geoNews.length}件）】
${geoNews.map((a) => `- ${a.title}`).join("\n") || "なし"}

【セクター関連ニュース（${sectorNews.length}件）】
${sectorNews.map((a) => `- ${a.title}${a.sector ? ` [${a.sector}]` : ""}`).join("\n") || "なし"}

【個別銘柄ニュース（${stockNews.length}件）】
${stockNews.map((a) => `- ${a.title}${a.tickerCode ? ` [${a.tickerCode}]` : ""}`).join("\n") || "なし"}`;

  const openai = getTracedOpenAIClient({
    generationName: "news-analysis",
    tags: ["news", "analysis"],
  });
  const response = await openai.chat.completions.create({
    model: OPENAI_CONFIG.MODEL,
    temperature: OPENAI_CONFIG.TEMPERATURE,
    messages: [
      { role: "system", content: NEWS_ANALYSIS_SYSTEM_PROMPT },
      {
        role: "user",
        content: `以下のニュースヘッドラインを分析してください。\n\n${newsText}`,
      },
    ],
    response_format: NEWS_ANALYSIS_SCHEMA,
  });

  const content = response.choices[0].message.content;
  if (!content) {
    throw new Error("[news-collector] AI分析: Empty response from OpenAI");
  }

  const analysis = JSON.parse(content) as NewsAnalysisResult;

  // NewsAnalysis に upsert（当日1レコード）
  await prisma.newsAnalysis.upsert({
    where: { date: getTodayForDB() },
    create: {
      date: getTodayForDB(),
      geopoliticalRiskLevel: analysis.geopoliticalRiskLevel,
      geopoliticalSummary: analysis.geopoliticalSummary,
      marketImpact: analysis.marketImpact,
      marketImpactSummary: analysis.marketImpactSummary,
      sectorImpacts: JSON.parse(JSON.stringify(analysis.sectorImpacts)),
      stockCatalysts: JSON.parse(JSON.stringify(analysis.stockCatalysts)),
      keyEvents: analysis.keyEvents,
      articleCount: recentArticles.length,
    },
    update: {
      geopoliticalRiskLevel: analysis.geopoliticalRiskLevel,
      geopoliticalSummary: analysis.geopoliticalSummary,
      marketImpact: analysis.marketImpact,
      marketImpactSummary: analysis.marketImpactSummary,
      sectorImpacts: JSON.parse(JSON.stringify(analysis.sectorImpacts)),
      stockCatalysts: JSON.parse(JSON.stringify(analysis.stockCatalysts)),
      keyEvents: analysis.keyEvents,
      articleCount: recentArticles.length,
    },
  });

  console.log(
    `  AI分析完了（地政学リスク: ${analysis.geopoliticalRiskLevel}/5, 市場: ${analysis.marketImpact}）`,
  );

  return { newArticleCount: savedCount, analysis };
}

export async function main() {
  console.log("=== News Collector 開始 ===");

  // 1. ニュース収集 + AI分析
  console.log("[1/2] ニュース収集・AI分析中...");
  const { analysis } = await collectAndAnalyzeNews();

  if (!analysis) {
    await notifySlack({
      title: "📰 ニュース収集完了",
      message: "直近24時間のニュースはありませんでした",
      color: "#808080",
    });
    console.log("=== News Collector 終了 ===");
    return;
  }

  // 2. 上場廃止関連ニュース検知
  console.log("[2/2] 上場廃止ニュース検知中...");
  let delistingFlagCount = 0;

  const oneDayAgo = dayjs().subtract(1, "day").toDate();
  const recentArticles = await prisma.newsArticle.findMany({
    where: { publishedAt: { gte: oneDayAgo } },
    orderBy: { publishedAt: "desc" },
    take: NEWS_AI_MAX_ARTICLES,
  });

  for (const article of recentArticles) {
    const matchedKeyword = DELISTING_NEWS_KEYWORDS.find((kw) =>
      article.title.includes(kw),
    );

    if (matchedKeyword && article.tickerCode) {
      const stock = await prisma.stock.findUnique({
        where: { tickerCode: article.tickerCode },
        select: { id: true, delistingNewsDetected: true },
      });

      if (stock && !stock.delistingNewsDetected) {
        await prisma.stock.update({
          where: { id: stock.id },
          data: { delistingNewsDetected: true },
        });
        await prisma.stockStatusLog.create({
          data: {
            tickerCode: article.tickerCode,
            changeType: "news_flag",
            oldValue: "false",
            newValue: "true",
            source: "news_collector",
            detail: `キーワード「${matchedKeyword}」検出: ${article.title}`,
          },
        });
        delistingFlagCount++;
        console.log(`  ⚠ ${article.tickerCode}: 「${matchedKeyword}」検出`);
      }
    }
  }

  if (delistingFlagCount > 0) {
    console.log(`  ${delistingFlagCount}銘柄にフラグ設定`);
  } else {
    console.log("  廃止関連ニュースなし");
  }

  // Slack通知
  const riskEmoji =
    analysis.geopoliticalRiskLevel >= 4
      ? "🔴"
      : analysis.geopoliticalRiskLevel >= 3
        ? "🟡"
        : "🟢";
  const impactEmoji =
    analysis.marketImpact === "positive"
      ? "📈"
      : analysis.marketImpact === "negative"
        ? "📉"
        : "➡️";

  await notifySlack({
    title: "📰 ニュース分析完了",
    message: analysis.keyEvents,
    color:
      analysis.marketImpact === "negative"
        ? "warning"
        : analysis.marketImpact === "positive"
          ? "good"
          : "#808080",
    fields: [
      {
        title: "地政学リスク",
        value: `${riskEmoji} レベル ${analysis.geopoliticalRiskLevel}/5`,
        short: true,
      },
      {
        title: "市場インパクト",
        value: `${impactEmoji} ${analysis.marketImpact}`,
        short: true,
      },
      {
        title: "記事数",
        value: `${recentArticles.length}件`,
        short: true,
      },
      {
        title: "セクター影響",
        value:
          analysis.sectorImpacts.length > 0
            ? analysis.sectorImpacts
                .map((s) => `${s.sector}: ${s.impact}`)
                .join(", ")
            : "特になし",
        short: true,
      },
    ],
  });

  console.log("=== News Collector 終了 ===");
}

const isDirectRun = process.argv[1]?.includes("news-collector");
if (isDirectRun) {
  main()
    .catch((error) => {
      console.error("News Collector エラー:", error);
      process.exit(1);
    })
    .finally(async () => {
      await flushLangfuse();
      await prisma.$disconnect();
    });
}
