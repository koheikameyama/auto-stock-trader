/**
 * JSON API エンドポイント
 */

import { Hono } from "hono";
import { prisma } from "../../lib/prisma";
import { getOpenPositions, getCashBalance } from "../../core/position-manager";
import { getPendingOrders } from "../../core/order-executor";
import { jobState } from "./dashboard";

const app = new Hono();

/**
 * GET /api/status - ダッシュボード JSON（自動更新用）
 */
app.get("/status", async (c) => {
  const [config, openPositions, pendingOrders, cashBalance] = await Promise.all(
    [
      prisma.tradingConfig.findFirst({ orderBy: { createdAt: "desc" } }),
      getOpenPositions(),
      getPendingOrders(),
      getCashBalance().catch(() => null),
    ],
  );

  const totalBudget = config ? Number(config.totalBudget) : 0;
  const cash = cashBalance ?? totalBudget;
  const investedValue = openPositions.reduce(
    (sum, p) => sum + Number(p.entryPrice) * p.quantity,
    0,
  );

  return c.json({
    uptime: Date.now() - jobState.startedAt.getTime(),
    isActive: config?.isActive ?? false,
    runningJobs: [...jobState.running],
    portfolio: {
      totalBudget,
      cash,
      investedValue,
      totalValue: cash + investedValue,
      pnl: cash + investedValue - totalBudget,
    },
    openPositions: openPositions.length,
    pendingOrders: pendingOrders.length,
  });
});

/**
 * GET /api/health - ヘルスチェック（認証不要）
 */
app.get("/health", (c) => {
  return c.json({ status: "ok", timestamp: new Date().toISOString() });
});

export default app;
