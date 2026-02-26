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
  buildGapFillContext,
  buildSupportResistanceContext,
  buildTrendlineContext,
} from "@/lib/stock-analysis-context";
import { buildPortfolioAnalysisPrompt } from "@/lib/prompts/portfolio-analysis-prompt";
import { getNikkei225Data, type MarketIndexData } from "@/lib/market-index";
import { getSectorTrend, formatSectorTrendForPrompt } from "@/lib/sector-trend";
import {
  calculateDeviationRate,
  calculateRSI,
  calculateSMA,
} from "@/lib/technical-indicators";
import {
  MA_DEVIATION,
  SELL_TIMING,
  RELATIVE_STRENGTH,
  INVESTMENT_STYLE_COEFFICIENTS,
  ATR_EXIT_STRATEGY,
  PROFIT_TAKING_PROMOTION,
} from "@/lib/constants";
import { getDaysAgoForDB } from "@/lib/date-utils";
import { isDangerousStock } from "@/lib/stock-safety-rules";
import { insertRecommendationOutcome, Prediction } from "@/lib/outcome-utils";
import { applyPortfolioStyleSafetyRules, type StyleAnalysesMap, type PortfolioStyleAnalysis } from "@/lib/style-analysis";
import dayjs from "dayjs";
import utc from "dayjs/plugin/utc";
import timezone from "dayjs/plugin/timezone";

dayjs.extend(utc);
dayjs.extend(timezone);

export class AnalysisError extends Error {
  constructor(
    message: string,
    public readonly code:
      | "NOT_FOUND"
      | "STALE_DATA"
      | "NO_PRICE_DATA"
      | "INTERNAL",
  ) {
    super(message);
  }
}

/**
 * ポートフォリオ分析のAI結果に対する共通ポストプロセス
 * executePortfolioAnalysis / executeSimulatedPortfolioAnalysis 両方から呼ばれる。
 *
 * 1. 安全補正ループ（パニック売り防止、上場廃止、危険銘柄、トレンド保護、相対強度保護）
 * 2. 率→絶対価格の算出（ATRベース損切り＋トレーリングストップ）
 * 3. 売りタイミング判定
 * 4. 投資スタイル別のセーフティルール適用
 */
const ALL_STYLE_KEYS_SHARED = ["CONSERVATIVE", "BALANCED", "AGGRESSIVE"] as const;

