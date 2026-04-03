/**
 * ブローカー注文操作モジュール
 *
 * デモ/本番の切替は TACHIBANA_ENV で行う。
 */

import { prisma } from "../lib/prisma";
import { getTachibanaClient, type TachibanaRequestParams, type TachibanaResponse } from "./broker-client";
import { tickerToBrokerCode, brokerCodeToTicker } from "../lib/ticker-utils";
import {
  TACHIBANA_CLMID,
  TACHIBANA_ORDER,
  TACHIBANA_ORDER_STATUS,
  TACHIBANA_ORDER_QUERY,
} from "../lib/constants/broker";
import { notifySlack } from "../lib/slack";

// ========================================
// 型定義
// ========================================

export interface BrokerOrderRequest {
  /** DB上のティッカー（例: "7203.T"） */
  ticker: string;
  /** "buy" | "sell" */
  side: "buy" | "sell";
  /** 株数 */
  quantity: number;
  /** 指値（null = 成行） */
  limitPrice: number | null;
  /** 逆指値トリガー価格（SL用） */
  stopTriggerPrice?: number;
  /** 逆指値約定価格（null = 成行） */
  stopOrderPrice?: number;
  /** 注文期日（YYYYMMDD）、省略時は当日 */
  expireDay?: string;
  /** 譲渡益課税区分（デフォルト: 特定） */
  taxType?: string;
  /** 執行条件: "0"=指定なし, "2"=寄付, "4"=引け（デフォルト: "0"） */
  condition?: string;
}

export interface BrokerOrderResult {
  success: boolean;
  /** ブローカー注文番号 */
  orderNumber?: string;
  /** 営業日 */
  businessDay?: string;
  /** 手数料 */
  commission?: number;
  /** エラーメッセージ */
  error?: string;
}

export interface BrokerHolding {
  ticker: string;
  quantity: number;
  sellableQuantity: number;
  bookValuePerShare: number;
  marketPrice: number;
  marketValue: number;
  unrealizedPnl: number;
}

// ========================================
// 注文操作
// ========================================

/**
 * 新規注文を送信
 */
export async function submitOrder(
  req: BrokerOrderRequest,
): Promise<BrokerOrderResult> {
  const brokerCode = tickerToBrokerCode(req.ticker);
  const baibaiKubun =
    req.side === "buy" ? TACHIBANA_ORDER.SIDE.BUY : TACHIBANA_ORDER.SIDE.SELL;

  // 逆指値の有無で注文種別を決定
  const hasReverse = req.stopTriggerPrice != null;
  const hasLimit = req.limitPrice != null;
  let gyakusasiOrderType: string = TACHIBANA_ORDER.REVERSE_ORDER_TYPE.NORMAL;
  if (hasLimit && hasReverse) {
    gyakusasiOrderType = TACHIBANA_ORDER.REVERSE_ORDER_TYPE.NORMAL_AND_REVERSE;
  } else if (hasReverse) {
    gyakusasiOrderType = TACHIBANA_ORDER.REVERSE_ORDER_TYPE.REVERSE_ONLY;
  }

  const params: TachibanaRequestParams = {
    sCLMID: TACHIBANA_CLMID.NEW_ORDER,
    sZyoutoekiKazeiC: req.taxType ?? TACHIBANA_ORDER.TAX_TYPE.SPECIFIC,
    sIssueCode: brokerCode,
    sSizyouC: TACHIBANA_ORDER.EXCHANGE.TSE,
    sBaibaiKubun: baibaiKubun,
    sCondition: req.condition ?? TACHIBANA_ORDER.CONDITION.NONE,
    sOrderPrice: req.limitPrice != null ? String(req.limitPrice) : TACHIBANA_ORDER.MARKET_PRICE,
    sOrderSuryou: String(req.quantity),
    sGenkinShinyouKubun: TACHIBANA_ORDER.MARGIN_TYPE.CASH,
    sOrderExpireDay: req.expireDay ?? TACHIBANA_ORDER.EXPIRE.TODAY,
    sGyakusasiOrderType: gyakusasiOrderType,
    sTatebiType: "*",
    sTategyokuZyoutoekiKazeiC: "*",
    sSecondPassword: process.env.TACHIBANA_SECOND_PASSWORD ?? "",
  };

  // 逆指値パラメータ（sGyakusasiZyouken / sGyakusasiPrice は常に必須）
  params.sGyakusasiZyouken = hasReverse ? String(req.stopTriggerPrice) : "0";
  params.sGyakusasiPrice = hasReverse
    ? (req.stopOrderPrice != null ? String(req.stopOrderPrice) : TACHIBANA_ORDER.MARKET_PRICE)
    : "*";

  return executeLiveOrder(params);
}

/**
 * 注文取消
 */
