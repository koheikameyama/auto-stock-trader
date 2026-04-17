/**
 * 高騰後押し目戦略（Post-Surge Consolidation）の定数
 */
export const POST_SURGE_CONSOLIDATION = {
  ENTRY: {
    /** 急騰フィルター: 直近20日リターン閾値 */
    MOMENTUM_LOOKBACK_DAYS: 20,
    MOMENTUM_MIN_RETURN: 0.15,       // +15%
    /** 高値圏維持: 高値からの最大乖離 */
    MAX_HIGH_DISTANCE_PCT: 0.05,     // 高値から-5%以内
    /** 再加速: 出来高サージ倍率 */
    VOL_SURGE_RATIO: 1.5,
    MIN_AVG_VOLUME_25: 100_000,
    MIN_ATR_PCT: 1.5,
  },
  STOP_LOSS: {
    ATR_MULTIPLIER: 1.0,
  },
  TIME_STOP: {
    MAX_HOLDING_DAYS: 5,
    MAX_EXTENDED_HOLDING_DAYS: 7,
  },
  ENTRY_ENABLED: true,
} as const;
