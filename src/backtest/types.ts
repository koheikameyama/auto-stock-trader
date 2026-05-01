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
  /** クランプ発生時にスキップ（true = 本番entry-executorと同じ挙動） */
  skipIfClamped?: boolean;

  // トレーリングストップ
  /** ブレイクイーブン発動 ATR倍率 */
  beActivationMultiplier: number;
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
  /** 最低売買代金（円）。price × avgVolume25 >= this。0=無効 */
  minTurnover: number;
  /** 最低株価（円）。0=無効 */
  minPrice: number;

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
  /** 指数SMAフィルターOFF転換バッファ（%）: 0.01=1%。SMA*(1-this)以下でOFF。デフォルト: 0 */
  indexTrendOffBufferPct?: number;
  /** 指数SMAフィルターON転換バッファ（%）: 0.005=0.5%。SMA*(1+this)以上でON。デフォルト: 0 */
  indexTrendOnBufferPct?: number;
  /** N225モメンタムフィルター: N225の現在値がN日前より高い場合のみエントリー */
  indexMomentumFilter?: boolean;
  /** N225モメンタム比較日数（デフォルト: 60） */
  indexMomentumDays?: number;
  /** ブレイクアウト強度フィルター: (close - highN) / atr14 >= this でのみエントリー。0=無効 */
  minBreakoutAtr?: number;
  /** 出来高トレンドフィルター: avgVolume5 / avgVolume25 >= this でのみエントリー。1.0=最も緩い */
  volumeTrendThreshold?: number;

  verbose: boolean;

  /** 1銘柄あたりの資金上限（getDynamicMaxPositionPct）を適用するか。デフォルト: true */
  positionCapEnabled?: boolean;
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
  minLowDuringHold: number;
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
    | "rotation_exit"
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
  /** その日に追加された資金額（月次追加シミュレーション用） */
  capitalAdded?: number;
}

export interface BreakoutBacktestResult {
  config: BreakoutBacktestConfig;
  trades: SimulatedPosition[];
  equityCurve: DailyEquity[];
  metrics: PerformanceMetrics;
}

// ──────────────────────────────────────────
// Combined バックテスト 戦略キー
// ──────────────────────────────────────────

export const BREAKDOWN_KEYS = ["bo", "gu", "wb", "psc"] as const;
export type BreakdownKey = (typeof BREAKDOWN_KEYS)[number];

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

// ──────────────────────────────────────────
// ギャップアップバックテスト設定
// ──────────────────────────────────────────

export interface GapUpBacktestConfig {
  startDate: string;
  endDate: string;
  initialBudget: number;
  maxPositions: number;

  gapMinPct: number;
  volSurgeRatio: number;

  atrMultiplier: number;
  maxLossPct: number;

  beActivationMultiplier: number;
  trailMultiplier: number;

  maxHoldingDays: number;
  maxExtendedHoldingDays: number;

  maxPrice: number;
  minAvgVolume25: number;
  minAtrPct: number;
  /** 最低売買代金（円）。price × avgVolume25 >= this。0=無効 */
  minTurnover: number;
  /** 最低株価（円）。0=無効 */
  minPrice: number;

  costModelEnabled: boolean;
  priceLimitEnabled: boolean;

  cooldownDays: number;

  marketTrendFilter?: boolean;
  marketTrendThreshold?: number;
  /** breadth上限 — この値超過の日は過熱判定でエントリーをスキップ（省略時は上限なし） */
  marketTrendUpperCap?: number;
  indexTrendFilter?: boolean;
  indexTrendSmaPeriod?: number;
  indexTrendOffBufferPct?: number;
  indexTrendOnBufferPct?: number;

  verbose: boolean;

  /** 1銘柄あたりの資金上限（getDynamicMaxPositionPct）を適用するか。デフォルト: true */
  positionCapEnabled?: boolean;

  /** 1日あたりの最大エントリー件数。省略時=無制限 */
  maxDailyEntries?: number;

  /** シグナルソート方法。"gapvol"=gapPct×vol(デフォルト), "rr"=RR比, "volume"=出来高サージ */
  signalSortMethod?: "gapvol" | "rr" | "volume";

