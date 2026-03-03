/**
 * 投資スタイル別分析の型定義とセーフティルール
 *
 * AIが3つの投資スタイル（安定配当型/成長投資型/アクティブ型）ごとに
 * 個別の分析結果を生成する前提で、セーフティルールとタイミング判定のみを適用する。
 */
import { INVESTMENT_STYLES, type InvestmentStyle } from "@/lib/constants";
import {
  isSurgeStock,
  isOverheated,
  isInDecline,
} from "@/lib/stock-safety-rules";
import { MA_DEVIATION, MOMENTUM, MARKET_DEFENSIVE_MODE } from "@/lib/constants";
import { generateCorrectionExplanation, getStyleNameJa } from "@/lib/correction-explanation";

/** 投資スタイル別の購入判断結果 */
export interface PurchaseStyleAnalysis {
  recommendation: string; // "buy" | "stay" | "avoid"
  confidence: number;
  marketSignal: string;
  advice: string;
  reason: string;
  caution: string;
  buyCondition: string | null;
  buyTiming: string | null;
  dipTargetPrice: number | null;
  sellTiming: string | null;
  sellTargetPrice: number | null;
  suggestedExitRate: number | null;
  suggestedSellTargetRate: number | null;
  /** セーフティルール補正時の解説テキスト */
  correctionExplanation: string | null;
  /** トレンド乖離（ねじれ）検出結果 */
  divergenceType?: string | null;
  divergenceLabel?: string | null;
  divergenceExplanation?: string | null;
}

/** 投資スタイル別のポートフォリオ分析結果 */
export interface PortfolioStyleAnalysis {
  recommendation: string; // "buy" | "hold" | "sell"
  confidence: number;
  marketSignal: string;
  advice: string;
  shortTerm: string;
  holdCondition: string | null;
  sellReason: string | null;
  sellCondition: string | null;
  suggestedSellPercent: number | null;
  sellTiming: string | null;
  sellTargetPrice: number | null;
  suggestedSellPrice: number | null;
  suggestedStopLossPrice: number | null;
  suggestedExitRate: number | null;
  suggestedSellTargetRate: number | null;
  /** セーフティルール補正時の解説テキスト */
  correctionExplanation: string | null;
  /** トレンド乖離（ねじれ）検出結果 */
  divergenceType?: string | null;
  divergenceLabel?: string | null;
  divergenceExplanation?: string | null;
}

/** 全3スタイルの分析結果マップ */
export type StyleAnalysesMap<T> = Record<InvestmentStyle, T>;

/**
 * AI推奨押し目価格のバリデーション
 * フォールバックチェーン: AI推奨 → SMA25 → SMA75 → ATR14 → volatility連動
 */
function validateDipPrice(
  aiPrice: number | null,
  currentPrice: number,
  sma25: number | null,
  sma75: number | null,
  volatility: number | null,
  atr14: number | null,
): number | null {
  if (aiPrice !== null && aiPrice > 0 && aiPrice < currentPrice) {
    const deviationFromCurrent = ((currentPrice - aiPrice) / currentPrice) * 100;
    // 現在価格から30%以上乖離していなければAI推奨価格を採用
    if (deviationFromCurrent <= 30) {
      return aiPrice;
    }
  }
  // フォールバック: SMA25 → SMA75 → ATR14 → volatility連動
  if (sma25 !== null && sma25 < currentPrice) {
    return sma25;
  }
  if (sma75 !== null && sma75 < currentPrice) {
    return sma75;
  }
  if (atr14 !== null && atr14 > 0) {
    return Math.round(currentPrice - atr14 * MA_DEVIATION.DIP_ATR_MULTIPLIER);
  }
  const dipRate = calcDipFallbackRate(volatility);
  return Math.round(currentPrice * (1 - dipRate));
}

/** volatilityからフォールバック下落率を算出（上下限クランプ付き） */
export function calcDipFallbackRate(volatility: number | null): number {
  if (volatility === null) {
    return MA_DEVIATION.DIP_PRICE_DEFAULT_RATE;
  }
  const raw = volatility * MA_DEVIATION.DIP_PRICE_VOLATILITY_FACTOR / 100;
  return Math.max(MA_DEVIATION.DIP_PRICE_MIN_RATE, Math.min(MA_DEVIATION.DIP_PRICE_MAX_RATE, raw));
}

const ALL_STYLES: InvestmentStyle[] = [
  INVESTMENT_STYLES.CONSERVATIVE,
  INVESTMENT_STYLES.BALANCED,
  INVESTMENT_STYLES.AGGRESSIVE,
];

