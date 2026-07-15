/**
 * ギャップアップバックテスト設定 & パラメータグリッド
 */

import { GAPUP } from "../lib/constants/gapup";
import { STOP_LOSS, POSITION_SIZING } from "../lib/constants/scoring";
import { TIME_STOP, SCREENING, MARKET_BREADTH } from "../lib/constants";
import { getMaxBuyablePrice } from "../core/risk-manager";
import type { GapUpBacktestConfig } from "./types";

/** デフォルト設定 */
export const GAPUP_BACKTEST_DEFAULTS: Omit<GapUpBacktestConfig, "startDate" | "endDate"> = {
  initialBudget: 500_000,
  maxPositions: 3,

  // エントリー
  gapMinPct: GAPUP.ENTRY.GAP_MIN_PCT,           // 0.03 (3%)
  volSurgeRatio: GAPUP.ENTRY.VOL_SURGE_RATIO,   // 1.5

  // ストップロス・トレーリングストップ（GAPUP定数から参照）
  atrMultiplier: GAPUP.STOP_LOSS.ATR_MULTIPLIER,
  maxLossPct: STOP_LOSS.MAX_LOSS_PCT,
  beActivationMultiplier: GAPUP.BREAK_EVEN.ACTIVATION_ATR_MULTIPLIER,
  trailMultiplier: GAPUP.TRAILING.TRAIL_ATR_MULTIPLIER,

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
  marketTrendUpperCap: MARKET_BREADTH.UPPER_CAP,
  indexTrendFilter: true,
  indexTrendSmaPeriod: 50,
  indexTrendOffBufferPct: 0,
  indexTrendOnBufferPct: 0,

  verbose: false,
  positionCapEnabled: true,
  signalSortMethod: "gapvol",
};

/** 本番パラメータ（GAPUP定数から参照、WF最適値） */
export const GAPUP_PRODUCTION_PARAMS = {
  atrMultiplier: GAPUP.STOP_LOSS.ATR_MULTIPLIER,
  beActivationMultiplier: GAPUP.BREAK_EVEN.ACTIVATION_ATR_MULTIPLIER,
  trailMultiplier: GAPUP.TRAILING.TRAIL_ATR_MULTIPLIER,
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
  // 下限 0.3 は意図的（KOH-552, 2026-07-15）。PSC 側で低い側 0.1/0.2 を検証したところ
  // OOS は単調に悪化し（be=0.1 → 2.47 / 0.2 → 2.51 / 0.3 → 2.58）、グリッドに入れると IS が
  // 掴んで OOS が落ちた。GU も be/trail 構成は同じ（共に 0.3）なので同様に入れない。
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
