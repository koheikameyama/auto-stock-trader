/**
 * 日次締め処理（15:50 JST / 平日）
 *
 * 1a. VIX高騰時（≥30）のポジション強制決済（オーバーナイトリスク回避）
 * 1b. crisis時のポジション強制決済
 * 2. 期限切れ注文のキャンセル
 * 3. TradingDailySummary 作成
 * 4. 日次サマリー生成
 * 5. Slackに日次レポート送信
 */

import { prisma } from "../lib/prisma";
import { getTodayForDB, getStartOfDayJST, getEndOfDayJST, addTradingDays, toJSTDateForDB } from "../lib/market-date";
import { STRATEGY_SWITCHING } from "../lib/constants";
import { MARKET_BREADTH } from "../lib/constants/trading";
import { fetchStockQuote } from "../core/market-data";
import { closePosition, getCashBalance, getTotalPortfolioValue, getPositionPnl } from "../core/position-manager";
import type { ExitSnapshot } from "../types/snapshots";
import { expireOrders } from "../core/order-executor";
import { getDailyPnl } from "../core/risk-manager";
import { updatePeakEquity } from "../core/drawdown-manager";
import { notifyDailyReport, notifyOrderFilled, notifySlack } from "../lib/slack";
import { chatCompletion } from "../lib/openai";
import { calculateMarketBreadth } from "../core/market-breadth";
import dayjs from "dayjs";

async function forceClosePositions(
  positions: Awaited<ReturnType<typeof prisma.tradingPosition.findMany>>,
  exitReason: string,
) {
  for (const position of positions) {
    const stock = (position as typeof position & { stock: { tickerCode: string; name: string } }).stock;
    const quote = await fetchStockQuote(stock.tickerCode, { yfinanceFallback: true });
    const exitPrice = (quote?.price && quote.price > 0) ? quote.price : Number(position.entryPrice);

    console.log(
      `  → ${stock.tickerCode}: ${exitReason} @ ¥${exitPrice.toLocaleString()}`,
    );

    const maxHigh = position.maxHighDuringHold
      ? Math.max(Number(position.maxHighDuringHold), quote?.high ?? exitPrice)
      : exitPrice;

    const exitSnapshot: ExitSnapshot = {
      exitReason,
      exitPrice,
      priceJourney: {
        maxHigh,
      },
      marketContext: null,
    };

    const closed = await closePosition(
      position.id,
      exitPrice,
      exitSnapshot as object,
    );

    await notifyOrderFilled({
      tickerCode: stock.tickerCode,
      name: stock.name,
      side: "sell",
      strategy: position.strategy,
      filledPrice: exitPrice,
      quantity: position.quantity,
      entryPrice: Number(position.entryPrice),
      pnl: getPositionPnl(closed),
      exitReason,
    });
  }
}

/** exitSnapshot から exitReason を安全に取り出す */
function getExitReason(snapshot: unknown): string {
  if (snapshot && typeof snapshot === "object" && "exitReason" in snapshot) {
    return String((snapshot as { exitReason: string }).exitReason);
  }
  return "unknown";
}

