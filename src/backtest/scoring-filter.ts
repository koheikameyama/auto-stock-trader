/**
 * Backtest-only scoring filter for breakout strategy verification.
 * Computes a 100-point score from OHLCV data to filter breakout entries.
 *
 * Categories:
 *   Trend Quality (40) + Entry Timing (35) + Risk Quality (25) = 100
 */

// ============================================================
// Constants
// ============================================================

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
