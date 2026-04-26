/**
 * SPY/QQQ Credit Spread バックテスト型定義
 *
 * Bull Put Credit Spread:
 *   sell short put (OTM, delta ~0.20)
 *   buy long put (further OTM, hedge for defined risk)
 *   max loss = spread width - credit received
 *
 * インデックスETFを原資産とすることで個別株の assignment テールを排除し、
 * Volatility Risk Premium (VRP) の構造的アルファを取りにいく。
 */

import type { DailyEquity, PerformanceMetrics } from "../types";

export interface USCreditSpreadBacktestConfig {
  startDate: string;
  endDate: string;
  initialBudget: number;

  /** 原資産シンボル（"SPY" 推奨。^GSPCを÷10で SPY 換算して使用） */
  underlyingSymbol: "SPY" | "QQQ" | "IWM";

  /** ショート側 put delta（絶対値、例 0.20） */
  shortPutDelta: number;
  /** スプレッド幅（ドル、SPYスケール。例: 5 = $5幅） */
  spreadWidth: number;
  /** 満期日数 */
  dte: number;
  /** 早期クローズ利益目標（クレジットの%、例 0.50 = 50% 取れたら決済） */
  profitTarget: number;
  /** ストップロス（クレジットの倍率、例 2.0 = クレジットの2倍損失で撤退。0=無効） */
  stopLossMultiplier: number;

  /** 無リスク金利（年率） */
  riskFreeRate: number;
  /** VIX→IV調整倍率 */
  ivScaleFactor: number;

  /** 同時保有スプレッド上限 */
  maxPositions: number;
  /** 1スプレッドあたりの想定コントラクト数（max loss = spreadWidth × 100 × contracts） */
  contractsPerSpread: number;

  /** 1コントラクトあたり手数料（往復片道） */
  optionsCommission: number;

  /** インデックストレンドフィルター（SMA上で売り） */
  indexTrendFilter: boolean;
  indexTrendSmaPeriod: number;
  /** VIX上限（VIXが閾値超なら新規エントリー停止） */
  vixCap: number;

  verbose: boolean;
}

export type SpreadState = "OPEN" | "CLOSED";

export interface SimulatedSpread {
  underlyingSymbol: string;
  entryDate: string;
  expirationDate: string;
  entrySpotPrice: number;
  entryIV: number;

  shortStrike: number;
  longStrike: number;
  shortDeltaAtEntry: number;

  /** 受領クレジット（1コントラクトあたり） */
  creditReceived: number;
  contracts: number;

  state: SpreadState;
  closeDate?: string;
  closeReason?:
    | "profit_target"
    | "stop_loss"
    | "expired_worthless"
    | "expired_max_loss"
    | "expired_partial";
  /** 決済時の残スプレッド価格（1コントラクトあたり） */
  closeSpreadPrice?: number;
  /** 純損益（手数料込、ドル） */
  netPnl?: number;
  /** 全コミッション（往復、ドル） */
  totalCommissions: number;
}

export interface CreditSpreadPerformanceMetrics extends PerformanceMetrics {
  totalSpreads: number;
  /** 最大利益（クレジット全額）まで取れた数 */
  expiredWorthless: number;
  /** 最大損失（spreadWidth）に達した数 */
  maxLossCount: number;
  /** 早期利益決済 */
  profitTargetHits: number;
  /** ストップロス */
  stopLossHits: number;
  /** クレジット合計（受領） */
  totalCreditReceived: number;
  /** 平均クレジット率 = credit / spreadWidth */
  avgCreditRatio: number;
  /** 平均保有日数 */
  avgHoldingDays: number;
}

export interface USCreditSpreadBacktestResult {
  config: USCreditSpreadBacktestConfig;
  spreads: SimulatedSpread[];
  equityCurve: DailyEquity[];
  metrics: CreditSpreadPerformanceMetrics;
}
