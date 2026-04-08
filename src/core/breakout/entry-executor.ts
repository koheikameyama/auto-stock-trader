/**
 * ブレイクアウト戦略のエントリーエグゼキューター
 *
 * ブレイクアウトトリガーを受け取り、以下のフローを実行する:
 * 1. 今日のMarketAssessmentでshouldTradeを確認
 * 2. 買い余力チェック（ローカル計算）
 * 3. SL価格 = currentPrice - ATR(14) × 1.0（最大3%）
 * 4. ポジションサイズ = リスク金額（資金の2%） / (currentPrice - SL)、100株単位切捨て
 * 5. TradingOrderをDBに作成
 * 6. submitBrokerOrder()でブローカー発注
 * 7. Slack通知
 */

import dayjs from "dayjs";
import utc from "dayjs/plugin/utc.js";
import timezone from "dayjs/plugin/timezone.js";
import { prisma } from "../../lib/prisma";
import { getTodayForDB, adjustToTradingDay } from "../../lib/market-date";
import { getCashBalance, getEffectiveCapital } from "../position-manager";
import { canOpenPosition, getDynamicMaxPositionPct } from "../risk-manager";
import { submitOrder as submitBrokerOrder, modifyOrder, cancelOrder } from "../broker-orders";
import { notifyOrderPlaced, notifySlack } from "../../lib/slack";
import { STOP_LOSS, UNIT_SHARES } from "../../lib/constants";
import { getRiskPctByRR } from "../risk-manager";
import { fetchStockQuote, checkLiquidity } from "../market-data";
import { TIMEZONE } from "../../lib/constants/timezone";
import { BREAKOUT } from "../../lib/constants/breakout";
import { GAPUP } from "../../lib/constants/gapup";
import { TACHIBANA_ORDER } from "../../lib/constants/broker";
import { ORDER_EXPIRY } from "../../lib/constants/jobs";
import type { BreakoutTrigger } from "./types";
import type { QuoteData } from "./breakout-scanner";
import type { GapUpTrigger } from "../gapup/gapup-scanner";

dayjs.extend(utc);
dayjs.extend(timezone);

export interface ExecutionResult {
  success: boolean;
  orderId?: string;
  reason?: string;
  /** true の場合、同じ銘柄の再トリガーを許可する（一時的な理由での却下） */
  retryable?: boolean;
}

/**
 * ブレイクアウト / ギャップアップトリガーのエントリー実行
 *
 * @param trigger ブレイクアウトまたはギャップアップトリガーイベント
 * @param strategy 戦略種別（デフォルト: "breakout"）
 */
