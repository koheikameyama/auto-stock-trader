/**
 * 強気相場モニター (Bull Market Monitor)
 *
 * D期 (中小型強気相場) は事後的にしか確定できないため、リアルタイムでは
 * 「強気局面か否か」を段階的に毎日報告する。ユーザーが Slack を見て判断する設計。
 *
 * シグナル一覧:
 *   1. breadth が5営業日連続 54% 以上 (band 上限撤廃、過熱も「強気の証」)
 *   2. breadth が直近30日で +10pp 以上回復
 *   3. 日経 close > SMA50
 *   4. 日経 SMA50 が上向き (10日傾き > 0)
 *   5. VIX < 25 (elevated 入り口手前)
 *
 * 段階レベル:
 *   🔥 STRONG_BULL (5/5)
 *   🟢 MODERATE_BULL (4/5)
 *   🟡 EARLY_SIGNAL (3/5)
 *   - NEUTRAL (0-2/5)
 */

import dayjs from "dayjs";
import { fetchBreadthSeries } from "./breadth-history";
import { fetchIndexFromDB, fetchVixFromDB } from "../backtest/data-fetcher";
import { MARKET_BREADTH } from "../lib/constants/trading";

export type SignalLevel =
  | "STRONG_BULL"
  | "MODERATE_BULL"
  | "EARLY_SIGNAL"
  | "NEUTRAL";

export const SIGNAL_LEVEL_ORDER: SignalLevel[] = [
  "NEUTRAL",
  "EARLY_SIGNAL",
  "MODERATE_BULL",
  "STRONG_BULL",
];

export interface BullMarketCurrent {
  breadth: number;
  breadthChange30d: number;
  nikkei: number;
  nikkeiSma50: number;
  nikkeiSma50Slope10d: number;
  vix: number;
}

export interface BullMarketSignals {
  /** breadth が 5営業日連続 54% 以上 */
  breadthAboveThreshold5Days: boolean;
  /** breadth が直近30日で +10pp 以上回復 */
  breadthRecovery10pp: boolean;
  /** 日経 close > SMA50 */
  nikkeiAboveSma50: boolean;
  /** 日経 SMA50 が上向き */
  nikkeiSma50Rising: boolean;
  /** VIX < 25 */
  vixLow: boolean;
}

export interface BullMarketResult {
  asOfDate: Date;
  level: SignalLevel;
  signalCount: number;
  signals: BullMarketSignals;
  current: BullMarketCurrent;
}

