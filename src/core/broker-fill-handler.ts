/**
 * ブローカー約定イベントハンドラ
 *
 * WebSocket EVENT I/F の EC（約定通知）を受信した際に呼ばれる。
 * CLMOrderListDetail で約定詳細を取得し、DB の注文・ポジションを更新する。
 *
 * recoverMissedFills() はポーリングによるリカバリ用（WebSocket見逃し対策）。
 */

import { prisma } from "../lib/prisma";
import { TACHIBANA_ORDER_STATUS, BROKER_RECONCILIATION } from "../lib/constants/broker";
import { getOrderDetail } from "./broker-orders";
import { fillOrder } from "./order-executor";
import { openPosition, closePosition, getPositionPnl, extractRegimeInfoFromSnapshot } from "./position-manager";
import { submitBrokerSL } from "./broker-sl-manager";
import { validateStopLoss } from "./risk-manager";
import { notifyOrderFilled, notifySlack } from "../lib/slack";
import type { ExecutionEvent } from "./broker-event-stream";

// ========================================
// ポーリングリカバリ
// ========================================

/**
 * WebSocketが見逃した約定をAPIポーリングでリカバリする
 *
 * DBのpending注文ごとにCLMOrderListDetailでブローカー状態を確認し、
 * FULLY_FILLEDならhandleBrokerFillで約定処理を実行する。
 * position-monitorのメインループで毎分呼び出す。
 */
export async function recoverMissedFills(): Promise<void> {
  const pendingOrders = await prisma.tradingOrder.findMany({
    where: {
      status: "pending",
      brokerOrderId: { not: null },
      brokerBusinessDay: { not: null },
    },
    select: {
      brokerOrderId: true,
      brokerBusinessDay: true,
      stock: { select: { tickerCode: true } },
    },
  });

  if (!pendingOrders.length) return;

  for (const order of pendingOrders) {
    // 営業日が空（Issue #322）の注文は getOrderDetail を引けない。
    // reconciliation の Phase 1（syncBrokerOrderStatuses）が注文番号フォールバックで
    // brokerBusinessDay をバックフィルするまでスキップする。
    if (!order.brokerBusinessDay) continue;

    const detail = await getOrderDetail(
      order.brokerOrderId!,
      order.brokerBusinessDay!,
    ).catch((e) => {
      console.warn(
        `[fill-recovery] getOrderDetail error for ${order.brokerOrderId}:`,
        e,
      );
      return null;
    });

    if (!detail) continue;

    const brokerStatus = String(detail.sOrderStatusCode ?? detail.sOrderStatus ?? "");
    if (brokerStatus !== TACHIBANA_ORDER_STATUS.FULLY_FILLED) continue;

    console.log(
      `[fill-recovery] ${order.stock.tickerCode} order ${order.brokerOrderId}: ブローカー約定済みを検出 → リカバリ処理開始`,
    );

    await handleBrokerFill({
      orderNumber: order.brokerOrderId!,
      businessDay: order.brokerBusinessDay!,
      raw: {},
    });
  }
}

// ========================================
// メイン処理
// ========================================

/**
 * ブローカー約定イベントを処理する
 *
 * position-monitor のポーリングとは独立して動作する。
 * DB の brokerStatus を先に更新することで、position-monitor 側での二重処理を防止する。
 */
