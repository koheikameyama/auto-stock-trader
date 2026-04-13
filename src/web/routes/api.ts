/**
 * JSON API エンドポイント
 */

import { Hono } from "hono";
import { prisma } from "../../lib/prisma";
import { getOpenPositions, getCashBalance, getEffectiveCapital, computeRealizedPnl } from "../../core/position-manager";
import { getPendingOrders } from "../../core/order-executor";
import { jobState } from "./dashboard";
import { notifySlack } from "../../lib/slack";
import { cronControl } from "../../lib/cron-control";
import { fetchHistoricalData, fetchStockQuote, fetchStockQuotesBatch } from "../../core/market-data";
import { analyzeTechnicals } from "../../core/technical-analysis";
import { generatePatternsResponse } from "../../lib/candlestick-patterns";
import { stockModal } from "../views/stock-modal";
import type { ModalAnalysis, ModalPositionInfo, ModalQuoteInfo } from "../views/stock-modal";
import { yfFetchIndexChart } from "../../lib/yfinance-client";
import { nikkeiChartBody } from "../views/components";
import { NIKKEI_CHART_PERIODS, TIMEZONE } from "../../lib/constants";
import { BREAKOUT } from "../../lib/constants/breakout";
import { GAPUP } from "../../lib/constants/gapup";
import { getWatchlist } from "../../jobs/watchlist-builder";
import { calculateVolumeSurgeRatio } from "../../core/breakout/volume-surge";
import { getTodayForDB } from "../../lib/market-date";
import { getTachibanaClient } from "../../core/broker-client";
import dayjs from "dayjs";
import utcPlugin from "dayjs/plugin/utc.js";
import timezonePlugin from "dayjs/plugin/timezone.js";

