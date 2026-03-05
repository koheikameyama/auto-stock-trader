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
  buildDefensiveModeContext,
  buildDeviationRateContext,
  buildDelistingContext,
  buildVolumeAnalysisContext,
  buildRelativeStrengthContext,
  buildGapFillContext,
  buildSupportResistanceContext,
  buildTrendlineContext,
  buildEarningsContext,
  buildExDividendContext,
  buildGeopoliticalRiskContext,
  buildSectorComparisonContext,
  buildBuySignalContext,
  type GeopoliticalRiskData,
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
  UNIT_SHARES,
  GEOPOLITICAL_RISK,
  GEOPOLITICAL_DEFENSIVE_MODE,
  MARKET_SHIELD,
  getSectorGroup,
} from "@/lib/constants";
import { getDaysAgoForDB, getTodayForDB } from "@/lib/date-utils";
import { isDangerousStock, isPostExDividend, assessGeopoliticalRisk, type GeopoliticalRiskLevel } from "@/lib/stock-safety-rules";
import { insertRecommendationOutcome, Prediction } from "@/lib/outcome-utils";
import { applyPortfolioStyleSafetyRules, type StyleAnalysesMap, type PortfolioStyleAnalysis } from "@/lib/style-analysis";
import { generateCorrectionExplanation, getStyleNameJa } from "@/lib/correction-explanation";
import { detectTrendDivergence, generateDivergenceExplanation } from "@/lib/trend-divergence";
import { findSupportResistance } from "@/lib/technical-indicators";
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
 * 1. 安全補正ループ（パニック売り防止、データ取得不可、危険銘柄、トレンド保護、相対強度保護）
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
    exDividendDate?: Date | null;
    dividendYield?: unknown;
  };
  weekChangeRate: number | null;
  marketData: MarketIndexData | null;
  geopoliticalRiskData: GeopoliticalRiskData | null;
  profitPercent: number | null;
  currentPrice: number;
  averagePrice: number;
  quantity: number;
  userSettings: { investmentStyle: string | null } | null;
  isShieldActive?: boolean;
}): {
  styleAnalyses: StyleAnalysesMap<PortfolioStyleAnalysis>;
  userStyleResult: PortfolioStyleAnalysis;
  sellTiming: string | null;
  sellTargetPrice: number | null;
  deviationRate: number | null;
} {
  const { result, prices, stock, weekChangeRate, marketData, geopoliticalRiskData, profitPercent, currentPrice, averagePrice, quantity, userSettings, isShieldActive } = params;

  // 地政学リスクレベルの算出（既存データから計算、DB不要）
  const geoRiskAssessment = assessGeopoliticalRisk({
    vixClose: geopoliticalRiskData?.vixClose ?? null,
    vixChangeRate: geopoliticalRiskData?.vixChangeRate ?? null,
    wtiChangeRate: geopoliticalRiskData?.wtiChangeRate ?? null,
    negativeGeoNewsCount: 0, // ポートフォリオ分析時点ではニュース数は別途取得不要（VIX/WTIで十分）
  });
  const geoRiskLevel = geoRiskAssessment.level;

  // テクニカル指標の計算
  const pricesNewestFirst = [...prices].reverse().map((p) => ({ close: p.close }));
  const deviationRate = calculateDeviationRate(pricesNewestFirst, MA_DEVIATION.PERIOD);
  const rsiValue = calculateRSI(pricesNewestFirst);
  const sma25 = calculateSMA(pricesNewestFirst, MA_DEVIATION.PERIOD);
  const sma75 = calculateSMA(pricesNewestFirst, MA_DEVIATION.LONG_PERIOD);
  const volatility = stock.volatility ? Number(stock.volatility) : null;

  // --- 安全補正を全3スタイルにループ適用 ---
  for (const styleKey of ALL_STYLE_KEYS_SHARED) {
    const sa = result.styleAnalyses[styleKey];
    const styleName = getStyleNameJa(styleKey);
    // correctionExplanation を初期化（AI結果にはこのフィールドがないため）
    sa.correctionExplanation = null;
    // holdCondition: AI結果にすでに含まれているが、buy/sellの場合はnullにリセット
    if (sa.recommendation !== "hold") {
      sa.holdCondition = null;
    }

    // パニック売り防止（スタイル別閾値 + 市場状況で解除 + 損切りライン優先）
    const panicThreshold = SELL_TIMING.PANIC_SELL_THRESHOLD[styleKey];
    const isMarketBearish = marketData?.isMarketPanic === true ||
      (geopoliticalRiskData?.vixClose !== null && geopoliticalRiskData?.vixClose !== undefined && geopoliticalRiskData.vixClose >= GEOPOLITICAL_RISK.VIX_HIGH);
    const isAtStopLoss = profitPercent !== null && profitPercent <= SELL_TIMING.STOP_LOSS_THRESHOLD;
    if (
      !isMarketBearish &&
      !isAtStopLoss &&
      panicThreshold !== null &&
      deviationRate !== null &&
      deviationRate <= panicThreshold &&
      sa.recommendation === "sell"
    ) {
      sa.recommendation = "hold";
      sa.sellReason = null;
      sa.suggestedSellPercent = null;
      sa.holdCondition = `25日移動平均線から${deviationRate.toFixed(1)}%の下方乖離で「売られすぎ」の状態です。自律反発を待つ様子見（リバウンド待ち）を推奨します。`;
      sa.sellCondition = null;
      sa.shortTerm = `【一旦様子見を推奨】移動平均線から${Math.abs(deviationRate).toFixed(1)}%の異常な売られすぎ水準のため、今すぐの売却は避け、数日中の反発を待つことを推奨します。AIの当初分析: ${sa.shortTerm}`;
      sa.advice = `異常な「売られすぎ」によるパニック状態です。大底での売却を避けるため、自律反発を待つ様子見を優先しましょう。`;
      sa.correctionExplanation = generateCorrectionExplanation({
        ruleId: "panic_sell_prevention",
        styleName,
        originalRecommendation: "sell",
        correctedRecommendation: "hold",
        actualValue: `${deviationRate.toFixed(1)}%`,
      });
    }

    // データ取得不可銘柄の強制補正
    if (stock.isDelisted) {
      sa.recommendation = "sell";
      sa.shortTerm = `この銘柄はデータを正常に取得できません。保有している場合は証券会社に確認してください。${sa.shortTerm}`;
      sa.correctionExplanation = generateCorrectionExplanation({
        ruleId: "delisted_stock",
        styleName,
        originalRecommendation: sa.recommendation,
        correctedRecommendation: "sell",
      });
    }

    // 危険銘柄の買い増し抑制
    if (
      isDangerousStock(stock.isProfitable, volatility) &&
      sa.recommendation === "buy"
    ) {
      sa.recommendation = "hold";
      sa.holdCondition = `業績が赤字かつボラティリティが${volatility?.toFixed(0)}%と高いため、業績改善の兆候を確認してから買い増しを検討してください。`;
      sa.shortTerm = `業績が赤字かつボラティリティが${volatility?.toFixed(0)}%と高いため、買い増しは慎重に検討してください。${sa.shortTerm}`;
      sa.correctionExplanation = generateCorrectionExplanation({
        ruleId: "dangerous_stock_buy_suppression",
        styleName,
        originalRecommendation: "buy",
        correctedRecommendation: "hold",
        actualValue: `${volatility?.toFixed(0)}%`,
      });
    }

    // 短期下降トレンドの買い増し抑制
    if (result.shortTermTrend === "down" && sa.recommendation === "buy") {
      sa.recommendation = "hold";
      sa.holdCondition = `短期的に下落トレンドが予測されているため、下げ止まりを確認してから買い増しを検討してください。`;
      sa.shortTerm = `短期的に下落が予測されているため、買い増しは下げ止まりを確認してからを推奨します。${sa.shortTerm}`;
      sa.correctionExplanation = generateCorrectionExplanation({
        ruleId: "short_term_downtrend",
        styleName,
        originalRecommendation: "buy",
        correctedRecommendation: "hold",
      });
    }

    // 中長期トレンドによる売り保護（投資スタイル別、重大な変化がない場合のみ）
    // CONSERVATIVE: 長期upの場合のみ保護（中期upだけでは保護しない）
    //   ※ 含み益あり + 短期下落予兆の場合は保護を無効化（利確を優先）
    // BALANCED: 中期 or 長期がupなら保護
    // AGGRESSIVE: 長期upの場合のみ保護（短期モメンタム重視だが、長期上昇中の狼狽売りは防ぐ）
    const shouldProtectFromSell = (() => {
      if (result.isCriticalChange) return false;
      if (profitPercent !== null && profitPercent <= SELL_TIMING.TREND_OVERRIDE_LOSS_THRESHOLD) return false;
      if (styleKey === "AGGRESSIVE") return result.longTermTrend === "up";
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
      sa.sellReason = null;
      sa.suggestedSellPercent = null;
      sa.holdCondition = `${trendInfo}の見通しが上昇のため、短期的な売りシグナルでの即売却は見送りを推奨します。${result.reconciliationMessage ? `（補足: ${result.reconciliationMessage}）` : ""}`;
      sa.sellCondition = null;
      sa.shortTerm = `【一旦様子見を推奨】${trendInfo}のトレンドは引き続き上昇見通しです。短期の売りシグナルが出ていますが、中長期の回復を優先して一旦ホールドを推奨します。${result.reconciliationMessage ? `分析の変化: ${result.reconciliationMessage}` : ""}`;
      sa.advice = `${trendInfo}のトレンドは依然として良好です。短期的な変動に惑わされず、中長期での回復を待つ方針を優先しましょう。`;
      sa.correctionExplanation = generateCorrectionExplanation({
        ruleId: "trend_protection",
        styleName,
        originalRecommendation: "sell",
        correctedRecommendation: "hold",
        additionalInfo: trendInfo,
      });
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
          sa.sellReason = null;
        sa.suggestedSellPercent = null;
        sa.holdCondition = `市場（日経平均${marketData.weekChangeRate >= 0 ? "+" : ""}${marketData.weekChangeRate.toFixed(1)}%）に対して+${relVsMarket.toFixed(1)}%のアウトパフォームで、下落は地合い要因とみられます。市場全体の回復を待ちましょう。`;
        sa.sellCondition = null;
        sa.shortTerm = `【様子見を推奨】市場全体が${marketData.weekChangeRate.toFixed(1)}%下落する中、この銘柄は相対的に+${relVsMarket.toFixed(1)}%強く、地合い要因による下落と判断しました。AIの短期分析: ${sa.shortTerm}`;
        sa.advice = `市場全体の下落（日経平均${marketData.weekChangeRate.toFixed(1)}%）に対してアウトパフォームしており、地合い要因の下落とみられます。様子見を推奨します。`;
        sa.correctionExplanation = generateCorrectionExplanation({
          ruleId: "relative_strength_protection",
          styleName,
          originalRecommendation: "sell",
          correctedRecommendation: "hold",
          actualValue: `+${relVsMarket.toFixed(1)}%`,
        });
      }
    }

    // 配当権利落ち後の売り保護
    // 権利落ち後3日以内の下落は配当落ち分を含む可能性があるため、sell→holdに補正
    if (
      sa.recommendation === "sell" &&
      isPostExDividend(stock.exDividendDate ?? null) &&
      profitPercent !== null &&
      profitPercent > -5 // 含み損が軽微な場合のみ保護（大きな含み損は保護しない）
    ) {
      const dividendYieldNum = stock.dividendYield ? Number(stock.dividendYield) : null;
      const yieldInfo = dividendYieldNum
        ? `配当利回り${dividendYieldNum.toFixed(2)}%分の下落は配当落ちによるものです。`
        : "直近の株価下落は配当落ちを含む可能性があります。";
      sa.recommendation = "hold";
      sa.sellReason = null;
      sa.suggestedSellPercent = null;
      sa.holdCondition = `${yieldInfo}配当落ち分だけを理由に売却するのは不利なため、数日間の値動きを確認してから判断しましょう。`;
      sa.sellCondition = null;
      sa.shortTerm = `【配当落ち保護】直近の株価下落は配当権利落ちによる自然な調整を含む可能性があります。トレンド転換かどうかは数日間の値動きで確認してください。AIの当初分析: ${sa.shortTerm}`;
      sa.advice = `配当権利落ち直後の下落です。${yieldInfo}数日間の値動きを確認してから判断しましょう。`;
      sa.correctionExplanation = generateCorrectionExplanation({
        ruleId: "post_ex_dividend",
        styleName,
        originalRecommendation: "sell",
        correctedRecommendation: "hold",
      });
    }

    // 利益確定促進ルール（全スタイル対象、閾値はスタイル別）
    // 含み益あり + 短期下落予兆 → hold を sell（戻り売り）に変更して利確を促す
    // 売却数量は100株（単元株）単位で算出
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
      const idealPercent =
        styleKey === "CONSERVATIVE"
          ? PROFIT_TAKING_PROMOTION.CONSERVATIVE_SELL_PERCENT
          : styleKey === "BALANCED"
            ? PROFIT_TAKING_PROMOTION.BALANCED_SELL_PERCENT
            : PROFIT_TAKING_PROMOTION.AGGRESSIVE_SELL_PERCENT;

      if (profitPercent >= minProfit && quantity >= UNIT_SHARES) {
        // 単元株単位で売却可能な最低限の割合を算出
        const idealShares = Math.floor((quantity * idealPercent) / 100 / UNIT_SHARES) * UNIT_SHARES;
        const validPercents = [25, 50, 75, 100] as const;
        let sellPercent: 25 | 50 | 75 | 100;
        if (idealShares >= UNIT_SHARES) {
          // 理想の割合で1単元以上売れる → そのまま使用
          sellPercent = idealPercent;
        } else {
          // 1単元未満 → 1単元（100株）以上売れる最小の割合に引き上げ
          sellPercent = validPercents.find((pct) => {
            const shares = Math.floor((quantity * pct) / 100 / UNIT_SHARES) * UNIT_SHARES;
            return shares >= UNIT_SHARES;
          }) ?? 100;
        }

        const sellShares = Math.floor((quantity * sellPercent) / 100 / UNIT_SHARES) * UNIT_SHARES;

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
        sa.suggestedSellPercent = sellPercent;
        sa.sellReason = `含み益+${profitPercent.toFixed(1)}%の状態で短期テクニカル指標に下落予兆が出ているため、${sellShares}株（${sellPercent}%）の利益確定を推奨します。`;
        sa.sellCondition = `短期下落トレンド中のため、${sellShares}株の利益確定を検討してください。押し目（一時的な下落）での再エントリーも有効です。`;
        sa.shortTerm = `【利確検討】含み益+${profitPercent.toFixed(1)}%で短期的に下落の予兆があります。${styleAdvice}AIの当初分析: ${sa.shortTerm}`;
        sa.advice = `含み益+${profitPercent.toFixed(1)}%を確保中ですが短期下落の予兆があります。${styleAction}`;
        sa.correctionExplanation = generateCorrectionExplanation({
          ruleId: "profit_taking_promotion",
          styleName,
          originalRecommendation: "hold",
          correctedRecommendation: "sell",
          actualValue: `+${profitPercent.toFixed(1)}%`,
          additionalInfo: `${styleName}の基準（含み益+${minProfit}%以上）を満たしており、${sellShares}株（${sellPercent}%）の利益確定を推奨します。`,
        });
      }
    }

    // 全面下降トレンド + 含み損 → hold を sell（損切り促進）に変更
    if (
      sa.recommendation === "hold" &&
      profitPercent !== null &&
      profitPercent < 0 &&
      result.shortTermTrend === "down" &&
      result.midTermTrend === "down" &&
      result.longTermTrend === "down"
    ) {
      sa.recommendation = "sell";
      sa.suggestedSellPercent = 100;
      sa.sellReason = `短期・中期・長期すべてのトレンドが下降で含み損${profitPercent.toFixed(1)}%のため、損切りを推奨します。`;
      sa.sellCondition = `すべてのトレンドが下降しており回復の見通しが立たないため、損切りを検討してください。`;
      sa.shortTerm = `【損切り検討】全トレンドが下降中で含み損${profitPercent.toFixed(1)}%です。回復の兆候が見られないため、損切りを検討してください。${sa.shortTerm}`;
      sa.advice = `短期・中期・長期すべてで下落が続いており、含み損${profitPercent.toFixed(1)}%の状態です。損失拡大を防ぐため、損切りを検討しましょう。`;
      sa.correctionExplanation = generateCorrectionExplanation({
        ruleId: "all_trends_down_loss",
        styleName,
        originalRecommendation: "hold",
        correctedRecommendation: "sell",
        actualValue: `${profitPercent.toFixed(1)}%`,
      });
    }
  }

  // --- 期間分析ベースの率を優先し、絶対価格を決定論的に算出 ---
  if (currentPrice && averagePrice > 0) {
    // 期間分析の予測価格から率を逆算（全スタイル共通: 短期ベース）
    const predictionSellTargetRate = deriveSellTargetRateFromPrediction(
      result.shortTermPriceHigh, currentPrice,
    );
    const predictionExitRate = deriveExitRateFromPrediction(
      result.shortTermPriceLow, currentPrice,
    );

    for (const styleKey of ALL_STYLE_KEYS_SHARED) {
      const sa = result.styleAnalyses[styleKey];
      // 期間分析ベースの率を優先、フォールバックはAIの率
      // スタイル差はATR補正で自動的に出る（安定配当型: 2.0x, 成長投資型: 2.5x, アクティブ型: 3.0x）
      const { suggestedSellPrice, suggestedStopLossPrice, effectiveExitRate } =
        calculatePricesFromRates({
          currentPrice,
          averagePrice,
          sellTargetRate: predictionSellTargetRate ?? sa.suggestedSellTargetRate,
          exitRate: predictionExitRate ?? sa.suggestedExitRate,
          atr14: stock.atr14 ? Number(stock.atr14) : null,
          investmentStyle: styleKey,
          geopoliticalRiskLevel: geoRiskLevel,
        });
      sa.suggestedSellPrice = suggestedSellPrice;
      sa.suggestedStopLossPrice = suggestedStopLossPrice;

      // 撤退ライン率がスタイル別上限を超えたらbuy→holdに降格
      if (effectiveExitRate != null && sa.recommendation === "buy") {
        const style = styleKey as keyof typeof ATR_EXIT_STRATEGY.MAX_EXIT_RATE_FOR_BUY;
        const maxExitRate = ATR_EXIT_STRATEGY.MAX_EXIT_RATE_FOR_BUY[style];
        if (maxExitRate != null && effectiveExitRate > maxExitRate) {
          sa.recommendation = "hold";
          sa.advice = `撤退ラインが${Math.round(effectiveExitRate * 100)}%と深く、リスクが高いため買い増し推奨を見送ります。${sa.advice || ""}`;
        }
      }
    }
  }

  // --- トレンド乖離（ねじれ）検出 ---
  const pricesNewestFirstFull = [...prices].reverse().map((p) => ({
    close: p.close,
    high: p.high,
    low: p.low,
  }));
  const { resistances } = findSupportResistance(pricesNewestFirstFull);
  const resistancePrice = resistances.length > 0 ? resistances[0] : null;

  for (const styleKey of ALL_STYLE_KEYS_SHARED) {
    const sa = result.styleAnalyses[styleKey];
    const divergence = detectTrendDivergence({
      shortTermTrend: result.shortTermTrend,
      longTermTrend: result.longTermTrend,
      weekChangeRate,
      rsiValue,
      deviationRate,
    });
    if (divergence.type) {
      sa.divergenceType = divergence.type;
      sa.divergenceLabel = divergence.label;
      sa.divergenceExplanation = generateDivergenceExplanation({
        type: divergence.type,
        weekChangeRate,
        rsiValue,
        deviationRate,
        resistancePrice,
        shortTermTrend: result.shortTermTrend,
        longTermTrend: result.longTermTrend,
        investmentStyle: styleKey,
        currentPrice,
        shortTermPriceLow: result.shortTermPriceLow,
        shortTermPriceHigh: result.shortTermPriceHigh,
        longTermPriceLow: result.longTermPriceLow,
        longTermPriceHigh: result.longTermPriceHigh,
      });
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

  // 戻り売り目安のフォールバックチェーン: SMA25 → SMA75 → ATR14 → market
  // 基準は現在価格（目安が現在価格以下だと「反発を待つ」意味がないため）
  if (sellTiming === "rebound" && currentPrice && (!sellTargetPrice || sellTargetPrice <= currentPrice)) {
    const atr14 = stock.atr14 ? Number(stock.atr14) : null;
    // SMA25は既に初回設定で試行済み（currentPrice以下のためここに到達）
    if (sma75 !== null && sma75 > currentPrice) {
      sellTargetPrice = sma75;
    } else if (atr14 && atr14 > 0) {
      sellTargetPrice = Math.round(currentPrice + atr14 * SELL_TIMING.REBOUND_ATR_MULTIPLIER);
    } else {
      sellTiming = "market";
      sellTargetPrice = null;
    }
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
    isMarketPanic: marketData?.isMarketPanic === true,
    geopoliticalRiskLevel: geoRiskLevel,
  });

  // --- マーケットシールド: 撤退ラインの引き上げ ---
  if (isShieldActive && currentPrice > 0) {
    const atr14 = stock.atr14 ? Number(stock.atr14) : null;
    if (atr14 && atr14 > 0) {
      for (const styleKey of ALL_STYLE_KEYS_SHARED) {
        const sa = styleAnalyses[styleKey];
        // Shield中はATR乗数を1.0に引き締め（通常: 2.0〜3.0）
        const shieldStopLoss = Math.round(currentPrice - atr14 * MARKET_SHIELD.SHIELD_ATR_MULTIPLIER);
        if (sa.suggestedStopLossPrice == null || shieldStopLoss > sa.suggestedStopLossPrice) {
          sa.suggestedStopLossPrice = shieldStopLoss;
        }
      }
    }
  }

  return {
    styleAnalyses,
    userStyleResult,
    sellTiming,
    sellTargetPrice,
    deviationRate,
  };
}

