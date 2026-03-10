/**
 * ジョブ設定
 */

// ポジションのデフォルト利確/損切り
export const POSITION_DEFAULTS = {
  TAKE_PROFIT_RATIO: 1.03, // 3%利確
  STOP_LOSS_RATIO: 0.98, // 2%損切り
} as const;

// 注文有効期限
export const ORDER_EXPIRY = {
  SWING_DAYS: 5, // スイングトレード注文の有効日数
} as const;

// 株価取得関連
export const STOCK_FETCH = {
  FAIL_THRESHOLD: 5, // 上場廃止判定の失敗回数
  WEEKLY_CHANGE_MIN_DAYS: 5, // 週間変化率計算の最低日数
} as const;

// ジョブの同時実行数
export const JOB_CONCURRENCY = {
  MARKET_SCANNER: 5,
  ORDER_MANAGER: 3, // OpenAI API レート制限考慮
} as const;

// トレーリングストップ
export const TRAILING_STOP = {
  // アクティベーション閾値（エントリー価格からATR×N上昇で発動）
  ACTIVATION_ATR_MULTIPLIER: {
    day_trade: 0.5,
    swing: 0.5,   // 0.75 → 0.5（より早く発動）
  },
  // トレール幅（最高値 - ATR×N がストップライン）
  TRAIL_ATR_MULTIPLIER: {
    day_trade: 1.0,
    swing: 1.2,   // 1.5 → 1.2（やや引き締め）
  },
  // ATR不明時のフォールバック（%ベース）
  ACTIVATION_PCT: { day_trade: 0.01, swing: 0.01 },   // 0.015 → 0.01
  TRAIL_PCT: { day_trade: 0.015, swing: 0.02 },        // 0.025 → 0.02
} as const;

// ディフェンシブモード（市場環境悪化時のポジション防衛）
export const DEFENSIVE_MODE = {
  ENABLED_SENTIMENTS: ["bearish", "crisis"] as readonly string[],
  // 微益撤退の最低利益率（%）— 損小利大を維持するため手数料以上の利益を確保
  MIN_PROFIT_PCT_FOR_RETREAT: 1.0,
} as const;

// 昼休み再評価
export const MIDDAY_REASSESSMENT = {
  SCHEDULED_HOUR: 12,
  SCHEDULED_MINUTE: 15,
} as const;

// 週次レビュー
export const WEEKLY_REVIEW = {
  LOOKBACK_DAYS: 7,
} as const;

// タイムストップ
export const TIME_STOP = {
  MAX_HOLDING_DAYS: 10, // 最大保有営業日数
} as const;
