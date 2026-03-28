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
  maxChaseAtr: 0.5,                                            // 高値追い抑制（元: 1.0）

  // ストップロス
  atrMultiplier: BREAKOUT.STOP_LOSS.ATR_MULTIPLIER,          // 1.0
  maxLossPct: STOP_LOSS.MAX_LOSS_PCT,                         // 0.03

  // トレーリングストップ
  beActivationMultiplier: BREAK_EVEN_STOP.ACTIVATION_ATR_MULTIPLIER.swing, // 1.5
  tsActivationMultiplier: TRAILING_STOP.ACTIVATION_ATR_MULTIPLIER.swing,   // 2.5
  trailMultiplier: TRAILING_STOP.TRAIL_ATR_MULTIPLIER.swing,               // 1.5

  // タイムストップ
  maxHoldingDays: 7,                                            // 利益伸長（元: 5）
  maxExtendedHoldingDays: TIME_STOP.MAX_EXTENDED_HOLDING_DAYS, // 10

  // ユニバースフィルター
  maxPrice: 5000,
  minAvgVolume25: 100_000,
  minAtrPct: 1.5,

  // コスト・リスク
  costModelEnabled: true,
  priceLimitEnabled: true,

  // クールダウン
  cooldownDays: 3,

  // エントリーフィルター
  marketTrendFilter: true,
  marketTrendThreshold: 0.73, // breadth 73%以上の強い上昇相場のみエントリー
  confirmationEntry: true,
  indexTrendFilter: true,
  indexTrendSmaPeriod: 50, // N225がSMA50以上の時のみエントリー
  indexMomentumFilter: false,
  indexMomentumDays: 60,
  minBreakoutAtr: 0,
  volumeTrendThreshold: 1.0,

  verbose: false,
};

/** 1トレードあたりリスク（%） */
export const RISK_PER_TRADE_PCT = POSITION_SIZING.RISK_PER_TRADE_PCT; // 2

/** walk-forward パラメータグリッド（エグジット系のみ、81通り） */
export const PARAMETER_GRID = {
  atrMultiplier: [0.8, 1.0, 1.2],
  beActivationMultiplier: [0.3, 0.5, 0.8],
  trailMultiplier: [0.3, 0.5, 0.8],
  tsActivationMultiplier: [1.0, 1.5, 2.0],
} as const;

export type ParameterKey = keyof typeof PARAMETER_GRID;

/** パラメータグリッドの全組み合わせを生成 */
export function generateParameterCombinations(): Array<Partial<BreakoutBacktestConfig>> {
  const combos: Array<Partial<BreakoutBacktestConfig>> = [];

  for (const atrMultiplier of PARAMETER_GRID.atrMultiplier) {
    for (const beActivationMultiplier of PARAMETER_GRID.beActivationMultiplier) {
      for (const trailMultiplier of PARAMETER_GRID.trailMultiplier) {
        for (const tsActivationMultiplier of PARAMETER_GRID.tsActivationMultiplier) {
          combos.push({
            atrMultiplier,
            beActivationMultiplier,
            trailMultiplier,
            tsActivationMultiplier,
          });
        }
      }
    }
  }

  return combos;
}
