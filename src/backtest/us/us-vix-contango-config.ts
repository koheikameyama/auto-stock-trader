/**
 * VIX Contango バックテスト設定
 */

import type { USVixContangoBacktestConfig } from "./us-vix-contango-types";

export const US_VIX_CONTANGO_DEFAULTS: Omit<USVixContangoBacktestConfig, "startDate" | "endDate"> = {
  initialBudget: 3300,
  underlyingTicker: "SVXY", // -0.5x = SVIXより安全側

  // VIXレジーム
  vixEntryUpperBound: 22, // VIX <= 22 のときエントリー（コンタンゴ前提条件）
  vixExitUpperBound: 25, // VIX > 25 で即撤退
  vixSpikeThreshold: 20, // 前日比 +20% 急上昇で撤退（Volmageddon対策）
  reentryCooldownDays: 5,

  positionSizing: 1.0, // フル投資（SVXY自体が-0.5xなのでレバ抑制済み）
  stopLossPct: 10, // -10%でストップロス

  commissionPerTrade: 1.0, // $1/trade（IBKR等の典型値）
  slippagePct: 0.05, // 0.05% slippage

  verbose: false,
};

/** Walk-Forward パラメータグリッド（27通り） */
export const US_VIX_CONTANGO_PARAMETER_GRID = {
  vixEntryUpperBound: [18, 22, 26] as const,
  vixExitUpperBound: [22, 25, 30] as const,
  stopLossPct: [5, 10, 15] as const,
};

export function generateUSVixContangoParameterCombinations(): Array<Partial<USVixContangoBacktestConfig>> {
  const combos: Array<Partial<USVixContangoBacktestConfig>> = [];
  for (const vixEntryUpperBound of US_VIX_CONTANGO_PARAMETER_GRID.vixEntryUpperBound) {
    for (const vixExitUpperBound of US_VIX_CONTANGO_PARAMETER_GRID.vixExitUpperBound) {
      if (vixExitUpperBound < vixEntryUpperBound) continue; // exit > entry を保証
      for (const stopLossPct of US_VIX_CONTANGO_PARAMETER_GRID.stopLossPct) {
        combos.push({ vixEntryUpperBound, vixExitUpperBound, stopLossPct });
      }
    }
  }
  return combos;
}
