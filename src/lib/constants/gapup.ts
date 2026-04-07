/**
 * ギャップアップ戦略の定数
 */
export const GAPUP = {
  ENTRY: {
    GAP_MIN_PCT: 0.03,
    VOL_SURGE_RATIO: 1.5,
    MAX_PRICE: 5000,
    MIN_AVG_VOLUME_25: 100_000,
    MIN_ATR_PCT: 1.5,
  },
  STOP_LOSS: {
    ATR_MULTIPLIER: 1.0,
  },
  /** エントリーガード条件（ライブ用） */
  GUARD: {
    /** gapupスキャン実行時刻（JST、15:20） */
    SCAN_HOUR: 15,
    SCAN_MINUTE: 20,
  },
  /** マーケットフィルター（ライブ用） */
  MARKET_FILTER: {
    /** breadth閾値（ウォッチリスト銘柄のSMA25上回り比率）— バックテストの marketTrendThreshold と同値 */
    BREADTH_THRESHOLD: 0.6,
  },
} as const;
