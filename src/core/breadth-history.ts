/**
 * Breadth 履歴ベースの予測・統計
 *
 * - 直近トレンドの線形外挿による点推定（いつ54%復帰するか）
 * - 過去類似ケースの統計（現値レベルからの復帰までの分位数）
 *
 * データソースは StockDailyBar。MarketAssessment.breadth は 2026-04 開始で
 * 履歴が浅いため、SMA25 を SQL で再計算して長期履歴を確保する。
 */

import dayjs from "dayjs";
import { prisma } from "../lib/prisma";
import { jstDateAsUTC } from "../lib/market-date";

export interface BreadthHistoryPoint {
  date: Date;
  breadth: number;
}

/**
 * 過去 lookbackDays 営業日分の breadth 時系列を計算する（古い順）。
 * SMA25 のウィンドウ確保のため内部では lookback + 40 暦日を取得する。
 */
export async function fetchBreadthSeries(opts: {
  lookbackDays: number;
  endDate?: Date;
}): Promise<BreadthHistoryPoint[]> {
  const endDate = opts.endDate ?? new Date();
  // 営業日換算で 1.5 倍 + SMA25 バッファ + 余裕
  const totalCalendarDays = Math.ceil(opts.lookbackDays * 1.5) + 40;
  const fromDate = jstDateAsUTC(dayjs(endDate).utc().subtract(totalCalendarDays, "day"));
  const calculationStart = jstDateAsUTC(
    dayjs(endDate).utc().subtract(Math.ceil(opts.lookbackDays * 1.5), "day"),
  );

  const rows = await prisma.$queryRaw<{ date: Date; above: number; total: number }[]>`
    WITH windowed AS (
      SELECT
        "tickerCode",
        date,
        close,
        AVG(close) OVER (
          PARTITION BY "tickerCode"
          ORDER BY date
          ROWS 24 PRECEDING
        ) as sma25,
        COUNT(*) OVER (
          PARTITION BY "tickerCode"
          ORDER BY date
          ROWS 24 PRECEDING
        ) as window_count
      FROM "StockDailyBar"
      WHERE market = 'JP'
        AND date >= ${fromDate}
        AND date <= ${endDate}
    )
    SELECT
      date,
      COUNT(*) FILTER (WHERE close > sma25)::int as above,
      COUNT(*)::int as total
    FROM windowed
    WHERE window_count >= 25
      AND date >= ${calculationStart}
    GROUP BY date
    ORDER BY date ASC
  `;

  return rows
    .filter((r) => r.total > 0)
    .map((r) => ({ date: r.date, breadth: r.above / r.total }));
}

export interface LinearForecast {
  /** 線形回帰の傾き（breadth/日、0.01 = +1pp/日） */
  driftPerDay: number;
  /** target 到達までの予想営業日数。傾き ≤ 0 や既に target 以上なら null */
  daysToTarget: number | null;
  /** 到達予想日（営業日 → 暦日換算で約 1.4 倍） */
  expectedDate: Date | null;
}

/**
 * 直近の breadth トレンド（線形回帰）から target 到達日を点推定する。
 */
export function computeLinearForecast(
  history: BreadthHistoryPoint[],
  target: number,
): LinearForecast {
  if (history.length < 3) {
    return { driftPerDay: 0, daysToTarget: null, expectedDate: null };
  }

  const n = history.length;
  const xs = history.map((_, i) => i);
  const ys = history.map((p) => p.breadth);
  const sumX = xs.reduce((a, b) => a + b, 0);
  const sumY = ys.reduce((a, b) => a + b, 0);
  const sumXY = xs.reduce((a, x, i) => a + x * ys[i], 0);
  const sumX2 = xs.reduce((a, x) => a + x * x, 0);
  const denom = n * sumX2 - sumX * sumX;
  if (denom === 0) {
    return { driftPerDay: 0, daysToTarget: null, expectedDate: null };
  }
  const slope = (n * sumXY - sumX * sumY) / denom;

  const currentBreadth = history[n - 1].breadth;

  if (slope <= 0 || currentBreadth >= target) {
    return { driftPerDay: slope, daysToTarget: null, expectedDate: null };
  }

  // 浮動小数点誤差で 22.0 が 22.0000…01 になり Math.ceil で 23 になるのを防ぐ
  const daysToTarget = Math.ceil((target - currentBreadth) / slope - 1e-9);
  const lastDate = history[n - 1].date;
  const expectedDate = dayjs(lastDate)
    .add(Math.ceil(daysToTarget * 1.4), "day")
    .toDate();

  return { driftPerDay: slope, daysToTarget, expectedDate };
}

export interface SimilarCaseStats {
  /** 過去履歴で見つかったエピソード数 */
  count: number;
  /** 復帰までの中央値営業日数 */
  medianDays: number | null;
  /** 復帰までの最短営業日数 */
  minDays: number | null;
  /** 復帰までの最長営業日数 */
  maxDays: number | null;
  /** マッチ範囲下限 */
  rangeLower: number;
  /** マッチ範囲上限 */
  rangeUpper: number;
}

/**
 * 過去履歴から、現値レベル付近から target 復帰までの統計を計算する。
 *
 * アルゴリズム:
 *   - target を割った時点 (slumpStart) から target に復帰した時点 (recovery) までを 1エピソード
 *   - そのエピソード中で初めて breadth が [current - tol, current + tol] に入った時点を起点
 *   - 起点 → recovery までの営業日数を集計
 *
 * 各低迷期につき 1件のみカウント（重複防止）。
 */
