/**
 * D期入り（中小型強気相場）の到来シグナルを検出する
 *
 * D期は過去9年で約3年に1回しか来ない希少局面で、戦略の主リターン源。
 * これを取り逃さないため、複数シグナルが揃った時点で即座に検知して通知する。
 *
 * 各シグナル:
 *   1. breadth が3営業日連続 54-80% band 内
 *   2. breadth が直近30日で +20pp 以上回復 (急回復シグナル)
 *   3. 日経 close > SMA50
 *   4. 日経 SMA50 が上向き (傾き > 0)
 *   5. VIX < 20 (リスクオン環境)
 *
 * 全条件 AND 充足で「D期入り候補」と判定。
 */

import dayjs from "dayjs";
import { fetchBreadthSeries } from "./breadth-history";
import { fetchIndexFromDB, fetchVixFromDB } from "../backtest/data-fetcher";
import { MARKET_BREADTH } from "../lib/constants/trading";

export interface RegimeShiftCurrent {
  breadth: number;
  breadthChange30d: number;
  nikkei: number;
  nikkeiSma50: number;
  nikkeiSma50Slope10d: number;
  vix: number;
}

export interface RegimeShiftSignals {
  breadthInBand3Days: boolean;
  breadthRecovery20pp: boolean;
  nikkeiAboveSma50: boolean;
  nikkeiSma50Rising: boolean;
  vixLow: boolean;
}

export interface RegimeShiftResult {
  /** 全シグナル AND 成立 = D期入り候補 */
  isRegimeShift: boolean;
  /** 評価基準日 */
  asOfDate: Date;
  signals: RegimeShiftSignals;
  current: RegimeShiftCurrent;
  /** 何個シグナルがONか (0-5) */
  signalCount: number;
}

/** D期入り判定パラメータ */
export const REGIME_SHIFT_PARAMS = {
  /** breadth band 内 連続日数 */
  BAND_DAYS: 3,
  /** breadth 30日変化の閾値 (pp) */
  BREADTH_RECOVERY_PP: 0.20,
  /** VIX 閾値 */
  VIX_THRESHOLD: 20,
  /** Nikkei SMA50 期間 */
  NIKKEI_SMA_PERIOD: 50,
  /** SMA50 傾き計算期間 (営業日) */
  SMA_SLOPE_PERIOD: 10,
};

function computeSMASeries(values: number[], period: number): (number | null)[] {
  const series: (number | null)[] = [];
  for (let i = 0; i < values.length; i++) {
    if (i < period - 1) {
      series.push(null);
      continue;
    }
    const window = values.slice(i - period + 1, i + 1);
    series.push(window.reduce((a, b) => a + b, 0) / period);
  }
  return series;
}