/**
 * 購入判断のセーフティルールを適用
 * AI生成済みの3スタイル結果に対して、セーフティルールとタイミング判定のみを適用する
 */
export function applyPurchaseStyleSafetyRules(params: {
  styleAnalyses: StyleAnalysesMap<PurchaseStyleAnalysis>;
  weekChangeRate: number | null;
  deviationRate: number | null;
  buyTimingParams: {
    deviationRate: number | null;
    rsi: number | null;
    sma25: number | null;
    sma75: number | null;
    currentPrice: number;
    volatility: number | null;
    atr14: number | null;
  };
  sellTimingParams: {
    deviationRate: number | null;
    rsi: number | null;
    sma25: number | null;
  };
  technicalSignal?: { signal: string; strength: number };
  skipSafetyRules: boolean;
  isMarketPanic?: boolean;
}): StyleAnalysesMap<PurchaseStyleAnalysis> {
  const { styleAnalyses, weekChangeRate, deviationRate, buyTimingParams, sellTimingParams, technicalSignal, skipSafetyRules, isMarketPanic = false } = params;

  const result = {} as StyleAnalysesMap<PurchaseStyleAnalysis>;

  for (const style of ALL_STYLES) {
    // AI生成済みの結果をコピー（元のオブジェクトを変更しないため）
    const styleResult = { ...styleAnalyses[style], correctionExplanation: null as string | null };
    const styleName = getStyleNameJa(style);

    // 極端な急騰は skipSafetyRules でも強制ブロック（ハードリミット）
    if (
      weekChangeRate !== null &&
      weekChangeRate >= MOMENTUM.EXTREME_SURGE_THRESHOLD &&
      styleResult.recommendation === "buy"
    ) {
      styleResult.recommendation = "stay";
      styleResult.caution = `週間+${weekChangeRate.toFixed(0)}%の急騰は高値掴みリスクが極めて高いため、様子見を推奨します。${styleResult.caution}`;
      if (style === INVESTMENT_STYLES.CONSERVATIVE) {
        styleResult.advice = `週間+${weekChangeRate.toFixed(0)}%の急騰後です。高値掴みリスクが非常に高いため、大幅な調整を待ってから購入を検討しましょう。`;
      }
      styleResult.correctionExplanation = generateCorrectionExplanation({
        ruleId: "extreme_surge_block",
        styleName,
        originalRecommendation: "buy",
        correctedRecommendation: "stay",
        thresholdValue: `+${MOMENTUM.EXTREME_SURGE_THRESHOLD}%`,
        actualValue: `+${weekChangeRate.toFixed(0)}%`,
      });
    }

    // 極端な過熱は skipSafetyRules でも強制ブロック（ハードリミット）
    if (
      deviationRate !== null &&
      deviationRate >= MA_DEVIATION.EXTREME_UPPER_THRESHOLD &&
      styleResult.recommendation === "buy"
    ) {
      styleResult.recommendation = "stay";
      styleResult.caution = `25日移動平均線から+${deviationRate.toFixed(1)}%乖離しており極端な過熱圏のため、様子見を推奨します。${styleResult.caution}`;
      if (style === INVESTMENT_STYLES.CONSERVATIVE) {
        styleResult.advice = `移動平均線から+${deviationRate.toFixed(1)}%乖離しており極端な過熱圏です。大幅な調整を待ってから購入を検討しましょう。`;
      }
      styleResult.correctionExplanation = generateCorrectionExplanation({
        ruleId: "extreme_overheat_block",
        styleName,
        originalRecommendation: "buy",
        correctedRecommendation: "stay",
        thresholdValue: `+${MA_DEVIATION.EXTREME_UPPER_THRESHOLD}%`,
        actualValue: `+${deviationRate.toFixed(1)}%`,
      });
    }

    // セーフティルールを適用
    if (!skipSafetyRules) {
      // 下落トレンドの強制補正
      if (
        isInDecline(weekChangeRate, style) &&
        styleResult.recommendation === "buy"
      ) {
        const declineThreshold = style === "CONSERVATIVE" ? MOMENTUM.CONSERVATIVE_DECLINE_THRESHOLD
          : style === "AGGRESSIVE" ? MOMENTUM.AGGRESSIVE_DECLINE_THRESHOLD
          : MOMENTUM.BALANCED_DECLINE_THRESHOLD;
        styleResult.recommendation = "stay";
        styleResult.confidence = Math.max(
          0,
          styleResult.confidence + MOMENTUM.DECLINE_CONFIDENCE_PENALTY,
        );
        styleResult.caution = `週間${weekChangeRate!.toFixed(0)}%の下落トレンドのため、様子見を推奨します。${styleResult.caution}`;
        styleResult.buyCondition =
          styleResult.buyCondition || "下落トレンドが落ち着いてから検討してください";
        if (style === INVESTMENT_STYLES.CONSERVATIVE) {
            styleResult.advice = `週間${weekChangeRate!.toFixed(0)}%の下落トレンド中です。下げ止まりを確認してから購入を検討しましょう。`;
        }
        styleResult.correctionExplanation = generateCorrectionExplanation({
          ruleId: "decline_block",
          styleName,
          originalRecommendation: "buy",
          correctedRecommendation: "stay",
          thresholdValue: `${declineThreshold}%`,
          actualValue: `${weekChangeRate!.toFixed(0)}%`,
        });
      }

      // 急騰銘柄の強制補正
      if (
        isSurgeStock(weekChangeRate, style) &&
        styleResult.recommendation === "buy"
      ) {
        const surgeThreshold = style === "CONSERVATIVE" ? MOMENTUM.CONSERVATIVE_SURGE_THRESHOLD
          : style === "AGGRESSIVE" ? MOMENTUM.AGGRESSIVE_SURGE_THRESHOLD
          : MOMENTUM.BALANCED_SURGE_THRESHOLD;
        styleResult.recommendation = "stay";
        styleResult.caution = `週間+${weekChangeRate!.toFixed(0)}%の急騰銘柄のため、様子見を推奨します。${styleResult.caution}`;
        if (style === INVESTMENT_STYLES.CONSERVATIVE) {
            styleResult.advice = `週間+${weekChangeRate!.toFixed(0)}%の急騰後です。高値掴みを避けるため、調整を待ってから購入を検討しましょう。`;
        }
        styleResult.correctionExplanation = generateCorrectionExplanation({
          ruleId: "surge_block",
          styleName,
          originalRecommendation: "buy",
          correctedRecommendation: "stay",
          thresholdValue: `+${surgeThreshold}%`,
          actualValue: `+${weekChangeRate!.toFixed(0)}%`,
        });
      }

      // 過熱圏の強制補正
      if (
        isOverheated(deviationRate, style) &&
        styleResult.recommendation === "buy"
      ) {
        styleResult.recommendation = "stay";
        styleResult.confidence = Math.max(
          0,
          styleResult.confidence + MA_DEVIATION.CONFIDENCE_PENALTY,
        );
        styleResult.caution = `25日移動平均線から+${deviationRate!.toFixed(1)}%乖離しており過熱圏のため、様子見を推奨します。${styleResult.caution}`;
        if (style === INVESTMENT_STYLES.CONSERVATIVE) {
            styleResult.advice = `移動平均線から+${deviationRate!.toFixed(1)}%乖離しており過熱圏です。平均線への回帰を待ってから購入を検討しましょう。`;
        }
        styleResult.correctionExplanation = generateCorrectionExplanation({
          ruleId: "overheat_block",
          styleName,
          originalRecommendation: "buy",
          correctedRecommendation: "stay",
          thresholdValue: `+${MA_DEVIATION.UPPER_THRESHOLD}%`,
          actualValue: `+${deviationRate!.toFixed(1)}%`,
        });
      }
    }

    // 市場パニック時のconfidence低下（全スタイル共通）
    if (isMarketPanic && styleResult.recommendation === "buy") {
      styleResult.confidence = Math.max(
        0,
        styleResult.confidence - MARKET_DEFENSIVE_MODE.CONFIDENCE_REDUCTION,
      );
      if (!styleResult.correctionExplanation) {
        styleResult.correctionExplanation = generateCorrectionExplanation({
          ruleId: "market_panic",
          styleName,
          originalRecommendation: "buy",
          correctedRecommendation: "buy",
          actualValue: `${weekChangeRate?.toFixed(0) ?? "N/A"}%`,
        });
      }
    }

    // 購入タイミング判断
    if (styleResult.recommendation === "buy") {
      const { deviationRate: devRate, rsi, sma25, currentPrice } = buyTimingParams;
      const isHighDeviation =
        devRate !== null && devRate > MA_DEVIATION.DIP_BUY_THRESHOLD;
      const isOverboughtRSI =
        rsi !== null && rsi > MA_DEVIATION.RSI_OVERBOUGHT_THRESHOLD;
      const isTechnicalSell = technicalSignal?.signal === "sell";

      if (isHighDeviation || isOverboughtRSI || isTechnicalSell) {
        styleResult.buyTiming = "dip";
      } else {
        styleResult.buyTiming = "market";
      }
      // AI推奨押し目価格のバリデーション（各スタイルのAI生成値を検証）
      const { sma75, volatility, atr14 } = buyTimingParams;
      styleResult.dipTargetPrice = validateDipPrice(styleResult.dipTargetPrice, currentPrice, sma25, sma75, volatility, atr14);
    }

    // 売りタイミング判定（avoid推奨時のみ）
    if (styleResult.recommendation === "avoid") {
      const { deviationRate: devRate, rsi } = sellTimingParams;
      const isDeviationOk =
        devRate === null || devRate >= -5;
      const isRsiOk = rsi === null || rsi >= 30;

      if (isDeviationOk && isRsiOk) {
        styleResult.sellTiming = "market";
      } else {
        // 売られすぎ状態は「様子見」として扱う（ウォッチリスト文脈では戻り待ちではなく様子見が適切）
        styleResult.recommendation = "stay";
        styleResult.sellTiming = null;
      }
    }

    result[style] = styleResult;
  }

  return result;
}

