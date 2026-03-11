/**
 * 日次バックテスト定数
 */

export const DAILY_BACKTEST = {
  /** 予算ティア（4段階） — maxPrice = budget / 100（1ロット100株） */
  BUDGET_TIERS: [
    { label: "10万", budget: 100_000, maxPrice: 1_000, maxPositions: 3 },
    { label: "30万", budget: 300_000, maxPrice: 3_000, maxPositions: 3 },
    { label: "50万", budget: 500_000, maxPrice: 5_000, maxPositions: 3 },
    { label: "100万", budget: 1_000_000, maxPrice: 10_000, maxPositions: 5 },
  ],

  /** シミュレーション期間（ローリング） */
  LOOKBACK_MONTHS: 6,

  /** ScoringRecord蓄積がこの月数未満ならフォールバックモードを使用 */
  MIN_SCORING_RECORD_MONTHS: 3,

  /** ScoringRecordからのティッカー選定 */
  TICKER_SELECTION: {
    LOOKBACK_DAYS: 30,
    MIN_TICKERS: 5,
    TARGET_RANKS: ["S"],
    FALLBACK_RANKS: ["S", "A"],
  },

  /** デフォルトシミュレーションパラメータ */
  DEFAULT_PARAMS: {
    scoreThreshold: 65,
    takeProfitRatio: 1.50,    // overrideTpSl=true 時のみ使用
    stopLossRatio: 0.98,      // overrideTpSl=true 時のみ使用
    atrMultiplier: 1.0,       // overrideTpSl=true 時のみ使用
    trailingActivationMultiplier: 1.5,  // TRAILING_STOP定数と同期
    strategy: "swing" as const,
    overrideTpSl: false,      // false = 本番ロジック（calculateEntryCondition の値をそのまま使用）
    cooldownDays: 5,          // ストップアウト後の同一銘柄再エントリー禁止日数
  },

  /** トレンド表示の日数 */
  TREND_DAYS: 30,
} as const;

export type BudgetTier = (typeof DAILY_BACKTEST.BUDGET_TIERS)[number];
