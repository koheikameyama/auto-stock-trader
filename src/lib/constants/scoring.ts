/**
 * スコアリング・損切り検証の定数
 *
 * 3カテゴリ100点満点:
 * - テクニカル指標: 40点
 * - チャート・ローソク足パターン: 30点
 * - 流動性: 30点
 */

export const SCORING = {
  // カテゴリ配点
  CATEGORY_MAX: {
    TECHNICAL: 40,
    PATTERN: 30,
    LIQUIDITY: 30,
  },

  // サブ項目配点
  SUB_MAX: {
    // テクニカル (40点)
    RSI: 15,
    MA: 15,
    VOLUME_CHANGE: 10,
    // パターン (30点)
    CHART_PATTERN: 22,
    CANDLESTICK: 8,
    // 流動性 (30点)
    TRADING_VALUE: 12,
    SPREAD_PROXY: 10,
    STABILITY: 8,
  },

  // 閾値
  THRESHOLDS: {
    S_RANK: 80,
    A_RANK: 65,
    B_RANK: 50,
  },

  // 即死ルール
  DISQUALIFY: {
    MAX_PRICE: 1000,
    MAX_DAILY_SPREAD_PCT: 0.05,
    MAX_WEEKLY_VOLATILITY: 8,
  },

  // 流動性閾値
  LIQUIDITY: {
    TRADING_VALUE_TIERS: [500_000_000, 300_000_000, 100_000_000, 50_000_000],
    SPREAD_PROXY_TIERS: [0.01, 0.02, 0.03, 0.05],
    STABILITY_CV_TIERS: [0.3, 0.5, 0.7],
  },

  // 週足トレンド整合性チェック
  WEEKLY_TREND: {
    PENALTY: 8,          // 日足↑ × 週足↓ 矛盾時の減点（MA 15点中）
    MIN_WEEKLY_BARS: 14, // SMA13算出に必要な最低週足本数
  },

  // 出来高方向性分析
  VOLUME_DIRECTION: {
    LOOKBACK_DAYS: 5,              // 買い/売り出来高の分析期間
    OBV_PERIOD: 10,                // OBVトレンド算出期間
    ACCUMULATION_THRESHOLD: 0.6,   // 買い出来高比率がこれ以上 → 買い集め
    DISTRIBUTION_THRESHOLD: 0.4,   // 買い出来高比率がこれ以下 → 投げ売り
    MIN_DATA_DAYS: 3,              // 方向性分析に必要な最低日数
    // 出来高×方向性のスコア表（volumeRatio別）
    SCORES: {
      HIGH_VOLUME: { accumulation: 10, neutral: 7, distribution: 3 },   // ratio >= 2.0
      MEDIUM_VOLUME: { accumulation: 8, neutral: 6, distribution: 3 },  // ratio >= 1.5
      NORMAL_VOLUME: { accumulation: 6, neutral: 5, distribution: 4 },  // ratio >= 1.0
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
  MIN_PROFIT_PCT: 0.5,
  /** Slackレポートの最大表示件数 */
  MAX_REPORT_WINNERS: 10,
  /** ボーナスポイントの段階 */
  BONUS_TIERS: [
    { minWins: 4, bonus: 7 },
    { minWins: 3, bonus: 5 },
    { minWins: 2, bonus: 3 },
  ],
} as const;

export const STOP_LOSS = {
  MAX_LOSS_PCT: 0.03,
  ATR_MIN_MULTIPLIER: 0.5,
  ATR_MAX_MULTIPLIER: 2.0,
  ATR_DEFAULT_MULTIPLIER: 1.0,
  ATR_ADJUSTED_MULTIPLIER: 1.5,
  SUPPORT_BUFFER_ATR: 0.3,
} as const;