export async function executeEntry(
  trigger: BreakoutTrigger | GapUpTrigger,
  strategy: "breakout" | "gapup" = "breakout",
): Promise<ExecutionResult> {
  const { ticker, currentPrice, atr14 } = trigger;

  // 0. 共有データを並列で一括取得（重複クエリ削減）
  const [todayAssessment, stock, cashBalance, effectiveCapital, config, openPositions] =
    await Promise.all([
      prisma.marketAssessment.findUnique({ where: { date: getTodayForDB() } }),
      prisma.stock.findUnique({ where: { tickerCode: ticker } }),
      getCashBalance(),
      getEffectiveCapital(),
      prisma.tradingConfig.findFirst({ orderBy: { createdAt: "desc" } }),
      prisma.tradingPosition.findMany({
        where: { status: "open" },
        include: { stock: { select: { id: true, jpxSectorName: true, tickerCode: true } } },
      }),
    ]);

  // 1. shouldTrade確認
  if (!todayAssessment || !todayAssessment.shouldTrade) {
    const reason = !todayAssessment
      ? "今日のMarketAssessmentがありません"
      : "今日は取引見送り（shouldTrade=false）";
    console.log(`[entry-executor] ${ticker} スキップ: ${reason}`);
    return { success: false, reason, retryable: false };
  }

  // 2. 銘柄マスタ確認
  if (!stock) {
    const reason = `銘柄マスタに存在しません: ${ticker}`;
    console.log(`[entry-executor] ${reason}`);
    return { success: false, reason, retryable: false };
  }

  // 3. SL価格 = currentPrice - ATR × multiplier（最大3%に制限）
  const slAtrMultiplier =
    strategy === "gapup" ? GAPUP.STOP_LOSS.ATR_MULTIPLIER : BREAKOUT.STOP_LOSS.ATR_MULTIPLIER;
  const rawStopLoss = currentPrice - atr14 * slAtrMultiplier;
  const maxStopLoss = currentPrice * (1 - STOP_LOSS.MAX_LOSS_PCT);
  const stopLossPrice = Math.round(Math.max(rawStopLoss, maxStopLoss));

  const isSLClamped = rawStopLoss < maxStopLoss;
  if (isSLClamped) {
    const reason = `SLがATRベース（¥${Math.round(rawStopLoss)}）より3%上限（¥${stopLossPrice}）でクランプされました — ノイズに狩られるリスクが高いためスキップ`;
    console.log(`[entry-executor] ${ticker} スキップ: ${reason}`);
    return { success: false, reason, retryable: false };
  }

  // 4. ポジションサイズ計算（RRに応じたリスク%傾斜）
  const riskPerShare = currentPrice - stopLossPrice;

  if (riskPerShare <= 0) {
    const reason = `SLがエントリー価格以上のため数量計算不可（SL: ¥${stopLossPrice}, entry: ¥${currentPrice}）`;
    console.log(`[entry-executor] ${ticker} スキップ: ${reason}`);
    return { success: false, reason, retryable: false };
  }

  // 利確参考値: ATR × 5.0（トレーリングストップが実際の利確を担う）
  const takeProfitPrice = Math.round(currentPrice + atr14 * 5.0);

  // RRに応じたリスク%傾斜: 高RR → 厚いポジション、低RR → 控えめ
  const riskRewardRatio = (takeProfitPrice - currentPrice) / riskPerShare;
  const riskPct = getRiskPctByRR(riskRewardRatio);
  const riskAmount = effectiveCapital * (riskPct / 100);

  const rawQuantity = Math.floor(riskAmount / riskPerShare);
  let quantity = Math.floor(rawQuantity / UNIT_SHARES) * UNIT_SHARES;

  if (quantity === 0) {
    const reason = `予算不足でポジションサイズが0（余力: ¥${cashBalance.toLocaleString()}, リスク額: ¥${riskAmount.toLocaleString()}, RR: ${riskRewardRatio.toFixed(1)}, リスク%: ${riskPct}%）`;
    console.log(`[entry-executor] ${ticker} スキップ: ${reason}`);
    return { success: false, reason, retryable: true };
  }

  // 残高上限で切り下げ: 買える最大100株単位に縮小
  const maxByBalance = Math.floor(cashBalance / currentPrice / UNIT_SHARES) * UNIT_SHARES;
  if (quantity > maxByBalance) {
    if (maxByBalance === 0) {
      const reason = `残高不足（必要: ¥${(currentPrice * quantity).toLocaleString()}, 残高: ¥${cashBalance.toLocaleString()}）`;
      console.log(`[entry-executor] ${ticker} スキップ: ${reason}`);
      return { success: false, reason, retryable: true };
    }
    console.log(`[entry-executor] ${ticker} 残高上限で縮小: ${quantity}株 → ${maxByBalance}株（残高: ¥${cashBalance.toLocaleString()}）`);
    quantity = maxByBalance;
  }

  // 集中率上限で切り下げ: maxPositionPct 以内に収まる最大100株単位に縮小
  const maxPositionPct = getDynamicMaxPositionPct(effectiveCapital, currentPrice);
  const existingAmountForStock = openPositions
    .filter((pos) => pos.stockId === stock.id)
    .reduce((sum, pos) => sum + Number(pos.entryPrice) * pos.quantity, 0);
  const maxAmountByConcentration = (effectiveCapital * maxPositionPct) / 100 - existingAmountForStock;
  const maxByConcentration = Math.floor(maxAmountByConcentration / currentPrice / UNIT_SHARES) * UNIT_SHARES;
  if (quantity > maxByConcentration) {
    if (maxByConcentration <= 0) {
      const reason = `集中率上限（${maxPositionPct}%）を超えるためスキップ（既存投資額: ¥${existingAmountForStock.toLocaleString()}）`;
      console.log(`[entry-executor] ${ticker} スキップ: ${reason}`);
      return { success: false, reason, retryable: false };
    }
    console.log(`[entry-executor] ${ticker} 集中率上限で縮小: ${quantity}株 → ${maxByConcentration}株（上限: ${maxPositionPct}%）`);
    quantity = maxByConcentration;
  }

  // 5. canOpenPosition でセクター集中・ドローダウン・ポジション数を確認（プリフェッチデータを渡す）
  const riskCheck = await canOpenPosition(
    stock.id,
    quantity,
    currentPrice,
    {
      config: config ?? undefined,
      openPositions,
      effectiveCapital,
    },
    strategy,
  );
  if (!riskCheck.allowed) {
    console.log(`[entry-executor] ${ticker} リスクチェック不可: ${riskCheck.reason}`);
    return { success: false, reason: riskCheck.reason, retryable: riskCheck.retryable ?? false };
  }

  // 5.5 流動性チェック（板情報フィルター）
  // 発注直前に最新の板情報を取得し、スプレッド・板厚を検証する
  const freshQuote = await fetchStockQuote(ticker);
  if (freshQuote) {
    const liquidityCheck = checkLiquidity(freshQuote, quantity);
    if (!liquidityCheck.isLiquid) {
      console.log(`[entry-executor] ${ticker} 流動性不足: ${liquidityCheck.reason}`);
      return { success: false, reason: liquidityCheck.reason, retryable: true };
    }
    if (liquidityCheck.riskFlags.length > 0) {
      console.log(
        `[entry-executor] ${ticker} 流動性リスクフラグ: ${liquidityCheck.riskFlags.join(", ")}（スプレッド: ${liquidityCheck.spreadPct?.toFixed(2) ?? "-"}%）`,
      );
    }
  }

  // 6. 変数の準備
  const isGapUp = strategy === "gapup";
  const expiresAt = isGapUp
    ? dayjs().tz(TIMEZONE).hour(15).minute(30).second(0).toDate()
    : dayjs().tz(TIMEZONE).add(ORDER_EXPIRY.SWING_DAYS, "day").hour(15).minute(0).second(0).toDate();
  const reasoning = isGapUp
    ? `ギャップアップトリガー: 出来高サージ比率 ${trigger.volumeSurgeRatio.toFixed(2)}x, ギャップ3%以上`
    : `ブレイクアウトトリガー: 出来高サージ比率 ${trigger.volumeSurgeRatio.toFixed(2)}x, 20日高値 ¥${'high20' in trigger ? trigger.high20 : ''} 突破`;

  // 7. ブローカー発注（DB保存前に実行）
  let brokerResult;
  try {
    brokerResult = await submitBrokerOrder({
      ticker,
      side: "buy",
      quantity,
      limitPrice: isGapUp ? null : currentPrice,
      condition: isGapUp ? TACHIBANA_ORDER.CONDITION.CLOSE : undefined,
      expireDay: isGapUp ? undefined : dayjs(adjustToTradingDay(expiresAt)).tz(TIMEZONE).format("YYYYMMDD"),
    });
  } catch (brokerErr) {
    console.error(`[entry-executor] ブローカーエラー ${ticker}:`, brokerErr);
    const errorMsg = brokerErr instanceof Error ? brokerErr.message : String(brokerErr);
    await notifySlack({
      title: `ブローカー発注失敗: ${ticker}`,
      message: errorMsg,
      color: "danger",
    });
    return { success: false, reason: errorMsg, retryable: false };
  }

  if (!brokerResult.success || !brokerResult.orderNumber) {
    const errorMsg = brokerResult.success
      ? "注文番号が取得できませんでした"
      : (brokerResult.error ?? "Unknown error");
    console.warn(`[entry-executor] ブローカー発注失敗: ${ticker}: ${errorMsg}`);
    await notifySlack({
      title: `ブローカー発注失敗: ${ticker}`,
      message: errorMsg,
      color: "danger",
    });
    return { success: false, reason: errorMsg, retryable: false };
  }

  console.log(
    `[entry-executor] ${ticker} ブローカー発注成功: orderNumber=${brokerResult.orderNumber}`,
  );

  // 6. TradingOrderをDBに作成（発注成功後）
  const newOrder = await prisma.tradingOrder.create({
    data: {
      updatedAt: new Date(),
      stockId: stock.id,
      side: "buy",
      orderType: isGapUp ? "market" : "limit",
      strategy,
      limitPrice: currentPrice, // gapup: スナップショット価格（実約定は引け値）
      takeProfitPrice,
      stopLossPrice,
      quantity,
      status: "pending",
      expiresAt,
      reasoning,
      brokerOrderId: brokerResult.orderNumber,
      brokerBusinessDay: brokerResult.businessDay,
      entrySnapshot: {
        trigger: {
          ticker: trigger.ticker,
          currentPrice: trigger.currentPrice,
          volumeSurgeRatio: trigger.volumeSurgeRatio,
          ...('high20' in trigger ? { high20: trigger.high20 } : {}),
          atr14: trigger.atr14,
          triggeredAt: trigger.triggeredAt.toISOString(),
        },
        slClamped: isSLClamped,
        riskRewardRatio: Math.round(riskRewardRatio * 100) / 100,
        riskPct,
        ...(freshQuote?.askPrice ? {
          liquidity: {
            askPrice: freshQuote.askPrice,
            bidPrice: freshQuote.bidPrice,
            askSize: freshQuote.askSize,
            bidSize: freshQuote.bidSize,
            spreadPct: freshQuote.askPrice && freshQuote.bidPrice && currentPrice > 0
              ? Math.round(((freshQuote.askPrice - freshQuote.bidPrice) / currentPrice) * 10000) / 100
              : null,
          },
        } : {}),
      },
    },
  });

  console.log(
    `[entry-executor] ${ticker} 注文作成: id=${newOrder.id}, 指値=¥${currentPrice}, SL=¥${stopLossPrice}, TP=¥${takeProfitPrice}, 数量=${quantity}株, RR=${riskRewardRatio.toFixed(1)}, リスク%=${riskPct}%`,
  );

  // 8. Slack通知
  const slackReasoning = isGapUp
    ? `ギャップアップトリガー: 出来高サージ ${trigger.volumeSurgeRatio.toFixed(2)}x / ギャップ3%以上`
    : `ブレイクアウトトリガー: 出来高サージ ${trigger.volumeSurgeRatio.toFixed(2)}x / 20日高値 ¥${'high20' in trigger ? trigger.high20 : ''} 突破`;
  await notifyOrderPlaced({
    tickerCode: ticker,
    name: stock.name,
    side: "buy",
    strategy,
    limitPrice: currentPrice,
    takeProfitPrice,
    stopLossPrice,
    quantity,
    reasoning: slackReasoning,
  });

  return { success: true, orderId: newOrder.id };
}