/**
 * 期間分析の予測価格から売却目標率を逆算する（全スタイル共通: 短期ベース）
 * shortTermPriceHigh が現在価格以下の場合はnullを返し、AIの率にフォールバック
 */
function deriveSellTargetRateFromPrediction(
  shortTermPriceHigh: number,
  currentPrice: number,
): number | null {
  if (!shortTermPriceHigh || !currentPrice || shortTermPriceHigh <= currentPrice) return null;
  return (shortTermPriceHigh - currentPrice) / currentPrice;
}

/**
 * 期間分析の予測価格から撤退ライン率を逆算する（全スタイル共通: 短期ベース）
 * shortTermPriceLow が現在価格以上の場合はnullを返し、AIの率にフォールバック
 */
function deriveExitRateFromPrediction(
  shortTermPriceLow: number,
  currentPrice: number,
): number | null {
  if (!shortTermPriceLow || !currentPrice || shortTermPriceLow >= currentPrice) return null;
  return (currentPrice - shortTermPriceLow) / currentPrice;
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
  geopoliticalRiskLevel?: GeopoliticalRiskLevel;
}): {
  suggestedSellPrice: number | null;
  suggestedStopLossPrice: number | null;
  effectiveExitRate: number | null;
} {
  const { currentPrice, averagePrice, sellTargetRate, exitRate, atr14, investmentStyle, geopoliticalRiskLevel } = params;

  const suggestedSellPrice =
    sellTargetRate != null
      ? Math.round(currentPrice * (1 + sellTargetRate))
      : null;

  let suggestedStopLossPrice: number | null = null;
  if (exitRate != null) {
    let effectiveExitRate = exitRate;

    // ATRベース損切りフロア: ボラティリティに応じた最低限の損切り幅を保証
    const style = (investmentStyle || "BALANCED") as keyof typeof INVESTMENT_STYLE_COEFFICIENTS.STOP_LOSS;
    let multiplier = INVESTMENT_STYLE_COEFFICIENTS.STOP_LOSS[style] ?? 2.5;

    // 地政学リスクモード: ATR乗数を引き締め（損切りラインを現在価格に近づける）
    if (geopoliticalRiskLevel === "alert") {
      multiplier *= GEOPOLITICAL_DEFENSIVE_MODE.ALERT.STOP_LOSS_TIGHTENING;
    } else if (geopoliticalRiskLevel === "caution") {
      multiplier *= GEOPOLITICAL_DEFENSIVE_MODE.CAUTION.STOP_LOSS_TIGHTENING;
    }

    if (atr14 != null && atr14 > 0 && currentPrice > 0) {
      const atrBasedRate = (atr14 * multiplier) / currentPrice;
      effectiveExitRate = Math.max(exitRate, atrBasedRate);
    } else {
      // ATRが利用できない場合のフォールバック
      const fallback = ATR_EXIT_STRATEGY.FALLBACK_STOP_LOSS[style] ?? 8;
      const fallbackRate = fallback / 100;
      effectiveExitRate = Math.max(exitRate, fallbackRate);
    }

    // リスクリワード比1:3の最低保証
    const minSellTargetRate = effectiveExitRate * ATR_EXIT_STRATEGY.MIN_RISK_REWARD_RATIO;
    const effectiveSellTargetRate = sellTargetRate != null
      ? Math.max(sellTargetRate, minSellTargetRate)
      : minSellTargetRate;
    const adjustedSellPrice = Math.round(currentPrice * (1 + effectiveSellTargetRate));

    const rawStopLoss = Math.round(currentPrice * (1 - effectiveExitRate));
    const hasUnrealizedGain = currentPrice > averagePrice;
    suggestedStopLossPrice = hasUnrealizedGain
      ? Math.max(rawStopLoss, Math.round(averagePrice))
      : rawStopLoss;

    return { suggestedSellPrice: adjustedSellPrice, suggestedStopLossPrice, effectiveExitRate };
  }

  return { suggestedSellPrice, suggestedStopLossPrice, effectiveExitRate: null };
}

