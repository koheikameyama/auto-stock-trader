/**
 * 銘柄の安全性ルール（強制補正の条件判定）
 *
 * おすすめ分析・購入判断の両方で共通して使う。
 * 条件判定のみを提供し、アクション（除外 or stay変更）は呼び出し側に委ねる。
 */
import { MA_DEVIATION, MOMENTUM } from "@/lib/constants";

/** 高ボラティリティの閾値（%） */
const HIGH_VOLATILITY_THRESHOLD = 50;

/** 急騰銘柄か（投資スタイル別の閾値で判定） */
export function isSurgeStock(
  weekChangeRate: number | null,
  investmentStyle?: string | null,
): boolean {
  if (weekChangeRate === null) return false;
  const threshold = getSurgeThreshold(investmentStyle);
  if (threshold === null) return false; // 積極派は制限なし
  return weekChangeRate >= threshold;
}

/** 投資スタイルに応じた急騰閾値を取得 */
function getSurgeThreshold(investmentStyle?: string | null): number | null {
  switch (investmentStyle) {
    case "CONSERVATIVE":
      return MOMENTUM.CONSERVATIVE_SURGE_THRESHOLD;
    case "BALANCED":
      return MOMENTUM.BALANCED_SURGE_THRESHOLD;
    case "AGGRESSIVE":
      return MOMENTUM.AGGRESSIVE_SURGE_THRESHOLD;
    default:
      return MOMENTUM.DEFAULT_SURGE_THRESHOLD;
  }
}

/** 危険銘柄か（赤字 かつ 高ボラティリティ） */
export function isDangerousStock(
  isProfitable: boolean | null,
  volatility: number | null,
): boolean {
  return (
    isProfitable === false &&
    volatility !== null &&
    volatility > HIGH_VOLATILITY_THRESHOLD
  );
}

/** 赤字×急騰銘柄か（赤字企業が急騰している場合、仕手株やバブルの可能性が高い） */
export function isUnprofitableSurge(
  isProfitable: boolean | null,
  weekChangeRate: number | null,
): boolean {
  return (
    isProfitable === false &&
    weekChangeRate !== null &&
    weekChangeRate >= MOMENTUM.UNPROFITABLE_SURGE_THRESHOLD
  );
}

/** 過熱圏か（移動平均乖離率+20%以上、積極派はスキップ） */
export function isOverheated(
  deviationRate: number | null,
  investmentStyle?: string | null,
): boolean {
  if (investmentStyle === "AGGRESSIVE" && MOMENTUM.AGGRESSIVE_SKIP_OVERHEAT)
    return false;
  return (
    deviationRate !== null && deviationRate >= MA_DEVIATION.UPPER_THRESHOLD
  );
}

/** 下落トレンドか（投資スタイル別の閾値で判定） */
export function isInDecline(
  weekChangeRate: number | null,
  investmentStyle?: string | null,
): boolean {
  if (weekChangeRate === null) return false;
  const threshold = getDeclineThreshold(investmentStyle);
  return weekChangeRate <= threshold;
}

/** 投資スタイルに応じた下落閾値を取得 */
function getDeclineThreshold(investmentStyle?: string | null): number {
  switch (investmentStyle) {
    case "CONSERVATIVE":
      return MOMENTUM.CONSERVATIVE_DECLINE_THRESHOLD;
    case "BALANCED":
      return MOMENTUM.BALANCED_DECLINE_THRESHOLD;
    case "AGGRESSIVE":
      return MOMENTUM.AGGRESSIVE_DECLINE_THRESHOLD;
    default:
      return MOMENTUM.DEFAULT_DECLINE_THRESHOLD;
  }
}