export async function handleBrokerFill(
  event: ExecutionEvent,
): Promise<void> {
  const { orderNumber, businessDay } = event;

  try {
    // 1. DB で該当注文を検索
    let order = await prisma.tradingOrder.findFirst({
      where: {
        brokerOrderId: orderNumber,
        brokerBusinessDay: businessDay,
      },
      include: { stock: true },
    });

    // businessDay 欠落注文（Issue #322）の救済:
    // submitOrder 応答に sEigyouDay が無いと brokerBusinessDay=null で保存され、WS通知が持つ
    // businessDay と完全一致せず約定を取りこぼす（reconciliation の同期を待つしかなかった）。
    // 注文番号 + businessDay=null の pending 注文を拾い、通知の businessDay をバックフィルして回収する。
    if (!order) {
      const nullDayOrder = await prisma.tradingOrder.findFirst({
        where: {
          brokerOrderId: orderNumber,
          brokerBusinessDay: null,
          status: "pending",
        },
        include: { stock: true },
      });
      if (nullDayOrder) {
        await prisma.tradingOrder.update({
          where: { id: nullDayOrder.id },
          data: { brokerBusinessDay: businessDay },
        });
        order = { ...nullDayOrder, brokerBusinessDay: businessDay };
        console.log(
          `[broker-fill] ${nullDayOrder.stock.tickerCode} order ${orderNumber}: 欠落していた営業日を ${businessDay} でバックフィルし WS 約定を回収`,
        );
      }
    }

    if (!order) {
      // TradingOrder が無い注文番号 = ブローカーSL（逆指値）の可能性。
      // SL注文は broker-sl-manager が TradingPosition.slBrokerOrderId に番号を持つだけで
      // TradingOrder を作らないため、通常経路では拾えない。ここでフォールバック検索して
      // SL約定をリアルタイムにクローズする（従来は reconcileHoldings の保有照合＝最大数時間遅延でしか
      // 検知できず、その空白時間に position-monitor が約定済みポジションを二重決済していた）。
      const slPosition = await prisma.tradingPosition.findFirst({
        where: { status: "open", slBrokerOrderId: orderNumber },
        include: { stock: { select: { tickerCode: true, name: true } } },
      });
      if (slPosition) {
        await handleBrokerSLFill(slPosition);
        return;
      }
      console.log(
        `[broker-fill] Unknown order: ${orderNumber} (day=${businessDay})`,
      );
      return;
    }

    // 既に処理済みの場合はスキップ
    if (order.status === "filled" || order.status === "cancelled") {
      console.log(
        `[broker-fill] Order ${orderNumber} already ${order.status}, skipping`,
      );
      return;
    }

    // 2. CLMOrderListDetail で約定詳細を取得
    const detail = await getOrderDetail(orderNumber, businessDay);
    if (!detail) {
      console.warn(
        `[broker-fill] Failed to get order detail for ${orderNumber}`,
      );
      return;
    }

    // 注文ステータスを確認（コード優先、テキストはフォールバック）
    const brokerStatus = String(detail.sOrderStatusCode ?? detail.sOrderStatus ?? "");

    // DB の brokerStatus を即座に更新（position-monitor の二重処理防止）
    await prisma.tradingOrder.update({
      where: { id: order.id },
      data: { brokerStatus },
    });

    // 全部約定でない場合はログのみ
    if (brokerStatus !== TACHIBANA_ORDER_STATUS.FULLY_FILLED) {
      console.log(
        `[broker-fill] Order ${orderNumber} status=${brokerStatus} (not fully filled)`,
      );
      return;
    }

    // 3. 約定価格を取得
    const execList =
      (detail.aYakuzyouSikkouList as Record<string, unknown>[]) ?? [];
    if (execList.length === 0) {
      console.warn(
        `[broker-fill] No execution records for ${orderNumber}`,
      );
      return;
    }

    // 加重平均約定価格を計算（複数回に分けて約定した場合）
    let totalAmount = 0;
    let totalQuantity = 0;
    for (const exec of execList) {
      const price = Number(exec.sYakuzyouPrice ?? exec.sExecPrice ?? 0);
      const qty = Number(
        exec.sYakuzyouSuryou ?? exec.sExecQuantity ?? 0,
      );
      totalAmount += price * qty;
      totalQuantity += qty;
    }

    const filledPrice =
      totalQuantity > 0 ? Math.round(totalAmount / totalQuantity) : 0;

    if (filledPrice <= 0) {
      console.warn(
        `[broker-fill] Invalid filled price for ${orderNumber}`,
      );
      return;
    }

    console.log(
      `[broker-fill] Order ${orderNumber} filled: ${order.stock.tickerCode} ${order.side} @ ¥${filledPrice.toLocaleString()} x ${totalQuantity}`,
    );

    // 4. 注文を約定済みに更新
    await fillOrder(order.id, filledPrice);

    // 5. 買い/売りに応じた後処理
    if (order.side === "buy") {
      await handleBuyFill(order, filledPrice);
    } else {
      await handleSellFill(order, filledPrice);
    }
  } catch (err) {
    console.error(
      `[broker-fill] Error processing fill for ${orderNumber}:`,
      err,
    );
    await notifySlack({
      title: "WebSocket 約定処理エラー",
      message: `注文番号: ${orderNumber}\n${err instanceof Error ? err.message : String(err)}`,
      color: "danger",
    }).catch(() => {});
  }
}

