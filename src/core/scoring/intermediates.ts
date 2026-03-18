/**
 * スコアリング中間計算の共通ヘルパー
 *
 * scoreStock()（エントリー用）と scoreHolding()（保有継続用）が共有する
 * 中間値の計算をまとめる。
 */

import { ATR } from "technicalindicators";
import {
  calculateSMA,
  aggregateDailyToWeekly,
} from "../../lib/technical-indicators";
import { calculateBBWidthPercentile } from "../../lib/technical-indicators/bb-width-history";
import { SCORING } from "../../lib/constants/scoring";
import { countDaysAboveSma25 } from "./trend-quality";
import { calculateAtrCv, calculateVolumeCv } from "./risk-quality";
import type { ScoringInput } from "./types";

type OHLCVData = ScoringInput["historicalData"][0];

/** 中間計算結果 */
export interface ScoringIntermediates {
  weeklyClose: number | null;
  weeklySma13: number | null;
  prevWeeklySma13: number | null;
  daysAboveSma25: number;
  atr14Values: number[];
  atrCv: number | null;
  volumeCv: number | null;
  volumeMA5: number | null;
  volumeMA25: number | null;
  bbWidthPercentile: number | null;
}

/**
 * スコアリングに必要な中間値を一括計算
 */
export function computeScoringIntermediates(
  historicalData: OHLCVData[],
): ScoringIntermediates {
  // 週足データ合成
  const dailyOldestFirst = [...historicalData].reverse();
  const weeklyBars = aggregateDailyToWeekly(dailyOldestFirst);

  let weeklyClose: number | null = null;
  let weeklySma13: number | null = null;
  let prevWeeklySma13: number | null = null;

  if (weeklyBars.length >= 14) {
    const weeklyNewestFirst = [...weeklyBars]
      .reverse()
      .map((b) => ({ close: b.close }));
    weeklySma13 = calculateSMA(weeklyNewestFirst, 13);
    weeklyClose = weeklyNewestFirst[0].close;

    if (weeklyNewestFirst.length >= 14) {
      prevWeeklySma13 = calculateSMA(weeklyNewestFirst.slice(1), 13);
    }
  }

  // SMA25上の連続日数
  const daysAboveSma25 = countDaysAboveSma25(historicalData);

  // ATR14のCV
  const atr14Values = computeAtr14Series(historicalData);
  const atrCv = calculateAtrCv(atr14Values);

  // 出来高CV
  const volumes = historicalData.map((d) => d.volume);
  const volumeCv = calculateVolumeCv(volumes);

  // 出来高MA
  const volumeNewestFirst = historicalData.map((d) => ({ close: d.volume }));
  const volumeMA5 = calculateSMA(volumeNewestFirst, 5);
  const volumeMA25 = calculateSMA(volumeNewestFirst, 25);

  // BB幅パーセンタイル
  const closePrices = historicalData.map((d) => d.close);
  const bbWidthPercentile = calculateBBWidthPercentile(
    closePrices,
    20,
    SCORING.RISK.BB_WIDTH_LOOKBACK,
  );

  return {
    weeklyClose,
    weeklySma13,
    prevWeeklySma13,
    daysAboveSma25,
    atr14Values,
    atrCv,
    volumeCv,
    volumeMA5,
    volumeMA25,
    bbWidthPercentile,
  };
}

/**
 * ATR(14)の直近20日分の時系列を計算
 * @param data OHLCVデータ（newest-first）
 * @returns ATR14値の配列（newest-first）
 */
export function computeAtr14Series(data: OHLCVData[]): number[] {
  if (data.length < 34) return []; // 14(ATR期間) + 20(CV計算) = 34

  const reversed = [...data].reverse();
  const result = ATR.calculate({
    high: reversed.map((d) => d.high),
    low: reversed.map((d) => d.low),
    close: reversed.map((d) => d.close),
    period: 14,
  });

  // oldest-first → newest-first
  return [...result].reverse();
}
