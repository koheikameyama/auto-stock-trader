/**
 * ダッシュボードページ（GET /）
 */

import { Hono } from "hono";
import { html } from "hono/html";
import dayjs from "dayjs";
import { prisma } from "../../lib/prisma";
import { getOpenPositions, getCashBalance, getEffectiveCapital, computeRealizedPnl } from "../../core/position-manager";
import { getPendingOrders } from "../../core/order-executor";
import { layout } from "../views/layout";
import {
  formatYen,
  pnlText,
  sentimentBadge,
  strategyBadge,
  emptyState,
  detailRow,
  tickerLink,
  tt,
  nikkeiChartShell,
} from "../views/components";
import { isMarketDay } from "../../lib/market-calendar";
import { determineMarketRegime } from "../../core/market-regime";
import { calculateDrawdownStatus } from "../../core/drawdown-manager";

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
    drawdown,
  ] = await Promise.all([
    prisma.tradingConfig.findFirst({ orderBy: { createdAt: "desc" } }),
    prisma.marketAssessment.findFirst({ orderBy: { date: "desc" } }),
    getOpenPositions(),
    getPendingOrders(),
    prisma.tradingDailySummary.findFirst({ orderBy: { date: "desc" } }),
    getCashBalance().catch(() => null),
    calculateDrawdownStatus(),
  ]);

  const totalBudget = config ? Number(config.totalBudget) : 0;
  const [effectiveCap, realizedPnl] = config
    ? [await getEffectiveCapital(config), await computeRealizedPnl()]
    : [0, 0];
  const cash = cashBalance ?? effectiveCap;
  // 初期表示は建値ベース（リアルタイム価格はクライアント側で非同期取得）
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

  // Trading verdict: 3-gate check
  const vix = assessment?.vix ? Number(assessment.vix) : null;
  const regime = vix !== null ? determineMarketRegime(vix) : null;
  const canTrade =
    (regime ? !regime.shouldHaltTrading : false) &&
    (assessment?.shouldTrade ?? false) &&
    !drawdown.shouldHaltTrading;

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
    <div class="grid-2" data-portfolio data-cash="${cash}" data-total-budget="${totalBudget}">
      <div class="card">
        <div class="card-title">ポートフォリオ</div>
        <div class="card-value" data-portfolio-total>¥${formatYen(portfolioValue)}</div>
        <div class="card-sub" data-portfolio-pnl>${pnlText(totalPnl)}</div>
      </div>
      <div class="card">
        <div class="card-title">キャッシュ残高</div>
        <div class="card-value">¥${formatYen(cash)}</div>
        <div class="card-sub" style="display:flex;align-items:center;gap:6px">
          予算: <span id="budgetDisplay">¥${formatYen(totalBudget)}</span>
          <button class="btn-toggle btn-success" style="font-size:11px;padding:2px 8px" onclick="editBudget(${totalBudget})">変更</button>
        </div>
        <div class="card-sub">確定損益: ${pnlText(realizedPnl)}</div>
      </div>
    </div>

    <!-- Nikkei 225 Chart -->
    ${nikkeiChartShell()}

    <!-- Market Assessment + Trading Verdict -->
    <div class="card">
      <div class="card-title">市場評価</div>
      ${assessment
        ? html`
            <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px">
              ${canTrade
                ? html`<span class="badge" style="background:#22c55e20;color:#22c55e;font-size:14px;padding:6px 12px">取引許可</span>`
                : html`<span class="badge" style="background:#ef444420;color:#ef4444;font-size:14px;padding:6px 12px">取引見送り</span>`}
              ${sentimentBadge(assessment.sentiment)}
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
                    const tickerCode = p.stock?.tickerCode ?? p.stockId;
                    const entryPrice = Number(p.entryPrice);

                    return html`
                    <tr data-quote-row data-ticker="${tickerCode}" data-entry-price="${entryPrice}" data-quantity="${p.quantity}">
                      <td>${tickerLink(tickerCode, p.stock?.name ?? p.stockId)}</td>
                      <td>${strategyBadge(p.strategy)}</td>
                      <td>¥${formatYen(entryPrice)}</td>
                      <td>${p.quantity}</td>
                      <td data-quote-price><span class="quote-loading">...</span></td>
                      <td data-quote-pnl><span class="quote-loading">...</span></td>
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

      function editBudget(current) {
        var input = prompt('新しい予算（入金額）を入力してください（円）:', current);
        if (!input) return;
        var newBudget = parseInt(input, 10);
        if (isNaN(newBudget) || newBudget <= 0) {
          alert('有効な金額を入力してください');
          return;
        }
        var params = new URLSearchParams(window.location.search);
        var token = params.get('token') || '';
        fetch('/api/config/budget?token=' + encodeURIComponent(token), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ totalBudget: newBudget }),
        })
        .then(function(res) {
          if (!res.ok) throw new Error('Failed');
          location.reload();
        })
        .catch(function() {
          alert('予算の更新に失敗しました');
        });
      }
    </script>
  `;

  return c.html(layout("ダッシュボード", "/", content));
});

export default app;
