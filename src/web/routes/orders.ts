/**
 * 注文ページ（GET /orders）
 */

import { Hono } from "hono";
import { html } from "hono/html";
import dayjs from "dayjs";
import { prisma } from "../../lib/prisma";
import { QUERY_LIMITS } from "../../lib/constants";
import { layout } from "../views/layout";
import {
  formatYen,
  strategyBadge,
  orderStatusBadge,
  brokerStatusLabel,
  tickerLink,
  emptyState,
  tt,
} from "../views/components";
import { getOrders } from "../../core/broker-orders";

const app = new Hono();

app.get("/", async (c) => {
  const [pendingOrders, recentOrders, brokerOrdersRes, dbOrderRows] = await Promise.all([
    prisma.tradingOrder.findMany({
      where: { status: "pending" },
      include: { stock: true },
      orderBy: { createdAt: "desc" },
    }),
    prisma.tradingOrder.findMany({
      where: {
        status: { not: "pending" },
      },
      include: { stock: true },
      orderBy: { updatedAt: "desc" },
      take: QUERY_LIMITS.ORDER_HISTORY,
    }),
    getOrders({ statusFilter: "" }).catch(() => null),
    prisma.tradingOrder.findMany({
      where: { brokerOrderId: { not: null } },
      select: { brokerOrderId: true },
    }),
  ]);

  const dbOrderIdSet = new Set(dbOrderRows.map((o) => o.brokerOrderId!));
  const brokerOrders = brokerOrdersRes?.sResultCode === "0"
    ? ((brokerOrdersRes.aOrderList as Record<string, unknown>[]) ?? [])
    : null;

  const pendingSection = html`
    <p class="section-title">待機中の注文 (${pendingOrders.length})</p>
    ${pendingOrders.length
      ? html`
          <div class="card table-wrap">
            <table>
              <thead>
                <tr>
                  <th>銘柄</th>
                  <th>売買</th>
                  <th>戦略</th>
                  <th>指値</th>
                  <th>${tt("現在価格", "リアルタイム価格")}</th>
                  <th>${tt("乖離", "指値と現在価格の差（%）")}</th>
                  <th>数量</th>
                  <th>期限</th>
                  <th>状態</th>
                  <th>${tt("証券注文ID", "立花証券 sOrderNumber")}</th>
                </tr>
              </thead>
              <tbody>
                ${pendingOrders.map(
                  (o) => {
                    const tickerCode = o.stock?.tickerCode ?? o.stockId;
                    const orderPrice = o.limitPrice ? Number(o.limitPrice) : o.stopPrice ? Number(o.stopPrice) : null;

                    return html`
                    <tr data-quote-row data-ticker="${tickerCode}" data-order-price="${orderPrice ?? ""}">
                      <td>${tickerLink(tickerCode, `${tickerCode} ${o.stock?.name ?? o.stockId}`)}</td>
                      <td>${o.side === "buy" ? "買" : "売"}</td>
                      <td>${strategyBadge(o.strategy)}</td>
                      <td>
                        ${o.limitPrice
                          ? `¥${formatYen(Number(o.limitPrice))}`
                          : o.stopPrice
                            ? `¥${formatYen(Number(o.stopPrice))}(逆)`
                            : "-"}
                      </td>
                      <td data-quote-price><span class="quote-loading">...</span></td>
                      <td data-quote-deviation><span class="quote-loading">...</span></td>
                      <td>${o.quantity}</td>
                      <td>
                        ${o.expiresAt
                          ? dayjs(o.expiresAt).format("M/D H:mm")
                          : "-"}
                      </td>
                      <td style="font-size:0.85em;color:var(--text-muted)">${brokerStatusLabel(o.brokerStatus)}</td>
                      <td style="font-size:0.85em;color:var(--text-muted)">${o.brokerOrderId ?? "-"}</td>
                    </tr>
                  `;
                  },
                )}
              </tbody>
            </table>
          </div>
        `
      : html`<div class="card">${emptyState("待機中の注文なし")}</div>`}
  `;

  const historySection = html`
    <p class="section-title">取引履歴</p>
    ${recentOrders.length > 0
      ? html`
          <div class="card table-wrap">
            <table>
              <thead>
                <tr>
                  <th>日時</th>
                  <th>銘柄</th>
                  <th>売買</th>
                  <th>状態</th>
                  <th>約定</th>
                  <th>数量</th>
                </tr>
              </thead>
              <tbody>
                ${recentOrders.map(
                  (o) => html`
                    <tr>
                      <td style="white-space:nowrap">${dayjs(o.updatedAt).format("M/D H:mm")}</td>
                      <td>${tickerLink(o.stock?.tickerCode ?? o.stockId, `${o.stock?.tickerCode ?? o.stockId} ${o.stock?.name ?? o.stockId}`)}</td>
                      <td>${o.side === "buy" ? "買" : "売"}</td>
                      <td>${orderStatusBadge(o.status)}</td>
                      <td>
                        ${o.filledPrice
                          ? `¥${formatYen(Number(o.filledPrice))}`
                          : "-"}
                      </td>
                      <td>${o.quantity}</td>
                    </tr>
                  `,
                )}
              </tbody>
            </table>
          </div>
        `
      : html`<div class="card">${emptyState("取引履歴なし")}</div>`}
  `;

  const brokerStatusCodeLabel = (code: string): string => {
    const labels: Record<string, string> = {
      "0": "受付未済",
      "1": "未約定",
      "7": "取消完了",
      "9": "一部約定",
      "10": "全部約定",
      "12": "失効",
      "13": "逆指値待機",
      "15": "逆指値切替中",
      "16": "逆指値未約定",
      "50": "発注中",
    };
    return labels[code] ?? code;
  };

  const brokerSection = html`
    <p class="section-title">ブローカー注文一覧（API直取得）</p>
    ${brokerOrders === null
      ? html`<div class="card">${emptyState("取得失敗またはセッション未確立")}</div>`
      : !brokerOrders.length
        ? html`<div class="card">${emptyState("ブローカー注文なし")}</div>`
        : html`
            <div class="card table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>注文番号</th>
                    <th>営業日</th>
                    <th>銘柄</th>
                    <th>売買</th>
                    <th>状態</th>
                    <th>注文価格</th>
                    <th>数量</th>
                    <th>注文日時</th>
                    <th>${tt("DBマッチ", "DBのtradingOrderにbrokerOrderIdが存在するか")}</th>
                  </tr>
                </thead>
                <tbody>
                  ${brokerOrders.map((bo) => {
                    const orderNum = String(bo.sOrderOrderNumber ?? bo.sOrderNumber ?? "");
                    const businessDay = String(bo.sOrderSikkouDay ?? bo.sEigyouDay ?? "");
                    const issueCode = String(bo.sIssueCode ?? "");
                    const side = String(bo.sBaibaiKubun ?? "");
                    const statusCode = String(bo.sOrderStatusCode ?? bo.sOrderStatus ?? "");
                    const price = String(bo.sOrderPrice ?? "");
                    const qty = String(bo.sOrderSuryou ?? "");
                    const orderDt = String(bo.sOrderOrderDateTime ?? "");
                    const matched = dbOrderIdSet.has(orderNum);

                    const formattedDt = orderDt.length === 14
                      ? `${orderDt.slice(4, 6)}/${orderDt.slice(6, 8)} ${orderDt.slice(8, 10)}:${orderDt.slice(10, 12)}`
                      : orderDt;

                    return html`
                      <tr style="${matched ? "" : "background:rgba(220,50,50,0.07)"}">
                        <td style="font-size:0.85em;color:var(--text-muted)">${orderNum}</td>
                        <td style="font-size:0.85em;color:var(--text-muted)">${businessDay}</td>
                        <td>${issueCode}</td>
                        <td>${side === "3" ? "買" : side === "1" ? "売" : side}</td>
                        <td style="font-size:0.85em">${brokerStatusCodeLabel(statusCode)}</td>
                        <td>${price === "0" ? "成行" : price ? `¥${formatYen(Number(price))}` : "-"}</td>
                        <td>${qty}</td>
                        <td style="font-size:0.85em;color:var(--text-muted)">${formattedDt}</td>
                        <td style="font-weight:600;color:${matched ? "var(--success)" : "var(--danger)"}">
                          ${matched ? "一致" : "孤立 ⚠"}
                        </td>
                      </tr>
                    `;
                  })}
                </tbody>
              </table>
            </div>
          `}
  `;

  const content = html`${pendingSection}${historySection}${brokerSection}`;
  return c.html(layout("注文", "/orders", content));
});

export default app;
