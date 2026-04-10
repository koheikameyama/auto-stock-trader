/**
 * 週足レンジブレイク戦略の定数
 */
export const WEEKLY_BREAK = {
  ENTRY: {
    /** N週高値ルックバック（週数） */
    HIGH_LOOKBACK_WEEKS: 13,
    /** 週足出来高サージ倍率 */
    VOL_SURGE_RATIO: 1.3,
    /** 最低日次平均出来高（25日） */
    MIN_AVG_VOLUME_25: 100_000,
    /** 最低ATR%（日足） */
    MIN_ATR_PCT: 1.5,
  },
  STOP_LOSS: {
    /** SL = entry - ATR × this（週足は広め） */
    ATR_MULTIPLIER: 1.5,
  },
  MARKET_FILTER: {
    BREADTH_THRESHOLD: 0.6,
  },
} as const;
