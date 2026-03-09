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
import { updatePeakEquity } from "../core/drawdown-manager";
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

  // 取引0件の場合、見送り理由のコンテキストを収集
  let noTradeContext = "";
  if (totalTrades === 0) {
    const todayAssessment = await prisma.marketAssessment.findUnique({
      where: { date: getTodayForDB() },
    });

    const scoringRecords = await prisma.scoringRecord.findMany({
      where: { date: getTodayForDB() },
    });

    if (todayAssessment) {
      noTradeContext += `\n【市場判断】\n`;
      noTradeContext += `- 判定: ${todayAssessment.shouldTrade ? "取引可" : "取引見送り"}\n`;
      noTradeContext += `- センチメント: ${todayAssessment.sentiment}\n`;
      noTradeContext += `- 判断理由: ${todayAssessment.reasoning}\n`;
      if (todayAssessment.nikkeiChange) {
        noTradeContext += `- 日経変化率: ${Number(todayAssessment.nikkeiChange).toFixed(2)}%\n`;
      }
      if (todayAssessment.vix) {
        noTradeContext += `- VIX: ${Number(todayAssessment.vix).toFixed(1)}\n`;
      }
    }

    if (scoringRecords.length > 0) {
      const disqualified = scoringRecords.filter((r) => r.isDisqualified).length;
      const belowThreshold = scoringRecords.filter((r) => r.rejectionReason === "below_threshold").length;
      const aiNoGo = scoringRecords.filter((r) => r.rejectionReason === "ai_no_go").length;
      const marketHalted = scoringRecords.filter((r) => r.rejectionReason === "market_halted").length;

      noTradeContext += `\n【スコアリング結果】\n`;
      noTradeContext += `- 分析銘柄数: ${scoringRecords.length}件\n`;
      if (disqualified > 0) noTradeContext += `- 即死ルール棄却: ${disqualified}件\n`;
      if (belowThreshold > 0) noTradeContext += `- スコア閾値未達: ${belowThreshold}件\n`;
      if (aiNoGo > 0) noTradeContext += `- AI却下: ${aiNoGo}件\n`;
      if (marketHalted > 0) noTradeContext += `- 市場停止(シャドウ): ${marketHalted}件\n`;

      // 上位銘柄のスコアを表示（最大3件）
      const topRecords = [...scoringRecords]
        .sort((a, b) => b.totalScore - a.totalScore)
        .slice(0, 3);
      if (topRecords.length > 0) {
        noTradeContext += `- 上位銘柄: ${topRecords.map((r) => `${r.tickerCode}(${r.totalScore}点/${r.rank})`).join(", ")}\n`;
      }
    }
  }

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
${noTradeContext}
${totalTrades === 0 ? "取引が行われなかった理由を具体的に説明し、明日への改善ポイントを述べてください。" : "今日の結果の要約と明日への改善ポイントを述べてください。"}
150文字以内で回答してください。`;

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
    .finally(() => prisma.$disconnect());
}