export async function cancelOrder(
  orderId: string,
  businessDay: string,
  reason?: string,
): Promise<BrokerOrderResult> {
  const params: TachibanaRequestParams = {
    sCLMID: TACHIBANA_CLMID.CANCEL_ORDER,
    sOrderNumber: orderId,
    sEigyouDay: businessDay,
    sSecondPassword: process.env.TACHIBANA_SECOND_PASSWORD ?? "",
  };

  const result = await executeLiveRequest(params);

  if (reason) {
    await notifySlack({
      title: result.success ? "注文キャンセル" : "注文キャンセル失敗",
      message: `注文番号: ${orderId}\n営業日: ${businessDay}\n理由: ${reason}${!result.success ? `\nエラー: ${result.error}` : ""}`,
      color: result.success ? "warning" : "danger",
    }).catch(() => {});
  }

  return result;
}

/**
 * 注文訂正
 */
export async function modifyOrder(
  orderId: string,
  businessDay: string,
  changes: {
    price?: number;
    quantity?: number;
    expireDay?: string;
  },
): Promise<BrokerOrderResult> {
  const params: TachibanaRequestParams = {
    sCLMID: TACHIBANA_CLMID.CORRECT_ORDER,
    sOrderNumber: orderId,
    sEigyouDay: businessDay,
    sOrderPrice: changes.price != null ? String(changes.price) : "*",
    sOrderSuryou: changes.quantity != null ? String(changes.quantity) : "*",
    sOrderExpireDay: changes.expireDay ?? "*",
    sSecondPassword: process.env.TACHIBANA_SECOND_PASSWORD ?? "",
  };

  return executeLiveRequest(params);
}

// ========================================
// 照会系
// ========================================

/**
 * 注文一覧取得
 */
export async function getOrders(filter?: {
  ticker?: string;
  statusFilter?: string;
}): Promise<TachibanaResponse | null> {
  const client = getTachibanaClient();

  return client.request({
    sCLMID: TACHIBANA_CLMID.ORDER_LIST,
    sIssueCode: filter?.ticker ? tickerToBrokerCode(filter.ticker) : "",
    sOrderSyoukaiStatus:
      filter?.statusFilter ?? TACHIBANA_ORDER_QUERY.UNFILLED_AND_PARTIAL,
  });
}

/**
 * 注文詳細取得
 */
export async function getOrderDetail(
  orderId: string,
  businessDay: string,
): Promise<TachibanaResponse | null> {
  const client = getTachibanaClient();

  return client.request({
    sCLMID: TACHIBANA_CLMID.ORDER_DETAIL,
    sOrderNumber: orderId,
    sEigyouDay: businessDay,
  });
}

/**
 * 現物保有銘柄一覧取得
 *
 * APIエラー時は null を返す（空配列との区別のため）。
 * 呼び出し側は null の場合は照合をスキップすること。
 */
export async function getHoldings(): Promise<BrokerHolding[] | null> {
  const client = getTachibanaClient();

  const res = await client.request({
    sCLMID: TACHIBANA_CLMID.HOLDINGS,
    sIssueCode: "",
  });

  if (res.sResultCode !== "0") return null;

  const list = (res.aGenbutuKabuList as Record<string, unknown>[]) ?? [];
  return list.map((item) => ({
    ticker: brokerCodeToTicker(String(item.sUriOrderIssueCode ?? "")),
    quantity: Number(item.sUriOrderZanKabuSuryou ?? 0),
    sellableQuantity: Number(item.sUriOrderUritukeKanouSuryou ?? 0),
    bookValuePerShare: Number(item.sUriOrderGaisanBokaTanka ?? 0),
    marketPrice: Number(item.sUriOrderHyoukaTanka ?? 0),
    marketValue: Number(item.sUriOrderGaisanHyoukagaku ?? 0),
    unrealizedPnl: Number(item.sUriOrderGaisanHyoukaSoneki ?? 0),
  }));
}

/**
 * 買余力取得
 */
export async function getBuyingPower(): Promise<number | null> {
  // 照会系APIのため brokerMode チェックは行わない（読み取り専用）
  const client = getTachibanaClient();

  const res = await client.request({
    sCLMID: TACHIBANA_CLMID.BUYING_POWER,
  });

  if (res.sResultCode !== "0") return null;

  return Number(res.sSummaryGenkabuKaituke ?? 0);
}

// ========================================
// DB同期
// ========================================

/**
 * ブローカー注文ステータスをDBに同期
 */
