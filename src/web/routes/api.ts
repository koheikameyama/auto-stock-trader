/**
 * JSON API エンドポイント
 */

import { Hono } from "hono";
import { prisma } from "../../lib/prisma";
import { getOpenPositions, getCashBalance } from "../../core/position-manager";
import { getPendingOrders } from "../../core/order-executor";
import { jobState } from "./dashboard";
import { authMiddleware } from "../middleware/auth";
import { notifySlack } from "../../lib/slack";
import { fetchHistoricalData } from "../../core/market-data";
import { analyzeTechnicals } from "../../core/technical-analysis";
import { generatePatternsResponse } from "../../lib/candlestick-patterns";
import { stockModal } from "../views/stock-modal";
import type { ModalAnalysis } from "../views/stock-modal";

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
 * POST /api/trading/toggle - 取引の有効/無効を切り替え（緊急停止/再開）
 */
app.post("/trading/toggle", authMiddleware, async (c) => {
  const body = await c.req.json<{ active: boolean }>();

  if (typeof body.active !== "boolean") {
    return c.json({ error: "active must be a boolean" }, 400);
  }

  const config = await prisma.tradingConfig.findFirst({
    orderBy: { createdAt: "desc" },
  });

  if (!config) {
    return c.json({ error: "TradingConfig not found" }, 404);
  }

  await prisma.tradingConfig.update({
    where: { id: config.id },
    data: { isActive: body.active },
  });

  const action = body.active ? "再開" : "緊急停止";
  console.log(`[${new Date().toISOString()}] Trading ${body.active ? "ENABLED" : "DISABLED"} via API`);

  await notifySlack({
    title: body.active ? "🟢 システムを再開しました" : "🔴 システムを緊急停止しました",
    message: `ダッシュボードから手動で${action}されました`,
    color: body.active ? "good" : "danger",
  }).catch(() => {});

  return c.json({ success: true, isActive: body.active });
});

/**
 * GET /api/stock/:tickerCode - 銘柄詳細データ
 */
app.get("/stock/:tickerCode", async (c) => {
  const stock = await prisma.stock.findUnique({
    where: { tickerCode: c.req.param("tickerCode") },
  });
  if (!stock) return c.json({ error: "not found" }, 404);
  // BigInt (latestVolume) は JSON.stringify できないため変換
  return c.json({
    ...stock,
    latestVolume: stock.latestVolume != null ? String(stock.latestVolume) : null,
  });
});

/**
 * GET /api/stock/:tickerCode/analysis - テクニカル分析データ（チャート・パターン・シグナル）
 */
app.get("/stock/:tickerCode/analysis", async (c) => {
  const tickerCode = c.req.param("tickerCode");

  // 並列: ヒストリカルデータ取得 + 最新スコアリング取得
  const [ohlcv, scoring] = await Promise.all([
    fetchHistoricalData(tickerCode),
    prisma.scoringRecord.findFirst({
      where: { tickerCode },
      orderBy: { date: "desc" },
      select: {
        date: true,
        totalScore: true,
        rank: true,
        technicalScore: true,
        patternScore: true,
        liquidityScore: true,
        fundamentalScore: true,
        isDisqualified: true,
        disqualifyReason: true,
        aiDecision: true,
      },
    }),
  ]);

  if (!ohlcv || ohlcv.length === 0) {
    return c.json({ error: "historical data not available" }, 404);
  }

  // テクニカル分析
  const technical = analyzeTechnicals(ohlcv);

  // パターン検出（oldest-first に変換）
  const oldestFirst = [...ohlcv].reverse();
  const chartData = oldestFirst.map((bar, i) => ({
    date: bar.date,
    open: bar.open,
    high: bar.high,
    low: bar.low,
    close: bar.close,
    // 最終バーにのみテクニカル指標を付与（combinedSignal計算用）
    rsi: i === oldestFirst.length - 1 ? technical.rsi : null,
    histogram: i === oldestFirst.length - 1 ? technical.macd.histogram : null,
  }));
  const patterns = generatePatternsResponse(chartData);

  return c.json({
    ohlcv: oldestFirst,
    technical,
    patterns,
    scoring,
  });
});

/**
 * GET /api/stock/:tickerCode/modal - 銘柄詳細モーダル HTML フラグメント
 */
app.get("/stock/:tickerCode/modal", async (c) => {
  const tickerCode = c.req.param("tickerCode");

  const stock = await prisma.stock.findUnique({
    where: { tickerCode },
  });
  if (!stock) return c.text("not found", 404);

  // 分析データを並列取得（失敗してもモーダルは表示する）
  let analysis: ModalAnalysis | null = null;
  try {
    const [ohlcv, scoring] = await Promise.all([
      fetchHistoricalData(tickerCode),
      prisma.scoringRecord.findFirst({
        where: { tickerCode },
        orderBy: { date: "desc" },
        select: {
          date: true,
          totalScore: true,
          rank: true,
          technicalScore: true,
          patternScore: true,
          liquidityScore: true,
          fundamentalScore: true,
          isDisqualified: true,
          disqualifyReason: true,
          aiDecision: true,
        },
      }),
    ]);

    if (ohlcv && ohlcv.length > 0) {
      const technical = analyzeTechnicals(ohlcv);
      const oldestFirst = [...ohlcv].reverse();
      const chartData = oldestFirst.map((bar, i) => ({
        date: bar.date,
        open: bar.open,
        high: bar.high,
        low: bar.low,
        close: bar.close,
        rsi: i === oldestFirst.length - 1 ? technical.rsi : null,
        histogram:
          i === oldestFirst.length - 1 ? technical.macd.histogram : null,
      }));
      const patterns = generatePatternsResponse(chartData);
      analysis = { ohlcv: oldestFirst, technical, patterns, scoring };
    }
  } catch {
    // 分析データ取得失敗 → analysis = null のままモーダル表示
  }

  return c.html(stockModal(stock, analysis));
});

/**
 * GET /api/health - ヘルスチェック（認証不要）
 */
app.get("/health", (c) => {
  return c.json({ status: "ok", timestamp: new Date().toISOString() });
});

export default app;
