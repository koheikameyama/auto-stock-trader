/**
 * スコアリング精度レポート（土曜 11:00 JST）
 *
 * ゴースト実績データをもとにスコアリングシステムの弱点を定量集計し、Slackに送信する。
 *
 * 1. 直近7日間のScoringRecordを取得（ゴースト実績あり）
 * 2. カテゴリ別の見逃し要因分析
 * 3. ランク別の的中率集計
 * 4. rejectionReason別の機会損失集計
 * 5. 週次/月次トレンド比較
 * 6. Slackにレポート送信
 */

import { prisma } from "../lib/prisma";
import { getDaysAgoForDB } from "../lib/date-utils";
import { SCORING_V1 as SCORING, SCORING_ACCURACY_REPORT } from "../lib/constants";
import { notifyScoringAccuracyReport } from "../lib/slack";
import dayjs from "dayjs";

interface ScoringRecordRow {
  rank: string;
  technicalScore: number;
  patternScore: number;
  liquidityScore: number;
  fundamentalScore: number;
  rejectionReason: string | null;
  ghostProfitPct: number; // Number()済み
}

function toRows(
  records: Awaited<ReturnType<typeof prisma.scoringRecord.findMany>>,
): ScoringRecordRow[] {
  return records.map((r) => ({
    rank: r.rank,
    technicalScore: r.technicalScore,
    patternScore: r.patternScore,
    liquidityScore: r.liquidityScore,
    fundamentalScore: r.fundamentalScore,
    rejectionReason: r.rejectionReason,
    ghostProfitPct: Number(r.ghostProfitPct),
  }));
}

/** カテゴリ別弱点分析 */
function analyzeCategoryWeakness(missedStocks: ScoringRecordRow[]) {
  const categories = [
    {
      key: "テクニカル",
      maxScore: SCORING.CATEGORY_MAX.TECHNICAL,
      getScore: (r: ScoringRecordRow) => r.technicalScore,
    },
    {
      key: "パターン",
      maxScore: SCORING.CATEGORY_MAX.PATTERN,
      getScore: (r: ScoringRecordRow) => r.patternScore,
    },
    {
      key: "流動性",
      maxScore: SCORING.CATEGORY_MAX.LIQUIDITY,
      getScore: (r: ScoringRecordRow) => r.liquidityScore,
    },
    {
      key: "ファンダ",
      maxScore: SCORING.CATEGORY_MAX.FUNDAMENTAL,
      getScore: (r: ScoringRecordRow) => r.fundamentalScore,
    },
  ];

  return categories.map((cat) => {
    const totalDeficit = missedStocks.reduce(
      (sum, r) => sum + (cat.maxScore - cat.getScore(r)),
      0,
    );
    return {
      category: cat.key,
      avgDeficit:
        missedStocks.length > 0 ? totalDeficit / missedStocks.length : 0,
      maxScore: cat.maxScore,
    };
  });
}

/** ランク別実績集計 */
function analyzeRankAccuracy(rows: ScoringRecordRow[]) {
  const ranks = ["S", "A", "B", "C"];
  return ranks.map((rank) => {
    const group = rows.filter((r) => r.rank === rank);
    const count = group.length;
    if (count === 0) {
      return { rank, avgProfitPct: 0, positiveRate: 0, count: 0 };
    }
    const avgProfitPct =
      group.reduce((s, r) => s + r.ghostProfitPct, 0) / count;
    const positiveRate =
      (group.filter((r) => r.ghostProfitPct > 0).length / count) * 100;
    return { rank, avgProfitPct, positiveRate, count };
  });
}

