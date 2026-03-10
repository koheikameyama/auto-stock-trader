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
    takeProfitRatio: 1.05,
    stopLossRatio: 0.98,
    atrMultiplier: 1.0,
    trailingActivationMultiplier: 1.0,
    strategy: "swing" as const,
    trailingStopEnabled: true,
  },

  /** トレンド表示の日数 */
  TREND_DAYS: 30,
} as const;

export type BudgetTier = (typeof DAILY_BACKTEST.BUDGET_TIERS)[number];