async function generateDailyReview(params: {
  totalTrades: number;
  wins: number;
  losses: number;
  totalPnl: number;
  portfolioValue: number;
  cashBalance: number;
  closedToday: { exitSnapshot: unknown; strategy: string | null; stock: { tickerCode: string; name: string }; entryPrice: number | { toNumber?: () => number }; exitPrice: number | { toNumber?: () => number } | null; quantity: number }[];
  filledBuyOrders: { stock: { tickerCode: string; name: string } }[];
  openPositions: { stock: { tickerCode: string; name: string }; stockId: string; entryPrice: unknown; quantity: number; strategy: string | null }[];
  priceMap: Map<string, number>;
  vix: number | null;
  breadth: number | null;
  sentiment: string | null;
}): Promise<string> {
  const {
    totalTrades, wins, losses, totalPnl, portfolioValue, cashBalance,
    closedToday, filledBuyOrders, openPositions, priceMap, vix, breadth, sentiment,
  } = params;

  // フォールバック用の機械的テキスト
  const fallback = totalTrades > 0
    ? `${totalTrades}件決済(${wins}勝${losses}敗, 勝率${totalTrades > 0 ? Math.round((wins / totalTrades) * 100) : 0}%)`
    : filledBuyOrders.length > 0
      ? `新規エントリー${filledBuyOrders.length}件`
      : "取引なし";

  // 何もアクティビティがなければAI不要
  if (totalTrades === 0 && filledBuyOrders.length === 0 && openPositions.length === 0) {
    return fallback;
  }

  try {
    // エグジット分類集計
    const exitCounts: Record<string, number> = {};
    for (const p of closedToday) {
      const reason = getExitReason(p.exitSnapshot);
      exitCounts[reason] = (exitCounts[reason] || 0) + 1;
    }
    const exitSummary = Object.entries(exitCounts)
      .map(([reason, count]) => `${reason}: ${count}件`)
      .join(", ");

    // 戦略別集計
    const strategyCounts: Record<string, number> = {};
    for (const p of closedToday) {
      const s = p.strategy || "unknown";
      strategyCounts[s] = (strategyCounts[s] || 0) + 1;
    }
    const strategySummary = Object.entries(strategyCounts)
      .map(([s, count]) => `${s}: ${count}件`)
      .join(", ");

    // 新規エントリー銘柄
    const entryNames = filledBuyOrders
      .map((o) => `${o.stock.tickerCode}(${o.stock.name})`)
      .join(", ");

    const closedPnls = closedToday.map((p) => getPositionPnl(p));
    const grossProfit = closedPnls.filter((v) => v > 0).reduce((s, v) => s + v, 0);
    const grossLoss = Math.abs(closedPnls.filter((v) => v <= 0).reduce((s, v) => s + v, 0));
    const pf = grossLoss > 0 ? (grossProfit / grossLoss).toFixed(2) : grossProfit > 0 ? "∞" : "-";

    // 決済銘柄の詳細
    const closedDetails = closedToday.map((p) => {
      const pnl = getPositionPnl(p);
      const entry = Number(p.entryPrice);
      const exit = Number(p.exitPrice);
      const pnlPct = entry > 0 ? ((exit - entry) / entry * 100).toFixed(1) : "?";
      const reason = getExitReason(p.exitSnapshot);
      return `  ${p.stock.tickerCode}(${p.stock.name}): ${reason}, ${pnlPct}%, ¥${pnl.toLocaleString()}`;
    }).join("\n");

    // 保有中ポジションの詳細
    const openDetails = openPositions.map((p) => {
      const entry = Number(p.entryPrice);
      const current = priceMap.get(p.stockId) ?? entry;
      const unrealizedPnl = (current - entry) * p.quantity;
      const unrealizedPct = entry > 0 ? ((current - entry) / entry * 100).toFixed(1) : "?";
      return `  ${p.stock.tickerCode}(${p.stock.name}): ${p.strategy ?? "?"}, ${unrealizedPct}%, 含み損益¥${Math.round(unrealizedPnl).toLocaleString()}`;
    }).join("\n");

    const userContent = [
      `## 本日のトレード結果`,
      `- 決済: ${totalTrades}件 (${wins}勝${losses}敗)`,
      `- 損益: ¥${totalPnl.toLocaleString()}`,
      `- PF: ${pf}`,
      totalTrades > 0 ? `- エグジット内訳: ${exitSummary}` : null,
      totalTrades > 0 ? `- 戦略別: ${strategySummary}` : null,
      totalTrades > 0 ? `\n### 決済銘柄\n${closedDetails}` : null,
      filledBuyOrders.length > 0 ? `\n### 新規エントリー: ${filledBuyOrders.length}件\n  ${entryNames}` : null,
      openPositions.length > 0 ? `\n### 保有中ポジション (${openPositions.length}件)\n${openDetails}` : null,
      ``,
      `## ポートフォリオ`,
      `- 評価額: ¥${Math.round(portfolioValue).toLocaleString()}`,
      `- 現金: ¥${Math.round(cashBalance).toLocaleString()}`,
      ``,
      `## 市場環境`,
      `- VIX: ${vix?.toFixed(1) ?? "N/A"}`,
      `- Breadth(値上がり率): ${breadth != null ? (breadth * 100).toFixed(0) + "%" : "N/A"}`,
      `- センチメント: ${sentiment ?? "N/A"}`,
    ].filter(Boolean).join("\n");

    const result = await chatCompletion([
      {
        role: "system",
        content: [
          "あなたはプロの株式トレーダーです。",
          "本日のトレード結果と市場環境を踏まえ、日次の総評を日本語で書いてください。",
          "",
          "## ルール",
          "- 決済・エントリー・保有中の各銘柄名に触れつつ全体を俯瞰した総評を書く",
          "- 各銘柄の損益%やエグジット理由を具体的に言及する（例:「〇〇はtrailingで+3.2%確保」）",
          "- 損切り(stop_loss)は損小利大戦略では正常動作。ポジティブに評価する",
          "- トレーリング(trailing_profit)は「利益を伸ばせた」と評価する",
          "- 市場環境（VIX, Breadth）と結果の整合性に言及する",
          "- 取引がない日は市場環境のみコメントする",
          "- 銘柄数が多い場合は損益インパクトの大きい銘柄を優先して言及する",
          "- JSONで返す: {\"review\": \"...\"}",
        ].join("\n"),
      },
      { role: "user", content: userContent },
    ], { temperature: 0.5, maxTokens: 500 });

    const parsed = JSON.parse(result);
    if (parsed.review && typeof parsed.review === "string") {
      return parsed.review;
    }
    return fallback;
  } catch (error) {
    console.error("  AI日次レビュー生成失敗（フォールバック使用）:", error);
    return fallback;
  }
}

