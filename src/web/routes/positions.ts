/**
 * ポジションページ（GET /positions）
 */

import { Hono } from "hono";
import { html } from "hono/html";
import { prisma } from "../../lib/prisma";
import { layout } from "../views/layout";
import {
  formatYen,
  pnlText,
  strategyBadge,
  emptyState,
} from "../views/components";

const app = new Hono();

app.get("/", async (c) => {
  const token = c.req.query("token") ?? "";

  const [openPositions, closedPositions] = await Promise.all([
    prisma.tradingPosition.findMany({
      where: { status: "open" },
      include: { stock: true },
      orderBy: { createdAt: "desc" },
    }),
    prisma.tradingPosition.findMany({
      where: {
        status: "closed",
        exitedAt: { gte: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) },
      },
      include: { stock: true },
      orderBy: { exitedAt: "desc" },
      take: 20,
    }),
  ]);

  const content = html`
    <p class="section-title">オープンポジション (${openPositions.length})</p>
    ${openPositions.length > 0
      ? html`
          <div class="card table-wrap">
            <table>
              <thead>
                <tr>
                  <th>銘柄</th>
                  <th>戦略</th>
                  <th>建値</th>
                  <th>数量</th>
                  <th>利確</th>
                  <th>損切</th>
                </tr>
              </thead>
              <tbody>
                ${openPositions.map(
                  (p) => html`
                    <tr>
                      <td>${p.stock?.name ?? p.stockId}</td>
                      <td>${strategyBadge(p.strategy)}</td>
                      <td>¥${formatYen(Number(p.entryPrice))}</td>
                      <td>${p.quantity}</td>
                      <td>
                        ${p.takeProfitPrice
                          ? `¥${formatYen(Number(p.takeProfitPrice))}`
                          : "-"}
                      </td>
                      <td>
                        ${p.stopLossPrice
                          ? `¥${formatYen(Number(p.stopLossPrice))}`
                          : "-"}
                      </td>
                    </tr>
                  `,
                )}
              </tbody>
            </table>
          </div>
        `
      : html`<div class="card">${emptyState("オープンポジションなし")}</div>`}

    <p class="section-title">クローズ済み (直近7日)</p>
    ${closedPositions.length > 0
      ? html`
          <div class="card table-wrap">
            <table>
              <thead>
                <tr>
                  <th>銘柄</th>
                  <th>戦略</th>
                  <th>建値</th>
                  <th>決済</th>
                  <th>損益</th>
                </tr>
              </thead>
              <tbody>
                ${closedPositions.map(
                  (p) => html`
                    <tr>
                      <td>${p.stock?.name ?? p.stockId}</td>
                      <td>${strategyBadge(p.strategy)}</td>
                      <td>¥${formatYen(Number(p.entryPrice))}</td>
                      <td>
                        ${p.exitPrice
                          ? `¥${formatYen(Number(p.exitPrice))}`
                          : "-"}
                      </td>
                      <td>
                        ${p.realizedPnl
                          ? pnlText(Number(p.realizedPnl))
                          : "-"}
                      </td>
                    </tr>
                  `,
                )}
              </tbody>
            </table>
          </div>
        `
      : html`<div class="card">${emptyState("直近7日のクローズポジションなし")}</div>`}
  `;

  return c.html(layout("ポジション", "/positions", content, token));
});

export default app;