function postProcessPortfolioAnalysis(params: {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  result: any;
  prices: Array<{ date: string; open: number; high: number; low: number; close: number }>;
  stock: {
    isDelisted: boolean | null;
    isProfitable: boolean | null;
    volatility: unknown;
    atr14: unknown;
  };
  weekChangeRate: number | null;
  marketData: MarketIndexData | null;
  profitPercent: number | null;
  currentPrice: number;
  averagePrice: number;
  userSettings: { investmentStyle: string | null } | null;
}): {
  styleAnalyses: StyleAnalysesMap<PortfolioStyleAnalysis>;
  userStyleResult: PortfolioStyleAnalysis;
  statusType: string;
  sellTiming: string | null;
  sellTargetPrice: number | null;
  deviationRate: number | null;
} {
  const { result, prices, stock, weekChangeRate, marketData, profitPercent, currentPrice, averagePrice, userSettings } = params;

  // テクニカル指標の計算
  const pricesNewestFirst = [...prices].reverse().map((p) => ({ close: p.close }));
  const deviationRate = calculateDeviationRate(pricesNewestFirst, MA_DEVIATION.PERIOD);
  const rsiValue = calculateRSI(pricesNewestFirst);
  const sma25 = calculateSMA(pricesNewestFirst, MA_DEVIATION.PERIOD);
  const volatility = stock.volatility ? Number(stock.volatility) : null;

  // --- 安全補正を全3スタイルにループ適用 ---
  for (const styleKey of ALL_STYLE_KEYS_SHARED) {
    const sa = result.styleAnalyses[styleKey];

    // パニック売り防止: 乖離率-20%以下 → sell→hold
    if (
      deviationRate !== null &&
      deviationRate <= SELL_TIMING.PANIC_SELL_THRESHOLD &&
      sa.recommendation === "sell"
    ) {
      sa.recommendation = "hold";
      sa.statusType = "ホールド";
      sa.sellReason = null;
      sa.suggestedSellPercent = null;
      sa.sellCondition = `25日移動平均線から${deviationRate.toFixed(1)}%の下方乖離で「売られすぎ」の状態です。AIは売却を検討しましたが、大底で売るリスクを避けるため、自律反発を待つ様子見（リバウンド待ち）を推奨します。`;
      sa.shortTerm = `【一旦様子見を推奨】移動平均線から${Math.abs(deviationRate).toFixed(1)}%の異常な売られすぎ水準のため、今すぐの売却は避け、数日中の反発を待つことを推奨します。AIの当初分析: ${sa.shortTerm}`;
      sa.advice = `異常な「売られすぎ」によるパニック状態です。大底での売却を避けるため、自律反発を待つ様子見を優先しましょう。`;
    }

    // 上場廃止銘柄の強制補正
    if (stock.isDelisted) {
      sa.recommendation = "sell";
      sa.shortTerm = `この銘柄は上場廃止されています。保有している場合は証券会社に確認してください。${sa.shortTerm}`;
    }

    // 危険銘柄の買い増し抑制
    if (
      isDangerousStock(stock.isProfitable, volatility) &&
      sa.recommendation === "buy"
    ) {
      sa.recommendation = "hold";
      sa.statusType = "ホールド";
      sa.shortTerm = `業績が赤字かつボラティリティが${volatility?.toFixed(0)}%と高いため、買い増しは慎重に検討してください。${sa.shortTerm}`;
    }

    // 中長期トレンドによる売り保護（投資スタイル別、重大な変化がない場合のみ）
    // CONSERVATIVE: 長期upの場合のみ保護（中期upだけでは保護しない）
    //   ※ 含み益あり + 短期下落予兆の場合は保護を無効化（利確を優先）
    // BALANCED: 中期 or 長期がupなら保護
    // AGGRESSIVE: 保護なし（AIの売り判断を尊重）
    const shouldProtectFromSell = (() => {
      if (result.isCriticalChange) return false;
      if (profitPercent !== null && profitPercent <= SELL_TIMING.TREND_OVERRIDE_LOSS_THRESHOLD) return false;
      if (styleKey === "AGGRESSIVE") return false;
      if (styleKey === "CONSERVATIVE") {
        // 含み益あり + 短期下落予兆 → トレンド保護を無効化し、AIの売り判断（利確）を通す
        if (
          profitPercent !== null &&
          profitPercent >= PROFIT_TAKING_PROMOTION.CONSERVATIVE_MIN_PROFIT &&
          result.shortTermTrend === "down"
        ) {
          return false;
        }
        return result.longTermTrend === "up";
      }
      // BALANCED: 現行通り
      return result.midTermTrend === "up" || result.longTermTrend === "up";
    })();

    if (sa.recommendation === "sell" && shouldProtectFromSell) {
      const trendInfoArr = [
        result.midTermTrend === "up" ? "中期" : null,
        result.longTermTrend === "up" ? "長期" : null,
      ].filter(Boolean);
      const trendInfo = trendInfoArr.join("・");
      sa.recommendation = "hold";
      sa.statusType = "ホールド";
      sa.sellReason = null;
      sa.suggestedSellPercent = null;
      sa.sellCondition = `${trendInfo}の見通しが上昇のため、短期的な売りシグナルでの即売却は見送りを推奨します。${result.reconciliationMessage ? `（補足: ${result.reconciliationMessage}）` : ""}`;
      sa.shortTerm = `【一旦様子見を推奨】${trendInfo}のトレンドは引き続き上昇見通しです。短期の売りシグナルが出ていますが、中長期の回復を優先して一旦ホールドを推奨します。${result.reconciliationMessage ? `分析の変化: ${result.reconciliationMessage}` : ""}`;
      sa.advice = `${trendInfo}のトレンドは依然として良好です。短期的な変動に惑わされず、中長期での回復を待つ方針を優先しましょう。`;
    }

    // 相対強度による売り保護
    if (
      sa.recommendation === "sell" &&
      weekChangeRate !== null &&
      weekChangeRate < 0 &&
      marketData?.weekChangeRate != null &&
      (profitPercent === null ||
        profitPercent > SELL_TIMING.TREND_OVERRIDE_LOSS_THRESHOLD)
    ) {
      const relVsMarket = weekChangeRate - marketData.weekChangeRate;
      if (relVsMarket >= RELATIVE_STRENGTH.OUTPERFORM_SELL_PROTECTION) {
        sa.recommendation = "hold";
        sa.statusType = "ホールド";
        sa.sellReason = null;
        sa.suggestedSellPercent = null;
        sa.sellCondition = `市場（日経平均${marketData.weekChangeRate >= 0 ? "+" : ""}${marketData.weekChangeRate.toFixed(1)}%）に対して+${relVsMarket.toFixed(1)}%のアウトパフォームで、下落は地合い要因とみられます。${sa.sellCondition || ""}`;
        sa.shortTerm = `【様子見を推奨】市場全体が${marketData.weekChangeRate.toFixed(1)}%下落する中、この銘柄は相対的に+${relVsMarket.toFixed(1)}%強く、地合い要因による下落と判断しました。AIの短期分析: ${sa.shortTerm}`;
        sa.advice = `市場全体の下落（日経平均${marketData.weekChangeRate.toFixed(1)}%）に対してアウトパフォームしており、地合い要因の下落とみられます。様子見を推奨します。`;
      }
    }

    // 利益確定促進ルール（全スタイル対象、閾値はスタイル別）
    // 含み益あり + 短期下落予兆 → hold を sell（戻り売り）に変更して利確を促す
    if (
      sa.recommendation === "hold" &&
      profitPercent !== null &&
      result.shortTermTrend === "down"
    ) {
      const minProfit =
        styleKey === "CONSERVATIVE"
          ? PROFIT_TAKING_PROMOTION.CONSERVATIVE_MIN_PROFIT
          : styleKey === "BALANCED"
            ? PROFIT_TAKING_PROMOTION.BALANCED_MIN_PROFIT
            : PROFIT_TAKING_PROMOTION.AGGRESSIVE_MIN_PROFIT;
      const sellPercent =
        styleKey === "CONSERVATIVE"
          ? PROFIT_TAKING_PROMOTION.CONSERVATIVE_SELL_PERCENT
          : styleKey === "BALANCED"
            ? PROFIT_TAKING_PROMOTION.BALANCED_SELL_PERCENT
            : PROFIT_TAKING_PROMOTION.AGGRESSIVE_SELL_PERCENT;

      if (profitPercent >= minProfit) {
        const styleAdvice =
          styleKey === "CONSERVATIVE"
            ? "利益を守ることを最優先に、利益確定を検討しましょう。"
            : styleKey === "BALANCED"
              ? "一部利確でリスクを抑えつつ、残りで上昇余地を狙う戦略も有効です。"
              : "大きな利益を一部確保しつつ、残りのポジションで上値追いを継続しましょう。";
        const styleAction =
          styleKey === "CONSERVATIVE"
            ? "利益確定を優先し、押し目で再エントリーを検討しましょう。"
            : styleKey === "BALANCED"
              ? "一部利確でリスク低減を検討しましょう。"
              : "一部利確で利益を確保し、残りで上昇トレンドの継続を狙いましょう。";

        sa.recommendation = "sell";
        sa.statusType = "戻り売り";
        sa.suggestedSellPercent = sellPercent;
        sa.sellReason = `含み益+${profitPercent.toFixed(1)}%の状態で短期テクニカル指標に下落予兆が出ているため、利益確定を推奨します。`;
        sa.sellCondition = `短期下落トレンド中のため、利益を確保しつつ押し目（一時的な下落）での再エントリーを検討してください。`;
        sa.shortTerm = `【利確検討】含み益+${profitPercent.toFixed(1)}%で短期的に下落の予兆があります。${styleAdvice}AIの当初分析: ${sa.shortTerm}`;
        sa.advice = `含み益+${profitPercent.toFixed(1)}%を確保中ですが短期下落の予兆があります。${styleAction}`;
      }
    }
  }

  // --- 率から絶対価格を決定論的に算出 ---
  if (currentPrice && averagePrice > 0) {
    for (const styleKey of ALL_STYLE_KEYS_SHARED) {
      const sa = result.styleAnalyses[styleKey];
      const { suggestedSellPrice, suggestedStopLossPrice } =
        calculatePricesFromRates({
          currentPrice,
          averagePrice,
          sellTargetRate: sa.suggestedSellTargetRate,
          exitRate: sa.suggestedExitRate,
          atr14: stock.atr14 ? Number(stock.atr14) : null,
          investmentStyle: styleKey,
        });
      sa.suggestedSellPrice = suggestedSellPrice;
      sa.suggestedStopLossPrice = suggestedStopLossPrice;
    }
  }

  // ユーザーの選択スタイルの結果を取得
  const investmentStyle = userSettings?.investmentStyle ?? null;
  const userStyle = (investmentStyle || "BALANCED") as "CONSERVATIVE" | "BALANCED" | "AGGRESSIVE";
  const userStyleResult = result.styleAnalyses[userStyle];

  // 売りタイミング判定
  let sellTiming: string | null = null;
  let sellTargetPrice: number | null = null;
  if (userStyleResult.recommendation === "sell") {
    if (
      profitPercent !== null &&
      profitPercent <= SELL_TIMING.STOP_LOSS_THRESHOLD
    ) {
      sellTiming = "market";
    } else if (
      profitPercent !== null &&
      profitPercent >= SELL_TIMING.PROFIT_TAKING_THRESHOLD
    ) {
      sellTiming = "market";
    } else {
      const isDeviationOk =
        deviationRate === null ||
        deviationRate >= SELL_TIMING.DEVIATION_LOWER_THRESHOLD;
      const isRsiOk =
        rsiValue === null || rsiValue >= SELL_TIMING.RSI_OVERSOLD_THRESHOLD;
      if (deviationRate === null && rsiValue === null) {
        sellTiming = null;
      } else if (isDeviationOk && isRsiOk) {
        sellTiming = "market";
      } else {
        sellTiming = "rebound";
        sellTargetPrice = sma25;
      }
    }
  }

  // statusType
  const statusType =
    userStyleResult.statusType ||
    (userStyleResult.recommendation === "sell"
      ? "即時売却"
      : userStyleResult.recommendation === "buy"
        ? "押し目買い"
        : "ホールド");

  // 戻り売りステータスの場合、sellTimingとsellTargetPriceを強制設定
  if (statusType === "戻り売り") {
    if (sellTiming !== "rebound") {
      sellTiming = "rebound";
    }
    if (!sellTargetPrice && sma25 !== null) {
      sellTargetPrice = sma25;
    }
  }

  // SMA25がない場合のフォールバック
  if (!sellTargetPrice && sellTiming === "rebound" && userStyleResult.suggestedSellPrice) {
    sellTargetPrice = userStyleResult.suggestedSellPrice;
  }

  // --- 投資スタイル別のセーフティルールを適用 ---
  const styleAnalyses = applyPortfolioStyleSafetyRules({
    styleAnalyses: Object.fromEntries(
      ALL_STYLE_KEYS_SHARED.map((key) => [key, {
        ...result.styleAnalyses[key],
        marketSignal: result.marketSignal || "neutral",
        sellTiming: null,
        sellTargetPrice: null,
      }])
    ) as StyleAnalysesMap<PortfolioStyleAnalysis>,
    weekChangeRate,
    sma25,
    sellTimingBase: sellTiming,
    sellTargetPriceBase: sellTargetPrice,
  });

  return {
    styleAnalyses,
    userStyleResult,
    statusType,
    sellTiming,
    sellTargetPrice,
    deviationRate,
  };
}

