/**
 * スコアリング・損切り検証の定数
 *
 * 4カテゴリ100点満点:
 * - テクニカル指標: 40点
 * - チャート・ローソク足パターン: 20点
 * - 流動性: 25点
 * - ファンダメンタルズ: 15点
 */

export const SCORING = {
  // カテゴリ配点
  CATEGORY_MAX: {
    TECHNICAL: 40,
    PATTERN: 20,
    LIQUIDITY: 25,
    FUNDAMENTAL: 15,
  },

  // サブ項目配点
  SUB_MAX: {
    // テクニカル (40点)
    RSI: 10,
    MA: 15,
    VOLUME_CHANGE: 10,
    MACD: 5,
    // パターン (20点)
    CHART_PATTERN: 14,
    CANDLESTICK: 6,
    // 流動性 (25点)
    TRADING_VALUE: 10,
    SPREAD_PROXY: 8,
    STABILITY: 7,
    // ファンダメンタルズ (15点)
    PER: 5,
    PBR: 4,
    PROFITABILITY: 4,
    MARKET_CAP: 2,
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
    EARNINGS_DAYS_BEFORE: 5,       // 決算前N日は即死
    EARNINGS_DAYS_AFTER: 2,        // 決算後N日は即死
    EX_DIVIDEND_DAYS_BEFORE: 2,    // 配当落ち日前N日は即死
    EX_DIVIDEND_DAYS_AFTER: 1,     // 配当落ち日後N日は即死
  },

  // 流動性閾値
  LIQUIDITY: {
    TRADING_VALUE_TIERS: [500_000_000, 300_000_000, 100_000_000, 50_000_000],
    SPREAD_PROXY_TIERS: [0.01, 0.02, 0.03, 0.05],
    STABILITY_CV_TIERS: [0.3, 0.5, 0.7],
  },

  // 週足トレンド整合性チェック
  WEEKLY_TREND: {
    PENALTY: 7,          // 日足↑ × 週足↓ 矛盾時の減点（MA 13点中）
    MIN_WEEKLY_BARS: 14, // SMA13算出に必要な最低週足本数
  },

  // ファンダメンタルズ閾値
  FUNDAMENTAL: {
    // PER閾値（点数は高い順に評価）
    PER_TIERS: [
      { min: 5, max: 15, score: 5 },   // 割安〜適正
      { min: 15, max: 30, score: 4 },  // 小型株として妥当
      { min: 0, max: 5, score: 3 },    // 安すぎ（構造的問題の可能性）
      { min: 30, max: 50, score: 2 },  // やや割高
    ],
    PER_DEFAULT: 0,       // 上記に該当しない or null → 0点

    // PBR閾値
    PBR_TIERS: [
      { min: 0.5, max: 1.5, score: 4 },
      { min: 1.5, max: 3.0, score: 3 },
      { min: 0, max: 0.5, score: 2 },
      { min: 3.0, max: 5.0, score: 1 },
    ],
    PBR_DEFAULT: 2,       // null → 2点（中立）
    PBR_OVER_5: 0,        // PBR > 5 → 0点

    // 収益性（EPS基準）
    EPS_STRONG_RATIO: 0.05,  // EPS >= 株価×5% → 4点
    EPS_GOOD_RATIO: 0.02,    // EPS >= 株価×2% → 3点
    EPS_POSITIVE: 2,          // EPS > 0 → 2点
    EPS_NEGATIVE: 0,          // EPS ≤ 0 → 0点
    EPS_NULL: 2,              // null → 2点（中立）

    // 時価総額（円）
    MARKET_CAP_TIERS: [
      { min: 200_000_000_000, score: 2 },  // ≥ 200億円
      { min: 50_000_000_000, score: 1 },   // ≥ 50億円
    ],
    MARKET_CAP_DEFAULT: 0,    // < 50億円 or null → 0点
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

/** リスクベースのポジションサイジング */
export const POSITION_SIZING = {
  /** 1トレードあたりリスク: 総資金の2% */
  RISK_PER_TRADE_PCT: 2,
} as const;
