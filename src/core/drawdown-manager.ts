/**
 * ドローダウン管理モジュール
 *
 * 週次・月次のドローダウン上限、連敗後のクールダウンを管理する。
 * TradingDailySummaryとTradingPositionの実績データから動的に計算。
 */

import { prisma } from "../lib/prisma";
import { DRAWDOWN } from "../lib/constants";
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
  consecutiveLosses: number;
  shouldHaltTrading: boolean;
  maxPositionsOverride: number | null;
  reason: string;
}

/**
 * ドローダウン状況を計算する
 *
 * 判定:
 * - 週次損失 ≥ 5% → 取引停止
 * - 月次損失 ≥ 10% → 取引停止
 * - 5連敗 → 取引停止
 * - 3連敗 → 最大1ポジションに制限
 */
export async function calculateDrawdownStatus(): Promise<DrawdownStatus> {
  const config = await prisma.tradingConfig.findFirst({
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
      consecutiveLosses: 0,
      shouldHaltTrading: true,
      maxPositionsOverride: null,
      reason: "TradingConfig が設定されていません",
    };
  }

  const totalBudget = Number(config.totalBudget);
  const peakEquity = config.peakEquity
    ? Number(config.peakEquity)
    : totalBudget;

  // 週次P&L: 今週月曜日以降
  const nowJST = dayjs().tz("Asia/Tokyo");
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

  // 連敗数: 直近のクローズ済みポジションから逆順にカウント
  const recentPositions = await prisma.tradingPosition.findMany({
    where: {
      status: "closed",
      exitedAt: { not: null },
    },
    orderBy: { exitedAt: "desc" },
    take: DRAWDOWN.COOLDOWN_HALT_TRIGGER + 1,
    select: { realizedPnl: true },
  });

  let consecutiveLosses = 0;
  for (const pos of recentPositions) {
    if (pos.realizedPnl && Number(pos.realizedPnl) < 0) {
      consecutiveLosses++;
    } else {
      break;
    }
  }

  // ドローダウン率
  const weeklyDrawdownPct =
    totalBudget > 0 ? (Math.abs(Math.min(weeklyPnl, 0)) / totalBudget) * 100 : 0;
  const monthlyDrawdownPct =
    totalBudget > 0
      ? (Math.abs(Math.min(monthlyPnl, 0)) / totalBudget) * 100
      : 0;
  const drawdownPct =
    peakEquity > 0 ? ((peakEquity - totalBudget) / peakEquity) * 100 : 0;

  // 停止判定
  let shouldHaltTrading = false;
  let maxPositionsOverride: number | null = null;
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

  if (consecutiveLosses >= DRAWDOWN.COOLDOWN_HALT_TRIGGER) {
    shouldHaltTrading = true;
    reasons.push(`${consecutiveLosses}連敗（停止閾値: ${DRAWDOWN.COOLDOWN_HALT_TRIGGER}）`);
  } else if (consecutiveLosses >= DRAWDOWN.COOLDOWN_TRIGGER) {
    maxPositionsOverride = DRAWDOWN.COOLDOWN_MAX_POSITIONS;
    reasons.push(
      `${consecutiveLosses}連敗 → 最大${DRAWDOWN.COOLDOWN_MAX_POSITIONS}ポジションに制限`,
    );
  }

  return {
    currentEquity: totalBudget,
    peakEquity,
    drawdownPct: Math.max(drawdownPct, 0),
    weeklyPnl,
    weeklyDrawdownPct,
    monthlyPnl,
    monthlyDrawdownPct,
    consecutiveLosses,
    shouldHaltTrading,
    maxPositionsOverride,
    reason: reasons.length > 0 ? reasons.join("; ") : "OK",
  };
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
