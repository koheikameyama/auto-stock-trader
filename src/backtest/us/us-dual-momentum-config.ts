/**
 * Dual Momentum (Antonacci GEM) バックテスト設定
 */

import type { USDualMomentumBacktestConfig } from "./us-dual-momentum-types";

export const US_DUAL_MOMENTUM_DEFAULTS: Omit<USDualMomentumBacktestConfig, "startDate" | "endDate"> = {
  initialBudget: 3300,

  // Antonacci GEM: SPY (米株) vs EFA (海外株)
  equityUniverse: ["SPY", "EFA"],
  // 絶対モメンタムが負なら AGG (米国総合債券) へ退避
  riskOffAsset: "AGG",
  absoluteMomentumThreshold: 0, // 0%（リターン正なら株式、負なら退避）

  // 12ヶ月モメンタム ≈ 252営業日
  lookbackDays: 252,
  // 月次リバランス
  rebalanceDays: 21,

  commissionPerTrade: 1.0,
  slippagePct: 0.05,

  verbose: false,
};

/** Walk-Forward パラメータグリッド（27通り） */
export const US_DUAL_MOMENTUM_PARAMETER_GRID = {
  lookbackDays: [63, 126, 252] as const, // 3, 6, 12ヶ月
  rebalanceDays: [21, 42, 63] as const, // 月次, 隔月, 四半期
  absoluteMomentumThreshold: [-5, 0, 5] as const,
};

export function generateUSDualMomentumParameterCombinations(): Array<Partial<USDualMomentumBacktestConfig>> {
  const combos: Array<Partial<USDualMomentumBacktestConfig>> = [];
  for (const lookbackDays of US_DUAL_MOMENTUM_PARAMETER_GRID.lookbackDays) {
    for (const rebalanceDays of US_DUAL_MOMENTUM_PARAMETER_GRID.rebalanceDays) {
      for (const absoluteMomentumThreshold of US_DUAL_MOMENTUM_PARAMETER_GRID.absoluteMomentumThreshold) {
        combos.push({ lookbackDays, rebalanceDays, absoluteMomentumThreshold });
      }
    }
  }
  return combos;
}
