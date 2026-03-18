/**
 * バックテスト型定義
 */

import type { TradingStrategy } from "../core/market-regime";
import type { ScoringRank } from "../core/scoring";

export interface BacktestConfig {
  tickers: string[];
  startDate: string; // YYYY-MM-DD
  endDate: string; // YYYY-MM-DD
  initialBudget: number;
  maxPositions: number;
  scoreThreshold: number;
  takeProfitRatio: number;
  stopLossRatio: number;
  atrMultiplier: number;
  trailingActivationMultiplier: number;
  maxPrice: number;
  strategy: TradingStrategy;
  costModelEnabled: boolean;
  priceLimitEnabled: boolean;
  gapRiskEnabled: boolean;
  cooldownDays: number;
  overrideTpSl: boolean;
  trailMultiplier?: number;
  /** トレンドプレフィルター: Price > SMA25 && SMA25 > SMA75 を要求 */
  trendFilterEnabled: boolean;
  /** プルバックエントリー: RSI < 60 AND SMA25乖離 <= 2% */
  pullbackFilterEnabled: boolean;
  /** ボラティリティフィルター: ATR% > MIN_ATR_PCT の銘柄のみ */
  volatilityFilterEnabled: boolean;
  /** ボラティリティフィルター閾値（ATR%）。未指定時は DAILY_BACKTEST.UNIVERSE_FILTER.MIN_ATR_PCT */
  minAtrPct?: number;
  /** RSフィルター: RS > MIN_RS_SCORE の銘柄のみ */
  rsFilterEnabled: boolean;
  /** タイムストップ日数オーバーライド（デフォルト: TIME_STOP.MAX_HOLDING_DAYS） */
  maxHoldingDays?: number;
  /** 指値カラー幅（現在価格からの最大乖離率）。デフォルト: 0.03 (3%) */
  collarPct?: number;
  outputFile?: string;
  /** 取引見送り日（shouldTrade=false）のセット。ペーパートレード用 */
  shouldTradeSkipDates?: Set<string>;
  verbose: boolean;
}

export type RegimeLevel = "normal" | "elevated" | "high" | "crisis";

export interface ScoreBreakdown {
  trendQuality: {
    total: number;
    maAlignment: number;
    weeklyTrend: number;
    trendContinuity: number;
  };
  entryTiming: {
    total: number;
    pullbackDepth: number;
    priorBreakout: number;
    candlestickSignal: number;
  };
  riskQuality: {
    total: number;
    atrStability: number;
    rangeContraction: number;
    volumeStability: number;
  };
  sectorMomentum: number;
}

export interface SimulatedPosition {
  ticker: string;
  entryDate: string;
  entryPrice: number;
  takeProfitPrice: number;
  stopLossPrice: number;
  quantity: number;
  rank: ScoringRank;
  score: number;
  scoreBreakdown: ScoreBreakdown | null;
  regime: RegimeLevel | null;
  maxHighDuringHold: number;
  trailingStopPrice: number | null;
  entryAtr: number | null;
  exitDate: string | null;
  exitPrice: number | null;
  exitReason:
    | "take_profit"
    | "stop_loss"
    | "trailing_profit"
    | "time_stop"
    | "defensive_exit"
    | "expired"
    | "still_open"
    | null;
  pnl: number | null;
  pnlPct: number | null;
  holdingDays: number | null;
  limitLockDays: number;
  // 取引コスト関連
  entryCommission: number | null;
  exitCommission: number | null;
  totalCost: number | null;
  tax: number | null;
  grossPnl: number | null;
  netPnl: number | null;
}

export interface DailyEquity {
  date: string;
  cash: number;
  positionsValue: number;
  totalEquity: number;
  openPositionCount: number;
}

export interface BacktestResult {
  config: BacktestConfig;
  trades: SimulatedPosition[];
  equityCurve: DailyEquity[];
  metrics: PerformanceMetrics;
}

export interface PerformanceMetrics {
  totalTrades: number;
  wins: number;
  losses: number;
  stillOpen: number;
  winRate: number;
  avgWinPct: number;
  avgLossPct: number;
  profitFactor: number;
  maxDrawdown: number;
  maxDrawdownPeriod: { start: string; end: string } | null;
  sharpeRatio: number | null;
  avgHoldingDays: number;
  totalPnl: number;
  totalReturnPct: number;
  byRank: Record<string, RankMetrics>;
  byRegime: Record<string, RankMetrics>;
  // 取引コスト関連
  totalCommission: number;
  totalTax: number;
  totalGrossPnl: number;
  totalNetPnl: number;
  netReturnPct: number;
  costImpactPct: number;
  expectancy: number;
  riskRewardRatio: number;
  // 約定率
  ordersPlaced: number;
  ordersFilled: number;
  fillRate: number;
}

export interface RankMetrics {
  totalTrades: number;
  wins: number;
  losses: number;
  winRate: number;
  avgPnlPct: number;
}

export interface SensitivityResult {
  parameter: string;
  value: number;
  metrics: PerformanceMetrics;
}
