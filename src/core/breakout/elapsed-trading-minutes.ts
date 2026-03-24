import { BREAKOUT } from "../../lib/constants/breakout";

const MORNING_START_H = 9,
  MORNING_START_M = 0;
const MORNING_END_H = 11,
  MORNING_END_M = 30;
const AFTERNOON_START_H = 12,
  AFTERNOON_START_M = 30;
const MORNING_MINUTES = 150;

/**
 * 市場開場（9:00 JST）からの経過取引分数を計算
 * 昼休み（11:30-12:30）を考慮
 *
 * 前場: 9:00-11:30 (150分)
 * 昼休み: 11:30-12:30
 * 後場: 12:30-15:00 (150分)
 * 合計: 300分
 *
 * @param hour - 時刻（0-23）
 * @param minute - 分（0-59）
 * @returns 経過取引分数（0-300）
 */
export function getElapsedTradingMinutes(hour: number, minute: number): number {
  const t = hour * 60 + minute;
  const morningStart = MORNING_START_H * 60 + MORNING_START_M;
  const morningEnd = MORNING_END_H * 60 + MORNING_END_M;
  const afternoonStart = AFTERNOON_START_H * 60 + AFTERNOON_START_M;

  if (t < morningStart) return 0;
  if (t <= morningEnd) return t - morningStart;
  if (t < afternoonStart) return MORNING_MINUTES;
  return MORNING_MINUTES + Math.min(t - afternoonStart, MORNING_MINUTES);
}

/**
 * 1営業日の進捗率（0.0-1.0）を計算
 *
 * @param hour - 時刻（0-23）
 * @param minute - 分（0-59）
 * @returns 進捗率（0.0-1.0）
 */
export function getElapsedFraction(hour: number, minute: number): number {
  return getElapsedTradingMinutes(hour, minute) / BREAKOUT.TRADING_MINUTES_PER_DAY;
}
