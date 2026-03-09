/**
 * ロジックスコアリングエンジン（3カテゴリ100点満点）
 *
 * カテゴリ1: テクニカル指標（40点） — RSI, MA, 出来高変化
 * カテゴリ2: チャート・ローソク足パターン（30点）
 * カテゴリ3: 流動性（30点） — 売買代金, 値幅率, 安定性
 *
 * 即死ルール: 1つでも該当 → 即0点
 *
 * 全て純粋関数（I/Oなし）。
 */

import type { TechnicalSummary } from "./technical-analysis";
import type { OHLCVData } from "./technical-analysis";
import type { ChartPatternResult, ChartPatternRank } from "../lib/chart-patterns";
import type { PatternResult } from "../lib/candlestick-patterns";
import type { WeeklyTrendResult } from "../lib/technical-indicators";
import { SCORING } from "../lib/constants";

// ========================================
// 型定義
// ========================================

export interface LogicScoreInput {
  summary: TechnicalSummary;
  chartPatterns: ChartPatternResult[];
  candlestickPattern: PatternResult | null;
  historicalData: OHLCVData[];
  latestPrice: number;
  latestVolume: number;
  weeklyVolatility: number | null;
  weeklyTrend?: WeeklyTrendResult | null;
}

export interface LogicScore {
  totalScore: number;
  rank: "S" | "A" | "B" | "C";

  technical: {
    total: number;
    rsi: number;
    ma: number;
    volume: number;
  };
  pattern: {
    total: number;
    chart: number;
    candlestick: number;
  };
  liquidity: {
    total: number;
    tradingValue: number;
    spreadProxy: number;
    stability: number;
  };

  isDisqualified: boolean;
  disqualifyReason: string | null;

  topPattern: {
    name: string;
    rank: string;
    winRate: number;
    signal: string;
  } | null;

  technicalSignal: "strong_buy" | "buy" | "neutral" | "sell" | "strong_sell";

  weeklyTrendPenalty: number;
}

/** 後方互換: 旧 ScorerInput */
export type ScorerInput = LogicScoreInput;
/** 後方互換: 旧 TechnicalScore */
export type TechnicalScore = LogicScore;

// ========================================
// 即死ルール
// ========================================

interface DisqualifyResult {
  isDisqualified: boolean;
  reason: string | null;
}

function checkDisqualify(input: LogicScoreInput): DisqualifyResult {
  const { latestPrice, weeklyVolatility, historicalData } = input;

  // 10万円で買えない（株価 > 1,000円）
  if (latestPrice > SCORING.DISQUALIFY.MAX_PRICE) {
    return { isDisqualified: true, reason: "price_too_high" };
  }

  // 値幅率が広すぎる（当日 high-low / close > 5%）
  if (historicalData.length > 0) {
    const latest = historicalData[0];
    if (latest.close <= 0) {
      return { isDisqualified: true, reason: "invalid_price_data" };
    }
    const spreadPct = (latest.high - latest.low) / latest.close;
    if (spreadPct > SCORING.DISQUALIFY.MAX_DAILY_SPREAD_PCT) {
      return { isDisqualified: true, reason: "spread_too_wide" };
    }
  }

  // ボラティリティ異常（週次 > 8%）
  if (
    weeklyVolatility != null &&
    weeklyVolatility > SCORING.DISQUALIFY.MAX_WEEKLY_VOLATILITY
  ) {
    return { isDisqualified: true, reason: "volatility_extreme" };
  }

  return { isDisqualified: false, reason: null };
}

// ========================================
// カテゴリ1: テクニカル指標（40点）
// ========================================

/** RSI スコア（0-15点） */
function scoreRSI(rsi: number | null): number {
  if (rsi == null) return 7;
  const max = SCORING.SUB_MAX.RSI;
  if (rsi >= 30 && rsi < 40) return max;      // 反発ゾーン
  if (rsi >= 40 && rsi < 50) return 10;
  if (rsi >= 50 && rsi < 60) return 7;
  if (rsi >= 60 && rsi < 70) return 4;
  if (rsi < 30) return 5;                     // 売られすぎ
  return 0;                                    // rsi >= 70
}

/** 移動平均線 / 乖離率 スコア（0-15点） */
function scoreMA(summary: TechnicalSummary): number {
  const { trend, orderAligned, slopesAligned } = summary.maAlignment;
  const max = SCORING.SUB_MAX.MA;

  if (trend === "uptrend" && orderAligned && slopesAligned) return max;
  if (trend === "uptrend" && orderAligned) return 12;
  if (trend === "uptrend") return 10;
  if (trend === "downtrend" && orderAligned && slopesAligned) return 0;
  if (trend === "downtrend" && orderAligned) return 3;
  if (trend === "downtrend") return 4;
  return 7; // none
}

