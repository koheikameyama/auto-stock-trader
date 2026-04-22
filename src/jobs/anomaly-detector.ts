/**
 * 異常検知アラートジョブ（平日朝に実行）
 *
 * 取引停止には連動しない「観測通知」専用ジョブ。
 * 想定外の挙動（大DD・連敗・長期沈黙）を Slack で早期に察知できるようにする。
 *
 * 検知対象:
 *   1. 月次DD ≥ 10%
 *   2. 直近20トレードの勝率 < 30%
 *   3. 直近5日で連敗4件以上
 *   4. 30日間エントリーゼロ
 */

import { prisma } from "../lib/prisma";
import { ANOMALY_ALERT, TIMEZONE } from "../lib/constants";
import { calculateDrawdownStatus } from "../core/drawdown-manager";
import { getPositionPnl } from "../core/position-manager";
import { notifySlack } from "../lib/slack";
import dayjs from "dayjs";
import utc from "dayjs/plugin/utc.js";
import timezone from "dayjs/plugin/timezone.js";

dayjs.extend(utc);
dayjs.extend(timezone);

interface Anomaly {
  code: string;
  title: string;
  detail: string;
}

export async function detectAnomalies(): Promise<Anomaly[]> {
  const anomalies: Anomaly[] = [];

  // 1. 月次DD ≥ 10%
  const dd = await calculateDrawdownStatus();
  if (dd.monthlyDrawdownPct >= ANOMALY_ALERT.MONTHLY_DRAWDOWN_PCT) {
    anomalies.push({
      code: "monthly_drawdown",
      title: "月次ドローダウン超過",
      detail:
        `月次DD ${dd.monthlyDrawdownPct.toFixed(1)}% ≥ ${ANOMALY_ALERT.MONTHLY_DRAWDOWN_PCT}% ` +
        `(月次P&L ¥${dd.monthlyPnl.toLocaleString()})`,
    });
  }

  // 2. 直近20トレードの勝率 < 30%
  const recent = await prisma.tradingPosition.findMany({
    where: { status: "closed", exitedAt: { not: null }, exitPrice: { not: null } },
    orderBy: { exitedAt: "desc" },
    take: ANOMALY_ALERT.RECENT_TRADES_WINDOW,
    select: { entryPrice: true, exitPrice: true, quantity: true },
  });
  if (recent.length === ANOMALY_ALERT.RECENT_TRADES_WINDOW) {
    const wins = recent.filter((p) => getPositionPnl(p) > 0).length;
    const winRatePct = (wins / recent.length) * 100;
    if (winRatePct < ANOMALY_ALERT.RECENT_TRADES_MIN_WINRATE_PCT) {
      anomalies.push({
        code: "low_win_rate",
        title: "勝率低下",
        detail:
          `直近${recent.length}件の勝率 ${winRatePct.toFixed(1)}% ` +
          `< ${ANOMALY_ALERT.RECENT_TRADES_MIN_WINRATE_PCT}% (勝${wins}/負${recent.length - wins})`,
      });
    }
  }

  // 3. 直近5日で連敗4件以上（決済日ベース）
  const fiveDaysAgo = dayjs().tz(TIMEZONE).subtract(ANOMALY_ALERT.STREAK_WINDOW_DAYS, "day").toDate();
  const recentByDate = await prisma.tradingPosition.findMany({
    where: {
      status: "closed",
      exitedAt: { gte: fiveDaysAgo, not: null },
      exitPrice: { not: null },
    },
    orderBy: { exitedAt: "desc" },
    select: { entryPrice: true, exitPrice: true, quantity: true },
  });
  const lossesInWindow = recentByDate.filter((p) => getPositionPnl(p) < 0).length;
  if (lossesInWindow >= ANOMALY_ALERT.STREAK_MIN_LOSSES) {
    anomalies.push({
      code: "loss_streak",
      title: "短期連敗",
      detail:
        `直近${ANOMALY_ALERT.STREAK_WINDOW_DAYS}日で負け${lossesInWindow}件 ` +
        `(全${recentByDate.length}件中)`,
    });
  }

  // 4. 30日間エントリーゼロ
  const thirtyDaysAgo = dayjs().tz(TIMEZONE).subtract(ANOMALY_ALERT.SILENT_DAYS, "day").toDate();
  const recentEntries = await prisma.tradingPosition.count({
    where: { createdAt: { gte: thirtyDaysAgo } },
  });
  if (recentEntries === 0) {
    anomalies.push({
      code: "silent_entries",
      title: "長期エントリーゼロ",
      detail: `直近${ANOMALY_ALERT.SILENT_DAYS}日間で新規エントリーが0件 (システム停止の可能性)`,
    });
  }

  return anomalies;
}

export async function main(): Promise<void> {
  const tag = "[anomaly-detector]";
  console.log(`${tag} 異常検知を開始...`);

  const anomalies = await detectAnomalies();

  if (anomalies.length === 0) {
    console.log(`${tag} ✅ 異常なし`);
    return;
  }

  console.warn(`${tag} ⚠️ ${anomalies.length}件の異常を検知`);
  for (const a of anomalies) {
    console.warn(`  - [${a.code}] ${a.title}: ${a.detail}`);
  }

  await notifySlack({
    title: `🚨 異常検知アラート: ${anomalies.length}件`,
    message: anomalies.map((a) => `• *${a.title}* — ${a.detail}`).join("\n"),
    color: "danger",
  });
}