  /** vol >= この倍率のとき gap 条件を gapMinPctRelaxed に緩和。省略時=無効 */
  gapRelaxVolThreshold?: number;
  /** gapRelaxVolThreshold 超時の緩和 gap 閾値。省略時=gapMinPct と同値 */
  gapMinPctRelaxed?: number;

  /**
   * 出口モード。
   * - "trail" (default): 既存のBE/トレール+タイムストップ
   * - "next_open": エントリー翌営業日の始値で無条件クローズ
   * - "next_close": エントリー翌営業日の終値で無条件クローズ
   * - "day2_close": エントリー2営業日後の終値で無条件クローズ
   *
   * 固定モードでも初日のSL（ATR/maxLossPct）は有効。BE・トレール・タイムストップは無効化。
   */
  exitMode?: "trail" | "next_open" | "next_close" | "day2_close";
}

export interface GapUpBacktestResult {
  config: GapUpBacktestConfig;
  trades: SimulatedPosition[];
  equityCurve: DailyEquity[];
  metrics: PerformanceMetrics;
}

// ──────────────────────────────────────────
// 週足レンジブレイクバックテスト設定
// ──────────────────────────────────────────

export interface WeeklyBreakBacktestConfig {
  startDate: string;
  endDate: string;
  initialBudget: number;
  maxPositions: number;

  /** N週高値ルックバック（週数） */
  weeklyHighLookback: number;
  /** 週足出来高サージ倍率 */
  weeklyVolSurgeRatio: number;

  atrMultiplier: number;
  maxLossPct: number;

  beActivationMultiplier: number;
  trailMultiplier: number;

  maxHoldingDays: number;
  maxExtendedHoldingDays: number;

  maxPrice: number;
  minAvgVolume25: number;
  minAtrPct: number;
  minTurnover: number;
  minPrice: number;

  /** 最低時価総額（億円単位、省略時はフィルターなし）。大型株universeで使用 */
  minMarketCap?: number;

  costModelEnabled: boolean;
  priceLimitEnabled: boolean;

  cooldownDays: number;

  marketTrendFilter?: boolean;
  marketTrendThreshold?: number;
  /** breadth上限 — この値超過の日は過熱判定でエントリーをスキップ（省略時は上限なし） */
  marketTrendUpperCap?: number;
  indexTrendFilter?: boolean;
  indexTrendSmaPeriod?: number;
  indexTrendOffBufferPct?: number;
  indexTrendOnBufferPct?: number;

  verbose: boolean;
  positionCapEnabled?: boolean;

  /** 1日あたりの最大エントリー件数。省略時=無制限 */
  maxDailyEntries?: number;
}

export interface WeeklyBreakBacktestResult {
  config: WeeklyBreakBacktestConfig;
  trades: SimulatedPosition[];
  equityCurve: DailyEquity[];
  metrics: PerformanceMetrics;
}

// ──────────────────────────────────────────
// モメンタムバックテスト設定
// ──────────────────────────────────────────

export interface MomentumBacktestConfig {
  startDate: string;
  endDate: string;
  initialBudget: number;
  maxPositions: number;

  /** リターン計測ルックバック（営業日） */
  lookbackDays: number;
  /** 保有する上位銘柄数 */
  topN: number;
  /** リバランス頻度（営業日） */
  rebalanceDays: number;
  /** 最低リターン閾値（%） */
  minReturnPct: number;

  atrMultiplier: number;
  maxLossPct: number;

  beActivationMultiplier: number;
  trailMultiplier: number;

  maxHoldingDays: number;
  maxExtendedHoldingDays: number;

  maxPrice: number;
  minAvgVolume25: number;
  minAtrPct: number;
  minTurnover: number;
  minPrice: number;

  /** 最低時価総額（億円単位、省略時はフィルターなし）。大型株universeで使用 */
  minMarketCap?: number;

  costModelEnabled: boolean;
  priceLimitEnabled: boolean;

  cooldownDays: number;

  marketTrendFilter?: boolean;
  marketTrendThreshold?: number;
  /** breadth上限 — この値超過の日は過熱判定でエントリーをスキップ（省略時は上限なし） */
  marketTrendUpperCap?: number;
  indexTrendFilter?: boolean;
  indexTrendSmaPeriod?: number;
  indexTrendOffBufferPct?: number;
  indexTrendOnBufferPct?: number;

  verbose: boolean;
  positionCapEnabled?: boolean;
}

