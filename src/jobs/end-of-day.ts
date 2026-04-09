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
import { getTodayForDB, getStartOfDayJST, getEndOfDayJST } from "../lib/market-date";
import { STRATEGY_SWITCHING } from "../lib/constants";
import { fetchStockQuote } from "../core/market-data";
import { closePosition, getCashBalance, getTotalPortfolioValue } from "../core/position-manager";
import type { ExitSnapshot } from "../types/snapshots";
import { expireOrders } from "../core/order-executor";
import { getDailyPnl } from "../core/risk-manager";
import { updatePeakEquity } from "../core/drawdown-manager";
import { notifyDailyReport, notifyOrderFilled } from "../lib/slack";
import { chatCompletion } from "../lib/openai";
import dayjs from "dayjs";

async function forceClosePositions(
  positions: Awaited<ReturnType<typeof prisma.tradingPosition.findMany>>,
  exitReason: string,
) {
  for (const position of positions) {
    const stock = (position as typeof position & { stock: { tickerCode: string; name: string } }).stock;
    const quote = await fetchStockQuote(stock.tickerCode);
    const exitPrice = quote?.price ?? Number(position.entryPrice);

    console.log(
      `  → ${stock.tickerCode}: ${exitReason} @ ¥${exitPrice.toLocaleString()}`,
    );

    const entryPriceNum = Number(position.entryPrice);
    const maxHigh = position.maxHighDuringHold
      ? Math.max(Number(position.maxHighDuringHold), quote?.high ?? exitPrice)
      : exitPrice;
    const minLow = position.minLowDuringHold
      ? Math.min(Number(position.minLowDuringHold), quote?.low ?? exitPrice)
      : exitPrice;

    const exitSnapshot: ExitSnapshot = {
      exitReason,
      exitPrice,
      priceJourney: {
        maxHigh,
        minLow,
        maxFavorableExcursion:
          ((maxHigh - entryPriceNum) / entryPriceNum) * 100,
        maxAdverseExcursion:
          ((entryPriceNum - minLow) / entryPriceNum) * 100,
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
      filledPrice: exitPrice,
      quantity: position.quantity,
      pnl: closed.realizedPnl ? Number(closed.realizedPnl) : 0,
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
  closedToday: { exitSnapshot: unknown; realizedPnl: unknown; strategy: string | null; stock: { tickerCode: string; name: string }; entryPrice: unknown; exitPrice: unknown }[];
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

    const grossProfit = closedToday
      .filter((p) => p.realizedPnl && Number(p.realizedPnl) > 0)
      .reduce((s, p) => s + Number(p.realizedPnl), 0);
    const grossLoss = Math.abs(
      closedToday
        .filter((p) => p.realizedPnl && Number(p.realizedPnl) <= 0)
        .reduce((s, p) => s + Number(p.realizedPnl), 0),
    );
    const pf = grossLoss > 0 ? (grossProfit / grossLoss).toFixed(2) : grossProfit > 0 ? "∞" : "-";

    // 決済銘柄の詳細
    const closedDetails = closedToday.map((p) => {
      const pnl = Number(p.realizedPnl ?? 0);
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
    (p) => p.realizedPnl && Number(p.realizedPnl) > 0,
  ).length;
  const losses = closedToday.filter(
    (p) => p.realizedPnl && Number(p.realizedPnl) < 0,
  ).length;
  const totalPnl = await getDailyPnl(new Date());

  // ポートフォリオ評価
  const openPositions = await prisma.tradingPosition.findMany({
    where: { status: "open" },
    include: { stock: true },
  });

  const priceMap = new Map<string, number>();
  for (const pos of openPositions) {
    const quote = await fetchStockQuote(pos.stock.tickerCode);
    if (quote) {
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

  console.log("=== End of Day 終了 ===");
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
