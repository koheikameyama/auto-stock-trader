import { prisma } from "@/lib/prisma";
import { getOpenAIClient } from "@/lib/openai";
import { getRelatedNews, formatNewsForPrompt } from "@/lib/news-rag";
import {
  fetchHistoricalPrices,
  fetchStockPrices,
} from "@/lib/stock-price-fetcher";
import {
  buildFinancialMetrics,
  buildCandlestickContext,
  buildTechnicalContext,
  buildChartPatternContext,
  buildWeekChangeContext,
  buildMarketContext,
  buildDeviationRateContext,
  buildDelistingContext,
  buildVolumeAnalysisContext,
  buildRelativeStrengthContext,
  buildTrendlineContext,
} from "@/lib/stock-analysis-context";
import { buildPurchaseRecommendationPrompt } from "@/lib/prompts/purchase-recommendation-prompt";
import { MA_DEVIATION, SELL_TIMING } from "@/lib/constants";
import {
  calculateDeviationRate,
  calculateSMA,
  calculateRSI,
  calculateMACD,
} from "@/lib/technical-indicators";
import { getTodayForDB } from "@/lib/date-utils";
import { insertRecommendationOutcome, Prediction } from "@/lib/outcome-utils";
import { getNikkei225Data, MarketIndexData } from "@/lib/market-index";
import { applyPurchaseStyleSafetyRules, type StyleAnalysesMap, type PurchaseStyleAnalysis } from "@/lib/style-analysis";
import { calculatePortfolioFromTransactions } from "@/lib/portfolio-calculator";
import {
  isDangerousStock,
  isUnprofitableSurge,
} from "@/lib/stock-safety-rules";
import { getSectorTrend, formatSectorTrendForPrompt } from "@/lib/sector-trend";
import { AnalysisError } from "@/lib/portfolio-analysis-core";
import {
  getCombinedSignal,
  analyzeSingleCandle,
} from "@/lib/candlestick-patterns";
import { detectChartPatterns } from "@/lib/chart-patterns";

export interface PurchaseRecommendationResult {
  stockId: string;
  stockName: string;
  tickerCode: string;
  currentPrice: number;
  marketSignal: string | null;
  shortTermTrend: string | null;
  shortTermPriceLow: number | null;
  shortTermPriceHigh: number | null;
  shortTermText: string | null;
  midTermTrend: string | null;
  midTermPriceLow: number | null;
  midTermPriceHigh: number | null;
  midTermText: string | null;
  longTermTrend: string | null;
  longTermPriceLow: number | null;
  longTermPriceHigh: number | null;
  longTermText: string | null;
  advice: string | null;
  recommendation: string;
  confidence: number;
  reason: string;
  caution: string;
  positives: string | null;
  concerns: string | null;
  suitableFor: string | null;
  buyCondition: string | null;
  buyTiming: string | null;
  dipTargetPrice: number | null;
  sellTiming: string | null;
  sellTargetPrice: number | null;
  userFitScore: number | null;
  budgetFit: boolean | null;
  periodFit: boolean | null;
  riskFit: boolean | null;
  personalizedReason: string | null;
  analyzedAt: string;
  styleAnalyses: StyleAnalysesMap<PurchaseStyleAnalysis> | null;
}

/**
 * 購入判断のコアロジック
 * APIルート・fire-and-forget両方から呼ばれる単一ソースオブトゥルース
 */