export async function syncBrokerOrderStatuses(): Promise<void> {
  const client = getTachibanaClient();

  // ブローカー注文一覧を先に取得（孤立注文の回収にも使う）
  const res = await client.request({
    sCLMID: TACHIBANA_CLMID.ORDER_LIST,
    sIssueCode: "",
    sOrderSyoukaiStatus: "",
  });

  if (res.sResultCode !== "0") {
    console.warn(
      `[broker-orders] Failed to fetch broker orders: ${res.sResultText}`,
    );
    return;
  }

  const brokerOrders =
    (res.aOrderList as Record<string, unknown>[]) ?? [];

  // 注文一覧の数値キー確認用ログ（最初の1件のみ）
  if (brokerOrders.length > 0) {
    console.log("[broker-orders] CLMOrderList item sample:", JSON.stringify(brokerOrders[0]));
  }

  // brokerOrderIdが設定されている未完了注文を取得
  const orders = await prisma.tradingOrder.findMany({
    where: {
      brokerOrderId: { not: null },
      status: { in: ["pending", "filled"] },
    },
    include: { stock: true },
  });

  if (orders.length === 0) return;

  // ブローカー注文をMapに変換
  // CLMOrderListの注文番号フィールドは sOrderOrderNumber、執行日は sOrderSikkouDay
  const brokerMap = new Map<string, Record<string, unknown>>();
  for (const bo of brokerOrders) {
    const orderNum = String(bo.sOrderOrderNumber ?? bo.sOrderNumber ?? "");
    const sikkouDay = String(bo.sOrderSikkouDay ?? bo.sEigyouDay ?? "");
    if (orderNum && sikkouDay) {
      brokerMap.set(`${orderNum}_${sikkouDay}`, bo);
    }
  }

  // DB注文とブローカーステータスを比較・更新
  for (const order of orders) {
    if (!order.brokerOrderId || !order.brokerBusinessDay) continue;
    const key = `${order.brokerOrderId}_${order.brokerBusinessDay}`;
    const bo = brokerMap.get(key);

    if (!bo) continue;

    // sOrderStatusCode（数値コード）を優先、なければ sOrderStatus（名称）を使用
    const brokerStatus = String(bo.sOrderStatusCode ?? bo.sOrderStatus ?? "");

    if (order.brokerStatus !== brokerStatus) {
      // ブローカー側で失効・取消された注文はDB statusも更新
      const statusUpdate: Record<string, string> = { brokerStatus };
      if (
        brokerStatus === TACHIBANA_ORDER_STATUS.EXPIRED ||
        brokerStatus === TACHIBANA_ORDER_STATUS.CANCELLED
      ) {
        if (order.status === "pending") {
          statusUpdate.status =
            brokerStatus === TACHIBANA_ORDER_STATUS.EXPIRED
              ? "expired"
              : "cancelled";
          console.log(
            `[broker-orders] ${order.stock.tickerCode} order ${order.brokerOrderId}: ブローカー${statusUpdate.status} → DB status更新`,
          );
        }
      }

      await prisma.tradingOrder.update({
        where: { id: order.id },
        data: statusUpdate,
      });
      console.log(
        `[broker-orders] Synced ${order.stock.tickerCode} order ${order.brokerOrderId}: ${order.brokerStatus} → ${brokerStatus}`,
      );
    }
  }
}

// ========================================
// 内部ヘルパー
// ========================================

async function executeLiveOrder(
  params: TachibanaRequestParams,
): Promise<BrokerOrderResult> {
  const client = getTachibanaClient();

  try {
    const res = await client.request(params);

    if (res.sResultCode !== "0") {
      const responseJson = JSON.stringify(res);
      console.error("[broker-orders] 発注失敗 response:", responseJson);
      await notifySlack({ title: "発注失敗 APIレスポンス", message: responseJson, color: "danger" });
      return {
        success: false,
        error: `[${res.sResultCode}] ${res.sResultText ?? "Unknown error"}`,
      };
    }

    // sResultCode=0 でもサブコード(688)にエラーが入る場合がある
    const subCode = String(res.sOrderResultCode ?? "0");
    if (subCode !== "0") {
      const responseJson = JSON.stringify(res);
      console.error("[broker-orders] 発注失敗 response:", responseJson);
      await notifySlack({ title: "発注失敗 APIレスポンス", message: responseJson, color: "danger" });
      return {
        success: false,
        error: `[sub:${subCode}] ${res.sOrderResultText ?? "Unknown error"}`,
      };
    }

    const orderNumber = String(res.sOrderNumber ?? "");
    if (!orderNumber) {
      return {
        success: false,
        error: `注文は受け付けられましたが注文番号が返却されませんでした`,
      };
    }

    return {
      success: true,
      orderNumber,
      businessDay: String(res.sEigyouDay ?? ""),
      commission: Number(res.sOrderTesuryou ?? 0),
    };
  } catch (e) {
    return {
      success: false,
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

async function executeLiveRequest(
  params: TachibanaRequestParams,
): Promise<BrokerOrderResult> {
  const client = getTachibanaClient();

  try {
    const res = await client.request(params);

    if (res.sResultCode !== "0") {
      return {
        success: false,
        error: `[${res.sResultCode}] ${res.sResultText ?? "Unknown error"}`,
      };
    }

    return { success: true };
  } catch (e) {
    return {
      success: false,
      error: e instanceof Error ? e.message : String(e),
    };
  }
}
