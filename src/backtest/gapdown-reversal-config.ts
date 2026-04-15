/**
 * ギャップダウンリバーサルバックテスト設定 & パラメータグリッド
 */

import { GAPDOWN_REVERSAL } from "../lib/constants/gapdown-reversal";
import { STOP_LOSS, POSITION_SIZING } from "../lib/constants/scoring";
import { BREAK_EVEN_STOP, TRAILING_STOP, SCREENING } from "../lib/constants";
import { getMaxBuyablePrice } from "../core/risk-manager";
import type { GapDownReversalBacktestConfig } from "./types";

/** デフォルト設定 */
export const GAPDOWN_REVERSAL_BACKTEST_DEFAULTS: Omit<GapDownReversalBacktestConfig, "startDate" | "endDate"> = {
  initialBudget: 500_000,
  maxPositions: 3,

  gapMinPct: GAPDOWN_REVERSAL.ENTRY.GAP_MIN_PCT,
  volSurgeRatio: GAPDOWN_REVERSAL.ENTRY.VOL_SURGE_RATIO,

  atrMultiplier: GAPDOWN_REVERSAL.STOP_LOSS.ATR_MULTIPLIER,
  maxLossPct: STOP_LOSS.MAX_LOSS_PCT,

  beActivationMultiplier: BREAK_EVEN_STOP.ACTIVATION_ATR_MULTIPLIER["gapdown-reversal"],
  trailMultiplier: TRAILING_STOP.TRAIL_ATR_MULTIPLIER["gapdown-reversal"],

  maxHoldingDays: GAPDOWN_REVERSAL.TIME_STOP.MAX_HOLDING_DAYS,
  maxExtendedHoldingDays: GAPDOWN_REVERSAL.TIME_STOP.MAX_EXTENDED_HOLDING_DAYS,

  maxPrice: getMaxBuyablePrice(500_000),
  minAvgVolume25: GAPDOWN_REVERSAL.ENTRY.MIN_AVG_VOLUME_25,
  minAtrPct: GAPDOWN_REVERSAL.ENTRY.MIN_ATR_PCT,
  minTurnover: SCREENING.MIN_TURNOVER,
  minPrice: SCREENING.MIN_PRICE,

  costModelEnabled: true,
  priceLimitEnabled: true,

  cooldownDays: 3,

  indexTrendFilter: true,
  indexTrendSmaPeriod: 50,
  indexTrendOffBufferPct: 0,
  indexTrendOnBufferPct: 0,

  verbose: false,
  positionCapEnabled: true,
};

/** 1トレードあたりリスク（%） */
export const GAPDOWN_REVERSAL_RISK_PER_TRADE_PCT = POSITION_SIZING.RISK_PER_TRADE_PCT;

/** walk-forward パラメータグリッド（27通り、エグジット系のみ） */
export const GAPDOWN_REVERSAL_PARAMETER_GRID = {
  atrMultiplier: [0.8, 1.0, 1.2],
  beActivationMultiplier: [0.3, 0.5, 0.8],
  trailMultiplier: [0.3, 0.5, 0.8],
} as const;

/** パラメータグリッドの全組み合わせを生成 */
export function generateGapDownReversalParameterCombinations(): Array<Partial<GapDownReversalBacktestConfig>> {
  const combos: Array<Partial<GapDownReversalBacktestConfig>> = [];

  for (const atrMultiplier of GAPDOWN_REVERSAL_PARAMETER_GRID.atrMultiplier) {
    for (const beActivationMultiplier of GAPDOWN_REVERSAL_PARAMETER_GRID.beActivationMultiplier) {
      for (const trailMultiplier of GAPDOWN_REVERSAL_PARAMETER_GRID.trailMultiplier) {
        combos.push({ atrMultiplier, beActivationMultiplier, trailMultiplier });
      }
    }
  }

  return combos;
}
