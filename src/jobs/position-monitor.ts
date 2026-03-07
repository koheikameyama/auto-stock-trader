/**
 * ポジションモニター（9:20〜15:19 / 毎分）
 *
 * 1. pending注文の約定チェック
 * 2. 約定した買い注文 → ポジションをオープン + 利確/損切り注文を作成
 * 3. openポジションの利確・損切り約定チェック
 * 4. デイトレポジションのタイムストップ（14:50以降は強制決済）
 * 5. Slackに約定・損益通知
 */

import { prisma } from "../lib/prisma";
import { TRADING_SCHEDULE, POSITION_DEFAULTS } from "../lib/constants";
import { fetchStockQuote } from "../core/market-data";
import {
  checkOrderFill,
  fillOrder,
  getPendingOrders,
  expireOrders,
} from "../core/order-executor";
import {
  openPosition,
  closePosition,
  getOpenPositions,
  getUnrealizedPnl,
} from "../core/position-manager";
import { notifyOrderFilled, notifyRiskAlert } from "../lib/slack";
import type { ExitSnapshot } from "../types/snapshots";
import dayjs from "dayjs";

export async function main() {
  console.log("=== Position Monitor 開始 ===");

  // 1. 期限切れ注文をキャンセル
  const expiredCount = await expireOrders();
  if (expiredCount > 0) {
    console.log(`  期限切れ注文キャンセル: ${expiredCount}件`);
  }

  // 2. pending注文の約定チェック
  console.log("[1/3] 未約定注文の約定チェック...");
  const pendingOrders = await getPendingOrders();
  console.log(`  未約定注文: ${pendingOrders.length}件`);

  for (const order of pendingOrders) {
    const quote = await fetchStockQuote(order.stock.tickerCode);
    if (!quote) {
      console.log(`  → ${order.stock.tickerCode}: 株価取得失敗`);
      continue;
    }

    const filledPrice = checkOrderFill(order, quote.high, quote.low);

    if (filledPrice !== null) {
      console.log(
        `  → ${order.stock.tickerCode}: 約定! ¥${filledPrice.toLocaleString()} (${order.side})`,
      );

      // 注文を約定済みに更新
      await fillOrder(order.id, filledPrice);

      if (order.side === "buy") {
        // 買い約定 → ポジションをオープン
        // 元の選定データから利確/損切り価格を取得
        const todayAssessment = await prisma.marketAssessment.findFirst({
          where: { shouldTrade: true },
          orderBy: { date: "desc" },
        });

        let takeProfitPrice = 0;
        let stopLossPrice = 0;

        if (todayAssessment?.selectedStocks) {
          const selections = todayAssessment.selectedStocks as Array<{
            tickerCode: string;
            takeProfitPrice?: number;
            stopLossPrice?: number;
          }>;
          const sel = selections.find(
            (s) => s.tickerCode === order.stock.tickerCode,
          );
          takeProfitPrice = sel?.takeProfitPrice ?? filledPrice * POSITION_DEFAULTS.TAKE_PROFIT_RATIO;
          stopLossPrice = sel?.stopLossPrice ?? filledPrice * POSITION_DEFAULTS.STOP_LOSS_RATIO;
        } else {
          takeProfitPrice = filledPrice * POSITION_DEFAULTS.TAKE_PROFIT_RATIO;
          stopLossPrice = filledPrice * POSITION_DEFAULTS.STOP_LOSS_RATIO;
        }

        // 約定した注文からエントリースナップショットを取得
        const filledOrder = await prisma.tradingOrder.findUnique({
          where: { id: order.id },
          select: { entrySnapshot: true },
        });

        const position = await openPosition(
          order.stockId,
          order.strategy,
          filledPrice,
          order.quantity,
          takeProfitPrice,
          stopLossPrice,
          filledOrder?.entrySnapshot as object | undefined,
        );

        // ポジションIDを注文に紐付け
        await prisma.tradingOrder.update({
          where: { id: order.id },
          data: { positionId: position.id },
        });

        await notifyOrderFilled({
          tickerCode: order.stock.tickerCode,
          name: order.stock.name,
          side: "buy",
          filledPrice,
          quantity: order.quantity,
        });
      } else {
        // 売り約定通知
        const pnl = order.positionId
          ? await calculatePnlForOrder(order.positionId, filledPrice)
          : undefined;

        await notifyOrderFilled({
          tickerCode: order.stock.tickerCode,
          name: order.stock.name,
          side: "sell",
          filledPrice,
          quantity: order.quantity,
          pnl,
        });
      }
    }
  }

  // 3. openポジションの利確・損切りチェック
  console.log("[2/3] ポジション利確/損切りチェック...");
  const openPositions = await getOpenPositions();
  console.log(`  オープンポジション: ${openPositions.length}件`);

  for (const position of openPositions) {
    const quote = await fetchStockQuote(position.stock.tickerCode);
    if (!quote) continue;

    const takeProfitPrice = position.takeProfitPrice
      ? Number(position.takeProfitPrice)
      : null;
    const stopLossPrice = position.stopLossPrice
      ? Number(position.stopLossPrice)
      : null;

    let exitPrice: number | null = null;
    let exitReason = "";

    // 利確チェック
    if (takeProfitPrice && quote.high >= takeProfitPrice) {
      exitPrice = takeProfitPrice;
      exitReason = "利確";
    }

    // 損切りチェック（利確より優先）
    if (stopLossPrice && quote.low <= stopLossPrice) {
      exitPrice = stopLossPrice;
      exitReason = "損切り";
    }

    if (exitPrice !== null) {
      console.log(
        `  → ${position.stock.tickerCode}: ${exitReason}! ¥${exitPrice.toLocaleString()}`,
      );

      // exitSnapshot構築
      const entryPriceNum = Number(position.entryPrice);
      const maxHigh = position.maxHighDuringHold
        ? Math.max(Number(position.maxHighDuringHold), quote.high)
        : quote.high;
      const minLow = position.minLowDuringHold
        ? Math.min(Number(position.minLowDuringHold), quote.low)
        : quote.low;

      const latestAssessment = await prisma.marketAssessment.findFirst({
        orderBy: { date: "desc" },
        select: { sentiment: true, reasoning: true },
      });

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
        marketContext: latestAssessment
          ? {
              sentiment: latestAssessment.sentiment,
              reasoning: latestAssessment.reasoning.slice(0, 500),
            }
          : null,
      };

      const closedPosition = await closePosition(
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
        pnl: closedPosition.realizedPnl
          ? Number(closedPosition.realizedPnl)
          : 0,
      });
    } else {
      // maxHigh/minLow を更新
      const newMaxHigh = position.maxHighDuringHold
        ? Math.max(Number(position.maxHighDuringHold), quote.high)
        : quote.high;
      const newMinLow = position.minLowDuringHold
        ? Math.min(Number(position.minLowDuringHold), quote.low)
        : quote.low;

      if (
        newMaxHigh !== Number(position.maxHighDuringHold) ||
        newMinLow !== Number(position.minLowDuringHold)
      ) {
        await prisma.tradingPosition.update({
          where: { id: position.id },
          data: {
            maxHighDuringHold: newMaxHigh,
            minLowDuringHold: newMinLow,
          },
        });
      }

      // 含み損益表示
      const unrealized = getUnrealizedPnl(position, quote.price);
      console.log(
        `  → ${position.stock.tickerCode}: 含み損益 ¥${unrealized.toLocaleString()}`,
      );
    }
  }

  // 4. デイトレ強制決済チェック
  console.log("[3/3] デイトレ強制決済チェック...");
  const now = dayjs();
  const forceExitHour = TRADING_SCHEDULE.DAY_TRADE_FORCE_EXIT.hour;
  const forceExitMinute = TRADING_SCHEDULE.DAY_TRADE_FORCE_EXIT.minute;

  if (
    now.hour() > forceExitHour ||
    (now.hour() === forceExitHour && now.minute() >= forceExitMinute)
  ) {
    const dayTradePositions = openPositions.filter(
      (p) => p.strategy === "day_trade",
    );

    for (const position of dayTradePositions) {
      const quote = await fetchStockQuote(position.stock.tickerCode);
      if (!quote) continue;

      console.log(
        `  → ${position.stock.tickerCode}: デイトレ強制決済 @ ¥${quote.price.toLocaleString()}`,
      );

      // exitSnapshot構築
      const entryPriceNum = Number(position.entryPrice);
      const maxHigh = position.maxHighDuringHold
        ? Math.max(Number(position.maxHighDuringHold), quote.high)
        : quote.high;
      const minLow = position.minLowDuringHold
        ? Math.min(Number(position.minLowDuringHold), quote.low)
        : quote.low;

      const exitSnapshot: ExitSnapshot = {
        exitReason: "デイトレ強制決済",
        exitPrice: quote.price,
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
        quote.price,
        exitSnapshot as object,
      );

      await notifyOrderFilled({
        tickerCode: position.stock.tickerCode,
        name: position.stock.name,
        side: "sell",
        filledPrice: quote.price,
        quantity: position.quantity,
        pnl: closed.realizedPnl ? Number(closed.realizedPnl) : 0,
      });
    }

    if (dayTradePositions.length > 0) {
      await notifyRiskAlert({
        type: "デイトレ強制決済",
        message: `${dayTradePositions.length}件のデイトレポジションを強制決済しました`,
      });
    }
  }

  console.log("=== Position Monitor 終了 ===");
}

async function calculatePnlForOrder(
  positionId: string,
  filledPrice: number,
): Promise<number> {
  const position = await prisma.tradingPosition.findUnique({
    where: { id: positionId },
  });
  if (!position) return 0;
  return (filledPrice - Number(position.entryPrice)) * position.quantity;
}

const isDirectRun = process.argv[1]?.includes("position-monitor");
if (isDirectRun) {
  main()
    .catch((error) => {
      console.error("Position Monitor エラー:", error);
      process.exit(1);
    })
    .finally(() => prisma.$disconnect());
}
