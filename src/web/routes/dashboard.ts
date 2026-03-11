/**
 * ダッシュボードページ（GET /）
 */

import { Hono } from "hono";
import { html } from "hono/html";
import dayjs from "dayjs";
import { prisma } from "../../lib/prisma";
import { getOpenPositions, getCashBalance } from "../../core/position-manager";
import { getPendingOrders } from "../../core/order-executor";
import { layout } from "../views/layout";
import {
  formatYen,
  pnlText,
  pnlPercent,
  sentimentBadge,
  strategyBadge,
  emptyState,
  detailRow,
  tickerLink,
  tt,
} from "../views/components";
import { isMarketDay } from "../../lib/market-calendar";
import { fetchStockQuotesBatch } from "../../core/market-data";

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

  // オープンポジションのリアルタイム価格を一括取得
  const openTickerCodes = openPositions
    .map((p) => (p as any).stock?.tickerCode)
    .filter((t): t is string => t != null);
  const quotes = openTickerCodes.length > 0
    ? await fetchStockQuotesBatch(openTickerCodes)
    : new Map();

  const totalBudget = config ? Number(config.totalBudget) : 0;
  const cash = cashBalance ?? totalBudget;
  // リアルタイム価格で時価評価額を計算
  const investedValue = openPositions.reduce(
    (sum, p) => {
      const tickerCode = (p as any).stock?.tickerCode;
      const quote = tickerCode ? (quotes.get(tickerCode + ".T") ?? quotes.get(tickerCode)) : null;
      const price = quote?.price ?? Number(p.entryPrice);
      return sum + price * p.quantity;
    },
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

  const marketOpen = isMarketDay();

  const content = html`
    <!-- System status -->
    <div class="card">
      <div class="card-title">システム状態</div>
      ${detailRow("稼働時間", `${uptimeH}h ${uptimeM}m`)}
      ${detailRow(
        "市場",
        marketOpen
          ? html`<span style="color:#22c55e">開場</span>`
          : html`<span style="color:#f59e0b">休場</span>`,
      )}
      <div class="detail-row">
        <span class="detail-label">システム</span>
        <span style="display:flex;align-items:center;gap:8px">
          ${config?.isActive
            ? html`<span style="color:#22c55e">稼働中</span>`
            : html`<span style="color:#ef4444">停止中</span>`}
          <button
            id="toggleTrading"
            class="btn-toggle ${config?.isActive ? "btn-danger" : "btn-success"}"
            onclick="toggleSystem(${config?.isActive ? "false" : "true"})"
          >
            ${config?.isActive ? "緊急停止" : "再開"}
          </button>
        </span>
      </div>
      ${detailRow("実行中ジョブ", `${jobState.running.size > 0 ? [...jobState.running].join(", ") : "なし"}`)}
      ${detailRow(tt("オープンポジション", "現在保有中の建玉"), `${openPositions.length}`)}
      ${detailRow(tt("待機注文", "未約定・約定待ちの注文"), `${pendingOrders.length}`)}
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
                  <th>${tt("建値", "エントリー時の購入価格")}</th>
                  <th>数量</th>
                  <th>${tt("現在価格", "Yahoo Financeからのリアルタイム価格")}</th>
                  <th>${tt("含み損益", "（現在価格 − 建値）× 数量")}</th>
                </tr>
              </thead>
              <tbody>
                ${openPositions.map(
                  (p) => {
                    const tickerCode = (p as any).stock?.tickerCode ?? p.stockId;
                    const quote = quotes.get(tickerCode + ".T") ?? quotes.get(tickerCode);
                    const entryPrice = Number(p.entryPrice);
                    const currentPrice = quote?.price ?? null;
                    const unrealizedPnl = currentPrice != null ? (currentPrice - entryPrice) * p.quantity : null;

                    return html`
                    <tr>
                      <td>${tickerLink(tickerCode, (p as any).stock?.name ?? p.stockId)}</td>
                      <td>${strategyBadge(p.strategy)}</td>
                      <td>¥${formatYen(entryPrice)}</td>
                      <td>${p.quantity}</td>
                      <td>${currentPrice != null ? `¥${formatYen(currentPrice)}` : "-"}</td>
                      <td>${unrealizedPnl != null ? pnlText(unrealizedPnl) : "-"}</td>
                    </tr>
                  `;
                  },
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
            ${detailRow("日付", dayjs(latestSummary.date).format("YYYY/M/D"))}
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

    <script>
      function toggleSystem(active) {
        var btn = document.getElementById('toggleTrading');
        if (!btn) return;
        var action = active ? 'システムを再開' : 'システムを緊急停止';
        if (!confirm(action + 'しますか？')) return;
        btn.disabled = true;
        btn.textContent = '処理中...';
        var params = new URLSearchParams(window.location.search);
        var token = params.get('token') || '';
        fetch('/api/trading/toggle?token=' + encodeURIComponent(token), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ active: active }),
        })
        .then(function(res) {
          if (!res.ok) throw new Error('Failed');
          location.reload();
        })
        .catch(function() {
          alert('エラーが発生しました');
          btn.disabled = false;
          btn.textContent = active ? '再開' : '緊急停止';
        });
      }
    </script>
  `;

  return c.html(layout("ダッシュボード", "/", content));
});

export default app;