/**
 * 既存pending買い注文の株数を現在の資金状況で再計算し、過大な場合は減株する
 *
 * 先着順（createdAt ASC）で残高を割り当て、後発の注文から優先的に減株される。
 */
export async function resizePendingOrders(): Promise<void> {
  const pendingOrders = await prisma.tradingOrder.findMany({
    where: { side: "buy", status: "pending" },
    include: { stock: { select: { tickerCode: true } } },
    orderBy: { createdAt: "asc" },
  });

  if (pendingOrders.length === 0) return;

  const [effectiveCapital, openPositions] = await Promise.all([
    getEffectiveCapital(),
    prisma.tradingPosition.findMany({ where: { status: "open" } }),
  ]);

  const investedAmount = openPositions.reduce(
    (sum, pos) => sum + Number(pos.entryPrice) * pos.quantity,
    0,
  );

  // 先着順で残高を割り当て
  let remainingCash = effectiveCapital - investedAmount;

  for (const order of pendingOrders) {
    const limitPrice = Number(order.limitPrice);
    const stopLossPrice = Number(order.stopLossPrice);

    if (!limitPrice || !stopLossPrice || limitPrice <= stopLossPrice) {
      remainingCash -= limitPrice * order.quantity;
      continue;
    }

    // リスクベース株数（entrySnapshotのRRに応じたリスク%を使用）
    const riskPerShare = limitPrice - stopLossPrice;
    const snapshot = order.entrySnapshot as Record<string, unknown> | null;
    const savedRR = (snapshot?.riskRewardRatio as number) ?? 0;
    const riskPctForResize = getRiskPctByRR(savedRR);
    const riskAmount = effectiveCapital * (riskPctForResize / 100);
    const riskBasedQty =
      Math.floor(Math.floor(riskAmount / riskPerShare) / UNIT_SHARES) * UNIT_SHARES;

    // 残高ベース株数
    const cashBasedQty =
      remainingCash > 0
        ? Math.floor(Math.floor(remainingCash / limitPrice) / UNIT_SHARES) * UNIT_SHARES
        : 0;

    const newQuantity = Math.min(riskBasedQty, cashBasedQty);

    if (newQuantity >= order.quantity) {
      remainingCash -= limitPrice * order.quantity;
      continue;
    }

    // 株数が0以下 → 注文キャンセル
    if (newQuantity <= 0) {
      if (order.brokerOrderId && order.brokerBusinessDay) {
        const result = await cancelOrder(order.brokerOrderId, order.brokerBusinessDay, `${order.stock.tickerCode}: 資金割り当て不足のためキャンセル`);
        if (!result.success) {
          console.warn(
            `[pending-resize] ${order.stock.tickerCode} ブローカー取消失敗: ${result.error}`,
          );
          remainingCash -= limitPrice * order.quantity;
          continue;
        }
      }

      await prisma.tradingOrder.update({
        where: { id: order.id },
        data: { status: "cancelled" },
      });

      console.log(
        `[pending-resize] ${order.stock.tickerCode} 残高不足のためキャンセル（残高: ¥${Math.round(remainingCash).toLocaleString()}）`,
      );

      await notifySlack({
        title: `注文キャンセル: ${order.stock.tickerCode}`,
        message: `${order.quantity}株 → キャンセル（残高不足）`,
        color: "warning",
      });

      continue;
    }

    // ブローカー訂正
    if (order.brokerOrderId && order.brokerBusinessDay) {
      const result = await modifyOrder(order.brokerOrderId, order.brokerBusinessDay, {
        quantity: newQuantity,
      });
      if (!result.success) {
        console.warn(
          `[pending-resize] ${order.stock.tickerCode} ブローカー訂正失敗: ${result.error}`,
        );
        remainingCash -= limitPrice * order.quantity;
        continue;
      }
    }

    // DB更新
    await prisma.tradingOrder.update({
      where: { id: order.id },
      data: { quantity: newQuantity },
    });

    console.log(
      `[pending-resize] ${order.stock.tickerCode} 株数訂正: ${order.quantity} → ${newQuantity}株`,
    );

    await notifySlack({
      title: `株数訂正: ${order.stock.tickerCode}`,
      message: `${order.quantity}株 → ${newQuantity}株（資金変動による再計算）`,
      color: "warning",
    });

    remainingCash -= limitPrice * newQuantity;
  }
}

