import { SECTOR_MOMENTUM_SCORING } from "../../lib/constants/scoring";

/**
 * セクターモメンタムスコア（0-5）
 *
 * セクターの対日経225相対強度をスコアに変換する。
 * null/undefined の場合はデフォルトスコア（市場並み: 2）を返す。
 */
export function scoreSectorMomentum(
  relativeStrength: number | null | undefined,
): number {
  if (relativeStrength == null) {
    return SECTOR_MOMENTUM_SCORING.DEFAULT_SCORE;
  }

  for (const tier of SECTOR_MOMENTUM_SCORING.TIERS) {
    if (relativeStrength >= tier.min) {
      return tier.score;
    }
  }

  return 0;
}
