/**
 * 高騰後押し目バックテスト設定 & パラメータグリッド
 */

import { POST_SURGE_CONSOLIDATION } from "../lib/constants/post-surge-consolidation";
import { STOP_LOSS, POSITION_SIZING } from "../lib/constants/scoring";
import { BREAK_EVEN_STOP, TRAILING_STOP, SCREENING, MARKET_BREADTH } from "../lib/constants";
import { getMaxBuyablePrice } from "../core/risk-manager";
import type { PostSurgeConsolidationBacktestConfig } from "./types";

/** デフォルト設定 */
export const PSC_BACKTEST_DEFAULTS: Omit<PostSurgeConsolidationBacktestConfig, "startDate" | "endDate"> = {
  initialBudget: 500_000,
  maxPositions: 3,

  momentumMinReturn: POST_SURGE_CONSOLIDATION.ENTRY.MOMENTUM_MIN_RETURN,
  maxHighDistancePct: POST_SURGE_CONSOLIDATION.ENTRY.MAX_HIGH_DISTANCE_PCT,
  volSurgeRatio: POST_SURGE_CONSOLIDATION.ENTRY.VOL_SURGE_RATIO,

  atrMultiplier: POST_SURGE_CONSOLIDATION.STOP_LOSS.ATR_MULTIPLIER,
  maxLossPct: STOP_LOSS.MAX_LOSS_PCT,

  beActivationMultiplier: BREAK_EVEN_STOP.ACTIVATION_ATR_MULTIPLIER["post-surge-consolidation"],
  trailMultiplier: TRAILING_STOP.TRAIL_ATR_MULTIPLIER["post-surge-consolidation"],

  maxHoldingDays: POST_SURGE_CONSOLIDATION.TIME_STOP.MAX_HOLDING_DAYS,
  maxExtendedHoldingDays: POST_SURGE_CONSOLIDATION.TIME_STOP.MAX_EXTENDED_HOLDING_DAYS,

  maxPrice: getMaxBuyablePrice(500_000),
  minAvgVolume25: POST_SURGE_CONSOLIDATION.ENTRY.MIN_AVG_VOLUME_25,
  minAtrPct: POST_SURGE_CONSOLIDATION.ENTRY.MIN_ATR_PCT,
  minTurnover: SCREENING.MIN_TURNOVER,
  minPrice: SCREENING.MIN_PRICE,

  costModelEnabled: true,
  priceLimitEnabled: true,

  cooldownDays: 3,

  marketTrendFilter: true,
  marketTrendThreshold: MARKET_BREADTH.THRESHOLD,
  indexTrendFilter: true,
  indexTrendSmaPeriod: 50,
  indexTrendOffBufferPct: 0,
  indexTrendOnBufferPct: 0,

  verbose: false,
  positionCapEnabled: true,
};

/** 1トレードあたりリスク（%） */
export const PSC_RISK_PER_TRADE_PCT = POSITION_SIZING.RISK_PER_TRADE_PCT;

/** walk-forward パラメータグリッド（27通り、エグジット系のみ） */
export const PSC_PARAMETER_GRID = {
  atrMultiplier: [0.8, 1.0, 1.2],
  beActivationMultiplier: [0.3, 0.5, 0.8],
  trailMultiplier: [0.5, 0.8, 1.0],
} as const;

/** パラメータグリッドの全組み合わせを生成 */
export function generatePSCParameterCombinations(): Array<Partial<PostSurgeConsolidationBacktestConfig>> {
  const combos: Array<Partial<PostSurgeConsolidationBacktestConfig>> = [];

  for (const atrMultiplier of PSC_PARAMETER_GRID.atrMultiplier) {
    for (const beActivationMultiplier of PSC_PARAMETER_GRID.beActivationMultiplier) {
      for (const trailMultiplier of PSC_PARAMETER_GRID.trailMultiplier) {
        combos.push({ atrMultiplier, beActivationMultiplier, trailMultiplier });
      }
    }
  }

  return combos;
}