export interface MomentumBacktestResult {
  config: MomentumBacktestConfig;
  trades: SimulatedPosition[];
  equityCurve: DailyEquity[];
  metrics: PerformanceMetrics;
}

// ──────────────────────────────────────────
// 決算ギャップバックテスト設定
// ──────────────────────────────────────────

export interface EarningsGapBacktestConfig {
  startDate: string;
  endDate: string;
  initialBudget: number;
  maxPositions: number;

  gapMinPct: number;
  volSurgeRatio: number;

  atrMultiplier: number;
  maxLossPct: number;

  beActivationMultiplier: number;
  trailMultiplier: number;

  maxHoldingDays: number;
  maxExtendedHoldingDays: number;

  maxPrice: number;
  minAvgVolume25: number;
  minAtrPct: number;
  minTurnover: number;
  minPrice: number;

  costModelEnabled: boolean;
  priceLimitEnabled: boolean;

  cooldownDays: number;

  marketTrendFilter?: boolean;
  marketTrendThreshold?: number;
  /** breadth上限 — この値超過の日は過熱判定でエントリーをスキップ（省略時は上限なし） */
  marketTrendUpperCap?: number;
  indexTrendFilter?: boolean;
  indexTrendSmaPeriod?: number;
  indexTrendOffBufferPct?: number;
  indexTrendOnBufferPct?: number;

  verbose: boolean;
  positionCapEnabled?: boolean;
}

export interface EarningsGapBacktestResult {
  config: EarningsGapBacktestConfig;
  trades: SimulatedPosition[];
  equityCurve: DailyEquity[];
  metrics: PerformanceMetrics;
}

// ──────────────────────────────────────────
// スクイーズブレイクアウトバックテスト設定
// ──────────────────────────────────────────

export interface SqueezeBreakoutBacktestConfig {
  startDate: string;
  endDate: string;
  initialBudget: number;
  maxPositions: number;

  /** BB幅パーセンタイル閾値（この%以下をスクイーズとみなす） */
  bbSqueezePercentile: number;
  /** BB期間 */
  bbPeriod: number;
  /** パーセンタイル計算のルックバック日数 */
  bbLookback: number;
  /** 出来高サージ倍率 */
  volSurgeRatio: number;

  atrMultiplier: number;
  maxLossPct: number;

  beActivationMultiplier: number;
  trailMultiplier: number;

  maxHoldingDays: number;
  maxExtendedHoldingDays: number;

  maxPrice: number;
  minAvgVolume25: number;
  minAtrPct: number;
  minTurnover: number;
  minPrice: number;

  costModelEnabled: boolean;
  priceLimitEnabled: boolean;

  cooldownDays: number;

  marketTrendFilter?: boolean;
  marketTrendThreshold?: number;
  /** breadth上限 — この値超過の日は過熱判定でエントリーをスキップ（省略時は上限なし） */
  marketTrendUpperCap?: number;
  indexTrendFilter?: boolean;
  indexTrendSmaPeriod?: number;
  indexTrendOffBufferPct?: number;
  indexTrendOnBufferPct?: number;

  verbose: boolean;
  positionCapEnabled?: boolean;
}

export interface SqueezeBreakoutBacktestResult {
  config: SqueezeBreakoutBacktestConfig;
  trades: SimulatedPosition[];
  equityCurve: DailyEquity[];
  metrics: PerformanceMetrics;
}

// ──────────────────────────────────────────
// MA押し目買いバックテスト設定
// ──────────────────────────────────────────

export interface MaPullbackBacktestConfig {
  startDate: string;
  endDate: string;
  initialBudget: number;
  maxPositions: number;

  // エントリー（固定パラメータ）
  /** 押し目判定MA期間 */
  maPeriod: number;
  /** MAタッチバッファ（low <= MA × (1 + this)） */
  maTouchBuffer: number;
  /** トレンドフィルターMA期間 */
  trendMaPeriod: number;
  /** 直近高値更新ルックバック日数 */
  recentHighLookback: number;
  /** 出来高干上がり倍率 */
  volumeDryupRatio: number;

  // ストップロス
  atrMultiplier: number;
  maxLossPct: number;

  // トレーリングストップ（WFグリッド対象）
  beActivationMultiplier: number;
  trailMultiplier: number;

