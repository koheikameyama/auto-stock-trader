import { NextRequest, NextResponse } from "next/server";
import pLimit from "p-limit";
import { prisma } from "@/lib/prisma";
import { verifyCronAuth } from "@/lib/cron-auth";
import { getOpenAIClient } from "@/lib/openai";
import { getTodayForDB, getDaysAgoForDB } from "@/lib/date-utils";
import {
  fetchHistoricalPrices,
  fetchStockPrices,
} from "@/lib/stock-price-fetcher";
import { getNikkei225Data } from "@/lib/market-index";

// AI API同時リクエスト数の制限（ユーザー単位での並列処理）
const USER_CONCURRENCY_LIMIT = 3;
import {
  buildFinancialMetrics,
  buildTechnicalContext,
  buildCandlestickContext,
  buildChartPatternContext,
  buildWeekChangeContext,
  buildMarketContext,
  buildDeviationRateContext,
  buildTrendlineContext,
} from "@/lib/stock-analysis-context";
import { buildDailyRecommendationPrompt } from "@/lib/prompts/daily-recommendation-prompt";
import { getRelatedNews, formatNewsForPrompt } from "@/lib/news-rag";
import {
  getAllSectorTrends,
  formatAllSectorTrendsForPrompt,
  type SectorTrendData,
} from "@/lib/sector-trend";
import { calculateDeviationRate } from "@/lib/technical-indicators";
import {
  MA_DEVIATION,
  STALE_DATA_DAYS,
  INVESTMENT_THEMES,
  getStyleLabel,
} from "@/lib/constants";
import {
  isSurgeStock,
  isDangerousStock,
  isOverheated,
  isInDecline,
} from "@/lib/stock-safety-rules";
import {
  calculateStockScores,
  applySectorDiversification,
  filterByLooseBudget,
  narrowByBudget,
  SCORING_CONFIG,
  StockForScoring,
  ScoredStock,
} from "@/lib/recommendation-scoring";
import { insertRecommendationOutcome } from "@/lib/outcome-utils";
import { calculatePortfolioFromTransactions } from "@/lib/portfolio-calculator";

interface GenerateRequest {
  session?: "morning" | "afternoon" | "evening";
  userId?: string;
}

interface UserResult {
  userId: string;
  success: boolean;
  recommendations?: Array<{
    tickerCode: string;
    reason: string;
    investmentTheme: string;
  }>;
  error?: string;
}

interface StockContext {
  stock: ScoredStock;
  currentPrice: number;
  financialMetrics: string;
  technicalContext: string;
  candlestickContext: string;
  chartPatternContext: string;
  trendlineContext: string;
  weekChangeContext: string;
  weekChangeRate: number | null;
  deviationRateContext: string;
  deviationRate: number | null;
  predictionContext: string;
}

/**
 * POST /api/recommendations/generate-daily
 * 日次おすすめ銘柄を生成（全ユーザーまたは指定ユーザー）
 */