/**
 * ブレイクアウト前提が崩壊したpending買い注文をキャンセルする
 *
 * 以下のいずれかを満たした場合にキャンセル:
 * - 出来高萎縮: surgeRatio < COOL_DOWN_THRESHOLD (1.2)
 * - 高値割り込み: currentPrice <= entrySnapshot.trigger.high20（フェイクアウト）
 *
 * @param quotes breakout-monitorが取得済みの時価データ
 * @param surgeRatios scannerのlastSurgeRatiosマップ
 */
export async function invalidateStalePendingOrders(
  quotes: QuoteData[],
  surgeRatios: ReadonlyMap<string, number>,
): Promise<Set<string>> {
  const cancelledTickers = new Set<string>();

  const pendingOrders = await prisma.tradingOrder.findMany({
    where: { side: "buy", status: "pending", strategy: "breakout" },
    include: { stock: { select: { tickerCode: true } } },
  });

  if (pendingOrders.length === 0) return cancelledTickers;

  const quoteMap = new Map(quotes.map((q) => [q.ticker, q]));

  for (const order of pendingOrders) {
    const ticker = order.stock.tickerCode;
    const quote = quoteMap.get(ticker);
    if (!quote) continue;

    const surgeRatio = surgeRatios.get(ticker);
    if (surgeRatio === undefined) continue;

    const snapshot = order.entrySnapshot as { trigger?: { high20?: number } } | null;
    const high20 = snapshot?.trigger?.high20;
    if (high20 === undefined) continue;

    const reasons: string[] = [];

    if (surgeRatio < BREAKOUT.VOLUME_SURGE.COOL_DOWN_THRESHOLD) {
      reasons.push(
        `出来高萎縮（サージ比率 ${surgeRatio.toFixed(1)}x < ${BREAKOUT.VOLUME_SURGE.COOL_DOWN_THRESHOLD}x）`,
      );
    }

    if (quote.price <= high20) {
      reasons.push(
        `高値割り込み（¥${quote.price.toLocaleString()} <= 20日高値 ¥${high20.toLocaleString()}）`,
      );
    }

    if (reasons.length === 0) continue;

    // ブローカー注文がある場合は取消
    if (order.brokerOrderId && order.brokerBusinessDay) {
      const result = await cancelOrder(order.brokerOrderId, order.brokerBusinessDay, `${ticker}: ${reasons.join('、')}`);
      if (!result.success) {
        console.warn(
          `[invalidate-pending] ${ticker} ブローカー取消失敗: ${result.error}`,
        );
        continue;
      }
    }

    await prisma.tradingOrder.update({
      where: { id: order.id },
      data: { status: "cancelled" },
    });

    cancelledTickers.add(ticker);

    const reasonText = reasons.join(" / ");
    console.log(`[invalidate-pending] ${ticker} 前提崩壊キャンセル: ${reasonText}`);

    await notifySlack({
      title: `前提崩壊キャンセル: ${ticker}`,
      message: reasonText,
      color: "warning",
    });
  }

  return cancelledTickers;
}
