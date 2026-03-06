/**
 * Railway Worker - 常駐プロセス
 *
 * node-cron でジョブをスケジュール実行し、
 * Hono HTTP サーバーでダッシュボードを提供する。
 * Railway 上で `npm start` で起動。
 */

import cron from "node-cron";
import dayjs from "dayjs";
import timezone from "dayjs/plugin/timezone.js";
import utc from "dayjs/plugin/utc.js";
import { serve } from "@hono/node-server";

dayjs.extend(utc);
dayjs.extend(timezone);

import { main as runScan } from "./jobs/market-scanner";
import { main as runOrder } from "./jobs/order-manager";
import { main as runMonitor } from "./jobs/position-monitor";
import { main as runEod } from "./jobs/end-of-day";
import { main as runWeekly } from "./jobs/weekly-review";
import { app } from "./web/app";
import { setJobState } from "./web/routes/dashboard";
import { prisma } from "./lib/prisma";
import { notifySlack } from "./lib/slack";

// ジョブ状態（ダッシュボードから参照可能）
const jobState = {
  running: new Set<string>(),
  lastRun: new Map<
    string,
    { startedAt: Date; completedAt?: Date; error?: string }
  >(),
  startedAt: new Date(),
};

// ダッシュボードに状態を共有
setJobState(jobState);

async function runJob(name: string, job: () => Promise<void>) {
  if (jobState.running.has(name)) {
    console.log(
      `[${nowJST()}] ${name} スキップ（前回の実行がまだ完了していません）`,
    );
    return;
  }

  jobState.running.add(name);
  jobState.lastRun.set(name, { startedAt: new Date() });
  console.log(`[${nowJST()}] ${name} 開始`);

  try {
    await job();
    const entry = jobState.lastRun.get(name);
    if (entry) entry.completedAt = new Date();
    console.log(`[${nowJST()}] ${name} 完了`);
  } catch (err) {
    const entry = jobState.lastRun.get(name);
    if (entry) entry.error = String(err);
    console.error(`[${nowJST()}] ${name} エラー:`, err);

    const errorDetail =
      err instanceof Error
        ? `${err.message}\n\n\`\`\`\n${err.stack?.split("\n").slice(1, 6).join("\n") ?? ""}\n\`\`\``
        : String(err);

    await notifySlack({
      title: `❌ ${name} でエラーが発生しました`,
      message: errorDetail,
      color: "danger",
    }).catch(() => {});
  } finally {
    jobState.running.delete(name);
  }
}

function nowJST(): string {
  return dayjs().tz("Asia/Tokyo").format("YYYY-MM-DD HH:mm:ss");
}

// スケジュール定義（全て JST）
// ※ Yahoo Finance日本株データの約20分遅延を考慮し、各ジョブを+20分にオフセット
const schedules = [
  // 8:30 市場スキャン（平日）— 海外指標は遅延影響なしのため据置
  { cron: "30 8 * * 1-5", job: runScan, name: "market-scanner" },
  // 9:20 注文発行（平日）— 寄付き9:00のデータ反映後
  { cron: "20 9 * * 1-5", job: runOrder, name: "order-manager" },
  // 9:20-15:19 毎分 ポジション監視（平日）— 遅延考慮
  { cron: "20-59 9 * * 1-5", job: runMonitor, name: "position-monitor" },
  { cron: "* 10-14 * * 1-5", job: runMonitor, name: "position-monitor" },
  { cron: "0-19 15 * * 1-5", job: runMonitor, name: "position-monitor" },
  // 15:50 日次締め（平日）— 大引け15:30のデータ反映後
  { cron: "50 15 * * 1-5", job: runEod, name: "end-of-day" },
  // 土曜 10:00 週次レビュー
  { cron: "0 10 * * 6", job: runWeekly, name: "weekly-review" },
];

// cron 登録
for (const s of schedules) {
  cron.schedule(s.cron, () => runJob(s.name, s.job), {
    timezone: "Asia/Tokyo",
  });
  console.log(`  スケジュール登録: ${s.name} → ${s.cron} (JST)`);
}

// HTTP サーバー起動（ダッシュボード）
const port = parseInt(process.env.PORT || "3000", 10);
serve({ fetch: app.fetch, port }, (info) => {
  console.log(`  Dashboard: http://localhost:${info.port}`);
});

console.log(`\n=== Worker 起動完了 ===`);
console.log(`  JST時刻: [${nowJST()}]`);
console.log(`  System時刻 (UTC): [${new Date().toISOString()}]`);
console.log(`============================\n`);

// ========================================
// 起動時キャッチアップ
// デプロイや再起動で逃したジョブを検出・実行
// ========================================

async function catchUpMissedJobs() {
  const now = dayjs().tz("Asia/Tokyo");
  const day = now.day(); // 0=日, 6=土
  const isWeekday = day >= 1 && day <= 5;

  if (!isWeekday) {
    console.log("[catch-up] 平日ではないのでスキップ");
    return;
  }

  const todayStart = now.startOf("day").toDate();

  console.log("[catch-up] 逃したジョブを確認中...");

  // market-scanner: 8:30以降で、今日のMarketAssessmentがなければ実行
  if (now.hour() >= 9 || (now.hour() === 8 && now.minute() >= 30)) {
    const assessment = await prisma.marketAssessment.findFirst({
      where: { date: todayStart },
    });
    if (!assessment) {
      console.log("[catch-up] market-scanner が未実行 → 実行します");
      await runJob("market-scanner", runScan);
    }
  }

  // order-manager: 9:20以降で、今日のpending注文がなければ実行
  // (market-scannerのshouldTrade=falseの場合は注文なしが正常なのでassessmentも確認)
  if (now.hour() >= 10 || (now.hour() === 9 && now.minute() >= 20)) {
    const assessment = await prisma.marketAssessment.findFirst({
      where: { date: todayStart },
    });
    if (assessment?.shouldTrade) {
      const todayOrders = await prisma.tradingOrder.findFirst({
        where: { createdAt: { gte: todayStart } },
      });
      if (!todayOrders) {
        console.log("[catch-up] order-manager が未実行 → 実行します");
        await runJob("order-manager", runOrder);
      }
    }
  }

  // end-of-day: 15:50以降で、今日のDailySummaryがなければ実行
  if (now.hour() >= 16 || (now.hour() === 15 && now.minute() >= 50)) {
    const summary = await prisma.tradingDailySummary.findFirst({
      where: { date: todayStart },
    });
    if (!summary) {
      console.log("[catch-up] end-of-day が未実行 → 実行します");
      await runJob("end-of-day", runEod);
    }
  }

  console.log("[catch-up] 完了");
}

// 起動後5秒待ってからキャッチアップ（DB接続の安定を待つ）
setTimeout(() => {
  catchUpMissedJobs().catch((err) => {
    console.error("[catch-up] エラー:", err);
  });
}, 5000);
