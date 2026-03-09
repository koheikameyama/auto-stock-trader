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

import { main as runOrder } from "./jobs/order-manager";
import { main as runMonitor } from "./jobs/position-monitor";
import { main as runEod } from "./jobs/end-of-day";
import { main as runDailyBacktest } from "./jobs/daily-backtest";
import { main as runDelistingSync } from "./jobs/jpx-delisting-sync";
import { main as runMiddayReassessment } from "./jobs/midday-reassessment";
import { app } from "./web/app";
import { setJobState } from "./web/routes/dashboard";
import { prisma } from "./lib/prisma";
import { notifySlack } from "./lib/slack";
import { isMarketDay } from "./lib/market-calendar";

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

// 休場日スキップのログ重複防止（position-monitor等の毎分実行対策）
const holidaySkipLogged = new Set<string>();

async function runJob(
  name: string,
  job: () => Promise<void>,
  requiresMarketDay = false,
) {
  // 休場日チェック
  if (requiresMarketDay && !isMarketDay()) {
    if (!holidaySkipLogged.has(name)) {
      console.log(`[${nowJST()}] ${name} スキップ（休場日）`);
      holidaySkipLogged.add(name);
    }
    return;
  }

  // システム停止チェック
  if (requiresMarketDay) {
    const config = await prisma.tradingConfig.findFirst({
      orderBy: { createdAt: "desc" },
    });
    if (config && !config.isActive) {
      if (!holidaySkipLogged.has(`${name}:inactive`)) {
        console.log(`[${nowJST()}] ${name} スキップ（システム停止中）`);
        holidaySkipLogged.add(`${name}:inactive`);
      }
      return;
    }
  }

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
// ※ news-collector, market-scanner, ghost-review, weekly-review は
//   GitHub Actions cron に移行済み（KOH-296）
const schedules = [
  // 9:20 注文発行（平日）— 寄付き9:00のデータ反映後
  { cron: "20 9 * * 1-5", job: runOrder, name: "order-manager", requiresMarketDay: true },
  // 12:15 昼休み再評価（平日）— 前場終了11:30のデータ反映後
  { cron: "15 12 * * 1-5", job: runMiddayReassessment, name: "midday-reassessment", requiresMarketDay: true },
  // 9:20-15:19 毎分 ポジション監視（平日）— 遅延考慮
  { cron: "20-59 9 * * 1-5", job: runMonitor, name: "position-monitor", requiresMarketDay: true },
  { cron: "* 10-14 * * 1-5", job: runMonitor, name: "position-monitor", requiresMarketDay: true },
  { cron: "0-19 15 * * 1-5", job: runMonitor, name: "position-monitor", requiresMarketDay: true },
  // 15:50 日次締め（平日）— 大引け15:30のデータ反映後
  { cron: "50 15 * * 1-5", job: runEod, name: "end-of-day", requiresMarketDay: true },
  // 16:30 日次バックテスト（平日）— 終値確定後、資金帯別パフォーマンス追跡
  { cron: "30 16 * * 1-5", job: runDailyBacktest, name: "daily-backtest", requiresMarketDay: true },
  // 土曜 9:00 JPX廃止予定同期（市場営業日に依存しない）
  { cron: "0 9 * * 6", job: runDelistingSync, name: "jpx-delisting-sync", requiresMarketDay: false },
];

// cron 登録
for (const s of schedules) {
  cron.schedule(
    s.cron,
    () => runJob(s.name, s.job, s.requiresMarketDay),
    { timezone: "Asia/Tokyo" },
  );
  console.log(`  スケジュール登録: ${s.name} → ${s.cron} (JST)`);
}

// 日次リセット: 休場日スキップログとシステム停止ログをクリア
cron.schedule("0 0 * * *", () => {
  holidaySkipLogged.clear();
}, { timezone: "Asia/Tokyo" });

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

  if (!isMarketDay()) {
    console.log("[catch-up] 休場日のためスキップ");
    return;
  }

  const todayStart = now.startOf("day").toDate();

  console.log("[catch-up] 逃したジョブを確認中...");

  // ※ news-collector, market-scanner は GitHub Actions に移行済み（KOH-296）

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

  // midday-reassessment: 12:15以降かつ15:00前で、未実行なら実行
  if (
    (now.hour() >= 13 || (now.hour() === 12 && now.minute() >= 15)) &&
    now.hour() < 15
  ) {
    const assessmentForMidday = await prisma.marketAssessment.findFirst({
      where: { date: todayStart },
      select: { middayReassessedAt: true },
    });
    if (assessmentForMidday && !assessmentForMidday.middayReassessedAt) {
      console.log("[catch-up] midday-reassessment が未実行 → 実行します");
      await runJob("midday-reassessment", runMiddayReassessment);
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

  // ※ ghost-review は GitHub Actions に移行済み（KOH-296）

  // daily-backtest: 16:30以降で、今日のBacktestDailyResultがなければ実行
  if (now.hour() >= 17 || (now.hour() === 16 && now.minute() >= 30)) {
    const hasBacktest = await prisma.backtestDailyResult.findFirst({
      where: { date: todayStart },
    });
    if (!hasBacktest) {
      console.log("[catch-up] daily-backtest が未実行 → 実行します");
      await runJob("daily-backtest", runDailyBacktest);
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
