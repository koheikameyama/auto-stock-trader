/**
 * 週次レビューページ（GET /weekly）
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
  emptyState,
  sparklineChart,
  detailRow,
} from "../views/components";

const app = new Hono();

app.get("/", async (c) => {
  const summaries = await prisma.tradingWeeklySummary.findMany({
    orderBy: { weekEnd: "desc" },
    take: QUERY_LIMITS.WEEKLY_SUMMARIES,
  });

  const latest = summaries[0];

  // Cumulative PnL chart data (oldest first)
  const chartData = [...summaries].reverse().reduce<
    { label: string; value: number }[]
  >((acc, s) => {
    const prev = acc.length > 0 ? acc[acc.length - 1].value : 0;
    acc.push({
      label: dayjs(s.weekEnd).format("M/D"),
      value: prev + Number(s.totalPnl),
    });
    return acc;
  }, []);

  const content = html`
    <!-- Latest Week Summary -->
    <p class="section-title">最新の週次レビュー</p>
    ${latest
      ? html`
          <div class="card">
            <p style="color:#94a3b8;font-size:12px;margin-bottom:8px">
              ${dayjs(latest.weekStart).format("M/D")}〜${dayjs(latest.weekEnd).format("M/D")}
            </p>
            ${detailRow("週間損益", pnlText(Number(latest.totalPnl)))}
            ${detailRow(
              "勝敗",
              latest.totalTrades > 0
                ? `${latest.wins}W ${latest.losses}L`
                : "-",
            )}
            ${detailRow("取引数", `${latest.totalTrades}件`)}
            ${detailRow("ポートフォリオ", `¥${formatYen(Number(latest.portfolioValue))}`)}
            ${detailRow("現金残高", `¥${formatYen(Number(latest.cashBalance))}`)}
          </div>

          <!-- AI Review -->
          ${(() => {
            const review = latest.aiReview as {
              performance?: string;
              strengths?: string;
              improvements?: string;
              nextWeekStrategy?: string;
            } | null;
            if (!review) return "";
            return html`
              <p class="section-title">レビュー</p>
              ${review.performance
                ? html`<div class="card">
                    <p style="font-size:12px;color:#94a3b8;margin-bottom:4px">📊 パフォーマンス評価</p>
                    <p style="font-size:13px">${review.performance}</p>
                  </div>`
                : ""}
              ${review.strengths
                ? html`<div class="card">
                    <p style="font-size:12px;color:#94a3b8;margin-bottom:4px">💪 良かった点</p>
                    <p style="font-size:13px">${review.strengths}</p>
                  </div>`
                : ""}
              ${review.improvements
                ? html`<div class="card">
                    <p style="font-size:12px;color:#94a3b8;margin-bottom:4px">🔧 改善すべき点</p>
                    <p style="font-size:13px">${review.improvements}</p>
                  </div>`
                : ""}
              ${review.nextWeekStrategy
                ? html`<div class="card">
                    <p style="font-size:12px;color:#94a3b8;margin-bottom:4px">🎯 来週の戦略</p>
                    <p style="font-size:13px">${review.nextWeekStrategy}</p>
                  </div>`
                : ""}
            `;
          })()}
        `
      : html`<div class="card">${emptyState("週次レビューはまだありません")}</div>`}

    <!-- Cumulative PnL Chart -->
    <p class="section-title">累積損益（週次）</p>
    <div class="chart-container">
      ${chartData.length >= 2
        ? sparklineChart(chartData, 340, 140)
        : emptyState("データ不足")}
    </div>

    <!-- Weekly Summary Table -->
    <p class="section-title">過去の週次レビュー</p>
    ${summaries.length > 0
      ? html`
          <div class="card table-wrap responsive-table">
            <table>
              <thead>
                <tr>
                  <th>期間</th>
                  <th>取引</th>
                  <th>勝敗</th>
                  <th>損益</th>
                </tr>
              </thead>
              <tbody>
                ${summaries.map((s) => {
                  const review = s.aiReview as {
                    performance?: string;
                  } | null;
                  return html`
                    <tr>
                      <td data-label="期間">
                        ${dayjs(s.weekStart).format("M/D")}〜${dayjs(s.weekEnd).format("M/D")}
                      </td>
                      <td data-label="取引">${s.totalTrades}</td>
                      <td data-label="勝敗">
                        ${s.totalTrades > 0
                          ? `${s.wins}W ${s.losses}L`
                          : "-"}
                      </td>
                      <td data-label="損益">${pnlText(Number(s.totalPnl))}</td>
                    </tr>
                    ${review?.performance
                      ? html`
                          <tr class="review-row">
                            <td
                              colspan="4"
                              style="font-size:11px;color:#64748b;padding:4px 8px 12px"
                            >
                              ${review.performance}
                            </td>
                          </tr>
                        `
                      : ""}
                  `;
                })}
              </tbody>
            </table>
          </div>
        `
      : html`<div class="card">${emptyState("週次レビューなし")}</div>`}
  `;

  return c.html(layout("週次レビュー", "/weekly", content));
});

export default app;
