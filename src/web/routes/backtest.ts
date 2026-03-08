/**
 * バックテスト結果ページ（GET /backtest）
 */

import { Hono } from "hono";
import { html } from "hono/html";
import dayjs from "dayjs";
import { prisma } from "../../lib/prisma";
import { DAILY_BACKTEST } from "../../lib/constants";
import { layout } from "../views/layout";
import {
  formatYen,
  pnlText,
  pnlPercent,
  emptyState,
  detailRow,
  sparklineChart,
} from "../views/components";

const app = new Hono();

app.get("/", async (c) => {
  const trendDays = DAILY_BACKTEST.TREND_DAYS;
  const sinceDate = dayjs().subtract(trendDays, "day").toDate();

  const [latestResults, trendData] = await Promise.all([
    // 最新日の結果（4ティア）
    prisma.backtestDailyResult.findMany({
      orderBy: { date: "desc" },
      take: 4,
      distinct: ["budgetTier"],
    }),
    // トレンドデータ（過去30日、全ティア）
    prisma.backtestDailyResult.findMany({
      where: { date: { gte: sinceDate } },
      orderBy: { date: "asc" },
      select: {
        date: true,
        budgetTier: true,
        winRate: true,
        totalReturnPct: true,
        profitFactor: true,
        totalPnl: true,
        totalTrades: true,
        maxDrawdown: true,
      },
    }),
  ]);

  // ティア別にグループ化
  const trendByTier = new Map<string, typeof trendData>();
  for (const row of trendData) {
    const existing = trendByTier.get(row.budgetTier) ?? [];
    existing.push(row);
    trendByTier.set(row.budgetTier, existing);
  }

  const latestDate =
    latestResults.length > 0
      ? dayjs(latestResults[0].date).format("YYYY/M/D")
      : null;

  // ティア順にソート
  const tierOrder = DAILY_BACKTEST.BUDGET_TIERS.map((t) => t.label);
  const sortedLatest = [...latestResults].sort(
    (a, b) => tierOrder.indexOf(a.budgetTier) - tierOrder.indexOf(b.budgetTier),
  );

  const content = html`
    <!-- 最新結果 -->
    <p class="section-title">
      最新バックテスト結果${latestDate ? html` (${latestDate})` : ""}
    </p>
    ${sortedLatest.length > 0
      ? html`
          <div class="card table-wrap">
            <table>
              <thead>
                <tr>
                  <th>ティア</th>
                  <th>勝率</th>
                  <th>PF</th>
                  <th>リターン</th>
                  <th>DD</th>
                  <th>取引</th>
                </tr>
              </thead>
              <tbody>
                ${sortedLatest.map(
                  (r) => html`
                    <tr>
                      <td style="font-weight:600">${r.budgetTier}</td>
                      <td>${Number(r.winRate)}%</td>
                      <td>
                        ${Number(r.profitFactor) >= 999
                          ? "∞"
                          : Number(r.profitFactor)}
                      </td>
                      <td>${pnlPercent(Number(r.totalReturnPct))}</td>
                      <td style="color:#ef4444">
                        -${Number(r.maxDrawdown)}%
                      </td>
                      <td>${r.totalTrades}</td>
                    </tr>
                  `,
                )}
              </tbody>
            </table>
          </div>

          ${sortedLatest.map(
            (r) => html`
              <details style="margin:0 16px 8px">
                <summary>${r.budgetTier}ティア詳細</summary>
                <div class="card" style="margin:8px 0">
                  ${detailRow("初期資金", `¥${formatYen(r.initialBudget)}`)}
                  ${detailRow("価格上限", `¥${formatYen(r.maxPrice)}`)}
                  ${detailRow("勝率", `${Number(r.winRate)}%`)}
                  ${detailRow("勝敗", `${r.wins}勝 ${r.losses}敗`)}
                  ${detailRow("累計損益", pnlText(r.totalPnl))}
                  ${detailRow(
                    "リターン",
                    pnlPercent(Number(r.totalReturnPct)),
                  )}
                  ${detailRow(
                    "PF",
                    `${Number(r.profitFactor) >= 999 ? "∞" : Number(r.profitFactor)}`,
                  )}
                  ${detailRow("最大DD", `-${Number(r.maxDrawdown)}%`)}
                  ${detailRow(
                    "シャープレシオ",
                    r.sharpeRatio != null ? `${Number(r.sharpeRatio)}` : "N/A",
                  )}
                  ${detailRow(
                    "平均保有日数",
                    `${Number(r.avgHoldingDays)}日`,
                  )}
                  ${detailRow("対象銘柄数", `${r.tickerCount}`)}
                  ${detailRow("期間", `${r.periodStart} ~ ${r.periodEnd}`)}
                  ${detailRow(
                    "実行時間",
                    `${(r.executionTimeMs / 1000).toFixed(1)}秒`,
                  )}
                </div>
              </details>
            `,
          )}
        `
      : html`<div class="card">${emptyState("バックテスト結果なし")}</div>`}

    <!-- 勝率トレンド -->
    <p class="section-title">勝率トレンド（過去${trendDays}日）</p>
    ${trendByTier.size > 0
      ? html`
          ${DAILY_BACKTEST.BUDGET_TIERS.map((tier) => {
            const data = trendByTier.get(tier.label) ?? [];
            const chartData = data.map((d) => ({
              label: dayjs(d.date).format("M/D"),
              value: Number(d.winRate),
            }));
            return html`
              <div class="chart-container">
                <div
                  style="font-size:12px;color:#94a3b8;margin-bottom:4px;padding-left:8px"
                >
                  ${tier.label}
                </div>
                ${chartData.length >= 2
                  ? sparklineChart(chartData, 340, 80)
                  : emptyState("データ不足")}
              </div>
            `;
          })}
        `
      : html`<div class="card">${emptyState("トレンドデータなし")}</div>`}

    <!-- 履歴テーブル -->
    <p class="section-title">バックテスト履歴</p>
    ${trendData.length > 0
      ? html`
          <div class="card table-wrap">
            <table>
              <thead>
                <tr>
                  <th>日付</th>
                  <th>ティア</th>
                  <th>勝率</th>
                  <th>リターン</th>
                  <th>PF</th>
                </tr>
              </thead>
              <tbody>
                ${[...trendData].reverse().map(
                  (r) => html`
                    <tr>
                      <td>${dayjs(r.date).format("M/D")}</td>
                      <td>${r.budgetTier}</td>
                      <td>${Number(r.winRate)}%</td>
                      <td>${pnlPercent(Number(r.totalReturnPct))}</td>
                      <td>
                        ${Number(r.profitFactor) >= 999
                          ? "∞"
                          : Number(r.profitFactor)}
                      </td>
                    </tr>
                  `,
                )}
              </tbody>
            </table>
          </div>
        `
      : html`<div class="card">${emptyState("履歴なし")}</div>`}
  `;

  return c.html(layout("バックテスト", "/backtest", content));
});

export default app;
