/**
 * ポジションモニター（9:20〜15:19 / 毎分）
 *
 * 1. pending注文の約定チェック
 * 2. 約定した買い注文 → ポジションをオープン + 利確/損切り注文を作成
 * 3. openポジションの利確・損切り約定チェック
 * 4. デイトレポジションのタイムストップ（14:50以降は強制決済）
 * 5. Slackに約定・損益通知
 */

import { Prisma } from "@prisma/client";
import { prisma } from "../lib/prisma";
import {
  TRADING_SCHEDULE,
  POSITION_DEFAULTS,
  DEFENSIVE_MODE,
  WEEKEND_RISK,
  TRAILING_STOP,
  SCORING,
} from "../lib/constants";
import { validateStopLoss } from "../core/risk-manager";
import { fetchStockQuote } from "../core/market-data";
import { countNonTradingDaysAhead } from "../lib/market-calendar";
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
  getCashBalance,
} from "../core/position-manager";
import { checkPositionExit } from "../core/exit-checker";
import type { ExitReason } from "../core/exit-checker";
import {
  adjustForExDividend,
  adjustForSplit,
  parseSplitFactor,
} from "../core/corporate-event-handler";
import { fetchCorporateEvents } from "../core/market-data";
import { notifyOrderFilled, notifyRiskAlert } from "../lib/slack";
import { syncBrokerOrderStatuses } from "../core/broker-orders";
import type { ExitSnapshot } from "../types/snapshots";
import type { TradingStrategy } from "../core/market-regime";
import dayjs from "dayjs";
import utc from "dayjs/plugin/utc";
import timezone from "dayjs/plugin/timezone";

dayjs.extend(utc);
dayjs.extend(timezone);

async function isSystemActive(): Promise<boolean> {
  const config = await prisma.tradingConfig.findFirst({
    orderBy: { createdAt: "desc" },
  });
  return !config || config.isActive;
}

