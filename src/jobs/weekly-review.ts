/**
 * 週次レビュー（土曜 10:00 JST）
 *
 * 1. 週間パフォーマンス集計
 * 2. 機械的サマリー生成
 * 3. DB保存
 * 4. Slackにレポート送信
 */

import { prisma } from "../lib/prisma";
import { WEEKLY_REVIEW } from "../lib/constants";
import { notifySlack } from "../lib/slack";
import { jstDateAsUTC } from "../lib/date-utils";
import dayjs from "dayjs";
import utc from "dayjs/plugin/utc";
import timezone from "dayjs/plugin/timezone";
import { TIMEZONE } from "../lib/constants";

dayjs.extend(utc);
dayjs.extend(timezone);

const JST = TIMEZONE;

interface WeeklyReview {
  [key: string]: string;
  performance: string;
  strengths: string;
  improvements: string;
  nextWeekStrategy: string;
}

export async function main() {
  console.log("=== Weekly Review 開始 ===");

  // 直前の月〜金を対象とする（土曜実行前提、他の曜日でも安全）
  const now = dayjs().tz(JST);
  // 直近の金曜を確実に取得: 金曜以降ならそのまま、それ以外は前週の金曜
  const friday = now.day() >= 5
    ? now.day(5)
    : now.subtract(1, "week").day(5);
  const monday = friday.day(1); // 同じ週の月曜
  const weekStart = jstDateAsUTC(monday);
  const weekEnd = jstDateAsUTC(friday);

  // 直近7日間のサマリーを取得
  const weekAgo = dayjs().subtract(WEEKLY_REVIEW.LOOKBACK_DAYS, "day").toDate();

  const dailySummaries = await prisma.tradingDailySummary.findMany({
    where: { date: { gte: weekAgo } },
    orderBy: { date: "asc" },
  });

  if (dailySummaries.length === 0) {
    console.log("今週の取引データがありません。");
    await notifySlack({
      title: "週次レビュー",
      message: "今週は取引がありませんでした。",
      color: "#808080",
    });
    return;
  }

  // 集計
  const totalTrades = dailySummaries.reduce((s, d) => s + d.totalTrades, 0);
  const totalWins = dailySummaries.reduce((s, d) => s + d.wins, 0);
  const totalLosses = dailySummaries.reduce((s, d) => s + d.losses, 0);
  const totalPnl = dailySummaries.reduce(
    (s, d) => s + Number(d.totalPnl),
    0,
  );
  const tradingDays = dailySummaries.length;

  const latestSummary = dailySummaries[dailySummaries.length - 1];
  const portfolioValue = Number(latestSummary.portfolioValue);
  const cashBalance = Number(latestSummary.cashBalance);

  console.log(`  取引日数: ${tradingDays}, 取引数: ${totalTrades}, PnL: ¥${totalPnl.toLocaleString()}`);

  // 機械的レビュー生成
  console.log("週次サマリー生成中...");

  const winRate = totalTrades > 0 ? ((totalWins / totalTrades) * 100).toFixed(0) : "0";
  const avgPnlPerTrade = totalTrades > 0 ? Math.round(totalPnl / totalTrades) : 0;

  const review: WeeklyReview = {
    performance: totalTrades > 0
      ? `${totalTrades}件取引, ${totalWins}勝${totalLosses}敗(勝率${winRate}%), 損益¥${totalPnl.toLocaleString()}`
      : `取引なし, PF時価¥${portfolioValue.toLocaleString()}`,
    strengths: totalWins > 0
      ? `${totalWins}件の勝ちトレード, 平均損益¥${avgPnlPerTrade.toLocaleString()}/件`
      : "該当なし",
    improvements: totalLosses > 0
      ? `${totalLosses}件の負けトレードを分析し損切り精度を改善`
      : "特になし",
    nextWeekStrategy: "ルールベースのbreakout/gapup戦略を継続運用",
  };

  // DB保存
  try {
    await prisma.tradingWeeklySummary.upsert({
      where: { weekEnd },
      create: {
        weekStart,
        weekEnd,
        tradingDays,
        totalTrades,
        wins: totalWins,
        losses: totalLosses,
        totalPnl,
        portfolioValue,
        cashBalance,
        aiReview: review,
      },
      update: {
        weekStart,
        tradingDays,
        totalTrades,
        wins: totalWins,
        losses: totalLosses,
        totalPnl,
        portfolioValue,
        cashBalance,
        aiReview: review,
      },
    });
    console.log("  週次サマリーをDBに保存しました");
  } catch (error) {
    console.error("DB保存エラー:", error);
  }

  // Slack通知
  const pnlEmoji = totalPnl >= 0 ? "+" : "";
  const slackMessage = [
    review.performance,
    review.strengths !== "該当なし" ? `勝ちトレード: ${review.strengths}` : null,
    review.improvements !== "特になし" ? `改善: ${review.improvements}` : null,
  ].filter(Boolean).join("\n");

  await notifySlack({
    title: `週次レビュー（${monday.format("MM/DD")}〜${friday.format("MM/DD")}）`,
    message: slackMessage,
    color: totalPnl >= 0 ? "good" : "danger",
    fields: [
      {
        title: "週間損益",
        value: `${pnlEmoji}¥${totalPnl.toLocaleString()}`,
        short: true,
      },
      {
        title: "勝敗",
        value: `${totalWins}勝${totalLosses}敗`,
        short: true,
      },
      {
        title: "取引日数",
        value: `${tradingDays}日`,
        short: true,
      },
      {
        title: "ポートフォリオ",
        value: `¥${portfolioValue.toLocaleString()}`,
        short: true,
      },
    ],
  });

  console.log("=== Weekly Review 終了 ===");
}

const isDirectRun = process.argv[1]?.includes("weekly-review");
if (isDirectRun) {
  main()
    .catch((error) => {
      console.error("Weekly Review エラー:", error);
      process.exit(1);
    })
    .finally(async () => {
      await prisma.$disconnect();
    });
}
