/**
 * Backtest-only scoring filter for breakout strategy verification.
 * Computes a 100-point score from OHLCV data to filter breakout entries.
 *
 * Categories:
 *   Trend Quality (40) + Entry Timing (35) + Risk Quality (25) = 100
 */

import type { OHLCVData } from "../core/technical-analysis";

// ============================================================
// Constants
// ============================================================

// Trend Quality thresholds
const CONTINUITY_SWEET_MIN = 10;
const CONTINUITY_SWEET_MAX = 30;
const CONTINUITY_MATURE_MAX = 50;
const WEEKLY_SMA13_FLAT_THRESHOLD = 0.5;

// Risk Quality thresholds
const ATR_CV_EXCELLENT = 0.15;
const ATR_CV_GOOD = 0.25;
const ATR_CV_FAIR = 0.35;
const BB_SQUEEZE_STRONG = 20;
const BB_SQUEEZE_MODERATE = 40;
const VOLUME_CV_STABLE = 0.5;
const VOLUME_CV_MODERATE = 0.8;
const VOLUME_CV_PERIOD = 25;
const ATR_CV_WINDOW = 20;

// ============================================================
// Trend Quality (max 40)
// ============================================================

/** MA整列スコア (0-18) */
export function scoreMaAlignment(
  close: number,
  sma5: number | null,
  sma25: number | null,
  sma75: number | null,
): number {
  if (sma25 == null || sma5 == null) return 0;

  if (sma75 == null) {
    if (close > sma5 && sma5 > sma25) return 14;
    if (close > sma25 && close < sma5) return 8;
    if (close > sma25) return 4;
    return 0;
  }

  if (close < sma25) {
    if (close > sma75 && sma25 > sma75) return 4;
    if (close > sma75) return 2;
    return 0;
  }

  if (close > sma5 && sma5 > sma25 && sma25 > sma75) return 18;
  if (close > sma5 && sma5 > sma25) return 14;
  if (close > sma25 && close < sma5) return 8;
  return 4;
}

/** 週足トレンドスコア (0-12) */
export function scoreWeeklyTrend(
  weeklyClose: number | null,
  weeklySma13: number | null,
  prevWeeklySma13: number | null,
): number {
  if (weeklySma13 == null || prevWeeklySma13 == null) return 0;
  const changeRate = ((weeklySma13 - prevWeeklySma13) / prevWeeklySma13) * 100;
  const isRising = changeRate > WEEKLY_SMA13_FLAT_THRESHOLD;
  const aboveSma = weeklyClose != null && weeklyClose > weeklySma13;
  if (aboveSma && isRising) return 12;
  if (aboveSma) return 8;
  if (isRising) return 4;
  return 0;
}

/** トレンド継続性スコア (0-10) */
export function scoreTrendContinuity(daysAboveSma25: number): number {
  if (daysAboveSma25 <= 0) return 0;
  if (daysAboveSma25 >= CONTINUITY_SWEET_MIN && daysAboveSma25 <= CONTINUITY_SWEET_MAX) return 10;
  if (daysAboveSma25 < CONTINUITY_SWEET_MIN) return 7;
  if (daysAboveSma25 <= CONTINUITY_MATURE_MAX) return 5;
  return 2;
}

/** SMA25上の連続日数をカウント（newest-first配列） */
export function countDaysAboveSma25(data: OHLCVData[]): number {
  if (data.length < 25) return 0;
  let count = 0;
  for (let i = 0; i < data.length - 24; i++) {
    const closes = data.slice(i, i + 25).map((d) => d.close);
    const sma25 = closes.reduce((s, v) => s + v, 0) / 25;
    if (data[i].close > sma25) {
      count++;
    } else {
      break;
    }
  }
  return count;
}

// Entry Timing thresholds
const PULLBACK_NEAR_MIN = -1;
const PULLBACK_NEAR_MAX = 2;
const PULLBACK_DEEP_THRESHOLD = -3;
const PRIOR_BREAKOUT_VOLUME_RATIO = 1.5;
const PRIOR_BREAKOUT_LOOKBACK_20 = 20;
const PRIOR_BREAKOUT_RECENCY_20 = 7;
const PRIOR_BREAKOUT_LOOKBACK_10 = 10;
const PRIOR_BREAKOUT_RECENCY_10 = 5;
const PRIOR_BREAKOUT_NEAR_HIGH_PCT = 0.95;