export interface PortfolioAnalysisResult {
  shortTerm: string;
  shortTermText: string;
  mediumTerm: string;
  midTermText: string;
  longTerm: string;
  longTermText: string;
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

  // SMA25計算に25営業日以上が必要なため3ヶ月分取得
  const historicalPrices = await fetchHistoricalPrices(
    portfolioStock.stock.tickerCode,
    MA_DEVIATION.FETCH_PERIOD,
  );
  const prices = historicalPrices.slice(-MA_DEVIATION.FETCH_SLICE); // oldest-first

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
    sectors: getSectorGroup(portfolioStock.stock.sector) ? [getSectorGroup(portfolioStock.stock.sector)!] : [],
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
  const earningsContext = buildEarningsContext(stock.nextEarningsDate, {
    isProfitable: stock.isProfitable,
    profitTrend: stock.profitTrend,
    revenueGrowth: stock.revenueGrowth ? Number(stock.revenueGrowth) : null,
    netIncomeGrowth: stock.netIncomeGrowth ? Number(stock.netIncomeGrowth) : null,
    eps: stock.eps ? Number(stock.eps) : null,
    per: stock.per ? Number(stock.per) : null,
  });
  const exDividendContext = buildExDividendContext(
    stock.exDividendDate,
    stock.dividendYield ? Number(stock.dividendYield) : null,
  );

