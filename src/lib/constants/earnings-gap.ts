/**
 * 決算ギャップ戦略の定数
 *
 * gapupの亜種。決算発表翌日のギャップに限定し、カタリストが明確でノイズが少ない。
 */
export const EARNINGS_GAP = {
  ENTRY: {
    /** 最低ギャップ率 */
    GAP_MIN_PCT: 0.03,
    /** 出来高サージ倍率 */
    VOL_SURGE_RATIO: 1.5,
    /** 最低25日平均出来高 */
    MIN_AVG_VOLUME_25: 100_000,
    /** 最低ATR%（日足） */
    MIN_ATR_PCT: 1.5,
  },
  STOP_LOSS: {
    /** SL = entry - ATR × this */
    ATR_MULTIPLIER: 1.0,
  },
  MARKET_FILTER: {
    BREADTH_THRESHOLD: 0.6,
  },
} as const;
