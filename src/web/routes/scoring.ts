/**
 * スコアリング結果ページ（GET /scoring）
 *
 * 1. 日付別一覧: その日のScoringRecord一覧（スコア降順）
 * 2. 銘柄別履歴: 指定銘柄の直近30日間のスコアリング推移
 */

import { Hono } from "hono";
import { html, raw } from "hono/html";
import dayjs from "dayjs";
import { prisma } from "../../lib/prisma";
import { QUERY_LIMITS, ROUTE_LOOKBACK_DAYS } from "../../lib/constants";
import { getDaysAgoForDB } from "../../lib/date-utils";
import { layout } from "../views/layout";
import {
  rankBadge,
  formatYen,
  pnlPercent,
  tickerLink,
  emptyState,
  tt,
} from "../views/components";

const app = new Hono();

/** AI判定バッジ */
function aiDecisionBadge(decision: string | null) {
  if (decision === "go")
    return html`<span class="badge" style="background:#22c55e20;color:#22c55e">Go</span>`;
  if (decision === "no_go")
    return html`<span class="badge" style="background:#ef444420;color:#ef4444">No Go</span>`;
  return html`<span class="badge" style="background:#64748b20;color:#64748b">-</span>`;
}

/** 理由バッジ */
function reasonBadge(reason: string | null) {
  if (!reason) return html`<span style="color:#64748b">-</span>`;
  const map: Record<string, { label: string; color: string }> = {
    market_halted: { label: "市場停止", color: "#f59e0b" },
    ai_no_go: { label: "AI却下", color: "#ef4444" },
    below_threshold: { label: "閾値未達", color: "#94a3b8" },
    disqualified: { label: "即死", color: "#dc2626" },
  };
  const info = map[reason] ?? { label: reason, color: "#94a3b8" };
  return html`<span class="badge" style="background:${info.color}20;color:${info.color}">${info.label}</span>`;
}

/** 内訳行を生成 */
function breakdownDetail(
  technical: Record<string, number> | null,
  pattern: Record<string, number> | null,
  liquidity: Record<string, number> | null,
  fundamental: Record<string, number> | null,
) {
  const items: string[] = [];

  if (technical) {
    const parts = [];
    if (technical.rsi != null) parts.push(`RSI:${technical.rsi}`);
    if (technical.ma != null) parts.push(`MA:${technical.ma}`);
    if (technical.volume != null) parts.push(`出来高:${technical.volume}`);
    if (technical.macd != null) parts.push(`MACD:${technical.macd}`);
    if (technical.rs != null) parts.push(`RS:${technical.rs}`);
    if (technical.volumeDirection != null) parts.push(`方向:${technical.volumeDirection}`);
    if (technical.weeklyTrendPenalty) parts.push(`週足減点:${technical.weeklyTrendPenalty}`);
    if (parts.length > 0) items.push(`技術: ${parts.join(" / ")}`);
  }
  if (pattern) {
    const parts = [];
    if (pattern.chart != null) parts.push(`チャート:${pattern.chart}`);
    if (pattern.candlestick != null) parts.push(`ローソク:${pattern.candlestick}`);
    if (parts.length > 0) items.push(`パターン: ${parts.join(" / ")}`);
  }
  if (liquidity) {
    const parts = [];
    if (liquidity.tradingValue != null) parts.push(`売買代金:${liquidity.tradingValue}`);
    if (liquidity.spreadProxy != null) parts.push(`スプレッド:${liquidity.spreadProxy}`);
    if (liquidity.stability != null) parts.push(`安定性:${liquidity.stability}`);
    if (parts.length > 0) items.push(`流動性: ${parts.join(" / ")}`);
  }
  if (fundamental) {
    const parts = [];
    if (fundamental.per != null) parts.push(`PER:${fundamental.per}`);
    if (fundamental.pbr != null) parts.push(`PBR:${fundamental.pbr}`);
    if (fundamental.profitability != null) parts.push(`収益性:${fundamental.profitability}`);
    if (fundamental.marketCap != null) parts.push(`時価総額:${fundamental.marketCap}`);
    if (parts.length > 0) items.push(`ファンダ: ${parts.join(" / ")}`);
  }

  return items.join("　|　");
}

/** カテゴリスコアをコンパクトに表示 */
function scoreBreakdownCompact(tech: number, pat: number, liq: number, fund: number) {
  return html`<span style="font-size:0.8rem">技<b>${tech}</b> パ<b>${pat}</b> 流<b>${liq}</b> フ<b>${fund}</b></span>`;
}

