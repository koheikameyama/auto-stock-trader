/**
 * 米株 ETF (1547, 1545) シグナル事前計算
 *
 * combined BT で 6戦略目として動かすため、日次シグナルを Map<date, USEtfSignal[]> に
 * precompute する。standalone simulation は scripts/_us-etf-backtest-mvp.ts で
 * 検証済みのため、ここでは precompute のみ提供する。
 */

import dayjs from "dayjs";
import type { OHLCVData } from "../core/technical-analysis";
import type { USEtfBacktestConfig } from "./us-etf-config";

export interface USEtfSignal {
  ticker: string;
  /** シグナル発火日 (= エントリー日)。終値でエントリー */
  date: string;
  /** エントリー価格 (= signal day close) */
  entryPrice: number;
  /** SL価格 (= entryPrice * (1 - slPct))、precompute時に算出 */
  stopLossPrice: number;
  /** 当日 gap% */
  gap: number;
  /** 当日 vol surge 倍率 */
  volumeSurgeRatio: number;
  /** 発火時の日本株 breadth (前日値) */
  breadthAtEntry: number;
}

export type PrecomputedUSEtfSignals = Map<string, USEtfSignal[]>;

/**
 * 米株ETFの全期間シグナルを precompute する。
 *
 * @param etfData ETF ticker -> OHLCV[] (date昇順)
 * @param dailyBreadth date -> japan breadth (0.0-1.0)
 * @param config USEtfBacktestConfig
 */
export function precomputeUSEtfSignals(
  etfData: Map<string, OHLCVData[]>,
  dailyBreadth: Map<string, number>,
  config: USEtfBacktestConfig,
): PrecomputedUSEtfSignals {
  const result: PrecomputedUSEtfSignals = new Map();

  for (const ticker of config.tickers) {
    const bars = etfData.get(ticker);
    if (!bars || bars.length < config.volumeLookbackDays + 2) continue;

    for (let i = config.volumeLookbackDays; i < bars.length; i++) {
      const today = bars[i];
      const prev = bars[i - 1];
      const todayDate = dayjs(today.date).format("YYYY-MM-DD");
      const prevDate = dayjs(prev.date).format("YYYY-MM-DD");

      const gap = (today.open - prev.close) / prev.close;
      if (gap < config.gapMinPct) continue;

      const isUpDay = today.close > today.open;
      if (!isUpDay) continue;

      let volSum = 0;
      for (let j = i - config.volumeLookbackDays; j < i; j++) {
        volSum += bars[j].volume;
      }
      const avgVol = volSum / config.volumeLookbackDays;
      if (avgVol <= 0) continue;
      const volSurge = today.volume / avgVol;
      if (volSurge < config.volumeSurgeRatio) continue;

      // 前日の日本株 breadth が idle帯 (< 0.54) であること
      const breadthPrev = dailyBreadth.get(prevDate);
      if (breadthPrev == null || breadthPrev >= config.breadthMax) continue;

      const entryPrice = today.close;
      const stopLossPrice = entryPrice * (1 - config.slPct);

      const signal: USEtfSignal = {
        ticker,
        date: todayDate,
        entryPrice,
        stopLossPrice,
        gap,
        volumeSurgeRatio: volSurge,
        breadthAtEntry: breadthPrev,
      };

      const arr = result.get(todayDate) ?? [];
      arr.push(signal);
      result.set(todayDate, arr);
    }
  }

  return result;
}