export async function POST(request: NextRequest) {
  const authError = verifyCronAuth(request);
  if (authError) return authError;

  let body: GenerateRequest = {};
  try {
    body = await request.json();
  } catch {
    // bodyがない場合はデフォルト値を使用
  }

  const session = body.session || "evening";
  const targetUserId = body.userId;

  console.log("=".repeat(60));
  console.log("Daily Recommendation Generation (TypeScript)");
  console.log("=".repeat(60));
  console.log(`Time: ${new Date().toISOString()}`);
  console.log(`Session: ${session}`);
  console.log(`Target User: ${targetUserId || "all"}`);

  try {
    const users = await prisma.userSettings.findMany({
      where: targetUserId ? { userId: targetUserId } : undefined,
      select: {
        userId: true,
        investmentStyle: true,
        investmentBudget: true,
      },
    });

    if (users.length === 0) {
      return NextResponse.json({
        success: true,
        message: "No users with settings",
        processed: 0,
      });
    }

    console.log(`Found ${users.length} users with settings`);

    const staleThreshold = getDaysAgoForDB(STALE_DATA_DAYS);
    const allStocks = await prisma.stock.findMany({
      where: {
        isDelisted: false,
        latestPriceDate: { not: null, gte: staleThreshold },
        latestPrice: { not: null },
        fetchFailCount: 0,
        volatility: { not: null },
      },
      select: {
        id: true,
        tickerCode: true,
        name: true,
        sector: true,
        latestPrice: true,
        weekChangeRate: true,
        volatility: true,
        volumeRatio: true,
        marketCap: true,
        isProfitable: true,
        maDeviationRate: true,
        dividendYield: true,
        pbr: true,
        per: true,
        roe: true,
        profitTrend: true,
        revenueGrowth: true,
        eps: true,
        fiftyTwoWeekHigh: true,
        fiftyTwoWeekLow: true,
        isDelisted: true,
        fetchFailCount: true,
      },
    });

    console.log(`Found ${allStocks.length} stocks with price data`);

    const userIds = users.map((u) => u.userId);

    const [portfolioStocks, watchlistStocks] = await Promise.all([
      prisma.portfolioStock.findMany({
        select: {
          userId: true,
          stockId: true,
          transactions: {
            select: {
              type: true,
              quantity: true,
              price: true,
              transactionDate: true,
            },
            orderBy: { transactionDate: "asc" },
          },
        },
      }),
      prisma.watchlistStock.findMany({
        select: { userId: true, stockId: true },
      }),
    ]);

    // ユーザーごとの保有株取得コスト合計を計算（保有コスト方式）
    // 売却済みの株は含まない。売れば（利確・損切り問わず）予算に戻ってくる。
    const holdingsCostByUser = new Map<string, number>();
    for (const ps of portfolioStocks) {
      const { quantity, averagePurchasePrice } =
        calculatePortfolioFromTransactions(ps.transactions);
      if (quantity > 0) {
        const current = holdingsCostByUser.get(ps.userId) ?? 0;
        holdingsCostByUser.set(
          ps.userId,
          current + quantity * averagePurchasePrice.toNumber(),
        );
      }
    }

    const registeredByUser = new Map<string, Set<string>>();
    for (const ps of portfolioStocks) {
      const { quantity } = calculatePortfolioFromTransactions(ps.transactions);
      if (quantity > 0) {
        if (!registeredByUser.has(ps.userId)) {
          registeredByUser.set(ps.userId, new Set());
        }
        registeredByUser.get(ps.userId)!.add(ps.stockId);
      }
    }
    for (const ws of watchlistStocks) {
      if (!registeredByUser.has(ws.userId)) {
        registeredByUser.set(ws.userId, new Set());
      }
      registeredByUser.get(ws.userId)!.add(ws.stockId);
    }

    let marketData = null;
    try {
      marketData = await getNikkei225Data();
    } catch (error) {
      console.error("市場データ取得失敗:", error);
    }
    const marketContext = buildMarketContext(marketData);

    // セクタートレンドを一括取得（全ユーザー共通）
    const { trends: sectorTrends } = await getAllSectorTrends();
    const sectorTrendMap: Record<string, SectorTrendData> = {};
    for (const t of sectorTrends) {
      sectorTrendMap[t.sector] = t;
    }
    const sectorTrendContext = formatAllSectorTrendsForPrompt(sectorTrends);

    // ユーザー処理を並列実行（同時実行数を制限）
    const limit = pLimit(USER_CONCURRENCY_LIMIT);
    console.log(
      `Processing ${users.length} users with concurrency limit: ${USER_CONCURRENCY_LIMIT}`,
    );

    const tasks = users.map((user) =>
      limit(async (): Promise<UserResult> => {
        try {
          const holdingsCost = holdingsCostByUser.get(user.userId) ?? 0;
          const remainingBudget =
            user.investmentBudget !== null
              ? Math.max(0, user.investmentBudget - holdingsCost)
              : null;

          const result = await processUser(
            user,
            allStocks,
            registeredByUser.get(user.userId) || new Set(),
            session,
            marketContext,
            remainingBudget,
            sectorTrendMap,
            sectorTrendContext,
          );
          return result;
        } catch (error) {
          console.error(`Error processing user ${user.userId}:`, error);
          return {
            userId: user.userId,
            success: false,
            error: error instanceof Error ? error.message : "Unknown error",
          };
        }
      }),
    );

    const results = await Promise.all(tasks);

    const successCount = results.filter((r) => r.success).length;
    const failCount = results.filter((r) => !r.success).length;

    console.log("=".repeat(60));
    console.log(
      `Completed: ${successCount} users OK, ${failCount} users failed`,
    );
    console.log("=".repeat(60));

    return NextResponse.json({
      success: true,
      processed: successCount,
      failed: failCount,
      results,
    });
  } catch (error) {
    console.error("Error in generate-daily:", error);
    return NextResponse.json(
      { error: "Failed to generate recommendations" },
      { status: 500 },
    );
  }
}