/**
 * AIが出力した率（rate）から売却目標価格・撤退ライン価格を決定論的に算出する。
 * ATRベース損切り: ATRが利用可能な場合、ボラティリティに応じた損切り幅をフロアとして適用。
 * トレーリングストップ: 含み益がある場合、撤退ラインの下限は平均取得単価とする。
 */
function calculatePricesFromRates(params: {
  currentPrice: number;
  averagePrice: number;
  sellTargetRate: number | null;
  exitRate: number | null;
  atr14?: number | null;
  investmentStyle?: string;
}): {
  suggestedSellPrice: number | null;
  suggestedStopLossPrice: number | null;
} {
  const { currentPrice, averagePrice, sellTargetRate, exitRate, atr14, investmentStyle } = params;

  const suggestedSellPrice =
    sellTargetRate != null
      ? Math.round(currentPrice * (1 + sellTargetRate))
      : null;

  let suggestedStopLossPrice: number | null = null;
  if (exitRate != null) {
    let effectiveExitRate = exitRate;

    // ATRベース損切りフロア: ボラティリティに応じた最低限の損切り幅を保証
    const style = (investmentStyle || "BALANCED") as keyof typeof INVESTMENT_STYLE_COEFFICIENTS.STOP_LOSS;
    const multiplier = INVESTMENT_STYLE_COEFFICIENTS.STOP_LOSS[style] ?? 2.5;

    if (atr14 != null && atr14 > 0 && currentPrice > 0) {
      const atrBasedRate = (atr14 * multiplier) / currentPrice;
      effectiveExitRate = Math.max(exitRate, atrBasedRate);
    } else {
      // ATRが利用できない場合のフォールバック
      const fallback = ATR_EXIT_STRATEGY.FALLBACK_STOP_LOSS[style] ?? 8;
      const fallbackRate = fallback / 100;
      effectiveExitRate = Math.max(exitRate, fallbackRate);
    }

    const rawStopLoss = Math.round(currentPrice * (1 - effectiveExitRate));
    const hasUnrealizedGain = currentPrice > averagePrice;
    suggestedStopLossPrice = hasUnrealizedGain
      ? Math.max(rawStopLoss, Math.round(averagePrice))
      : rawStopLoss;
  }

  return { suggestedSellPrice, suggestedStopLossPrice };
}

