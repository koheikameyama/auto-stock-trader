/**
 * ブレイクアウトバックテスト設定 & パラメータグリッド
 */

import { BREAKOUT } from "../lib/constants/breakout";
import { STOP_LOSS, POSITION_SIZING } from "../lib/constants/scoring";
import { BREAK_EVEN_STOP, TRAILING_STOP, TIME_STOP } from "../lib/constants";
import type { BreakoutBacktestConfig } from "./types";

/** デフォルト設定（本番パラメータと同一） */
export const BREAKOUT_BACKTEST_DEFAULTS: Omit<BreakoutBacktestConfig, "startDate" | "endDate"> = {
  initialBudget: 500_000,
  maxPositions: 3,

  // エントリー
  triggerThreshold: BREAKOUT.VOLUME_SURGE.TRIGGER_THRESHOLD, // 2.0
  highLookbackDays: BREAKOUT.PRICE.HIGH_LOOKBACK_DAYS,       // 20
  maxChaseAtr: BREAKOUT.PRICE.MAX_CHASE_ATR,                  // 1.0

  // ストップロス
  atrMultiplier: BREAKOUT.STOP_LOSS.ATR_MULTIPLIER,          // 1.0
  maxLossPct: STOP_LOSS.MAX_LOSS_PCT,                         // 0.03

  // トレーリングストップ
  beActivationMultiplier: BREAK_EVEN_STOP.ACTIVATION_ATR_MULTIPLIER.swing, // 1.5
  tsActivationMultiplier: TRAILING_STOP.ACTIVATION_ATR_MULTIPLIER.swing,   // 2.5
  trailMultiplier: TRAILING_STOP.TRAIL_ATR_MULTIPLIER.swing,               // 1.5

  // タイムストップ
  maxHoldingDays: TIME_STOP.MAX_HOLDING_DAYS,                  // 5
  maxExtendedHoldingDays: TIME_STOP.MAX_EXTENDED_HOLDING_DAYS, // 10

  // ユニバースフィルター
  maxPrice: 5000,
  minAvgVolume25: 50_000,
  minAtrPct: 1.5,

  // コスト・リスク
  costModelEnabled: true,
  priceLimitEnabled: true,

  // クールダウン
  cooldownDays: 3,

  verbose: false,
};

/** 1トレードあたりリスク（%） */
export const RISK_PER_TRADE_PCT = POSITION_SIZING.RISK_PER_TRADE_PCT; // 2

/** walk-forward パラメータグリッド */
export const PARAMETER_GRID = {
  triggerThreshold: [1.5, 1.8, 2.0, 2.5, 3.0],
  highLookbackDays: [10, 15, 20, 30],
  atrMultiplier: [0.8, 1.0, 1.2, 1.5],
  beActivationMultiplier: [0.8, 1.0, 1.5],
  trailMultiplier: [0.8, 1.0, 1.5],
  tsActivationMultiplier: [1.5, 2.0, 2.5],
  maxChaseAtr: [0.5, 1.0, 1.5, 2.0],
} as const;

export type ParameterKey = keyof typeof PARAMETER_GRID;

/** パラメータグリッドの全組み合わせを生成 */
export function generateParameterCombinations(): Array<Partial<BreakoutBacktestConfig>> {
  const combos: Array<Partial<BreakoutBacktestConfig>> = [];

  for (const triggerThreshold of PARAMETER_GRID.triggerThreshold) {
    for (const highLookbackDays of PARAMETER_GRID.highLookbackDays) {
      for (const atrMultiplier of PARAMETER_GRID.atrMultiplier) {
        for (const beActivationMultiplier of PARAMETER_GRID.beActivationMultiplier) {
          for (const trailMultiplier of PARAMETER_GRID.trailMultiplier) {
            for (const tsActivationMultiplier of PARAMETER_GRID.tsActivationMultiplier) {
              for (const maxChaseAtr of PARAMETER_GRID.maxChaseAtr) {
                combos.push({
                  triggerThreshold,
                  highLookbackDays,
                  atrMultiplier,
                  beActivationMultiplier,
                  trailMultiplier,
                  tsActivationMultiplier,
                  maxChaseAtr,
                });
              }
            }
          }
        }
      }
    }
  }

  return combos;
}
