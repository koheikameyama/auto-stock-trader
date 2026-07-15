/**
 * 高騰後押し目バックテスト設定 & パラメータグリッド
 */

import { POST_SURGE_CONSOLIDATION } from "../lib/constants/post-surge-consolidation";
import { STOP_LOSS, POSITION_SIZING } from "../lib/constants/scoring";
import { SCREENING, MARKET_BREADTH } from "../lib/constants";
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

  beActivationMultiplier: POST_SURGE_CONSOLIDATION.BREAK_EVEN.ACTIVATION_ATR_MULTIPLIER,
  trailMultiplier: POST_SURGE_CONSOLIDATION.TRAILING.TRAIL_ATR_MULTIPLIER,

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
  marketTrendUpperCap: MARKET_BREADTH.UPPER_CAP,
  indexTrendFilter: true,
  indexTrendSmaPeriod: 50,
  indexTrendOffBufferPct: 0,
  indexTrendOnBufferPct: 0,

  verbose: false,
  positionCapEnabled: true,
};

/** 本番パラメータ（PSC定数から参照、WF最適値） */
export const PSC_PRODUCTION_PARAMS = {
  atrMultiplier: POST_SURGE_CONSOLIDATION.STOP_LOSS.ATR_MULTIPLIER,
  beActivationMultiplier: POST_SURGE_CONSOLIDATION.BREAK_EVEN.ACTIVATION_ATR_MULTIPLIER,
  trailMultiplier: POST_SURGE_CONSOLIDATION.TRAILING.TRAIL_ATR_MULTIPLIER,
};

/** 1トレードあたりリスク（%） */
export const PSC_RISK_PER_TRADE_PCT = POSITION_SIZING.RISK_PER_TRADE_PCT;

/** walk-forward パラメータグリッド（27通り、エグジット系のみ） */
export const PSC_PARAMETER_GRID = {
  atrMultiplier: [0.8, 1.0, 1.2],
  // 下限 0.3 は意図的（KOH-552, 2026-07-15 測定）。低い側も検証済みで OOS は単調に悪化する:
  //   WF固定比較(atr=0.8/trail=0.3固定, 7窓 OOS集計PF): be=0.1 → 2.47 / 0.2 → 2.51 / 0.3 → 2.58
  // combined 単発BTでは be=0.1 が Calmar 33.63（0.3 は 32.04）と勝つが WF で再現しない経路依存ノイズ。
  // グリッドに 0.1/0.2 を入れると IS が掴んで OOS が落ちる（集計PF 2.48→2.43 / 勝率 44.9%→42.9%）
  // ＝過学習の次元が増えるだけなので入れない。上側 0.5/0.8 は明確に悪いが探索範囲として残す。
  beActivationMultiplier: [0.3, 0.5, 0.8],
  // 0.3 は KOH-548 で追加。イントラバー先読み修正後の combined 単発BTで trail=0.3 が
  // Calmar 32.04（現行0.5 は 22.98）と最良になったため、WF で確認できるようグリッドに入れた。
  // GU 側は元々 0.3 を含んでおり、PSC だけ下限が 0.5 で欠けていた。
  trailMultiplier: [0.3, 0.5, 0.8, 1.0],
  // breakEvenFloor はグリッドに入れない（KOH-552）。
  // WF固定比較で OOS に効かないと確認済み: trail=0.5 で entry 2.26 / none 2.23（悪化）、
  // trail=0.3 では 2.58 / 2.58 と完全同値（trail==BE発動 0.3 でフロアが数学的に無意味）。
  // にもかかわらず none は 7/7 窓で IS最適に選ばれる = OOSに効かない純粋な過学習の次元。
  // グリッドに残すと毎回 none が選ばれるだけなので外す。config の配線は --compare-be 用に残置。
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
