/**
 * 週足レンジブレイクバックテスト設定 & パラメータグリッド
 */

import { WEEKLY_BREAK } from "../lib/constants/weekly-break";
import { STOP_LOSS, POSITION_SIZING } from "../lib/constants/scoring";
import { SCREENING } from "../lib/constants";
import { getMaxBuyablePrice } from "../core/risk-manager";
import type { WeeklyBreakBacktestConfig } from "./types";

/** デフォルト設定 */
export const WEEKLY_BREAK_BACKTEST_DEFAULTS: Omit<WeeklyBreakBacktestConfig, "startDate" | "endDate"> = {
  initialBudget: 500_000,
  maxPositions: 3,

  // エントリー
  weeklyHighLookback: WEEKLY_BREAK.ENTRY.HIGH_LOOKBACK_WEEKS, // 13
  weeklyVolSurgeRatio: WEEKLY_BREAK.ENTRY.VOL_SURGE_RATIO,    // 1.3

  // ストップロス（週足は広め）
  atrMultiplier: WEEKLY_BREAK.STOP_LOSS.ATR_MULTIPLIER, // 1.5
  maxLossPct: STOP_LOSS.MAX_LOSS_PCT,                    // 0.03

  // トレーリングストップ
  beActivationMultiplier: 0.8,
  trailMultiplier: 1.0,

  // タイムストップ（週足は長め）
  maxHoldingDays: 15,
  maxExtendedHoldingDays: 25,

  // ユニバースフィルター
  maxPrice: getMaxBuyablePrice(500_000),
  minAvgVolume25: WEEKLY_BREAK.ENTRY.MIN_AVG_VOLUME_25,
  minAtrPct: WEEKLY_BREAK.ENTRY.MIN_ATR_PCT,
  minTurnover: SCREENING.MIN_TURNOVER,
  minPrice: SCREENING.MIN_PRICE,

  // コスト・リスク
  costModelEnabled: true,
  priceLimitEnabled: true,

  // クールダウン
  cooldownDays: 5,

  // マーケットフィルター
  marketTrendFilter: true,
  marketTrendThreshold: WEEKLY_BREAK.MARKET_FILTER.BREADTH_THRESHOLD,
  indexTrendFilter: true,
  indexTrendSmaPeriod: 50,
  indexTrendOffBufferPct: 0,
  indexTrendOnBufferPct: 0,

  verbose: false,
  positionCapEnabled: true,
};

/** 1トレードあたりリスク（%） */
export const WEEKLY_BREAK_RISK_PER_TRADE_PCT = POSITION_SIZING.RISK_PER_TRADE_PCT; // 2

/** walk-forward パラメータグリッド（エグジット系のみ、27通り） */
export const WEEKLY_BREAK_PARAMETER_GRID = {
  atrMultiplier: [1.0, 1.5, 2.0],
  beActivationMultiplier: [0.5, 0.8, 1.2],
  trailMultiplier: [0.8, 1.0, 1.5],
} as const;

/** パラメータグリッドの全組み合わせを生成 */
export function generateWeeklyBreakParameterCombinations(): Array<Partial<WeeklyBreakBacktestConfig>> {
  const combos: Array<Partial<WeeklyBreakBacktestConfig>> = [];

  for (const atrMultiplier of WEEKLY_BREAK_PARAMETER_GRID.atrMultiplier) {
    for (const beActivationMultiplier of WEEKLY_BREAK_PARAMETER_GRID.beActivationMultiplier) {
      for (const trailMultiplier of WEEKLY_BREAK_PARAMETER_GRID.trailMultiplier) {
        combos.push({
          atrMultiplier,
          beActivationMultiplier,
          trailMultiplier,
        });
      }
    }
  }

  return combos;
}
