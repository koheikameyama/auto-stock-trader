/**
 * 日次締め処理（15:50 JST / 平日）
 *
 * 1a. デイトレ未決済ポジションの強制決済
 * 1b. VIX高騰時（≥30）のスイングポジション強制決済（オーバーナイトリスク回避）
 * 2. 期限切れ注文のキャンセル
 * 3. TradingDailySummary 作成
 * 4. 日次サマリー生成
 * 5. Slackに日次レポート送信
 */

import { prisma } from "../lib/prisma";
import { getTodayForDB, getStartOfDayJST, getEndOfDayJST } from "../lib/date-utils";
import { STRATEGY_SWITCHING } from "../lib/constants";
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
  const _todayStrategy = (todayAssessmentForStrategy as Record<string, unknown> | null)?.tradingStrategy as string | null;

  // 1a. デイトレ未決済ポジションの強制決済
  console.log("[1a/5] デイトレ未決済ポジション強制決済...");
  const dayTradePositions = await prisma.tradingPosition.findMany({
    where: { status: "open", strategy: "day_trade" },
    include: { stock: true },
  });
  await forceClosePositions(dayTradePositions, "EOD強制決済");

  // 1b. VIX高騰時のswing/breakoutポジション強制決済（オーバーナイトリスク回避）
  // VIX 25-30: 新規エントリーのみデイトレ化、既存ポジションはSLに委ねて保持
  // VIX ≥ 30: 既存swing/breakoutも強制決済（ギャップダウンでSLが機能しないリスク）
  const todayVix = todayAssessmentForStrategy?.vix != null
    ? Number(todayAssessmentForStrategy.vix)
    : null;

  if (todayVix != null && todayVix >= STRATEGY_SWITCHING.VIX_SWING_FORCE_CLOSE_THRESHOLD) {
    console.log(`[1b/5] VIX ${todayVix.toFixed(1)} ≥ ${STRATEGY_SWITCHING.VIX_SWING_FORCE_CLOSE_THRESHOLD}: swing/breakoutポジション強制決済...`);
    const overnightPositions = await prisma.tradingPosition.findMany({
      where: { status: "open", strategy: { in: ["swing", "breakout"] } },
      include: { stock: true },
    });
    if (overnightPositions.length > 0) {
      console.log(`  ${overnightPositions.length}件のswing/breakoutポジションを決済`);
      await forceClosePositions(overnightPositions, "VIX高騰オーバーナイトリスク回避");
    } else {
      console.log("  対象なし");
    }
  } else {
    console.log(`[1b/5] VIX ${todayVix?.toFixed(1) ?? "N/A"}: swing/breakoutポジション保持`);
  }

  // 1c. crisis時のbreakoutポジション強制決済
  // swingはday_tradeに変換済みで1aで決済されるが、breakoutはstrategyを変えないためここで決済
  const todaySentiment = todayAssessmentForStrategy?.sentiment as string | null;
  if (todaySentiment === "crisis") {
    console.log(`[1c/5] センチメント「${todaySentiment}」: breakoutポジション強制決済...`);
    const breakoutPositions = await prisma.tradingPosition.findMany({
      where: { status: "open", strategy: "breakout" },
      include: { stock: true },
    });
    if (breakoutPositions.length > 0) {
      console.log(`  ${breakoutPositions.length}件のbreakoutポジションを決済`);
      await forceClosePositions(breakoutPositions, `${todaySentiment}環境オーバーナイトリスク回避`);
    } else {
      console.log("  対象なし");
    }
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

  // 4. 日次サマリー生成
  console.log("[4/5] 日次サマリー生成...");
  let aiReview = "";
  if (totalTrades > 0) {
    const winRate = ((wins / totalTrades) * 100).toFixed(0);
    aiReview = `${totalTrades}件決済(${wins}勝${losses}敗, 勝率${winRate}%), 損益¥${totalPnl.toLocaleString()}, PF時価¥${portfolioValue.toLocaleString()}`;
  } else if (filledBuyOrders.length > 0) {
    aiReview = `新規${filledBuyOrders.length}件エントリー, 未決済, PF時価¥${portfolioValue.toLocaleString()}`;
  } else {
    aiReview = `取引なし, PF時価¥${portfolioValue.toLocaleString()}, 現金¥${cashBalance.toLocaleString()}`;
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
      await prisma.$disconnect();
    });
}
