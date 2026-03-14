import { SCORING } from "../../lib/constants/scoring";
import type { OHLCVData } from "../technical-analysis";

const { SUB_MAX, TREND } = SCORING;

/**
 * MA配列スコア（0-18）
 * close, SMA5, SMA25, SMA75 の位置関係を評価
 */
export function scoreMaAlignment(
  close: number,
  sma5: number | null,
  sma25: number | null,
  sma75: number | null,
): number {
  if (sma25 == null || sma5 == null) return 0;

  // SMA25下 → 0
  if (close < sma25) return 0;

  // SMA75なし → SMA25のみで判定（最大14点）
  if (sma75 == null) {
    if (close > sma5 && sma5 > sma25) return 14;
    if (close > sma25 && close < sma5) return 8;
    return 4;
  }

  // 完全パーフェクトオーダー
  if (close > sma5 && sma5 > sma25 && sma25 > sma75) return SUB_MAX.MA_ALIGNMENT; // 18
  // 短中期揃い、SMA75下
  if (close > sma5 && sma5 > sma25) return 14;
  // SMA5割れ（押し目）
  if (close > sma25 && close < sma5) return 8;
  // SMA25上だが配列崩れ
  return 4;
}

/**
 * 週足トレンド確認（0-12）
 * @param weeklyClose 最新週足終値
 * @param weeklySma13 今週のSMA13
 * @param prevWeeklySma13 前週のSMA13
 */
export function scoreWeeklyTrend(
  weeklyClose: number,
  weeklySma13: number | null,
  prevWeeklySma13: number | null,
): number {
  if (weeklySma13 == null || prevWeeklySma13 == null) return 0;

  const aboveSma = weeklyClose > weeklySma13;
  const changeRate = ((weeklySma13 - prevWeeklySma13) / prevWeeklySma13) * 100;
  const isRising = changeRate > TREND.WEEKLY_SMA13_FLAT_THRESHOLD;
  const isFlat = Math.abs(changeRate) <= TREND.WEEKLY_SMA13_FLAT_THRESHOLD;

  if (aboveSma && isRising) return SUB_MAX.WEEKLY_TREND; // 12
  if (aboveSma && isFlat) return 8;
  if (!aboveSma && isRising) return 4;
  return 0; // 下 & 下向き or 横ばい
}

/**
 * SMA25上の連続日数をカウント
 * @param data OHLCVデータ（newest-first）
 */
export function countDaysAboveSma25(data: OHLCVData[]): number {
  if (data.length < 25) return 0;

  const closes = data.map((d) => d.close);
  let count = 0;

  for (let i = 0; i < closes.length - 24; i++) {
    const window = closes.slice(i, i + 25);
    const sma25 = window.reduce((a, b) => a + b, 0) / 25;
    if (closes[i] > sma25) {
      count++;
    } else {
      break;
    }
  }

  return count;
}

/**
 * トレンド継続性スコア（0-10）
 */
export function scoreTrendContinuity(daysAboveSma25: number): number {
  if (daysAboveSma25 <= 0) return 0;
  if (daysAboveSma25 >= TREND.CONTINUITY_SWEET_MIN && daysAboveSma25 <= TREND.CONTINUITY_SWEET_MAX) return SUB_MAX.TREND_CONTINUITY; // 10
  if (daysAboveSma25 < TREND.CONTINUITY_SWEET_MIN) return 7;
  if (daysAboveSma25 <= TREND.CONTINUITY_MATURE_MAX) return 5;
  return 2; // 50日超
}

/** トレンド品質の入力 */
export interface TrendQualityInput {
  close: number;
  sma5: number | null;
  sma25: number | null;
  sma75: number | null;
  weeklyClose: number | null;
  weeklySma13: number | null;
  prevWeeklySma13: number | null;
  daysAboveSma25: number;
}

/**
 * トレンド品質トータル（0-40）
 */
export function scoreTrendQuality(input: TrendQualityInput) {
  const maAlignment = scoreMaAlignment(input.close, input.sma5, input.sma25, input.sma75);
  const weeklyTrend = scoreWeeklyTrend(
    input.weeklyClose ?? input.close,
    input.weeklySma13,
    input.prevWeeklySma13,
  );
  const trendContinuity = scoreTrendContinuity(input.daysAboveSma25);

  return {
    total: maAlignment + weeklyTrend + trendContinuity,
    maAlignment,
    weeklyTrend,
    trendContinuity,
  };
}
