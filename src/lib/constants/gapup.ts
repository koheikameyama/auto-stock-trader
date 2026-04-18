/**
 * ギャップアップ戦略の定数
 */
export const GAPUP = {
  ENTRY: {
    GAP_MIN_PCT: 0.03,
    VOL_SURGE_RATIO: 1.5,
    MIN_AVG_VOLUME_25: 100_000,
    MIN_ATR_PCT: 1.5,
    /** vol >= この倍率のとき gap 条件を GAP_MIN_PCT_RELAXED に緩和 */
    GAP_RELAX_VOL_THRESHOLD: 4.0,
    /** GAP_RELAX_VOL_THRESHOLD 超時の緩和 gap 下限 */
    GAP_MIN_PCT_RELAXED: 0.01,
  },
  STOP_LOSS: {
    ATR_MULTIPLIER: 1.0,
  },
  /** エントリーガード条件（ライブ用） */
  GUARD: {
    /** gapupスキャン実行時刻（JST、15:24）— 東証クロージングオークション（15:25〜）直前に発注 */
    SCAN_HOUR: 15,
    SCAN_MINUTE: 24,
  },
} as const;
