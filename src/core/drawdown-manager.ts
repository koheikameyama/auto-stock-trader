/**
 * ドローダウン管理モジュール
 *
 * 週次・月次のドローダウン上限、連敗後のクールダウンを管理する。
 * TradingDailySummaryとTradingPositionの実績データから動的に計算。
 */

import { prisma } from "../lib/prisma";
import { DRAWDOWN } from "../lib/constants";
import { getEffectiveCapital } from "./position-manager";
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
  consecutiveWins: number;
  isRecoveryMode: boolean;
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
      consecutiveWins: 0,
      isRecoveryMode: false,
      shouldHaltTrading: true,
      maxPositionsOverride: null,
      reason: "TradingConfig が設定されていません",
    };
  }

  const effectiveCap = await getEffectiveCapital(config);
  const peakEquity = config.peakEquity
    ? Number(config.peakEquity)
    : effectiveCap;

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

  // 連敗/回復数: 直近のクローズ済みポジションから分析
  // 5連敗停止後は3連勝が揃うまで停止を継続するため、十分な件数を取得する
  const recentPositions = await prisma.tradingPosition.findMany({
    where: {
      status: "closed",
      exitedAt: { not: null },
    },
    orderBy: { exitedAt: "desc" },
    take: DRAWDOWN.COOLDOWN_HALT_TRIGGER + DRAWDOWN.RECOVERY_WINS_REQUIRED + 1,
    select: { realizedPnl: true },
  });

  // 直近の連勝数（最新から数える）
  let consecutiveWins = 0;
  for (const pos of recentPositions) {
    if (pos.realizedPnl && Number(pos.realizedPnl) > 0) {
      consecutiveWins++;
    } else {
      break;
    }
  }

  // 連勝の後ろにある連敗数（停止トリガーや回復判定に使用）
  let consecutiveLosses = 0;
  for (const pos of recentPositions.slice(consecutiveWins)) {
    if (pos.realizedPnl && Number(pos.realizedPnl) < 0) {
      consecutiveLosses++;
    } else {
      break;
    }
  }

  // 回復モード: 5連敗後にまだ3連勝に達していない状態
  const isRecoveryMode =
    consecutiveWins > 0 &&
    consecutiveWins < DRAWDOWN.RECOVERY_WINS_REQUIRED &&
    consecutiveLosses >= DRAWDOWN.COOLDOWN_HALT_TRIGGER;

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

  if (consecutiveLosses >= DRAWDOWN.COOLDOWN_HALT_TRIGGER && consecutiveWins === 0) {
    // アクティブな連敗中
    shouldHaltTrading = true;
    reasons.push(`${consecutiveLosses}連敗（停止閾値: ${DRAWDOWN.COOLDOWN_HALT_TRIGGER}）`);
  } else if (isRecoveryMode) {
    // 5連敗後の回復中: 3連勝に達するまで停止を継続
    shouldHaltTrading = true;
    reasons.push(
      `回復中: ${consecutiveLosses}連敗後 ${consecutiveWins}/${DRAWDOWN.RECOVERY_WINS_REQUIRED}連勝（あと${DRAWDOWN.RECOVERY_WINS_REQUIRED - consecutiveWins}勝で再開）`,
    );
  } else if (consecutiveLosses >= DRAWDOWN.COOLDOWN_TRIGGER && consecutiveWins === 0) {
    maxPositionsOverride = DRAWDOWN.COOLDOWN_MAX_POSITIONS;
    reasons.push(
      `${consecutiveLosses}連敗 → 最大${DRAWDOWN.COOLDOWN_MAX_POSITIONS}ポジションに制限`,
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
    consecutiveLosses,
    consecutiveWins,
    isRecoveryMode,
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
