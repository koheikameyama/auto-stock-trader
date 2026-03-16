import type { OHLCVData, TechnicalSummary } from "../technical-analysis";

/** ゲート判定結果 */
export interface ScoringGateResult {
  passed: boolean;
  failedGate:
    | "liquidity"
    | "spread"
    | "volatility"
    | "earnings"
    | "dividend"
    | null;
}

/** スコアリング入力 */
export interface ScoringInput {
  /** 日足OHLCV（newest-first） */
  historicalData: OHLCVData[];
  latestPrice: number;
  latestVolume: number;
  weeklyVolatility: number | null;
  nextEarningsDate?: Date | null;
  exDividendDate?: Date | null;
  /** 25日平均出来高 */
  avgVolume25?: number | null;
  /** テクニカルサマリー（analyzeTechnicals() の出力） */
  summary: TechnicalSummary;
  /** セクター相対強度（対日経225、%） */
  sectorRelativeStrength?: number | null;
}

/** 新スコアリング結果 */
export interface NewLogicScore {
  totalScore: number;
  rank: "S" | "A" | "B" | "C" | "D";
  gate: ScoringGateResult;
  trendQuality: {
    total: number;
    maAlignment: number;
    weeklyTrend: number;
    trendContinuity: number;
  };
  entryTiming: {
    total: number;
    pullbackDepth: number;
    breakout: number;
    candlestickSignal: number;
  };
  riskQuality: {
    total: number;
    atrStability: number;
    rangeContraction: number;
    volumeStability: number;
  };
  sectorMomentumScore: number;
  isDisqualified: boolean;
  disqualifyReason: string | null;
}

/** ランク判定 */
export function getRank(score: number): NewLogicScore["rank"] {
  if (score >= 80) return "S";
  if (score >= 65) return "A";
  if (score >= 50) return "B";
  if (score >= 35) return "C";
  return "D";
}
