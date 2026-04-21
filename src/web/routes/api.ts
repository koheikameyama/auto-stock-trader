/**
 * JSON API エンドポイント
 */

import { Hono } from "hono";
import { Prisma } from "@prisma/client";
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
import { GAPUP } from "../../lib/constants/gapup";
import { POST_SURGE_CONSOLIDATION } from "../../lib/constants/post-surge-consolidation";
import { getAllWatchlist } from "../../jobs/watchlist-builder";
import { calculateVolumeSurgeRatio } from "../../core/breakout/volume-surge";
import { getTodayForDB, getDaysAgoForDB, isMarketOpen } from "../../lib/market-date";
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
 * トレーディング再開処理（armLogin + login を同期実行）
 * POST /trading/toggle と GET /trading/resume の共通ロジック。
 * @returns 成功時は null、失敗時はエラーメッセージ
 */
async function resumeTrading(source: string): Promise<string | null> {
  const config = await prisma.tradingConfig.findFirst({
    orderBy: { createdAt: "desc" },
  });
  if (!config) return "TradingConfig not found";

  const client = getTachibanaClient();
  await prisma.tradingConfig.update({
    where: { id: config.id },
    data: { isActive: true, loginLockedUntil: null, loginLockReason: null },
  });
  await client.clearLoginLock().catch(() => {});

  try {
    await client.armLogin();
    await client.login();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await prisma.tradingConfig.update({
      where: { id: config.id },
      data: { isActive: false, loginLockReason: `再開失敗: ${msg}` },
    });
    console.error(`[${new Date().toISOString()}] Resume login failed (${source}): ${msg}`);
    await notifySlack({
      title: "❌ システム再開に失敗しました",
      message: `ログイン試行でエラー (${source}):\n${msg}`,
      color: "danger",
    }).catch(() => {});
    return msg;
  }

  cronControl.start();
  console.log(`[${new Date().toISOString()}] Trading ENABLED via ${source} (login confirmed)`);
  await notifySlack({
    title: "🟢 システムを再開しました",
    message: `${source}から再開され、立花証券へのログインに成功しました`,
    color: "good",
  }).catch(() => {});
  return null;
}

/**
 * POST /api/trading/toggle - 取引の有効/無効を切り替え（緊急停止/再開）
 * 再開時は armLogin + login を同期実行し、電話番号認証後のログイン確定まで一括で行う。
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

  if (!body.active) {
    await prisma.tradingConfig.update({
      where: { id: config.id },
      data: { isActive: false, loginLockReason: "手動停止", loginLockedUntil: null },
    });
    cronControl.stop();
    console.log(`[${new Date().toISOString()}] Trading DISABLED via API`);
    await notifySlack({
      title: "🔴 システムを緊急停止しました",
      message: "ダッシュボードから手動で緊急停止されました",
      color: "danger",
    }).catch(() => {});
    return c.json({ success: true, isActive: false });
  }

  const err = await resumeTrading("ダッシュボード");
  if (err) return c.json({ error: err }, 500);
  return c.json({ success: true, isActive: true });
});

/**
 * GET /api/trading/resume - システム再開（Slackリンク等のブラウザアクセス用）
 * POST /trading/toggle (active=true) と同じ再開処理を行い、HTML ページを返す。
 */
