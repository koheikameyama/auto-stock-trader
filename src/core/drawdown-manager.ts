/**
 * ドローダウン管理モジュール
 *
 * 週次・月次のドローダウン上限を管理する。
 * TradingDailySummaryの実績データから動的に計算。
 */

import { prisma } from "../lib/prisma";
import { DRAWDOWN, TIMEZONE } from "../lib/constants";
import { getEffectiveCapital } from "./position-manager";
import type { TradingConfig } from "@prisma/client";
import dayjs from "dayjs";
import utc from "dayjs/plugin/utc.js";
import timezone from "dayjs/plugin/timezone.js";

dayjs.extend(utc);
dayjs.extend(timezone);

export interface DrawdownStatus {
  currentEquity: number;
  peakEquity: number;
  drawdownPct: number;
  weeklyPnl: number;
  weeklyDrawdownPct: number;
  monthlyPnl: number;
  monthlyDrawdownPct: number;
  shouldHaltTrading: boolean;
  reason: string;
}

/**
 * ドローダウン状況を計算する
 *
 * 判定:
 * - 週次損失 ≥ 5% → 取引停止
 * - 月次損失 ≥ 10% → 取引停止
 */
/** 事前取得データ（重複クエリ削減用） */
export interface DrawdownPrefetch {
  config?: TradingConfig;
  effectiveCapital?: number;
}

export async function calculateDrawdownStatus(
  prefetch?: DrawdownPrefetch,
): Promise<DrawdownStatus> {
  const config = prefetch?.config ?? await prisma.tradingConfig.findFirst({
    orderBy: { createdAt: "desc" },
  });

  if (!config) {
    return {
      currentEquity: 0,
      peakEquity: 0,
      drawdownPct: 0,
      weeklyPnl: 0,
      weeklyDrawdownPct: 0,
      monthlyPnl: 0,
      monthlyDrawdownPct: 0,
      shouldHaltTrading: true,
      reason: "TradingConfig が設定されていません",
    };
  }

  const effectiveCap = prefetch?.effectiveCapital ?? await getEffectiveCapital(config);
  const peakEquity = config.peakEquity
    ? Number(config.peakEquity)
    : effectiveCap;

  // 週次P&L: 今週月曜日以降
  const nowJST = dayjs().tz(TIMEZONE);
  const mondayJST = nowJST.startOf("week").add(1, "day"); // dayjs week starts on Sunday
  const mondayUTC = new Date(
    Date.UTC(mondayJST.year(), mondayJST.month(), mondayJST.date()),
  );

  const weeklySummaries = await prisma.tradingDailySummary.findMany({
    where: { date: { gte: mondayUTC } },
  });
  const weeklyPnl = weeklySummaries.reduce(
    (sum, s) => sum + Number(s.totalPnl),
    0,
  );

  // 月次P&L: 今月1日以降
  const firstOfMonthJST = nowJST.startOf("month");
  const firstOfMonthUTC = new Date(
    Date.UTC(
      firstOfMonthJST.year(),
      firstOfMonthJST.month(),
      firstOfMonthJST.date(),
    ),
  );

  const monthlySummaries = await prisma.tradingDailySummary.findMany({
    where: { date: { gte: firstOfMonthUTC } },
  });
  const monthlyPnl = monthlySummaries.reduce(
    (sum, s) => sum + Number(s.totalPnl),
    0,
  );

  // ドローダウン率
  const weeklyDrawdownPct =
    effectiveCap > 0 ? (Math.abs(Math.min(weeklyPnl, 0)) / effectiveCap) * 100 : 0;
  const monthlyDrawdownPct =
    effectiveCap > 0
      ? (Math.abs(Math.min(monthlyPnl, 0)) / effectiveCap) * 100
      : 0;
  const drawdownPct =
    peakEquity > 0 ? ((peakEquity - effectiveCap) / peakEquity) * 100 : 0;

  // 停止判定
  let shouldHaltTrading = false;
  const reasons: string[] = [];

  if (weeklyDrawdownPct >= DRAWDOWN.WEEKLY_HALT_PCT) {
    shouldHaltTrading = true;
    reasons.push(
      `週次損失 ${weeklyDrawdownPct.toFixed(1)}% ≥ ${DRAWDOWN.WEEKLY_HALT_PCT}%`,
    );
  }

  if (monthlyDrawdownPct >= DRAWDOWN.MONTHLY_HALT_PCT) {
    shouldHaltTrading = true;
    reasons.push(
      `月次損失 ${monthlyDrawdownPct.toFixed(1)}% ≥ ${DRAWDOWN.MONTHLY_HALT_PCT}%`,
    );
  }

  return {
    currentEquity: effectiveCap,
    peakEquity,
    drawdownPct: Math.max(drawdownPct, 0),
    weeklyPnl,
    weeklyDrawdownPct,
    monthlyPnl,
    monthlyDrawdownPct,
    shouldHaltTrading,
    reason: reasons.length > 0 ? reasons.join("; ") : "OK",
  };
}

/**
 * 直近のクローズ済みポジションから連敗数を動的計算する
 *
 * closedAt降順で並べて、連続する負けトレード（realizedPnl < 0）の数を返す。
 * 1つでも勝ちがあればそこでリセットされる。
 */
export async function getLosingStreak(): Promise<number> {
  const recentPositions = await prisma.tradingPosition.findMany({
    where: { status: "closed", closedAt: { not: null } },
    orderBy: { closedAt: "desc" },
    take: 10,
    select: { realizedPnl: true },
  });

  let streak = 0;
  for (const pos of recentPositions) {
    if (Number(pos.realizedPnl) < 0) {
      streak++;
    } else {
      break;
    }
  }
  return streak;
}

/**
 * ピークエクイティを更新する（end-of-dayで呼び出し）
 *
 * 現在の資産がハイウォーターマークを超えていれば更新する。
 */
export async function updatePeakEquity(currentEquity: number): Promise<void> {
  const config = await prisma.tradingConfig.findFirst({
    orderBy: { createdAt: "desc" },
  });

  if (!config) return;

  const currentPeak = config.peakEquity ? Number(config.peakEquity) : 0;

  if (currentEquity > currentPeak) {
    await prisma.tradingConfig.update({
      where: { id: config.id },
      data: { peakEquity: Math.round(currentEquity) },
    });
  }
}