// ========================================
// 買い約定処理
// ========================================

async function handleBuyFill(
  order: {
    id: string;
    stockId: string;
    strategy: string;
    orderType: string;
    quantity: number;
    takeProfitPrice: unknown;
    stopLossPrice: unknown;
    entrySnapshot: unknown;
    stock: { tickerCode: string; name: string };
  },
  filledPrice: number,
): Promise<void> {
  // 同一銘柄のopenポジションが既にあれば注文キャンセル（多重防御）
  const existingPosition = await prisma.tradingPosition.findFirst({
    where: { stockId: order.stockId, status: "open" },
  });
  if (existingPosition) {
    console.log(
      `[broker-fill] ${order.stock.tickerCode}: duplicate open position, cancelling`,
    );
    await prisma.tradingOrder.update({
      where: { id: order.id },
      data: { status: "cancelled" },
    });
    return;
  }

  // entrySnapshot から ATR を取得
  const entryAtr = extractAtrFromSnapshot(order.entrySnapshot);

  // 約定価格ベースで TP/SL を再計算
  const orderTP = order.takeProfitPrice
    ? Number(order.takeProfitPrice)
    : null;
  const orderSL = order.stopLossPrice
    ? Number(order.stopLossPrice)
    : null;
  const { takeProfitPrice, stopLossPrice } = recalculateExitPrices(
    filledPrice,
    orderTP,
    orderSL,
    entryAtr,
  );

  // ポジションオープン
  const regimeInfo = extractRegimeInfoFromSnapshot(order.entrySnapshot);
  const position = await openPosition(
    order.stockId,
    order.strategy,
    filledPrice,
    order.quantity,
    takeProfitPrice,
    stopLossPrice,
    order.entrySnapshot as object | undefined,
    entryAtr,
    regimeInfo,
  );

  // 約定品質ロギング: 引け成行注文（gapup/weekly-break/PSC）のみ
  // 基準価格 = スキャン時のcurrentPrice（entrySnapshot.trigger.currentPrice）
  // スリッページ = (約定価格 - 基準価格) / 基準価格 × 10000 [bps]
  const executionQuality = computeExecutionQuality(
    order.orderType,
    order.entrySnapshot,
    filledPrice,
  );

  // ポジションIDを注文に紐付け（+ 約定品質）
  await prisma.tradingOrder.update({
    where: { id: order.id },
    data: {
      positionId: position.id,
      ...(executionQuality
        ? { referencePrice: executionQuality.referencePrice, slippageBps: executionQuality.slippageBps }
        : {}),
    },
  });

  // SL 逆指値注文をブローカーに発注（エラーはbroker-sl-manager内で処理）
  await submitBrokerSL({
    positionId: position.id,
    ticker: order.stock.tickerCode,
    quantity: order.quantity,
    stopTriggerPrice: stopLossPrice,
    strategy: order.strategy,
  });

  // Slack 通知
  const triggerSnapshot = (order.entrySnapshot as Record<string, unknown>)?.trigger as Record<string, unknown> | undefined;
  const buyReasoning = triggerSnapshot
    ? `出来高サージ ${Number(triggerSnapshot.volumeSurgeRatio ?? 0).toFixed(2)}x`
    : undefined;
  await notifyOrderFilled({
    tickerCode: order.stock.tickerCode,
    name: order.stock.name,
    side: "buy",
    strategy: order.strategy,
    filledPrice,
    quantity: order.quantity,
    stopLossPrice,
    reasoning: buyReasoning,
  });

  // 約定品質: 異常値Slack通知
  if (executionQuality) {
    await notifyExecutionQualityIfAnomaly({
      ticker: order.stock.tickerCode,
      strategy: order.strategy,
      referencePrice: executionQuality.referencePrice,
      filledPrice,
      slippageBps: executionQuality.slippageBps,
    });
  }
}