async function processUser(
  user: {
    userId: string;
    investmentStyle: string | null;
    investmentBudget: number | null;
  },
  allStocks: Array<{
    id: string;
    tickerCode: string;
    name: string;
    sector: string | null;
    latestPrice: unknown;
    weekChangeRate: unknown;
    volatility: unknown;
    volumeRatio: unknown;
    marketCap: unknown;
    isProfitable: boolean | null;
    maDeviationRate: unknown;
    dividendYield: unknown;
    pbr: unknown;
    per: unknown;
    roe: unknown;
    profitTrend: string | null;
    revenueGrowth: unknown;
    eps: unknown;
    fiftyTwoWeekHigh: unknown;
    fiftyTwoWeekLow: unknown;
    isDelisted: boolean;
    fetchFailCount: number;
  }>,
  registeredStockIds: Set<string>,
  session: string,
  marketContext: string,
  remainingBudget: number | null,
  sectorTrendMap: Record<string, SectorTrendData>,
  sectorTrendContext: string,
): Promise<UserResult> {
  const { userId, investmentStyle, investmentBudget } = user;

  console.log(
    `\n--- User: ${userId} (totalBudget: ${investmentBudget}, remainingBudget: ${remainingBudget}, style: ${investmentStyle}) ---`,
  );

  const stocksForScoring: StockForScoring[] = allStocks.map((s) => ({
    id: s.id,
    tickerCode: s.tickerCode,
    name: s.name,
    sector: s.sector,
    latestPrice: s.latestPrice ? Number(s.latestPrice) : null,
    weekChangeRate: s.weekChangeRate ? Number(s.weekChangeRate) : null,
    volatility: s.volatility ? Number(s.volatility) : null,
    volumeRatio: s.volumeRatio ? Number(s.volumeRatio) : null,
    marketCap: s.marketCap ? Number(s.marketCap) : null,
    isProfitable: s.isProfitable,
    maDeviationRate: s.maDeviationRate ? Number(s.maDeviationRate) : null,
  }));

  // 予算の1.5倍までの緩いフィルタ（候補を広めに取る）
  const looseFiltered = filterByLooseBudget(stocksForScoring, remainingBudget);
  console.log(
    `  Stocks after loose budget filter: ${looseFiltered.length}/${stocksForScoring.length}`,
  );

  if (looseFiltered.length === 0) {
    return {
      userId,
      success: false,
      error: "No stocks available after budget filter",
    };
  }

  const scored = calculateStockScores(
    looseFiltered,
    investmentStyle,
    sectorTrendMap,
  );
  console.log(
    `  Top 3 scores: ${scored
      .slice(0, 3)
      .map((s) => `${s.tickerCode}:${s.score}`)
      .join(", ")}`,
  );

  let diversified = applySectorDiversification(scored);
  console.log(`  After sector diversification: ${diversified.length} stocks`);

  if (registeredStockIds.size > 0) {
    const candidates = diversified.filter((s) => !registeredStockIds.has(s.id));
    if (candidates.length > 5) {
      diversified = candidates;
      console.log(`  After excluding registered: ${diversified.length} stocks`);
    }
  }

  // 予算内の銘柄を優先し、5件未満なら予算超も追加
  const budgetResult = narrowByBudget(diversified, remainingBudget);
  const isBudgetExceeded = budgetResult.isBudgetExceeded;
  if (isBudgetExceeded) {
    console.log(`  Budget exceeded: including over-budget stocks`);
  }

  const topCandidates = budgetResult.stocks.slice(
    0,
    SCORING_CONFIG.MAX_CANDIDATES_FOR_AI,
  );

  const { contexts: stockContexts, newsContext } = await buildStockContexts(
    topCandidates,
    allStocks,
    investmentStyle,
  );

  const recommendations = await selectWithAI(
    userId,
    investmentStyle,
    investmentBudget,
    remainingBudget,
    session,
    stockContexts,
    marketContext,
    newsContext,
    sectorTrendContext,
    isBudgetExceeded,
  );

  if (!recommendations || recommendations.length === 0) {
    return { userId, success: false, error: "AI selection failed" };
  }

  const saved = await saveRecommendations(
    userId,
    recommendations,
    topCandidates,
  );
  console.log(`  Saved ${saved} recommendations`);

  return {
    userId,
    success: true,
    recommendations,
  };
}