export const REGIME_SHIFT_PARAMS = {
  BAND_DAYS: 5,
  BREADTH_RECOVERY_PP: 0.10,
  VIX_THRESHOLD: 25,
  NIKKEI_SMA_PERIOD: 50,
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

export function determineLevel(signalCount: number): SignalLevel {
  if (signalCount >= 5) return "STRONG_BULL";
  if (signalCount >= 4) return "MODERATE_BULL";
  if (signalCount >= 3) return "EARLY_SIGNAL";
  return "NEUTRAL";
}

export async function detectRegimeShift(opts: {
  asOfDate?: Date;
} = {}): Promise<BullMarketResult> {
  const today = opts.asOfDate ?? new Date();
  const endDate = dayjs(today).format("YYYY-MM-DD");

  const breadthSeries = await fetchBreadthSeries({
    lookbackDays: 90,
    endDate: today,
  });

  const indexStart = dayjs(endDate).subtract(180, "day").format("YYYY-MM-DD");
  const nikkeiMap = await fetchIndexFromDB("^N225", indexStart, endDate, 0);
  const vixMap = await fetchVixFromDB(indexStart, endDate);

  const nikkeiCloses = [...nikkeiMap.entries()]
    .map(([d, c]) => ({ date: d, close: c }))
    .sort((a, b) => a.date.localeCompare(b.date));

  const nikkeiValues = nikkeiCloses.map((r) => r.close);
  const nikkeiSma50Series = computeSMASeries(
    nikkeiValues,
    REGIME_SHIFT_PARAMS.NIKKEI_SMA_PERIOD,
  );

  const latestNikkei = nikkeiCloses[nikkeiCloses.length - 1];
  const latestSma50 = nikkeiSma50Series[nikkeiSma50Series.length - 1];
  const sma50_10dAgo = nikkeiSma50Series[
    nikkeiSma50Series.length - 1 - REGIME_SHIFT_PARAMS.SMA_SLOPE_PERIOD
  ];

  const sma50Slope =
    latestSma50 != null && sma50_10dAgo != null
      ? (latestSma50 - sma50_10dAgo) / sma50_10dAgo
      : 0;

  const vixEntries = [...vixMap.entries()].sort(([a], [b]) =>
    a.localeCompare(b),
  );
  const latestVix =
    vixEntries.length > 0
      ? vixEntries[vixEntries.length - 1][1]
      : Number.POSITIVE_INFINITY;

  const latestBreadthPoint = breadthSeries[breadthSeries.length - 1];
  const lastN = breadthSeries.slice(-REGIME_SHIFT_PARAMS.BAND_DAYS);
  const breadthAboveThreshold5Days =
    lastN.length === REGIME_SHIFT_PARAMS.BAND_DAYS &&
    lastN.every((p) => p.breadth >= MARKET_BREADTH.THRESHOLD);

  const breadth30dAgo =
    breadthSeries[Math.max(0, breadthSeries.length - 31)];
  const breadthChange30d = breadth30dAgo
    ? latestBreadthPoint.breadth - breadth30dAgo.breadth
    : 0;

  const signals: BullMarketSignals = {
    breadthAboveThreshold5Days,
    breadthRecovery10pp:
      breadthChange30d >= REGIME_SHIFT_PARAMS.BREADTH_RECOVERY_PP,
    nikkeiAboveSma50: latestSma50 != null && latestNikkei.close > latestSma50,
    nikkeiSma50Rising: sma50Slope > 0,
    vixLow: latestVix < REGIME_SHIFT_PARAMS.VIX_THRESHOLD,
  };

  const signalCount = Object.values(signals).filter(Boolean).length;
  const level = determineLevel(signalCount);

  return {
    asOfDate: latestBreadthPoint.date,
    level,
    signalCount,
    signals,
    current: {
      breadth: latestBreadthPoint.breadth,
      breadthChange30d,
      nikkei: latestNikkei.close,
      nikkeiSma50: latestSma50 ?? 0,
      nikkeiSma50Slope10d: sma50Slope,
      vix: latestVix,
    },
  };
}

const LEVEL_EMOJI: Record<SignalLevel, string> = {
  STRONG_BULL: "🔥",
  MODERATE_BULL: "🟢",
  EARLY_SIGNAL: "🟡",
  NEUTRAL: "⚪",
};

const LEVEL_LABEL: Record<SignalLevel, string> = {
  STRONG_BULL: "STRONG_BULL (D期確定モード)",
  MODERATE_BULL: "MODERATE_BULL (D期候補)",
  EARLY_SIGNAL: "EARLY_SIGNAL (強気サイン)",
  NEUTRAL: "NEUTRAL (静観)",
};

export function formatBullMarketMessage(r: BullMarketResult): string {
  const tick = (b: boolean) => (b ? "✅" : "❌");
  const change = r.current.breadthChange30d;
  const slope = r.current.nikkeiSma50Slope10d;

  const lines = [
    `${LEVEL_EMOJI[r.level]} ${LEVEL_LABEL[r.level]}: ${r.signalCount}/5`,
    "",
    `breadth: ${(r.current.breadth * 100).toFixed(1)}% (30日変化 ${change >= 0 ? "+" : ""}${(change * 100).toFixed(1)}pp)`,
    `日経: ${r.current.nikkei.toFixed(0)} (SMA50 ${r.current.nikkeiSma50.toFixed(0)}, 傾き ${(slope * 100).toFixed(2)}%)`,
    `VIX: ${isFinite(r.current.vix) ? r.current.vix.toFixed(1) : "N/A"}`,
    "",
    "シグナル:",
    `  ${tick(r.signals.breadthAboveThreshold5Days)} breadth が 5営業日連続 54%以上`,
    `  ${tick(r.signals.breadthRecovery10pp)} breadth が直近30日で +10pp以上回復`,
    `  ${tick(r.signals.nikkeiAboveSma50)} 日経 close > SMA50`,
    `  ${tick(r.signals.nikkeiSma50Rising)} 日経 SMA50 が上向き`,
    `  ${tick(r.signals.vixLow)} VIX < 25`,
  ];
  return lines.join("\n");
}

/**
 * 1行サマリー。毎日飛ぶ breadth-notify に相乗りして「D期にどれだけ近いか」を
 * 常時可視化する用（regime-shift-notify はレベル変化時しか飛ばないため）。
 */
export function formatBullMarketLine(r: BullMarketResult): string {
  const s = r.signals;
  const tick = (b: boolean) => (b ? "✅" : "❌");
  return (
    `🌡️ D期監視: ${LEVEL_EMOJI[r.level]} ${LEVEL_LABEL[r.level]} ${r.signalCount}/5` +
    `（日経>SMA50${tick(s.nikkeiAboveSma50)} 傾き${tick(s.nikkeiSma50Rising)} VIX<25${tick(s.vixLow)}` +
    ` / breadth連続${tick(s.breadthAboveThreshold5Days)} 回復${tick(s.breadthRecovery10pp)}）`
  );
}

export function getLevelEmoji(level: SignalLevel): string {
  return LEVEL_EMOJI[level];
}

export function getLevelLabel(level: SignalLevel): string {
  return LEVEL_LABEL[level];
}
