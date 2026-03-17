/**
 * スコアリング・損切り検証の定数
 *
 * 4カテゴリ100点満点:
 * - トレンド品質: 40点
 * - エントリータイミング: 35点
 * - リスク品質: 20点
 * - セクターモメンタム: 5点
 */

/** 4カテゴリ + ゲート スコアリング定数 */
export const SCORING = {
  /** カテゴリ最大点数 */
  CATEGORY_MAX: {
    TREND_QUALITY: 40,
    ENTRY_TIMING: 35,
    RISK_QUALITY: 20,
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
    // リスク品質 (20)
    ATR_STABILITY: 10,
    RANGE_CONTRACTION: 8,
    VOLUME_STABILITY: 2,
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
    MAX_PRICE: 5000,
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

export const SECTOR_MOMENTUM_SCORING = {
  CATEGORY_MAX: 5,
  TIERS: [
    { min: 3.0, score: 5 },
    { min: 1.5, score: 4 },
    { min: 0.5, score: 3 },
    { min: -0.5, score: 2 },
    { min: -2.0, score: 1 },
  ],
  DEFAULT_SCORE: 2,
  MIN_SECTOR_STOCK_COUNT: 3,
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

export const CONTRARIAN = {
  /** 逆行実績の検索期間（日） */
  LOOKBACK_DAYS: 90,
  /** 逆行勝ちとカウントする最低利益率(%) */
  MIN_PROFIT_PCT: 1.5,
  /** ボーナス判定に必要な最低取引見送り日数 */
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

/** スコアリング妥当性ページ */
export const SCORING_VALIDITY = {
  /** 分析対象の過去日数 */
  LOOKBACK_DAYS: 90,
  /** FP/FN一覧の表示件数 */
  FP_FN_DISPLAY_LIMIT: 10,
  /** スコア帯の区分 */
  SCORE_BANDS: [
    { label: "80-100", min: 80, max: 100 },
    { label: "65-79", min: 65, max: 79 },
    { label: "50-64", min: 50, max: 64 },
    { label: "35-49", min: 35, max: 49 },
    { label: "<35", min: 0, max: 34 },
  ],
} as const;

export const STOP_LOSS = {
  MAX_LOSS_PCT: 0.03,
  ATR_MIN_MULTIPLIER: 0.5,
  ATR_MAX_MULTIPLIER: 2.0,
  ATR_DEFAULT_MULTIPLIER: 0.8,
  ATR_ADJUSTED_MULTIPLIER: 1.5,
  SUPPORT_BUFFER_ATR: 0.3,
} as const;

/** 指値カラー幅（ATR連動） */
export const COLLAR = {
  /** ATR% → カラー幅変換の係数 */
  ATR_MULTIPLIER: 1.0,
  /** カラー幅の下限（%） */
  MIN_PCT: 0.01,
  /** カラー幅の上限（%） */
  MAX_PCT: 0.05,
  /** ATR取得不可時のフォールバック（%） */
  FALLBACK_PCT: 0.03,
} as const;

/** リスクベースのポジションサイジング */
export const POSITION_SIZING = {
  /** 1トレードあたりリスク: 総資金の2%（スコア未指定時のデフォルト） */
  RISK_PER_TRADE_PCT: 2,
  /** スコア別リスク%テーブル（降順で最初にマッチしたものを採用） */
  SCORE_RISK_TABLE: [
    { minScore: 80, riskPct: 3.0 }, // Sランク
    { minScore: 65, riskPct: 2.5 }, // Aランク
    { minScore: 50, riskPct: 2.0 }, // Bランク
    { minScore: 0, riskPct: 1.5 }, // Cランク
  ],
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