export interface PortfolioAnalysisResult {
  shortTerm: string;
  shortTermText: string;
  mediumTerm: string;
  midTermText: string;
  longTerm: string;
  longTermText: string;
  statusType: string;
  marketSignal: string | null;
  suggestedSellPrice: number | null;
  suggestedSellPercent: number | null;
  sellReason: string | null;
  sellCondition: string | null;
  sellTiming: string | null;
  sellTargetPrice: number | null;
  recommendation: string | null;
  lastAnalysis: string;
  isToday: true;
  styleAnalyses?: StyleAnalysesMap<PortfolioStyleAnalysis> | null;
}

/**
 * ポートフォリオ分析のコアロジック
 * APIルート・fire-and-forget両方から呼ばれる単一ソースオブトゥルース
 */
export async function executePortfolioAnalysis(
  userId: string,
  stockId: string,
): Promise<PortfolioAnalysisResult> {
  // ポートフォリオ銘柄と株式情報を取得
  const portfolioStock = await prisma.portfolioStock.findFirst({
    where: {
      userId,
      stockId,
    },
    include: {
      stock: true,
      transactions: {
        orderBy: { transactionDate: "asc" },
      },
    },
  });

  if (!portfolioStock) {
    throw new AnalysisError(
      "この銘柄はポートフォリオに登録されていません",
      "NOT_FOUND",
    );
  }

  // 保有数量と平均取得単価を計算
  let quantity = 0;
  let totalBuyCost = 0;
  let totalBuyQuantity = 0;

  for (const tx of portfolioStock.transactions) {
    if (tx.type === "buy") {
      quantity += tx.quantity;
      totalBuyCost += Number(tx.totalAmount);
      totalBuyQuantity += tx.quantity;
    } else {
      quantity -= tx.quantity;
    }
  }

  // 保有数ゼロの銘柄は分析スキップ
  if (quantity <= 0) {
    throw new AnalysisError(
      "保有数がゼロの銘柄は分析できません",
      "NOT_FOUND",
    );
  }

  const averagePrice =
    totalBuyQuantity > 0 ? totalBuyCost / totalBuyQuantity : 0;

  // ユーザー設定を取得
  const userSettings = await prisma.userSettings.findUnique({
    where: { userId },
    select: {
      investmentStyle: true,
      targetReturnRate: true,
      stopLossRate: true,
    },
  });

  // staleチェック: 株価データが古すぎる銘柄は分析スキップ
  const { prices: realtimePrices, staleTickers: staleCheck } =
    await fetchStockPrices([portfolioStock.stock.tickerCode]);
  if (staleCheck.includes(portfolioStock.stock.tickerCode)) {
    throw new AnalysisError(
      "最新の株価が取得できないため分析がおこなえません",
      "STALE_DATA",
    );
  }

  // リアルタイム株価を取得
  const currentPrice = realtimePrices[0]?.currentPrice ?? null;

  // 損益計算
  let profit: number | null = null;
  let profitPercent: number | null = null;
  if (currentPrice && averagePrice > 0 && quantity > 0) {
    const totalCost = averagePrice * quantity;
    const currentValue = currentPrice * quantity;
    profit = currentValue - totalCost;
    profitPercent = (profit / totalCost) * 100;
  }

  // 直近30日の価格データを取得（yfinanceからリアルタイム取得）
  const historicalPrices = await fetchHistoricalPrices(
    portfolioStock.stock.tickerCode,
    "1m",
  );
  const prices = historicalPrices.slice(-30); // oldest-first

  // ローソク足パターン分析
  const patternContext = buildCandlestickContext(prices);

  // テクニカル指標（RSI / MACD）
  const technicalContext = buildTechnicalContext(prices);

  // チャートパターン（複数足フォーメーション）の検出
  const chartPatternContext = buildChartPatternContext(
    prices,
    userSettings?.investmentStyle,
  );

  // 週間変化率
  const { text: weekChangeContext, rate: weekChangeRate } =
    buildWeekChangeContext(prices);

  // 乖離率コンテキスト
  const deviationRateContext = buildDeviationRateContext(prices);

  // 出来高分析
  const volumeAnalysisContext = buildVolumeAnalysisContext(prices);

  // 窓埋め判定
  const gapFillContext = buildGapFillContext(prices);

  // 支持線・抵抗線
  const supportResistanceContext = buildSupportResistanceContext(prices);

  // トレンドライン
  const trendlineContext = buildTrendlineContext(prices);

  // 関連ニュースを取得
  const tickerCodeSlug = portfolioStock.stock.tickerCode.replace(".T", "");
  const news = await getRelatedNews({
    tickerCodes: [tickerCodeSlug],
    sectors: portfolioStock.stock.sector ? [portfolioStock.stock.sector] : [],
    limit: 5,
    daysAgo: 7,
  });
  const newsContext =
    news.length > 0
      ? `\n【最新のニュース情報】\n${formatNewsForPrompt(news)}`
      : "";

  // 財務指標のフォーマット
  const stock = portfolioStock.stock;
  const financialMetrics = buildFinancialMetrics(stock, currentPrice);

  // 日経平均の市場文脈を取得
  let marketData = null;
  try {
    marketData = await getNikkei225Data();
  } catch (error) {
    console.error("市場データ取得失敗（フォールバック）:", error);
  }
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

  // 初回購入が7日以内 → 直近の購入判断をコンテキストに含める
  const firstBuyTransaction = portfolioStock.transactions.find(
    (tx) => tx.type === "buy",
  );
  const isRecentlyPurchased =
    firstBuyTransaction &&
    firstBuyTransaction.transactionDate >= getDaysAgoForDB(7);

  let purchaseRecContext = "";
  if (isRecentlyPurchased) {
    const recentPurchaseRec = await prisma.purchaseRecommendation.findFirst({
      where: { stockId },
      orderBy: { date: "desc" },
      select: {
        recommendation: true,
        reason: true,
        date: true,
      },
    });

    if (recentPurchaseRec) {
      const purchaseRecLabel: Record<string, string> = {
        buy: "買い推奨",
        stay: "様子見",
        avoid: "見送り推奨",
      };
      const daysSinceRec = recentPurchaseRec.date
        ? Math.floor(
            (Date.now() - new Date(recentPurchaseRec.date).getTime()) /
              (1000 * 60 * 60 * 24),
          )
        : null;
      const daysAgoText =
        daysSinceRec !== null ? `${daysSinceRec}日前` : "直近";
      purchaseRecContext = `\n【直近の購入判断との整合性 - 最重要】
- あなたの数日前の判定: ${purchaseRecLabel[recentPurchaseRec.recommendation] || recentPurchaseRec.recommendation}
- 判定日: ${daysAgoText}
- 当時の理由: ${recentPurchaseRec.reason}
- ※ この銘柄は購入から7日以内です。以下の誠実な対応を徹底してください:
  1. 判断の変更に対する責任: もし今回 "sell"（売却）と判断する場合、数日前の自らの「買い推奨」がなぜ誤りだったのか、あるいは何が決定的に変わったのかを reconciliationMessage に誠実に記載してください。
  2. 狼狽売りの防止: 単なる数%の価格変動や、想定内の調整を理由に "sell" に変えてはいけません。
  3. 重大な変化の明示: 決算ミス、不祥事、地合いの劇的な悪化など、前提が崩れた場合のみ isCriticalChange を true にした上で、勇気を持って売却を提案してください。
  4. 根拠の維持: 状況が変わっていないなら、含み損が出ていても「購入時のストーリーは崩れていない」ことを伝え、自信を持って "hold" を継続してください。
`;
    }
  }

  // ユーザー設定コンテキスト
  const styleMap: Record<string, string> = {
    CONSERVATIVE: "慎重派（守り） - 資産保護を最優先",
    BALANCED: "バランス型 - リスクとリワードのバランス",
    AGGRESSIVE: "積極派（攻め） - 利益の最大化を優先",
  };
  const userContext = userSettings
    ? `\n【ユーザーの投資設定】
- 投資スタイル: ${styleMap[userSettings.investmentStyle] || userSettings.investmentStyle}
`
    : "";

  // プロンプト構築
  const prompt = buildPortfolioAnalysisPrompt({
    stockName: stock.name,
    tickerCode: stock.tickerCode,
    sector: stock.sector || "不明",
    quantity,
    averagePrice,
    currentPrice,
    profit,
    profitPercent,
    userContext,
    purchaseRecContext,
    financialMetrics,
    weekChangeContext,
    patternContext,
    technicalContext,
    chartPatternContext,
    deviationRateContext,
    volumeAnalysisContext,
    relativeStrengthContext,
    newsContext,
    marketContext,
    sectorTrendContext,
    gapFillContext,
    supportResistanceContext,
    trendlineContext,
    takeProfitRate: portfolioStock.takeProfitRate != null
      ? Number(portfolioStock.takeProfitRate)
      : null,
    stopLossRate: portfolioStock.stopLossRate != null
      ? Number(portfolioStock.stopLossRate)
      : null,
    defaultTakeProfitRate: userSettings?.targetReturnRate,
    defaultStopLossRate: userSettings?.stopLossRate,
    atr14: stock.atr14 ? Number(stock.atr14) : null,
    isSimulation: false,
  });

  // OpenAI API呼び出し
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
    temperature: 0.3,
    max_tokens: 1600,
    response_format: {
      type: "json_schema",
      json_schema: {
        name: "portfolio_analysis",
        strict: true,
        schema: {
          type: "object",
          properties: {
            marketSignal: {
              type: "string",
              enum: ["bullish", "neutral", "bearish"],
            },
            shortTerm: { type: "string" },
            mediumTerm: { type: "string" },
            longTerm: { type: "string" },
            shortTermTrend: { type: "string", enum: ["up", "neutral", "down"] },
            shortTermPriceLow: { type: "number" },
            shortTermPriceHigh: { type: "number" },
            midTermTrend: { type: "string", enum: ["up", "neutral", "down"] },
            midTermPriceLow: { type: "number" },
            midTermPriceHigh: { type: "number" },
            longTermTrend: { type: "string", enum: ["up", "neutral", "down"] },
            longTermPriceLow: { type: "number" },
            longTermPriceHigh: { type: "number" },
            isCriticalChange: {
              type: "boolean",
              description:
                "購入直後の売却判定において、前提を覆すほどの重大な変化（決算ミス、不祥事、地合いの劇変等）があるか",
            },
            reconciliationMessage: {
              type: ["string", "null"],
              description:
                "前回（購入時）の判断と今回の判断が異なる場合の誠実な釈明や理由の説明",
            },
            styleAnalyses: {
              type: "object",
              properties: {
                CONSERVATIVE: {
                  type: "object",
                  properties: {
                    recommendation: { type: "string", enum: ["buy", "hold", "sell"] },
                    confidence: { type: "number" },
                    statusType: { type: "string" },
                    advice: { type: "string" },
                    shortTerm: { type: "string" },
                    sellReason: { type: ["string", "null"] },
                    sellCondition: { type: ["string", "null"] },
                    suggestedSellPercent: { type: ["integer", "null"], enum: [25, 50, 75, 100, null] },
                    suggestedExitRate: { type: ["number", "null"] },
                    suggestedSellTargetRate: { type: ["number", "null"] },
                  },
                  required: ["recommendation", "confidence", "statusType", "advice", "shortTerm", "sellReason", "sellCondition", "suggestedSellPercent", "suggestedExitRate", "suggestedSellTargetRate"],
                  additionalProperties: false,
                },
                BALANCED: {
                  type: "object",
                  properties: {
                    recommendation: { type: "string", enum: ["buy", "hold", "sell"] },
                    confidence: { type: "number" },
                    statusType: { type: "string" },
                    advice: { type: "string" },
                    shortTerm: { type: "string" },
                    sellReason: { type: ["string", "null"] },
                    sellCondition: { type: ["string", "null"] },
                    suggestedSellPercent: { type: ["integer", "null"], enum: [25, 50, 75, 100, null] },
                    suggestedExitRate: { type: ["number", "null"] },
                    suggestedSellTargetRate: { type: ["number", "null"] },
                  },
                  required: ["recommendation", "confidence", "statusType", "advice", "shortTerm", "sellReason", "sellCondition", "suggestedSellPercent", "suggestedExitRate", "suggestedSellTargetRate"],
                  additionalProperties: false,
                },
                AGGRESSIVE: {
                  type: "object",
                  properties: {
                    recommendation: { type: "string", enum: ["buy", "hold", "sell"] },
                    confidence: { type: "number" },
                    statusType: { type: "string" },
                    advice: { type: "string" },
                    shortTerm: { type: "string" },
                    sellReason: { type: ["string", "null"] },
                    sellCondition: { type: ["string", "null"] },
                    suggestedSellPercent: { type: ["integer", "null"], enum: [25, 50, 75, 100, null] },
                    suggestedExitRate: { type: ["number", "null"] },
                    suggestedSellTargetRate: { type: ["number", "null"] },
                  },
                  required: ["recommendation", "confidence", "statusType", "advice", "shortTerm", "sellReason", "sellCondition", "suggestedSellPercent", "suggestedExitRate", "suggestedSellTargetRate"],
                  additionalProperties: false,
                },
              },
              required: ["CONSERVATIVE", "BALANCED", "AGGRESSIVE"],
              additionalProperties: false,
            },
          },
          required: [
            "marketSignal",
            "shortTerm",
            "mediumTerm",
            "longTerm",
            "shortTermTrend",
            "shortTermPriceLow",
            "shortTermPriceHigh",
            "midTermTrend",
            "midTermPriceLow",
            "midTermPriceHigh",
            "longTermTrend",
            "longTermPriceLow",
            "longTermPriceHigh",
            "isCriticalChange",
            "reconciliationMessage",
            "styleAnalyses",
          ],
          additionalProperties: false,
        },
      },
    },
  });

  const content = response.choices[0].message.content?.trim() || "{}";
  const result = JSON.parse(content);

  // 共通ポストプロセス（安全補正・価格算出・売りタイミング判定・スタイルルール適用）
  const { styleAnalyses, userStyleResult, statusType, sellTiming, sellTargetPrice } =
    postProcessPortfolioAnalysis({
      result,
      prices,
      stock,
      weekChangeRate,
      marketData,
      profitPercent,
      currentPrice,
      averagePrice,
      userSettings,
    });

  // 保存
  const now = dayjs.utc().toDate();

  const [, createdAnalysis] = await prisma.$transaction([
    prisma.portfolioStock.update({
      where: { id: portfolioStock.id },
      data: {
        shortTerm: userStyleResult.shortTerm,
        mediumTerm: result.mediumTerm,
        longTerm: result.longTerm,
        statusType,
        marketSignal: result.marketSignal || null,
        suggestedSellPrice: userStyleResult.suggestedSellPrice || null,
        suggestedSellPercent: userStyleResult.suggestedSellPercent || null,
        sellReason: userStyleResult.sellReason || null,
        sellCondition: userStyleResult.sellCondition || null,
        sellTiming,
        sellTargetPrice,
        lastAnalysis: now,
        updatedAt: now,
      },
    }),
    prisma.stockAnalysis.create({
      data: {
        stockId,
        shortTermTrend: result.shortTermTrend || "neutral",
        shortTermPriceLow: result.shortTermPriceLow || currentPrice || 0,
        shortTermPriceHigh: result.shortTermPriceHigh || currentPrice || 0,
        shortTermText: userStyleResult.shortTerm || null,
        midTermTrend: result.midTermTrend || "neutral",
        midTermPriceLow: result.midTermPriceLow || currentPrice || 0,
        midTermPriceHigh: result.midTermPriceHigh || currentPrice || 0,
        midTermText: result.mediumTerm || null,
        longTermTrend: result.longTermTrend || "neutral",
        longTermPriceLow: result.longTermPriceLow || currentPrice || 0,
        longTermPriceHigh: result.longTermPriceHigh || currentPrice || 0,
        longTermText: result.longTerm || null,
        recommendation: userStyleResult.recommendation,
        advice: userStyleResult.advice || userStyleResult.shortTerm || "",
        confidence: userStyleResult.confidence || 0.7,
        limitPrice: userStyleResult.suggestedSellPrice || null,
        stopLossPrice: userStyleResult.suggestedStopLossPrice || null,
        statusType: statusType || null,
        sellCondition: userStyleResult.sellCondition || null,
        styleAnalyses: styleAnalyses ? JSON.parse(JSON.stringify(styleAnalyses)) : undefined,
        analyzedAt: now,
      },
    }),
  ]);

  // Outcome追跡
  const trendToPrediction: Record<string, Prediction> = {
    up: "up",
    down: "down",
    neutral: "neutral",
  };

  await insertRecommendationOutcome({
    type: "analysis",
    recommendationId: createdAnalysis.id,
    stockId,
    tickerCode: stock.tickerCode,
    sector: stock.sector,
    recommendedAt: now,
    priceAtRec: currentPrice || 0,
    prediction: trendToPrediction[result.shortTermTrend] || "neutral",
    confidence: userStyleResult.confidence || 0.7,
    volatility: stock.volatility ? Number(stock.volatility) : null,
    marketCap: stock.marketCap
      ? BigInt(Number(stock.marketCap) * 100_000_000)
      : null,
  });

  return {
    shortTerm: userStyleResult.shortTerm,
    shortTermText: userStyleResult.shortTerm,
    mediumTerm: result.mediumTerm,
    midTermText: result.mediumTerm,
    longTerm: result.longTerm,
    longTermText: result.longTerm,
    statusType,
    marketSignal: result.marketSignal || null,
    suggestedSellPrice: userStyleResult.suggestedSellPrice || null,
    suggestedSellPercent: userStyleResult.suggestedSellPercent || null,
    sellReason: userStyleResult.sellReason || null,
    sellCondition: userStyleResult.sellCondition || null,
    sellTiming,
    sellTargetPrice,
    recommendation: userStyleResult.recommendation || null,
    lastAnalysis: now.toISOString(),
    isToday: true,
    styleAnalyses,
  };
}

