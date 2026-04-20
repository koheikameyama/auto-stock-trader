/**
 * トレーディングスナップショット型定義
 *
 * エントリー（購入）時とエグジット（売却）時の
 * コンテキストデータを保存するための構造。
 */

export interface EntrySnapshot {
  score: {
    totalScore: number;
    gate: {
      passed: boolean;
      failedGate: string | null;
    };
    trendQuality: {
      total: number;
      maAlignment: number;
      weeklyTrend: number;
      trendContinuity: number;
    };
    entryTiming: {
      total: number;
      pullbackDepth: number;
      priorBreakout: number;
      candlestickSignal: number;
    };
    riskQuality: {
      total: number;
      atrStability: number;
      rangeContraction: number;
      volumeStability: number;
    };
    isDisqualified: boolean;
    disqualifyReason: string | null;
  };
  technicals: {
    rsi: number | null;
    sma5: number | null;
    sma25: number | null;
    sma75: number | null;
    macd: {
      macd: number | null;
      signal: number | null;
      histogram: number | null;
    };
    bollingerBands: {
      upper: number | null;
      middle: number | null;
      lower: number | null;
    };
    atr14: number | null;
    volumeRatio: number | null;
    deviationRate25: number | null;
    maAlignment: {
      trend: string;
      orderAligned: boolean;
      slopesAligned: boolean;
    };
    supports: number[];
    resistances: number[];
  };
  logicEntryCondition: {
    limitPrice: number;
    takeProfitPrice: number;
    stopLossPrice: number;
    quantity: number;
    riskRewardRatio: number;
    strategy: string;
  };
  aiReview: {
    decision: string;
    reasoning: string;
    modification: {
      adjustLimitPrice: number | null;
      adjustTakeProfitPrice: number | null;
      adjustStopLossPrice: number | null;
      adjustQuantity: number | null;
    } | null;
    riskFlags: string[];
  } | null;
  marketContext: {
    sentiment: string;
    reasoning: string;
  };
  newsContext: string | null;
}

export interface ExitSnapshot {
  exitReason: string;
  exitPrice: number;
  priceJourney: {
    maxHigh: number;
    minLow?: number;
  };
  trailingStop?: {
    wasActivated: boolean;
    finalTrailingStopPrice: number | null;
    entryAtr: number | null;
  };
  marketContext: {
    sentiment: string;
    reasoning: string;
  } | null;
}
