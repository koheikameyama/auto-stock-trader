/**
 * ブローカー照合ジョブ（毎分・市場時間中）
 *
 * DBとブローカー実態の差異を検出・自動修正する。
 * position-monitor より先に実行されることを前提とする。
 *
 * Phase 1: 注文ステータス同期    (syncBrokerOrderStatuses から移管)
 * Phase 2: 見逃し約定リカバリ   (recoverMissedFills から移管)
 * Phase 3: 保有株数照合         (NEW) ブローカー保有 vs DBオープンポジション
 * Phase 4: SL注文照合           (NEW) 失効・取消SLの再発注
 * Phase 5: 孤立買い注文キャンセル (NEW) DBに記録のないブローカー買い注文を自動キャンセル
 */

import { prisma } from "../lib/prisma";
import { notifySlack } from "../lib/slack";
import { syncBrokerOrderStatuses, getHoldings, getOrderDetail, getOrders, cancelOrder } from "../core/broker-orders";
import { recoverMissedFills } from "../core/broker-fill-handler";
import { TACHIBANA_ORDER } from "../lib/constants/broker";
import { closePosition } from "../core/position-manager";
import { submitBrokerSL } from "../core/broker-sl-manager";
import { fetchStockQuote } from "../core/market-data";
import { TACHIBANA_ORDER_STATUS } from "../lib/constants/broker";

export async function main(): Promise<void> {
  console.log("=== Broker Reconciliation 開始 ===");

  // Phase 1: 注文ステータス同期
  try {
    await syncBrokerOrderStatuses();
  } catch (e) {
    console.warn("[broker-reconciliation] syncBrokerOrderStatuses error (ignored):", e);
  }

  // Phase 2: 見逃し約定リカバリ
  try {
    await recoverMissedFills();
  } catch (e) {
    console.warn("[broker-reconciliation] recoverMissedFills error (ignored):", e);
  }

  // Phase 3: 保有株数照合
  try {
    await reconcileHoldings();
  } catch (e) {
    console.warn("[broker-reconciliation] reconcileHoldings error (ignored):", e);
  }

  // Phase 4: SL注文照合
  try {
    await reconcileSLOrders();
  } catch (e) {
    console.warn("[broker-reconciliation] reconcileSLOrders error (ignored):", e);
  }

  // Phase 5: 孤立買い注文キャンセル
  try {
    await cancelOrphanedBuyOrders();
  } catch (e) {
    console.warn("[broker-reconciliation] cancelOrphanedBuyOrders error (ignored):", e);
  }

  console.log("=== Broker Reconciliation 完了 ===");
}

/**
 * ブローカー実保有 vs DBオープンポジションを照合する
 *
 * ブローカーに保有がないポジションを検出し、SL約定の有無を確認してDBをクローズする。
 * 数量が不一致の場合はSlackアラートを送信する。
 */
async function reconcileHoldings(): Promise<void> {
  const [brokerHoldings, openPositions] = await Promise.all([
    getHoldings(),
    prisma.tradingPosition.findMany({
      where: { status: "open" },
      include: { stock: true },
    }),
  ]);

  if (!openPositions.length) return;

  const holdingMap = new Map(brokerHoldings.map((h) => [h.ticker, h]));

  for (const position of openPositions) {
    const ticker = position.stock.tickerCode;
    const holding = holdingMap.get(ticker);

    if (!holding) {
      // ブローカーに保有なし → SL約定の可能性
      console.log(
        `[broker-reconciliation] ${ticker}: DBオープンポジションあり、ブローカー保有なし → SL約定を確認`,
      );
      await handleMissingHolding(position);
      continue;
    }

    // 数量不一致チェック（部分的な売却等の検出）
    if (holding.quantity !== position.quantity) {
      console.warn(
        `[broker-reconciliation] ${ticker}: 数量不一致 DB=${position.quantity} ブローカー=${holding.quantity}`,
      );
      await notifySlack({
        title: `⚠️ 保有数量不一致: ${ticker}`,
        message: `DB: ${position.quantity}株\nブローカー: ${holding.quantity}株\n手動確認が必要です\npositionId: ${position.id}`,
        color: "warning",
      }).catch(() => {});
    }
  }
}

/**
 * ブローカーに保有がないポジションを処理する
 *
 * slBrokerOrderId の約定詳細を確認し、FULLY_FILLED であれば
 * 約定価格を取得してDBポジションをクローズする。
 * 確認できない場合はSlackアラートを送信する。
 */
