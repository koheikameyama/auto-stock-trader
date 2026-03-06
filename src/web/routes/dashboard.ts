/**
 * ダッシュボードページ（GET /）
 */

import { Hono } from "hono";
import { html } from "hono/html";
import { prisma } from "../../lib/prisma";
import { getOpenPositions, getCashBalance } from "../../core/position-manager";
import { getPendingOrders } from "../../core/order-executor";
import { layout } from "../views/layout";
import {
  formatYen,
  pnlText,
  sentimentBadge,
  strategyBadge,
  emptyState,
  detailRow,
} from "../views/components";

// jobState is injected from worker.ts
export let jobState: {
  running: Set<string>;
  lastRun: Map<string, { startedAt: Date; completedAt?: Date; error?: string }>;
  startedAt: Date;
} = {
  running: new Set(),
  lastRun: new Map(),
  startedAt: new Date(),
};

export function setJobState(state: typeof jobState) {
  jobState = state;
}

const app = new Hono();

app.get("/", async (c) => {
  const token = c.req.query("token") ?? "";

  // Parallel data fetch
  const [
    config,
    assessment,
    openPositions,
    pendingOrders,
    latestSummary,
    cashBalance,
  ] = await Promise.all([
    prisma.tradingConfig.findFirst({ orderBy: { createdAt: "desc" } }),
    prisma.marketAssessment.findFirst({ orderBy: { date: "desc" } }),
    getOpenPositions(),
    getPendingOrders(),
    prisma.tradingDailySummary.findFirst({ orderBy: { date: "desc" } }),
    getCashBalance().catch(() => null),
  ]);

  const totalBudget = config ? Number(config.totalBudget) : 0;
  const cash = cashBalance ?? totalBudget;
  const investedValue = openPositions.reduce(
    (sum, p) => sum + Number(p.entryPrice) * p.quantity,
    0,
  );
  const portfolioValue = cash + investedValue;
  const totalPnl = portfolioValue - totalBudget;

  // Uptime
  const uptimeMs = Date.now() - jobState.startedAt.getTime();
  const uptimeH = Math.floor(uptimeMs / 3600000);
  const uptimeM = Math.floor((uptimeMs % 3600000) / 60000);

  // Selected stocks count
  const selectedStocks = assessment?.selectedStocks as
    | { tickerCode: string }[]
    | null;

  const content = html`
    <!-- System status -->
    <div class="card">
      <div class="card-title">システム状態</div>
      ${detailRow("稼働時間", `${uptimeH}h ${uptimeM}m`)}
      ${detailRow(
        "取引",
        config?.isActive
          ? html`<span style="color:#22c55e">ON</span>`
          : html`<span style="color:#ef4444">OFF</span>`,
      )}
      ${detailRow("実行中ジョブ", `${jobState.running.size > 0 ? [...jobState.running].join(", ") : "なし"}`)}
      ${detailRow("オープンポジション", `${openPositions.length}`)}
      ${detailRow("待機注文", `${pendingOrders.length}`)}
    </div>

    <!-- Portfolio -->
    <div class="grid-2">
      <div class="card">
        <div class="card-title">ポートフォリオ</div>
        <div class="card-value">¥${formatYen(portfolioValue)}</div>
        <div class="card-sub">${pnlText(totalPnl)}</div>
      </div>
      <div class="card">
        <div class="card-title">キャッシュ残高</div>
        <div class="card-value">¥${formatYen(cash)}</div>
        <div class="card-sub">予算: ¥${formatYen(totalBudget)}</div>
      </div>
    </div>

    <!-- Market Assessment -->
    <div class="card">
      <div class="card-title">市場評価</div>
      ${assessment
        ? html`
            <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px">
              ${sentimentBadge(assessment.sentiment)}
              <span style="font-size:13px;color:#94a3b8">
                ${assessment.shouldTrade ? "取引推奨" : "様子見"}
              </span>
            </div>
            ${detailRow(
              "日経225",
              assessment.nikkeiPrice
                ? `¥${formatYen(Number(assessment.nikkeiPrice))}`
                : "N/A",
            )}
            ${detailRow(
              "選定銘柄",
              `${selectedStocks?.length ?? 0}銘柄`,
            )}
            <details>
              <summary>判断理由</summary>
              <div class="review-text">${assessment.reasoning}</div>
            </details>
          `
        : emptyState("市場評価データなし")}
    </div>

    <!-- Open Positions -->
    <p class="section-title">オープンポジション</p>
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
                </tr>
              </thead>
              <tbody>
                ${openPositions.map(
                  (p) => html`
                    <tr>
                      <td>${(p as any).stock?.name ?? p.stockId}</td>
                      <td>${strategyBadge(p.strategy)}</td>
                      <td>¥${formatYen(Number(p.entryPrice))}</td>
                      <td>${p.quantity}</td>
                    </tr>
                  `,
                )}
              </tbody>
            </table>
          </div>
        `
      : html`<div class="card">${emptyState("オープンポジションなし")}</div>`}

    <!-- Latest Summary -->
    ${latestSummary
      ? html`
          <p class="section-title">最新日次サマリー</p>
          <div class="card">
            ${detailRow("日付", new Date(latestSummary.date).toLocaleDateString("ja-JP"))}
            ${detailRow("取引数", `${latestSummary.totalTrades}`)}
            ${detailRow("勝敗", `${latestSummary.wins}勝 ${latestSummary.losses}敗`)}
            ${detailRow("損益", pnlText(Number(latestSummary.totalPnl)))}
            ${latestSummary.aiReview
              ? html`
                  <details>
                    <summary>AIレビュー</summary>
                    <div class="review-text">${latestSummary.aiReview}</div>
                  </details>
                `
              : ""}
          </div>
        `
      : ""}
  `;

  return c.html(layout("ダッシュボード", "/", content, token));
});

export default app;