/** rejectionReason別の機会損失集計 */
function analyzeRejectionCost(rows: ScoringRecordRow[]) {
  const reasons = [
    "below_threshold",
    "ai_no_go",
    "disqualified",
    "market_halted",
  ];
  const rejected = rows.filter((r) => r.rejectionReason != null);

  return reasons.map((reason) => {
    const group = rejected.filter((r) => r.rejectionReason === reason);
    const count = group.length;
    const profitable = group.filter((r) => r.ghostProfitPct > 0);
    const profitableCount = profitable.length;
    const avgMissedProfit =
      profitableCount > 0
        ? profitable.reduce((s, r) => s + r.ghostProfitPct, 0) /
          profitableCount
        : 0;
    return { reason, count, profitableCount, avgMissedProfit };
  });
}

/** 全体統計 */
function computeStats(rows: ScoringRecordRow[]) {
  if (rows.length === 0) {
    return { positiveRate: 0, avgProfit: 0 };
  }
  const positiveRate =
    (rows.filter((r) => r.ghostProfitPct > 0).length / rows.length) * 100;
  const avgProfit =
    rows.reduce((s, r) => s + r.ghostProfitPct, 0) / rows.length;
  return { positiveRate, avgProfit };
}

export async function main() {
  console.log("=== Scoring Accuracy Report 開始 ===");

  // データ取得
  const [weeklyRaw, monthlyRaw] = await Promise.all([
    prisma.scoringRecord.findMany({
      where: {
        date: {
          gte: getDaysAgoForDB(SCORING_ACCURACY_REPORT.WEEKLY_LOOKBACK_DAYS),
        },
        ghostProfitPct: { not: null },
      },
    }),
    prisma.scoringRecord.findMany({
      where: {
        date: {
          gte: getDaysAgoForDB(SCORING_ACCURACY_REPORT.MONTHLY_LOOKBACK_DAYS),
        },
        ghostProfitPct: { not: null },
      },
    }),
  ]);

  const weeklyRows = toRows(weeklyRaw);
  const monthlyRows = toRows(monthlyRaw);

  console.log(
    `  週次レコード: ${weeklyRows.length}件, 月次レコード: ${monthlyRows.length}件`,
  );

  if (weeklyRows.length === 0) {
    console.log("今週のスコアリングデータがありません。");
    const { notifySlack } = await import("../lib/slack");
    await notifySlack({
      title: "🎯 スコアリング精度レポート",
      message: "今週はスコアリングデータがありませんでした。",
      color: "#808080",
    });
    return;
  }

  // 見逃し銘柄: 却下されたが利益が出ていた銘柄
  const missedStocks = weeklyRows.filter(
    (r) =>
      r.rejectionReason != null &&
      r.ghostProfitPct >= SCORING_ACCURACY_REPORT.MISSED_PROFIT_THRESHOLD,
  );

  // 各セクションの集計
  const categoryWeakness = analyzeCategoryWeakness(missedStocks);
  const rankAccuracy = analyzeRankAccuracy(weeklyRows);
  const rejectionCost = analyzeRejectionCost(weeklyRows);
  const weeklyStats = computeStats(weeklyRows);
  const monthlyStats = computeStats(monthlyRows);

  const periodLabel = `${dayjs().subtract(SCORING_ACCURACY_REPORT.WEEKLY_LOOKBACK_DAYS, "day").format("MM/DD")}〜${dayjs().format("MM/DD")}`;

  console.log(`  見逃し銘柄: ${missedStocks.length}件`);
  console.log(
    `  ランク別: ${rankAccuracy.map((r) => `${r.rank}=${r.count}件`).join(", ")}`,
  );

  // Slack通知
  await notifyScoringAccuracyReport({
    periodLabel,
    totalRecords: weeklyRows.length,
    missedCount: missedStocks.length,
    categoryWeakness,
    rankAccuracy,
    rejectionCost,
    weeklyStats,
    monthlyStats,
  });

  console.log("=== Scoring Accuracy Report 終了 ===");
}

const isDirectRun = process.argv[1]?.includes("scoring-accuracy-report");
if (isDirectRun) {
  main()
    .catch((error) => {
      console.error("Scoring Accuracy Report エラー:", error);
      process.exit(1);
    })
    .finally(() => prisma.$disconnect());
}