/** 出来高変化スコア（0-10点） */
function scoreVolumeChange(volumeRatio: number | null): number {
  if (volumeRatio == null) return 5;
  const max = SCORING.SUB_MAX.VOLUME_CHANGE;

  if (volumeRatio >= 2.0) return max;
  if (volumeRatio >= 1.5) return 8;
  if (volumeRatio >= 1.0) return 5;
  if (volumeRatio > 0.5) return 3;
  return 2;
}

// ========================================
// カテゴリ2: チャート・ローソク足パターン（30点）
// ========================================

/** チャートパターン スコア（0-22点） */
function scoreChartPattern(
  patterns: ChartPatternResult[],
): { score: number; topPattern: LogicScore["topPattern"] } {
  if (patterns.length === 0) {
    return { score: 0, topPattern: null };
  }

  const max = SCORING.SUB_MAX.CHART_PATTERN;
  const rankScoreMap: Record<ChartPatternRank, number> = {
    S: max,        // 22
    A: 17,
    B: 13,
    C: 9,
    D: 6,
  };

  const buyPatterns = patterns.filter((p) => p.signal === "buy");
  const sellPatterns = patterns.filter((p) => p.signal === "sell");

  if (buyPatterns.length > 0) {
    const best = buyPatterns.sort(
      (a, b) => rankScoreMap[b.rank] - rankScoreMap[a.rank],
    )[0];
    return {
      score: rankScoreMap[best.rank],
      topPattern: {
        name: best.patternName,
        rank: best.rank,
        winRate: best.winRate,
        signal: best.signal,
      },
    };
  }

  if (sellPatterns.length > 0) {
    const best = sellPatterns.sort(
      (a, b) => rankScoreMap[b.rank] - rankScoreMap[a.rank],
    )[0];
    // 売りパターンは反転（高ランク売り = 低スコア）
    const invertedScore = max - rankScoreMap[best.rank];
    return {
      score: invertedScore,
      topPattern: {
        name: best.patternName,
        rank: best.rank,
        winRate: best.winRate,
        signal: best.signal,
      },
    };
  }

  // neutral パターンのみ
  const best = patterns[0];
  return {
    score: 6,
    topPattern: {
      name: best.patternName,
      rank: best.rank,
      winRate: best.winRate,
      signal: best.signal,
    },
  };
}

/** ローソク足パターン スコア（0-8点） */
function scoreCandlestick(pattern: PatternResult | null): number {
  const max = SCORING.SUB_MAX.CANDLESTICK;
  if (pattern == null) return 4; // 中立

  if (pattern.signal === "buy") return Math.round(pattern.strength * max / 100);
  if (pattern.signal === "sell") return Math.round((100 - pattern.strength) * max / 100);
  return 4;
}

// ========================================
// カテゴリ3: 流動性（30点）
// ========================================

/** 売買代金スコア（0-12点） */
function scoreTradingValue(price: number, volume: number): number {
  const tradingValue = price * volume;
  const tiers = SCORING.LIQUIDITY.TRADING_VALUE_TIERS;
  const scores = [12, 9, 6, 3];

  for (let i = 0; i < tiers.length; i++) {
    if (tradingValue >= tiers[i]) return scores[i];
  }
  return 0;
}

/** 値幅率スコア（スプレッド代替）（0-10点） */
function scoreSpreadProxy(historicalData: OHLCVData[]): number {
  if (historicalData.length === 0) return 5;

  const latest = historicalData[0];
  if (latest.close <= 0) return 0;
  const spreadPct = (latest.high - latest.low) / latest.close;
  const tiers = SCORING.LIQUIDITY.SPREAD_PROXY_TIERS;
  const scores = [10, 7, 4, 2];

  for (let i = 0; i < tiers.length; i++) {
    if (spreadPct <= tiers[i]) return scores[i];
  }
  return 0;
}

