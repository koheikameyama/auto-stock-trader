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
import { main as runWeeklyBreakMonitor } from "./jobs/weekly-break-monitor";
import { main as runGapupMonitor } from "./jobs/gapup-monitor";
import { main as runPSCMonitor } from "./jobs/post-surge-consolidation-monitor";
import { main as runBrokerReconciliation } from "./jobs/broker-reconciliation";
import { main as runIntradayMaScanner } from "./jobs/intraday-ma-scanner";
import { main as runSessionHealthCheck } from "./jobs/session-health-check";
import { app } from "./web/app";
import { setJobState } from "./web/routes/dashboard";
import { prisma } from "./lib/prisma";
import { notifySlack } from "./lib/slack";
import { isMarketDay } from "./lib/market-date";
import { TIMEZONE } from "./lib/constants";
import { cronControl } from "./lib/cron-control";
import { getTachibanaClient, resetTachibanaClient, type TachibanaSession } from "./core/broker-client";
import { getBrokerEventStream, resetBrokerEventStream, isBrokerConnectionWindow } from "./core/broker-event-stream";
import { handleBrokerFill } from "./core/broker-fill-handler";

// ジョブ状態（ダッシュボード・cronルートから参照可能）
const jobState = {
  running: new Set<string>(),
  lastRun: new Map<
    string,
    { startedAt: Date; completedAt?: Date; error?: string }
  >(),
  startedAt: new Date(),
};

// cron タスク参照（動的停止/再開用）
const cronTasks: cron.ScheduledTask[] = [];

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
  return dayjs().tz(TIMEZONE).format("YYYY-MM-DD HH:mm:ss");
}

// 市場時間の毎分tick: broker-reconciliation → position-monitor の順にシーケンシャル実行
async function runMarketTick() {
  await runJob("broker-reconciliation", runBrokerReconciliation, true);
  await runJob("position-monitor", runMonitor, true);
}

// 前場のみのtick: intraday-ma-scanner を実行
async function runAMTick() {
  await runJob("intraday-ma-scanner", runIntradayMaScanner, true);
}

// スケジュール定義（全て JST）
// ※ position-monitor のみ Worker cron で実行
// ※ バッチジョブ（end-of-day, jpx-delisting-sync）は cron-job.org → /api/cron/* に移行
// ※ news-collector, weekly-review は GitHub Actions cron に移行済み
const schedules = [
  // 9:00-11:30, 12:30-15:30 毎分 ポジション監視（平日・市場時間）
  // broker-reconciliation → position-monitor の順に実行
  { cron: "0-59 9 * * 1-5", job: runMarketTick, name: "market-tick", requiresMarketDay: false },
  { cron: "* 10 * * 1-5", job: runMarketTick, name: "market-tick", requiresMarketDay: false },
  { cron: "0-30 11 * * 1-5", job: runMarketTick, name: "market-tick", requiresMarketDay: false },
  // 前場のみ: intraday-ma-scanner（9:00-11:30）
  { cron: "0-59 9 * * 1-5", job: runAMTick, name: "intraday-ma-scanner", requiresMarketDay: true },
  { cron: "* 10 * * 1-5", job: runAMTick, name: "intraday-ma-scanner", requiresMarketDay: true },
  { cron: "0-30 11 * * 1-5", job: runAMTick, name: "intraday-ma-scanner", requiresMarketDay: true },
  { cron: "30-59 12 * * 1-5", job: runMarketTick, name: "market-tick", requiresMarketDay: false },
  { cron: "* 13-14 * * 1-5", job: runMarketTick, name: "market-tick", requiresMarketDay: false },
  { cron: "0-30 15 * * 1-5", job: runMarketTick, name: "market-tick", requiresMarketDay: false },
  // 15:20-15:29 ギャップアップ監視（内部で1日1回制限。API失敗時は次分リトライ）
  { cron: "20-29 15 * * 1-5", job: runGapupMonitor, name: "gapup-monitor", requiresMarketDay: true },
  // 15:20-15:29 週足ブレイク監視（内部で週末最終営業日のみ実行）
  { cron: "20-29 15 * * 1-5", job: runWeeklyBreakMonitor, name: "weekly-break-monitor", requiresMarketDay: true },
  // 15:20-15:29 高騰後押し目監視（ENTRY_ENABLED=false の間は内部でスキップ）
  { cron: "20-29 15 * * 1-5", job: runPSCMonitor, name: "psc-monitor", requiresMarketDay: true },
  // 8:50 プレマーケット セッション確認（電話番号認証の早期検出）
  { cron: "50 8 * * 1-5", job: runSessionHealthCheck, name: "session-health-check", requiresMarketDay: true },
  // 14:50 プレクローズ セッション確認（15:20のモニター前に最終確認）
  { cron: "50 14 * * 1-5", job: runSessionHealthCheck, name: "session-health-check", requiresMarketDay: true },
];

