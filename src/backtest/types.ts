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
  maxPrice: number;
  strategy: "day_trade" | "swing";
  outputFile?: string;
  verbose: boolean;
}

export interface SimulatedPosition {
  ticker: string;
  entryDate: string;
  entryPrice: number;
  takeProfitPrice: number;
  stopLossPrice: number;
  quantity: number;
  rank: "S" | "A" | "B" | "C";
  score: number;
  exitDate: string | null;
  exitPrice: number | null;
  exitReason: "take_profit" | "stop_loss" | "expired" | "still_open" | null;
  pnl: number | null;
  pnlPct: number | null;
  holdingDays: number | null;
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