/** 売買代金安定性スコア（0-8点）：過去5日の売買代金の変動係数 */
function scoreStability(historicalData: OHLCVData[]): number {
  const days = Math.min(historicalData.length, 5);
  if (days < 2) return 4; // データ不足は中立

  const tradingValues = historicalData.slice(0, days).map(
    (d) => d.close * d.volume,
  );
  const mean = tradingValues.reduce((s, v) => s + v, 0) / tradingValues.length;
  if (mean === 0) return 1;

  const variance =
    tradingValues.reduce((s, v) => s + (v - mean) ** 2, 0) / tradingValues.length;
  const cv = Math.sqrt(variance) / mean; // 変動係数

  const tiers = SCORING.LIQUIDITY.STABILITY_CV_TIERS;
  const scores = [8, 6, 3];

  for (let i = 0; i < tiers.length; i++) {
    if (cv <= tiers[i]) return scores[i];
  }
  return 1;
}

// ========================================
// メインスコアリング関数
// ========================================

export function getRank(score: number): "S" | "A" | "B" | "C" {
  if (score >= SCORING.THRESHOLDS.S_RANK) return "S";
  if (score >= SCORING.THRESHOLDS.A_RANK) return "A";
  if (score >= SCORING.THRESHOLDS.B_RANK) return "B";
  return "C";
}

function getTechnicalSignal(
  score: number,
): "strong_buy" | "buy" | "neutral" | "sell" | "strong_sell" {
  if (score >= 80) return "strong_buy";
  if (score >= 65) return "buy";
  if (score >= 50) return "neutral";
  if (score >= 35) return "sell";
  return "strong_sell";
}

/**
 * 3カテゴリスコアリング（100点満点）
 *
 * 即死ルール → テクニカル(40) + パターン(30) + 流動性(30)
 */
export function scoreTechnicals(input: LogicScoreInput): LogicScore {
  const {
    summary,
    chartPatterns,
    candlestickPattern,
    historicalData,
    latestPrice,
    latestVolume,
  } = input;

  // 即死ルールチェック
  const disqualify = checkDisqualify(input);
  if (disqualify.isDisqualified) {
    return {
      totalScore: 0,
      rank: "C",
      technical: { total: 0, rsi: 0, ma: 0, volume: 0 },
      pattern: { total: 0, chart: 0, candlestick: 0 },
      liquidity: { total: 0, tradingValue: 0, spreadProxy: 0, stability: 0 },
      isDisqualified: true,
      disqualifyReason: disqualify.reason,
      topPattern: null,
      technicalSignal: "strong_sell",
      weeklyTrendPenalty: 0,
    };
  }

  // カテゴリ1: テクニカル指標（40点）
  const rsiScore = scoreRSI(summary.rsi);
  let maScore = scoreMA(summary);
  const volumeChangeScore = scoreVolumeChange(summary.volumeAnalysis.volumeRatio);

  // 週足トレンド整合性チェック: 日足↑ × 週足↓ → MA減点
  let weeklyTrendPenalty = 0;
  if (
    input.weeklyTrend &&
    input.weeklyTrend.trend === "downtrend" &&
    summary.maAlignment.trend === "uptrend"
  ) {
    weeklyTrendPenalty = -SCORING.WEEKLY_TREND.PENALTY;
    maScore = Math.max(0, maScore + weeklyTrendPenalty);
  }

  const technicalTotal = rsiScore + maScore + volumeChangeScore;

  // カテゴリ2: チャート・ローソク足パターン（30点）
  const { score: chartScore, topPattern } = scoreChartPattern(chartPatterns);
  const candlestickScore = scoreCandlestick(candlestickPattern);
  const patternTotal = chartScore + candlestickScore;

  // カテゴリ3: 流動性（30点）
  const tradingValueScore = scoreTradingValue(latestPrice, latestVolume);
  const spreadProxyScore = scoreSpreadProxy(historicalData);
  const stabilityScore = scoreStability(historicalData);
  const liquidityTotal = tradingValueScore + spreadProxyScore + stabilityScore;

  const totalScore = technicalTotal + patternTotal + liquidityTotal;

  return {
    totalScore,
    rank: getRank(totalScore),
    technical: {
      total: technicalTotal,
      rsi: rsiScore,
      ma: maScore,
      volume: volumeChangeScore,
    },
    pattern: {
      total: patternTotal,
      chart: chartScore,
      candlestick: candlestickScore,
    },
    liquidity: {
      total: liquidityTotal,
      tradingValue: tradingValueScore,
      spreadProxy: spreadProxyScore,
      stability: stabilityScore,
    },
    isDisqualified: false,
    disqualifyReason: null,
    topPattern,
    technicalSignal: getTechnicalSignal(totalScore),
    weeklyTrendPenalty,
  };
}