export async function detectRegimeShift(opts: {
  asOfDate?: Date;
} = {}): Promise<RegimeShiftResult> {
  const today = opts.asOfDate ?? new Date();
  const endDate = dayjs(today).format("YYYY-MM-DD");

  // 履歴データ取得 (90 営業日 = 130 暦日相当を lookback)
  const breadthSeries = await fetchBreadthSeries({
    lookbackDays: 90,
    endDate: today,
  });

  // 日経 SMA50 計算には50日+傾き10日 = 60日+ のバッファ必要
  const indexStart = dayjs(endDate).subtract(180, "day").format("YYYY-MM-DD");
  const nikkeiMap = await fetchIndexFromDB("^N225", indexStart, endDate, 0);
  const vixMap = await fetchVixFromDB(indexStart, endDate);

  const nikkeiCloses: { date: string; close: number }[] = [...nikkeiMap.entries()]
    .map(([d, c]) => ({ date: d, close: c }))
    .sort((a, b) => a.date.localeCompare(b.date));

  const nikkeiValues = nikkeiCloses.map((r) => r.close);
  const nikkeiSma50Series = computeSMASeries(nikkeiValues, REGIME_SHIFT_PARAMS.NIKKEI_SMA_PERIOD);

  const latestNikkei = nikkeiCloses[nikkeiCloses.length - 1];
  const latestSma50 = nikkeiSma50Series[nikkeiSma50Series.length - 1];
  const sma50_10dAgo = nikkeiSma50Series[nikkeiSma50Series.length - 1 - REGIME_SHIFT_PARAMS.SMA_SLOPE_PERIOD];

  const sma50Slope =
    latestSma50 != null && sma50_10dAgo != null
      ? (latestSma50 - sma50_10dAgo) / sma50_10dAgo
      : 0;

  // VIX 最新値
  const vixEntries = [...vixMap.entries()].sort(([a], [b]) => a.localeCompare(b));
  const latestVix = vixEntries.length > 0 ? vixEntries[vixEntries.length - 1][1] : Number.POSITIVE_INFINITY;

  // breadth: 直近3日が band内か、30日変化
  const latestBreadthPoint = breadthSeries[breadthSeries.length - 1];
  const last3 = breadthSeries.slice(-REGIME_SHIFT_PARAMS.BAND_DAYS);
  const breadthInBand3Days =
    last3.length === REGIME_SHIFT_PARAMS.BAND_DAYS &&
    last3.every(
      (p) =>
        p.breadth >= MARKET_BREADTH.THRESHOLD && p.breadth <= MARKET_BREADTH.UPPER_CAP,
    );

  const breadth30dAgo = breadthSeries[Math.max(0, breadthSeries.length - 31)];
  const breadthChange30d = breadth30dAgo
    ? latestBreadthPoint.breadth - breadth30dAgo.breadth
    : 0;

  // シグナル判定
  const signals: RegimeShiftSignals = {
    breadthInBand3Days,
    breadthRecovery20pp: breadthChange30d >= REGIME_SHIFT_PARAMS.BREADTH_RECOVERY_PP,
    nikkeiAboveSma50: latestSma50 != null && latestNikkei.close > latestSma50,
    nikkeiSma50Rising: sma50Slope > 0,
    vixLow: latestVix < REGIME_SHIFT_PARAMS.VIX_THRESHOLD,
  };

  const signalCount = Object.values(signals).filter(Boolean).length;
  const isRegimeShift = signalCount === 5;

  return {
    isRegimeShift,
    asOfDate: latestBreadthPoint.date,
    signals,
    current: {
      breadth: latestBreadthPoint.breadth,
      breadthChange30d,
      nikkei: latestNikkei.close,
      nikkeiSma50: latestSma50 ?? 0,
      nikkeiSma50Slope10d: sma50Slope,
      vix: latestVix,
    },
    signalCount,
  };
}

/** Slack 通知本文を整形 */
export function formatRegimeShiftMessage(r: RegimeShiftResult): string {
  const tick = (b: boolean) => (b ? "✅" : "❌");
  const lines = [
    `breadth: ${(r.current.breadth * 100).toFixed(1)}% (30日変化 ${r.current.breadthChange30d >= 0 ? "+" : ""}${(r.current.breadthChange30d * 100).toFixed(1)}pp)`,
    `日経: ${r.current.nikkei.toFixed(0)} (SMA50 ${r.current.nikkeiSma50.toFixed(0)}, 傾き ${(r.current.nikkeiSma50Slope10d * 100).toFixed(2)}%)`,
    `VIX: ${r.current.vix.toFixed(1)}`,
    "",
    "シグナル状態:",
    `  ${tick(r.signals.breadthInBand3Days)} breadth が 3営業日連続 54-80% band内`,
    `  ${tick(r.signals.breadthRecovery20pp)} breadth が直近30日で +20pp 以上回復`,
    `  ${tick(r.signals.nikkeiAboveSma50)} 日経 close > SMA50`,
    `  ${tick(r.signals.nikkeiSma50Rising)} 日経 SMA50 が上向き`,
    `  ${tick(r.signals.vixLow)} VIX < 20`,
    "",
    `シグナルカウント: ${r.signalCount}/5`,
  ];
  return lines.join("\n");
}
