/**
 * ブレイクアウト戦略フィルター関数
 *
 * エントリー候補銘柄のゲートチェックと週足トレンド判定を行う。
 */

import type { OHLCVData } from "../technical-analysis";
import { SCORING } from "../../lib/constants/scoring";
import { SCREENING } from "../../lib/constants";

interface GateInput {
  latestPrice: number;
  avgVolume25: number | null;
  atrPct: number | null;
  nextEarningsDate: Date | null;
  /** 直近の過去決算日（EarningsDate テーブルから取得した最新日付）。 */
  recentEarningsDate?: Date | null;
  exDividendDate: Date | null;
  today: Date;
  /** 資金連動の最大株価（getMaxBuyablePrice で算出） */
  maxPrice: number;
  /**
   * 流動性ゲートの下限。省略時はスコアリング系の汎用値 `SCORING.GATES.MIN_AVG_VOLUME_25`。
   * GU/PSC は BT の `passesUniverseGates` と揃えるため戦略固有値を明示的に渡す。
   */
  minAvgVolume25?: number;
}

/**
 * ゲートチェック（即死ルール）
 * 流動性・価格・ATR・決算・権利落ち日の条件を満たさない銘柄を除外する
 */
export function checkGates(input: GateInput): { passed: boolean; reason?: string } {
  const { latestPrice, avgVolume25, atrPct, nextEarningsDate, recentEarningsDate, exDividendDate, today, maxPrice } = input;
  const minAvgVolume25 = input.minAvgVolume25 ?? SCORING.GATES.MIN_AVG_VOLUME_25;

  if (!avgVolume25 || avgVolume25 < minAvgVolume25) {
    return { passed: false, reason: "volume" };
  }

  if (latestPrice < SCREENING.MIN_PRICE) {
    return { passed: false, reason: "price_low" };
  }

  if (avgVolume25 && latestPrice * avgVolume25 < SCREENING.MIN_TURNOVER) {
    return { passed: false, reason: "turnover" };
  }

  if (latestPrice > maxPrice) {
    return { passed: false, reason: "price" };
  }

  if (!atrPct || atrPct < SCORING.GATES.MIN_ATR_PCT) {
    return { passed: false, reason: "atr" };
  }

  if (nextEarningsDate) {
    const daysUntil = Math.floor(
      (nextEarningsDate.getTime() - today.getTime()) / (1000 * 60 * 60 * 24),
    );
    if (daysUntil >= 0 && daysUntil <= SCORING.GATES.EARNINGS_DAYS_BEFORE) {
      return { passed: false, reason: "earnings" };
    }
  }

  if (recentEarningsDate) {
    const daysSince = Math.floor(
      (today.getTime() - recentEarningsDate.getTime()) / (1000 * 60 * 60 * 24),
    );
    if (daysSince >= 0 && daysSince <= SCORING.GATES.EARNINGS_DAYS_AFTER) {
      return { passed: false, reason: "earnings_recent" };
    }
  }

  if (exDividendDate) {
    const daysUntil = Math.floor(
      (exDividendDate.getTime() - today.getTime()) / (1000 * 60 * 60 * 24),
    );
    if (daysUntil >= 0 && daysUntil <= SCORING.GATES.EX_DIVIDEND_DAYS_BEFORE) {
      return { passed: false, reason: "exdividend" };
    }
  }

  return { passed: true };
}

interface FilterIntermediates {
  weeklyClose: number | null;
  weeklySma13: number | null;
  /** 13週高値（当週除く、WB戦略用） */
  weeklyHigh13: number | null;
}

/**
 * 週足トレンド判定に必要な中間値を計算する
 * data は newest-first の日足OHLCVデータ
 */
export function computeScoringIntermediates(data: OHLCVData[]): FilterIntermediates {
  if (!data || data.length < 2) {
    return { weeklyClose: null, weeklySma13: null, weeklyHigh13: null };
  }

  // 古い順にソート
  const sorted = [...data].sort(
    (a, b) => new Date(a.date).getTime() - new Date(b.date).getTime(),
  );

  // 週足に集約（各週の終値・高値）
  const weekCloseMap = new Map<string, number>();
  const weekHighMap = new Map<string, number>();
  for (const bar of sorted) {
    const d = new Date(bar.date);
    const dayOfWeek = d.getDay();
    const daysToMonday = dayOfWeek === 0 ? -6 : 1 - dayOfWeek;
    const monday = new Date(d);
    monday.setDate(d.getDate() + daysToMonday);
    const weekKey = monday.toISOString().slice(0, 10);
    weekCloseMap.set(weekKey, bar.close); // 同週の後ろのデータで上書き → 週末終値
    weekHighMap.set(weekKey, Math.max(weekHighMap.get(weekKey) ?? 0, bar.high));
  }

  const weekKeys = Array.from(weekCloseMap.keys()).sort();
  const weeklyCloses = weekKeys.map((k) => weekCloseMap.get(k)!);

  if (weeklyCloses.length === 0) {
    return { weeklyClose: null, weeklySma13: null, weeklyHigh13: null };
  }

  const weeklyClose = weeklyCloses[weeklyCloses.length - 1];

  if (weeklyCloses.length < 13) {
    return { weeklyClose, weeklySma13: null, weeklyHigh13: null };
  }

  const last13 = weeklyCloses.slice(-13);
  const weeklySma13 = last13.reduce((sum, c) => sum + c, 0) / 13;

  // 13週高値（当週を除く直近13週の最大 high）
  let weeklyHigh13: number | null = null;
  if (weekKeys.length >= 14) {
    const lookbackKeys = weekKeys.slice(-14, -1);
    weeklyHigh13 = Math.max(...lookbackKeys.map((k) => weekHighMap.get(k)!));
  }

  return { weeklyClose, weeklySma13, weeklyHigh13 };
}