async function buildStockContexts(
  candidates: ScoredStock[],
  allStocksData: Array<{
    id: string;
    tickerCode: string;
    dividendYield: unknown;
    pbr: unknown;
    per: unknown;
    roe: unknown;
    isProfitable: boolean | null;
    profitTrend: string | null;
    revenueGrowth: unknown;
    eps: unknown;
    fiftyTwoWeekHigh: unknown;
    fiftyTwoWeekLow: unknown;
    marketCap: unknown;
    isDelisted: boolean;
    fetchFailCount: number;
  }>,
  investmentStyle?: string | null,
): Promise<{ contexts: StockContext[]; newsContext: string }> {
  console.log(
    `  Fetching detailed data for ${candidates.length} candidates...`,
  );

  const stockDataMap = new Map(allStocksData.map((s) => [s.id, s]));

  const pricesPromises = candidates.map(async (candidate) => {
    try {
      const prices = await fetchHistoricalPrices(candidate.tickerCode, "1m");
      return { stockId: candidate.id, prices };
    } catch (error) {
      console.error(
        `  Failed to fetch prices for ${candidate.tickerCode}:`,
        error,
      );
      return { stockId: candidate.id, prices: [] };
    }
  });

  // 価格取得・ニュース取得・AI予測取得を並列実行
  const stockIds = candidates.map((c) => c.id);
  const tickerCodesForNews = candidates.map((c) =>
    c.tickerCode.replace(".T", ""),
  );
  const sectors = Array.from(
    new Set(
      candidates.map((c) => c.sector).filter((s): s is string => s !== null),
    ),
  );

  const [pricesResults, realtimePricesResult, relatedNews, analyses] =
    await Promise.all([
      Promise.all(pricesPromises),
      fetchStockPrices(candidates.map((c) => c.tickerCode))
        .then((r) => r.prices)
        .catch((error) => {
          console.error("  Failed to fetch realtime prices:", error);
          return [] as { tickerCode: string; currentPrice: number }[];
        }),
      getRelatedNews({
        tickerCodes: tickerCodesForNews,
        sectors,
        limit: 10,
        daysAgo: 7,
      }).catch((error) => {
        console.error("  Failed to fetch news:", error);
        return [];
      }),
      prisma.stockAnalysis.findMany({
        where: { stockId: { in: stockIds } },
        orderBy: { analyzedAt: "desc" },
        distinct: ["stockId"],
        select: {
          stockId: true,
          shortTermTrend: true,
          shortTermPriceLow: true,
          shortTermPriceHigh: true,
          midTermTrend: true,
          midTermPriceLow: true,
          midTermPriceHigh: true,
          longTermTrend: true,
          longTermPriceLow: true,
          longTermPriceHigh: true,
          recommendation: true,
          advice: true,
          confidence: true,
        },
      }),
    ]);

  const pricesMap = new Map(pricesResults.map((r) => [r.stockId, r.prices]));
  const currentPrices = new Map(
    realtimePricesResult.map((p) => [p.tickerCode, p.currentPrice]),
  );
  const analysisMap = new Map(analyses.map((a) => [a.stockId, a]));

  const newsContext =
    relatedNews.length > 0
      ? `\n【最新のニュース情報】\n${formatNewsForPrompt(relatedNews)}`
      : "";

  console.log(
    `  News: ${relatedNews.length} articles, Predictions: ${analyses.length} stocks`,
  );

  const trendLabel = (trend: string) =>
    trend === "up" ? "上昇" : trend === "down" ? "下落" : "横ばい";

  const contexts: StockContext[] = [];

  for (const candidate of candidates) {
    const stockData = stockDataMap.get(candidate.id);
    const prices = pricesMap.get(candidate.id) || [];
    const currentPrice =
      currentPrices.get(candidate.tickerCode) || candidate.latestPrice || 0;

    const financialMetrics = stockData
      ? buildFinancialMetrics(
          {
            marketCap: stockData.marketCap
              ? Number(stockData.marketCap)
              : undefined,
            dividendYield: stockData.dividendYield
              ? Number(stockData.dividendYield)
              : undefined,
            pbr: stockData.pbr ? Number(stockData.pbr) : undefined,
            per: stockData.per ? Number(stockData.per) : undefined,
            roe: stockData.roe ? Number(stockData.roe) : undefined,
            isProfitable: stockData.isProfitable,
            profitTrend: stockData.profitTrend,
            revenueGrowth: stockData.revenueGrowth
              ? Number(stockData.revenueGrowth)
              : undefined,
            eps: stockData.eps ? Number(stockData.eps) : undefined,
            fiftyTwoWeekHigh: stockData.fiftyTwoWeekHigh
              ? Number(stockData.fiftyTwoWeekHigh)
              : undefined,
            fiftyTwoWeekLow: stockData.fiftyTwoWeekLow
              ? Number(stockData.fiftyTwoWeekLow)
              : undefined,
          },
          currentPrice,
        )
      : "財務データなし";

    const ohlcvPrices = prices.map((p) => ({
      date: p.date,
      open: p.open,
      high: p.high,
      low: p.low,
      close: p.close,
    }));

    const technicalContext = buildTechnicalContext(ohlcvPrices);
    const candlestickContext = buildCandlestickContext(ohlcvPrices);
    const chartPatternContext = buildChartPatternContext(
      ohlcvPrices,
      investmentStyle,
    );
    const trendlineContext = buildTrendlineContext(ohlcvPrices);
    const { text: weekChangeContext, rate: weekChangeRate } =
      buildWeekChangeContext(ohlcvPrices);
    const deviationRateContext = buildDeviationRateContext(ohlcvPrices);

    // 乖離率の数値（後補正用）
    const pricesNewestFirst = [...ohlcvPrices]
      .reverse()
      .map((p) => ({ close: p.close }));
    const deviationRate = calculateDeviationRate(
      pricesNewestFirst,
      MA_DEVIATION.PERIOD,
    );

    // AI予測コンテキスト
    const analysis = analysisMap.get(candidate.id);
    const predictionContext = analysis
      ? `\n【AI予測データ】
- 短期予測: ${trendLabel(analysis.shortTermTrend)} (${Number(analysis.shortTermPriceLow).toLocaleString()}〜${Number(analysis.shortTermPriceHigh).toLocaleString()}円)
- 中期予測: ${trendLabel(analysis.midTermTrend)} (${Number(analysis.midTermPriceLow).toLocaleString()}〜${Number(analysis.midTermPriceHigh).toLocaleString()}円)
- 長期予測: ${trendLabel(analysis.longTermTrend)} (${Number(analysis.longTermPriceLow).toLocaleString()}〜${Number(analysis.longTermPriceHigh).toLocaleString()}円)
- AI推奨: ${analysis.recommendation === "buy" ? "買い" : analysis.recommendation === "sell" ? "売り" : "ホールド"} (信頼度: ${(analysis.confidence * 100).toFixed(0)}%)`
      : "";

    contexts.push({
      stock: candidate,
      currentPrice,
      financialMetrics,
      technicalContext,
      candlestickContext,
      chartPatternContext,
      trendlineContext,
      weekChangeContext,
      weekChangeRate,
      deviationRateContext,
      deviationRate,
      predictionContext,
    });
  }

  console.log(`  Built contexts for ${contexts.length} stocks`);
  return { contexts, newsContext };
}