async function handleMissingHolding(position: {
  id: string;
  quantity: number;
  strategy: string;
  stopLossPrice: unknown;
  trailingStopPrice: unknown;
  slBrokerOrderId: string | null;
  slBrokerBusinessDay: string | null;
  stock: { tickerCode: string; name: string };
}): Promise<void> {
  const ticker = position.stock.tickerCode;

  if (position.slBrokerOrderId && position.slBrokerBusinessDay) {
    const detail = await getOrderDetail(
      position.slBrokerOrderId,
      position.slBrokerBusinessDay,
    ).catch(() => null);

    if (detail) {
      const brokerStatus = String(detail.sOrderStatusCode ?? detail.sOrderStatus ?? "");

      if (brokerStatus === TACHIBANA_ORDER_STATUS.FULLY_FILLED) {
        // SL約定 → 約定価格を計算してポジションクローズ
        const execList =
          (detail.aYakuzyouSikkouList as Record<string, unknown>[]) ?? [];
        let filledPrice = 0;

        if (execList.length > 0) {
          let totalAmount = 0;
          let totalQuantity = 0;
          for (const exec of execList) {
            const price = Number(exec.sYakuzyouPrice ?? exec.sExecPrice ?? 0);
            const qty = Number(exec.sYakuzyouSuryou ?? exec.sExecQuantity ?? 0);
            totalAmount += price * qty;
            totalQuantity += qty;
          }
          filledPrice = totalQuantity > 0 ? Math.round(totalAmount / totalQuantity) : 0;
        }

        if (filledPrice > 0) {
          await closePosition(position.id, filledPrice, {
            exitReason: "SL約定（ブローカー自律執行・照合リカバリ）",
            exitPrice: filledPrice,
            marketContext: null,
          });
          console.log(
            `[broker-reconciliation] ${ticker}: SL約定リカバリ @ ¥${filledPrice} → ポジションクローズ`,
          );
          await notifySlack({
            title: `🔴 SL約定リカバリ: ${ticker}`,
            message: `SL注文 ${position.slBrokerOrderId} が約定済みを検出\n約定価格: ¥${filledPrice.toLocaleString()}\nDBポジションをクローズしました`,
            color: "danger",
          }).catch(() => {});
          return;
        }
      }
    }
  }

  // SL注文なし or 約定確認できず → DBの約定済み売注文 or 現在値でクローズ
  const exitPrice = await resolveExitPrice(position);
  await closePosition(position.id, exitPrice, {
    exitReason: "保有照合クローズ（ブローカー保有なし・自動修正）",
    exitPrice,
    marketContext: null,
  });
  console.log(
    `[broker-reconciliation] ${ticker}: 保有照合クローズ @ ¥${exitPrice} → ポジションクローズ`,
  );
  await notifySlack({
    title: `🔴 保有照合クローズ: ${ticker}`,
    message: `ブローカーに保有が見つからないため自動クローズしました\npositionId: ${position.id}\nSL注文: ${position.slBrokerOrderId ?? "なし"}\n使用価格: ¥${exitPrice.toLocaleString()}`,
    color: "danger",
  }).catch(() => {});
}

/**
 * ポジションの推定エグジット価格を解決する
 *
 * 1. DB内の約定済み売注文の約定価格
 * 2. 現在の市場価格
 * 3. trailingStopPrice or stopLossPrice（フォールバック）
 */
async function resolveExitPrice(position: {
  id: string;
  stopLossPrice: unknown;
  trailingStopPrice: unknown;
  stock: { tickerCode: string };
}): Promise<number> {
  // 1. DB内の約定済み売注文
  const filledSellOrder = await prisma.tradingOrder.findFirst({
    where: { positionId: position.id, side: "sell", status: "filled" },
    orderBy: { filledAt: "desc" },
  });
  if (filledSellOrder?.filledPrice) {
    return Number(filledSellOrder.filledPrice);
  }

  // 2. 現在の市場価格
  const quote = await fetchStockQuote(position.stock.tickerCode).catch(() => null);
  if (quote?.price && quote.price > 0) {
    return quote.price;
  }

  // 3. trailingStopPrice or stopLossPrice
  const fallback =
    position.trailingStopPrice != null
      ? Number(position.trailingStopPrice)
      : Number(position.stopLossPrice ?? 0);
  return fallback;
}

/**
 * SL注文の状態を照合する
 *
 * オープンポジションのSL注文が失効・取消されている場合は再発注する。
 * SL約定（FULLY_FILLED）は Phase 3 の保有照合で処理済みのためここではスキップ。
 */
