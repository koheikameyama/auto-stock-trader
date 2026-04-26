/**
 * VIX Contango バックテスト型定義
 *
 * 戦略: VIX先物のコンタンゴ構造（front < back month）から生まれるロール収益を
 * SVXY（Inverse Short-term VIX Futures ETF, -0.5x）保有で取りに行く。
 *
 * 防御: VIX が閾値超 / 急上昇でフラット化（リスクオフ）。
 */

import type { DailyEquity, PerformanceMetrics } from "../types";

export interface USVixContangoBacktestConfig {
  startDate: string;
  endDate: string;
  initialBudget: number;

  /** 保有ETF（SVXY = -0.5x VIX short-term futures, SVIX = -1x） */
  underlyingTicker: "SVXY" | "SVIX";

  /** 新規エントリー: VIX がこの値以下のときのみエントリー */
  vixEntryUpperBound: number;
  /** 撤退: VIX がこの値超のとき即時撤退（リスクオフ） */
  vixExitUpperBound: number;
  /** 撤退: 当日 VIX 急上昇率（前日比 %）がこの値超のとき即時撤退 */
  vixSpikeThreshold: number;
  /** 再エントリー禁止期間（日） */
  reentryCooldownDays: number;

  /** 1ポジションのフル資金比率 (1.0 = 100%, 0.5 = 50%でレバ抑制) */
  positionSizing: number;
  /** stop loss (%) - 0 = 無効 */
  stopLossPct: number;

  /** コミッション ($/trade) */
  commissionPerTrade: number;
  /** スプレッド + slippage (% of trade value) */
  slippagePct: number;

  verbose: boolean;
}

export interface SimulatedVixPosition {
  ticker: string;
  entryDate: string;
  entryPrice: number;
  entryVix: number;
  shares: number;

  exitDate?: string;
  exitPrice?: number;
  exitVix?: number;
  exitReason?: "vix_cap" | "vix_spike" | "stop_loss" | "still_open";

  grossPnl?: number;
  commissions?: number;
  netPnl?: number;
  holdingDays?: number;
}

export interface VixContangoPerformanceMetrics extends PerformanceMetrics {
  /** 平均VIXエントリー時 */
  avgEntryVix: number;
  /** 平均保有日数 */
  avgHoldingDays: number;
  /** vix_cap 退場 */
  vixCapExits: number;
  /** vix_spike 退場 */
  vixSpikeExits: number;
  /** stop_loss 退場 */
  stopLossExits: number;
  /** 在場日数 / 全期間 */
  marketParticipationRate: number;
}

export interface USVixContangoBacktestResult {
  config: USVixContangoBacktestConfig;
  positions: SimulatedVixPosition[];
  equityCurve: DailyEquity[];
  metrics: VixContangoPerformanceMetrics;
}
