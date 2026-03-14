/**
 * スコアリング・損切り検証の定数
 *
 * 新3カテゴリ100点満点:
 * - トレンド品質: 40点
 * - エントリータイミング: 35点
 * - リスク品質: 25点
 */

/** @deprecated 旧4カテゴリ定数（移行完了後に削除） */
export const SCORING_V1 = {
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

/** 新3カテゴリ + ゲート スコアリング定数 */
export const SCORING = {
  /** カテゴリ最大点数 */
  CATEGORY_MAX: {
    TREND_QUALITY: 40,
    ENTRY_TIMING: 35,
    RISK_QUALITY: 25,
  },

  /** サブスコア最大点数 */
  SUB_MAX: {
    // トレンド品質 (40)
    MA_ALIGNMENT: 18,
    WEEKLY_TREND: 12,
    TREND_CONTINUITY: 10,
    // エントリータイミング (35)
    PULLBACK_DEPTH: 15,
    BREAKOUT: 12,
    CANDLESTICK_SIGNAL: 8,
    // リスク品質 (25)
    ATR_STABILITY: 10,
    RANGE_CONTRACTION: 8,
    VOLUME_STABILITY: 7,
  },

  /** ランク閾値 */
  THRESHOLDS: {
    S_RANK: 80,
    A_RANK: 65,
    B_RANK: 50,
    C_RANK: 35,
  },

  /** ゲート（即死ルール） */
  GATES: {
    MIN_AVG_VOLUME_25: 50_000,
    MAX_PRICE: 3000,
    MIN_ATR_PCT: 1.5,
    EARNINGS_DAYS_BEFORE: 5,
    EX_DIVIDEND_DAYS_BEFORE: 3,
  },

  /** トレンド品質パラメータ */
  TREND: {
    CONTINUITY_SWEET_MIN: 10,
    CONTINUITY_SWEET_MAX: 30,
    CONTINUITY_MATURE_MAX: 50,
    WEEKLY_SMA13_FLAT_THRESHOLD: 0.5,
  },

  /** エントリータイミングパラメータ */
  ENTRY: {
    PULLBACK_NEAR_MIN: -1,
    PULLBACK_NEAR_MAX: 2,
    PULLBACK_DEEP_THRESHOLD: -3,
    BREAKOUT_VOLUME_RATIO: 1.5,
    BREAKOUT_LOOKBACK_20: 20,
    BREAKOUT_LOOKBACK_10: 10,
  },

  /** リスク品質パラメータ */
  RISK: {
    ATR_CV_EXCELLENT: 0.15,
    ATR_CV_GOOD: 0.25,
    ATR_CV_FAIR: 0.35,
    BB_SQUEEZE_STRONG: 20,
    BB_SQUEEZE_MODERATE: 40,
    BB_WIDTH_LOOKBACK: 60,
    VOLUME_CV_STABLE: 0.5,
    VOLUME_CV_MODERATE: 0.8,
    VOLUME_CV_PERIOD: 25,
  },

  MAX_CANDIDATES_FOR_AI: 20,
  MIN_CANDIDATES_FOR_AI: 5,
} as const;

export const SCORING_ACCURACY = {
  /** 追跡対象の最低スコア */
  MIN_SCORE_FOR_TRACKING: 60,
  /** FN分析（見逃し）の最大件数/日 */
  MAX_AI_FN_ANALYSIS: 5,
  /** FP分析（誤買い）の最大件数/日 */
  MAX_AI_FP_ANALYSIS: 5,
  /** FN分析トリガーの最低利益率(%) */
  MIN_PROFIT_PCT_FOR_FN_ANALYSIS: 1.0,
  /** FP分析トリガーの最低損失率(%) */
  MIN_LOSS_PCT_FOR_FP_ANALYSIS: 1.0,
  /** AI並列数 */
  AI_CONCURRENCY: 3,
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
