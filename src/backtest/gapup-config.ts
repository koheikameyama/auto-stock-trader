/**
 * ギャップアップバックテスト設定 & パラメータグリッド
 */

import { GAPUP } from "../lib/constants/gapup";
import { STOP_LOSS, POSITION_SIZING } from "../lib/constants/scoring";
import type { GapUpBacktestConfig } from "./types";

/** デフォルト設定 */
export const GAPUP_BACKTEST_DEFAULTS: Omit<GapUpBacktestConfig, "startDate" | "endDate"> = {
  initialBudget: 500_000,
  maxPositions: 3,

  // エントリー
  gapMinPct: GAPUP.ENTRY.GAP_MIN_PCT,           // 0.03 (3%)
  volSurgeRatio: GAPUP.ENTRY.VOL_SURGE_RATIO,   // 1.5

  // ストップロス
  atrMultiplier: GAPUP.STOP_LOSS.ATR_MULTIPLIER, // 1.0
  maxLossPct: STOP_LOSS.MAX_LOSS_PCT,             // 0.03

  // トレーリングストップ（短期向けにタイト設定）
  beActivationMultiplier: 0.5,
  tsActivationMultiplier: 1.0,
  trailMultiplier: 0.5,

  // タイムストップ（短期決戦）
  maxHoldingDays: 3,
  maxExtendedHoldingDays: 5,

  // ユニバースフィルター
  maxPrice: GAPUP.ENTRY.MAX_PRICE,               // 5000
  minAvgVolume25: GAPUP.ENTRY.MIN_AVG_VOLUME_25, // 100_000
  minAtrPct: GAPUP.ENTRY.MIN_ATR_PCT,            // 1.5

  // コスト・リスク
  costModelEnabled: true,
  priceLimitEnabled: true,

  // クールダウン
  cooldownDays: 3,

  // マーケットフィルター
  marketTrendFilter: true,
  marketTrendThreshold: 0.6,
  indexTrendFilter: true,
  indexTrendSmaPeriod: 50,
  indexTrendOffBufferPct: 0,
  indexTrendOnBufferPct: 0,

  verbose: false,
};

/** 1トレードあたりリスク（%） */
export const GAPUP_RISK_PER_TRADE_PCT = POSITION_SIZING.RISK_PER_TRADE_PCT; // 2

/** walk-forward パラメータグリッド（エグジット系のみ、81通り） */
export const GAPUP_PARAMETER_GRID = {
  atrMultiplier: [0.8, 1.0, 1.2],
  beActivationMultiplier: [0.3, 0.5, 0.8],
  trailMultiplier: [0.3, 0.5, 0.8],
  tsActivationMultiplier: [0.5, 1.0, 1.5],
} as const;

/** パラメータグリッドの全組み合わせを生成 */
export function generateGapUpParameterCombinations(): Array<Partial<GapUpBacktestConfig>> {
  const combos: Array<Partial<GapUpBacktestConfig>> = [];

  for (const atrMultiplier of GAPUP_PARAMETER_GRID.atrMultiplier) {
    for (const beActivationMultiplier of GAPUP_PARAMETER_GRID.beActivationMultiplier) {
      for (const trailMultiplier of GAPUP_PARAMETER_GRID.trailMultiplier) {
        for (const tsActivationMultiplier of GAPUP_PARAMETER_GRID.tsActivationMultiplier) {
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
