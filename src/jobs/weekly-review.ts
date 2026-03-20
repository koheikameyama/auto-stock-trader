/**
 * 週次レビュー（土曜 10:00 JST）
 *
 * 1. 週間パフォーマンス集計
 * 2. AIによる戦略レビュー（構造化出力）
 * 3. DB保存
 * 4. Slackにレポート送信
 */

import { prisma } from "../lib/prisma";
import { OPENAI_CONFIG, WEEKLY_REVIEW } from "../lib/constants";
import { getTracedOpenAIClient } from "../lib/openai";
import { flushLangfuse } from "../lib/langfuse";
import { notifySlack } from "../lib/slack";
import { jstDateAsUTC } from "../lib/date-utils";
import dayjs from "dayjs";
import utc from "dayjs/plugin/utc";
import timezone from "dayjs/plugin/timezone";

dayjs.extend(utc);
dayjs.extend(timezone);

const JST = "Asia/Tokyo";

const WEEKLY_REVIEW_SCHEMA = {
  type: "json_schema" as const,
  json_schema: {
    name: "weekly_review",
    strict: true,
    schema: {
      type: "object",
      properties: {
        performance: { type: "string", description: "今週のパフォーマンス評価（50文字以内）" },
        strengths: { type: "string", description: "良かった点（50文字以内）" },
        improvements: { type: "string", description: "改善すべき点（50文字以内）" },
        nextWeekStrategy: { type: "string", description: "来週の戦略提案（50文字以内）" },
      },
      required: ["performance", "strengths", "improvements", "nextWeekStrategy"],
      additionalProperties: false,
    },
  },
};

type WeeklyAIReview = {
  performance: string;
  strengths: string;
  improvements: string;
  nextWeekStrategy: string;
};

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
      title: "📊 週次レビュー",
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

  // 直近の注文履歴
  const _recentOrders = await prisma.tradingOrder.findMany({
    where: {
      createdAt: { gte: weekAgo },
      status: "filled",
    },
    include: { stock: true },
    orderBy: { filledAt: "asc" },
  });

  // 直近のクローズポジション
  const closedPositions = await prisma.tradingPosition.findMany({
    where: {
      status: "closed",
      exitedAt: { gte: weekAgo },
    },
    include: { stock: true },
    orderBy: { exitedAt: "asc" },
  });

  console.log(`  取引日数: ${tradingDays}, 取引数: ${totalTrades}, PnL: ¥${totalPnl.toLocaleString()}`);

  // AIレビュー生成
  console.log("AI週次レビュー生成中...");

  const positionSummary = closedPositions
    .map((p) => {
      const pnl = p.realizedPnl ? Number(p.realizedPnl) : 0;
      return `${p.stock.tickerCode} ${p.stock.name}: ${p.strategy}, 損益 ¥${pnl.toLocaleString()}`;
    })
    .join("\n");

  let aiReview: WeeklyAIReview | null = null;
  try {
    const openai = getTracedOpenAIClient({
      generationName: "weekly-review",
      tags: ["review", "weekly"],
    });
    const response = await openai.chat.completions.create({
      model: OPENAI_CONFIG.MODEL,
      temperature: 0.5,
      response_format: WEEKLY_REVIEW_SCHEMA,
      messages: [
        {
          role: "user",
          content: `週次の自動売買シミュレーション結果をレビューしてください。

【週間サマリー】
- 取引日数: ${tradingDays}日
- 取引数: ${totalTrades}件（${totalWins}勝 ${totalLosses}敗）
- 確定損益: ¥${totalPnl.toLocaleString()}
- ポートフォリオ時価: ¥${portfolioValue.toLocaleString()}
- 現金残高: ¥${cashBalance.toLocaleString()}

【クローズポジション詳細】
${positionSummary || "なし"}

各項目を50文字以内で簡潔に述べてください。`,
        },
      ],
      max_tokens: 500,
    });

    aiReview = JSON.parse(response.choices[0].message.content ?? "{}");
  } catch (error) {
    console.error("AIレビュー生成エラー:", error);
  }

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
        aiReview: aiReview ?? {},
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
        aiReview: aiReview ?? {},
      },
    });
    console.log("  週次サマリーをDBに保存しました");
  } catch (error) {
    console.error("DB保存エラー:", error);
  }

  // Slack通知
  const pnlEmoji = totalPnl >= 0 ? "📈" : "📉";
  const slackMessage = aiReview
    ? [
        `📊 ${aiReview.performance}`,
        `💪 ${aiReview.strengths}`,
        `🔧 ${aiReview.improvements}`,
        `🎯 ${aiReview.nextWeekStrategy}`,
      ].join("\n")
    : "AIレビューの生成に失敗しました";

  await notifySlack({
    title: `📊 週次レビュー（${monday.format("MM/DD")}〜${friday.format("MM/DD")}）`,
    message: slackMessage,
    color: totalPnl >= 0 ? "good" : "danger",
    fields: [
      {
        title: "週間損益",
        value: `${pnlEmoji} ¥${totalPnl.toLocaleString()}`,
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
      await flushLangfuse();
      await prisma.$disconnect();
    });
}