  // タイムストップ
  maxHoldingDays: number;
  maxExtendedHoldingDays: number;

  // ユニバースフィルター
  maxPrice: number;
  minAvgVolume25: number;
  minAtrPct: number;
  minTurnover: number;
  minPrice: number;

  // コスト・リスク
  costModelEnabled: boolean;
  priceLimitEnabled: boolean;

  // クールダウン
  cooldownDays: number;

  // マーケットフィルター
  marketTrendFilter?: boolean;
  marketTrendThreshold?: number;
  indexTrendFilter?: boolean;
  indexTrendSmaPeriod?: number;
  indexTrendOffBufferPct?: number;
  indexTrendOnBufferPct?: number;

  verbose: boolean;
  positionCapEnabled?: boolean;
  maxDailyEntries?: number;
}

export interface MaPullbackBacktestResult {
  config: MaPullbackBacktestConfig;
  trades: SimulatedPosition[];
  equityCurve: DailyEquity[];
  metrics: PerformanceMetrics;
}

// ──────────────────────────────────────────
// ギャップダウンリバーサルバックテスト設定
// ──────────────────────────────────────────

export interface GapDownReversalBacktestConfig {
  startDate: string;
  endDate: string;
  initialBudget: number;
  maxPositions: number;

  gapMinPct: number;
  volSurgeRatio: number;

  atrMultiplier: number;
  maxLossPct: number;

  beActivationMultiplier: number;
  trailMultiplier: number;

  maxHoldingDays: number;
  maxExtendedHoldingDays: number;

  maxPrice: number;
  minAvgVolume25: number;
  minAtrPct: number;
  minTurnover: number;
  minPrice: number;

  costModelEnabled: boolean;
  priceLimitEnabled: boolean;

  cooldownDays: number;

  // マーケットフィルター（indexのみ、breadthなし）
  indexTrendFilter?: boolean;
  indexTrendSmaPeriod?: number;
  indexTrendOffBufferPct?: number;
  indexTrendOnBufferPct?: number;

  verbose: boolean;
  positionCapEnabled?: boolean;
  maxDailyEntries?: number;
}

export interface GapDownReversalBacktestResult {
  config: GapDownReversalBacktestConfig;
  trades: SimulatedPosition[];
  equityCurve: DailyEquity[];
  metrics: PerformanceMetrics;
}

// ──────────────────────────────────────────
// 高騰後押し目バックテスト設定
// ──────────────────────────────────────────

export interface PostSurgeConsolidationBacktestConfig {
  startDate: string;
  endDate: string;
  initialBudget: number;
  maxPositions: number;

  /** 急騰フィルター: 直近20日リターン閾値 */
  momentumMinReturn: number;
  /** 高値圏維持: 高値からの最大乖離率 */
  maxHighDistancePct: number;
  /** 再加速: 出来高サージ倍率 */
  volSurgeRatio: number;

  atrMultiplier: number;
  maxLossPct: number;

  beActivationMultiplier: number;
  trailMultiplier: number;

  maxHoldingDays: number;
  maxExtendedHoldingDays: number;

  maxPrice: number;
  minAvgVolume25: number;
  minAtrPct: number;
  minTurnover: number;
  minPrice: number;

  costModelEnabled: boolean;
  priceLimitEnabled: boolean;

  cooldownDays: number;

  marketTrendFilter?: boolean;
  marketTrendThreshold?: number;
  /** breadth上限 — この値超過の日は過熱判定でエントリーをスキップ（省略時は上限なし） */
  marketTrendUpperCap?: number;
  indexTrendFilter?: boolean;
  indexTrendSmaPeriod?: number;
  indexTrendOffBufferPct?: number;
  indexTrendOnBufferPct?: number;

  verbose: boolean;
  positionCapEnabled?: boolean;
  maxDailyEntries?: number;
}

export interface PostSurgeConsolidationBacktestResult {
  config: PostSurgeConsolidationBacktestConfig;
  trades: SimulatedPosition[];
  equityCurve: DailyEquity[];
  metrics: PerformanceMetrics;
}

// ──────────────────────────────────────────
// NR7ブレイクバックテスト設定
// ──────────────────────────────────────────

export interface NR7BacktestConfig {
  startDate: string;
  endDate: string;
  initialBudget: number;
  maxPositions: number;

