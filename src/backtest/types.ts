/**
 * バックテスト型定義
 */

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
  strategy: "day_trade" | "swing";
  trailingStopEnabled: boolean;
  costModelEnabled: boolean;
  priceLimitEnabled: boolean;
  gapRiskEnabled: boolean;
  outputFile?: string;
  verbose: boolean;
}

export type RegimeLevel = "normal" | "elevated" | "high" | "crisis";

export interface SimulatedPosition {
  ticker: string;
  entryDate: string;
  entryPrice: number;
  takeProfitPrice: number;
  stopLossPrice: number;
  quantity: number;
  rank: "S" | "A" | "B" | "C";
  score: number;
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
