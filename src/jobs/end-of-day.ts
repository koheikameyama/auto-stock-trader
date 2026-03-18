/**
 * 日次締め処理（15:50 JST / 平日）
 *
 * 1a. デイトレ未決済ポジションの強制決済
 * 1b. VIX高騰時（≥30）のスイングポジション強制決済（オーバーナイトリスク回避）
 * 2. 期限切れ注文のキャンセル
 * 3. TradingDailySummary 作成
 * 4. AIによる日次レビュー
 * 5. Slackに日次レポート送信
 */

import { prisma } from "../lib/prisma";
import { getTodayForDB, getStartOfDayJST, getEndOfDayJST } from "../lib/date-utils";
import { OPENAI_CONFIG, STRATEGY_SWITCHING } from "../lib/constants";
import { getTracedOpenAIClient } from "../lib/openai";
import { flushLangfuse } from "../lib/langfuse";
import { fetchStockQuote } from "../core/market-data";
import { closePosition, getCashBalance, getTotalPortfolioValue } from "../core/position-manager";
import type { ExitSnapshot } from "../types/snapshots";
import { expireOrders } from "../core/order-executor";
import { getDailyPnl } from "../core/risk-manager";
import { updatePeakEquity } from "../core/drawdown-manager";
import { notifyDailyReport, notifyOrderFilled } from "../lib/slack";
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

export async function main() {
  console.log("=== End of Day 開始 ===");

  // 今日の戦略判定を取得
  const todayAssessmentForStrategy = await prisma.marketAssessment.findUnique({
    where: { date: getTodayForDB() },
  });
  const todayStrategy = (todayAssessmentForStrategy as Record<string, unknown> | null)?.tradingStrategy as string | null;

  // 1a. デイトレ未決済ポジションの強制決済
  console.log("[1a/5] デイトレ未決済ポジション強制決済...");
  const dayTradePositions = await prisma.tradingPosition.findMany({
    where: { status: "open", strategy: "day_trade" },
    include: { stock: true },
  });
  await forceClosePositions(dayTradePositions, "EOD強制決済");

  // 1b. VIX高騰時のスイングポジション強制決済（オーバーナイトリスク回避）
  // VIX 25-30: 新規エントリーのみデイトレ化、既存スイングはSLに委ねて保持
  // VIX ≥ 30: 既存スイングも強制決済（ギャップダウンでSLが機能しないリスク）
  const todayVix = todayAssessmentForStrategy?.vix != null
    ? Number(todayAssessmentForStrategy.vix)
    : null;

  if (todayVix != null && todayVix >= STRATEGY_SWITCHING.VIX_SWING_FORCE_CLOSE_THRESHOLD) {
    console.log(`[1b/5] VIX ${todayVix.toFixed(1)} ≥ ${STRATEGY_SWITCHING.VIX_SWING_FORCE_CLOSE_THRESHOLD}: スイングポジション強制決済...`);
    const swingPositions = await prisma.tradingPosition.findMany({
      where: { status: "open", strategy: "swing" },
      include: { stock: true },
    });
    if (swingPositions.length > 0) {
      console.log(`  ${swingPositions.length}件のスイングポジションを決済`);
      await forceClosePositions(swingPositions, "VIX高騰オーバーナイトリスク回避");
    } else {
      console.log("  対象なし");
    }
  } else {
    console.log(`[1b/5] VIX ${todayVix?.toFixed(1) ?? "N/A"}: スイングポジション保持`);
  }

  // 2. 期限切れ注文のキャンセル
  console.log("[2/5] 期限切れ注文キャンセル...");
  const expiredCount = await expireOrders();
  console.log(`  ${expiredCount}件キャンセル`);

  // 当日の未約定注文もキャンセル（翌朝order-managerが最新データで再作成する）
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

  // 4. AIレビュー
  console.log("[4/5] AI日次レビュー生成...");
  let aiReview = "";

  // エントリー情報
  let entryContext = "";
  if (filledBuyOrders.length > 0) {
    entryContext += `\n【本日のエントリー】\n`;
    entryContext += `- 新規買い約定: ${filledBuyOrders.length}件\n`;
    for (const order of filledBuyOrders) {
      entryContext += `  - ${order.stock.tickerCode} ${order.stock.name}: ¥${Number(order.filledPrice).toLocaleString()} × ${order.quantity}株\n`;
    }
  }

  // 決済0件かつエントリー0件の場合、見送り理由のコンテキストを収集
  let noTradeContext = "";
  if (totalTrades === 0 && filledBuyOrders.length === 0) {
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
      if (marketHalted > 0) noTradeContext += `- 取引見送り(シャドウ): ${marketHalted}件\n`;

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
    const openai = getTracedOpenAIClient({
      generationName: "eod-review",
      tags: ["review", "daily"],
    });
    let reviewInstruction: string;
    if (totalTrades === 0 && filledBuyOrders.length === 0) {
      reviewInstruction = "取引が行われなかった理由を具体的に説明し、明日への改善ポイントを述べてください。";
    } else if (totalTrades === 0 && filledBuyOrders.length > 0) {
      reviewInstruction = "新規エントリーがあったがまだ決済はない状況です。エントリーの評価と今後の見通しを述べてください。";
    } else {
      reviewInstruction = "今日の結果の要約と明日への改善ポイントを述べてください。";
    }

    const reviewPrompt = `本日の日本株自動売買シミュレーションの日次レビューを簡潔に生成してください。

【本日の結果】
- 決済数: ${totalTrades}件
- 勝敗: ${wins}勝 ${losses}敗
- 確定損益: ¥${totalPnl.toLocaleString()}
- 新規エントリー: ${filledBuyOrders.length}件
- ポートフォリオ時価: ¥${portfolioValue.toLocaleString()}
- 現金残高: ¥${cashBalance.toLocaleString()}
- 残ポジション数: ${openPositions.length}件
${entryContext}${noTradeContext}
${reviewInstruction}
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
    .finally(async () => {
      await flushLangfuse();
      await prisma.$disconnect();
    });
}