  /** NR7 ルックバック日数 */
  lookbackDays: number;
  /** 出来高サージ倍率 */
  volSurgeRatio: number;

  atrMultiplier: number;
  maxLossPct: number;

  beActivationMultiplier: number;
  trailMultiplier: number;

  maxHoldingDays: number;
  maxExtendedHoldingDays: number;

  maxPrice: number;
  minAvgVolume25: number;
  minAtrPct: number;
  minTurnover: number;
  minPrice: number;

  costModelEnabled: boolean;
  priceLimitEnabled: boolean;

  cooldownDays: number;

  marketTrendFilter?: boolean;
  marketTrendThreshold?: number;
  /** breadth上限 — この値超過の日は過熱判定でエントリーをスキップ（省略時は上限なし） */
  marketTrendUpperCap?: number;
  indexTrendFilter?: boolean;
  indexTrendSmaPeriod?: number;
  indexTrendOffBufferPct?: number;
  indexTrendOnBufferPct?: number;

  verbose: boolean;
  positionCapEnabled?: boolean;
  maxDailyEntries?: number;
}

export interface NR7BacktestResult {
  config: NR7BacktestConfig;
  trades: SimulatedPosition[];
  equityCurve: DailyEquity[];
  metrics: PerformanceMetrics;
}

// ──────────────────────────────────────────
// ストップ高フォロースルーバックテスト設定
// ──────────────────────────────────────────

export interface StopHighBacktestConfig {
  startDate: string;
  endDate: string;
  initialBudget: number;
  maxPositions: number;

  /** 前日がストップ高とみなす最小比率（limit_up × this 以上の終値） */
  stopHighThresholdRatio: number;
  /** 当日の最小ギャップ率（open / prevClose - 1） */
  minGapPct: number;
  /** 当日の最小陽線幅（close / open - 1） */
  minBodyPct: number;
  /** 当日の最大陽線幅（ストップ高ロック銘柄を除外、close / open - 1 がこの未満） */
  maxBodyPct: number;
  /** 当日の出来高サージ倍率（volume / avgVolume25 >= this） */
  volSurgeRatio: number;

  atrMultiplier: number;
  maxLossPct: number;

  beActivationMultiplier: number;
  trailMultiplier: number;

  maxHoldingDays: number;
  maxExtendedHoldingDays: number;

  maxPrice: number;
  minAvgVolume25: number;
  minAtrPct: number;
  minTurnover: number;
  minPrice: number;

  costModelEnabled: boolean;
  priceLimitEnabled: boolean;

  cooldownDays: number;

  marketTrendFilter?: boolean;
  marketTrendThreshold?: number;
  /** breadth上限 — この値超過の日は過熱判定でエントリーをスキップ（省略時は上限なし） */
  marketTrendUpperCap?: number;
  indexTrendFilter?: boolean;
  indexTrendSmaPeriod?: number;
  indexTrendOffBufferPct?: number;
  indexTrendOnBufferPct?: number;

  verbose: boolean;
  positionCapEnabled?: boolean;
  maxDailyEntries?: number;
}

export interface StopHighBacktestResult {
  config: StopHighBacktestConfig;
  trades: SimulatedPosition[];
  equityCurve: DailyEquity[];
  metrics: PerformanceMetrics;
}

// ──────────────────────────────────────────
// Early Volume Spike バックテスト設定
// ──────────────────────────────────────────

export interface EarlyVolumeSpikeBacktestConfig {
  startDate: string;
  endDate: string;
  initialBudget: number;
  maxPositions: number;

  /** 出来高サージ倍率（volume / avgVolume25 >= this） */
  volSurgeRatio: number;
  /** 20日高値に対する最小比率（close / high20 >= this） */
  minHigh20Ratio: number;
  /** 20日高値に対する最大比率（close / high20 < this） */
  maxHigh20Ratio: number;
  /** 高値ルックバック日数 */
  highLookbackDays: number;
  /** 最小陽線幅（close / open - 1） */
  minBodyPct: number;
  /** ATR拡大フィルター: 当日レンジ >= ATR14 × this */
  minRangeAtrRatio: number;

  atrMultiplier: number;
  maxLossPct: number;

  beActivationMultiplier: number;
  trailMultiplier: number;

  maxHoldingDays: number;
  maxExtendedHoldingDays: number;

