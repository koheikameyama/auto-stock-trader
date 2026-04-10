/**
 * ボラティリティスクイーズ・ブレイクアウト戦略の定数
 *
 * BB幅が収縮（スクイーズ）した状態からのブレイクアウトを狙う。
 * 需給の溜まり → 解放 による高確率フォロースルーを期待。
 */
export const SQUEEZE_BREAKOUT = {
  ENTRY: {
    /** BB(20,2σ)幅の60日パーセンタイル閾値（この%tile以下をスクイーズとみなす） */
    BB_SQUEEZE_PERCENTILE: 20,
    /** BB期間 */
    BB_PERIOD: 20,
    /** パーセンタイル計算のルックバック日数 */
    BB_LOOKBACK: 60,
    /** 出来高サージ倍率 */
    VOL_SURGE_RATIO: 1.5,
    /** 最低25日平均出来高 */
    MIN_AVG_VOLUME_25: 100_000,
    /** 最低ATR%（ボラティリティ下限） */
    MIN_ATR_PCT: 1.5,
  },
  STOP_LOSS: {
    /** SL = entry - ATR × this */
    ATR_MULTIPLIER: 1.0,
  },
  MARKET_FILTER: {
    /** breadth閾値（SMA25上回り比率） */
    BREADTH_THRESHOLD: 0.6,
  },
  /** ライブエントリー有効フラグ（WF検証後に有効化） */
  ENTRY_ENABLED: false,
} as const;