// ---- 日付別一覧 ----
app.get("/", async (c) => {
  const dateParam = c.req.query("date");
  const targetDate = dateParam
    ? new Date(`${dateParam}T00:00:00Z`)
    : (() => {
        const now = new Date();
        const jstDate = new Date(now.getTime() + 9 * 60 * 60 * 1000);
        const y = jstDate.getUTCFullYear();
        const m = jstDate.getUTCMonth();
        const d = jstDate.getUTCDate();
        return new Date(Date.UTC(y, m, d));
      })();

  const dateStr = dayjs(targetDate).format("YYYY-MM-DD");
  const prevDate = dayjs(targetDate).subtract(1, "day").format("YYYY-MM-DD");
  const nextDate = dayjs(targetDate).add(1, "day").format("YYYY-MM-DD");

  const records = await prisma.scoringRecord.findMany({
    where: { date: targetDate },
    orderBy: { totalScore: "desc" },
  });

  // 銘柄名を一括取得（N+1回避）
  const tickerCodes = [...new Set(records.map((r) => r.tickerCode))];
  const stocks = await prisma.stock.findMany({
    where: { tickerCode: { in: tickerCodes } },
    select: { tickerCode: true, name: true },
  });
  const nameMap = new Map(stocks.map((s) => [s.tickerCode, s.name]));

  // サマリー集計
  const rankCounts: Record<string, number> = { S: 0, A: 0, B: 0, C: 0 };
  let disqualifiedCount = 0;
  for (const r of records) {
    rankCounts[r.rank] = (rankCounts[r.rank] ?? 0) + 1;
    if (r.isDisqualified) disqualifiedCount++;
  }

  const content = html`
    <!-- 日付ナビ -->
    <div style="display:flex;align-items:center;justify-content:space-between;margin:0 16px 1rem">
      <a href="/scoring?date=${prevDate}" style="color:#3b82f6;text-decoration:none;font-size:1.2rem;padding:8px">&larr;</a>
      <span style="font-size:1rem;font-weight:600">${dateStr}</span>
      <a href="/scoring?date=${nextDate}" style="color:#3b82f6;text-decoration:none;font-size:1.2rem;padding:8px">&rarr;</a>
    </div>

    <!-- サマリー -->
    <div class="card" style="display:grid;grid-template-columns:repeat(3,1fr);gap:0.75rem;text-align:center;margin-bottom:0.5rem">
      <div>
        <div style="color:#94a3b8;font-size:0.75rem">件数</div>
        <div style="font-size:1.2rem;font-weight:700">${records.length}</div>
      </div>
      <div>
        <div style="color:#94a3b8;font-size:0.75rem">ランク分布</div>
        <div style="font-size:0.85rem;font-weight:600">
          <span style="color:#f59e0b">S:${rankCounts.S ?? 0}</span>
          <span style="color:#3b82f6;margin-left:4px">A:${rankCounts.A ?? 0}</span>
          <span style="color:#22c55e;margin-left:4px">B:${rankCounts.B ?? 0}</span>
          <span style="color:#94a3b8;margin-left:4px">C:${rankCounts.C ?? 0}</span>
        </div>
      </div>
      <div>
        <div style="color:#94a3b8;font-size:0.75rem">即死棄却</div>
        <div style="font-size:1.2rem;font-weight:700;color:${disqualifiedCount > 0 ? "#ef4444" : "#64748b"}">${disqualifiedCount}</div>
      </div>
    </div>

    <!-- 銘柄一覧（カード形式 — スマホ対応） -->
    ${records.length > 0
      ? records.map((r) => {
          const name = nameMap.get(r.tickerCode) ?? "";
          const detail = breakdownDetail(
            r.technicalBreakdown as Record<string, number> | null,
            r.patternBreakdown as Record<string, number> | null,
            r.liquidityBreakdown as Record<string, number> | null,
            r.fundamentalBreakdown as Record<string, number> | null,
          );
          const cardOpacity = r.isDisqualified ? "opacity:0.5;" : "";
          return html`
            <div class="card scoring-card" style="${cardOpacity}cursor:pointer" onclick="toggleScoringDetail(this)">
              <!-- ヘッダー行: 銘柄コード + スコア + ランク -->
              <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:0.35rem">
                <div onclick="event.stopPropagation()">
                  ${tickerLink(r.tickerCode)}
                  <span style="color:#94a3b8;font-size:0.75rem;margin-left:0.35rem">${name}</span>
                  <a href="/scoring/${r.tickerCode}" style="color:#64748b;font-size:0.7rem;margin-left:0.35rem;text-decoration:none" onclick="event.stopPropagation()">履歴</a>
                </div>
                <div style="display:flex;align-items:center;gap:0.5rem">
                  <span style="font-size:1.1rem;font-weight:700">${r.totalScore}</span>
                  ${rankBadge(r.rank)}
                </div>
              </div>
              <!-- カテゴリスコア + AI判定 -->
              <div style="display:flex;align-items:center;justify-content:space-between;font-size:0.8rem;color:#94a3b8">
                <div>
                  技<span style="color:#e2e8f0;font-weight:600">${r.technicalScore}</span>
                  パ<span style="color:#e2e8f0;font-weight:600;margin-left:0.35rem">${r.patternScore}</span>
                  流<span style="color:#e2e8f0;font-weight:600;margin-left:0.35rem">${r.liquidityScore}</span>
                  フ<span style="color:#e2e8f0;font-weight:600;margin-left:0.35rem">${r.fundamentalScore}</span>
                </div>
                <div style="display:flex;align-items:center;gap:0.35rem">
                  ${aiDecisionBadge(r.aiDecision)}
                  ${r.rejectionReason ? reasonBadge(r.rejectionReason) : ""}
                </div>
              </div>
              <!-- 展開エリア（内訳詳細） -->
              <div class="scoring-detail" style="display:none;margin-top:0.5rem;padding-top:0.5rem;border-top:1px solid #334155;font-size:0.78rem;color:#94a3b8">
                ${detail || "内訳データなし"}
                ${r.aiReasoning
                  ? html`<div style="margin-top:0.25rem;color:#cbd5e1">AI: ${r.aiReasoning}</div>`
                  : ""}
                ${r.entryPrice
                  ? html`<div style="margin-top:0.25rem">エントリー: ¥${formatYen(Number(r.entryPrice))}${r.ghostProfitPct != null ? html` → ${pnlPercent(Number(r.ghostProfitPct))}` : ""}</div>`
                  : ""}
              </div>
            </div>
          `;
        })
      : html`<div class="card">${emptyState("この日のスコアリングデータはありません")}</div>`}

    <script>
      function toggleScoringDetail(card) {
        var detail = card.querySelector('.scoring-detail');
        if (detail) {
          detail.style.display = detail.style.display === 'none' ? '' : 'none';
        }
      }
    </script>
  `;

  return c.html(layout("スコアリング", "/scoring", content));
});