async function reconcileSLOrders(): Promise<void> {
  const openPositions = await prisma.tradingPosition.findMany({
    where: {
      status: "open",
      slBrokerOrderId: { not: null },
      slBrokerBusinessDay: { not: null },
    },
    include: { stock: true },
  });

  if (!openPositions.length) return;

  for (const position of openPositions) {
    if (!position.slBrokerOrderId || !position.slBrokerBusinessDay) continue;

    const detail = await getOrderDetail(
      position.slBrokerOrderId,
      position.slBrokerBusinessDay,
    ).catch(() => null);

    if (!detail) continue;

    const brokerStatus = String(detail.sOrderStatusCode ?? detail.sOrderStatus ?? "");
    const ticker = position.stock.tickerCode;

    // 失効・取消の場合は再発注（約定は Phase 3 で処理済み）
    if (
      brokerStatus === TACHIBANA_ORDER_STATUS.EXPIRED ||
      brokerStatus === TACHIBANA_ORDER_STATUS.CANCELLED
    ) {
      const reason = brokerStatus === TACHIBANA_ORDER_STATUS.EXPIRED ? "失効" : "取消";
      console.warn(
        `[broker-reconciliation] ${ticker}: SL注文 ${position.slBrokerOrderId} が${reason} → 再発注`,
      );

      // SL IDをクリアしてから再発注
      await prisma.tradingPosition.update({
        where: { id: position.id },
        data: { slBrokerOrderId: null, slBrokerBusinessDay: null },
      });

      // 最新のSL価格（trailingStop優先）で再発注
      const stopPrice =
        position.trailingStopPrice != null
          ? Number(position.trailingStopPrice)
          : Number(position.stopLossPrice ?? 0);

      if (stopPrice > 0) {
        await submitBrokerSL({
          positionId: position.id,
          ticker,
          quantity: position.quantity,
          stopTriggerPrice: stopPrice,
          strategy: position.strategy,
        });
        await notifySlack({
          title: `⚠️ SL注文再発注: ${ticker}`,
          message: `SL注文 ${position.slBrokerOrderId} が${reason}されたため再発注しました\nトリガー価格: ¥${stopPrice.toLocaleString()}`,
          color: "warning",
        }).catch(() => {});
      } else {
        await notifySlack({
          title: `❌ SL注文再発注失敗: ${ticker}`,
          message: `SL注文 ${position.slBrokerOrderId} が${reason}されましたが、SL価格が不明なため再発注できません\npositionId: ${position.id}\n手動対応が必要です`,
          color: "danger",
        }).catch(() => {});
      }
    }
  }
}

/**
 * DBに記録のないブローカー買い注文を検出してキャンセルする
 *
 * DBに対応するTradingOrderがない未約定買い注文は「孤立注文」として自動キャンセルする。
 * 約定するとSL・TP管理なしの野良ポジションになるため、キャンセルして安全側に倒す。
 */
async function cancelOrphanedBuyOrders(): Promise<void> {
  // ブローカーの未約定注文一覧を取得
  const res = await getOrders({ statusFilter: "" });
  if (!res || res.sResultCode !== "0") return;

  const brokerOrders = (res.aOrderList as Record<string, unknown>[]) ?? [];

  // DBに記録されているbrokerOrderIdのセットを作成
  const dbOrderIds = new Set(
    (
      await prisma.tradingOrder.findMany({
        where: { brokerOrderId: { not: null } },
        select: { brokerOrderId: true },
      })
    ).map((o) => o.brokerOrderId!),
  );

  for (const bo of brokerOrders) {
    const orderNum = String(bo.sOrderOrderNumber ?? bo.sOrderNumber ?? "");
    const businessDay = String(bo.sOrderSikkouDay ?? bo.sEigyouDay ?? "");
    const side = String(bo.sBaibaiKubun ?? bo.sOrderBaibaiKubun ?? "");
    const status = String(bo.sOrderStatusCode ?? bo.sOrderStatus ?? "");

    // 買い注文かつ未約定（UNFILLED or PARTIAL_FILLED）のみ対象
    if (side !== TACHIBANA_ORDER.SIDE.BUY) continue;
    if (
      status !== TACHIBANA_ORDER_STATUS.UNFILLED &&
      status !== TACHIBANA_ORDER_STATUS.PARTIAL_FILLED
    ) continue;
    if (!orderNum || !businessDay) continue;

    // DBに対応レコードがある場合はスキップ
    if (dbOrderIds.has(orderNum)) continue;

    // 孤立買い注文 → キャンセル
    console.warn(
      `[broker-reconciliation] 孤立買い注文を検出: ${orderNum} (${businessDay}) → キャンセル`,
    );
    const result = await cancelOrder(orderNum, businessDay).catch(() => ({
      success: false,
      error: "cancel request failed",
    }));

    await notifySlack({
      title: result.success
        ? `⚠️ 孤立買い注文をキャンセルしました`
        : `❌ 孤立買い注文のキャンセルに失敗しました`,
      message: `注文番号: ${orderNum}\n営業日: ${businessDay}\n${result.success ? "DBに記録のない買い注文を自動キャンセルしました" : `キャンセル失敗: ${result.error}\n手動対応が必要です`}`,
      color: result.success ? "warning" : "danger",
    }).catch(() => {});
  }
}