// cron 登録
for (const s of schedules) {
  const task = cron.schedule(
    s.cron,
    () => runJob(s.name, s.job, s.requiresMarketDay),
    { timezone: TIMEZONE },
  );
  cronTasks.push(task);
  console.log(`  スケジュール登録: ${s.name} → ${s.cron} (JST)`);
}

// cron 制御関数を登録（api.ts から cronControl.stop()/start() で呼べる）
cronControl.register(
  () => {
    for (const task of cronTasks) task.stop();
    console.log(`[${nowJST()}] cron タスク停止（${cronTasks.length}件）`);
  },
  () => {
    for (const task of cronTasks) task.start();
    holidaySkipLogged.delete("position-monitor:inactive");
    holidaySkipLogged.delete("broker-reconciliation:inactive");
    holidaySkipLogged.delete("intraday-ma-scanner:inactive");
    console.log(`[${nowJST()}] cron タスク再開（${cronTasks.length}件）`);
  },
);

// 起動時に isActive=false なら cron を停止した状態で開始
prisma.tradingConfig.findFirst({ orderBy: { createdAt: "desc" } }).then((config) => {
  if (config && !config.isActive) {
    cronControl.stop();
    console.log("  起動時 isActive=false → cron タスク停止状態で開始");
  }
}).catch(() => {});

// 日次リセット: 休場日スキップログをクリア
cron.schedule("0 0 * * *", () => {
  holidaySkipLogged.clear();
}, { timezone: TIMEZONE });

// HTTP サーバー起動（ダッシュボード）
const port = parseInt(process.env.PORT || "3000", 10);
serve({ fetch: app.fetch, port }, (info) => {
  console.log(`  Dashboard: http://localhost:${info.port}`);
});

// ブローカーセッション初期化（APIログインは行わない — 初回API呼び出し時に遅延ログイン）
(async () => {
  try {
    console.log("  ブローカーセッション初期化中...");
    const client = getTachibanaClient();

    // WebSocket + auto-refresh セットアップ（セッション確立後に実行）
    const setupBrokerConnection = (session: TachibanaSession) => {
      const stream = getBrokerEventStream();
      stream.on("execution", (event) => {
        handleBrokerFill(event).catch((err) => {
          console.error("[worker] broker-fill error:", err);
        });
      });
      stream.on("error", (err) => {
        console.error("[worker] EventStream error:", err);
      });
      if (!isBrokerConnectionWindow()) {
        console.log("  WebSocket: 営業時間外 — 次の営業時間に自動接続します");
      }
      stream.connect(session.urlEventWebSocket);

      client.startAutoRefresh((newSession) => {
        stream.reconnect(newSession.urlEventWebSocket);
      });

      console.log("  ブローカーセッション確立");
    };

    // DBからセッション復元を試みる（APIログインはしない）
    const session = await client.restoreFromDB();

    if (session) {
      setupBrokerConnection(session);
    } else {
      console.log("  セッションなし — 初回API呼び出し時にログインします");
      client.onSessionReady(setupBrokerConnection);
    }
  } catch (e) {
    console.error("  ブローカーセッション復元失敗:", e);
  }
})();

// シャットダウン
async function shutdown(signal: string) {
  console.log(`\n[${nowJST()}] ${signal} 受信、シャットダウン中...`);
  for (const task of cronTasks) task.stop();

  // WebSocket 切断
  resetBrokerEventStream();

  try {
    const client = getTachibanaClient();
    if (client.isLoggedIn()) {
      await client.logout();
    }
    resetTachibanaClient();
  } catch (e) {
    console.warn("  ブローカーログアウトエラー:", e);
  }

  await prisma.$disconnect();
  process.exit(0);
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

console.log(`\n=== Worker 起動完了 ===`);
console.log(`  JST時刻: [${nowJST()}]`);
console.log(`  System時刻 (UTC): [${new Date().toISOString()}]`);
console.log(`============================\n`);