// ---- 銘柄別履歴 ----
app.get("/:tickerCode", async (c) => {
  const tickerCode = c.req.param("tickerCode");
  const since = getDaysAgoForDB(ROUTE_LOOKBACK_DAYS.SCORING_HISTORY);

  const [records, stock] = await Promise.all([
    prisma.scoringRecord.findMany({
      where: {
        tickerCode,
        date: { gte: since },
      },
      orderBy: { date: "desc" },
      take: QUERY_LIMITS.SCORING_RECORDS,
    }),
    prisma.stock.findFirst({
      where: { tickerCode },
      select: { tickerCode: true, name: true },
    }),
  ]);

  const stockName = stock?.name ?? tickerCode;

  const content = html`
    <div style="margin:0 16px 1rem">
      <a href="/scoring" style="color:#3b82f6;text-decoration:none;font-size:0.85rem">&larr; 一覧に戻る</a>
    </div>

    <p class="section-title">${tickerCode} ${stockName}（直近${ROUTE_LOOKBACK_DAYS.SCORING_HISTORY}日）</p>

    ${records.length > 0
      ? records.map((r) => {
          const rowOpacity = r.isDisqualified ? "opacity:0.5;" : "";
          return html`
            <div class="card" style="${rowOpacity}">
              <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:0.35rem">
                <a href="/scoring?date=${dayjs(r.date).format("YYYY-MM-DD")}" style="color:#3b82f6;text-decoration:none;font-weight:600">${dayjs(r.date).format("M/D")}</a>
                <div style="display:flex;align-items:center;gap:0.5rem">
                  <span style="font-size:1.1rem;font-weight:700">${r.totalScore}</span>
                  ${rankBadge(r.rank)}
                </div>
              </div>
              <div style="display:flex;align-items:center;justify-content:space-between;font-size:0.8rem;color:#94a3b8">
                <div>
                  技<span style="color:#e2e8f0;font-weight:600">${r.technicalScore}</span>
                  パ<span style="color:#e2e8f0;font-weight:600;margin-left:0.35rem">${r.patternScore}</span>
                  流<span style="color:#e2e8f0;font-weight:600;margin-left:0.35rem">${r.liquidityScore}</span>
                  フ<span style="color:#e2e8f0;font-weight:600;margin-left:0.35rem">${r.fundamentalScore}</span>
                </div>
                <div style="display:flex;align-items:center;gap:0.35rem">
                  ${aiDecisionBadge(r.aiDecision)}
                  ${r.ghostProfitPct != null ? pnlPercent(Number(r.ghostProfitPct)) : ""}
                </div>
              </div>
            </div>
          `;
        })
      : html`<div class="card">${emptyState("この銘柄のスコアリングデータはありません")}</div>`}
  `;

  return c.html(layout(`${tickerCode} スコア履歴`, "/scoring", content));
});

export default app;
