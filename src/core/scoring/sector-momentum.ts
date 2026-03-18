import { SECTOR_MOMENTUM_SCORING } from "../../lib/constants/scoring";

/**
 * セクターモメンタムボーナス（-3〜+5）
 *
 * セクターの対日経225相対強度をボーナス/ペナルティ修飾子に変換する。
 * null/undefined の場合はデフォルト（0: ニュートラル）を返す。
 */
export function scoreSectorMomentum(
  relativeStrength: number | null | undefined,
): number {
  if (relativeStrength == null) {
    return SECTOR_MOMENTUM_SCORING.DEFAULT_BONUS;
  }

  for (const tier of SECTOR_MOMENTUM_SCORING.TIERS) {
    if (relativeStrength >= tier.min) {
      return tier.bonus;
    }
  }

  return SECTOR_MOMENTUM_SCORING.FLOOR_BONUS;
}
