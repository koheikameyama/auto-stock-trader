import { SCORING } from "../../lib/constants/scoring";

const { SUB_MAX, RISK } = SCORING;

/**
 * ATR安定性スコア（0-10）
 */
export function scoreAtrStability(atrCv: number | null): number {
  if (atrCv == null) return 0;
  if (atrCv < RISK.ATR_CV_EXCELLENT) return SUB_MAX.ATR_STABILITY; // 10
  if (atrCv < RISK.ATR_CV_GOOD) return 7;
  if (atrCv < RISK.ATR_CV_FAIR) return 4;
  return 0;
}

/**
 * レンジ収縮度スコア（0-8）
 */
export function scoreRangeContraction(bbWidthPercentile: number | null): number {
  if (bbWidthPercentile == null) return 0;
  if (bbWidthPercentile < RISK.BB_SQUEEZE_STRONG) return SUB_MAX.RANGE_CONTRACTION; // 8
  if (bbWidthPercentile < RISK.BB_SQUEEZE_MODERATE) return 5;
  if (bbWidthPercentile < 60) return 3;
  return 0;
}

/**
 * 出来高安定性スコア（0-7）
 */
export function scoreVolumeStability(
  volumeMA5: number | null,
  volumeMA25: number | null,
  volumeCv: number | null,
): number {
  if (volumeMA5 == null || volumeMA25 == null || volumeCv == null) return 0;

  if (volumeCv > RISK.VOLUME_CV_MODERATE) return 0;

  const isIncreasing = volumeMA5 > volumeMA25;

  if (isIncreasing && volumeCv < RISK.VOLUME_CV_STABLE) return SUB_MAX.VOLUME_STABILITY; // 7
  if (isIncreasing && volumeCv <= RISK.VOLUME_CV_MODERATE) return 5;

  return 3;
}

/**
 * ATR14のCV（変動係数）を計算
 * @param atr14Values 直近20日分のATR14値（newest-first）
 */
export function calculateAtrCv(atr14Values: number[]): number | null {
  if (atr14Values.length < 20) return null;
  const window = atr14Values.slice(0, 20);
  const mean = window.reduce((a, b) => a + b, 0) / window.length;
  if (mean === 0) return null;
  const variance = window.reduce((sum, v) => sum + (v - mean) ** 2, 0) / window.length;
  return Math.sqrt(variance) / mean;
}

/**
 * 出来高のCVを計算
 * @param volumes 直近25日分の出来高（newest-first）
 */
export function calculateVolumeCv(volumes: number[]): number | null {
  const period = RISK.VOLUME_CV_PERIOD;
  if (volumes.length < period) return null;
  const window = volumes.slice(0, period);
  const mean = window.reduce((a, b) => a + b, 0) / window.length;
  if (mean === 0) return null;
  const variance = window.reduce((sum, v) => sum + (v - mean) ** 2, 0) / window.length;
  return Math.sqrt(variance) / mean;
}

/** リスク品質の入力 */
export interface RiskQualityInput {
  atrCv: number | null;
  bbWidthPercentile: number | null;
  volumeMA5: number | null;
  volumeMA25: number | null;
  volumeCv: number | null;
}

/**
 * リスク品質トータル（0-25）
 */
export function scoreRiskQuality(input: RiskQualityInput) {
  const atrStability = scoreAtrStability(input.atrCv);
  const rangeContraction = scoreRangeContraction(input.bbWidthPercentile);
  const volumeStability = scoreVolumeStability(
    input.volumeMA5, input.volumeMA25, input.volumeCv,
  );

  return {
    total: atrStability + rangeContraction + volumeStability,
    atrStability,
    rangeContraction,
    volumeStability,
  };
}