// ============================================================
// Entry Timing (max 35)
// ============================================================

/** リバーサルサインの判定 */
function hasReversalSign(bars: OHLCVData[]): boolean {
  if (bars.length < 2) return false;
  const [today, yesterday] = bars;
  // 下ヒゲが実体以上
  for (const bar of [today, yesterday]) {
    const lowerShadow = Math.min(bar.open, bar.close) - bar.low;
    const realBody = Math.abs(bar.close - bar.open);
    if (lowerShadow >= realBody && realBody > 0) return true;
  }
  // 陰線→陽線の転換
  if (yesterday.close < yesterday.open && today.close > today.open) return true;
  return false;
}

/** プルバック深度スコア (0-15) */
export function scorePullbackDepth(
  close: number,
  sma5: number | null,
  sma25: number | null,
  deviationRate25: number | null,
  recentBars: OHLCVData[],
): number {
  if (sma25 == null || deviationRate25 == null) return 0;
  if (deviationRate25 < PULLBACK_DEEP_THRESHOLD) return 0;

  const nearSma = deviationRate25 >= PULLBACK_NEAR_MIN && deviationRate25 <= PULLBACK_NEAR_MAX;
  if (nearSma && hasReversalSign(recentBars)) return 15;
  if (nearSma) return 10;

  // SMA25を一時的に割って回復
  if (close > sma25 && recentBars.length >= 4) {
    for (let i = 1; i <= Math.min(3, recentBars.length - 1); i++) {
      if (recentBars[i].close < sma25) return 8;
    }
  }

  if (deviationRate25 > PULLBACK_NEAR_MAX && deviationRate25 <= 5) return 6;
  if (sma5 != null && close >= sma5) return 4;
  return 0;
}

/** 直近ブレイクアウトスコア (0-12) */
export function scorePriorBreakout(
  bars: OHLCVData[],
  avgVolume25: number | null,
  pullbackScore: number,
): number {
  if (pullbackScore === 0 || bars.length < 2) return 0;
  const currentClose = bars[0].close;

  // 20日チェック
  const lookback20 = bars.slice(0, PRIOR_BREAKOUT_LOOKBACK_20 + 1);
  if (lookback20.length > 1) {
    let maxClose = -Infinity;
    let maxIdx = 0;
    for (let i = 0; i < lookback20.length; i++) {
      if (lookback20[i].close > maxClose) {
        maxClose = lookback20[i].close;
        maxIdx = i;
      }
    }
    if (maxIdx >= 1 && maxIdx <= PRIOR_BREAKOUT_RECENCY_20) {
      const breakoutBar = lookback20[maxIdx];
      const volumeRatio = avgVolume25 && avgVolume25 > 0
        ? breakoutBar.volume / avgVolume25
        : 1;
      if (volumeRatio > PRIOR_BREAKOUT_VOLUME_RATIO) return 12;
      if (volumeRatio > 1.2) return 9;
      return 7;
    }
  }

  // 10日チェック
  const lookback10 = bars.slice(0, PRIOR_BREAKOUT_LOOKBACK_10 + 1);
  if (lookback10.length > 1) {
    let maxClose = -Infinity;
    let maxIdx = 0;
    for (let i = 0; i < lookback10.length; i++) {
      if (lookback10[i].close > maxClose) {
        maxClose = lookback10[i].close;
        maxIdx = i;
      }
    }
    if (maxIdx >= 1 && maxIdx <= PRIOR_BREAKOUT_RECENCY_10) return 5;
    if (maxIdx >= 1 && currentClose >= maxClose * PRIOR_BREAKOUT_NEAR_HIGH_PCT) return 2;
  }

  return 0;
}