export async function executePurchaseRecommendation(
  userId: string | null,
  stockId: string,
): Promise<PurchaseRecommendationResult> {
  // 銘柄情報を取得（財務指標も含む）
  const stock = await prisma.stock.findUnique({
    where: { id: stockId },
    select: {
      id: true,
      tickerCode: true,
      name: true,
      sector: true,
      marketCap: true,
      dividendYield: true,
      pbr: true,
      per: true,
      roe: true,
      isProfitable: true,
      profitTrend: true,
      revenueGrowth: true,
      eps: true,
      fiftyTwoWeekHigh: true,
      fiftyTwoWeekLow: true,
      volatility: true,
      isDelisted: true,
      fetchFailCount: true,
    },
  });

  if (!stock) {
    throw new AnalysisError("銘柄が見つかりません", "NOT_FOUND");
  }

  // ユーザー設定を取得
  const userSettings = userId
    ? await prisma.userSettings.findUnique({
        where: { userId },
        select: {
          investmentStyle: true,
          investmentBudget: true,
        },
      })
    : null;

  // 残り予算を計算
  let remainingBudget: number | null = null;
  if (userId && userSettings?.investmentBudget) {
    const userPortfolioStocks = await prisma.portfolioStock.findMany({
      where: { userId },
      select: {
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
    });
    let holdingsCost = 0;
    for (const ps of userPortfolioStocks) {
      const { quantity, averagePurchasePrice } =
        calculatePortfolioFromTransactions(ps.transactions);
      if (quantity > 0) {
        holdingsCost += quantity * averagePurchasePrice.toNumber();
      }
    }
    remainingBudget = Math.max(0, userSettings.investmentBudget - holdingsCost);
  }

  // staleチェック兼リアルタイム株価取得
  const { prices: realtimePrices, staleTickers: staleCheck } =
    await fetchStockPrices([stock.tickerCode]);
  if (staleCheck.includes(stock.tickerCode)) {
    throw new AnalysisError(
      "最新の株価が取得できないため分析がおこなえません",
      "STALE_DATA",
    );
  }

  // 直近30日の価格データを取得
  const historicalPrices = await fetchHistoricalPrices(stock.tickerCode, "1m");
  const prices = historicalPrices.slice(-30); // oldest-first

  if (prices.length === 0) {
    throw new AnalysisError("価格データがありません", "NO_PRICE_DATA");
  }

  // ローソク足パターン分析
  const patternContext = buildCandlestickContext(prices);

  // テクニカル指標の計算（RSI/MACD）
  const technicalContext = buildTechnicalContext(prices);

  // チャートパターン（複数足フォーメーション）の検出
  const chartPatternContext = buildChartPatternContext(
    prices,
    userSettings?.investmentStyle,
  );

  // 移動平均乖離率
  const deviationRateContext = buildDeviationRateContext(prices);

  // 出来高分析
  const volumeAnalysisContext = buildVolumeAnalysisContext(prices);

  // トレンドライン
  const trendlineContext = buildTrendlineContext(prices);

  // 関連ニュースを取得
  const tickerCode = stock.tickerCode.replace(".T", "");
  const news = await getRelatedNews({
    tickerCodes: [tickerCode],
    sectors: stock.sector ? [stock.sector] : [],
    limit: 5,
    daysAgo: 7,
  });
  const newsContext =
    news.length > 0
      ? `\n【最新のニュース情報】\n${formatNewsForPrompt(news)}`
      : "";

  // 既存の予測データを取得（StockAnalysisから）
  const analysis = await prisma.stockAnalysis.findFirst({
    where: { stockId },
    orderBy: { analyzedAt: "desc" },
  });

  const trendLabel = (trend: string) =>
    trend === "up" ? "上昇" : trend === "down" ? "下落" : "横ばい";

  const predictionContext = analysis
    ? `
【前回のAI予測データ（参考情報）】
※ 以下は前回の分析時の価格予測です。参考にしつつ、最新データとの乖離に注意してください。

■ 短期予測（今週）: ${trendLabel(analysis.shortTermTrend)}
  - 予測価格帯: ${Number(analysis.shortTermPriceLow).toLocaleString()}円 〜 ${Number(analysis.shortTermPriceHigh).toLocaleString()}円
  - 解説: ${analysis.shortTermText || "解説なし"}

■ 中期予測（今月）: ${trendLabel(analysis.midTermTrend)}
  - 予測価格帯: ${Number(analysis.midTermPriceLow).toLocaleString()}円 〜 ${Number(analysis.midTermPriceHigh).toLocaleString()}円
  - 解説: ${analysis.midTermText || "解説なし"}

■ 長期予測（3ヶ月）: ${trendLabel(analysis.longTermTrend)}
  - 予測価格帯: ${Number(analysis.longTermPriceLow).toLocaleString()}円 〜 ${Number(analysis.longTermPriceHigh).toLocaleString()}円
  - 解説: ${analysis.longTermText || "解説なし"}

■ 総合判断: ${analysis.recommendation === "buy" ? "買い推奨" : analysis.recommendation === "sell" ? "売り推奨" : "ホールド"}
■ アドバイス: ${analysis.advice || "なし"}
■ 信頼度: ${(analysis.confidence * 100).toFixed(0)}%
`
    : "";

  // 市場全体の状況を取得
  let marketData: MarketIndexData | null = null;
  try {
    marketData = await getNikkei225Data();
  } catch (error) {
    console.error("市場データ取得失敗（フォールバック）:", error);
  }

  const currentPrice =
    realtimePrices[0]?.currentPrice ??
    (prices[0] ? Number(prices[0].close) : 0);

  // 週間変化率を計算
  const { text: weekChangeContext, rate: weekChangeRate } =
    buildWeekChangeContext(prices);

  // 市場全体の状況コンテキスト
  const marketContext = buildMarketContext(marketData);

  // セクタートレンド
  let sectorTrendContext = "";
  let sectorAvgWeekChangeRate: number | null = null;
  if (stock.sector) {
    const sectorTrend = await getSectorTrend(stock.sector);
    if (sectorTrend) {
      sectorTrendContext = `\n【セクタートレンド】\n${formatSectorTrendForPrompt(sectorTrend)}\n`;
      sectorAvgWeekChangeRate = sectorTrend.avgWeekChangeRate ?? null;
    }
  }

  // 相対強度分析
  const relativeStrengthContext = buildRelativeStrengthContext(
    weekChangeRate,
    marketData?.weekChangeRate ?? null,
    sectorAvgWeekChangeRate,
  );

  // 財務指標のフォーマット
  const financialMetrics = buildFinancialMetrics(stock, currentPrice);

  // 上場廃止コンテキスト
  const delistingContext = buildDelistingContext(
    stock.isDelisted,
    stock.fetchFailCount,
  );

  // ユーザー設定のコンテキスト
  const styleMap: Record<string, string> = {
    CONSERVATIVE: "慎重派（守り） - 資産保護を最優先",
    BALANCED: "バランス型 - リスクとリワードのバランス",
    AGGRESSIVE: "積極派（攻め） - 利益の最大化を優先",
  };

  const userContext = userSettings
    ? `
【ユーザーの投資設定】
- 投資スタイル: ${styleMap[userSettings.investmentStyle] || userSettings.investmentStyle}
- 投資予算（合計）: ${userSettings.investmentBudget ? `${userSettings.investmentBudget.toLocaleString()}円` : "未設定"}
- 投資予算（残り）: ${remainingBudget !== null ? `${remainingBudget.toLocaleString()}円` : userSettings.investmentBudget ? "未計算" : "未設定"}
`
    : "";

  const hasPrediction = analysis !== null;

  const prompt = buildPurchaseRecommendationPrompt({
    stockName: stock.name,
    tickerCode: stock.tickerCode,
    sector: stock.sector,
    currentPrice,
    financialMetrics,
    userContext,
    predictionContext,
    pricesCount: prices.length,
    delistingContext,
    weekChangeContext,
    marketContext,
    sectorTrendContext,
    patternContext,
    technicalContext,
    chartPatternContext,
    deviationRateContext,
    volumeAnalysisContext,
    relativeStrengthContext,
    trendlineContext,
    newsContext,
    hasPrediction,
  });

  // OpenAI API呼び出し（Structured Outputs使用）
  const openai = getOpenAIClient();
  const response = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [
      {
        role: "system",
        content: "You are a helpful investment coach for beginners.",
      },
      { role: "user", content: prompt },
    ],
    temperature: 0.4,
    max_tokens: 2000,
    response_format: {
      type: "json_schema",
      json_schema: {
        name: "purchase_recommendation",
        strict: true,
        schema: {
          type: "object",
          properties: {
            marketSignal: {
              type: "string",
              enum: ["bullish", "neutral", "bearish"],
            },
            shortTermTrend: { type: "string", enum: ["up", "neutral", "down"] },
            shortTermPriceLow: { type: "number" },
            shortTermPriceHigh: { type: "number" },
            shortTermText: { type: "string" },
            midTermTrend: { type: "string", enum: ["up", "neutral", "down"] },
            midTermPriceLow: { type: "number" },
            midTermPriceHigh: { type: "number" },
            midTermText: { type: "string" },
            longTermTrend: { type: "string", enum: ["up", "neutral", "down"] },
            longTermPriceLow: { type: "number" },
            longTermPriceHigh: { type: "number" },
            longTermText: { type: "string" },
            positives: { type: ["string", "null"] },
            concerns: { type: ["string", "null"] },
            suitableFor: { type: ["string", "null"] },
            styleAnalyses: {
              type: "object",
              properties: {
                CONSERVATIVE: {
                  type: "object",
                  properties: {
                    recommendation: { type: "string", enum: ["buy", "stay", "avoid"] },
                    confidence: { type: "number" },
                    statusType: {
                      type: "string",
                      enum: ["即時売却", "戻り売り", "ホールド", "押し目買い", "全力買い"],
                    },
                    advice: { type: "string" },
                    reason: { type: "string" },
                    caution: { type: "string" },
                    buyCondition: { type: ["string", "null"] },
                    suggestedDipPrice: { type: ["number", "null"] },
                    suggestedStopLossRate: { type: "number" },
                    suggestedTakeProfitRate: { type: "number" },
                  },
                  required: ["recommendation", "confidence", "statusType", "advice", "reason", "caution", "buyCondition", "suggestedDipPrice", "suggestedStopLossRate", "suggestedTakeProfitRate"],
                  additionalProperties: false,
                },
                BALANCED: {
                  type: "object",
                  properties: {
                    recommendation: { type: "string", enum: ["buy", "stay", "avoid"] },
                    confidence: { type: "number" },
                    statusType: {
                      type: "string",
                      enum: ["即時売却", "戻り売り", "ホールド", "押し目買い", "全力買い"],
                    },
                    advice: { type: "string" },
                    reason: { type: "string" },
                    caution: { type: "string" },
                    buyCondition: { type: ["string", "null"] },
                    suggestedDipPrice: { type: ["number", "null"] },
                    suggestedStopLossRate: { type: "number" },
                    suggestedTakeProfitRate: { type: "number" },
                  },
                  required: ["recommendation", "confidence", "statusType", "advice", "reason", "caution", "buyCondition", "suggestedDipPrice", "suggestedStopLossRate", "suggestedTakeProfitRate"],
                  additionalProperties: false,
                },
                AGGRESSIVE: {
                  type: "object",
                  properties: {
                    recommendation: { type: "string", enum: ["buy", "stay", "avoid"] },
                    confidence: { type: "number" },
                    statusType: {
                      type: "string",
                      enum: ["即時売却", "戻り売り", "ホールド", "押し目買い", "全力買い"],
                    },
                    advice: { type: "string" },
                    reason: { type: "string" },
                    caution: { type: "string" },
                    buyCondition: { type: ["string", "null"] },
                    suggestedDipPrice: { type: ["number", "null"] },
                    suggestedStopLossRate: { type: "number" },
                    suggestedTakeProfitRate: { type: "number" },
                  },
                  required: ["recommendation", "confidence", "statusType", "advice", "reason", "caution", "buyCondition", "suggestedDipPrice", "suggestedStopLossRate", "suggestedTakeProfitRate"],
                  additionalProperties: false,
                },
              },
              required: ["CONSERVATIVE", "BALANCED", "AGGRESSIVE"],
              additionalProperties: false,
            },
            userFitScore: { type: ["number", "null"] },
            budgetFit: { type: ["boolean", "null"] },
            periodFit: { type: ["boolean", "null"] },
            riskFit: { type: ["boolean", "null"] },
            personalizedReason: { type: ["string", "null"] },
          },
          required: [
            "marketSignal",
            "shortTermTrend",
            "shortTermPriceLow",
            "shortTermPriceHigh",
            "shortTermText",
            "midTermTrend",
            "midTermPriceLow",
            "midTermPriceHigh",
            "midTermText",
            "longTermTrend",
            "longTermPriceLow",
            "longTermPriceHigh",
            "longTermText",
            "positives",
            "concerns",
            "suitableFor",
            "styleAnalyses",
            "userFitScore",
            "budgetFit",
            "periodFit",
            "riskFit",
            "personalizedReason",
          ],
          additionalProperties: false,
        },
      },
    },
  });

  const content = response.choices[0].message.content?.trim() || "{}";
  const result = JSON.parse(content);

  // --- 強制補正ロジック（Hard Overrides） ---

  // 1. テクニカル総合判定による強制ブレーキ (Consistency Fix)
  // ポートフォリオ側と同じロジックで強い売りシグナルが出ている場合は、AIの回答に関わらず stay にする
  const pricesNewestFirst = [...prices].reverse().map((p) => ({
    date: p.date,
    open: p.open,
    high: p.high,
    low: p.low,
    close: p.close,
  }));

  const rsiValue = calculateRSI(pricesNewestFirst, 14);
  const macd = calculateMACD(pricesNewestFirst);
  const candlestickPatterns = prices.slice(-1).map((p) => ({
    date: p.date,
    open: p.open,
    high: p.high,
    low: p.low,
    close: p.close,
  }));
  const latestCandle = candlestickPatterns[0];

  const chartPatterns = detectChartPatterns(
    prices.map((p) => ({
      date: p.date,
      open: p.open,
      high: p.high,
      low: p.low,
      close: p.close,
    })),
  );

  const combinedTechnical = getCombinedSignal(
    latestCandle ? analyzeSingleCandle(latestCandle) : null,
    rsiValue,
    macd.histogram,
    chartPatterns,
  );

  const investmentStyle = userSettings?.investmentStyle ?? null;

  // 今日のおすすめ銘柄かどうかを確認
  const isRecommendedToday = await prisma.userDailyRecommendation.findFirst({
    where: {
      userId: userId || undefined,
      stockId: stockId,
      date: getTodayForDB(),
    },
  });

  // おすすめ銘柄の場合は、モメンタムやボラティリティの強制ストップ（stay化）をスキップする
  // （AIがおすすめと判断したのに「気になる」に入れたら即「見送り」になるのを防ぐため）
  const skipSafetyRules = !!isRecommendedToday;

  // 危険銘柄の強制補正用
  const volatility = stock.volatility ? Number(stock.volatility) : null;

  // 移動平均乖離率の計算
  const deviationRate = calculateDeviationRate(
    pricesNewestFirst,
    MA_DEVIATION.PERIOD,
  );

  // 下方乖離ボーナス用
  const isLowVolatility =
    volatility !== null && volatility <= MA_DEVIATION.LOW_VOLATILITY_THRESHOLD;

  // --- 強制補正ロジックを全3スタイルに適用 ---
  const ALL_STYLE_KEYS = ["CONSERVATIVE", "BALANCED", "AGGRESSIVE"] as const;
  for (const styleKey of ALL_STYLE_KEYS) {
    const sa = result.styleAnalyses[styleKey];

    // テクニカル総合判定ブレーキ
    if (combinedTechnical.signal === "sell" && combinedTechnical.strength >= 70) {
      if (sa.recommendation === "buy") {
        sa.recommendation = "stay";
        sa.statusType = "ホールド";
        sa.confidence = Math.max(0.5, combinedTechnical.strength / 100);
        sa.reason = `テクニカル指標で強い下落シグナル（${combinedTechnical.reasons.join("、")}）が出ているため、購入は下げ止まりを確認してからを推奨します。 ${sa.reason}`;
        sa.caution = `最新のローソク足パターン等が強い下落（強さ${combinedTechnical.strength}%）を示しています。${sa.caution}`;
        sa.buyCondition = "テクニカルシグナルが好転し、下げ止まりを確認できたら検討してください";
        if (styleKey === "CONSERVATIVE") {
          sa.statusType = "ホールド";
          sa.advice = `テクニカル指標が下落シグナルを示しています。シグナルの好転を確認してから購入を検討しましょう。`;
        }
      }
    }

    // avoid は confidence >= 0.8 の場合のみ許可
    if (sa.recommendation === "avoid" && sa.confidence < 0.8) {
      sa.recommendation = "stay";
      sa.statusType = "ホールド";
    }

    // 危険銘柄の強制補正
    if (!skipSafetyRules && isDangerousStock(stock.isProfitable, volatility) && sa.recommendation === "buy") {
      sa.recommendation = "stay";
      sa.statusType = "ホールド";
      sa.caution = `業績が赤字かつボラティリティが${volatility?.toFixed(0)}%と高いため、様子見を推奨します。${sa.caution}`;
      if (styleKey === "CONSERVATIVE") {
        sa.statusType = "ホールド";
        sa.advice = `業績が赤字かつボラティリティが高いため、業績改善を確認してから購入を検討しましょう。`;
      }
    }

    // 赤字×急騰銘柄の強制補正（仕手株・バブルの可能性）
    if (isUnprofitableSurge(stock.isProfitable, weekChangeRate) && sa.recommendation === "buy") {
      sa.recommendation = "stay";
      sa.statusType = "ホールド";
      sa.caution = `業績が赤字の銘柄が週間${weekChangeRate?.toFixed(0)}%急騰しており、仕手株やバブルの可能性があります。${sa.caution}`;
      sa.buyCondition = "業績改善や急騰の裏付けとなる材料を確認してから検討してください";
      if (styleKey === "CONSERVATIVE") {
        sa.advice = `赤字企業の急騰は投機的な値動きの可能性が高いため、業績改善を確認してから購入を検討しましょう。`;
      }
    }

    // 市場急落時の強制補正
    if (marketData?.isMarketCrash && sa.recommendation === "buy") {
      sa.recommendation = "stay";
      sa.statusType = "ホールド";
      sa.reason = `市場全体が急落しているため、様子見をおすすめします。${sa.reason}`;
      sa.buyCondition = sa.buyCondition || "市場が落ち着いてから検討してください";
      if (styleKey === "CONSERVATIVE") {
        sa.statusType = "ホールド";
        sa.advice = `市場全体が急落中です。市場の安定を確認してから購入を検討しましょう。`;
      }
    }

    // 下方乖離ボーナス
    if (deviationRate !== null && deviationRate <= MA_DEVIATION.LOWER_THRESHOLD && stock.isProfitable === true && isLowVolatility) {
      sa.confidence = Math.min(1.0, sa.confidence + MA_DEVIATION.CONFIDENCE_BONUS);
    }

    // パニック売り防止
    if (deviationRate !== null && deviationRate <= SELL_TIMING.PANIC_SELL_THRESHOLD && sa.recommendation === "avoid") {
      sa.recommendation = "stay";
      sa.statusType = "ホールド";
      sa.caution = `25日移動平均線から${deviationRate.toFixed(1)}%下方乖離しており売られすぎです。大底で見送るのはもったいないため、様子見を推奨します。${sa.caution}`;
    }
  }

  // --- 投資スタイル別のセーフティルール・タイミング判定を適用 ---
  const rsiForTiming = calculateRSI(pricesNewestFirst, 14);
  const sma25ForTiming = calculateSMA(pricesNewestFirst, MA_DEVIATION.PERIOD);

  const styleAnalyses = applyPurchaseStyleSafetyRules({
    styleAnalyses: result.styleAnalyses,
    weekChangeRate,
    deviationRate,
    buyTimingParams: {
      deviationRate,
      rsi: rsiForTiming,
      sma25: sma25ForTiming,
      currentPrice,
    },
    sellTimingParams: {
      deviationRate,
      rsi: rsiForTiming,
      sma25: sma25ForTiming,
    },
    skipSafetyRules,
  });

  // ユーザーの選択スタイルの結果を取得
  const userStyle = (investmentStyle || "BALANCED") as "CONSERVATIVE" | "BALANCED" | "AGGRESSIVE";
  const userStyleResult = styleAnalyses[userStyle];

  // 購入タイミング・売りタイミングはユーザースタイルの結果を使用
  const buyTiming = userStyleResult.buyTiming;
  const dipTargetPrice = userStyleResult.dipTargetPrice;
  const sellTiming = userStyleResult.sellTiming;
  const sellTargetPrice = userStyleResult.sellTargetPrice;

  // データベースに保存
  const today = getTodayForDB();

  const savedRecommendation = await prisma.purchaseRecommendation.upsert({
    where: {
      stockId_date: {
        stockId,
        date: today,
      },
    },
    update: {
      marketSignal: result.marketSignal || null,
      recommendation: userStyleResult.recommendation,
      confidence: userStyleResult.confidence,
      reason: userStyleResult.reason,
      caution: userStyleResult.caution,
      positives: result.positives || null,
      concerns: result.concerns || null,
      suitableFor: result.suitableFor || null,
      buyCondition:
        userStyleResult.recommendation === "stay" ? userStyleResult.buyCondition || null : null,
      buyTiming: buyTiming,
      dipTargetPrice: dipTargetPrice,
      sellTiming: sellTiming,
      sellTargetPrice: sellTargetPrice,
      userFitScore: result.userFitScore ?? null,
      budgetFit: result.budgetFit ?? null,
      periodFit: result.periodFit ?? null,
      riskFit: result.riskFit ?? null,
      personalizedReason: result.personalizedReason || null,
      styleAnalyses: styleAnalyses ? JSON.parse(JSON.stringify(styleAnalyses)) : undefined,
      updatedAt: new Date(),
    },
    create: {
      stockId,
      date: today,
      marketSignal: result.marketSignal || null,
      recommendation: userStyleResult.recommendation,
      confidence: userStyleResult.confidence,
      reason: userStyleResult.reason,
      caution: userStyleResult.caution,
      positives: result.positives || null,
      concerns: result.concerns || null,
      suitableFor: result.suitableFor || null,
      buyCondition:
        userStyleResult.recommendation === "stay" ? userStyleResult.buyCondition || null : null,
      buyTiming: buyTiming,
      dipTargetPrice: dipTargetPrice,
      sellTiming: sellTiming,
      sellTargetPrice: sellTargetPrice,
      userFitScore: result.userFitScore ?? null,
      budgetFit: result.budgetFit ?? null,
      periodFit: result.periodFit ?? null,
      riskFit: result.riskFit ?? null,
      personalizedReason: result.personalizedReason || null,
      styleAnalyses: styleAnalyses ? JSON.parse(JSON.stringify(styleAnalyses)) : undefined,
    },
  });

  // StockAnalysisに価格帯予測を保存
  const now = new Date();
  await prisma.stockAnalysis.create({
    data: {
      stockId,
      shortTermTrend: result.shortTermTrend || "neutral",
      shortTermPriceLow: result.shortTermPriceLow || currentPrice || 0,
      shortTermPriceHigh: result.shortTermPriceHigh || currentPrice || 0,
      shortTermText: result.shortTermText || "",
      midTermTrend: result.midTermTrend || "neutral",
      midTermPriceLow: result.midTermPriceLow || currentPrice || 0,
      midTermPriceHigh: result.midTermPriceHigh || currentPrice || 0,
      midTermText: result.midTermText || "",
      longTermTrend: result.longTermTrend || "neutral",
      longTermPriceLow: result.longTermPriceLow || currentPrice || 0,
      longTermPriceHigh: result.longTermPriceHigh || currentPrice || 0,
      longTermText: result.longTermText || "",
      recommendation:
        userStyleResult.recommendation === "buy"
          ? "buy"
          : userStyleResult.recommendation === "avoid"
            ? "sell"
            : "hold",
      statusType:
        userStyleResult.statusType ||
        (userStyleResult.recommendation === "buy"
          ? "押し目買い"
          : userStyleResult.recommendation === "avoid"
            ? "即時売却"
            : "ホールド"),
      advice: userStyleResult.advice || userStyleResult.reason || "",
      confidence: userStyleResult.confidence || 0.7,
      limitPrice: null,
      stopLossPrice: null,
      styleAnalyses: styleAnalyses ? JSON.parse(JSON.stringify(styleAnalyses)) : undefined,
      analyzedAt: now,
    },
  });

  // Outcome追跡
  const predictionMap: Record<string, Prediction> = {
    buy: "buy",
    stay: "stay",
    avoid: "remove",
  };

  await insertRecommendationOutcome({
    type: "purchase",
    recommendationId: savedRecommendation.id,
    stockId,
    tickerCode: stock.tickerCode,
    sector: stock.sector,
    recommendedAt: new Date(),
    priceAtRec: currentPrice,
    prediction: predictionMap[userStyleResult.recommendation] || "stay",
    confidence: userStyleResult.confidence,
    volatility: volatility,
    marketCap: stock.marketCap
      ? BigInt(Number(stock.marketCap) * 100_000_000)
      : null,
  });

  return {
    stockId: stock.id,
    stockName: stock.name,
    tickerCode: stock.tickerCode,
    currentPrice: currentPrice,
    marketSignal: result.marketSignal || null,
    shortTermTrend: result.shortTermTrend || null,
    shortTermPriceLow: result.shortTermPriceLow || null,
    shortTermPriceHigh: result.shortTermPriceHigh || null,
    shortTermText: result.shortTermText || null,
    midTermTrend: result.midTermTrend || null,
    midTermPriceLow: result.midTermPriceLow || null,
    midTermPriceHigh: result.midTermPriceHigh || null,
    midTermText: result.midTermText || null,
    longTermTrend: result.longTermTrend || null,
    longTermPriceLow: result.longTermPriceLow || null,
    longTermPriceHigh: result.longTermPriceHigh || null,
    longTermText: result.longTermText || null,
    advice: userStyleResult.advice || null,
    recommendation: userStyleResult.recommendation,
    confidence: userStyleResult.confidence,
    reason: userStyleResult.reason,
    caution: userStyleResult.caution,
    positives: result.positives || null,
    concerns: result.concerns || null,
    suitableFor: result.suitableFor || null,
    buyCondition:
      userStyleResult.recommendation === "stay" ? userStyleResult.buyCondition || null : null,
    buyTiming: buyTiming,
    dipTargetPrice: dipTargetPrice,
    sellTiming: sellTiming,
    sellTargetPrice: sellTargetPrice,
    userFitScore: result.userFitScore ?? null,
    budgetFit: result.budgetFit ?? null,
    periodFit: result.periodFit ?? null,
    riskFit: result.riskFit ?? null,
    personalizedReason: result.personalizedReason || null,
    analyzedAt: today.toISOString(),
    styleAnalyses,
  };
}
