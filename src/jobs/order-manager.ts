/**
 * 注文マネージャー（9:00 JST / 平日）
 *
 * 1. 今日のMarketAssessmentを確認（shouldTrade = true のみ）
 * 2. 選定済み銘柄に対してAI売買判断
 * 3. リスクチェック
 * 4. TradingOrder作成（pending状態）
 * 5. Slackに注文内容を通知
 */

import { prisma } from "../lib/prisma";
import { getTodayForDB } from "../lib/date-utils";
import { TRADING_SCHEDULE } from "../lib/constants";
import { fetchStockQuote, fetchHistoricalData } from "../core/market-data";
import { analyzeTechnicals, formatTechnicalForAI } from "../core/technical-analysis";
import { decideTrade } from "../core/ai-decision";
import type { MarketAssessmentResult, PositionInput } from "../core/ai-decision";
import { canOpenPosition } from "../core/risk-manager";
import { getOpenPositions, getCashBalance } from "../core/position-manager";
import { notifyOrderPlaced, notifyRiskAlert } from "../lib/slack";
import { getSectorGroup } from "../lib/constants";
import dayjs from "dayjs";

export async function main() {
  console.log("=== Order Manager 開始 ===");

  // 1. 今日のMarketAssessmentを取得
  const todayAssessment = await prisma.marketAssessment.findUnique({
    where: { date: getTodayForDB() },
  });

  if (!todayAssessment) {
    console.log("今日のMarketAssessmentがありません。market-scannerを先に実行してください。");
    return;
  }

  if (!todayAssessment.shouldTrade) {
    console.log("今日は取引見送りです。");
    return;
  }

  const selectedStocks = todayAssessment.selectedStocks as Array<{
    tickerCode: string;
    strategy: string;
    score: number;
    reasoning: string;
  }> | null;

  if (!selectedStocks || selectedStocks.length === 0) {
    console.log("選定銘柄がありません。");
    return;
  }

  // 2. 現在のポジション・残高を取得
  const openPositions = await getOpenPositions();
  const cashBalance = await getCashBalance();

  const currentPositions: PositionInput[] = openPositions.map((p) => ({
    tickerCode: p.stock.tickerCode,
    quantity: p.quantity,
    averagePrice: Number(p.entryPrice),
    strategy: p.strategy as "day_trade" | "swing",
  }));

  const assessment: MarketAssessmentResult = {
    shouldTrade: todayAssessment.shouldTrade,
    sentiment: todayAssessment.sentiment as MarketAssessmentResult["sentiment"],
    reasoning: todayAssessment.reasoning,
  };

  console.log(`  選定銘柄数: ${selectedStocks.length}, 現金残高: ¥${cashBalance.toLocaleString()}`);

  // 3. 各銘柄に対してAI売買判断
  let ordersCreated = 0;

  for (const selected of selectedStocks) {
    console.log(`\n  [${selected.tickerCode}] 売買判断中...`);

    // 銘柄データ取得
    const stock = await prisma.stock.findUnique({
      where: { tickerCode: selected.tickerCode },
    });
    if (!stock) {
      console.log(`    → 銘柄マスタに存在しません: ${selected.tickerCode}`);
      continue;
    }

    const quote = await fetchStockQuote(stock.tickerCode);
    if (!quote) {
      console.log(`    → 株価取得失敗: ${stock.tickerCode}`);
      continue;
    }

    // テクニカル分析
    const historical = await fetchHistoricalData(stock.tickerCode);
    if (!historical || historical.length < 15) {
      console.log(`    → ヒストリカルデータ不足: ${stock.tickerCode}`);
      continue;
    }

    const techSummary = analyzeTechnicals(historical);
    const techFormatted = formatTechnicalForAI(techSummary);

    // AI売買判断
    const decision = await decideTrade(
      {
        tickerCode: stock.tickerCode,
        name: stock.name,
        price: quote.price,
        open: quote.open,
        high: quote.high,
        low: quote.low,
        previousClose: quote.previousClose,
        changePercent: quote.changePercent,
        sector: getSectorGroup(stock.sector) ?? stock.sector ?? "不明",
        technicalSummary: techFormatted,
      },
      assessment,
      cashBalance,
      currentPositions,
    );

    console.log(`    → action: ${decision.action}, strategy: ${decision.strategy}`);

    if (decision.action === "skip") {
      console.log(`    → スキップ: ${decision.reasoning}`);
      continue;
    }

    // リスクチェック
    const riskCheck = await canOpenPosition(
      stock.id,
      decision.quantity,
      decision.limitPrice ?? quote.price,
    );

    if (!riskCheck.allowed) {
      console.log(`    → リスクチェック不可: ${riskCheck.reason}`);
      await notifyRiskAlert({
        type: "注文制限",
        message: `${stock.tickerCode} ${stock.name}: ${riskCheck.reason}`,
      });
      continue;
    }

    // 注文有効期限設定
    const now = dayjs();
    let expiresAt: Date;

    if (decision.strategy === "day_trade") {
      // デイトレ: 当日14:30まで
      expiresAt = now
        .hour(TRADING_SCHEDULE.DAY_TRADE_FORCE_EXIT.hour)
        .minute(TRADING_SCHEDULE.DAY_TRADE_FORCE_EXIT.minute)
        .second(0)
        .toDate();
    } else {
      // スイング: 3営業日
      expiresAt = now.add(3, "day").hour(15).minute(0).second(0).toDate();
    }

    // TradingOrder作成
    await prisma.tradingOrder.create({
      data: {
        stockId: stock.id,
        side: "buy",
        orderType: "limit",
        strategy: decision.strategy,
        limitPrice: decision.limitPrice,
        quantity: decision.quantity,
        status: "pending",
        reasoning: decision.reasoning,
        expiresAt,
      },
    });

    ordersCreated++;

    // Slack通知
    await notifyOrderPlaced({
      tickerCode: stock.tickerCode,
      name: stock.name,
      side: "buy",
      strategy: decision.strategy,
      limitPrice: decision.limitPrice ?? quote.price,
      takeProfitPrice: decision.takeProfitPrice ?? undefined,
      stopLossPrice: decision.stopLossPrice ?? undefined,
      quantity: decision.quantity,
      reasoning: decision.reasoning,
    });
  }

  console.log(`\n  注文作成数: ${ordersCreated}`);
  console.log("=== Order Manager 終了 ===");
}

const isDirectRun = process.argv[1]?.includes("order-manager");
if (isDirectRun) {
  main()
    .catch((error) => {
      console.error("Order Manager エラー:", error);
      process.exit(1);
    })
    .finally(() => prisma.$disconnect());
}