export async function main() {
  console.log("=== End of Day 開始 ===");

  // 今日の戦略判定を取得
  const todayAssessmentForStrategy = await prisma.marketAssessment.findUnique({
    where: { date: getTodayForDB() },
  });
  const _todayStrategy = (todayAssessmentForStrategy as Record<string, unknown> | null)?.tradingStrategy as string | null;

  // 1a. VIX高騰時のポジション強制決済（オーバーナイトリスク回避）
  // VIX ≥ 30: 全ポジション強制決済（ギャップダウンでSLが機能しないリスク）
  const todayVix = todayAssessmentForStrategy?.vix != null
    ? Number(todayAssessmentForStrategy.vix)
    : null;

  if (todayVix != null && todayVix >= STRATEGY_SWITCHING.VIX_FORCE_CLOSE_THRESHOLD) {
    console.log(`[1a/5] VIX ${todayVix.toFixed(1)} ≥ ${STRATEGY_SWITCHING.VIX_FORCE_CLOSE_THRESHOLD}: 全ポジション強制決済...`);
    const overnightPositions = await prisma.tradingPosition.findMany({
      where: { status: "open", strategy: { in: ["breakout", "gapup"] } },
      include: { stock: true },
    });
    if (overnightPositions.length > 0) {
      console.log(`  ${overnightPositions.length}件のポジションを決済`);
      await forceClosePositions(overnightPositions, "VIX高騰オーバーナイトリスク回避");
    } else {
      console.log("  対象なし");
    }
  } else {
    console.log(`[1a/5] VIX ${todayVix?.toFixed(1) ?? "N/A"}: ポジション保持`);
  }

  // 1b. crisis時のポジション強制決済
  const todaySentiment = todayAssessmentForStrategy?.sentiment as string | null;
  if (todaySentiment === "crisis") {
    console.log(`[1b/5] センチメント「${todaySentiment}」: 全ポジション強制決済...`);
    const crisisPositions = await prisma.tradingPosition.findMany({
      where: { status: "open", strategy: { in: ["breakout", "gapup"] } },
      include: { stock: true },
    });
    if (crisisPositions.length > 0) {
      console.log(`  ${crisisPositions.length}件のポジションを決済`);
      await forceClosePositions(crisisPositions, `${todaySentiment}環境オーバーナイトリスク回避`);
    } else {
      console.log("  対象なし");
    }
  }

  // 2. 期限切れ注文のキャンセル
  console.log("[2/5] 期限切れ注文キャンセル...");
  const expiredCount = await expireOrders();
  console.log(`  ${expiredCount}件キャンセル`);

  // 当日の未約定注文もキャンセル
  const pendingCount = await prisma.tradingOrder.updateMany({
    where: {
      status: "pending",
      createdAt: { gte: getTodayForDB() },
    },
    data: { status: "cancelled" },
  });
  console.log(`  当日未約定注文キャンセル: ${pendingCount.count}件`);

  // 3. 日次サマリー計算
  console.log("[3/5] 日次サマリー計算...");
  const startOfDay = getStartOfDayJST();
  const endOfDay = getEndOfDayJST();

  // 今日クローズされたポジション
  const closedToday = await prisma.tradingPosition.findMany({
    where: {
      status: "closed",
      exitedAt: { gte: startOfDay, lte: endOfDay },
    },
    include: { stock: true },
  });

  // 今日約定した買い注文（エントリー）
  const filledBuyOrders = await prisma.tradingOrder.findMany({
    where: {
      side: "buy",
      status: "filled",
      filledAt: { gte: startOfDay, lte: endOfDay },
    },
    include: { stock: true },
  });

  const totalTrades = closedToday.length;
  const wins = closedToday.filter(
    (p) => getPositionPnl(p) > 0,
  ).length;
  const losses = closedToday.filter(
    (p) => getPositionPnl(p) < 0,
  ).length;
  const totalPnl = await getDailyPnl(new Date());

  // ポートフォリオ評価
  const openPositions = await prisma.tradingPosition.findMany({
    where: { status: "open" },
    include: { stock: true },
  });

  const priceMap = new Map<string, number>();
  for (const pos of openPositions) {
    const quote = await fetchStockQuote(pos.stock.tickerCode, { yfinanceFallback: true });
    if (quote && quote.price > 0) {
      priceMap.set(pos.stockId, quote.price);
    }
  }

  const portfolioValue = await getTotalPortfolioValue(priceMap);
  const cashBalance = await getCashBalance();

  console.log(
    `  決済数: ${totalTrades}, 勝: ${wins}, 負: ${losses}, 損益: ¥${totalPnl.toLocaleString()}, エントリー: ${filledBuyOrders.length}件`,
  );

  // 4. 日次サマリー生成（AI総評）
  console.log("[4/5] 日次サマリー生成...");
  const aiReview = await generateDailyReview({
    totalTrades,
    wins,
    losses,
    totalPnl,
    portfolioValue,
    cashBalance,
    closedToday,
    filledBuyOrders,
    openPositions,
    priceMap,
    vix: todayVix,
    breadth: todayAssessmentForStrategy?.breadth != null
      ? Number(todayAssessmentForStrategy.breadth)
      : null,
    sentiment: todaySentiment,
  });

  // 5. TradingDailySummary 作成
  console.log("[5/5] DailySummary保存 + Slack通知...");
  await prisma.tradingDailySummary.upsert({
    where: { date: getTodayForDB() },
    create: {
      date: getTodayForDB(),
      totalTrades,
      wins,
      losses,
      totalPnl,
      portfolioValue: Math.round(portfolioValue),
      cashBalance: Math.round(cashBalance),
      aiReview,
    },
    update: {
      totalTrades,
      wins,
      losses,
      totalPnl,
      portfolioValue: Math.round(portfolioValue),
      cashBalance: Math.round(cashBalance),
      aiReview,
    },
  });

  // ピークエクイティ更新
  const totalEquity = portfolioValue + cashBalance;
  await updatePeakEquity(totalEquity);

  // Slack通知
  await notifyDailyReport({
    date: dayjs().format("YYYY-MM-DD"),
    totalTrades,
    wins,
    losses,
    totalPnl,
    portfolioValue: Math.round(portfolioValue),
    cashBalance: Math.round(cashBalance),
    aiReview,
  });

  // 6. RejectedSignal の close5d/close10d 補完
  await fillRejectedSignalReturns();

  // 7. MA押し目シグナルの終値補完
  await fillIntradayMaSignalClosePrices(getTodayForDB());

  // 8. 決済後の株価追跡補完
  await fillPostExitReturns();

  // 9. 翌日始値乖離補完
  await fillNextDayOpen();

  // 10. 翌日エントリー可否通知（直近の JP 営業日終値ベース）
  // 15:50 時点では当日分の StockDailyBar が未入庫（17:00 backfill 前）なので
  // asOfDate は明示せず、StockDailyBarにある最新 JP 日を使う（Slack通知に基準日を表示）。
  const tomorrowBreadth = await calculateMarketBreadth().catch((e) => {
    console.warn("翌日breadth計算に失敗:", e);
    return null;
  });
  if (tomorrowBreadth) {
    const pct = (tomorrowBreadth.breadth * 100).toFixed(1);
    const asOf = tomorrowBreadth.asOfDate.toISOString().slice(0, 10);
    const isEntryOk = tomorrowBreadth.breadth >= MARKET_BREADTH.THRESHOLD && tomorrowBreadth.breadth <= MARKET_BREADTH.UPPER_CAP;
    const reason = tomorrowBreadth.breadth < MARKET_BREADTH.THRESHOLD
      ? `${pct}% — ${(MARKET_BREADTH.THRESHOLD * 100).toFixed(0)}%未満につきスキップ`
      : tomorrowBreadth.breadth > MARKET_BREADTH.UPPER_CAP
        ? `${pct}% — ${(MARKET_BREADTH.UPPER_CAP * 100).toFixed(0)}%超過（過熱）につきスキップ`
        : `${pct}% — エントリーゾーン内`;
    await notifySlack({
      title: isEntryOk ? `🟢 明日エントリー可: Breadth ${pct}%` : `🔴 明日エントリーNG: Breadth ${pct}%`,
      message: reason,
      color: isEntryOk ? "good" : "warning",
      fields: [
        { title: "SMA25超え", value: `${tomorrowBreadth.above}/${tomorrowBreadth.total}銘柄`, short: true },
        { title: "基準日", value: asOf, short: true },
      ],
    });
  }

  console.log("=== End of Day 終了 ===");
}

