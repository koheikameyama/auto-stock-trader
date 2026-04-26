/**
 * Dual Momentum (Antonacci GEM) バックテスト型定義
 *
 * Cross-sectional momentum (best performer) + Absolute momentum (vs cash/T-bill).
 * 月次リバランスで保有1本に集中、絶対モメンタムが負ならリスクオフ資産へ退避。
 */

import type { DailyEquity, PerformanceMetrics } from "../types";

export interface USDualMomentumBacktestConfig {
  startDate: string;
  endDate: string;
  initialBudget: number;

  /** 株式ユニバース（モメンタム比較対象） */
  equityUniverse: string[];
  /** リスクオフ資産（絶対モメンタム陰性時の退避先） */
  riskOffAsset: string;
  /** 絶対モメンタム閾値（年率%、これ未満なら risk-off） */
  absoluteMomentumThreshold: number;

  /** モメンタム測定期間（営業日） */
  lookbackDays: number;
  /** リバランス間隔（営業日、約21=月次） */
  rebalanceDays: number;

  /** コミッション ($/trade) */
  commissionPerTrade: number;
  /** スリッページ (% of trade value) */
  slippagePct: number;

  verbose: boolean;
}

export interface DualMomentumRebalance {
  date: string;
  selectedAsset: string;
  selectedReason: "best_equity" | "risk_off";
  rankings: Array<{ ticker: string; momentum: number }>;
  prevAsset: string | null;
  switched: boolean;
}

export interface SimulatedRotationPosition {
  ticker: string;
  entryDate: string;
  entryPrice: number;
  shares: number;
  exitDate?: string;
  exitPrice?: number;
  exitReason?: "rotation_exit" | "still_open";
  netPnl?: number;
  pnlPct?: number;
  holdingDays?: number;
}

export interface DualMomentumPerformanceMetrics extends PerformanceMetrics {
  /** 各資産への配分比率（在場日数） */
  assetParticipation: Record<string, number>;
  /** リバランス回数 */
  rebalanceCount: number;
  /** スイッチ回数（前回と異なる資産を選択） */
  switchCount: number;
  /** リスクオフ滞在日数 */
  riskOffDays: number;
}

export interface USDualMomentumBacktestResult {
  config: USDualMomentumBacktestConfig;
  positions: SimulatedRotationPosition[];
  rebalances: DualMomentumRebalance[];
  equityCurve: DailyEquity[];
  metrics: DualMomentumPerformanceMetrics;
}
