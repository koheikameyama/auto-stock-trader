/**
 * ギャップアップバックテスト設定 & パラメータグリッド
 */

import { GAPUP } from "../lib/constants/gapup";
import { STOP_LOSS, POSITION_SIZING } from "../lib/constants/scoring";
import { BREAK_EVEN_STOP, TRAILING_STOP, TIME_STOP, SCREENING, MARKET_BREADTH } from "../lib/constants";
import { getMaxBuyablePrice } from "../core/risk-manager";
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

  // トレーリングストップ（本番定数と同一）
  beActivationMultiplier: BREAK_EVEN_STOP.ACTIVATION_ATR_MULTIPLIER.gapup, // 0.5
  trailMultiplier: TRAILING_STOP.TRAIL_ATR_MULTIPLIER.gapup,               // 0.3

  // タイムストップ（本番定数と同一）
  maxHoldingDays: TIME_STOP.GAPUP_MAX_HOLDING_DAYS,                        // 3
  maxExtendedHoldingDays: TIME_STOP.GAPUP_MAX_EXTENDED_HOLDING_DAYS,       // 5

  // ユニバースフィルター
  maxPrice: getMaxBuyablePrice(500_000),           // 資金連動（50万→2500）
  minAvgVolume25: GAPUP.ENTRY.MIN_AVG_VOLUME_25, // 100_000
  minAtrPct: GAPUP.ENTRY.MIN_ATR_PCT,            // 1.5
  minTurnover: SCREENING.MIN_TURNOVER,             // 100_000_000
  minPrice: SCREENING.MIN_PRICE,                   // 100

  // コスト・リスク
  costModelEnabled: true,
  priceLimitEnabled: true,

  // クールダウン
  cooldownDays: 3,

  // マーケットフィルター
  marketTrendFilter: true,
  marketTrendThreshold: MARKET_BREADTH.THRESHOLD,
  indexTrendFilter: true,
  indexTrendSmaPeriod: 50,
  indexTrendOffBufferPct: 0,
  indexTrendOnBufferPct: 0,

  verbose: false,
  positionCapEnabled: true,
  signalSortMethod: "gapvol",
};

/** 本番パラメータ（WF最適値、combined-run / AI評価で参照） */
export const GAPUP_PRODUCTION_PARAMS = {
  atrMultiplier: GAPUP_BACKTEST_DEFAULTS.atrMultiplier,
  beActivationMultiplier: GAPUP_BACKTEST_DEFAULTS.beActivationMultiplier,
  trailMultiplier: GAPUP_BACKTEST_DEFAULTS.trailMultiplier,
};

/** 1トレードあたりリスク（%） */
export const GAPUP_RISK_PER_TRADE_PCT = POSITION_SIZING.RISK_PER_TRADE_PCT; // 2

/**
 * walk-forward パラメータグリッド（条件付きgap緩和 + エグジット系、81通り）
 *
 * gapMinPct=3% 固定。vol が gapRelaxVolThreshold 以上のとき gapMinPctRelaxed=1% に緩和。
 * gapRelaxVolThreshold=undefined は緩和無効（従来の gap=3% 単純フィルター）。
 */
export const GAPUP_PARAMETER_GRID = {
  /** undefined = 緩和無効 */
  gapRelaxVolThreshold: [undefined, 3.0, 4.0] as (number | undefined)[],
  atrMultiplier: [0.8, 1.0, 1.2],
  beActivationMultiplier: [0.3, 0.5, 0.8],
  trailMultiplier: [0.3, 0.5, 0.8],
} as const;

/** 緩和時の gap 下限 */
export const GAPUP_RELAXED_GAP_MIN_PCT = 0.01;

/** パラメータグリッドの全組み合わせを生成 */
export function generateGapUpParameterCombinations(): Array<Partial<GapUpBacktestConfig>> {
  const combos: Array<Partial<GapUpBacktestConfig>> = [];

  for (const gapRelaxVolThreshold of GAPUP_PARAMETER_GRID.gapRelaxVolThreshold) {
    for (const atrMultiplier of GAPUP_PARAMETER_GRID.atrMultiplier) {
      for (const beActivationMultiplier of GAPUP_PARAMETER_GRID.beActivationMultiplier) {
        for (const trailMultiplier of GAPUP_PARAMETER_GRID.trailMultiplier) {
          combos.push({
            gapRelaxVolThreshold,
            gapMinPctRelaxed: gapRelaxVolThreshold != null ? GAPUP_RELAXED_GAP_MIN_PCT : undefined,
            atrMultiplier,
            beActivationMultiplier,
            trailMultiplier,
          });
        }
      }
    }
  }

  return combos;
}
