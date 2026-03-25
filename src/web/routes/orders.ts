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
  orderStatusBadge,
  tickerLink,
  emptyState,
  tt,
} from "../views/components";
import { getWatchlist } from "../../jobs/watchlist-builder";
const app = new Hono();

app.get("/", async (c) => {
  const watchlist = getWatchlist();

  const tickers = watchlist.map((w) => w.ticker);
  const [stocks, recentOrders] = await Promise.all([
    tickers.length
      ? prisma.stock.findMany({
          where: { tickerCode: { in: tickers } },
          select: { tickerCode: true, name: true },
        })
      : Promise.resolve([]),
    prisma.tradingOrder.findMany({
      where: {
        status: { not: "pending" },
      },
      include: { stock: true },
      orderBy: { updatedAt: "desc" },
      take: QUERY_LIMITS.ORDER_HISTORY,
    }),
  ]);

  const nameMap = new Map(stocks.map((s) => [s.tickerCode, s.name]));

  const content = html`
    <p class="section-title">${tt("監視中のウォッチリスト", "毎朝8:00に構築。ブレイクアウト候補銘柄")} (${watchlist.length})</p>
    ${watchlist.length
      ? html`
          <div class="card table-wrap">
            <table>
              <thead>
                <tr>
                  <th>銘柄</th>
                  <th>${tt("現在価格", "リアルタイム価格")}</th>
                  <th>${tt("20日高値", "ブレイクアウト基準価格")}</th>
                  <th>${tt("乖離", "現在価格と20日高値の差（%）")}</th>
                </tr>
              </thead>
              <tbody>
                ${watchlist.map(
                  (w) => html`
                    <tr data-quote-row data-ticker="${w.ticker}" data-order-price="${w.high20}">
                      <td>${tickerLink(w.ticker, nameMap.get(w.ticker) ?? w.ticker)}</td>
                      <td data-quote-price><span class="quote-loading">...</span></td>
                      <td>¥${formatYen(w.high20)}</td>
                      <td data-quote-deviation><span class="quote-loading">...</span></td>
                    </tr>
                  `,
                )}
              </tbody>
            </table>
          </div>
        `
      : html`<div class="card">${emptyState("監視銘柄なし（8:00に構築）")}</div>`}

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
      : html`<div class="card">${emptyState("取引履歴なし")}</div>`}
  `;

  return c.html(layout("注文", "/orders", content));
});

export default app;