app.get("/trading/resume", async (c) => {
  const err = await resumeTrading("Slackリンク");
  const escape = (s: string) =>
    s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const success = err === null;
  const title = success ? "✅ システムを再開しました" : "❌ システム再開に失敗しました";
  const color = success ? "#22c55e" : "#ef4444";
  const bodyMsg = success
    ? "立花証券へのログインに成功し、自動売買を再開しました。"
    : `エラー: ${escape(err ?? "不明")}`;

  return c.html(
    `<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>システム再開</title><style>body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:#0f172a;color:#e2e8f0;margin:0;padding:24px;display:flex;justify-content:center;align-items:center;min-height:100vh}.card{background:#1e293b;border:1px solid #334155;border-radius:12px;padding:32px;max-width:480px;width:100%}.title{font-size:20px;font-weight:700;color:${color};margin-bottom:16px}.msg{font-size:14px;line-height:1.6;color:#cbd5e1;margin-bottom:24px;white-space:pre-wrap}.link{display:inline-block;background:#3b82f6;color:#fff;padding:10px 20px;border-radius:8px;text-decoration:none;font-weight:600}.link:hover{background:#2563eb}</style></head><body><div class="card"><div class="title">${title}</div><div class="msg">${bodyMsg}</div><a class="link" href="/">ダッシュボードへ</a></div></body></html>`,
    success ? 200 : 500,
  );
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

  const marketOpen = isMarketOpen();
  const quotes = await fetchStockQuotesBatch(tickers, { yfinanceFallback: !marketOpen });
  const result: Record<string, { price: number }> = {};
  for (const [key, value] of quotes) {
    result[key] = { price: value.price };
  }
  if (marketOpen && quotes.size < tickers.length) {
    return c.json({ ...result, _error: "broker_api_failed" });
  }
  return c.json(result);
});

/** PSCシグナル判定に必要な履歴データ */
type PSCHistoricalData = {
  close20DaysAgo: number;
  high20: number;
};

/** PSC用履歴データをバッチ取得 */
async function fetchPSCHistoricalData(tickers: string[]): Promise<Map<string, PSCHistoricalData>> {
  const LOOKBACK_DAYS = 25;
  const cutoff = dayjs().tz(TIMEZONE).subtract(50, "day").toDate();

  const bars = await prisma.stockDailyBar.findMany({
    where: { tickerCode: { in: tickers }, date: { gte: cutoff } },
    select: { tickerCode: true, close: true },
    orderBy: [{ tickerCode: "asc" }, { date: "asc" }],
  });

  const tickerBars = new Map<string, Array<{ close: number }>>();
  for (const bar of bars) {
    let arr = tickerBars.get(bar.tickerCode);
    if (!arr) {
      arr = [];
      tickerBars.set(bar.tickerCode, arr);
    }
    arr.push({ close: bar.close });
  }

  const result = new Map<string, PSCHistoricalData>();
  for (const [ticker, barList] of tickerBars) {
    if (barList.length < LOOKBACK_DAYS) continue;

    const recent = barList.slice(-LOOKBACK_DAYS);
    const close20DaysAgo = recent[recent.length - 20].close;
    const high20 = Math.max(...recent.slice(-20).map((b) => b.close));

    result.set(ticker, { close20DaysAgo, high20 });
  }

  return result;
}

/**
 * GET /api/watchlist/state?tickers=7203,8306 - ウォッチリスト状態（ポーリング用）
 *
 * breakout-monitor 依存を排除し、ライブ時価から直接サージ比率を計算。
 * GU/PSC 戦略ごとの条件チェック結果を返す。
 */
