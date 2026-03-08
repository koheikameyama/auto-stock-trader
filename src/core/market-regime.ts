/**
 * マーケットレジーム判定モジュール
 *
 * VIXベースの機械的レジーム判定。
 * AIの前段で動作し、VIX > 30 の暴落局面ではAI判断を待たず取引停止する。
 */

import { VIX_THRESHOLDS, MARKET_REGIME } from "../lib/constants";

export type RegimeLevel = "normal" | "elevated" | "high" | "crisis";

export interface MarketRegime {
  level: RegimeLevel;
  vix: number;
  maxPositions: number;
  minRank: "S" | "A" | "B" | null; // nullは取引停止
  shouldHaltTrading: boolean;
  reason: string;
}

/**
 * VIX水準からマーケットレジームを機械的に判定する
 *
 * - VIX > 30: crisis → 取引停止（AI判断不要）
 * - VIX 25-30: high → 最大1ポジション、Sランクのみ
 * - VIX 20-25: elevated → 最大2ポジション、S/Aランク
 * - VIX < 20: normal → 制限なし
 */
export function determineMarketRegime(vix: number): MarketRegime {
  if (vix > VIX_THRESHOLDS.HIGH) {
    return {
      level: "crisis",
      vix,
      maxPositions: MARKET_REGIME.CRISIS.maxPositions,
      minRank: MARKET_REGIME.CRISIS.minRank,
      shouldHaltTrading: true,
      reason: `VIX ${vix.toFixed(1)} > ${VIX_THRESHOLDS.HIGH}: 市場パニック状態。全取引停止`,
    };
  }

  if (vix > VIX_THRESHOLDS.ELEVATED) {
    return {
      level: "high",
      vix,
      maxPositions: MARKET_REGIME.HIGH.maxPositions,
      minRank: MARKET_REGIME.HIGH.minRank,
      shouldHaltTrading: false,
      reason: `VIX ${vix.toFixed(1)} > ${VIX_THRESHOLDS.ELEVATED}: 高ボラティリティ。最大${MARKET_REGIME.HIGH.maxPositions}ポジション、Sランクのみ`,
    };
  }

  if (vix > VIX_THRESHOLDS.NORMAL) {
    return {
      level: "elevated",
      vix,
      maxPositions: MARKET_REGIME.ELEVATED.maxPositions,
      minRank: MARKET_REGIME.ELEVATED.minRank,
      shouldHaltTrading: false,
      reason: `VIX ${vix.toFixed(1)} > ${VIX_THRESHOLDS.NORMAL}: やや不安定。最大${MARKET_REGIME.ELEVATED.maxPositions}ポジション、S/Aランク`,
    };
  }

  return {
    level: "normal",
    vix,
    maxPositions: MARKET_REGIME.NORMAL.maxPositions,
    minRank: MARKET_REGIME.NORMAL.minRank,
    shouldHaltTrading: false,
    reason: `VIX ${vix.toFixed(1)}: 通常レジーム`,
  };
}