/**
 * ポートフォリオ分析のセーフティルールを適用
 * AI生成済みの3スタイル結果に対して、急騰抑制と戻り売り強制設定のみを適用する
 */
export function applyPortfolioStyleSafetyRules(params: {
  styleAnalyses: StyleAnalysesMap<PortfolioStyleAnalysis>;
  weekChangeRate: number | null;
  sma25: number | null;
  sellTimingBase: string | null;
  sellTargetPriceBase: number | null;
  isMarketPanic?: boolean;
}): StyleAnalysesMap<PortfolioStyleAnalysis> {
  const { styleAnalyses, weekChangeRate, sma25, sellTimingBase, sellTargetPriceBase, isMarketPanic = false } = params;

  const result = {} as StyleAnalysesMap<PortfolioStyleAnalysis>;

  for (const style of ALL_STYLES) {
    // AI生成済みの結果をコピー（元のオブジェクトを変更しないため）
    const styleResult = { ...styleAnalyses[style], correctionExplanation: styleAnalyses[style].correctionExplanation ?? null };
    const styleName = getStyleNameJa(style);

    // sellTiming/sellTargetPriceのベース値がAI結果に含まれていない場合はベース値を設定
    if (styleResult.sellTiming === null && sellTimingBase !== null) {
      styleResult.sellTiming = sellTimingBase;
    }
    if (styleResult.sellTargetPrice === null && sellTargetPriceBase !== null) {
      styleResult.sellTargetPrice = sellTargetPriceBase;
    }

    // 急騰銘柄の買い増し抑制（スタイル依存）
    if (
      isSurgeStock(weekChangeRate, style) &&
      styleResult.recommendation === "buy"
    ) {
      const surgeThreshold = style === "CONSERVATIVE" ? MOMENTUM.CONSERVATIVE_SURGE_THRESHOLD
        : style === "AGGRESSIVE" ? MOMENTUM.AGGRESSIVE_SURGE_THRESHOLD
        : MOMENTUM.BALANCED_SURGE_THRESHOLD;
      styleResult.recommendation = "hold";
      styleResult.shortTerm = `週間+${weekChangeRate!.toFixed(0)}%の急騰後のため、買い増しは高値掴みのリスクがあります。${styleResult.shortTerm}`;
      styleResult.correctionExplanation = generateCorrectionExplanation({
        ruleId: "surge_block",
        styleName,
        originalRecommendation: "buy",
        correctedRecommendation: "hold",
        thresholdValue: `+${surgeThreshold}%`,
        actualValue: `+${weekChangeRate!.toFixed(0)}%`,
      });
    }

    // 市場パニック時のconfidence低下（買い増し推奨時）
    if (isMarketPanic && styleResult.recommendation === "buy") {
      styleResult.confidence = Math.max(
        0,
        styleResult.confidence - MARKET_DEFENSIVE_MODE.CONFIDENCE_REDUCTION,
      );
      if (!styleResult.correctionExplanation) {
        styleResult.correctionExplanation = generateCorrectionExplanation({
          ruleId: "market_panic",
          styleName,
          originalRecommendation: "buy",
          correctedRecommendation: "buy",
          actualValue: `${weekChangeRate?.toFixed(0) ?? "N/A"}%`,
        });
      }
    }

    result[style] = styleResult;
  }

  return result;
}
