/**
 * スクイーズブレイクアウト バックテスト設定 & パラメータグリッド
 */

import { SQUEEZE_BREAKOUT } from "../lib/constants/squeeze-breakout";
import { STOP_LOSS, POSITION_SIZING } from "../lib/constants/scoring";
import { SCREENING } from "../lib/constants";
import { getMaxBuyablePrice } from "../core/risk-manager";
import type { SqueezeBreakoutBacktestConfig } from "./types";

/** デフォルト設定 */
export const SQUEEZE_BREAKOUT_BACKTEST_DEFAULTS: Omit<SqueezeBreakoutBacktestConfig, "startDate" | "endDate"> = {
  initialBudget: 500_000,
  maxPositions: 3,

  // エントリー（スクイーズ検出）
  bbSqueezePercentile: SQUEEZE_BREAKOUT.ENTRY.BB_SQUEEZE_PERCENTILE, // 20
  bbPeriod: SQUEEZE_BREAKOUT.ENTRY.BB_PERIOD,                        // 20
  bbLookback: SQUEEZE_BREAKOUT.ENTRY.BB_LOOKBACK,                    // 60
  volSurgeRatio: SQUEEZE_BREAKOUT.ENTRY.VOL_SURGE_RATIO,             // 1.5

  // ストップロス
  atrMultiplier: SQUEEZE_BREAKOUT.STOP_LOSS.ATR_MULTIPLIER, // 1.0
  maxLossPct: STOP_LOSS.MAX_LOSS_PCT,                        // 0.03

  // トレーリングストップ（初期値、WFで最適化）
  beActivationMultiplier: 0.5,
  trailMultiplier: 0.5,

  // タイムストップ
  maxHoldingDays: 5,
  maxExtendedHoldingDays: 10,

  // ユニバースフィルター
  maxPrice: getMaxBuyablePrice(500_000),
  minAvgVolume25: SQUEEZE_BREAKOUT.ENTRY.MIN_AVG_VOLUME_25,
  minAtrPct: SQUEEZE_BREAKOUT.ENTRY.MIN_ATR_PCT,
  minTurnover: SCREENING.MIN_TURNOVER,
  minPrice: SCREENING.MIN_PRICE,

  // コスト・リスク
  costModelEnabled: true,
  priceLimitEnabled: true,

  // クールダウン
  cooldownDays: 5,

  // マーケットフィルター
  marketTrendFilter: true,
  marketTrendThreshold: SQUEEZE_BREAKOUT.MARKET_FILTER.BREADTH_THRESHOLD, // 0.6
  indexTrendFilter: true,
  indexTrendSmaPeriod: 50,
  indexTrendOffBufferPct: 0,
  indexTrendOnBufferPct: 0,

  verbose: false,
  positionCapEnabled: true,
};

/** 1トレードあたりリスク（%） */
export const SQUEEZE_BREAKOUT_RISK_PER_TRADE_PCT = POSITION_SIZING.RISK_PER_TRADE_PCT; // 2

/** walk-forward パラメータグリッド（エグジット系のみ、27通り） */
export const SQUEEZE_BREAKOUT_PARAMETER_GRID = {
  atrMultiplier: [0.8, 1.0, 1.2],
  beActivationMultiplier: [0.3, 0.5, 0.8],
  trailMultiplier: [0.5, 0.8, 1.0],
} as const;

/** パラメータグリッドの全組み合わせを生成 */
export function generateSqueezeBreakoutParameterCombinations(): Array<Partial<SqueezeBreakoutBacktestConfig>> {
  const combos: Array<Partial<SqueezeBreakoutBacktestConfig>> = [];

  for (const atrMultiplier of SQUEEZE_BREAKOUT_PARAMETER_GRID.atrMultiplier) {
    for (const beActivationMultiplier of SQUEEZE_BREAKOUT_PARAMETER_GRID.beActivationMultiplier) {
      for (const trailMultiplier of SQUEEZE_BREAKOUT_PARAMETER_GRID.trailMultiplier) {
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