/**
 * ポートフォリオ分析のシミュレーション（DB保存なし）
 */
export async function executeSimulatedPortfolioAnalysis(
  userId: string,
  stockId: string,
  simulatedQuantity: number,
  simulatedAveragePrice: number,
): Promise<PortfolioAnalysisResult & { [key: string]: any }> {
  const stock = await prisma.stock.findUnique({
    where: { id: stockId },
  });

  if (!stock) {
    throw new AnalysisError("銘柄が見つかりません", "NOT_FOUND");
  }

  const userSettings = await prisma.userSettings.findUnique({
    where: { userId },
    select: {
      investmentStyle: true,
      stopLossRate: true,
      targetReturnRate: true,
    },
  });

  const { prices: realtimePrices, staleTickers: staleCheck } =
    await fetchStockPrices([stock.tickerCode]);
  if (staleCheck.includes(stock.tickerCode)) {
    throw new AnalysisError(
      "最新の株価が取得できないため分析がおこなえません",
      "STALE_DATA",
    );
  }

  const currentPrice = realtimePrices[0]?.currentPrice ?? null;
  const averagePrice = simulatedAveragePrice || currentPrice || 0;
  const quantity = simulatedQuantity;

  let profit: number | null = null;
  let profitPercent: number | null = null;
  if (currentPrice && averagePrice > 0 && quantity > 0) {
    const totalCost = averagePrice * quantity;
    const currentValue = currentPrice * quantity;
    profit = currentValue - totalCost;
    profitPercent = (profit / totalCost) * 100;
  }

  const historicalPrices = await fetchHistoricalPrices(stock.tickerCode, "1m");
  const prices = historicalPrices.slice(-30);

  const patternContext = buildCandlestickContext(prices);
  const technicalContext = buildTechnicalContext(prices);
  const chartPatternContext = buildChartPatternContext(
    prices,
    userSettings?.investmentStyle,
  );
  const { text: weekChangeContext, rate: weekChangeRate } =
    buildWeekChangeContext(prices);
  const deviationRateContext = buildDeviationRateContext(prices);
  const volumeAnalysisContext = buildVolumeAnalysisContext(prices);

  const tickerCodeSlug = stock.tickerCode.replace(".T", "");
  const news = await getRelatedNews({
    tickerCodes: [tickerCodeSlug],
    sectors: stock.sector ? [stock.sector] : [],
    limit: 5,
    daysAgo: 7,
  });
  const newsContext =
    news.length > 0
      ? `\n【最新のニュース情報】\n${formatNewsForPrompt(news)}`
      : "";
  const financialMetrics = buildFinancialMetrics(stock, currentPrice);

  let marketData = null;
  try {
    marketData = await getNikkei225Data();
  } catch (e) {}
  const marketContext = buildMarketContext(marketData);

  let sectorTrendContext = "";
  let sectorAvgWeekChangeRate: number | null = null;
  if (stock.sector) {
    const sectorTrend = await getSectorTrend(stock.sector);
    if (sectorTrend) {
      sectorTrendContext = `\n【セクタートレンド】\n${formatSectorTrendForPrompt(sectorTrend)}\n`;
      sectorAvgWeekChangeRate = sectorTrend.avgWeekChangeRate ?? null;
    }
  }

  const relativeStrengthContext = buildRelativeStrengthContext(
    weekChangeRate,
    marketData?.weekChangeRate ?? null,
    sectorAvgWeekChangeRate,
  );

  const styleMap: Record<string, string> = {
    CONSERVATIVE: "慎重派（守り） - 資産保護を最優先",
    BALANCED: "バランス型 - リスクとリワードのバランス",
    AGGRESSIVE: "積極派（攻め） - 利益の最大化を優先",
  };
  const userContext = userSettings
    ? `\n【ユーザーの投資設定】
- 投資スタイル: ${styleMap[userSettings.investmentStyle] || userSettings.investmentStyle}
`
    : "";

  const gapFillContext = buildGapFillContext(prices);
  const supportResistanceContext = buildSupportResistanceContext(prices);
  const trendlineContext = buildTrendlineContext(prices);

  const prompt = buildPortfolioAnalysisPrompt({
    stockName: stock.name,
    tickerCode: stock.tickerCode,
    sector: stock.sector || "不明",
    quantity,
    averagePrice,
    currentPrice,
    profit,
    profitPercent,
    userContext,
    purchaseRecContext: "",
    financialMetrics,
    weekChangeContext,
    patternContext,
    technicalContext,
    chartPatternContext,
    deviationRateContext,
    volumeAnalysisContext,
    relativeStrengthContext,
    newsContext,
    marketContext,
    sectorTrendContext,
    gapFillContext,
    supportResistanceContext,
    trendlineContext,
    atr14: stock.atr14 ? Number(stock.atr14) : null,
    isSimulation: true,
  });

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
    temperature: 0.3,
    max_tokens: 1600,
    response_format: {
      type: "json_schema",
      json_schema: {
        name: "portfolio_analysis",
        strict: true,
        schema: {
          type: "object",
          properties: {
            marketSignal: {
              type: "string",
              enum: ["bullish", "neutral", "bearish"],
            },
            shortTerm: { type: "string" },
            mediumTerm: { type: "string" },
            longTerm: { type: "string" },
            shortTermTrend: { type: "string", enum: ["up", "neutral", "down"] },
            shortTermPriceLow: { type: "number" },
            shortTermPriceHigh: { type: "number" },
            midTermTrend: { type: "string", enum: ["up", "neutral", "down"] },
            midTermPriceLow: { type: "number" },
            midTermPriceHigh: { type: "number" },
            longTermTrend: { type: "string", enum: ["up", "neutral", "down"] },
            longTermPriceLow: { type: "number" },
            longTermPriceHigh: { type: "number" },
            isCriticalChange: { type: "boolean" },
            reconciliationMessage: { type: ["string", "null"] },
            styleAnalyses: {
              type: "object",
              properties: {
                CONSERVATIVE: {
                  type: "object",
                  properties: {
                    recommendation: { type: "string", enum: ["buy", "hold", "sell"] },
                    confidence: { type: "number" },
                    statusType: { type: "string" },
                    advice: { type: "string" },
                    shortTerm: { type: "string" },
                    sellReason: { type: ["string", "null"] },
                    sellCondition: { type: ["string", "null"] },
                    suggestedSellPercent: { type: ["integer", "null"], enum: [25, 50, 75, 100, null] },
                    suggestedExitRate: { type: ["number", "null"] },
                    suggestedSellTargetRate: { type: ["number", "null"] },
                  },
                  required: ["recommendation", "confidence", "statusType", "advice", "shortTerm", "sellReason", "sellCondition", "suggestedSellPercent", "suggestedExitRate", "suggestedSellTargetRate"],
                  additionalProperties: false,
                },
                BALANCED: {
                  type: "object",
                  properties: {
                    recommendation: { type: "string", enum: ["buy", "hold", "sell"] },
                    confidence: { type: "number" },
                    statusType: { type: "string" },
                    advice: { type: "string" },
                    shortTerm: { type: "string" },
                    sellReason: { type: ["string", "null"] },
                    sellCondition: { type: ["string", "null"] },
                    suggestedSellPercent: { type: ["integer", "null"], enum: [25, 50, 75, 100, null] },
                    suggestedExitRate: { type: ["number", "null"] },
                    suggestedSellTargetRate: { type: ["number", "null"] },
                  },
                  required: ["recommendation", "confidence", "statusType", "advice", "shortTerm", "sellReason", "sellCondition", "suggestedSellPercent", "suggestedExitRate", "suggestedSellTargetRate"],
                  additionalProperties: false,
                },
                AGGRESSIVE: {
                  type: "object",
                  properties: {
                    recommendation: { type: "string", enum: ["buy", "hold", "sell"] },
                    confidence: { type: "number" },
                    statusType: { type: "string" },
                    advice: { type: "string" },
                    shortTerm: { type: "string" },
                    sellReason: { type: ["string", "null"] },
                    sellCondition: { type: ["string", "null"] },
                    suggestedSellPercent: { type: ["integer", "null"], enum: [25, 50, 75, 100, null] },
                    suggestedExitRate: { type: ["number", "null"] },
                    suggestedSellTargetRate: { type: ["number", "null"] },
                  },
                  required: ["recommendation", "confidence", "statusType", "advice", "shortTerm", "sellReason", "sellCondition", "suggestedSellPercent", "suggestedExitRate", "suggestedSellTargetRate"],
                  additionalProperties: false,
                },
              },
              required: ["CONSERVATIVE", "BALANCED", "AGGRESSIVE"],
              additionalProperties: false,
            },
          },
          required: [
            "marketSignal",
            "shortTerm",
            "mediumTerm",
            "longTerm",
            "shortTermTrend",
            "shortTermPriceLow",
            "shortTermPriceHigh",
            "midTermTrend",
            "midTermPriceLow",
            "midTermPriceHigh",
            "longTermTrend",
            "longTermPriceLow",
            "longTermPriceHigh",
            "isCriticalChange",
            "reconciliationMessage",
            "styleAnalyses",
          ],
          additionalProperties: false,
        },
      },
    },
  });

  const content = response.choices[0].message.content?.trim() || "{}";
  const result = JSON.parse(content);

  // 共通ポストプロセス（安全補正・価格算出・売りタイミング判定・スタイルルール適用）
  const { styleAnalyses, userStyleResult, statusType, sellTiming, sellTargetPrice } =
    postProcessPortfolioAnalysis({
      result,
      prices,
      stock,
      weekChangeRate,
      marketData,
      profitPercent,
      currentPrice,
      averagePrice,
      userSettings,
    });

  const now = dayjs.utc().toDate();

  return {
    shortTerm: userStyleResult.shortTerm,
    shortTermText: userStyleResult.shortTerm,
    mediumTerm: result.mediumTerm,
    midTermText: result.mediumTerm,
    longTerm: result.longTerm,
    longTermText: result.longTerm,
    statusType,
    marketSignal: result.marketSignal || null,
    suggestedSellPrice: userStyleResult.suggestedSellPrice || null,
    suggestedSellPercent: userStyleResult.suggestedSellPercent || null,
    sellReason: userStyleResult.sellReason || null,
    sellCondition: userStyleResult.sellCondition || null,
    sellTiming,
    sellTargetPrice,
    recommendation: userStyleResult.recommendation || null,
    lastAnalysis: now.toISOString(),
    isToday: true,
    currentPrice,
    averagePurchasePrice: averagePrice,
    stopLossRate: userSettings?.stopLossRate ?? null,
    targetReturnRate: userSettings?.targetReturnRate ?? null,
    userTargetPrice:
      averagePrice && userSettings?.targetReturnRate
        ? Math.round(averagePrice * (1 + userSettings.targetReturnRate / 100))
        : null,
    userStopLossPrice:
      averagePrice && userSettings?.stopLossRate
        ? Math.round(averagePrice * (1 + userSettings.stopLossRate / 100))
        : null,
    shortTermTrend: result.shortTermTrend,
    shortTermPriceLow: result.shortTermPriceLow,
    shortTermPriceHigh: result.shortTermPriceHigh,
    midTermTrend: result.midTermTrend,
    midTermPriceLow: result.midTermPriceLow,
    midTermPriceHigh: result.midTermPriceHigh,
    longTermTrend: result.longTermTrend,
    longTermPriceLow: result.longTermPriceLow,
    longTermPriceHigh: result.longTermPriceHigh,
    advice: userStyleResult.advice,
    confidence: userStyleResult.confidence,
    limitPrice: userStyleResult.suggestedSellPrice,
    stopLossPrice: userStyleResult.suggestedStopLossPrice,
    analyzedAt: now.toISOString(),
    styleAnalyses,
  };
}