async function fillIntradayMaSignalClosePrices(today: Date): Promise<void> {
  const signals = await prisma.intraDayMaPullbackSignal.findMany({
    where: { date: today, closePrice: null },
    select: { id: true, tickerCode: true },
  });

  if (!signals.length) {
    console.log("[end-of-day] MA押し目シグナル終値補完: 対象なし");
    return;
  }

  const tickers = signals.map((s) => s.tickerCode);

  const bars = await prisma.stockDailyBar.findMany({
    where: { tickerCode: { in: tickers }, date: today },
    select: { tickerCode: true, close: true },
  });

  const closeMap = new Map<string, number>();
  for (const bar of bars) {
    closeMap.set(bar.tickerCode, Number(bar.close));
  }

  await Promise.all(
    tickers.map((ticker) => {
      const close = closeMap.get(ticker);
      if (close == null) return Promise.resolve();
      return prisma.intraDayMaPullbackSignal.updateMany({
        where: { date: today, tickerCode: ticker },
        data: { closePrice: close },
      });
    }),
  );

  console.log(`[end-of-day] MA押し目シグナル終値補完: ${signals.length}件`);
}

/**
 * RejectedSignal の close5d / close10d を StockDailyBar から補完する
 */
async function fillRejectedSignalReturns(): Promise<void> {
  const tag = "[end-of-day] RejectedSignal補完";

  const signals = await prisma.rejectedSignal.findMany({
    where: {
      OR: [{ close5d: null }, { close10d: null }],
    },
  });

  if (!signals.length) {
    console.log(`${tag}: 対象なし`);
    return;
  }

  console.log(`${tag}: ${signals.length}件処理開始`);

  for (const signal of signals) {
    const updates: {
      close5d?: number;
      return5dPct?: number;
      close10d?: number;
      return10dPct?: number;
    } = {};

    if (signal.close5d === null) {
      const target5d = addTradingDays(signal.rejectedAt, 5);
      const bar5d = await prisma.stockDailyBar.findFirst({
        where: { tickerCode: signal.ticker, date: target5d },
        select: { close: true },
      });
      if (bar5d) {
        updates.close5d = bar5d.close;
        updates.return5dPct = ((bar5d.close - signal.entryPrice) / signal.entryPrice) * 100;
      }
    }

    if (signal.close10d === null) {
      const target10d = addTradingDays(signal.rejectedAt, 10);
      const bar10d = await prisma.stockDailyBar.findFirst({
        where: { tickerCode: signal.ticker, date: target10d },
        select: { close: true },
      });
      if (bar10d) {
        updates.close10d = bar10d.close;
        updates.return10dPct = ((bar10d.close - signal.entryPrice) / signal.entryPrice) * 100;
      }
    }

    if (Object.keys(updates).length) {
      await prisma.rejectedSignal.update({
        where: { id: signal.id },
        data: updates,
      });
    }
  }

  console.log(`${tag}: 完了`);
}

