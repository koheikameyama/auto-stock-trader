/**
 * 履歴ページ（GET /history）
 */

import { Hono } from "hono";
import { html } from "hono/html";
import { prisma } from "../../lib/prisma";
import { layout } from "../views/layout";
import {
  formatYen,
  pnlText,
  emptyState,
  sparklineChart,
} from "../views/components";

const app = new Hono();

app.get("/", async (c) => {
  const token = c.req.query("token") ?? "";

  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

  const summaries = await prisma.tradingDailySummary.findMany({
    where: { date: { gte: thirtyDaysAgo } },
    orderBy: { date: "desc" },
    take: 30,
  });

  // Cumulative PnL chart data (oldest first)
  const chartData = [...summaries].reverse().reduce<
    { label: string; value: number }[]
  >((acc, s) => {
    const prev = acc.length > 0 ? acc[acc.length - 1].value : 0;
    acc.push({
      label: new Date(s.date).toLocaleDateString("ja-JP", {
        month: "numeric",
        day: "numeric",
      }),
      value: prev + Number(s.totalPnl),
    });
    return acc;
  }, []);

  const content = html`
    <!-- PnL Chart -->
    <p class="section-title">累積損益（過去30日）</p>
    <div class="chart-container">
      ${chartData.length >= 2
        ? sparklineChart(chartData, 340, 140)
        : emptyState("データ不足")}
    </div>

    <!-- Daily Summary Table -->
    <p class="section-title">日次サマリー</p>
    ${summaries.length > 0
      ? html`
          <div class="card table-wrap">
            <table>
              <thead>
                <tr>
                  <th>日付</th>
                  <th>取引</th>
                  <th>勝敗</th>
                  <th>損益</th>
                  <th>PF値</th>
                </tr>
              </thead>
              <tbody>
                ${summaries.map(
                  (s) => html`
                    <tr>
                      <td>
                        ${new Date(s.date).toLocaleDateString("ja-JP", {
                          month: "numeric",
                          day: "numeric",
                        })}
                      </td>
                      <td>${s.totalTrades}</td>
                      <td>
                        ${s.totalTrades > 0
                          ? `${s.wins}W ${s.losses}L`
                          : "-"}
                      </td>
                      <td>${pnlText(Number(s.totalPnl))}</td>
                      <td>¥${formatYen(Number(s.portfolioValue))}</td>
                    </tr>
                    ${s.aiReview
                      ? html`
                          <tr>
                            <td
                              colspan="5"
                              style="font-size:11px;color:#64748b;padding:4px 8px 12px"
                            >
                              ${s.aiReview}
                            </td>
                          </tr>
                        `
                      : ""}
                  `,
                )}
              </tbody>
            </table>
          </div>
        `
      : html`<div class="card">${emptyState("日次サマリーなし")}</div>`}
  `;

  return c.html(layout("履歴", "/history", content, token));
});

export default app;