export function computeSimilarCases(
  history: BreadthHistoryPoint[],
  currentBreadth: number,
  target: number,
  opts: { tolerance?: number } = {},
): SimilarCaseStats {
  const tolerance = opts.tolerance ?? 0.04;
  const lower = Math.max(0, currentBreadth - tolerance);
  const upper = Math.min(1, currentBreadth + tolerance);

  const recoveryDays: number[] = [];
  let inSlump = false;
  let slumpStartIdx = -1;

  for (let i = 0; i < history.length; i++) {
    const b = history[i].breadth;
    if (!inSlump && b < target) {
      inSlump = true;
      slumpStartIdx = i;
    } else if (inSlump && b >= target) {
      let touchIdx = -1;
      for (let k = slumpStartIdx; k < i; k++) {
        const bk = history[k].breadth;
        if (bk >= lower && bk <= upper) {
          touchIdx = k;
          break;
        }
      }
      if (touchIdx >= 0) {
        recoveryDays.push(i - touchIdx);
      }
      inSlump = false;
      slumpStartIdx = -1;
    }
  }

  if (recoveryDays.length === 0) {
    return {
      count: 0,
      medianDays: null,
      minDays: null,
      maxDays: null,
      rangeLower: lower,
      rangeUpper: upper,
    };
  }

  recoveryDays.sort((a, b) => a - b);
  const median = recoveryDays[Math.floor(recoveryDays.length * 0.5)];

  return {
    count: recoveryDays.length,
    medianDays: median,
    minDays: recoveryDays[0],
    maxDays: recoveryDays[recoveryDays.length - 1],
    rangeLower: lower,
    rangeUpper: upper,
  };
}

export interface BreadthEnrichment {
  /** 直近 N 日の breadth 推移 (古い順、% 表記) */
  recentSeries: number[];
  /** 直近日数あたりの平均変化 (% / 日) */
  recentAvgChangePct: number;
  forecast: LinearForecast;
  similar: SimilarCaseStats;
}

/**
 * 通知用にまとめた breadth 履歴情報を返す。
 * 履歴データが少ない場合でも安全に動作するよう、各フィールドは個別に欠損可。
 */
export async function buildBreadthEnrichment(opts: {
  currentBreadth: number;
  target: number;
  asOfDate: Date;
  recentDays?: number;
  similarLookbackDays?: number;
  similarTolerance?: number;
}): Promise<BreadthEnrichment> {
  const recentDays = opts.recentDays ?? 5;
  const lookbackDays = opts.similarLookbackDays ?? 500;

  const fullSeries = await fetchBreadthSeries({
    lookbackDays,
    endDate: opts.asOfDate,
  });

  const recent = fullSeries.slice(-recentDays);
  const recentSeriesPct = recent.map((p) => Number((p.breadth * 100).toFixed(1)));

  let recentAvgChangePct = 0;
  if (recent.length >= 2) {
    const first = recent[0].breadth;
    const last = recent[recent.length - 1].breadth;
    recentAvgChangePct = ((last - first) / (recent.length - 1)) * 100;
  }

  const forecast = computeLinearForecast(recent, opts.target);
  const similar = computeSimilarCases(fullSeries, opts.currentBreadth, opts.target, {
    tolerance: opts.similarTolerance,
  });

  return {
    recentSeries: recentSeriesPct,
    recentAvgChangePct,
    forecast,
    similar,
  };
}

/**
 * Slack 通知本文用の複数行サマリーを生成する。
 * 各行は単独でも意味が通る。null 行はスキップ。
 */
export function formatEnrichment(
  enrichment: BreadthEnrichment,
  target: number,
): string {
  const lines: string[] = [];

  if (enrichment.recentSeries.length >= 2) {
    const change = enrichment.recentAvgChangePct;
    const arrow = change > 0.1 ? "↗" : change < -0.1 ? "↘" : "→";
    const sign = change >= 0 ? "+" : "";
    const series = enrichment.recentSeries.map((v) => v.toFixed(1)).join("→");
    lines.push(`📈 直近推移: ${series}% (${arrow} ${sign}${change.toFixed(2)}%/日)`);
  }

  const fc = enrichment.forecast;
  if (fc.daysToTarget !== null && fc.expectedDate !== null) {
    const dateStr = dayjs(fc.expectedDate).format("M/D");
    lines.push(
      `🎯 点推定: ≈${fc.daysToTarget}営業日後（${dateStr}頃）に${(target * 100).toFixed(0)}%復帰`,
    );
  } else if (enrichment.recentSeries.length >= 3) {
    lines.push(`🎯 点推定: 直近トレンドは横ばい〜下降（目標未達）`);
  }

  const s = enrichment.similar;
  if (s.count > 0) {
    const rangeStr = `${(s.rangeLower * 100).toFixed(0)}-${(s.rangeUpper * 100).toFixed(0)}%`;
    lines.push(
      `📊 過去類似(${rangeStr}帯, N=${s.count}): ${s.minDays}〜${s.maxDays}営業日で復帰（中央値${s.medianDays}）`,
    );
  }

  return lines.join("\n");
}
