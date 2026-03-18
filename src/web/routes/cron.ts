/**
 * Cron API ルート（POST /api/cron/:jobName）
 *
 * cron-job.org または GitHub Actions から呼び出されるバッチジョブエンドポイント。
 * Bearer CRON_SECRET で認証。
 */

import { Hono } from "hono";
import dayjs from "dayjs";
import timezone from "dayjs/plugin/timezone.js";
import utc from "dayjs/plugin/utc.js";
import { cronAuthMiddleware } from "../middleware/cron-auth";
import { jobState } from "./dashboard";
import { isMarketDay } from "../../lib/market-calendar";
import { prisma } from "../../lib/prisma";


import { main as runOrder } from "../../jobs/order-manager";
import { main as runMiddayReassessment } from "../../jobs/midday-reassessment";
import { main as runEod } from "../../jobs/end-of-day";
import { main as runDailyBacktest } from "../../jobs/daily-backtest";
import { main as runDelistingSync } from "../../jobs/jpx-delisting-sync";
import { main as runMarketScanner } from "../../jobs/market-scanner";
import { main as runScoringAccuracy } from "../../jobs/scoring-accuracy";
import { main as runDefensiveExitFollowup } from "../../jobs/defensive-exit-followup";
import { main as runUnfilledOrderFollowup } from "../../jobs/unfilled-order-followup";
import { main as runDataCleanup } from "../../jobs/data-cleanup";
import { main as runHoldingScore } from "../../jobs/holding-score";

dayjs.extend(utc);
dayjs.extend(timezone);

const app = new Hono();

// 全エンドポイントに CRON_SECRET 認証を適用
app.use("*", cronAuthMiddleware);

interface JobDef {
  fn: () => Promise<void>;
  requiresMarketDay: boolean;
}

const JOBS: Record<string, JobDef> = {
  "order-manager": { fn: runOrder, requiresMarketDay: true },
  "midday-reassessment": { fn: runMiddayReassessment, requiresMarketDay: true },
  "end-of-day": { fn: runEod, requiresMarketDay: true },
  "daily-backtest": { fn: runDailyBacktest, requiresMarketDay: true },
  "market-scanner": { fn: runMarketScanner, requiresMarketDay: true },
  "scoring-accuracy": { fn: runScoringAccuracy, requiresMarketDay: true },
  "defensive-exit-followup": { fn: runDefensiveExitFollowup, requiresMarketDay: true },
  "unfilled-order-followup": { fn: runUnfilledOrderFollowup, requiresMarketDay: true },
  "holding-score": { fn: runHoldingScore, requiresMarketDay: true },
  "jpx-delisting-sync": { fn: runDelistingSync, requiresMarketDay: false },
  "data-cleanup": { fn: runDataCleanup, requiresMarketDay: false },
};

function nowJST(): string {
  return dayjs().tz("Asia/Tokyo").format("YYYY-MM-DD HH:mm:ss");
}

for (const [key, def] of Object.entries(JOBS)) {
  app.post(`/${key}`, async (c) => {
    const skipChecks = c.req.query("skip_checks") === "true";

    // 休場日チェック（skip_checksでスキップ可能）
    if (!skipChecks && def.requiresMarketDay && !isMarketDay()) {
      return c.json({ status: "skipped", jobName: key, reason: "non-market-day" });
    }

    // システム停止チェック（skip_checksでもバイパス不可）
    if (def.requiresMarketDay) {
      const config = await prisma.tradingConfig.findFirst({
        orderBy: { createdAt: "desc" },
      });
      if (config && !config.isActive) {
        return c.json({ status: "skipped", jobName: key, reason: "system-inactive" });
      }
    }

    // 同時実行防止
    if (jobState.running.has(key)) {
      return c.json({ status: "skipped", jobName: key, reason: "already-running" });
    }

    // ジョブ実行
    const startedAt = new Date();
    jobState.running.add(key);
    jobState.lastRun.set(key, { startedAt });
    console.log(`[${nowJST()}] ${key} 開始 (API)`);

    try {
      await def.fn();
      const completedAt = new Date();
      const entry = jobState.lastRun.get(key);
      if (entry) entry.completedAt = completedAt;
      console.log(`[${nowJST()}] ${key} 完了 (API)`);

      return c.json({
        status: "completed",
        jobName: key,
        startedAt: startedAt.toISOString(),
        completedAt: completedAt.toISOString(),
        durationMs: completedAt.getTime() - startedAt.getTime(),
      });
    } catch (err) {
      const entry = jobState.lastRun.get(key);
      if (entry) entry.error = String(err);
      console.error(`[${nowJST()}] ${key} エラー (API):`, err);

      return c.json(
        {
          status: "error",
          jobName: key,
          startedAt: startedAt.toISOString(),
          error: err instanceof Error ? err.message : String(err),
        },
        500,
      );
    } finally {
      jobState.running.delete(key);
    }
  });
}

export default app;