async function selectWithAI(
  _userId: string,
  investmentStyle: string | null,
  investmentBudget: number | null,
  remainingBudget: number | null,
  session: string,
  stockContexts: StockContext[],
  marketContext: string,
  newsContext: string,
  sectorTrendContext: string,
  isBudgetExceeded: boolean = false,
): Promise<Array<{
  tickerCode: string;
  reason: string;
  investmentTheme: string;
}> | null> {
  const styleLabel = getStyleLabel(investmentStyle);
  let budgetLabel = investmentBudget
    ? remainingBudget !== null
      ? `${remainingBudget.toLocaleString()}円（残り）/ 合計 ${investmentBudget.toLocaleString()}円`
      : `${investmentBudget.toLocaleString()}円`
    : "未設定";
  if (isBudgetExceeded) {
    budgetLabel += "（※予算内で購入可能な銘柄がないため、予算に近い銘柄を候補にしています。おすすめ理由に予算を超えている旨を含めてください）";
  }

  const stockSummaries = stockContexts
    .map((ctx, idx) => {
      const s = ctx.stock;
      return `
【候補${idx + 1}: ${s.name}（${s.tickerCode}）】
- セクター: ${s.sector || "不明"}
- 現在価格: ${ctx.currentPrice.toLocaleString()}円
- スコア: ${s.score}点

${ctx.financialMetrics}
${ctx.technicalContext}${ctx.candlestickContext}${ctx.chartPatternContext}${ctx.trendlineContext}${ctx.weekChangeContext}${ctx.deviationRateContext}${ctx.predictionContext}`;
    })
    .join("\n\n");

  const prompt = buildDailyRecommendationPrompt({
    session,
    styleLabel,
    budgetLabel,
    investmentStyle,
    stockSummaries,
    marketContext,
    sectorTrendContext,
    newsContext,
  });

  try {
    const openai = getOpenAIClient();
    const response = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "system",
          content:
            "You are a helpful investment coach for beginners. Always respond in valid JSON format only.",
        },
        { role: "user", content: prompt },
      ],
      temperature: 0.4,
      max_tokens: 1200,
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "daily_recommendation",
          strict: true,
          schema: {
            type: "object",
            properties: {
              marketSignal: {
                type: "string",
                enum: ["bullish", "neutral", "bearish"],
              },
              selections: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    tickerCode: { type: "string" },
                    reason: { type: "string" },
                    investmentTheme: {
                      type: "string",
                      enum: INVESTMENT_THEMES,
                    },
                  },
                  required: ["tickerCode", "reason", "investmentTheme"],
                  additionalProperties: false,
                },
              },
            },
            required: ["marketSignal", "selections"],
            additionalProperties: false,
          },
        },
      },
    });

    const content = response.choices[0].message.content?.trim() || "{}";
    const result = JSON.parse(content);

    if (!result.selections || !Array.isArray(result.selections)) {
      console.error("  Invalid AI response format");
      return null;
    }

    const validSelections = result.selections
      .filter(
        (s: {
          tickerCode?: string;
          reason?: string;
          investmentTheme?: string;
        }) => s.tickerCode && s.reason && s.investmentTheme,
      )
      .slice(0, 5);

    // AI後のログ警告: 危険な銘柄を検出してログに記録（除外はしない）
    for (const selection of validSelections) {
      const ctx = stockContexts.find(
        (c: StockContext) => c.stock.tickerCode === selection.tickerCode,
      );
      if (!ctx) continue;

      const s = ctx.stock;
      const volatility = s.volatility !== null ? Number(s.volatility) : null;

      if (isInDecline(ctx.weekChangeRate, investmentStyle)) {
        console.warn(
          `  ⚠️ Safety warning: ${s.tickerCode} is in decline (week: ${ctx.weekChangeRate?.toFixed(0)}%)`,
        );
      }
      if (isSurgeStock(ctx.weekChangeRate, investmentStyle)) {
        console.warn(
          `  ⚠️ Safety warning: ${s.tickerCode} is surge stock (week: +${ctx.weekChangeRate?.toFixed(0)}%)`,
        );
      }
      if (isDangerousStock(s.isProfitable, volatility)) {
        console.warn(
          `  ⚠️ Safety warning: ${s.tickerCode} is dangerous (unprofitable + high volatility)`,
        );
      }
      if (isOverheated(ctx.deviationRate, investmentStyle)) {
        console.warn(
          `  ⚠️ Safety warning: ${s.tickerCode} is overheated (deviation: +${ctx.deviationRate?.toFixed(1)}%)`,
        );
      }
    }

    console.log(
      `  AI selected ${validSelections.length} stocks (marketSignal: ${result.marketSignal})`,
    );
    return validSelections;
  } catch (error) {
    console.error("  AI selection error:", error);
    return null;
  }
}

