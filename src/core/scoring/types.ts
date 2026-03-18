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
    | "weeklyDowntrend"
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
    priorBreakout: number;
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

import { SCORING } from "../../lib/constants/scoring";

/** ランク判定 */
export function getRank(score: number): NewLogicScore["rank"] {
  const { S_RANK, A_RANK, B_RANK, C_RANK } = SCORING.THRESHOLDS;
  if (score >= S_RANK) return "S";
  if (score >= A_RANK) return "A";
  if (score >= B_RANK) return "B";
  if (score >= C_RANK) return "C";
  return "D";
}