  maxPrice: number;
  minAvgVolume25: number;
  minAtrPct: number;
  minTurnover: number;
  minPrice: number;

  costModelEnabled: boolean;
  priceLimitEnabled: boolean;

  cooldownDays: number;

  marketTrendFilter?: boolean;
  marketTrendThreshold?: number;
  /** breadth上限 — この値超過の日は過熱判定でエントリーをスキップ（省略時は上限なし） */
  marketTrendUpperCap?: number;
  indexTrendFilter?: boolean;
  indexTrendSmaPeriod?: number;
  indexTrendOffBufferPct?: number;
  indexTrendOnBufferPct?: number;

  verbose: boolean;
  positionCapEnabled?: boolean;
  maxDailyEntries?: number;
}

export interface EarlyVolumeSpikeBacktestResult {
  config: EarlyVolumeSpikeBacktestConfig;
  trades: SimulatedPosition[];
  equityCurve: DailyEquity[];
  metrics: PerformanceMetrics;
}

// ──────────────────────────────────────────
// Down-Day Reversal バックテスト設定
// ──────────────────────────────────────────

export interface DownDayReversalBacktestConfig {
  startDate: string;
  endDate: string;
  initialBudget: number;
  maxPositions: number;

  /** 前日からの最小下落率 */
  minDropPct: number;
  /** 出来高サージ倍率 */
  volSurgeRatio: number;
  /** 当日最小陽線幅 */
  minBodyPct: number;
  /** breadth上限（この未満でのみエントリー） */
  maxBreadth: number;

  atrMultiplier: number;
  maxLossPct: number;

  beActivationMultiplier: number;
  trailMultiplier: number;

  maxHoldingDays: number;
  maxExtendedHoldingDays: number;

  maxPrice: number;
  minAvgVolume25: number;
  minAtrPct: number;
  minTurnover: number;
  minPrice: number;

  costModelEnabled: boolean;
  priceLimitEnabled: boolean;

  cooldownDays: number;

  indexTrendFilter?: boolean;
  indexTrendSmaPeriod?: number;
  indexTrendOffBufferPct?: number;
  indexTrendOnBufferPct?: number;

  verbose: boolean;
  positionCapEnabled?: boolean;
  maxDailyEntries?: number;
}

export interface DownDayReversalBacktestResult {
  config: DownDayReversalBacktestConfig;
  trades: SimulatedPosition[];
  equityCurve: DailyEquity[];
  metrics: PerformanceMetrics;
}

// ──────────────────────────────────────────
// Overnight Gap-Fade バックテスト設定
// ──────────────────────────────────────────

export interface OvernightGapFadeBacktestConfig {
  startDate: string;
  endDate: string;
  initialBudget: number;
  maxPositions: number;

  /** 前日の最小陽線幅 */
  prevMinBodyPct: number;
  /** 当日gapdown最小 */
  minGapDownPct: number;
  /** 当日gapdown最大 */
  maxGapDownPct: number;
  /** 当日最小陽線幅 */
  minBodyPct: number;
  /** 前日出来高サージ倍率 */
  prevVolSurgeRatio: number;

  atrMultiplier: number;
  maxLossPct: number;

  beActivationMultiplier: number;
  trailMultiplier: number;

  maxHoldingDays: number;
  maxExtendedHoldingDays: number;

  maxPrice: number;
  minAvgVolume25: number;
  minAtrPct: number;
  minTurnover: number;
  minPrice: number;

  costModelEnabled: boolean;
  priceLimitEnabled: boolean;

  cooldownDays: number;

  marketTrendFilter?: boolean;
  marketTrendThreshold?: number;
  /** breadth上限 — この値超過の日は過熱判定でエントリーをスキップ（省略時は上限なし） */
  marketTrendUpperCap?: number;
  indexTrendFilter?: boolean;
  indexTrendSmaPeriod?: number;
  indexTrendOffBufferPct?: number;
  indexTrendOnBufferPct?: number;

  verbose: boolean;
  positionCapEnabled?: boolean;
  maxDailyEntries?: number;
}

export interface OvernightGapFadeBacktestResult {
  config: OvernightGapFadeBacktestConfig;
  trades: SimulatedPosition[];
  equityCurve: DailyEquity[];
  metrics: PerformanceMetrics;
}
