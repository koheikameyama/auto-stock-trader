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
  nikkeiChartShell,
  rankBadge,
  scoreBar,
} from "../views/components";
import { SCORING, SECTOR_MOMENTUM_SCORING } from "../../lib/constants/scoring";
import { COLORS } from "../views/styles";
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

  // --- Scoring summary data ---
  const latestScoringDate = await prisma.scoringRecord.findFirst({
    orderBy: { date: "desc" },
    select: { date: true },
  });

  const scoringDate = latestScoringDate?.date ?? null;
  let todayScoring: Awaited<ReturnType<typeof prisma.scoringRecord.findMany>> = [];
  let prevScoring: Pick<
    Awaited<ReturnType<typeof prisma.scoringRecord.findMany>>[number],
    "totalScore" | "rank" | "trendQualityScore" | "entryTimingScore" | "riskQualityScore" | "sectorMomentumScore" | "isDisqualified"
  >[] = [];

  if (scoringDate) {
    const prevDate = await prisma.scoringRecord.findFirst({
      where: { date: { lt: scoringDate } },
      orderBy: { date: "desc" },
      select: { date: true },
    });

    [todayScoring, prevScoring] = await Promise.all([
      prisma.scoringRecord.findMany({
        where: { date: scoringDate },
        orderBy: { totalScore: "desc" },
      }),
      prevDate
        ? prisma.scoringRecord.findMany({
            where: { date: prevDate.date },
            select: {
              totalScore: true,
              rank: true,
              trendQualityScore: true,
              entryTimingScore: true,
              riskQualityScore: true,
              sectorMomentumScore: true,
              isDisqualified: true,
            },
          })
        : Promise.resolve([]),
    ]);
  }

  // Stock names for top tickers (avoid N+1)
  const topTickers = todayScoring.slice(0, 5).map((r) => r.tickerCode);
  const scoringStocks =
    topTickers.length > 0
      ? await prisma.stock.findMany({
          where: { tickerCode: { in: topTickers } },
          select: { tickerCode: true, name: true },
        })
      : [];
  const scoringNameMap = new Map(scoringStocks.map((s) => [s.tickerCode, s.name]));

  // Rank distribution
  const rankCounts: Record<string, number> = { S: 0, A: 0, B: 0, C: 0, D: 0 };
  let disqualifiedCount = 0;
  for (const r of todayScoring) {
    rankCounts[r.rank] = (rankCounts[r.rank] ?? 0) + 1;
    if (r.isDisqualified) disqualifiedCount++;
  }

  const prevRankCounts: Record<string, number> = { S: 0, A: 0, B: 0, C: 0, D: 0 };
  for (const r of prevScoring) {
    prevRankCounts[r.rank] = (prevRankCounts[r.rank] ?? 0) + 1;
  }

  // Category averages (non-disqualified only)
  const activeRecords = todayScoring.filter((r) => !r.isDisqualified);
  const n = activeRecords.length || 1;
  const avgTrend = activeRecords.reduce((s, r) => s + r.trendQualityScore, 0) / n;
  const avgEntry = activeRecords.reduce((s, r) => s + r.entryTimingScore, 0) / n;
  const avgRisk = activeRecords.reduce((s, r) => s + r.riskQualityScore, 0) / n;
  const avgSector = activeRecords.reduce((s, r) => s + r.sectorMomentumScore, 0) / n;

  const categoryPcts = [
    { name: "トレンド品質", avg: avgTrend, max: SCORING.CATEGORY_MAX.TREND_QUALITY },
    { name: "エントリータイミング", avg: avgEntry, max: SCORING.CATEGORY_MAX.ENTRY_TIMING },
    { name: "リスク品質", avg: avgRisk, max: SCORING.CATEGORY_MAX.RISK_QUALITY },
    { name: "セクターモメンタム", avg: avgSector, max: SECTOR_MOMENTUM_SCORING.CATEGORY_MAX },
  ].map((c) => ({ ...c, pct: c.max > 0 ? (c.avg / c.max) * 100 : 0 }));
  categoryPcts.sort((a, b) => a.pct - b.pct);
  const bottleneck = categoryPcts[0];

  // Previous day comparison
  const prevActive = prevScoring.filter((r) => !r.isDisqualified);
  const pn = prevActive.length || 1;
  const todayAvgScore = activeRecords.reduce((s, r) => s + r.totalScore, 0) / n;
  const prevAvgScore = prevActive.reduce((s, r) => s + r.totalScore, 0) / pn;
  const scoreDiff = todayAvgScore - prevAvgScore;
  const hasPrev = prevScoring.length > 0;

  const totalBudget = config ? Number(config.totalBudget) : 0;
  const cash = cashBalance ?? totalBudget;
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
        <div class="card-sub">予算: ¥${formatYen(totalBudget)}</div>
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

    <!-- Scoring Summary -->
    ${todayScoring.length > 0
      ? html`
          <p class="section-title">
            スコアリングサマリー
            <span style="font-size:11px;color:${COLORS.textDim};font-weight:400;margin-left:8px">
              ${dayjs(scoringDate).format("M/D")}
            </span>
          </p>

          <!-- Rank distribution -->
          <div class="card">
            <div class="card-title">ランク分布</div>
            <div style="display:flex;justify-content:space-around;text-align:center;margin:8px 0">
              ${["S", "A", "B", "C", "D"].map((rank) => {
                const colorMap: Record<string, string> = {
                  S: "#f59e0b",
                  A: "#3b82f6",
                  B: "#22c55e",
                  C: "#94a3b8",
                  D: "#64748b",
                };
                const color = colorMap[rank] ?? "#94a3b8";
                const count = rankCounts[rank] ?? 0;
                const diff = count - (prevRankCounts[rank] ?? 0);
                return html`
                  <div>
                    <div style="font-size:11px;color:${color};font-weight:600">${rank}</div>
                    <div style="font-size:20px;font-weight:700;color:${color}">${count}</div>
                    ${hasPrev && diff !== 0
                      ? html`<div style="font-size:10px;color:${diff > 0 ? COLORS.profit : COLORS.loss}">
                          ${diff > 0 ? "+" : ""}${diff}
                        </div>`
                      : html``}
                  </div>
                `;
              })}
            </div>
            ${disqualifiedCount > 0
              ? html`<div style="font-size:11px;color:${COLORS.textDim};text-align:center">
                  即死棄却: ${disqualifiedCount}件
                </div>`
              : html``}
            ${rankCounts["S"] === 0
              ? html`<div style="margin-top:8px;padding:8px 12px;background:${COLORS.bg};border-radius:8px;border-left:3px solid ${COLORS.warning};font-size:12px;color:${COLORS.warning}">
                  Sランク該当なし — ボトルネック: ${bottleneck.name}（達成率${bottleneck.pct.toFixed(0)}%）
                </div>`
              : html``}
          </div>

          <!-- Category bottleneck -->
          <div class="card">
            <div class="card-title">カテゴリ平均（ボトルネック分析）</div>
            ${categoryPcts.map((cat) => {
              const isBottleneck = cat === bottleneck;
              const barColor = isBottleneck ? COLORS.warning : COLORS.accent;
              return scoreBar(
                isBottleneck
                  ? html`<span style="color:${COLORS.warning}">${cat.name} ★</span>`
                  : cat.name,
                Math.round(cat.avg * 10) / 10,
                cat.max,
                barColor,
              );
            })}
            ${hasPrev
              ? detailRow(
                  "前日比（平均スコア）",
                  scoreDiff >= 0
                    ? html`<span class="pnl-positive">+${scoreDiff.toFixed(1)}</span>`
                    : html`<span class="pnl-negative">${scoreDiff.toFixed(1)}</span>`,
                )
              : html``}
          </div>

          <!-- Top stocks -->
          <div class="card">
            <div class="card-title">トップ銘柄</div>
            ${todayScoring.slice(0, 5).map(
              (r) => html`
                <div style="display:flex;align-items:center;justify-content:space-between;padding:6px 0;border-bottom:1px solid ${COLORS.border}">
                  <div>
                    ${tickerLink(r.tickerCode, scoringNameMap.get(r.tickerCode) ?? r.tickerCode)}
                    <span style="font-size:10px;color:${COLORS.textDim};margin-left:4px">
                      趨${r.trendQualityScore} 入${r.entryTimingScore} 危${r.riskQualityScore} 業${r.sectorMomentumScore}
                    </span>
                  </div>
                  <div style="display:flex;align-items:center;gap:6px">
                    <span style="font-weight:700">${r.totalScore}</span>
                    ${rankBadge(r.rank)}
                  </div>
                </div>
              `,
            )}
            <div style="text-align:center;margin-top:8px">
              <a href="/scoring" style="font-size:12px;color:${COLORS.accent}">全件を見る →</a>
            </div>
          </div>
        `
      : html``}

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
                    const entryPrice = Number(p.entryPrice);

                    return html`
                    <tr data-quote-row data-ticker="${tickerCode}" data-entry-price="${entryPrice}" data-quantity="${p.quantity}">
                      <td>${tickerLink(tickerCode, (p as any).stock?.name ?? p.stockId)}</td>
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
    </script>
  `;

  return c.html(layout("ダッシュボード", "/", content));
});

export default app;
