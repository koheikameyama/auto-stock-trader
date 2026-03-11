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
  pnlText,
  pnlPercent,
  strategyBadge,
  orderStatusBadge,
  tickerLink,
  emptyState,
  tt,
} from "../views/components";
import { fetchStockQuotesBatch } from "../../core/market-data";

const app = new Hono();

app.get("/", async (c) => {


  const [pendingOrders, recentOrders] = await Promise.all([
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
      take: QUERY_LIMITS.ORDERS_TODAY,
    }),
  ]);

  // 待機中注文のリアルタイム価格を一括取得
  const pendingTickerCodes = pendingOrders
    .map((o) => o.stock?.tickerCode)
    .filter((t): t is string => t != null);
  const quotes = pendingTickerCodes.length > 0
    ? await fetchStockQuotesBatch(pendingTickerCodes)
    : new Map();

  const latestOrderDate = recentOrders.length > 0
    ? dayjs(recentOrders[0].updatedAt).format("M月D日")
    : dayjs().format("M月D日");

  const content = html`
    <p class="section-title">待機中の注文 (${pendingOrders.length})</p>
    ${pendingOrders.length > 0
      ? html`
          <div class="card table-wrap">
            <table>
              <thead>
                <tr>
                  <th>銘柄</th>
                  <th>売買</th>
                  <th>戦略</th>
                  <th>指値</th>
                  <th>${tt("現在価格", "Yahoo Financeからのリアルタイム価格")}</th>
                  <th>${tt("乖離", "指値と現在価格の差（%）")}</th>
                  <th>数量</th>
                  <th>期限</th>
                </tr>
              </thead>
              <tbody>
                ${pendingOrders.map(
                  (o) => {
                    const tickerCode = o.stock?.tickerCode ?? o.stockId;
                    const quote = quotes.get(tickerCode + ".T") ?? quotes.get(tickerCode);
                    const currentPrice = quote?.price ?? null;
                    const orderPrice = o.limitPrice ? Number(o.limitPrice) : o.stopPrice ? Number(o.stopPrice) : null;
                    const deviationPct = currentPrice != null && orderPrice != null
                      ? ((currentPrice - orderPrice) / orderPrice) * 100
                      : null;

                    return html`
                    <tr>
                      <td>${tickerLink(tickerCode, o.stock?.name ?? o.stockId)}</td>
                      <td>${o.side === "buy" ? "買" : "売"}</td>
                      <td>${strategyBadge(o.strategy)}</td>
                      <td>
                        ${o.limitPrice
                          ? `¥${formatYen(Number(o.limitPrice))}`
                          : o.stopPrice
                            ? `¥${formatYen(Number(o.stopPrice))}(逆)`
                            : "-"}
                      </td>
                      <td>${currentPrice != null ? `¥${formatYen(currentPrice)}` : "-"}</td>
                      <td>${deviationPct != null ? pnlPercent(deviationPct) : "-"}</td>
                      <td>${o.quantity}</td>
                      <td>
                        ${o.expiresAt
                          ? dayjs(o.expiresAt).format("M/D H:mm")
                          : "-"}
                      </td>
                    </tr>
                  `;
                  },
                )}
              </tbody>
            </table>
          </div>
        `
      : html`<div class="card">${emptyState("待機中の注文なし")}</div>`}

    <p class="section-title">${latestOrderDate}の注文履歴</p>
    ${recentOrders.length > 0
      ? html`
          <div class="card table-wrap">
            <table>
              <thead>
                <tr>
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
                      <td>${tickerLink(o.stock?.tickerCode ?? o.stockId, o.stock?.name ?? o.stockId)}</td>
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
      : html`<div class="card">${emptyState(`${latestOrderDate}の注文履歴なし`)}</div>`}
  `;

  return c.html(layout("注文", "/orders", content));
});

export default app;