/**
 * 決済後の株価追跡: close5d/close10d + maxHigh/minLow (10営業日) を補完
 */
export async function fillPostExitReturns(): Promise<void> {
  const tag = "[end-of-day] PostExit補完";

  const positions = await prisma.tradingPosition.findMany({
    where: {
      status: "closed",
      exitedAt: { not: null },
      exitPrice: { not: null },
      OR: [
        { postExitClose5d: null },
        { postExitClose10d: null },
      ],
    },
    include: { stock: { select: { tickerCode: true } } },
  });

  if (!positions.length) {
    console.log(`${tag}: 対象なし`);
    return;
  }

  console.log(`${tag}: ${positions.length}件処理開始`);
  let updatedCount = 0;

  for (const position of positions) {
    const exitDate = position.exitedAt!;
    const exitPrice = Number(position.exitPrice!);
    const tickerCode = position.stock.tickerCode;

    // exitedAt (DateTime) → @db.Date 形式に変換（JST日付境界）
    const exitDateForDb = toJSTDateForDB(exitDate);

    const target10d = addTradingDays(exitDate, 10);

    // 決済日翌日〜10営業日後の全バーを一括取得
    const bars = await prisma.stockDailyBar.findMany({
      where: {
        tickerCode,
        date: { gt: exitDateForDb, lte: target10d },
      },
      orderBy: { date: "asc" },
      select: { close: true, high: true, low: true },
    });

    if (bars.length === 0) continue;

    const updates: Record<string, number> = {};

    // close5d: 5営業日目の終値 (bars[4])
    if (position.postExitClose5d === null && bars.length >= 5) {
      const close5d = bars[4].close;
      updates.postExitClose5d = close5d;
      updates.postExitReturn5dPct = ((close5d - exitPrice) / exitPrice) * 100;
    }

    // close10d + maxHigh + minLow: 10営業日分揃ったらセット
    if (position.postExitClose10d === null && bars.length >= 10) {
      const close10d = bars[9].close;
      const maxHigh = Math.max(...bars.slice(0, 10).map((b) => b.high));
      const minLow = Math.min(...bars.slice(0, 10).map((b) => b.low));

      updates.postExitClose10d = close10d;
      updates.postExitReturn10dPct = ((close10d - exitPrice) / exitPrice) * 100;
      updates.postExitMaxHigh10d = maxHigh;
      updates.postExitMinLow10d = minLow;
      updates.postExitMaxHighPct = ((maxHigh - exitPrice) / exitPrice) * 100;
      updates.postExitMinLowPct = ((minLow - exitPrice) / exitPrice) * 100;
    }

    if (Object.keys(updates).length > 0) {
      await prisma.tradingPosition.update({
        where: { id: position.id },
        data: updates,
      });
      updatedCount++;
    }
  }

  console.log(`${tag}: ${updatedCount}件更新完了`);
}