  // 地政学リスク指標（VIX・WTI）を取得
  const todayForDB = getTodayForDB();
  const preMarketData = await prisma.preMarketData.findFirst({
    where: { date: todayForDB },
    select: {
      vixClose: true, vixChangeRate: true,
      wtiClose: true, wtiChangeRate: true,
    },
  });
  const geopoliticalRiskData: GeopoliticalRiskData = {
    vixClose: preMarketData?.vixClose ? Number(preMarketData.vixClose) : null,
    vixChangeRate: preMarketData?.vixChangeRate ? Number(preMarketData.vixChangeRate) : null,
    wtiClose: preMarketData?.wtiClose ? Number(preMarketData.wtiClose) : null,
    wtiChangeRate: preMarketData?.wtiChangeRate ? Number(preMarketData.wtiChangeRate) : null,
  };
  const execGeoRiskAssessment = assessGeopoliticalRisk({
    vixClose: geopoliticalRiskData.vixClose,
    vixChangeRate: geopoliticalRiskData.vixChangeRate,
    wtiChangeRate: geopoliticalRiskData.wtiChangeRate,
    negativeGeoNewsCount: 0,
  });

  const marketContext = buildMarketContext(marketData) + buildDefensiveModeContext(marketData) + buildGeopoliticalRiskContext(geopoliticalRiskData, execGeoRiskAssessment) + earningsContext + exDividendContext;