// ========================================
// 売り約定処理
// ========================================

async function handleSellFill(
  order: {
    id: string;
    positionId: string | null;
    strategy: string;
    stock: { tickerCode: string; name: string };
    quantity: number;
  },
  filledPrice: number,
): Promise<void> {
  let pnl = 0;
  let entryPrice: number | undefined;
  let exitReason: string | undefined;

  if (order.positionId) {
    // エントリー価格 + SL/trailing想定決済価格を取得（sell slippage 記録用）
    const position = await prisma.tradingPosition.findUnique({
      where: { id: order.positionId },
      select: {
        entryPrice: true,
        exitSnapshot: true,
        stopLossPrice: true,
        trailingStopPrice: true,
      },
    });
    entryPrice = position ? Number(position.entryPrice) : undefined;

    // ブローカーSL発動時の想定決済価格 = trailing 優先、なければ stopLoss
    const referencePrice = position
      ? Number(position.trailingStopPrice ?? position.stopLossPrice ?? 0) || null
      : null;

    // ポジションをクローズ
    const exitSnapshot = {
      exitReason: "ブローカー約定（WebSocket）",
      exitPrice: filledPrice,
      marketContext: null,
    };

    const closed = await closePosition(
      order.positionId,
      filledPrice,
      exitSnapshot as object,
      referencePrice,
    );
    pnl = getPositionPnl(closed);

    // 決済理由を判定（SL約定 = 逆指値発動）
    exitReason = "SL約定";
  }

  // Slack 通知
  await notifyOrderFilled({
    tickerCode: order.stock.tickerCode,
    name: order.stock.name,
    side: "sell",
    strategy: order.strategy,
    filledPrice,
    quantity: order.quantity,
    entryPrice,
    pnl,
    exitReason,
  });
}

// ========================================
// ブローカーSL（逆指値）約定処理
// ========================================

/**
 * ブローカーSL（逆指値）約定をリアルタイムに処理してポジションをクローズする。
 *
 * SL注文は TradingOrder を持たず TradingPosition.slBrokerOrderId で追跡されるため、
 * handleBrokerFill の通常経路（TradingOrder 検索）では拾えない。WebSocket EC 通知の
 * 注文番号が open ポジションの slBrokerOrderId に一致した時に本関数へフォールバックする。
 *
 * broker-reconciliation の handleMissingHolding（保有照合・遅延バックアップ）と同型の処理を
 * リアルタイム化したもの。両者は closePosition 前の status ガードでべき等（二重クローズしない）。
 */