async function saveRecommendations(
  userId: string,
  recommendations: Array<{
    tickerCode: string;
    reason: string;
    investmentTheme: string;
  }>,
  candidates: ScoredStock[],
): Promise<number> {
  const today = getTodayForDB();
  const now = new Date();

  const stockMap = new Map(candidates.map((s) => [s.tickerCode, s]));

  let saved = 0;

  for (let idx = 0; idx < recommendations.length; idx++) {
    const rec = recommendations[idx];
    const stock = stockMap.get(rec.tickerCode);

    if (!stock) {
      console.log(`  Warning: Stock not found for ticker ${rec.tickerCode}`);
      continue;
    }

    try {
      const savedRec = await prisma.userDailyRecommendation.upsert({
        where: {
          userId_date_position: {
            userId,
            date: today,
            position: idx + 1,
          },
        },
        update: {
          stockId: stock.id,
          reason: rec.reason,
          investmentTheme: rec.investmentTheme,
        },
        create: {
          userId,
          date: today,
          stockId: stock.id,
          position: idx + 1,
          reason: rec.reason,
          investmentTheme: rec.investmentTheme,
        },
      });

      saved++;

      await insertRecommendationOutcome({
        type: "daily",
        recommendationId: savedRec.id,
        stockId: stock.id,
        tickerCode: stock.tickerCode,
        sector: stock.sector,
        recommendedAt: now,
        priceAtRec: stock.latestPrice || 0,
        prediction: "buy",
        confidence: null,
        volatility: stock.volatility,
        marketCap: stock.marketCap
          ? BigInt(Math.round(stock.marketCap * 100_000_000))
          : null,
      });
    } catch (error) {
      console.error(
        `  Error saving recommendation for ${rec.tickerCode}:`,
        error,
      );
    }
  }

  return saved;
}