dayjs.extend(utcPlugin);
dayjs.extend(timezonePlugin);

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
  const [effectiveCap, realizedPnl] = config
    ? [await getEffectiveCapital(config), await computeRealizedPnl()]
    : [0, 0];
  const cash = cashBalance ?? effectiveCap;
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
      realizedPnl,
      effectiveCapital: effectiveCap,
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
app.post("/trading/toggle", async (c) => {
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

  // cron タスク自体を停止/再開（スケジュール発火を根本から止める）
  if (body.active) {
    cronControl.start();
  } else {
    cronControl.stop();
  }

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
 * POST /api/config/budget - 予算（入金額）を更新
 */
app.post("/config/budget", async (c) => {
  const body = await c.req.json<{ totalBudget: number }>();

  if (typeof body.totalBudget !== "number" || body.totalBudget <= 0 || !Number.isInteger(body.totalBudget)) {
    return c.json({ error: "totalBudget must be a positive integer" }, 400);
  }

  const config = await prisma.tradingConfig.findFirst({
    orderBy: { createdAt: "desc" },
  });

  if (!config) {
    return c.json({ error: "TradingConfig not found" }, 404);
  }

  await prisma.tradingConfig.update({
    where: { id: config.id },
    data: { totalBudget: body.totalBudget },
  });

  console.log(`[${new Date().toISOString()}] Budget updated to ¥${body.totalBudget.toLocaleString()} via API`);

  return c.json({ success: true, totalBudget: body.totalBudget });
});

/**
 * POST /api/broker/clear-login-lock - ブローカーログインロック解除
 */
app.post("/broker/clear-login-lock", async (c) => {
  const client = getTachibanaClient();
  client.clearLoginLock();

  await notifySlack({
    title: "🔓 ブローカーログインロック解除",
    message: "ダッシュボードから手動でログインロックを解除しました",
    color: "good",
  }).catch(() => {});

  return c.json({ success: true });
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

  const ohlcv = await fetchHistoricalData(tickerCode);

  // チャートデータがなければ空を返す
  if (!ohlcv || ohlcv.length === 0) {
    return c.json({
      ohlcv: [],
      technical: null,
      patterns: null,
    });
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

  // 分析データ・ポジション・リアルタイム価格を並列取得
  let analysis: ModalAnalysis | null = null;
  let positionInfo: ModalPositionInfo | null = null;
  let quoteInfo: ModalQuoteInfo | null = null;
  try {
    const [ohlcv, openPosition, quote] = await Promise.all([
      fetchHistoricalData(tickerCode),
      prisma.tradingPosition.findFirst({
        where: { stockId: stock.id, status: "open" },
      }),
      fetchStockQuote(tickerCode, { yfinanceFallback: true }),
    ]);

    if (quote) {
      quoteInfo = {
        price: quote.price,
        change: quote.change,
        changePercent: quote.changePercent,
      };
    }

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
      analysis = { ohlcv: oldestFirst, technical, patterns };
    }

    if (openPosition) {
      const entryPrice = Number(openPosition.entryPrice);
      const currentPrice = quote?.price ?? null;
      positionInfo = {
        entryPrice,
        quantity: openPosition.quantity,
        strategy: openPosition.strategy,
        currentPrice,
        unrealizedPnl: currentPrice != null ? (currentPrice - entryPrice) * openPosition.quantity : null,
        pnlRate: currentPrice != null ? ((currentPrice - entryPrice) / entryPrice) * 100 : null,
        takeProfitPrice: openPosition.takeProfitPrice != null ? Number(openPosition.takeProfitPrice) : null,
        stopLossPrice: openPosition.stopLossPrice != null ? Number(openPosition.stopLossPrice) : null,
      };
    }
  } catch {
    // 分析データ取得失敗 → analysis = null のままモーダル表示
  }

  return c.html(stockModal(stock, analysis, positionInfo, quoteInfo));
});

/**
 * GET /api/quotes?tickers=7203,8306 - リアルタイム株価を非同期取得
 */
app.get("/quotes", async (c) => {
  const tickersParam = c.req.query("tickers");
  if (!tickersParam) return c.json({});

  const tickers = tickersParam.split(",").filter(Boolean);
  if (tickers.length === 0) return c.json({});

  const quotes = await fetchStockQuotesBatch(tickers, { yfinanceFallback: true });
  const result: Record<string, { price: number }> = {};
  for (const [key, value] of quotes) {
    result[key] = { price: value.price };
  }
  return c.json(result);
});

/**
 * GET /api/watchlist/state?tickers=7203,8306 - ウォッチリスト状態（ポーリング用）
 *
 * breakout-monitor 依存を排除し、ライブ時価から直接サージ比率を計算。
 * GU/BO/WB 戦略ごとの条件チェック結果を返す。
 */
app.get("/watchlist/state", async (c) => {
  const tickersParam = c.req.query("tickers");
  if (!tickersParam) return c.json({});

  const tickers = tickersParam.split(",").filter(Boolean);
  if (!tickers.length) return c.json({});

  // ウォッチリスト・保有・注文・市場評価・時価を並列取得
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const [watchlist, holdings, todayOrders, todayAssessment, quotes] = await Promise.all([
    getWatchlist(),
    prisma.tradingPosition.findMany({
      where: { status: "open" },
      select: { stock: { select: { tickerCode: true } } },
    }),
    prisma.tradingOrder.findMany({
      where: { side: "buy", createdAt: { gte: todayStart } },
      select: { stock: { select: { tickerCode: true } }, strategy: true },
    }),
    prisma.marketAssessment.findUnique({
      where: { date: getTodayForDB() },
      select: { shouldTrade: true },
    }),
    fetchStockQuotesBatch(tickers, { yfinanceFallback: true }),
  ]);

  const holdingTickers = new Set(holdings.map((h) => h.stock.tickerCode));
  const orderedMap = new Map<string, string>(); // ticker → strategy
  for (const o of todayOrders) {
    orderedMap.set(o.stock.tickerCode, o.strategy ?? "");
  }

  // ウォッチリストを Map 化
  const wlMap = new Map(watchlist.map((w) => [w.ticker, w]));

  // 現在時刻（サージ比率の時間帯加重用）
  const now = dayjs().tz(TIMEZONE);
  const hour = now.hour();
  const minute = now.minute();
  const isFriday = now.day() === 5;

  // ステータス判定
  type WatchlistStatus = "ordered" | "holding" | "watching";
  function getStatus(ticker: string): { status: WatchlistStatus; orderStrategy?: string } {
    if (holdingTickers.has(ticker)) return { status: "holding" };
    if (orderedMap.has(ticker)) return { status: "ordered", orderStrategy: orderedMap.get(ticker) };
    return { status: "watching" };
  }

  // 戦略条件チェック
  function checkStrategies(ticker: string, quote: { price: number; open: number; volume: number } | null): string[] {
    if (!quote) return [];
    const wl = wlMap.get(ticker);
    if (!wl) return [];

    const surgeRatio = calculateVolumeSurgeRatio(quote.volume, wl.avgVolume25, hour, minute);
    const strategies: string[] = [];

    // GU: open > prevClose × 1.03 + 陽線 + サージ ≥ 1.5x
    if (
      wl.latestClose > 0 &&
      quote.open > wl.latestClose * (1 + GAPUP.ENTRY.GAP_MIN_PCT) &&
      quote.price >= quote.open &&
      surgeRatio >= GAPUP.ENTRY.VOL_SURGE_RATIO
    ) {
      strategies.push("GU");
    }

    // BO: price > high20 + サージ ≥ 2.0x
    if (quote.price > wl.high20 && surgeRatio >= BREAKOUT.ENTRY.TRIGGER_THRESHOLD) {
      strategies.push("BO");
    }

    // WB: price > weeklyHigh13（金曜のみ）
    if (isFriday && wl.weeklyHigh13 != null && quote.price > wl.weeklyHigh13) {
      strategies.push("WB");
    }

    return strategies;
  }

  // GU条件詳細を計算
  type GapupConditions = {
    gapPct: number;        // ギャップ率 (%)
    isGapOk: boolean;      // gap >= 3%
    isCandleOk: boolean;   // 陽線（price >= open）
    isVolumeOk: boolean;   // 出来高サージ >= 1.5x
    prevClose: number;
    open: number;
  };

  function calcGapupConditions(ticker: string, quote: { price: number; open: number; volume: number } | null): GapupConditions | null {
    if (!quote) return null;
    const wl = wlMap.get(ticker);
    if (!wl || wl.latestClose <= 0) return null;

    const surgeRatio = calculateVolumeSurgeRatio(quote.volume, wl.avgVolume25, hour, minute);
    const gapPct = ((quote.open - wl.latestClose) / wl.latestClose) * 100;

    return {
      gapPct,
      isGapOk: quote.open > wl.latestClose * (1 + GAPUP.ENTRY.GAP_MIN_PCT),
      isCandleOk: quote.price >= quote.open,
      isVolumeOk: surgeRatio >= GAPUP.ENTRY.VOL_SURGE_RATIO,
      prevClose: wl.latestClose,
      open: quote.open,
    };
  }

  // ティッカーごとのデータ
  const tickerData: Record<string, {
    status: WatchlistStatus;
    orderStrategy?: string;
    strategies: string[];
    surgeRatio: number | null;
    price: number | null;
    open: number | null;
    gapup: GapupConditions | null;
  }> = {};

  for (const ticker of tickers) {
    const { status, orderStrategy } = getStatus(ticker);
    const quote = quotes.get(ticker);
    const wl = wlMap.get(ticker);

    const surgeRatio = quote && wl
      ? calculateVolumeSurgeRatio(quote.volume, wl.avgVolume25, hour, minute)
      : null;

    const quoteData = quote ? { price: quote.price, open: quote.open, volume: quote.volume } : null;

    tickerData[ticker] = {
      status,
      ...(orderStrategy && { orderStrategy }),
      strategies: checkStrategies(ticker, quoteData),
      surgeRatio,
      price: quote?.price ?? null,
      open: quote?.open ?? null,
      gapup: calcGapupConditions(ticker, quoteData),
    };
  }

  // 時間帯チェック
  const [eh, em] = BREAKOUT.GUARD.EARLIEST_ENTRY_TIME.split(":").map(Number);
  const [lh, lm] = BREAKOUT.GUARD.LATEST_ENTRY_TIME.split(":").map(Number);
  const current = hour * 60 + minute;
  const inTimeWindow = current >= eh * 60 + em && current <= lh * 60 + lm;

  return c.json({
    tickers: tickerData,
    global: {
      inTimeWindow,
      shouldTrade: todayAssessment?.shouldTrade ?? false,
      isFriday,
    },
  });
});

/**
 * GET /api/health - ヘルスチェック（認証不要）
 */
app.get("/health", (c) => {
  return c.json({ status: "ok", timestamp: new Date().toISOString() });
});

/**
 * GET /api/nikkei/chart-html - 日経225チャートHTMLフラグメント
 */
app.get("/nikkei/chart-html", async (c) => {
  const period = c.req.query("period") || "1d";
  const config = NIKKEI_CHART_PERIODS[period];
  if (!config) return c.text("Invalid period", 400);

  try {
    const data = await yfFetchIndexChart("^N225", period, config.interval);
    return c.html(nikkeiChartBody(data, period));
  } catch (e) {
    console.error("[nikkei/chart-html] Error:", e);
    return c.html(`<div class="empty">データ取得失敗</div>`);
  }
});

export default app;
