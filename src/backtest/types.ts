/**
 * バックテスト型定義（ブレイクアウト戦略用）
 */

// ──────────────────────────────────────────
// ブレイクアウトバックテスト設定
// ──────────────────────────────────────────

export interface BreakoutBacktestConfig {
  startDate: string; // YYYY-MM-DD
  endDate: string; // YYYY-MM-DD
  initialBudget: number;
  maxPositions: number;

  // エントリー
  /** 出来高サージ倍率（dailyVolume / avgVolume25 >= this） */
  triggerThreshold: number;
  /** 高値ルックバック日数 */
  highLookbackDays: number;
  /** high20からの最大許容乖離（ATR倍率）。これ以上離れていたら高値追いとしてスキップ */
  maxChaseAtr: number;

  // ストップロス
  /** SL = entry - ATR × this */
  atrMultiplier: number;
  /** SLハードキャップ（%）— 0.03 = 3% */
  maxLossPct: number;

  // トレーリングストップ
  /** ブレイクイーブン発動 ATR倍率 */
  beActivationMultiplier: number;
  /** トレーリングストップ発動 ATR倍率 */
  tsActivationMultiplier: number;
  /** トレール幅 ATR倍率 */
  trailMultiplier: number;

  // タイムストップ
  /** ベース保有日数 */
  maxHoldingDays: number;
  /** 含み益時の延長上限 */
  maxExtendedHoldingDays: number;

  // ユニバースフィルター
  maxPrice: number;
  minAvgVolume25: number;
  minAtrPct: number;

  // コスト・リスク
  costModelEnabled: boolean;
  priceLimitEnabled: boolean;

  // クールダウン
  cooldownDays: number;

  // スコアフィルター
  /** スコアフィルター設定（省略時はフィルターなし） */
  scoreFilter?: ScoreFilterConfig;

  // エントリーフィルター
  /** 市場トレンドフィルター: 全銘柄のbreadth(SMA25上%)が閾値以上の時のみエントリー */
  marketTrendFilter?: boolean;
  /** 市場breadth閾値 (0〜1、デフォルト: 0.5) */
  marketTrendThreshold?: number;
  /** 確認足エントリー: ブレイクアウト翌日にclose > breakout levelで初めてエントリー */
  confirmationEntry?: boolean;
  /** 確認足＋出来高継続: 確認日の出来高が avgVolume25 以上の場合のみエントリー */
  confirmationVolumeFilter?: boolean;
  /** 指数トレンドフィルター: 日経225などの指数がSMA以上の時のみエントリー */
  indexTrendFilter?: boolean;
  /** 指数SMA期間（デフォルト: 50） */
  indexTrendSmaPeriod?: number;
  /** N225モメンタムフィルター: N225の現在値がN日前より高い場合のみエントリー */
  indexMomentumFilter?: boolean;
  /** N225モメンタム比較日数（デフォルト: 60） */
  indexMomentumDays?: number;
  /** ブレイクアウト強度フィルター: (close - highN) / atr14 >= this でのみエントリー。0=無効 */
  minBreakoutAtr?: number;
  /** 出来高トレンドフィルター: avgVolume5 / avgVolume25 >= this でのみエントリー。1.0=最も緩い */
  volumeTrendThreshold?: number;

  verbose: boolean;
}

// ──────────────────────────────────────────
// シミュレーション結果
// ──────────────────────────────────────────

export type RegimeLevel = "normal" | "elevated" | "high" | "crisis";

export interface SimulatedPosition {
  ticker: string;
  entryDate: string;
  entryPrice: number;
  takeProfitPrice: number;
  stopLossPrice: number;
  quantity: number;
  /** エントリー時の出来高サージ倍率 */
  volumeSurgeRatio: number;
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

export interface BreakoutBacktestResult {
  config: BreakoutBacktestConfig;
  trades: SimulatedPosition[];
  equityCurve: DailyEquity[];
  metrics: PerformanceMetrics;
}

// ──────────────────────────────────────────
// パフォーマンス指標
// ──────────────────────────────────────────

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

// ──────────────────────────────────────────
// スコアフィルター
// ──────────────────────────────────────────

/** スコアフィルター結果 */
export interface ScoreFilterResult {
  total: number; // 0-100
  trend: number; // 0-40
  timing: number; // 0-35
  risk: number; // 0-25
}

/** スコアフィルター設定（バックテスト用） */
export interface ScoreFilterConfig {
  /** フィルター対象カテゴリ */
  category: "total" | "trend" | "timing" | "risk";
  /** 最低スコア閾値 */
  minScore: number;
}
