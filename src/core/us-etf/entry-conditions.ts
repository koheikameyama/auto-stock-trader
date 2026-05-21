/**
 * 米株 ETF (1547, 1545) のエントリーシグナル判定
 *
 * 設計 (A-3 結合検証で確定):
 *   - 日本株 breadth < 54% (idle 帯) のみ動作 = 既存 GU/PSC が休んでいる時にだけ動く
 *   - gap ≥ 0.5% + 出来高サージ 1.5x + 陽線 = ETF版 gap-up シグナル
 *
 * バックテスト (8.5年, 1547+1545):
 *   - PF 1.83 / Calmar 5.24 / MaxDD -6.43% / 累計 +33.7%
 *   - WF (14窓): OOS PF 1.91, 全窓アクティブ
 *   - レジーム別: idle 帯 PF 1.92 / band 帯 PF 1.08 / overheat 帯 PF 0.31
 *     → idle 帯フィルター必須
 */

import { MARKET_BREADTH } from "../../lib/constants/trading";

export interface USEtfSignalInput {
  ticker: string;
  todayOpen: number;
  todayHigh: number;
  todayLow: number;
  todayClose: number;
  todayVolume: number;
  prevClose: number;
  avgVolume25: number;
  japanBreadth: number;
}

export interface USEtfSignalParams {
  /** デフォルト 0.005 (=0.5%) */
  gapMinPct: number;
  /** デフォルト 1.5 */
  volumeSurgeRatio: number;
  /** デフォルト = MARKET_BREADTH.THRESHOLD (=0.54) */
  breadthMax: number;
}

export const US_ETF_SIGNAL_DEFAULTS: USEtfSignalParams = {
  gapMinPct: 0.005,
  volumeSurgeRatio: 1.5,
  breadthMax: MARKET_BREADTH.THRESHOLD,
};

export interface USEtfSignalResult {
  triggered: boolean;
  ticker: string;
  gap: number;
  volSurge: number;
  isUpDay: boolean;
  breadthOk: boolean;
  /** 不発の場合の理由 */
  rejectReasons: string[];
}

/** 米株ETFエントリーシグナル判定 */
export function detectUSEtfSignal(
  input: USEtfSignalInput,
  params: USEtfSignalParams = US_ETF_SIGNAL_DEFAULTS,
): USEtfSignalResult {
  const gap = (input.todayOpen - input.prevClose) / input.prevClose;
  const isUpDay = input.todayClose > input.todayOpen;
  const volSurge = input.avgVolume25 > 0 ? input.todayVolume / input.avgVolume25 : 0;
  const breadthOk = input.japanBreadth < params.breadthMax;

  const rejectReasons: string[] = [];
  if (gap < params.gapMinPct) {
    rejectReasons.push(`gap ${(gap * 100).toFixed(2)}% < ${(params.gapMinPct * 100).toFixed(1)}%`);
  }
  if (!isUpDay) {
    rejectReasons.push("陽線でない");
  }
  if (volSurge < params.volumeSurgeRatio) {
    rejectReasons.push(`vol ${volSurge.toFixed(2)}x < ${params.volumeSurgeRatio}x`);
  }
  if (!breadthOk) {
    rejectReasons.push(
      `breadth ${(input.japanBreadth * 100).toFixed(1)}% >= ${(params.breadthMax * 100).toFixed(0)}% (idle帯外)`,
    );
  }

  return {
    triggered: rejectReasons.length === 0,
    ticker: input.ticker,
    gap,
    volSurge,
    isUpDay,
    breadthOk,
    rejectReasons,
  };
}

/** ETF用のリスク管理パラメータ */
export const US_ETF_RISK_PARAMS = {
  /** 損切り幅 -2% */
  slPct: 0.02,
  /** タイムストップ 5営業日 */
  timeStopDays: 5,
  /** リスク% (資金に対する) */
  riskPct: 0.015,
  /** ETF universe */
  tickers: ["1547", "1545"] as const,
};
