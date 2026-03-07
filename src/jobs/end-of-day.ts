/**
 * 日次締め処理（15:50 JST / 平日）
 *
 * 1. デイトレ未決済ポジションの強制決済
 * 2. 期限切れ注文のキャンセル
 * 3. TradingDailySummary 作成
 * 4. AIによる日次レビュー
 * 5. Slackに日次レポート送信
 */

import { prisma } from "../lib/prisma";
import { getTodayForDB, getStartOfDayJST, getEndOfDayJST } from "../lib/date-utils";
import { OPENAI_CONFIG } from "../lib/constants";
import { getOpenAIClient } from "../lib/openai";
import { fetchStockQuote } from "../core/market-data";
import { closePosition, getCashBalance, getTotalPortfolioValue } from "../core/position-manager";
import type { ExitSnapshot } from "../types/snapshots";
import { expireOrders } from "../core/order-executor";
import { getDailyPnl } from "../core/risk-manager";
import { notifyDailyReport, notifyOrderFilled } from "../lib/slack";
import dayjs from "dayjs";

export async function main() {
  console.log("=== End of Day 開始 ===");

  // 1. デイトレ未決済ポジションの強制決済
  console.log("[1/5] デイトレ未決済ポジション強制決済...");
  const dayTradePositions = await prisma.tradingPosition.findMany({
    where: { status: "open", strategy: "day_trade" },
    include: { stock: true },
  });

  for (const position of dayTradePositions) {
    const quote = await fetchStockQuote(position.stock.tickerCode);
    const exitPrice = quote?.price ?? Number(position.entryPrice);

    console.log(
      `  → ${position.stock.tickerCode}: 強制決済 @ ¥${exitPrice.toLocaleString()}`,
    );

    // exitSnapshot構築
    const entryPriceNum = Number(position.entryPrice);
    const maxHigh = position.maxHighDuringHold
      ? Math.max(Number(position.maxHighDuringHold), quote?.high ?? exitPrice)
      : exitPrice;
    const minLow = position.minLowDuringHold
      ? Math.min(Number(position.minLowDuringHold), quote?.low ?? exitPrice)
      : exitPrice;

    const exitSnapshot: ExitSnapshot = {
      exitReason: "EOD強制決済",
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
      tickerCode: position.stock.tickerCode,
      name: position.stock.name,
      side: "sell",
      filledPrice: exitPrice,
      quantity: position.quantity,
      pnl: closed.realizedPnl ? Number(closed.realizedPnl) : 0,
    });
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
    `  取引数: ${totalTrades}, 勝: ${wins}, 負: ${losses}, 損益: ¥${totalPnl.toLocaleString()}`,
  );

  // 4. AIレビュー
  console.log("[4/5] AI日次レビュー生成...");
  let aiReview = "";

  try {
    const openai = getOpenAIClient();
    const reviewPrompt = `本日の日本株自動売買シミュレーションの日次レビューを簡潔に生成してください。

【本日の結果】
- 取引数: ${totalTrades}件
- 勝敗: ${wins}勝 ${losses}敗
- 確定損益: ¥${totalPnl.toLocaleString()}
- ポートフォリオ時価: ¥${portfolioValue.toLocaleString()}
- 現金残高: ¥${cashBalance.toLocaleString()}
- 残ポジション数: ${openPositions.length}件

100文字以内で、今日の結果の要約と明日への改善ポイントを述べてください。`;

    const response = await openai.chat.completions.create({
      model: OPENAI_CONFIG.MODEL,
      temperature: 0.5,
      messages: [{ role: "user", content: reviewPrompt }],
      max_tokens: 200,
    });

    aiReview = response.choices[0].message.content ?? "";
  } catch (error) {
    console.error("  AIレビュー生成エラー:", error);
  }

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
    .finally(() => prisma.$disconnect());
}