  // セクタートレンド
  let sectorTrendContext = "";
  let sectorAvgWeekChangeRate: number | null = null;
  let sectorAvg: { avgPER: number | null; avgPBR: number | null; avgROE: number | null } | null = null;
  const stockSectorGroup = getSectorGroup(stock.sector);
  if (stockSectorGroup) {
    const sectorTrend = await getSectorTrend(stockSectorGroup);
    if (sectorTrend) {
      sectorTrendContext = `\n【セクタートレンド】\n${formatSectorTrendForPrompt(sectorTrend)}\n`;
      sectorAvgWeekChangeRate = sectorTrend.avgWeekChangeRate ?? null;
      sectorAvg = {
        avgPER: sectorTrend.avgPER ?? null,
        avgPBR: sectorTrend.avgPBR ?? null,
        avgROE: sectorTrend.avgROE ?? null,
      };
    }
  }

  // セクター内相対評価
  const sectorComparisonContext = buildSectorComparisonContext(stock, sectorAvg, stock.sector);

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
    CONSERVATIVE: "安定配当型（守り） - 資産保護を最優先",
    BALANCED: "成長投資型 - リスクとリワードのバランス",
    AGGRESSIVE: "アクティブ型（攻め） - 利益の最大化を優先",
  };
  const userContext = userSettings
    ? `\n【ユーザーの投資設定】
- 投資スタイル: ${styleMap[userSettings.investmentStyle] || userSettings.investmentStyle}
`
    : "";

  // 買いシグナル判定コンテキスト
  const buySignalContext = buildBuySignalContext(
    {
      weekChangeRate,
      maDeviationRate: stock.maDeviationRate ? Number(stock.maDeviationRate) : null,
      volumeRatio: stock.volumeRatio ? Number(stock.volumeRatio) : null,
      isProfitable: stock.isProfitable,
      profitTrend: stock.profitTrend,
      revenueGrowth: stock.revenueGrowth ? Number(stock.revenueGrowth) : null,
      volatility: stock.volatility ? Number(stock.volatility) : null,
    },
    userSettings?.investmentStyle,
  );

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
    financialMetrics: financialMetrics + sectorComparisonContext,
    weekChangeContext,
    patternContext,
    technicalContext,
    chartPatternContext,
    deviationRateContext,
    volumeAnalysisContext,
    relativeStrengthContext,
    buySignalContext,
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
            trendConvergence: {
              type: "object",
              properties: {
                divergenceType: { type: "string", enum: ["short_down_long_up", "short_up_long_down", "aligned"] },
                estimatedConvergenceDays: { type: ["integer", "null"] },
                confidence: { type: "string", enum: ["high", "medium", "low"] },
                waitSuggestion: { type: "string" },
                keyLevelToWatch: { type: ["number", "null"] },
                triggerCondition: { type: "string" },
              },
              required: ["divergenceType", "estimatedConvergenceDays", "confidence", "waitSuggestion", "keyLevelToWatch", "triggerCondition"],
              additionalProperties: false,
            },
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
                    advice: { type: "string" },
                    shortTerm: { type: "string" },
                    holdCondition: { type: ["string", "null"] },
                    sellReason: { type: ["string", "null"] },
                    sellCondition: { type: ["string", "null"] },
                    suggestedSellPercent: { type: ["integer", "null"], enum: [25, 50, 75, 100, null] },
                    suggestedExitRate: { type: ["number", "null"] },
                    suggestedSellTargetRate: { type: ["number", "null"] },
                  },
                  required: ["recommendation", "confidence", "advice", "shortTerm", "holdCondition", "sellReason", "sellCondition", "suggestedSellPercent", "suggestedExitRate", "suggestedSellTargetRate"],
                  additionalProperties: false,
                },
                BALANCED: {
                  type: "object",
                  properties: {
                    recommendation: { type: "string", enum: ["buy", "hold", "sell"] },
                    confidence: { type: "number" },
                    advice: { type: "string" },
                    shortTerm: { type: "string" },
                    holdCondition: { type: ["string", "null"] },
                    sellReason: { type: ["string", "null"] },
                    sellCondition: { type: ["string", "null"] },
                    suggestedSellPercent: { type: ["integer", "null"], enum: [25, 50, 75, 100, null] },
                    suggestedExitRate: { type: ["number", "null"] },
                    suggestedSellTargetRate: { type: ["number", "null"] },
                  },
                  required: ["recommendation", "confidence", "advice", "shortTerm", "holdCondition", "sellReason", "sellCondition", "suggestedSellPercent", "suggestedExitRate", "suggestedSellTargetRate"],
                  additionalProperties: false,
                },
                AGGRESSIVE: {
                  type: "object",
                  properties: {
                    recommendation: { type: "string", enum: ["buy", "hold", "sell"] },
                    confidence: { type: "number" },
                    advice: { type: "string" },
                    shortTerm: { type: "string" },
                    holdCondition: { type: ["string", "null"] },
                    sellReason: { type: ["string", "null"] },
                    sellCondition: { type: ["string", "null"] },
                    suggestedSellPercent: { type: ["integer", "null"], enum: [25, 50, 75, 100, null] },
                    suggestedExitRate: { type: ["number", "null"] },
                    suggestedSellTargetRate: { type: ["number", "null"] },
                  },
                  required: ["recommendation", "confidence", "advice", "shortTerm", "holdCondition", "sellReason", "sellCondition", "suggestedSellPercent", "suggestedExitRate", "suggestedSellTargetRate"],
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
            "trendConvergence",
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

  // マーケットシールド状態を取得
  const { isMarketShieldActive } = await import("@/lib/market-shield");
  const shieldActive = await isMarketShieldActive();

  // 共通ポストプロセス（安全補正・価格算出・売りタイミング判定・スタイルルール適用）
  const { styleAnalyses, userStyleResult, sellTiming, sellTargetPrice } =
    postProcessPortfolioAnalysis({
      result,
      prices,
      stock,
      weekChangeRate,
      marketData,
      geopoliticalRiskData,
      profitPercent,
      currentPrice,
      averagePrice,
      quantity,
      userSettings,
      isShieldActive: shieldActive,
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
        marketSignal: result.marketSignal || null,
        suggestedSellPrice: userStyleResult.suggestedSellPrice || null,
        suggestedSellPercent: userStyleResult.suggestedSellPercent || null,
        sellReason: userStyleResult.sellReason || null,
        sellCondition: userStyleResult.sellCondition || null,
        sellTiming,
        sellTargetPrice,
        recommendation: userStyleResult.recommendation,
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
        trendConvergence: result.trendConvergence ?? undefined,
        recommendation: userStyleResult.recommendation,
        advice: userStyleResult.advice || userStyleResult.shortTerm || "",
        confidence: userStyleResult.confidence || 0.7,
        limitPrice: userStyleResult.suggestedSellPrice || null,
        stopLossPrice: userStyleResult.suggestedStopLossPrice || null,
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

  const historicalPrices = await fetchHistoricalPrices(stock.tickerCode, MA_DEVIATION.FETCH_PERIOD);
  const prices = historicalPrices.slice(-MA_DEVIATION.FETCH_SLICE);

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
    sectors: getSectorGroup(stock.sector) ? [getSectorGroup(stock.sector)!] : [],
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
  const simEarningsContext = buildEarningsContext(stock.nextEarningsDate, {
    isProfitable: stock.isProfitable,
    profitTrend: stock.profitTrend,
    revenueGrowth: stock.revenueGrowth ? Number(stock.revenueGrowth) : null,
    netIncomeGrowth: stock.netIncomeGrowth ? Number(stock.netIncomeGrowth) : null,
    eps: stock.eps ? Number(stock.eps) : null,
    per: stock.per ? Number(stock.per) : null,
  });
  const simExDividendContext = buildExDividendContext(
    stock.exDividendDate,
    stock.dividendYield ? Number(stock.dividendYield) : null,
  );

  // 地政学リスク指標（VIX・WTI）を取得
  const simTodayForDB = getTodayForDB();
  const simPreMarketData = await prisma.preMarketData.findFirst({
    where: { date: simTodayForDB },
    select: {
      vixClose: true, vixChangeRate: true,
      wtiClose: true, wtiChangeRate: true,
    },
  });
  const simGeopoliticalRiskData: GeopoliticalRiskData = {
    vixClose: simPreMarketData?.vixClose ? Number(simPreMarketData.vixClose) : null,
    vixChangeRate: simPreMarketData?.vixChangeRate ? Number(simPreMarketData.vixChangeRate) : null,
    wtiClose: simPreMarketData?.wtiClose ? Number(simPreMarketData.wtiClose) : null,
    wtiChangeRate: simPreMarketData?.wtiChangeRate ? Number(simPreMarketData.wtiChangeRate) : null,
  };

  const marketContext = buildMarketContext(marketData) + buildDefensiveModeContext(marketData) + buildGeopoliticalRiskContext(simGeopoliticalRiskData) + simEarningsContext + simExDividendContext;

  let sectorTrendContext = "";
  let sectorAvgWeekChangeRate: number | null = null;
  let simSectorAvg: { avgPER: number | null; avgPBR: number | null; avgROE: number | null } | null = null;
  const simStockSectorGroup = getSectorGroup(stock.sector);
  if (simStockSectorGroup) {
    const sectorTrend = await getSectorTrend(simStockSectorGroup);
    if (sectorTrend) {
      sectorTrendContext = `\n【セクタートレンド】\n${formatSectorTrendForPrompt(sectorTrend)}\n`;
      sectorAvgWeekChangeRate = sectorTrend.avgWeekChangeRate ?? null;
      simSectorAvg = {
        avgPER: sectorTrend.avgPER ?? null,
        avgPBR: sectorTrend.avgPBR ?? null,
        avgROE: sectorTrend.avgROE ?? null,
      };
    }
  }

  // セクター内相対評価
  const simSectorComparisonContext = buildSectorComparisonContext(stock, simSectorAvg, stock.sector);

  const relativeStrengthContext = buildRelativeStrengthContext(
    weekChangeRate,
    marketData?.weekChangeRate ?? null,
    sectorAvgWeekChangeRate,
  );

  const styleMap: Record<string, string> = {
    CONSERVATIVE: "安定配当型（守り） - 資産保護を最優先",
    BALANCED: "成長投資型 - リスクとリワードのバランス",
    AGGRESSIVE: "アクティブ型（攻め） - 利益の最大化を優先",
  };
  const userContext = userSettings
    ? `\n【ユーザーの投資設定】
- 投資スタイル: ${styleMap[userSettings.investmentStyle] || userSettings.investmentStyle}
`
    : "";

  const gapFillContext = buildGapFillContext(prices);
  const supportResistanceContext = buildSupportResistanceContext(prices);
  const trendlineContext = buildTrendlineContext(prices);

  // 買いシグナル判定コンテキスト
  const simBuySignalContext = buildBuySignalContext(
    {
      weekChangeRate,
      maDeviationRate: stock.maDeviationRate ? Number(stock.maDeviationRate) : null,
      volumeRatio: stock.volumeRatio ? Number(stock.volumeRatio) : null,
      isProfitable: stock.isProfitable,
      profitTrend: stock.profitTrend,
      revenueGrowth: stock.revenueGrowth ? Number(stock.revenueGrowth) : null,
      volatility: stock.volatility ? Number(stock.volatility) : null,
    },
    userSettings?.investmentStyle,
  );

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
    financialMetrics: financialMetrics + simSectorComparisonContext,
    weekChangeContext,
    patternContext,
    technicalContext,
    chartPatternContext,
    deviationRateContext,
    volumeAnalysisContext,
    relativeStrengthContext,
    buySignalContext: simBuySignalContext,
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
            trendConvergence: {
              type: "object",
              properties: {
                divergenceType: { type: "string", enum: ["short_down_long_up", "short_up_long_down", "aligned"] },
                estimatedConvergenceDays: { type: ["integer", "null"] },
                confidence: { type: "string", enum: ["high", "medium", "low"] },
                waitSuggestion: { type: "string" },
                keyLevelToWatch: { type: ["number", "null"] },
                triggerCondition: { type: "string" },
              },
              required: ["divergenceType", "estimatedConvergenceDays", "confidence", "waitSuggestion", "keyLevelToWatch", "triggerCondition"],
              additionalProperties: false,
            },
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
                    advice: { type: "string" },
                    shortTerm: { type: "string" },
                    holdCondition: { type: ["string", "null"] },
                    sellReason: { type: ["string", "null"] },
                    sellCondition: { type: ["string", "null"] },
                    suggestedSellPercent: { type: ["integer", "null"], enum: [25, 50, 75, 100, null] },
                    suggestedExitRate: { type: ["number", "null"] },
                    suggestedSellTargetRate: { type: ["number", "null"] },
                  },
                  required: ["recommendation", "confidence", "advice", "shortTerm", "holdCondition", "sellReason", "sellCondition", "suggestedSellPercent", "suggestedExitRate", "suggestedSellTargetRate"],
                  additionalProperties: false,
                },
                BALANCED: {
                  type: "object",
                  properties: {
                    recommendation: { type: "string", enum: ["buy", "hold", "sell"] },
                    confidence: { type: "number" },
                    advice: { type: "string" },
                    shortTerm: { type: "string" },
                    holdCondition: { type: ["string", "null"] },
                    sellReason: { type: ["string", "null"] },
                    sellCondition: { type: ["string", "null"] },
                    suggestedSellPercent: { type: ["integer", "null"], enum: [25, 50, 75, 100, null] },
                    suggestedExitRate: { type: ["number", "null"] },
                    suggestedSellTargetRate: { type: ["number", "null"] },
                  },
                  required: ["recommendation", "confidence", "advice", "shortTerm", "holdCondition", "sellReason", "sellCondition", "suggestedSellPercent", "suggestedExitRate", "suggestedSellTargetRate"],
                  additionalProperties: false,
                },
                AGGRESSIVE: {
                  type: "object",
                  properties: {
                    recommendation: { type: "string", enum: ["buy", "hold", "sell"] },
                    confidence: { type: "number" },
                    advice: { type: "string" },
                    shortTerm: { type: "string" },
                    holdCondition: { type: ["string", "null"] },
                    sellReason: { type: ["string", "null"] },
                    sellCondition: { type: ["string", "null"] },
                    suggestedSellPercent: { type: ["integer", "null"], enum: [25, 50, 75, 100, null] },
                    suggestedExitRate: { type: ["number", "null"] },
                    suggestedSellTargetRate: { type: ["number", "null"] },
                  },
                  required: ["recommendation", "confidence", "advice", "shortTerm", "holdCondition", "sellReason", "sellCondition", "suggestedSellPercent", "suggestedExitRate", "suggestedSellTargetRate"],
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
            "trendConvergence",
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

  // マーケットシールド状態を取得（シミュレーション分析でも共通）
  const { isMarketShieldActive: isShieldActiveSim } = await import("@/lib/market-shield");
  const shieldActiveSim = await isShieldActiveSim();

  // 共通ポストプロセス（安全補正・価格算出・売りタイミング判定・スタイルルール適用）
  const { styleAnalyses, userStyleResult, sellTiming, sellTargetPrice } =
    postProcessPortfolioAnalysis({
      result,
      prices,
      stock,
      weekChangeRate,
      marketData,
      geopoliticalRiskData: simGeopoliticalRiskData,
      profitPercent,
      currentPrice,
      averagePrice,
      quantity,
      userSettings,
      isShieldActive: shieldActiveSim,
    });

  const now = dayjs.utc().toDate();

  return {
    shortTerm: userStyleResult.shortTerm,
    shortTermText: userStyleResult.shortTerm,
    mediumTerm: result.mediumTerm,
    midTermText: result.mediumTerm,
    longTerm: result.longTerm,
    longTermText: result.longTerm,
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
