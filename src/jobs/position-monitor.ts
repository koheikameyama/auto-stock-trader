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
import {
  TRADING_SCHEDULE,
  POSITION_DEFAULTS,
  DEFENSIVE_MODE,
  TIME_STOP,
} from "../lib/constants";
import { fetchStockQuote } from "../core/market-data";
import {
  checkOrderFill,
  fillOrder,
  getPendingOrders,
  expireOrders,
} from "../core/order-executor";
import { checkTimeWindow } from "../core/time-filter";
import {
  openPosition,
  closePosition,
  getOpenPositions,
  getUnrealizedPnl,
} from "../core/position-manager";
import { calculateTrailingStop } from "../core/trailing-stop";
import { notifyOrderFilled, notifyRiskAlert } from "../lib/slack";
import type { ExitSnapshot } from "../types/snapshots";
import dayjs from "dayjs";
import utc from "dayjs/plugin/utc";
import timezone from "dayjs/plugin/timezone";

dayjs.extend(utc);
dayjs.extend(timezone);

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

    const filledPrice = checkOrderFill(order, quote.high, quote.low, quote.open);

    if (filledPrice !== null) {
      // 買い注文: 時間帯チェック（デイトレ14:30以降は約定をスキップ）
      if (order.side === "buy") {
        const timeCheck = checkTimeWindow(
          order.strategy as "day_trade" | "swing",
        );
        if (!timeCheck.canTrade) {
          console.log(
            `  → ${order.stock.tickerCode}: ${timeCheck.reason}のためスキップ`,
          );
          await prisma.tradingOrder.update({
            where: { id: order.id },
            data: { status: "cancelled" },
          });
          continue;
        }
      }

      console.log(
        `  → ${order.stock.tickerCode}: 約定! ¥${filledPrice.toLocaleString()} (${order.side})`,
      );

      // 注文を約定済みに更新
      await fillOrder(order.id, filledPrice);

      if (order.side === "buy") {
        // 買い約定 → ポジションをオープン
        // 時間帯リスクフラグを判定
        const timeCheck = checkTimeWindow(
          order.strategy as "day_trade" | "swing",
        );

        // 注文レコードから利確/損切り価格を取得
        const filledOrder = await prisma.tradingOrder.findUnique({
          where: { id: order.id },
          select: { entrySnapshot: true, takeProfitPrice: true, stopLossPrice: true },
        });

        const takeProfitPrice = filledOrder?.takeProfitPrice
          ? Number(filledOrder.takeProfitPrice)
          : filledPrice * POSITION_DEFAULTS.TAKE_PROFIT_RATIO;
        const stopLossPrice = filledOrder?.stopLossPrice
          ? Number(filledOrder.stopLossPrice)
          : filledPrice * POSITION_DEFAULTS.STOP_LOSS_RATIO;

        const entryAtr = extractAtrFromSnapshot(
          filledOrder?.entrySnapshot,
        );

        // 寄付き直後の約定にはリスクフラグを付与
        const entrySnapshot = filledOrder?.entrySnapshot as object | undefined;
        const snapshotWithTimeRisk =
          timeCheck.isOpeningVolatility && entrySnapshot
            ? { ...entrySnapshot, timeWindowRisk: "opening_volatility" }
            : entrySnapshot;

        const position = await openPosition(
          order.stockId,
          order.strategy,
          filledPrice,
          order.quantity,
          takeProfitPrice,
          stopLossPrice,
          snapshotWithTimeRisk,
          entryAtr,
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

    const entryPriceNum = Number(position.entryPrice);

    // maxHigh/minLow を exit チェック前に更新（トレーリングストップで最新値を使うため）
    const newMaxHigh = position.maxHighDuringHold
      ? Math.max(Number(position.maxHighDuringHold), quote.high)
      : quote.high;
    const newMinLow = position.minLowDuringHold
      ? Math.min(Number(position.minLowDuringHold), quote.low)
      : quote.low;

    // トレーリングストップ算出
    const originalTP = position.takeProfitPrice
      ? Number(position.takeProfitPrice)
      : entryPriceNum * POSITION_DEFAULTS.TAKE_PROFIT_RATIO;
    const originalSL = position.stopLossPrice
      ? Number(position.stopLossPrice)
      : entryPriceNum * POSITION_DEFAULTS.STOP_LOSS_RATIO;
    const entryAtr = position.entryAtr
      ? Number(position.entryAtr)
      : extractAtrFromSnapshot(position.entrySnapshot);

    const trailingResult = calculateTrailingStop({
      entryPrice: entryPriceNum,
      maxHighDuringHold: newMaxHigh,
      currentTrailingStop: position.trailingStopPrice
        ? Number(position.trailingStopPrice)
        : null,
      originalStopLoss: originalSL,
      originalTakeProfit: originalTP,
      entryAtr,
      strategy: position.strategy as "day_trade" | "swing",
    });

    const effectiveTP = trailingResult.effectiveTakeProfit;
    const effectiveSL = trailingResult.effectiveStopLoss;

    let exitPrice: number | null = null;
    let exitReason = "";

    // 利確チェック（トレーリング発動中は effectiveTP = null なのでスキップ）
    if (effectiveTP !== null && quote.high >= effectiveTP) {
      // ギャップアップで利確ラインを突き抜けた場合、寄り付き値で約定
      exitPrice =
        quote.open > effectiveTP ? quote.open : effectiveTP;
      exitReason = "利確";
    }

    // 損切り / トレーリングストップチェック（利確より優先）
    if (quote.low <= effectiveSL) {
      // ギャップダウンでSLを突き抜けた場合、寄り付き値で約定（スリッページ反映）
      exitPrice =
        quote.open < effectiveSL ? quote.open : effectiveSL;
      exitReason = trailingResult.isActivated ? "トレーリング利確" : "損切り";
    }

    // タイムストップ: 最大保有日数超過で強制決済（スイングのみ）
    if (exitPrice === null && position.strategy !== "day_trade") {
      const entryDate = dayjs(position.createdAt).tz("Asia/Tokyo");
      const now = dayjs().tz("Asia/Tokyo");
      let businessDays = 0;
      let d = entryDate.add(1, "day");
      while (d.isBefore(now, "day") || d.isSame(now, "day")) {
        const dow = d.day();
        if (dow !== 0 && dow !== 6) businessDays++;
        d = d.add(1, "day");
      }
      if (businessDays >= TIME_STOP.MAX_HOLDING_DAYS) {
        exitReason = "タイムストップ";
        exitPrice = quote.price;
      }
    }

    if (exitPrice !== null) {
      console.log(
        `  → ${position.stock.tickerCode}: ${exitReason}! ¥${exitPrice.toLocaleString()} (${trailingResult.reason})`,
      );

      const latestAssessment = await prisma.marketAssessment.findFirst({
        orderBy: { date: "desc" },
        select: { sentiment: true, reasoning: true },
      });

      const exitSnapshot: ExitSnapshot = {
        exitReason,
        exitPrice,
        priceJourney: {
          maxHigh: newMaxHigh,
          minLow: newMinLow,
          maxFavorableExcursion:
            ((newMaxHigh - entryPriceNum) / entryPriceNum) * 100,
          maxAdverseExcursion:
            ((entryPriceNum - newMinLow) / entryPriceNum) * 100,
        },
        trailingStop: {
          wasActivated: trailingResult.isActivated,
          finalTrailingStopPrice: trailingResult.trailingStopPrice,
          entryAtr,
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
      // maxHigh/minLow/trailingStopPrice を更新
      const updateData: Record<string, number | null> = {};

      if (newMaxHigh !== Number(position.maxHighDuringHold)) {
        updateData.maxHighDuringHold = newMaxHigh;
      }
      if (newMinLow !== Number(position.minLowDuringHold)) {
        updateData.minLowDuringHold = newMinLow;
      }
      const currentTrailing = position.trailingStopPrice
        ? Number(position.trailingStopPrice)
        : null;
      if (trailingResult.trailingStopPrice !== currentTrailing) {
        updateData.trailingStopPrice = trailingResult.trailingStopPrice;
      }

      if (Object.keys(updateData).length > 0) {
        await prisma.tradingPosition.update({
          where: { id: position.id },
          data: updateData,
        });
      }

      // 含み損益表示
      const unrealized = getUnrealizedPnl(position, quote.price);
      console.log(
        `  → ${position.stock.tickerCode}: 含み損益 ¥${unrealized.toLocaleString()} ${trailingResult.reason}`,
      );
    }
  }

  // 3.5. ディフェンシブモード（bearish/crisis時のポジション防衛）
  console.log("[2.5/3] ディフェンシブモード判定...");
  const latestAssessmentForDefense = await prisma.marketAssessment.findFirst({
    orderBy: { date: "desc" },
    select: { sentiment: true, reasoning: true },
  });

  const currentSentiment = latestAssessmentForDefense?.sentiment;
  const isDefensiveMode =
    currentSentiment != null &&
    DEFENSIVE_MODE.ENABLED_SENTIMENTS.includes(currentSentiment);

  if (isDefensiveMode) {
    const isCrisis = currentSentiment === "crisis";
    console.log(`  → ディフェンシブモード発動: ${currentSentiment}`);

    // TP/SLで決済済みを除外した残存ポジションを取得
    const remainingPositions = await getOpenPositions();
    let defensiveCloseCount = 0;

    for (const position of remainingPositions) {
      const quote = await fetchStockQuote(position.stock.tickerCode);
      if (!quote) continue;

      const entryPriceNum = Number(position.entryPrice);
      const currentProfitPct =
        ((quote.price - entryPriceNum) / entryPriceNum) * 100;

      let shouldDefensiveClose = false;
      let defensiveReason = "";

      if (isCrisis) {
        // crisis: 全ポジション即時決済（資本防衛）
        shouldDefensiveClose = true;
        defensiveReason = `crisis全ポジション即時決済（含み損益: ${currentProfitPct >= 0 ? "+" : ""}${currentProfitPct.toFixed(2)}%）`;
      } else if (
        currentProfitPct >= DEFENSIVE_MODE.MIN_PROFIT_PCT_FOR_RETREAT
      ) {
        // bearish: 含み益ポジションのみ決済（利益確保）
        shouldDefensiveClose = true;
        defensiveReason = `bearish微益撤退（含み益 +${currentProfitPct.toFixed(2)}%）`;
      }

      if (shouldDefensiveClose) {
        const maxHigh = position.maxHighDuringHold
          ? Math.max(Number(position.maxHighDuringHold), quote.high)
          : quote.high;
        const minLow = position.minLowDuringHold
          ? Math.min(Number(position.minLowDuringHold), quote.low)
          : quote.low;

        const exitSnapshot: ExitSnapshot = {
          exitReason: defensiveReason,
          exitPrice: quote.price,
          priceJourney: {
            maxHigh,
            minLow,
            maxFavorableExcursion:
              ((maxHigh - entryPriceNum) / entryPriceNum) * 100,
            maxAdverseExcursion:
              ((entryPriceNum - minLow) / entryPriceNum) * 100,
          },
          marketContext: latestAssessmentForDefense
            ? {
                sentiment: latestAssessmentForDefense.sentiment,
                reasoning: latestAssessmentForDefense.reasoning.slice(0, 500),
              }
            : null,
        };

        console.log(
          `  → ${position.stock.tickerCode}: ${defensiveReason} @ ¥${quote.price.toLocaleString()}`,
        );

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

        defensiveCloseCount++;
      } else {
        console.log(
          `  → ${position.stock.tickerCode}: bearish維持（含み損益 ${currentProfitPct.toFixed(2)}% → 通常SL監視継続）`,
        );
      }
    }

    if (defensiveCloseCount > 0) {
      await notifyRiskAlert({
        type: `ディフェンシブモード（${currentSentiment}）`,
        message: `${defensiveCloseCount}件のポジションを防衛決済しました`,
      });
    }
  } else {
    console.log(
      `  → ディフェンシブモード: OFF（sentiment: ${currentSentiment ?? "不明"}）`,
    );
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

/**
 * entrySnapshot JSON から atr14 を抽出する
 */
function extractAtrFromSnapshot(snapshot: unknown): number | null {
  if (!snapshot || typeof snapshot !== "object") return null;
  const s = snapshot as Record<string, unknown>;
  const technicals = s.technicals as Record<string, unknown> | undefined;
  return technicals?.atr14 != null ? Number(technicals.atr14) : null;
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
