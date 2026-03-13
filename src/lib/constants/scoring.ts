/**
 * スコアリング・損切り検証の定数
 *
 * 4カテゴリ100点満点:
 * - テクニカル指標: 65点
 * - チャート・ローソク足パターン: 15点
 * - 流動性: 10点
 * - ファンダメンタルズ: 10点
 */

export const SCORING = {
  CATEGORY_MAX: {
    TECHNICAL: 65,
    PATTERN: 15,
    LIQUIDITY: 10,
    FUNDAMENTAL: 10,
  },

  SUB_MAX: {
    // テクニカル (65点)
    RSI: 12,
    MA: 18,
    VOLUME_CHANGE: 13,
    MACD: 7,
    RELATIVE_STRENGTH: 15,
    // パターン (15点)
    CHART_PATTERN: 10,
    CANDLESTICK: 5,
    // 流動性 (10点)
    TRADING_VALUE: 5,
    SPREAD_PROXY: 3,
    STABILITY: 2,
    // ファンダメンタルズ (10点)
    PER: 4,
    PBR: 3,
    PROFITABILITY: 2,
    MARKET_CAP: 1,
  },

  THRESHOLDS: {
    S_RANK: 80,
    A_RANK: 65,
    B_RANK: 50,
  },

  DISQUALIFY: {
    MAX_PRICE: 3000,
    MAX_DAILY_SPREAD_PCT: 0.05,
    MAX_WEEKLY_VOLATILITY: 8,
    EARNINGS_DAYS_BEFORE: 5,
    EARNINGS_DAYS_AFTER: 2,
    EX_DIVIDEND_DAYS_BEFORE: 2,
    EX_DIVIDEND_DAYS_AFTER: 1,
  },

  WEEKLY_TREND: {
    PENALTY: 8,
    MIN_WEEKLY_BARS: 14,
  },

  RELATIVE_STRENGTH: {
    MAX_SCORE: 15,
    MIN_SECTOR_STOCKS: 2,
  },

  LIQUIDITY: {
    TRADING_VALUE_TIERS: [500_000_000, 300_000_000, 100_000_000, 50_000_000],
    SPREAD_PROXY_TIERS: [0.01, 0.02, 0.03, 0.05],
    STABILITY_CV_TIERS: [0.3, 0.5, 0.7],
  },

  FUNDAMENTAL: {
    PER_TIERS: [
      { min: 5, max: 15, score: 4 },
      { min: 15, max: 30, score: 3 },
      { min: 0, max: 5, score: 2 },
      { min: 30, max: 50, score: 1 },
    ],
    PER_DEFAULT: 0,
    PBR_TIERS: [
      { min: 0.5, max: 1.5, score: 3 },
      { min: 1.5, max: 3.0, score: 2 },
      { min: 0, max: 0.5, score: 1 },
      { min: 3.0, max: 5.0, score: 1 },
    ],
    PBR_DEFAULT: 0,
    PBR_OVER_5: 0,
    EPS_STRONG_RATIO: 0.05,
    EPS_POSITIVE: 1,
    EPS_NEGATIVE: 0,
    EPS_NULL: 0,
    MARKET_CAP_TIERS: [
      { min: 200_000_000_000, score: 1 },
    ],
    MARKET_CAP_DEFAULT: 0,
  },

  VOLUME_DIRECTION: {
    LOOKBACK_DAYS: 5,
    OBV_PERIOD: 10,
    ACCUMULATION_THRESHOLD: 0.6,
    DISTRIBUTION_THRESHOLD: 0.4,
    MIN_DATA_DAYS: 3,
    SCORES: {
      HIGH_VOLUME: { accumulation: 10, neutral: 7, distribution: 3 },
      MEDIUM_VOLUME: { accumulation: 8, neutral: 6, distribution: 3 },
      NORMAL_VOLUME: { accumulation: 6, neutral: 5, distribution: 4 },
    },
  },

  MAX_CANDIDATES_FOR_AI: 20,
  MIN_CANDIDATES_FOR_AI: 5,
} as const;

export const GHOST_TRADING = {
  /** Ghost追跡対象の最低スコア */
  MIN_SCORE_FOR_TRACKING: 60,
  /** AI後悔分析の最大件数/日 */
  MAX_AI_REGRET_ANALYSIS: 5,
  /** AI分析トリガーの最低利益率(%) */
  MIN_PROFIT_PCT_FOR_ANALYSIS: 1.0,
  /** AI並列数 */
  AI_CONCURRENCY: 3,
} as const;

export const CONTRARIAN = {
  /** 逆行実績の検索期間（日） */
  LOOKBACK_DAYS: 90,
  /** 逆行勝ちとカウントする最低利益率(%) */
  MIN_PROFIT_PCT: 1.5,
  /** ボーナス判定に必要な最低市場停止日数 */
  MIN_SAMPLE_DAYS: 4,
  /** Slackレポートの最大表示件数 */
  MAX_REPORT_WINNERS: 10,
  /** ボーナスポイントの段階（勝率条件付き） */
  BONUS_TIERS: [
    { minWins: 4, minWinRate: 0.5, bonus: 4 },
    { minWins: 3, minWinRate: 0.4, bonus: 2 },
  ],
} as const;

export const SCORING_ACCURACY_REPORT = {
  /** 週次レポートの振り返り期間（日） */
  WEEKLY_LOOKBACK_DAYS: 7,
  /** 月次ローリング統計の期間（日） */
  MONTHLY_LOOKBACK_DAYS: 30,
  /** ゴースト利益の「見逃し」閾値（%） */
  MISSED_PROFIT_THRESHOLD: 1.0,
  /** Slack通知の見逃し銘柄表示件数上限 */
  MAX_MISSED_DISPLAY: 5,
} as const;

export const STOP_LOSS = {
  MAX_LOSS_PCT: 0.03,
  ATR_MIN_MULTIPLIER: 0.5,
  ATR_MAX_MULTIPLIER: 2.0,
  ATR_DEFAULT_MULTIPLIER: 1.0,
  ATR_ADJUSTED_MULTIPLIER: 1.5,
  SUPPORT_BUFFER_ATR: 0.3,
} as const;

/** リスクベースのポジションサイジング */
export const POSITION_SIZING = {
  /** 1トレードあたりリスク: 総資金の2% */
  RISK_PER_TRADE_PCT: 2,
} as const;

/** ギャップリスク推定パラメータ */
export const GAP_RISK = {
  /** MAG（最大想定ギャップ）算出に使う過去データ日数 */
  LOOKBACK_DAYS: 60,
  /** ATRベースの最低ギャップ想定倍率 */
  ATR_FLOOR_MULTIPLIER: 1.5,
  /** ATRベースの上限倍率（異常値カット） */
  ATR_CAP_MULTIPLIER: 3.0,
} as const;
