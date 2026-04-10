/**
 * モメンタムバックテスト設定 & パラメータグリッド
 */

import { MOMENTUM } from "../lib/constants/momentum";
import { STOP_LOSS, POSITION_SIZING } from "../lib/constants/scoring";
import { SCREENING } from "../lib/constants";
import { getMaxBuyablePrice } from "../core/risk-manager";
import type { MomentumBacktestConfig } from "./types";

/** デフォルト設定 */
export const MOMENTUM_BACKTEST_DEFAULTS: Omit<MomentumBacktestConfig, "startDate" | "endDate"> = {
  initialBudget: 500_000,
  maxPositions: 3,

  // エントリー
  lookbackDays: MOMENTUM.ENTRY.LOOKBACK_DAYS,      // 60
  topN: MOMENTUM.ENTRY.TOP_N,                       // 3
  rebalanceDays: MOMENTUM.ENTRY.REBALANCE_DAYS,    // 20
  minReturnPct: MOMENTUM.ENTRY.MIN_RETURN_PCT,      // 5

  // ストップロス（長期保有のため広め）
  atrMultiplier: MOMENTUM.STOP_LOSS.ATR_MULTIPLIER, // 1.5
  maxLossPct: STOP_LOSS.MAX_LOSS_PCT,                // 0.03

  // トレーリングストップ
  beActivationMultiplier: 1.0,
  trailMultiplier: 1.0,

  // タイムストップ（リバランスが主決済手段なので長め）
  maxHoldingDays: 30,
  maxExtendedHoldingDays: 40,

  // ユニバースフィルター
  maxPrice: getMaxBuyablePrice(500_000),
  minAvgVolume25: MOMENTUM.ENTRY.MIN_AVG_VOLUME_25,
  minAtrPct: MOMENTUM.ENTRY.MIN_ATR_PCT,
  minTurnover: SCREENING.MIN_TURNOVER,
  minPrice: SCREENING.MIN_PRICE,

  // コスト・リスク
  costModelEnabled: true,
  priceLimitEnabled: true,

  // クールダウン
  cooldownDays: 0, // リバランス駆動なのでクールダウン不要

  // マーケットフィルター
  marketTrendFilter: true,
  marketTrendThreshold: MOMENTUM.MARKET_FILTER.BREADTH_THRESHOLD,
  indexTrendFilter: false,
  indexTrendSmaPeriod: 50,
  indexTrendOffBufferPct: 0,
  indexTrendOnBufferPct: 0,

  verbose: false,
  positionCapEnabled: true,
};

/** 1トレードあたりリスク（%） */
export const MOMENTUM_RISK_PER_TRADE_PCT = POSITION_SIZING.RISK_PER_TRADE_PCT; // 2

/** walk-forward パラメータグリッド（エグジット系のみ、27通り） */
export const MOMENTUM_PARAMETER_GRID = {
  atrMultiplier: [1.0, 1.5, 2.0],
  beActivationMultiplier: [0.5, 1.0, 1.5],
  trailMultiplier: [0.8, 1.0, 1.5],
} as const;

/** パラメータグリッドの全組み合わせを生成 */
export function generateMomentumParameterCombinations(): Array<Partial<MomentumBacktestConfig>> {
  const combos: Array<Partial<MomentumBacktestConfig>> = [];

  for (const atrMultiplier of MOMENTUM_PARAMETER_GRID.atrMultiplier) {
    for (const beActivationMultiplier of MOMENTUM_PARAMETER_GRID.beActivationMultiplier) {
      for (const trailMultiplier of MOMENTUM_PARAMETER_GRID.trailMultiplier) {
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
