/**
 * モメンタム戦略の定数
 */
export const MOMENTUM = {
  ENTRY: {
    /** リターン計測ルックバック（営業日）。60日 ≈ 3ヶ月 */
    LOOKBACK_DAYS: 60,
    /** 保有する上位銘柄数 */
    TOP_N: 3,
    /** リバランス頻度（営業日）。20日 ≈ 月次 */
    REBALANCE_DAYS: 20,
    /** 最低リターン閾値（%） */
    MIN_RETURN_PCT: 5,
    /** 最低日次平均出来高（25日） */
    MIN_AVG_VOLUME_25: 100_000,
    /** 最低ATR%（日足） */
    MIN_ATR_PCT: 1.5,
  },
  STOP_LOSS: {
    /** SL = entry - ATR × this（長期保有のため広め） */
    ATR_MULTIPLIER: 1.5,
  },
  MARKET_FILTER: {
    BREADTH_THRESHOLD: 0.5,
  },
} as const;
