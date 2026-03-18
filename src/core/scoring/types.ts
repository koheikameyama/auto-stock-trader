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

/** スコアリングランク（S≥75: エントリー対象, A≥60: フォールバック, B<60: 対象外） */
export type ScoringRank = "S" | "A" | "B";

/** 新スコアリング結果 */
export interface NewLogicScore {
  totalScore: number;
  rank: ScoringRank;
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

/** 保有継続スコア結果 */
export interface HoldingScore {
  totalScore: number; // 0-67
  holdingRank: HoldingRank;
  trendQuality: {
    total: number;
    maAlignment: number;
    weeklyTrend: number;
    trendContinuity: number;
  };
  riskQuality: {
    total: number;
    atrStability: number;
    rangeContraction: number;
    volumeStability: number;
  };
  sectorMomentumScore: number;
  gate: HoldingGateResult;
  alerts: HoldingAlert[];
}

export type HoldingRank =
  | "strong"
  | "healthy"
  | "weakening"
  | "deteriorating"
  | "critical";

export interface HoldingGateResult {
  passed: boolean;
  failedGate: "liquidity_dried" | "weekly_breakdown" | null;
}

export interface HoldingAlert {
  type:
    | "trend_collapse"
    | "risk_spike"
    | "sector_weakness"
    | "liquidity_warning";
  severity: "warning" | "critical";
  message: string;
}

import { SCORING, HOLDING_SCORE } from "../../lib/constants/scoring";

/** ランク判定（エントリースコア用） */
export function getRank(score: number): ScoringRank {
  const { S_RANK, A_RANK } = SCORING.THRESHOLDS;
  if (score >= S_RANK) return "S";
  if (score >= A_RANK) return "A";
  return "B";
}

/** ランク判定（保有継続スコア用） */
export function getHoldingRank(score: number): HoldingRank {
  const { STRONG, HEALTHY, WEAKENING, DETERIORATING } = HOLDING_SCORE.RANKS;
  if (score >= STRONG) return "strong";
  if (score >= HEALTHY) return "healthy";
  if (score >= WEAKENING) return "weakening";
  if (score >= DETERIORATING) return "deteriorating";
  return "critical";
}
