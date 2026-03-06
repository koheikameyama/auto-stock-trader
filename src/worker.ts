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
  } finally {
    jobState.running.delete(name);
  }
}

function nowJST(): string {
  return dayjs().tz("Asia/Tokyo").format("YYYY-MM-DD HH:mm:ss");
}

// スケジュール定義（全て JST）
const schedules = [
  // 8:30 市場スキャン（平日）
  { cron: "30 8 * * 1-5", job: runScan, name: "market-scanner" },
  // 9:00 注文発行（平日）
  { cron: "0 9 * * 1-5", job: runOrder, name: "order-manager" },
  // 9:00-15:00 毎分 ポジション監視（平日）
  { cron: "* 9-14 * * 1-5", job: runMonitor, name: "position-monitor" },
  // 15:30 日次締め（平日）
  { cron: "30 15 * * 1-5", job: runEod, name: "end-of-day" },
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

console.log(`\n=== Worker 起動完了 [${nowJST()}] ===\n`);
