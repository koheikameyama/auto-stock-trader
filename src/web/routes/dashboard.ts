/**
 * ダッシュボードページ（GET /）
 */

import { Hono } from "hono";
import { html } from "hono/html";
import dayjs from "dayjs";
import utc from "dayjs/plugin/utc.js";
import timezone from "dayjs/plugin/timezone.js";
import { prisma } from "../../lib/prisma";

dayjs.extend(utc);
dayjs.extend(timezone);
import { getOpenPositions, getCashBalance, getEffectiveCapital, computeRealizedPnl } from "../../core/position-manager";
import { getPendingOrders } from "../../core/order-executor";
import { layout } from "../views/layout";
import {
  formatYen,
  pnlText,
  pnlPercent,
  strategyBadge,
  emptyState,
  detailRow,
  signalRow,
  tickerLink,
  tt,
  nikkeiChartShell,
} from "../views/components";
import type { SignalStatus } from "../views/components";
import { isMarketDay } from "../../lib/market-date";
import { determineMarketRegime } from "../../core/market-regime";
import { calculateDrawdownStatus } from "../../core/drawdown-manager";
import { VIX_THRESHOLDS, CME_NIGHT_DIVERGENCE, DRAWDOWN, TIMEZONE } from "../../lib/constants";
import { isTachibanaProduction } from "../../lib/constants/broker";
import { COLORS } from "../views/styles";

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
    calculateDrawdownStatus().catch((): {
      weeklyDrawdownPct: number; monthlyDrawdownPct: number; shouldHaltTrading: boolean;
    } => ({
      weeklyDrawdownPct: 0, monthlyDrawdownPct: 0, shouldHaltTrading: false,
    })),
  ]);

  const totalBudget = config ? Number(config.totalBudget) : 0;
  const [effectiveCap, realizedPnl] = config
    ? await Promise.all([
        getEffectiveCapital(config).catch(() => Number(config.totalBudget)),
        computeRealizedPnl(),
      ])
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

  // Trading verdict: 3-gate check
  const vix = assessment?.vix ? Number(assessment.vix) : null;
  const regime = vix !== null ? determineMarketRegime(vix) : null;
  const canTrade =
    (regime ? !regime.shouldHaltTrading : false) &&
    (assessment?.shouldTrade ?? false) &&
    !drawdown.shouldHaltTrading;

  const marketOpen = isMarketDay();

  // Signal light logic
  const breadth = assessment?.breadth ? Number(assessment.breadth) : null;
  const breadthStatus: SignalStatus = breadth === null ? "warning"
    : breadth >= 0.60 ? "ok"
    : breadth >= 0.50 ? "warning"
    : "danger";
  const breadthText = breadth !== null ? `${(breadth * 100).toFixed(1)}%` : "N/A";

  const vixStatus: SignalStatus = vix === null ? "warning"
    : vix < VIX_THRESHOLDS.NORMAL ? "ok"
    : vix < VIX_THRESHOLDS.ELEVATED ? "warning"
    : "danger";
  const vixLabel = regime?.level
    ? { normal: "Normal", elevated: "Elevated", high: "High", crisis: "Crisis" }[regime.level]
    : "N/A";
  const vixText = vix !== null ? `${vix.toFixed(1)} ${vixLabel}` : "N/A";

  const cmeDivPct = assessment?.cmeDivergencePct ? Number(assessment.cmeDivergencePct) : null;
  const cmeStatus: SignalStatus = cmeDivPct === null ? "warning"
    : cmeDivPct > CME_NIGHT_DIVERGENCE.WARNING ? "ok"
    : cmeDivPct > CME_NIGHT_DIVERGENCE.CRITICAL ? "warning"
    : "danger";
  const cmeText = cmeDivPct !== null ? `${cmeDivPct >= 0 ? "+" : ""}${cmeDivPct.toFixed(1)}%` : "N/A";

  const ddStatus: SignalStatus = drawdown.shouldHaltTrading ? "danger"
    : (drawdown.weeklyDrawdownPct >= DRAWDOWN.WEEKLY_HALT_PCT * 0.6
      || drawdown.monthlyDrawdownPct >= DRAWDOWN.MONTHLY_HALT_PCT * 0.6) ? "warning"
    : "ok";
  const ddText = `週${drawdown.weeklyDrawdownPct.toFixed(1)}% / 月${drawdown.monthlyDrawdownPct.toFixed(1)}%`;

  // Broker login lock status
  const now = new Date();
  const brokerLock = {
    isLocked: !!(config?.loginLockedUntil && now < config.loginLockedUntil),
    lockedUntil: config?.loginLockedUntil ?? null,
    reason: config?.loginLockReason ?? null,
    occurredAt: config?.loginLockOccurredAt ?? null,
  };
  const overallEmoji = canTrade ? "\u{1F7E2}" : "\u{1F534}";
  const overallLabel = canTrade ? "トレード可" : "取引見送り";
  const overallColor = canTrade ? "#22c55e" : "#ef4444";

  // Market sentiment from 4 signals: ok=+1, warning=0, danger=-1
  const sentimentScore = [breadthStatus, vixStatus, cmeStatus, ddStatus]
    .reduce((sum, s) => sum + (s === "ok" ? 1 : s === "danger" ? -1 : 0), 0);
  const sentimentLabel = sentimentScore >= 2 ? "強気" : sentimentScore <= -2 ? "弱気" : "中立";
  const sentimentColor = sentimentScore >= 2 ? "#22c55e" : sentimentScore <= -2 ? "#ef4444" : "#f59e0b";
  const sentimentEmoji = sentimentScore >= 2 ? "\u{1F7E2}" : sentimentScore <= -2 ? "\u{1F534}" : "\u{1F7E1}";

  const content = html`
    <!-- Broker login lock banner -->
    ${brokerLock.isLocked
      ? html`
        <div style="background:#991b1b;border:1px solid #ef4444;border-radius:12px;padding:16px;margin-bottom:16px">
          <div style="font-weight:700;font-size:15px;margin-bottom:8px">🚨 ブローカーログインロック中（システム自動停止済み）</div>
          <div style="font-size:13px;color:#fca5a5">
            立花証券のログインがロックされています。手続き後にシステム再開ボタンを押してください。<br>
            📞 サポートセンター: <a href="tel:0336690777" style="color:#fca5a5">03-3669-0777</a> ／ 電話認証: <a href="tel:05031026575" style="color:#fca5a5">050-3102-6575</a>
            ${brokerLock.reason ? html`<br>理由: ${brokerLock.reason}` : ""}
            ${brokerLock.occurredAt ? html`<br>発生日時: ${dayjs(brokerLock.occurredAt).tz(TIMEZONE).format("YYYY-MM-DD HH:mm")}` : ""}
          </div>
        </div>`
      : ""}

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
      ${!config?.isActive
        ? detailRow("停止理由", (() => {
            const reason = brokerLock.reason;
            if (!reason) return html`<span style="color:#94a3b8">不明</span>`;
            if (reason === "手動停止") return html`<span style="color:#94a3b8">手動停止</span>`;
            const occurredStr = brokerLock.occurredAt ? ` (${dayjs(brokerLock.occurredAt).tz(TIMEZONE).format("MM/DD HH:mm")})` : "";
            return html`<span style="color:#fca5a5">${reason}${occurredStr}</span>`;
          })())
        : ""}
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
          ${isTachibanaProduction
            ? html`実質資金(API): ¥${formatYen(effectiveCap)}`
            : html`予算: <span id="budgetDisplay">¥${formatYen(totalBudget)}</span>
              <button class="btn-toggle btn-success" style="font-size:11px;padding:2px 8px" onclick="editBudget(${totalBudget})">変更</button>`}
        </div>
        <div class="card-sub">確定損益: ${pnlText(realizedPnl)}</div>
      </div>
    </div>

    <!-- Nikkei 225 Chart -->
    ${nikkeiChartShell()}

    <!-- Market Condition -->
    <div class="card">
      <div class="card-title">市場コンディション</div>
      ${assessment
        ? html`
            <div style="display:flex;align-items:center;gap:8px;margin-bottom:12px;font-size:16px;font-weight:700">
              <span>${overallEmoji}</span>
              <span style="color:${overallColor}">総合判定: ${overallLabel}</span>
              <span style="margin-left:auto;font-size:13px;color:${sentimentColor}">${sentimentEmoji} ${sentimentLabel}</span>
            </div>

            ${signalRow(tt("Breadth", "SMA25超の銘柄比率。60%以上でエントリー許可"), breadthText, breadthStatus)}
            ${signalRow(tt("VIX", "恐怖指数。20未満が通常、25超で警戒、30超で危機"), vixText, vixStatus)}
            ${signalRow(tt("CME乖離", "CME日経先物と前日終値の乖離率"), cmeText, cmeStatus)}
            ${signalRow(tt("ドローダウン", "週次5%/月次10%で取引停止"), ddText, ddStatus)}

            <div style="border-top:1px solid ${COLORS.border};margin-top:10px;padding-top:10px">
              <div style="font-size:11px;color:${COLORS.textMuted};margin-bottom:6px">米国市場（前日）</div>
              ${detailRow("S&P500", assessment.sp500Change != null ? pnlPercent(Number(assessment.sp500Change)) : "N/A")}
              ${detailRow("NASDAQ", assessment.nasdaqChange != null ? pnlPercent(Number(assessment.nasdaqChange)) : "N/A")}
              ${detailRow("DOW", assessment.dowChange != null ? pnlPercent(Number(assessment.dowChange)) : "N/A")}
              ${detailRow("SOX", assessment.soxChange != null ? pnlPercent(Number(assessment.soxChange)) : "N/A")}
              ${detailRow("USD/JPY", assessment.usdjpy != null ? Number(assessment.usdjpy).toFixed(1) : "N/A")}
            </div>

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
                    <summary>サマリー</summary>
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
        var msg = active
          ? 'システムを再開しますか？\\n\\n⚠️ 立花証券のログインに電話番号認証が必要な場合は、先に登録電話番号から 050-3102-6575 に発信して認証を完了してください。\\n再開ボタン押下でログインが実行されます。'
          : 'システムを緊急停止しますか？';
        if (!confirm(msg)) return;
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
          return res.json().then(function(data) {
            if (!res.ok) throw new Error(data.error || 'Failed');
            return data;
          });
        })
        .then(function() { location.reload(); })
        .catch(function(err) {
          alert('エラー: ' + (err && err.message ? err.message : '不明'));
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
