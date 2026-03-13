/**
 * トレーディングスナップショット型定義
 *
 * エントリー（購入）時とエグジット（売却）時の
 * コンテキストデータを保存するための構造。
 */

export interface EntrySnapshot {
  score: {
    totalScore: number;
    rank: string;
    technical: { total: number; rsi: number; ma: number; volume: number; volumeDirection?: string; macd?: number; rs?: number };
    pattern: { total: number; chart: number; candlestick: number };
    liquidity: {
      total: number;
      tradingValue: number;
      spreadProxy: number;
      stability: number;
    };
    topPattern: {
      name: string;
      rank: string;
      winRate: number;
      signal: string;
    } | null;
    technicalSignal: string;
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
  };
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
    minLow: number;
    maxFavorableExcursion: number;
    maxAdverseExcursion: number;
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