app.get("/watchlist/state", async (c) => {
  const tickersParam = c.req.query("tickers");
  if (!tickersParam) return c.json({});

  const tickers = tickersParam.split(",").filter(Boolean);
  if (!tickers.length) return c.json({});

  // ウォッチリスト・保有・注文・市場評価・時価・PSC履歴を並列取得
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const [watchlist, holdings, todayOrders, todayAssessment, quotes, pscHistMap] = await Promise.all([
    getAllWatchlist(),
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
    fetchStockQuotesBatch(tickers, { yfinanceFallback: !isMarketOpen() }),
    fetchPSCHistoricalData(tickers),
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

  // 戦略条件チェック
  function checkStrategies(ticker: string, quote: { price: number; open: number; volume: number } | null): string[] {
    if (!quote) return [];
    const wl = wlMap.get(ticker);
    if (!wl) return [];

    const surgeRatio = calculateVolumeSurgeRatio(quote.volume, wl.avgVolume25, hour, minute);
    const strategies: string[] = [];

    // GU: 全4条件（vol4x以上なら gap 条件を1%に緩和）
    const effectiveGapMin = surgeRatio >= GAPUP.ENTRY.GAP_RELAX_VOL_THRESHOLD
      ? GAPUP.ENTRY.GAP_MIN_PCT_RELAXED
      : GAPUP.ENTRY.GAP_MIN_PCT;
    if (
      wl.latestClose > 0 &&
      quote.open > wl.latestClose * (1 + effectiveGapMin) &&
      quote.price > wl.latestClose * (1 + effectiveGapMin) &&
      quote.price >= quote.open &&
      surgeRatio >= GAPUP.ENTRY.VOL_SURGE_RATIO
    ) {
      strategies.push("GU");
    }

    // PSC: 全4条件を満たす場合のみ
    const pscHist = pscHistMap.get(ticker);
    if (pscHist) {
      const momentum20d = pscHist.close20DaysAgo > 0 ? quote.price / pscHist.close20DaysAgo - 1 : 0;
      const highDistancePct = pscHist.high20 > 0 ? quote.price / pscHist.high20 - 1 : -1;

      if (
        momentum20d >= POST_SURGE_CONSOLIDATION.ENTRY.MOMENTUM_MIN_RETURN &&
        highDistancePct >= -POST_SURGE_CONSOLIDATION.ENTRY.MAX_HIGH_DISTANCE_PCT &&
        quote.price >= quote.open &&
        surgeRatio >= POST_SURGE_CONSOLIDATION.ENTRY.VOL_SURGE_RATIO
      ) {
        strategies.push("PSC");
      }
    }

    return strategies;
  }

  // GU条件詳細を計算
  type GapupConditions = {
    gapPct: number;           // ギャップ率 (%)
    isGapOk: boolean;         // gap >= 3%（vol4x以上なら1%に緩和）
    closePct: number;         // 終値の前日比 (%)
    isCloseGapOk: boolean;    // 終値もギャップ維持（close > prevClose × 1.03）
    isCandleOk: boolean;      // 陽線（price >= open）
    isVolumeOk: boolean;      // 出来高サージ >= 1.5x
    prevClose: number;
    open: number;
    surgeRatio: number;       // 出来高サージ倍率（緩和判定用）
  };

  function calcGapupConditions(ticker: string, quote: { price: number; open: number; volume: number } | null): GapupConditions | null {
    if (!quote) return null;
    const wl = wlMap.get(ticker);
    if (!wl || wl.latestClose <= 0) return null;

    const surgeRatio = calculateVolumeSurgeRatio(quote.volume, wl.avgVolume25, hour, minute);
    const gapPct = ((quote.open - wl.latestClose) / wl.latestClose) * 100;
    const closePct = ((quote.price - wl.latestClose) / wl.latestClose) * 100;

    // vol が 4x 以上なら gap 条件を 1% に緩和
    const effectiveGapMin = surgeRatio >= GAPUP.ENTRY.GAP_RELAX_VOL_THRESHOLD
      ? GAPUP.ENTRY.GAP_MIN_PCT_RELAXED
      : GAPUP.ENTRY.GAP_MIN_PCT;

    return {
      gapPct,
      isGapOk: quote.open > wl.latestClose * (1 + effectiveGapMin),
      closePct,
      isCloseGapOk: quote.price > wl.latestClose * (1 + effectiveGapMin),
      isCandleOk: quote.price >= quote.open,
      isVolumeOk: surgeRatio >= GAPUP.ENTRY.VOL_SURGE_RATIO,
      prevClose: wl.latestClose,
      open: quote.open,
      surgeRatio,
    };
  }

  // PSC条件詳細を計算
  type PscConditions = {
    momentum20d: number;       // 20日モメンタム (%)
    isMomentum20dOk: boolean;  // 20日モメンタム >= 15%
    highDistancePct: number;   // 高値からの乖離 (%)
    isHighDistanceOk: boolean; // 高値から-5%以内
    isCandleOk: boolean;       // 陽線（price >= open）
    isVolumeOk: boolean;       // 出来高サージ >= 1.5x
  };

  function calcPscConditions(
    ticker: string,
    quote: { price: number; open: number; volume: number } | null,
    pscHist: PSCHistoricalData | undefined,
  ): PscConditions | null {
    const wl = wlMap.get(ticker);
    if (!wl) return null;

    const surgeRatio = quote
      ? calculateVolumeSurgeRatio(quote.volume, wl.avgVolume25, hour, minute)
      : 0;

    // 履歴データがない場合はデフォルト値
    const currentPrice = quote?.price ?? wl.latestClose;
    const close20DaysAgo = pscHist?.close20DaysAgo ?? 0;
    const high20 = pscHist?.high20 ?? 0;

    const momentum20d = close20DaysAgo > 0 ? (currentPrice / close20DaysAgo - 1) : 0;
    const highDistancePct = high20 > 0 ? (currentPrice / high20 - 1) : 0;

    return {
      momentum20d,
      isMomentum20dOk: momentum20d >= POST_SURGE_CONSOLIDATION.ENTRY.MOMENTUM_MIN_RETURN,
      highDistancePct,
      isHighDistanceOk: highDistancePct >= -POST_SURGE_CONSOLIDATION.ENTRY.MAX_HIGH_DISTANCE_PCT,
      isCandleOk: quote ? quote.price >= quote.open : false,
      isVolumeOk: surgeRatio >= POST_SURGE_CONSOLIDATION.ENTRY.VOL_SURGE_RATIO,
    };
  }

  // ティッカーごとのデータ（注文済/保有中は返さない）
  const tickerData: Record<string, {
    strategies: string[];
    surgeRatio: number | null;
    price: number | null;
    open: number | null;
    gapup: GapupConditions | null;
    psc: PscConditions | null;
  }> = {};

  const marketOpen = isMarketOpen();

  // 市場フェーズ判定（場前: pre / 場中: intra / 場後: post）
  const currentMinutes = hour * 60 + minute;
  const marketPhase: "pre" | "intra" | "post" =
    currentMinutes < 9 * 60 ? "pre"
    : marketOpen ? "intra"
    : "post";

  for (const ticker of tickers) {
    // 注文済/保有中は既にアクション済のためレスポンスに含めない
    if (holdingTickers.has(ticker) || orderedMap.has(ticker)) continue;

    const quote = quotes.get(ticker);
    const wl = wlMap.get(ticker);

    const surgeRatio = quote && wl
      ? calculateVolumeSurgeRatio(quote.volume, wl.avgVolume25, hour, minute)
      : null;

    // 場前は前日データが混入するため open/gapup を null にする
    // 場中・場後は当日データが取得できるため gapup 計算を行う
    const quoteData = marketPhase !== "pre" && quote ? { price: quote.price, open: quote.open, volume: quote.volume } : null;

    tickerData[ticker] = {
      strategies: checkStrategies(ticker, quoteData),
      surgeRatio,
      price: quote?.price ?? null,
      open: marketPhase !== "pre" ? (quote?.open ?? null) : null,
      gapup: calcGapupConditions(ticker, quoteData),
      psc: calcPscConditions(ticker, quoteData, pscHistMap.get(ticker)),
    };
  }

  // 時間帯チェック
  const [eh, em] = [9, 5]; // 市場エントリー開始 09:05
  const [lh, lm] = [15, 25]; // 市場エントリー終了 15:25
  const current = hour * 60 + minute;
  const inTimeWindow = current >= eh * 60 + em && current <= lh * 60 + lm;

  const brokerError = isMarketOpen() && quotes.size < tickers.length;

  return c.json({
    tickers: tickerData,
    global: {
      inTimeWindow,
      shouldTrade: todayAssessment?.shouldTrade ?? false,
      marketPhase,
      ...(brokerError && { _error: "broker_api_failed" }),
    },
  });
});

/**
 * GET /api/intraday-ma-signals?from=YYYY-MM-DD&to=YYYY-MM-DD - 当日MA引きつけシグナル一覧
 */
app.get("/intraday-ma-signals", async (c) => {
  const fromParam = c.req.query("from");
  const toParam = c.req.query("to");

  const from = fromParam ? new Date(`${fromParam}T00:00:00Z`) : getDaysAgoForDB(30);
  const to = toParam ? new Date(`${toParam}T00:00:00Z`) : getTodayForDB();

  const signals = await prisma.intraDayMaPullbackSignal.findMany({
    where: {
      date: { gte: from, lte: to },
    },
    orderBy: [{ date: "desc" }, { detectedAt: "asc" }],
  });

  const result = signals.map((s) => {
    let pnl: number | null = null;
    if (s.closePrice != null) {
      if (s.closePrice < s.stopLossPrice) {
        pnl = (s.stopLossPrice - s.detectedPrice) / s.detectedPrice;
      } else {
        pnl = (s.closePrice - s.detectedPrice) / s.detectedPrice;
      }
    }
    return {
      id: s.id,
      date: s.date.toISOString().slice(0, 10),
      tickerCode: s.tickerCode,
      detectedAt: s.detectedAt.toISOString(),
      ma20: s.ma20,
      detectedPrice: s.detectedPrice,
      closePrice: s.closePrice,
      stopLossPrice: s.stopLossPrice,
      atr14: s.atr14,
      pnl,
      createdAt: s.createdAt.toISOString(),
    };
  });

  return c.json(result);
});

/**
 * GET /api/rejected-signals
 *
 * クエリパラメータ:
 * - strategy: gapup | weekly-break | post-surge-consolidation | all (default: all)
 * - dateFrom: YYYY-MM-DD
 * - dateTo: YYYY-MM-DD
 */
app.get("/rejected-signals", async (c) => {
  const strategy = c.req.query("strategy") ?? "all";
  const dateFrom = c.req.query("dateFrom");
  const dateTo = c.req.query("dateTo");

  const where: Prisma.RejectedSignalWhereInput = {};
  if (strategy !== "all") where.strategy = strategy;
  if (dateFrom) where.rejectedAt = { ...((where.rejectedAt ?? {}) as object), gte: new Date(dateFrom) };
  if (dateTo) where.rejectedAt = { ...((where.rejectedAt ?? {}) as object), lte: new Date(`${dateTo}T23:59:59Z`) };

  const signals = await prisma.rejectedSignal.findMany({
    where,
    orderBy: { rejectedAt: "desc" },
    take: 200,
  });

  // 理由別集計
  const summaryMap = new Map<string, { count: number; sum5d: number; count5d: number; sum10d: number; count10d: number }>();
  for (const s of signals) {
    const entry = summaryMap.get(s.reasonLabel) ?? { count: 0, sum5d: 0, count5d: 0, sum10d: 0, count10d: 0 };
    entry.count++;
    if (s.return5dPct !== null) { entry.sum5d += s.return5dPct; entry.count5d++; }
    if (s.return10dPct !== null) { entry.sum10d += s.return10dPct; entry.count10d++; }
    summaryMap.set(s.reasonLabel, entry);
  }

  const summary = Array.from(summaryMap.entries()).map(([label, v]) => ({
    label,
    count: v.count,
    avg5dPct: v.count5d > 0 ? v.sum5d / v.count5d : null,
    avg10dPct: v.count10d > 0 ? v.sum10d / v.count10d : null,
  }));

  return c.json({ summary, signals });
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
