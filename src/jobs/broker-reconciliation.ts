/**
 * ブローカー照合ジョブ（毎分・市場時間中）
 *
 * DBとブローカー実態の差異を検出・自動修正する。
 * position-monitor より先に実行されることを前提とする。
 *
 * Phase 1: 注文ステータス同期    (syncBrokerOrderStatuses から移管)
 * Phase 2: 見逃し約定リカバリ   (recoverMissedFills から移管)
 * Phase 3: 保有株数照合         (NEW) ブローカー保有 vs DBオープンポジション
 * Phase 4: 孤立買い注文キャンセル (NEW) DBに記録のないブローカー買い注文を自動キャンセル
 */

import { prisma } from "../lib/prisma";
import { notifySlack } from "../lib/slack";
import { syncBrokerOrderStatuses, getHoldings, getOrderDetail, getOrders } from "../core/broker-orders";
import { recoverMissedFills } from "../core/broker-fill-handler";
import { TACHIBANA_ORDER, TACHIBANA_ORDER_STATUS, isTachibanaProduction } from "../lib/constants/broker";
import { closePosition } from "../core/position-manager";

// 約定直後はブローカーの保有反映が遅れるためスキップする猶予期間
const HOLDINGS_GRACE_PERIOD_MS = 5 * 60 * 1000; // 5分

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

  // Phase 4: 孤立買い注文キャンセル
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
  if (!isTachibanaProduction) {
    console.log("[broker-reconciliation] デモ環境のため保有照合をスキップ");
    return;
  }

  const [brokerHoldings, openPositions] = await Promise.all([
    getHoldings(),
    prisma.tradingPosition.findMany({
      where: { status: "open" },
      include: { stock: true },
    }),
  ]);

  if (!openPositions.length) return;

  // APIエラー時（null）は照合をスキップ（誤爆による全ポジション自動クローズを防止）
  if (brokerHoldings === null) {
    console.warn("[broker-reconciliation] 保有一覧取得失敗 → 照合スキップ");
    return;
  }

  const holdingMap = new Map(brokerHoldings.map((h) => [h.ticker, h]));

  const now = Date.now();

  for (const position of openPositions) {
    const ticker = position.stock.tickerCode;

    // 約定直後はブローカーの保有反映が遅れるためスキップ
    if (now - position.createdAt.getTime() < HOLDINGS_GRACE_PERIOD_MS) {
      console.log(`[broker-reconciliation] ${ticker}: 開設直後のためスキップ（猶予期間中）`);
      continue;
    }

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

  // SL注文なし or 約定確認できず → 通知のみ（手動確認を促す）
  console.warn(
    `[broker-reconciliation] ${ticker}: ブローカー保有なし・約定未確認 → 通知のみ（自動クローズ停止中）`,
  );
  await notifySlack({
    title: `⚠️ 要確認: ブローカー保有なし ${ticker}`,
    message: `ブローカーに保有が見つかりません（SL約定未確認）\npositionId: ${position.id}\nSL注文: ${position.slBrokerOrderId ?? "なし"}\n手動で確認してください`,
    color: "warning",
  }).catch(() => {});
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

    // 孤立買い注文 → 通知のみ（自動キャンセル停止中）
    console.warn(
      `[broker-reconciliation] 孤立買い注文を検出: ${orderNum} (${businessDay}) → 通知のみ`,
    );
    await notifySlack({
      title: `⚠️ 要確認: 孤立買い注文を検出`,
      message: `注文番号: ${orderNum}\n営業日: ${businessDay}\nDBに記録のない買い注文が存在します\n手動で確認してください`,
      color: "warning",
    }).catch(() => {});
  }
}