export async function main() {
  console.log("=== Position Monitor 開始 ===");

  // システム停止チェック（実行中でも即座に停止）
  if (!(await isSystemActive())) {
    console.log("  → システム停止中のため終了");
    return;
  }

  // 0. ブローカー注文ステータス同期（Phase 1: 情報取得のみ）
  try {
    await syncBrokerOrderStatuses();
  } catch (e) {
    console.warn("[position-monitor] Broker sync error (ignored):", e);
  }

  // 1. 期限切れ注文をキャンセル
  const expiredCount = await expireOrders();
  if (expiredCount > 0) {
    console.log(`  期限切れ注文キャンセル: ${expiredCount}件`);
  }

  // 2. pending注文の約定チェック
  console.log("[1/3] 未約定注文の約定チェック...");

  // ディフェンシブモード判定（買い注文の約定ブロック用）
  const latestAssessmentForBuyBlock = await prisma.marketAssessment.findFirst({
    orderBy: { date: "desc" },
    select: { sentiment: true },
  });
  const isDefensiveModeForBuy =
    latestAssessmentForBuyBlock?.sentiment != null &&
    DEFENSIVE_MODE.ENABLED_SENTIMENTS.includes(
      latestAssessmentForBuyBlock.sentiment,
    );

  const pendingOrders = await getPendingOrders();
  console.log(`  未約定注文: ${pendingOrders.length}件`);

  // 残高チェック用（スコア順に約定させ、資金が尽きたらスキップ）
  let cashBalance = await getCashBalance();

  for (const order of pendingOrders) {
    if (!(await isSystemActive())) {
      console.log("  → システム停止中のため終了");
      return;
    }

    // 買い注文: ディフェンシブモード中はquote取得前にキャンセル（防御的二重チェック）
    if (order.side === "buy" && isDefensiveModeForBuy) {
      console.log(
        `  → ${order.stock.tickerCode}: ディフェンシブモード中のため買い注文キャンセル`,
      );
      await prisma.tradingOrder.update({
        where: { id: order.id },
        data: { status: "cancelled" },
      });
      continue;
    }

    const quote = await fetchStockQuote(order.stock.tickerCode);
    if (!quote) {
      console.log(`  → ${order.stock.tickerCode}: 株価取得失敗`);
      continue;
    }

    const filledPrice = checkOrderFill(order, quote.high, quote.low, quote.open);

    if (filledPrice !== null) {

      // 買い注文: 時間帯チェック + 残高チェック
      if (order.side === "buy") {
        const timeCheck = checkTimeWindow(
          order.strategy as TradingStrategy,
        );
        if (!timeCheck.canTrade) {
          if (timeCheck.isOpeningVolatility) {
            // 寄付き30分: 一時的な制限なのでスキップのみ（キャンセルしない）
            console.log(
              `  → ${order.stock.tickerCode}: ${timeCheck.reason}のため約定保留`,
            );
          } else {
            // デイトレ14:30以降等: エントリー窓逸失のためキャンセル
            console.log(
              `  → ${order.stock.tickerCode}: ${timeCheck.reason}のためキャンセル`,
            );
            await prisma.tradingOrder.update({
              where: { id: order.id },
              data: { status: "cancelled" },
            });
          }
          continue;
        }

        // 残高チェック: 資金不足ならスキップ（pendingのまま残す）
        const requiredAmount = filledPrice * order.quantity;
        if (cashBalance < requiredAmount) {
          console.log(
            `  → ${order.stock.tickerCode}: 残高不足でスキップ（必要: ¥${requiredAmount.toLocaleString()}, 残高: ¥${Math.floor(cashBalance).toLocaleString()}）`,
          );
          continue;
        }
      }

      console.log(
        `  → ${order.stock.tickerCode}: 約定! ¥${filledPrice.toLocaleString()} (${order.side})`,
      );

      // 注文を約定済みに更新
      await fillOrder(order.id, filledPrice);

      if (order.side === "buy") {
        // 同一銘柄のopenポジションが既にあれば約定をスキップ（多重防御）
        const existingPosition = await prisma.tradingPosition.findFirst({
          where: { stockId: order.stockId, status: "open" },
        });
        if (existingPosition) {
          console.log(
            `  → ${order.stock.tickerCode}: 同一銘柄のopenポジションあり、注文キャンセル`,
          );
          await prisma.tradingOrder.update({
            where: { id: order.id },
            data: { status: "cancelled" },
          });
          continue;
        }

        // 買い約定 → ポジションをオープン
        // 時間帯リスクフラグを判定
        const timeCheck = checkTimeWindow(
          order.strategy as TradingStrategy,
        );

        // 注文レコードから利確/損切り価格を取得
        const filledOrder = await prisma.tradingOrder.findUnique({
          where: { id: order.id },
          select: { entrySnapshot: true, takeProfitPrice: true, stopLossPrice: true },
        });

        const entryAtr = extractAtrFromSnapshot(
          filledOrder?.entrySnapshot,
        );

        // 約定価格ベースでTP/SLを再検証（指値と約定価格の乖離を補正）
        const { takeProfitPrice, stopLossPrice } = recalculateExitPrices(
          filledPrice,
          filledOrder?.takeProfitPrice ? Number(filledOrder.takeProfitPrice) : null,
          filledOrder?.stopLossPrice ? Number(filledOrder.stopLossPrice) : null,
          entryAtr,
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

        // 残高を減算（同サイクル内の後続注文に反映）
        cashBalance -= filledPrice * order.quantity;

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

  // システム停止チェック（フェーズ間で再確認）
  if (!(await isSystemActive())) {
    console.log("  → システム停止中のため終了");
    return;
  }

  // 3. openポジションの利確・損切りチェック
  console.log("[2/3] ポジション利確/損切りチェック...");
  const openPositions = await getOpenPositions();
  console.log(`  オープンポジション: ${openPositions.length}件`);

  // コーポレートイベント（配当落ち・株式分割）チェック
  await applyCorporateEventAdjustments(openPositions);

  // 連休前リスク管理: トレーリングストップ引き締め判定
  const nonTradingDays = countNonTradingDaysAhead();
  const isPreLongHoliday = nonTradingDays >= WEEKEND_RISK.TRAILING_TIGHTEN_THRESHOLD;
  if (isPreLongHoliday) {
    const tightenedMultiplier = TRAILING_STOP.TRAIL_ATR_MULTIPLIER.swing * WEEKEND_RISK.TRAILING_TIGHTEN_MULTIPLIER;
    console.log(
      `  連休前リスク管理: トレーリングストップ引き締め（ATR倍率 ${TRAILING_STOP.TRAIL_ATR_MULTIPLIER.swing} → ${tightenedMultiplier.toFixed(1)}、非営業日: ${nonTradingDays}日）`,
    );
  }

  for (const position of openPositions) {
    if (!(await isSystemActive())) {
      console.log("  → システム停止中のため終了");
      return;
    }
    const quote = await fetchStockQuote(position.stock.tickerCode);
    if (!quote) continue;

    const entryPriceNum = Number(position.entryPrice);

    // minLow を更新（出口判定には不要だがスナップショットに使用）
    const newMinLow = position.minLowDuringHold
      ? Math.min(Number(position.minLowDuringHold), quote.low)
      : quote.low;

    // 保有営業日数を算出
    const entryDate = dayjs(position.createdAt).tz("Asia/Tokyo");
    const now = dayjs().tz("Asia/Tokyo");
    let holdingBusinessDays = 0;
    let d = entryDate.add(1, "day");
    while (d.isBefore(now, "day") || d.isSame(now, "day")) {
      const dow = d.day();
      if (dow !== 0 && dow !== 6) holdingBusinessDays++;
      d = d.add(1, "day");
    }

    const entryAtr = position.entryAtr
      ? Number(position.entryAtr)
      : extractAtrFromSnapshot(position.entrySnapshot);

    // 既存ポジションのTP/SL整合性チェック（3%ルール違反を自動修正）
    const rawTP = position.takeProfitPrice
      ? Number(position.takeProfitPrice)
      : entryPriceNum * POSITION_DEFAULTS.TAKE_PROFIT_RATIO;
    const rawSL = position.stopLossPrice
      ? Number(position.stopLossPrice)
      : entryPriceNum * POSITION_DEFAULTS.STOP_LOSS_RATIO;

    const { takeProfitPrice: correctedTP, stopLossPrice: correctedSL, wasCorrected } =
      validateExistingPositionExitPrices(entryPriceNum, rawTP, rawSL, entryAtr);

    const originalTP = correctedTP;
    const originalSL = correctedSL;

    if (wasCorrected) {
      await prisma.tradingPosition.update({
        where: { id: position.id },
        data: {
          takeProfitPrice: originalTP,
          stopLossPrice: originalSL,
        },
      });
      console.log(
        `  → ${position.stock.tickerCode}: TP/SL修正（TP: ¥${rawTP} → ¥${originalTP}, SL: ¥${rawSL} → ¥${originalSL}）`,
      );
    }

    // スイングポジションのみ連休前引き締め（デイトレは当日決済のため不要）
    let trailOverride: number | undefined;
    if (position.strategy === "swing") {
      const normalTrail = TRAILING_STOP.TRAIL_ATR_MULTIPLIER.swing;
      if (isPreLongHoliday) {
        trailOverride = normalTrail * WEEKEND_RISK.TRAILING_TIGHTEN_MULTIPLIER;
      }
    }

    // 保有スコアによる引き締め（最も保守的な値を採用）
    if (position.strategy === "swing" && position.holdingScoreTrailOverride) {
      const holdingOverride = Number(position.holdingScoreTrailOverride);
      trailOverride = trailOverride
        ? Math.min(trailOverride, holdingOverride)
        : holdingOverride;
    }

    // 共通出口判定（バックテストと同一ロジック）
    const exitResult = checkPositionExit(
      {
        entryPrice: entryPriceNum,
        takeProfitPrice: originalTP,
        stopLossPrice: originalSL,
        entryAtr,
        maxHighDuringHold: position.maxHighDuringHold
          ? Number(position.maxHighDuringHold)
          : entryPriceNum,
        currentTrailingStop: position.trailingStopPrice
          ? Number(position.trailingStopPrice)
          : null,
        strategy: position.strategy as TradingStrategy,
        holdingBusinessDays,
        trailMultiplierOverride: trailOverride,
      },
      { open: quote.open, high: quote.high, low: quote.low, close: quote.price },
    );

    const newMaxHigh = exitResult.newMaxHigh;
    const exitPrice = exitResult.exitPrice;

    // 出口理由の日本語変換
    const EXIT_REASON_LABELS: Record<ExitReason, string> = {
      take_profit: "利確",
      stop_loss: "損切り",
      trailing_profit: "トレーリング利確",
      time_stop: "タイムストップ",
    };
    const exitReason = exitResult.exitReason
      ? EXIT_REASON_LABELS[exitResult.exitReason]
      : "";

    if (exitPrice !== null) {
      console.log(
        `  → ${position.stock.tickerCode}: ${exitReason}! ¥${exitPrice.toLocaleString()}`,
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
          wasActivated: exitResult.isTrailingActivated,
          finalTrailingStopPrice: exitResult.trailingStopPrice,
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
      if (exitResult.trailingStopPrice !== currentTrailing) {
        updateData.trailingStopPrice = exitResult.trailingStopPrice;
      }

      if (Object.keys(updateData).length > 0) {
        await prisma.tradingPosition.update({
          where: { id: position.id },
          data: updateData,
        });
      }

      // 含み損益表示
      const unrealized = getUnrealizedPnl(position, quote.price);
      const tsInfo = exitResult.isTrailingActivated
        ? ` TS発動(¥${exitResult.trailingStopPrice})`
        : "";
      console.log(
        `  → ${position.stock.tickerCode}: 含み損益 ¥${unrealized.toLocaleString()}${tsInfo}`,
      );
    }
  }

  // システム停止チェック（フェーズ間で再確認）
  if (!(await isSystemActive())) {
    console.log("  → システム停止中のため終了");
    return;
  }

  // 3.2. 決算前強制決済（nextEarningsDate が5日以内のポジションをクローズ）
  console.log("[2.2/3] 決算前強制決済チェック...");
  const remainingForEarnings = await getOpenPositions();
  const todayJst = dayjs().tz("Asia/Tokyo").startOf("day");
  let earningsCloseCount = 0;

  for (const position of remainingForEarnings) {
    const { nextEarningsDate } = position.stock;
    if (!nextEarningsDate) continue;

    const diffDays = Math.floor(
      (nextEarningsDate.getTime() - todayJst.toDate().getTime()) / 86_400_000,
    );

    if (diffDays < 0 || diffDays > SCORING.GATES.EARNINGS_DAYS_BEFORE) continue;

    const quote = await fetchStockQuote(position.stock.tickerCode);
    if (!quote) continue;

    const entryPriceNum = Number(position.entryPrice);
    const maxHigh = position.maxHighDuringHold
      ? Math.max(Number(position.maxHighDuringHold), quote.high)
      : quote.high;
    const minLow = position.minLowDuringHold
      ? Math.min(Number(position.minLowDuringHold), quote.low)
      : quote.low;

    const earningsReason = `決算前強制決済（決算まで${diffDays}日）`;

    const exitSnapshot: ExitSnapshot = {
      exitReason: earningsReason,
      exitPrice: quote.price,
      priceJourney: {
        maxHigh,
        minLow,
        maxFavorableExcursion: ((maxHigh - entryPriceNum) / entryPriceNum) * 100,
        maxAdverseExcursion: ((entryPriceNum - minLow) / entryPriceNum) * 100,
      },
      marketContext: null,
    };

    console.log(
      `  → ${position.stock.tickerCode}: ${earningsReason} @ ¥${quote.price.toLocaleString()}`,
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

    earningsCloseCount++;
  }

  if (earningsCloseCount > 0) {
    await notifyRiskAlert({
      type: "決算前強制決済",
      message: `${earningsCloseCount}件のポジションを決算前に強制決済しました`,
    });
  } else {
    console.log("  → 決算前強制決済対象なし");
  }

  // システム停止チェック（フェーズ間で再確認）
  if (!(await isSystemActive())) {
    console.log("  → システム停止中のため終了");
    return;
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
      } else if (
        currentProfitPct <= -DEFENSIVE_MODE.BEARISH_LOSS_CUT_PCT
      ) {
        // bearish: 含み損が閾値超過 → SL引き締め（ギャップダウンリスク回避）
        shouldDefensiveClose = true;
        defensiveReason = `bearish含み損損切り（含み損 ${currentProfitPct.toFixed(2)}%、閾値: -${DEFENSIVE_MODE.BEARISH_LOSS_CUT_PCT}%）`;
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
          `  → ${position.stock.tickerCode}: bearish維持（含み損益 ${currentProfitPct.toFixed(2)}%、閾値未満のため通常SL監視継続）`,
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

  // システム停止チェック（フェーズ間で再確認）
  if (!(await isSystemActive())) {
    console.log("  → システム停止中のため終了");
    return;
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

/**
 * コーポレートイベント（配当落ち・株式分割）によるポジション調整
 *
 * - 配当落ち日当日: 損切り・トレーリングストップを配当額分引き下げ
 * - 株式分割当日: 全ポジション値を分割比率で調整
 */
async function applyCorporateEventAdjustments(
  positions: Awaited<ReturnType<typeof getOpenPositions>>,
) {
  const todayStr = dayjs().tz("Asia/Tokyo").format("YYYY-MM-DD");

  for (const pos of positions) {
    const stock = pos.stock;

    // 配当落ち日チェック
    if (
      stock.exDividendDate &&
      stock.dividendPerShare &&
      dayjs(stock.exDividendDate).format("YYYY-MM-DD") === todayStr
    ) {
      const dividendPerShare = Number(stock.dividendPerShare);
      const stopLoss = pos.stopLossPrice ? Number(pos.stopLossPrice) : null;
      if (stopLoss == null || dividendPerShare <= 0) continue;

      const result = adjustForExDividend(
        stopLoss,
        pos.trailingStopPrice ? Number(pos.trailingStopPrice) : null,
        dividendPerShare,
      );

      if (result.adjusted) {
        await prisma.tradingPosition.update({
          where: { id: pos.id },
          data: {
            stopLossPrice: result.newStopLoss,
            ...(result.newTrailingStop !== null && {
              trailingStopPrice: result.newTrailingStop,
            }),
          },
        });

        // ポジションのメモリ内データも更新（後続のループで最新値を使うため）
        pos.stopLossPrice = new Prisma.Decimal(result.newStopLoss);
        if (result.newTrailingStop !== null) {
          pos.trailingStopPrice = new Prisma.Decimal(result.newTrailingStop);
        }

        await prisma.corporateEventLog.create({
          data: {
            tickerCode: stock.tickerCode,
            eventType: "ex_dividend",
            eventDate: stock.exDividendDate,
            detail: { dividendAmount: dividendPerShare },
            positionId: pos.id,
            adjustmentType: "stop_loss_adjusted",
            beforeValue: {
              stopLossPrice: result.oldStopLoss,
              trailingStopPrice: result.oldTrailingStop,
            },
            afterValue: {
              stopLossPrice: result.newStopLoss,
              trailingStopPrice: result.newTrailingStop,
            },
          },
        });

        console.log(
          `  → ${stock.tickerCode}: 配当落ち調整（SL: ¥${result.oldStopLoss} → ¥${result.newStopLoss}, 配当: ¥${dividendPerShare}）`,
        );
      }
    }

    // 株式分割チェック（yahoo-finance2 の lastSplitDate と比較）
    try {
      const events = await fetchCorporateEvents(stock.tickerCode);
      if (
        events.lastSplitDate &&
        events.lastSplitFactor &&
        dayjs(events.lastSplitDate).format("YYYY-MM-DD") === todayStr
      ) {
        const parsed = parseSplitFactor(events.lastSplitFactor);
        if (!parsed) continue;

        const stopLoss = pos.stopLossPrice ? Number(pos.stopLossPrice) : 0;
        const result = adjustForSplit(
          Number(pos.entryPrice),
          pos.quantity,
          stopLoss,
          pos.takeProfitPrice ? Number(pos.takeProfitPrice) : null,
          pos.trailingStopPrice ? Number(pos.trailingStopPrice) : null,
          pos.entryAtr ? Number(pos.entryAtr) : null,
          parsed.numerator,
          parsed.denominator,
        );

        if (result.adjusted) {
          const adj = result.adjustments;
          await prisma.tradingPosition.update({
            where: { id: pos.id },
            data: {
              entryPrice: adj.entryPrice.new,
              quantity: adj.quantity.new,
              stopLossPrice: adj.stopLossPrice.new,
              takeProfitPrice: adj.takeProfitPrice.new,
              trailingStopPrice: adj.trailingStopPrice.new,
              entryAtr: adj.entryAtr.new,
            },
          });

          await prisma.corporateEventLog.create({
            data: {
              tickerCode: stock.tickerCode,
              eventType: "stock_split",
              eventDate: events.lastSplitDate,
              detail: {
                splitRatio: events.lastSplitFactor,
                numerator: parsed.numerator,
                denominator: parsed.denominator,
              },
              positionId: pos.id,
              adjustmentType: "position_split_adjusted",
              beforeValue: {
                entryPrice: adj.entryPrice.old,
                quantity: adj.quantity.old,
                stopLossPrice: adj.stopLossPrice.old,
              },
              afterValue: {
                entryPrice: adj.entryPrice.new,
                quantity: adj.quantity.new,
                stopLossPrice: adj.stopLossPrice.new,
              },
            },
          });

          console.log(
            `  → ${stock.tickerCode}: 株式分割調整（${events.lastSplitFactor}, 価格÷${result.splitRatio}, 数量×${result.splitRatio}）`,
          );
        }
      }
    } catch (error) {
      console.warn(
        `  → ${stock.tickerCode}: 分割チェックエラー:`,
        error,
      );
    }
  }
}

/**
 * 約定価格ベースでTP/SLを再検証する
 *
 * 注文時のTP/SLはlimitPrice基準で計算されるが、実際の約定価格（filledPrice）は
 * limitPriceと異なる場合がある。約定価格に対してSLが3%ルールを超過していないか等を
 * 再検証し、必要に応じて修正する。
 */
function recalculateExitPrices(
  filledPrice: number,
  orderTP: number | null,
  orderSL: number | null,
  entryAtr: number | null,
): { takeProfitPrice: number; stopLossPrice: number } {
  // デフォルト値
  let takeProfitPrice = orderTP ?? filledPrice * POSITION_DEFAULTS.TAKE_PROFIT_RATIO;
  let stopLossPrice = orderSL ?? filledPrice * POSITION_DEFAULTS.STOP_LOSS_RATIO;

  // SLを約定価格ベースで再検証
  const slValidation = validateStopLoss(filledPrice, stopLossPrice, entryAtr, []);
  if (slValidation.wasOverridden) {
    const oldSL = stopLossPrice;
    stopLossPrice = Math.round(slValidation.validatedPrice);
    console.log(
      `    → SL再検証（約定価格¥${filledPrice}）: ¥${oldSL} → ¥${stopLossPrice}（${slValidation.reason}）`,
    );

    // SLが変わった場合、TPもRR比を維持するよう再計算
    // entryAtrがあればATR×1.5、なければ元のRR比から逆算
    if (entryAtr) {
      const atrBasedTP = filledPrice + entryAtr * 1.5;
      // 元のTPとATRベースTPの大きい方を採用（利益を伸ばす方向）
      takeProfitPrice = Math.round(Math.max(takeProfitPrice, atrBasedTP));
    }
    // RRチェック: 最低1.5を確保
    const risk = filledPrice - stopLossPrice;
    const reward = takeProfitPrice - filledPrice;
    if (risk > 0 && reward / risk < 1.5) {
      takeProfitPrice = Math.round(filledPrice + risk * 1.5);
      console.log(
        `    → TP再計算（RR≥1.5確保）: ¥${takeProfitPrice}`,
      );
    }
  }

  return { takeProfitPrice, stopLossPrice };
}

/**
 * 既存オープンポジションのTP/SL整合性を検証する
 *
 * エントリー価格に対してSLが3%ルールを超過している場合に自動修正する。
 * 過去にバグで不正なTP/SLが設定されたポジションを救済する。
 */
function validateExistingPositionExitPrices(
  entryPrice: number,
  currentTP: number,
  currentSL: number,
  entryAtr: number | null,
): { takeProfitPrice: number; stopLossPrice: number; wasCorrected: boolean } {
  const slValidation = validateStopLoss(entryPrice, currentSL, entryAtr, []);

  if (!slValidation.wasOverridden) {
    return { takeProfitPrice: currentTP, stopLossPrice: currentSL, wasCorrected: false };
  }

  const newSL = Math.round(slValidation.validatedPrice);
  let newTP = currentTP;

  // TPもRR≥1.5を確保するよう再計算
  const risk = entryPrice - newSL;
  const reward = newTP - entryPrice;
  if (risk > 0 && reward / risk < 1.5) {
    newTP = Math.round(entryPrice + risk * 1.5);
  }

  return { takeProfitPrice: newTP, stopLossPrice: newSL, wasCorrected: true };
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
