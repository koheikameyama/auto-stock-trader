/**
 * 週足レンジブレイクのエントリー条件
 *
 * 週足終値がN週高値を上抜け + 週足出来高サージで判定。
 */

import type { WeeklyBar } from "../../lib/technical-indicators";

export interface WeeklyBreakSignalResult {
  isBreak: boolean;
  weeklyHigh: number;
  weeklyClose: number;
  weeklyVolSurge: number;
}

/**
 * 最新の週足バーがN週高値を上抜けたか判定する。
 *
 * @param weeklyBars - 週足データ（oldest-first）、少なくとも highLookbackWeeks+1 本必要
 * @param highLookbackWeeks - 高値ルックバック週数
 * @param volSurgeRatio - 出来高サージ閾値
 */
export function isWeeklyBreakSignal(
  weeklyBars: WeeklyBar[],
  highLookbackWeeks: number,
  volSurgeRatio: number,
): WeeklyBreakSignalResult {
  const noBreak: WeeklyBreakSignalResult = { isBreak: false, weeklyHigh: 0, weeklyClose: 0, weeklyVolSurge: 0 };
  const len = weeklyBars.length;
  if (len < highLookbackWeeks + 1) return noBreak;

  const currentWeek = weeklyBars[len - 1];
  const lookbackBars = weeklyBars.slice(len - 1 - highLookbackWeeks, len - 1);

  // N週高値（当週を除く）
  const weeklyHigh = Math.max(...lookbackBars.map((b) => b.high));

  // 週足出来高平均
  const avgWeeklyVol = lookbackBars.reduce((s, b) => s + b.volume, 0) / lookbackBars.length;
  const weeklyVolSurge = avgWeeklyVol > 0 ? currentWeek.volume / avgWeeklyVol : 0;

  const isBreak = currentWeek.close > weeklyHigh && weeklyVolSurge >= volSurgeRatio;

  return { isBreak, weeklyHigh, weeklyClose: currentWeek.close, weeklyVolSurge };
}
