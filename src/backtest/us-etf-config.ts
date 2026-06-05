/**
 * 米株 ETF (1547, 1545) バックテスト設定
 *
 * 設計 (CLAUDE.md backtest.md Phase 5 と整合):
 *   - universe: 1547 (SPDR S&P500 ETF), 1545 (NEXT FUNDS NASDAQ-100)
 *   - エントリー: gap≥0.5% + vol≥1.5x + 陽線 + 日本株 breadth<54% (idle帯)
 *   - SL -2%, タイムストップ 5営業日, リスク 1.5%
 *   - 株数単位: 1株単位 (GU/PSC の100株単位とは異なる)
 *   - WF OOS PF 1.91 / Calmar 5.24 / MaxDD -6.4% (8.5年BT)
 */

import { MARKET_BREADTH } from "../lib/constants/trading";

export interface USEtfBacktestConfig {
  /** ETF universe (デフォルト ["1547", "1545"]) */
  tickers: string[];
  /** ギャップ最小%（0.005 = 0.5%） */
  gapMinPct: number;
  /** 出来高サージ最小倍率 */
  volumeSurgeRatio: number;
  /** 出来高平均の lookback 日数 */
  volumeLookbackDays: number;
  /** 日本株 breadth がこの値未満の日のみ発火 (idle帯フィルター) */
  breadthMax: number;
  /** 損切り% (0.02 = -2%) */
  slPct: number;
  /** タイムストップ営業日数 */
  timeStopDays: number;
  /** リスク% (0.015 = 1.5%) */
  riskPct: number;
  /** コストモデル有効化 */
  costModelEnabled: boolean;
  /** 1取引あたりの株数単位（ETF は 1 株単位） */
  unitShares: number;
}

export const US_ETF_DEFAULT_CONFIG: USEtfBacktestConfig = {
  tickers: ["1547", "1545"],
  gapMinPct: 0.005,
  volumeSurgeRatio: 1.5,
  volumeLookbackDays: 25,
  breadthMax: MARKET_BREADTH.THRESHOLD,
  slPct: 0.02,
  timeStopDays: 5,
  riskPct: 0.015,
  costModelEnabled: true,
  unitShares: 1,
};

/** リスク%を百分率（1.5 = 1.5%）に変換 */
export const US_ETF_RISK_PER_TRADE_PCT = US_ETF_DEFAULT_CONFIG.riskPct * 100;
