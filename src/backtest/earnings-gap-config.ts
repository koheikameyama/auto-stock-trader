/**
 * 決算ギャップバックテスト設定 & パラメータグリッド
 */

import { EARNINGS_GAP } from "../lib/constants/earnings-gap";
import { STOP_LOSS, POSITION_SIZING } from "../lib/constants/scoring";
import { BREAK_EVEN_STOP, TRAILING_STOP, TIME_STOP, SCREENING } from "../lib/constants";
import { getMaxBuyablePrice } from "../core/risk-manager";
import type { EarningsGapBacktestConfig } from "./types";

/** デフォルト設定（gapupと同じイグジット・短期保有） */
export const EARNINGS_GAP_BACKTEST_DEFAULTS: Omit<EarningsGapBacktestConfig, "startDate" | "endDate"> = {
  initialBudget: 500_000,
  maxPositions: 3,

  // エントリー
  gapMinPct: EARNINGS_GAP.ENTRY.GAP_MIN_PCT,           // 0.03 (3%)
  volSurgeRatio: EARNINGS_GAP.ENTRY.VOL_SURGE_RATIO,   // 1.5

  // ストップロス
  atrMultiplier: EARNINGS_GAP.STOP_LOSS.ATR_MULTIPLIER, // 1.0
  maxLossPct: STOP_LOSS.MAX_LOSS_PCT,                   // 0.03

  // トレーリングストップ（gapupと同一）
  beActivationMultiplier: BREAK_EVEN_STOP.ACTIVATION_ATR_MULTIPLIER.gapup, // 0.5
  trailMultiplier: TRAILING_STOP.TRAIL_ATR_MULTIPLIER.gapup,               // 0.3

  // タイムストップ（gapupと同一: 3日/5日）
  maxHoldingDays: TIME_STOP.GAPUP_MAX_HOLDING_DAYS,                        // 3
  maxExtendedHoldingDays: TIME_STOP.GAPUP_MAX_EXTENDED_HOLDING_DAYS,       // 5

  // ユニバースフィルター
  maxPrice: getMaxBuyablePrice(500_000),
  minAvgVolume25: EARNINGS_GAP.ENTRY.MIN_AVG_VOLUME_25,
  minAtrPct: EARNINGS_GAP.ENTRY.MIN_ATR_PCT,
  minTurnover: SCREENING.MIN_TURNOVER,
  minPrice: SCREENING.MIN_PRICE,

  // コスト・リスク
  costModelEnabled: true,
  priceLimitEnabled: true,

  // クールダウン
  cooldownDays: 3,

  // マーケットフィルター
  marketTrendFilter: true,
  marketTrendThreshold: EARNINGS_GAP.MARKET_FILTER.BREADTH_THRESHOLD,
  indexTrendFilter: true,
  indexTrendSmaPeriod: 50,
  indexTrendOffBufferPct: 0,
  indexTrendOnBufferPct: 0,

  verbose: false,
  positionCapEnabled: true,
};

/** 1トレードあたりリスク（%） */
export const EARNINGS_GAP_RISK_PER_TRADE_PCT = POSITION_SIZING.RISK_PER_TRADE_PCT; // 2

/** walk-forward パラメータグリッド（エグジット系のみ、27通り） */
export const EARNINGS_GAP_PARAMETER_GRID = {
  atrMultiplier: [0.8, 1.0, 1.2],
  beActivationMultiplier: [0.3, 0.5, 0.8],
  trailMultiplier: [0.3, 0.5, 0.8],
} as const;

/** パラメータグリッドの全組み合わせを生成 */
export function generateEarningsGapParameterCombinations(): Array<Partial<EarningsGapBacktestConfig>> {
  const combos: Array<Partial<EarningsGapBacktestConfig>> = [];

  for (const atrMultiplier of EARNINGS_GAP_PARAMETER_GRID.atrMultiplier) {
    for (const beActivationMultiplier of EARNINGS_GAP_PARAMETER_GRID.beActivationMultiplier) {
      for (const trailMultiplier of EARNINGS_GAP_PARAMETER_GRID.trailMultiplier) {
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