export async function handleBrokerSLFill(position: {
  id: string;
  quantity: number;
  strategy: string;
  entryPrice: unknown;
  stopLossPrice: unknown;
  trailingStopPrice: unknown;
  slBrokerOrderId: string | null;
  slBrokerBusinessDay: string | null;
  stock: { tickerCode: string; name: string };
}): Promise<void> {
  const ticker = position.stock.tickerCode;
  if (!position.slBrokerOrderId || !position.slBrokerBusinessDay) return;

  const detail = await getOrderDetail(
    position.slBrokerOrderId,
    position.slBrokerBusinessDay,
  ).catch(() => null);
  if (!detail) return;

  const brokerStatus = String(detail.sOrderStatusCode ?? detail.sOrderStatus ?? "");
  // まだ全部約定でない（トリガー前 / 一部約定）→ 何もしない。reconciliation が後続で拾う。
  if (brokerStatus !== TACHIBANA_ORDER_STATUS.FULLY_FILLED) return;

  // 加重平均約定価格を計算（複数回約定に対応）
  const execList = (detail.aYakuzyouSikkouList as Record<string, unknown>[]) ?? [];
  let totalAmount = 0;
  let totalQuantity = 0;
  for (const exec of execList) {
    const price = Number(exec.sYakuzyouPrice ?? exec.sExecPrice ?? 0);
    const qty = Number(exec.sYakuzyouSuryou ?? exec.sExecQuantity ?? 0);
    totalAmount += price * qty;
    totalQuantity += qty;
  }
  const filledPrice = totalQuantity > 0 ? Math.round(totalAmount / totalQuantity) : 0;
  if (filledPrice <= 0) {
    console.warn(
      `[broker-fill] SL ${position.slBrokerOrderId} (${ticker}): 約定価格を取得できず、reconciliation に委譲`,
    );
    return;
  }

  // 約定価格の異常値ガード（reconciliation と同基準）
  const entryPrice = Number(position.entryPrice ?? 0);
  if (
    entryPrice > 0 &&
    filledPrice < entryPrice * BROKER_RECONCILIATION.MIN_FILL_PRICE_RATIO
  ) {
    console.error(
      `[broker-fill] ${ticker}: SL約定価格が異常 (¥${filledPrice} << エントリー¥${entryPrice}) → 自動クローズ中止`,
    );
    await notifySlack({
      title: `🚨 SL約定価格異常: ${ticker}`,
      message: `SL注文 ${position.slBrokerOrderId} の約定価格が異常です\n約定価格: ¥${filledPrice.toLocaleString()}\nエントリー価格: ¥${entryPrice.toLocaleString()}\n自動クローズを中止しました。手動で確認してください\npositionId: ${position.id}`,
      color: "danger",
    }).catch(() => {});
    return;
  }

  // べき等性: reconciliation / WS 3段リトライ等との二重クローズを防止
  const fresh = await prisma.tradingPosition.findUnique({
    where: { id: position.id },
    select: { status: true },
  });
  if (!fresh || fresh.status !== "open") {
    console.log(
      `[broker-fill] ${ticker}: ポジション既に ${fresh?.status ?? "不明"}、SL約定処理スキップ`,
    );
    return;
  }

  // SL発動時の想定決済価格 = trailing 優先、なければ stopLoss（sell slippage 記録用）
  const referencePrice =
    Number(position.trailingStopPrice ?? position.stopLossPrice ?? 0) || null;

  const closed = await closePosition(
    position.id,
    filledPrice,
    {
      exitReason: "SL約定（ブローカー自律執行）",
      exitPrice: filledPrice,
      marketContext: null,
    } as object,
    referencePrice,
  );

  // slBrokerOrderId をクリア（reconciliation の再処理・再発注防止）
  await prisma.tradingPosition.update({
    where: { id: position.id },
    data: { slBrokerOrderId: null, slBrokerBusinessDay: null },
  });

  console.log(
    `[broker-fill] ${ticker}: SL約定リアルタイム検知 @ ¥${filledPrice.toLocaleString()} → ポジションクローズ`,
  );

  await notifyOrderFilled({
    tickerCode: ticker,
    name: position.stock.name,
    side: "sell",
    strategy: position.strategy,
    filledPrice,
    quantity: position.quantity,
    entryPrice: entryPrice > 0 ? entryPrice : undefined,
    pnl: getPositionPnl(closed),
    exitReason: "SL約定",
  });
}

// ========================================
// ユーティリティ
// ========================================