/** ローソク足シグナルスコア (0-8) */
export function scoreCandlestickSignal(
  bars: OHLCVData[],
  avgVolume25: number | null,
): number {
  if (bars.length < 2) return 0;
  const [today, yesterday] = bars;
  let maxScore = 0;

  const volumeRatio = avgVolume25 && avgVolume25 > 0
    ? today.volume / avgVolume25
    : 0;

  // Bullish engulfing + volume
  const todayBullish = today.close > today.open;
  const yesterdayBearish = yesterday.close < yesterday.open;
  if (
    todayBullish && yesterdayBearish &&
    today.close > yesterday.open &&
    today.open < yesterday.close &&
    volumeRatio > 1.0
  ) {
    maxScore = Math.max(maxScore, 8);
  }

  // Hammer
  const realBody = Math.abs(today.close - today.open);
  const totalRange = today.high - today.low;
  const lowerShadow = Math.min(today.open, today.close) - today.low;
  const upperShadow = today.high - Math.max(today.open, today.close);
  if (totalRange > 0 && realBody > 0 && lowerShadow > realBody * 2 && upperShadow <= lowerShadow / 3) {
    maxScore = Math.max(maxScore, 6);
  }

  // 3 consecutive bullish + increasing volume
  if (bars.length >= 3) {
    const [b0, b1, b2] = bars;
    if (
      b0.close > b0.open && b1.close > b1.open && b2.close > b2.open &&
      b0.volume > b1.volume && b1.volume > b2.volume
    ) {
      maxScore = Math.max(maxScore, 5);
    }
  }

  // Strong bullish bar
  if (totalRange > 0) {
    const closeToHigh = (today.high - today.close) / totalRange;
    const bodyRatio = realBody / totalRange;
    if (closeToHigh < 0.15 && bodyRatio > 0.6) {
      maxScore = Math.max(maxScore, 4);
    }
  }

  // Doji
  if (totalRange > 0 && realBody / totalRange < 0.1) {
    maxScore = Math.max(maxScore, 3);
  }

  return maxScore;
}

// ============================================================
// Risk Quality (max 25)
// ============================================================

/** ATR安定性スコア (0-10) */
export function scoreAtrStability(atrCv: number | null): number {
  if (atrCv == null) return 0;
  if (atrCv < ATR_CV_EXCELLENT) return 10;
  if (atrCv < ATR_CV_GOOD) return 7;
  if (atrCv < ATR_CV_FAIR) return 4;
  return 0;
}

/** レンジ収縮スコア (0-8) */
export function scoreRangeContraction(bbWidthPercentile: number | null): number {
  if (bbWidthPercentile == null) return 0;
  if (bbWidthPercentile < BB_SQUEEZE_STRONG) return 8;
  if (bbWidthPercentile < BB_SQUEEZE_MODERATE) return 5;
  if (bbWidthPercentile < 60) return 3;
  return 0;
}

/** 出来高安定性スコア (0-7) */
export function scoreVolumeStability(
  volumeMA5: number | null,
  volumeMA25: number | null,
  volumeCv: number | null,
): number {
  if (volumeMA5 == null || volumeMA25 == null || volumeCv == null) return 0;
  const isIncreasing = volumeMA5 > volumeMA25;
  if (isIncreasing && volumeCv < VOLUME_CV_STABLE) return 7;
  if (isIncreasing && volumeCv < VOLUME_CV_MODERATE) return 5;
  if (volumeCv < VOLUME_CV_STABLE) return 3;
  if (volumeCv < VOLUME_CV_MODERATE) return 1;
  return 0;
}

/** ATR14のCV（変動係数）を計算 */
export function calculateAtrCv(atr14Values: number[]): number | null {
  if (atr14Values.length < ATR_CV_WINDOW) return null;
  const window = atr14Values.slice(0, ATR_CV_WINDOW);
  const mean = window.reduce((s, v) => s + v, 0) / window.length;
  if (mean === 0) return 0;
  const variance = window.reduce((s, v) => s + (v - mean) ** 2, 0) / window.length;
  return Math.sqrt(variance) / mean;
}

/** 出来高のCV（変動係数）を計算 */
export function calculateVolumeCv(volumes: number[]): number | null {
  if (volumes.length < VOLUME_CV_PERIOD) return null;
  const window = volumes.slice(0, VOLUME_CV_PERIOD);
  const mean = window.reduce((s, v) => s + v, 0) / window.length;
  if (mean === 0) return 0;
  const variance = window.reduce((s, v) => s + (v - mean) ** 2, 0) / window.length;
  return Math.sqrt(variance) / mean;
}
