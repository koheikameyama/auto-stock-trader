/**
 * MA押し目買い戦略の定数
 */
export const MA_PULLBACK = {
  ENTRY: {
    /** 押し目判定MA期間 */
    MA_PERIOD: 20,
    /** MAタッチ判定バッファ（low <= MA × (1 + BUFFER) でタッチ判定） */
    MA_TOUCH_BUFFER: 0.02,
    /** トレンド確認MA期間 */
    TREND_MA_PERIOD: 50,
    /** 直近高値更新ルックバック日数 */
    RECENT_HIGH_LOOKBACK: 10,
    /** 出来高干上がり判定倍率（直近3日avg < avg25 × this） */
    VOLUME_DRYUP_RATIO: 0.85,
    /** 最低25日平均出来高 */
    MIN_AVG_VOLUME_25: 100_000,
    /** 最低ATR%（ボラティリティフィルター） */
    MIN_ATR_PCT: 1.5,
  },
  RETOUCH: {
    /** リタッチ判定の最低間隔（ミリ秒）: 前回タッチから5分以上空いていること */
    MIN_INTERVAL_MS: 5 * 60 * 1000,
  },
  STOP_LOSS: {
    ATR_MULTIPLIER: 1.0,
  },
  MARKET_FILTER: {
    BREADTH_THRESHOLD: 0.6,
  },
} as const;