function extractAtrFromSnapshot(snapshot: unknown): number | null {
  if (!snapshot || typeof snapshot !== "object") return null;
  const s = snapshot as Record<string, unknown>;
  const technicals = s.technicals as Record<string, unknown> | undefined;
  return technicals?.atr14 != null ? Number(technicals.atr14) : null;
}

/**
 * 引け成行注文の約定品質を計算する
 * 基準価格 = entrySnapshot.trigger.currentPrice（スキャン時の現在値）
 * limit注文（breakout）は構造上スリッページなしなので null を返す
 */
function computeExecutionQuality(
  orderType: string,
  snapshot: unknown,
  filledPrice: number,
): { referencePrice: number; slippageBps: number } | null {
  if (orderType !== "market") return null;
  if (!snapshot || typeof snapshot !== "object") return null;

  const trigger = (snapshot as Record<string, unknown>).trigger as
    | Record<string, unknown>
    | undefined;
  if (!trigger?.currentPrice) return null;

  const referencePrice = Number(trigger.currentPrice);
  if (!Number.isFinite(referencePrice) || referencePrice <= 0) return null;

  const slippageBps = Math.round(((filledPrice - referencePrice) / referencePrice) * 10000);
  return { referencePrice, slippageBps };
}

/**
 * スリッページが閾値を超えたら Slack 通知する
 * - |slip| > 200bps (2%): danger
 * - |slip| > 100bps (1%): warning
 */
async function notifyExecutionQualityIfAnomaly(params: {
  ticker: string;
  strategy: string;
  referencePrice: number;
  filledPrice: number;
  slippageBps: number;
}): Promise<void> {
  const { ticker, strategy, referencePrice, filledPrice, slippageBps } = params;
  const absBps = Math.abs(slippageBps);

  let color: "warning" | "danger";
  if (absBps > 200) color = "danger";
  else if (absBps > 100) color = "warning";
  else return;

  const slipPct = (slippageBps / 100).toFixed(2);
  const direction = slippageBps > 0 ? "高く" : "安く";

  await notifySlack({
    title: `[execution-quality] ${ticker} 引け成行スリッページ ${slipPct}%`,
    message:
      `戦略: ${strategy}\n` +
      `基準価格(スキャン時): ¥${referencePrice.toLocaleString()}\n` +
      `約定価格(終値): ¥${filledPrice.toLocaleString()}\n` +
      `→ 基準より ${slipPct}% ${direction}約定`,
    color,
  }).catch(() => {});
}

/**
 * 約定価格ベースで TP/SL を再検証する
 */
function recalculateExitPrices(
  filledPrice: number,
  orderTP: number | null,
  orderSL: number | null,
  entryAtr: number | null,
): { takeProfitPrice: number; stopLossPrice: number } {
  const DEFAULT_TP_RATIO = 1.05;
  const DEFAULT_SL_RATIO = 0.97;

  let takeProfitPrice =
    orderTP ?? Math.round(filledPrice * DEFAULT_TP_RATIO);
  let stopLossPrice =
    orderSL ?? Math.round(filledPrice * DEFAULT_SL_RATIO);

  // SL を約定価格ベースで再検証
  const slValidation = validateStopLoss(
    filledPrice,
    stopLossPrice,
    entryAtr,
    [],
  );
  if (slValidation.wasOverridden) {
    stopLossPrice = Math.round(slValidation.validatedPrice);

    // ATR ベースで TP も再計算
    if (entryAtr) {
      const atrBasedTP = filledPrice + entryAtr * 1.5;
      takeProfitPrice = Math.round(
        Math.max(takeProfitPrice, atrBasedTP),
      );
    }

    // RR >= 1.5 を確保
    const risk = filledPrice - stopLossPrice;
    const reward = takeProfitPrice - filledPrice;
    if (risk > 0 && reward / risk < 1.5) {
      takeProfitPrice = Math.round(filledPrice + risk * 1.5);
    }
  }

  return { takeProfitPrice, stopLossPrice };
}
