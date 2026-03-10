/**
 * マーケットレジーム判定モジュール
 *
 * 日経VIベースの機械的レジーム判定。
 * AIの前段で動作し、日経VI > 40 の暴落局面ではAI判断を待たず取引停止する。
 * VIXは補助指標として残し、日経VI取得不可時のフォールバックに使用する。
 */

import { NIKKEI_VI_THRESHOLDS, VIX_THRESHOLDS, MARKET_REGIME, CME_NIGHT_DIVERGENCE } from "../lib/constants";

export type RegimeLevel = "normal" | "elevated" | "high" | "crisis";

export interface MarketRegime {
  level: RegimeLevel;
  nikkeiVi: number;
  maxPositions: number;
  minRank: "S" | "A" | "B" | null; // nullは取引停止
  shouldHaltTrading: boolean;
  reason: string;
}

/**
 * 日経VI水準からマーケットレジームを機械的に判定する
 *
 * - 日経VI > 40: crisis → 取引停止（AI判断不要）
 * - 日経VI 30-40: high → 最大1ポジション、Sランクのみ
 * - 日経VI 25-30: elevated → 最大2ポジション、S/Aランク
 * - 日経VI < 25: normal → 制限なし
 */
export function determineMarketRegime(nikkeiVi: number): MarketRegime {
  if (nikkeiVi > NIKKEI_VI_THRESHOLDS.HIGH) {
    return {
      level: "crisis",
      nikkeiVi,
      maxPositions: MARKET_REGIME.CRISIS.maxPositions,
      minRank: MARKET_REGIME.CRISIS.minRank,
      shouldHaltTrading: true,
      reason: `日経VI ${nikkeiVi.toFixed(1)} > ${NIKKEI_VI_THRESHOLDS.HIGH}: 市場パニック状態。全取引停止`,
    };
  }

  if (nikkeiVi > NIKKEI_VI_THRESHOLDS.ELEVATED) {
    return {
      level: "high",
      nikkeiVi,
      maxPositions: MARKET_REGIME.HIGH.maxPositions,
      minRank: MARKET_REGIME.HIGH.minRank,
      shouldHaltTrading: false,
      reason: `日経VI ${nikkeiVi.toFixed(1)} > ${NIKKEI_VI_THRESHOLDS.ELEVATED}: 高ボラティリティ。最大${MARKET_REGIME.HIGH.maxPositions}ポジション、Sランクのみ`,
    };
  }

  if (nikkeiVi > NIKKEI_VI_THRESHOLDS.NORMAL) {
    return {
      level: "elevated",
      nikkeiVi,
      maxPositions: MARKET_REGIME.ELEVATED.maxPositions,
      minRank: MARKET_REGIME.ELEVATED.minRank,
      shouldHaltTrading: false,
      reason: `日経VI ${nikkeiVi.toFixed(1)} > ${NIKKEI_VI_THRESHOLDS.NORMAL}: やや不安定。最大${MARKET_REGIME.ELEVATED.maxPositions}ポジション、S/Aランク`,
    };
  }

  return {
    level: "normal",
    nikkeiVi,
    maxPositions: MARKET_REGIME.NORMAL.maxPositions,
    minRank: MARKET_REGIME.NORMAL.minRank,
    shouldHaltTrading: false,
    reason: `日経VI ${nikkeiVi.toFixed(1)}: 通常レジーム`,
  };
}

/**
 * VIXからマーケットレジームを判定する（日経VI取得不可時のフォールバック）
 */
export function determineMarketRegimeFromVix(vix: number): MarketRegime {
  let level: RegimeLevel;
  let reason: string;

  if (vix > VIX_THRESHOLDS.HIGH) {
    level = "crisis";
    reason = `VIX ${vix.toFixed(1)} > ${VIX_THRESHOLDS.HIGH}: 市場パニック状態。全取引停止（日経VI未取得のためVIXで代替）`;
  } else if (vix > VIX_THRESHOLDS.ELEVATED) {
    level = "high";
    reason = `VIX ${vix.toFixed(1)} > ${VIX_THRESHOLDS.ELEVATED}: 高ボラティリティ（日経VI未取得のためVIXで代替）`;
  } else if (vix > VIX_THRESHOLDS.NORMAL) {
    level = "elevated";
    reason = `VIX ${vix.toFixed(1)} > ${VIX_THRESHOLDS.NORMAL}: やや不安定（日経VI未取得のためVIXで代替）`;
  } else {
    level = "normal";
    reason = `VIX ${vix.toFixed(1)}: 通常レジーム（日経VI未取得のためVIXで代替）`;
  }

  const config = MARKET_REGIME[level === "crisis" ? "CRISIS" : level === "high" ? "HIGH" : level === "elevated" ? "ELEVATED" : "NORMAL"];

  return {
    level,
    nikkeiVi: vix, // フォールバック時はVIX値を格納
    maxPositions: config.maxPositions,
    minRank: config.minRank,
    shouldHaltTrading: level === "crisis",
    reason,
  };
}

/**
 * CME日経先物ナイトセッション乖離率からプレマーケットリスクを判定する
 *
 * 乖離率(%) = ((CME先物価格 × USDJPY) / 日経前日終値 - 1) × 100
 * ※ NKD=FはUSD建てのため、USDJPY変換が必要
 *
 * - 乖離 ≤ -3.0% → crisis（取引停止、前場でギャップダウン必至）
 * - 乖離 ≤ -1.5% → elevated以上に引き上げ（警戒モード）
 * - それ以外 → レジームへの影響なし
 */
export function determinePreMarketRegime(cmeDivergencePct: number): {
  minLevel: RegimeLevel | null;
  reason: string | null;
} {
  if (cmeDivergencePct <= CME_NIGHT_DIVERGENCE.CRITICAL) {
    return {
      minLevel: "crisis",
      reason: `CME先物乖離率 ${cmeDivergencePct.toFixed(2)}% ≤ ${CME_NIGHT_DIVERGENCE.CRITICAL}%: ギャップダウン必至。全取引停止`,
    };
  }

  if (cmeDivergencePct <= CME_NIGHT_DIVERGENCE.WARNING) {
    return {
      minLevel: "elevated",
      reason: `CME先物乖離率 ${cmeDivergencePct.toFixed(2)}% ≤ ${CME_NIGHT_DIVERGENCE.WARNING}%: 警戒モード`,
    };
  }

  return { minLevel: null, reason: null };
}

/**
 * CME先物乖離率を計算する
 *
 * @param cmeFuturesPrice CME日経先物価格（USD建て）
 * @param usdjpy USD/JPYレート
 * @param nikkeiPreviousClose 日経225前日終値
 */
export function calculateCmeDivergence(
  cmeFuturesPrice: number,
  usdjpy: number,
  nikkeiPreviousClose: number,
): number {
  const cmeFuturesJpy = cmeFuturesPrice * usdjpy;
  return ((cmeFuturesJpy / nikkeiPreviousClose) - 1) * 100;
}