/**
 * 翌日始値乖離を補完する
 *
 * closedポジションで nextDayOpenPrice が null のものに対して、
 * エントリー日の翌営業日始値を取得し、エントリー価格との乖離率を計算する。
 */
export async function fillNextDayOpen(): Promise<void> {
  const tag = "[end-of-day] 翌日始値補完";

  const positions = await prisma.tradingPosition.findMany({
    where: {
      status: "closed",
      nextDayOpenPrice: null,
    },
    include: { stock: { select: { tickerCode: true } } },
  });

  if (!positions.length) {
    console.log(`${tag}: 対象なし`);
    return;
  }

  console.log(`${tag}: ${positions.length}件処理開始`);
  let updatedCount = 0;

  for (const position of positions) {
    const entryDate = position.createdAt;
    const entryPrice = Number(position.entryPrice);
    const tickerCode = position.stock.tickerCode;

    // createdAt (DateTime) → @db.Date 形式に変換（JST日付境界）
    const entryDateForDb = toJSTDateForDB(entryDate);
    const target1d = addTradingDays(entryDate, 1);

    // エントリー日翌日の1本だけ取得
    const bar = await prisma.stockDailyBar.findFirst({
      where: {
        tickerCode,
        date: { gt: entryDateForDb, lte: target1d },
      },
      orderBy: { date: "asc" },
      select: { open: true },
    });

    if (!bar) continue;

    const nextDayOpenPrice = bar.open;
    const nextDayOpenGapPct = ((nextDayOpenPrice - entryPrice) / entryPrice) * 100;

    await prisma.tradingPosition.update({
      where: { id: position.id },
      data: { nextDayOpenPrice, nextDayOpenGapPct },
    });
    updatedCount++;
  }

  console.log(`${tag}: ${updatedCount}件更新完了`);
}

const isDirectRun = process.argv[1]?.includes("end-of-day");
if (isDirectRun) {
  main()
    .catch((error) => {
      console.error("End of Day エラー:", error);
      process.exit(1);
    })
    .finally(async () => {
      await prisma.$disconnect();
    });
}
