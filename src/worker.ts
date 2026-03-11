/**
 * Railway Worker - 常駐プロセス
 *
 * position-monitor のみ node-cron でスケジュール実行し、
 * Hono HTTP サーバーでダッシュボードを提供する。
 * バッチジョブは /api/cron/* エンドポイント経由で cron-job.org からトリガー。
 * Railway 上で `npm start` で起動。
 */

import cron from "node-cron";
import dayjs from "dayjs";
import timezone from "dayjs/plugin/timezone.js";
import utc from "dayjs/plugin/utc.js";
import { serve } from "@hono/node-server";

dayjs.extend(utc);
dayjs.extend(timezone);

import { main as runMonitor } from "./jobs/position-monitor";
import { app } from "./web/app";
import { setJobState } from "./web/routes/dashboard";
import { prisma } from "./lib/prisma";
import { notifySlack } from "./lib/slack";
import { isMarketDay } from "./lib/market-calendar";

// ジョブ状態（ダッシュボード・cronルートから参照可能）
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

// 休場日スキップのログ重複防止（position-monitorの毎分実行対策）
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
// ※ position-monitor のみ Worker cron で実行
// ※ バッチジョブ（order-manager, midday-reassessment, end-of-day,
//   daily-backtest, jpx-delisting-sync）は cron-job.org → /api/cron/* に移行
// ※ news-collector, market-scanner, ghost-review, weekly-review は
//   GitHub Actions cron に移行済み（KOH-296）
// TODO: isActive制御が安定したらスケジュールを復元する
// const schedules = [
//   // 9:20-15:19 毎分 ポジション監視（平日）— Yahoo Finance遅延考慮
//   { cron: "20-59 9 * * 1-5", job: runMonitor, name: "position-monitor", requiresMarketDay: true },
//   { cron: "* 10-14 * * 1-5", job: runMonitor, name: "position-monitor", requiresMarketDay: true },
//   { cron: "0-19 15 * * 1-5", job: runMonitor, name: "position-monitor", requiresMarketDay: true },
// ];
//
// // cron 登録
// for (const s of schedules) {
//   cron.schedule(
//     s.cron,
//     () => runJob(s.name, s.job, s.requiresMarketDay),
//     { timezone: "Asia/Tokyo" },
//   );
//   console.log(`  スケジュール登録: ${s.name} → ${s.cron} (JST)`);
// }
console.log("  ⚠️ position-monitor スケジュール: 無効化中");

// 日次リセット: 休場日スキップログをクリア
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
