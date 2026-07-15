/**
 * 注文シミュレーションモジュール
 *
 * 指値・逆指値注文の約定判定と注文ステータス更新を行う
 */

import { prisma } from "../lib/prisma";
import { getStartOfDayJST } from "../lib/market-date";
import type { TradingOrder } from "@prisma/client";

/**
 * 買い指値注文の約定判定（純粋関数）
 *
 * 安値が指値以下なら約定。ギャップダウン時は寄り付き値で約定（買い手に有利）。
 * バックテストと本番で同一ロジックを共有する。
 *
 * @returns 約定価格（約定しない場合は null）
 */
export function checkBuyLimitFill(
  limitPrice: number,
  barLow: number,
  barOpen: number,
): number | null {
  if (barLow <= limitPrice) {
    return barOpen < limitPrice ? barOpen : limitPrice;
  }
  return null;
}

/**
 * 注文約定チェック
 *
 * - 買い指値: 安値が指値以下なら約定（指値で約定）
 * - 売り指値（利確）: 高値が指値以上なら約定（指値で約定）
 * - 逆指値（損切り）: 安値が逆指値以下なら約定（逆指値で約定）
 *
 * @returns 約定価格（約定しない場合は null）
 */
export function checkOrderFill(
  order: TradingOrder,
  currentHigh: number,
  currentLow: number,
  currentOpen?: number,
): number | null {
  const limitPrice = order.limitPrice ? Number(order.limitPrice) : null;
  const stopPrice = order.stopPrice ? Number(order.stopPrice) : null;

  // 成行注文（引け成行等）はbroker約定通知を待つため疑似約定しない
  if (order.orderType === "market") return null;

  // 買い指値注文
  if (order.side === "buy" && limitPrice !== null) {
    return checkBuyLimitFill(limitPrice, currentLow, currentOpen ?? currentLow);
  }

  // 売り指値注文（利確）: 高値が指値以上なら約定
  if (
    order.side === "sell" &&
    limitPrice !== null &&
    order.orderType !== "stop_limit"
  ) {
    if (currentHigh >= limitPrice) {
      // ギャップアップで寄り付いた場合、寄り付き値で約定（売り手に有利）
      if (currentOpen != null && currentOpen > limitPrice) {
        return currentOpen;
      }
      return limitPrice;
    }
  }

  // 逆指値注文（損切り）: 安値が逆指値以下なら約定
  if (order.side === "sell" && stopPrice !== null) {
    if (currentLow <= stopPrice) {
      // ギャップダウンで逆指値を突き抜けた場合、寄り付き値で約定（スリッページ）
      if (currentOpen != null && currentOpen < stopPrice) {
        return currentOpen;
      }
      return stopPrice;
    }
  }

  return null;
}

/**
 * 注文を約定済みに更新する
 */
export async function fillOrder(
  orderId: string,
  filledPrice: number,
): Promise<TradingOrder> {
  return prisma.tradingOrder.update({
    where: { id: orderId },
    data: {
      status: "filled",
      filledPrice,
      filledAt: new Date(),
    },
  });
}

/**
 * 注文を「約定済み」として atomic に claim する。勝者だけ true を返す。
 *
 * 立花の EVENT I/F は同一約定を複数回配信するため、「status を読む → 未処理なら約定処理」
 * という read-then-act では重複イベントが競合する。実際 2026-07-14 の 3276.T / 8008.T は
 * 2つのイベントが同時に status='pending' を読んで両方素通りし、先行側が建てたポジションを
 * 後続側が「二重建て」と誤認して正常約定を cancelled に上書きした (KOH-549)。
 *
 * 条件付き更新 (status が未確定のときだけ filled にする) を1クエリで撃ち、更新できた側だけが
 * 後処理に進むことで、DB 側で排他する。
 */
export async function claimOrderFill(
  orderId: string,
  filledPrice: number,
): Promise<boolean> {
  const res = await prisma.tradingOrder.updateMany({
    where: { id: orderId, status: { notIn: ["filled", "cancelled"] } },
    data: {
      status: "filled",
      filledPrice,
      filledAt: new Date(),
    },
  });
  return res.count === 1;
}

/**
 * 当日の未約定（pending）買い注文が存在するティッカー集合を返す（全戦略横断）。
 *
 * GU/PSC/ETF は発注時に TradingPosition ではなく TradingOrder(pending) を作り、
 * ポジションは約定後にしか生成されない。そのため約定前の二重発注を防ぐには、
 * open/ordered ポジションに加えて「当日の pending 買い注文」も保有扱いで除外する必要がある。
 * gapup と post-surge-consolidation が同一銘柄に二重建てする事故（Issue #322）を防ぐため
 * strategy では絞らず全戦略横断で名寄せする。BT の allOpenTickers（1銘柄1ポジション）挙動に一致。
 */
export async function getSameDayPendingBuyTickers(): Promise<Set<string>> {
  const pendingBuys = await prisma.tradingOrder.findMany({
    where: {
      side: "buy",
      status: "pending",
      createdAt: { gte: getStartOfDayJST() },
    },
    include: { stock: { select: { tickerCode: true } } },
  });
  return new Set(pendingBuys.map((o) => o.stock.tickerCode));
}

/**
 * 期限切れ注文をキャンセルする
 *
 * 注意: 立花に発注済み（brokerOrderId あり）の注文は、時間ベース単独では失効確定しない。
 * 引け成行の約定（15:30）とジョブ実行が競合すると、約定済み注文を expired に塗り潰す事故が
 * 起きる（Issue #322: 2026-06-30 3989.T）。発注済み注文の失効/取消/約定の確定は
 * reconciliation（syncBrokerOrderStatuses）/ EVENT I/F が立花の実ステータスを確認して行う。
 * ここで時間失効させるのは brokerOrderId を持たない注文（未送信/デモ）のみに限定する。
 */
export async function expireOrders(): Promise<number> {
  const now = new Date();
  const result = await prisma.tradingOrder.updateMany({
    where: {
      status: "pending",
      expiresAt: { lte: now },
      brokerOrderId: null,
    },
    data: { status: "expired" },
  });
  return result.count;
}

/**
 * 未約定の注文を取得する（スコア降順）
 *
 * 高スコア銘柄を優先的に約定させるため、entrySnapshotのtotalScoreで降順ソートする。
 * 複数の指値が同時に刺さった場合、資金が尽きるまで高スコア順に約定させる。
 */
export async function getPendingOrders() {
  const orders = await prisma.tradingOrder.findMany({
    where: { status: "pending" },
    include: { stock: true },
  });

  return orders.sort((a, b) => {
    const scoreA =
      (a.entrySnapshot as Record<string, unknown> | null)?.score != null
        ? ((a.entrySnapshot as Record<string, Record<string, unknown>>).score
            .totalScore as number)
        : 0;
    const scoreB =
      (b.entrySnapshot as Record<string, unknown> | null)?.score != null
        ? ((b.entrySnapshot as Record<string, Record<string, unknown>>).score
            .totalScore as number)
        : 0;
    return scoreB - scoreA;
  });
}
