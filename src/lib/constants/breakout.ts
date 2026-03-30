/**
 * インtraday体積ブレイクアウト戦略の定数
 *
 * 体積サージを使った株式ブレイクアウト検出:
 * - 平均体積の25日間に対する相対比
 * - 9:05-15:25のインtraday取引窓での価格行動
 * - 20日高値ブレイクアウト + ATRベースのエントリー検証
 */

/** ブレイクアウト戦略の定数 */
export const BREAKOUT = {
  /** 体積サージ閾値 */
  VOLUME_SURGE: {
    /** ホット認定の最小倍率（平均体積比） */
    HOT_THRESHOLD: 1.5,
    /** ブレイクアウトトリガーの倍率 */
    TRIGGER_THRESHOLD: 2.0,
    /** クールダウン状態への逆戻り倍率 */
    COOL_DOWN_THRESHOLD: 1.2,
    /** クールダウンカウント（N回連続で体積サージが低下したら完全リセット） */
    COOL_DOWN_COUNT: 2,
  },

  /** 価格ブレイクアウト条件 */
  PRICE: {
    /** 高値の検索期間（営業日） */
    HIGH_LOOKBACK_DAYS: 20,
    /** high20からの最大許容乖離（ATR倍率）。これ以上離れていたら高値追いとしてスキップ */
    MAX_CHASE_ATR: 1.0,
  },

  /** ポーリング間隔 */
  POLLING: {
    /** コールド状態（ホットセットなし）のポーリング間隔（ms） */
    COLD_INTERVAL_MS: 5 * 60 * 1000,
    /** ホット状態（ホットセットあり）のポーリング間隔（ms） */
    HOT_INTERVAL_MS: 1 * 60 * 1000,
  },

  /** ストップロス設定 */
  STOP_LOSS: {
    /** ATR乗数（ブレイクアウト戦略用: 確認エントリーのためタイトなSL） */
    ATR_MULTIPLIER: 1.0,
  },

  /** エントリーガード条件 */
  GUARD: {
    /** 最早エントリー時刻（JST） */
    EARLIEST_ENTRY_TIME: "09:05",
    /** 最遅エントリー時刻（JST） */
    LATEST_ENTRY_TIME: "15:25",
  },

  /** 1営業日の取引分数（前場150分 + 後場180分） */
  TRADING_MINUTES_PER_DAY: 330,

  /** エントリー判定（バックテスト・ライブ共通、single source of truth） */
  ENTRY: {
    /** 出来高サージ閾値 */
    TRIGGER_THRESHOLD: 2.0,
    /** high20からの最大許容乖離（ATR倍率）。BT検証済み */
    MAX_CHASE_ATR: 0.5,
    /** 高値の検索期間（営業日） */
    HIGH_LOOKBACK_DAYS: 20,
    /** 最大株価 */
    MAX_PRICE: 5000,
    /** 最小平均出来高25日。BT検証済み */
    MIN_AVG_VOLUME_25: 100_000,
    /** 最小ATR%（ボラティリティ下限） */
    MIN_ATR_PCT: 1.5,
  },

  /** ウォッチリストDBキャッシュの有効期間（ms） */
  WATCHLIST_CACHE_TTL_MS: 5 * 60 * 1000,
} as const;
