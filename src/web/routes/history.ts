/**
 * 履歴ページ（GET /history）
 *
 * 振り返りカード3つ + 日次サマリーテーブル
 */

import { Hono } from "hono";
import { html } from "hono/html";
import dayjs from "dayjs";
import { prisma } from "../../lib/prisma";
import { getPositionPnl } from "../../core/position-manager";
import { QUERY_LIMITS, ROUTE_LOOKBACK_DAYS } from "../../lib/constants";
import { COLORS } from "../views/styles";
import { layout } from "../views/layout";
import {
  formatYen,
  pnlText,
  emptyState,
  sparklineChart,
  miniBarChart,
  detailRow,
  signalRow,
  tt,
} from "../views/components";
import type { SignalStatus } from "../views/components";

const app = new Hono();

/** exitSnapshot から exitReason を安全に取り出す */
function getExitReason(snapshot: unknown): string {
  if (snapshot && typeof snapshot === "object" && "exitReason" in snapshot) {
    return String((snapshot as { exitReason: string }).exitReason);
  }
  return "unknown";
}

/** exitReason を4分類にまとめる */
function classifyExit(reason: string): "sl" | "trailing" | "time_stop" | "other" {
  if (reason === "stop_loss") return "sl";
  if (reason === "trailing_profit") return "trailing";
  if (reason === "time_stop") return "time_stop";
  return "other";
}

const EXIT_COLORS: Record<string, string> = {
  sl: "#ef4444",
  trailing: "#22c55e",
  time_stop: "#f59e0b",
  other: "#64748b",
};

const EXIT_LABELS: Record<string, string> = {
  sl: "SL\uFF08\u640D\u5207\u308A\uFF09",
  trailing: "\u30C8\u30EC\u30FC\u30EA\u30F3\u30B0",
  time_stop: "\u30BF\u30A4\u30E0\u30B9\u30C8\u30C3\u30D7",
  other: "\u305D\u306E\u4ED6",
};

app.get("/", async (c) => {
  const thirtyDaysAgo = dayjs().subtract(ROUTE_LOOKBACK_DAYS.HISTORY, "day").toDate();
  const ninetyDaysAgo = dayjs().subtract(90, "day").toDate();

  // Parallel data fetch
  const [summaries, closedPositions, assessments, rejectedSignals] = await Promise.all([
    prisma.tradingDailySummary.findMany({
      where: { date: { gte: thirtyDaysAgo } },
      orderBy: { date: "desc" },
      take: QUERY_LIMITS.HISTORY_SUMMARIES,
    }),
    prisma.tradingPosition.findMany({
      where: { status: "closed", exitedAt: { gte: ninetyDaysAgo } },
      select: {
        exitSnapshot: true,
        exitedAt: true,
        strategy: true,
        entryPrice: true,
        exitPrice: true,
        quantity: true,
      },
      orderBy: { exitedAt: "desc" },
    }),
    prisma.marketAssessment.findMany({
      where: { date: { gte: thirtyDaysAgo } },
      select: { date: true, shouldTrade: true, breadth: true, vix: true, reasoning: true },
      orderBy: { date: "desc" },
    }),
    prisma.rejectedSignal.findMany({
      where: { rejectedAt: { gte: ninetyDaysAgo }, return5dPct: { not: null } },
      select: { return5dPct: true, return10dPct: true, reason: true },
    }),
  ]);

  // === Exit classification ===
  const exitCounts = { sl: 0, trailing: 0, time_stop: 0, other: 0 };
  for (const p of closedPositions) {
    const reason = getExitReason(p.exitSnapshot);
    exitCounts[classifyExit(reason)]++;
  }
  const totalClosed = closedPositions.length;
  const trailingPct = totalClosed > 0 ? (exitCounts.trailing / totalClosed) * 100 : 0;
  const trailingStatus: SignalStatus =
    trailingPct >= 40 ? "ok" : trailingPct >= 20 ? "warning" : "danger";
  const trailingComment =
    trailingPct >= 40
      ? "\u5229\u76CA\u3092\u4F38\u3070\u305B\u3066\u3044\u308B"
      : trailingPct >= 20
        ? "\u6A19\u6E96\u7684"
        : "\u5229\u76CA\u304C\u4F38\u3073\u3066\u3044\u306A\u3044 \u2014 \u30D1\u30E9\u30E1\u30FC\u30BF\u8981\u78BA\u8A8D";

  // === Performance metrics ===
  const wins = closedPositions.filter(
    (p) => getPositionPnl(p) > 0,
  );
  const losses = closedPositions.filter(
    (p) => getPositionPnl(p) <= 0,
  );
  const grossProfit = wins.reduce((s, p) => s + getPositionPnl(p), 0);
  const grossLoss = Math.abs(
    losses.reduce((s, p) => s + getPositionPnl(p), 0),
  );
  const pf = grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? Infinity : 0;
  const winRate = totalClosed > 0 ? (wins.length / totalClosed) * 100 : 0;

  // PnL% approximation from entry/exit prices
  const winPcts = wins
    .filter((p) => p.entryPrice && p.exitPrice && Number(p.entryPrice) > 0)
    .map(
      (p) =>
        ((Number(p.exitPrice) - Number(p.entryPrice)) / Number(p.entryPrice)) *
        100,
    );
  const lossPcts = losses
    .filter((p) => p.entryPrice && p.exitPrice && Number(p.entryPrice) > 0)
    .map(
      (p) =>
        ((Number(p.exitPrice) - Number(p.entryPrice)) / Number(p.entryPrice)) *
        100,
    );
  const avgWinPct =
    winPcts.length > 0 ? winPcts.reduce((s, v) => s + v, 0) / winPcts.length : 0;
  const avgLossPct =
    lossPcts.length > 0
      ? lossPcts.reduce((s, v) => s + v, 0) / lossPcts.length
      : 0;
  const rr =
    avgLossPct !== 0 ? Math.abs(avgWinPct / avgLossPct) : avgWinPct > 0 ? Infinity : 0;
  const expectancy =
    (winRate / 100) * avgWinPct + (1 - winRate / 100) * avgLossPct;

  // MFE stats: maxHigh と entryPrice から都度計算
  const mfeValues = closedPositions
    .map((p) => {
      const snap = p.exitSnapshot as { priceJourney?: { maxHigh?: number } } | null;
      const maxHigh = snap?.priceJourney?.maxHigh;
      const entry = p.entryPrice ? Number(p.entryPrice) : null;
      if (maxHigh == null || !entry) return null;
      return ((maxHigh - entry) / entry) * 100;
    })
    .filter((v): v is number => v !== null);
  const avgMfe = mfeValues.length > 0 ? mfeValues.reduce((s, v) => s + v, 0) / mfeValues.length : 0;

  // Profit giveback rate: how much of MFE was returned
  // Only for trades that had positive MFE
  const givebackRates = closedPositions
    .map((p) => {
      const snap = p.exitSnapshot as { priceJourney?: { maxHigh?: number } } | null;
      const maxHigh = snap?.priceJourney?.maxHigh;
      const entry = p.entryPrice ? Number(p.entryPrice) : null;
      if (maxHigh == null || !entry || !p.exitPrice) return null;
      const mfe = ((maxHigh - entry) / entry) * 100;
      if (mfe <= 0) return null;
      const realizedPct = ((Number(p.exitPrice) - entry) / entry) * 100;
      return 1 - realizedPct / mfe; // 0 = kept all, 1 = returned all
    })
    .filter((v): v is number => v !== null);
  const avgGiveback = givebackRates.length > 0 ? givebackRates.reduce((s, v) => s + v, 0) / givebackRates.length : 0;

  // Average holding days (approximate from exitedAt - not precise but usable)
  const totalPnl = closedPositions.reduce(
    (s, p) => s + getPositionPnl(p),
    0,
  );

  // === Signal selection accuracy ===
  const entryPnlPcts = closedPositions
    .filter((p) => p.entryPrice && p.exitPrice && Number(p.entryPrice) > 0)
    .map((p) => ((Number(p.exitPrice) - Number(p.entryPrice)) / Number(p.entryPrice)) * 100);
  const entryAvgPnlPct = entryPnlPcts.length > 0
    ? entryPnlPcts.reduce((s, v) => s + v, 0) / entryPnlPcts.length
    : 0;

  const rej5dPcts = rejectedSignals
    .map((r) => r.return5dPct)
    .filter((v): v is number => v !== null);
  const rej10dPcts = rejectedSignals
    .map((r) => r.return10dPct)
    .filter((v): v is number => v !== null);
  const rejAvg5d = rej5dPcts.length > 0
    ? rej5dPcts.reduce((s, v) => s + v, 0) / rej5dPcts.length
    : 0;
  const rejAvg10d = rej10dPcts.length > 0
    ? rej10dPcts.reduce((s, v) => s + v, 0) / rej10dPcts.length
    : 0;

  // Rejection reasons breakdown
  const rejByReason: Record<string, { count: number; avg5d: number }> = {};
  for (const r of rejectedSignals) {
    if (!rejByReason[r.reason]) rejByReason[r.reason] = { count: 0, avg5d: 0 };
    rejByReason[r.reason].count++;
    rejByReason[r.reason].avg5d += r.return5dPct ?? 0;
  }
  for (const key of Object.keys(rejByReason)) {
    rejByReason[key].avg5d /= rejByReason[key].count;
  }

  // === Gate log ===
  const tradeDays = assessments.filter((a) => a.shouldTrade).length;
  const skipDays = assessments.filter((a) => !a.shouldTrade);

  // Cumulative PnL chart data (oldest first)
  const chartData = [...summaries].reverse().reduce<
    { label: string; value: number }[]
  >((acc, s) => {
    const prev = acc.length > 0 ? acc[acc.length - 1].value : 0;
    acc.push({
      label: dayjs(s.date).format("M/D"),
      value: prev + Number(s.totalPnl),
    });
    return acc;
  }, []);

  const content = html`
    <!-- Exit Classification -->
    <p class="section-title">${tt("\u30A8\u30B0\u30B8\u30C3\u30C8\u5206\u985E", "\u904E\u53BB90\u65E5\u306E\u6C7A\u6E08\u7406\u7531\u306E\u5185\u8A33")}\uFF0890\u65E5\uFF09</p>
    ${totalClosed > 0
      ? html`
          <div class="card">
            ${miniBarChart(
              [
                { label: EXIT_LABELS.sl, count: exitCounts.sl, color: EXIT_COLORS.sl },
                { label: EXIT_LABELS.trailing, count: exitCounts.trailing, color: EXIT_COLORS.trailing },
                { label: EXIT_LABELS.time_stop, count: exitCounts.time_stop, color: EXIT_COLORS.time_stop },
                { label: EXIT_LABELS.other, count: exitCounts.other, color: EXIT_COLORS.other },
              ],
              totalClosed,
            )}
            <div style="margin-top:10px;padding-top:10px;border-top:1px solid ${COLORS.border}">
              ${signalRow(
                "\u30C8\u30EC\u30FC\u30EA\u30F3\u30B0\u6BD4\u7387",
                `${trailingPct.toFixed(0)}%: ${trailingComment}`,
                trailingStatus,
              )}
            </div>
          </div>
        `
      : html`<div class="card">${emptyState("\u6C7A\u6E08\u6E08\u307F\u30C8\u30EC\u30FC\u30C9\u306A\u3057")}</div>`}

    <!-- Performance Metrics -->
    <p class="section-title">${tt("\u30D1\u30D5\u30A9\u30FC\u30DE\u30F3\u30B9\u6307\u6A19", "\u904E\u53BB90\u65E5\u306E\u5B9F\u7E3E\u30D9\u30FC\u30B9\u306E\u5404\u6307\u6A19")}\uFF0890\u65E5\uFF09</p>
    ${totalClosed > 0
      ? html`
          <div class="card">
            ${detailRow(tt("PF", "\u30D7\u30ED\u30D5\u30A3\u30C3\u30C8\u30D5\u30A1\u30AF\u30BF\u30FC\u3002\u7DCF\u5229\u76CA\u00F7\u7DCF\u640D\u5931\u30021.3\u4EE5\u4E0A\u304C\u76EE\u6A19"), pf === Infinity ? "\u221E" : pf.toFixed(2))}
            ${detailRow(tt("\u52DD\u7387", "\u5229\u76CA\u304C\u51FA\u305F\u30C8\u30EC\u30FC\u30C9\u306E\u5272\u5408"), `${winRate.toFixed(1)}%`)}
            ${detailRow(tt("RR\u6BD4", "\u30EA\u30B9\u30AF\u30EA\u30EF\u30FC\u30C9\u6BD4\u30021.5\u4EE5\u4E0A\u304C\u76EE\u6A19"), rr === Infinity ? "\u221E" : rr.toFixed(2))}
            ${detailRow(tt("\u671F\u5F85\u5024", "(\u52DD\u7387\u00D7\u5E73\u5747\u5229\u76CA%) + (\u6557\u7387\u00D7\u5E73\u5747\u640D\u5931%)\u3002\u6B63\u306A\u3089\u512A\u4F4D\u6027\u3042\u308A"), `${expectancy >= 0 ? "+" : ""}${expectancy.toFixed(2)}%`)}
            ${detailRow(tt("平均MFE%", "保有中に到達した最大含み益の平均。大きいほどエントリー精度が高い"), `+${avgMfe.toFixed(2)}%`)}
            ${detailRow(tt("利益返還率", "MFEのうち返した割合。低いほど利益を守れている"), `${(avgGiveback * 100).toFixed(0)}%`)}
            ${detailRow("\u640D\u76CA", pnlText(totalPnl))}
            ${detailRow("\u53D6\u5F15\u6570", `${totalClosed}\u4EF6`)}
          </div>
        `
      : html`<div class="card">${emptyState("\u6C7A\u6E08\u6E08\u307F\u30C8\u30EC\u30FC\u30C9\u306A\u3057")}</div>`}

    <!-- Signal Selection Accuracy -->
    <p class="section-title">${tt("シグナル選別精度", "入ったトレード vs 見送ったシグナルの成績比較")}（90日）</p>
    ${entryPnlPcts.length > 0 || rej5dPcts.length > 0
      ? html`
          <div class="card">
            ${detailRow(tt("入った", "実際にエントリーしたトレードの平均損益%"), `${entryAvgPnlPct >= 0 ? "+" : ""}${entryAvgPnlPct.toFixed(2)}%（${entryPnlPcts.length}件）`)}
            ${rej5dPcts.length > 0
              ? html`
                  ${detailRow(tt("見送り 5d", "見送ったシグナルの5営業日後リターン平均"), `${rejAvg5d >= 0 ? "+" : ""}${rejAvg5d.toFixed(2)}%（${rej5dPcts.length}件）`)}
                  ${detailRow(tt("見送り 10d", "見送ったシグナルの10営業日後リターン平均"), `${rejAvg10d >= 0 ? "+" : ""}${rejAvg10d.toFixed(2)}%（${rej10dPcts.length}件）`)}
                  <div style="margin-top:10px;padding-top:10px;border-top:1px solid ${COLORS.border}">
                    ${detailRow(tt("選別効果", "入った方が見送りより良ければプラス"), html`<span style="color:${entryAvgPnlPct - rejAvg5d >= 0 ? COLORS.profit : COLORS.loss}">${(entryAvgPnlPct - rejAvg5d) >= 0 ? "+" : ""}${(entryAvgPnlPct - rejAvg5d).toFixed(2)}%</span>`)}
                  </div>
                  ${Object.keys(rejByReason).length > 0
                    ? html`
                        <div style="margin-top:10px;padding-top:10px;border-top:1px solid ${COLORS.border}">
                          <div style="font-size:11px;color:${COLORS.textMuted};margin-bottom:6px">見送り理由別の5d平均:</div>
                          ${Object.entries(rejByReason)
                            .sort((a, b) => b[1].count - a[1].count)
                            .slice(0, 5)
                            .map(([reason, data]) => html`
                              <div style="font-size:12px;margin-bottom:3px">
                                <span style="color:${COLORS.textMuted}">${reason}</span>:
                                <span style="color:${data.avg5d >= 0 ? COLORS.profit : COLORS.loss}">${data.avg5d >= 0 ? "+" : ""}${data.avg5d.toFixed(2)}%</span>
                                <span style="color:${COLORS.textMuted}">（${data.count}件）</span>
                              </div>
                            `)}
                        </div>
                      `
                    : ""}
                `
              : html`<div style="font-size:12px;color:${COLORS.textMuted}">見送りシグナルの株価追跡データなし</div>`}
          </div>
        `
      : html`<div class="card">${emptyState("データなし")}</div>`}

    <!-- Gate Log -->
    <p class="section-title">${tt("\u30B2\u30FC\u30C8\u30ED\u30B0", "\u5E02\u5834\u30B3\u30F3\u30C7\u30A3\u30B7\u30E7\u30F3\u306B\u3088\u308B\u53D6\u5F15\u53EF\u5426\u306E\u8A18\u9332")}\uFF0830\u65E5\uFF09</p>
    ${assessments.length > 0
      ? html`
          <div class="card">
            ${detailRow("\u53D6\u5F15\u53EF", `${tradeDays}\u65E5`)}
            ${detailRow("\u898B\u9001\u308A", `${skipDays.length}\u65E5`)}
            ${skipDays.length > 0
              ? html`
                  <div style="margin-top:10px;padding-top:10px;border-top:1px solid ${COLORS.border}">
                    ${skipDays.map((a) => {
                      const dateStr = dayjs(a.date).format("M/D");
                      const reason = a.reasoning
                        ? String(a.reasoning).replace(/^\[.*?\]\s*/, "").slice(0, 80)
                        : "\u7406\u7531\u4E0D\u660E";
                      return html`<div style="font-size:12px;color:${COLORS.textMuted};margin-bottom:4px">
                        <span style="color:${COLORS.loss}">\u{1F534}</span> ${dateStr} \u2014 ${reason}
                      </div>`;
                    })}
                  </div>
                `
              : ""}
          </div>
        `
      : html`<div class="card">${emptyState("\u5E02\u5834\u8A55\u4FA1\u30C7\u30FC\u30BF\u306A\u3057")}</div>`}

    <!-- PnL Chart -->
    <p class="section-title">\u7D2F\u7A4D\u640D\u76CA\uFF08\u904E\u53BB30\u65E5\uFF09</p>
    <div class="chart-container">
      ${chartData.length >= 2
        ? sparklineChart(chartData, 340, 140)
        : emptyState("\u30C7\u30FC\u30BF\u4E0D\u8DB3")}
    </div>

    <!-- Daily Summary Table -->
    <p class="section-title">\u65E5\u6B21\u30B5\u30DE\u30EA\u30FC</p>
    ${summaries.length > 0
      ? html`
          <div class="card table-wrap responsive-table">
            <table>
              <thead>
                <tr>
                  <th>\u65E5\u4ED8</th>
                  <th>\u53D6\u5F15</th>
                  <th>${tt("\u52DD\u6557", "W=\u52DD\u3061\uFF08\u5229\u78BA\uFF09/ L=\u8CA0\u3051\uFF08\u640D\u5207\uFF09")}</th>
                  <th>${tt("\u640D\u76CA", "\u5F53\u65E5\u306E\u5B9F\u73FE\u640D\u76CA\u5408\u8A08")}</th>
                  <th>${tt("PF\u5024", "\u30D7\u30ED\u30D5\u30A3\u30C3\u30C8\u30D5\u30A1\u30AF\u30BF\u30FC\u3002\u7DCF\u5229\u76CA\u00F7\u7DCF\u640D\u5931")}</th>
                </tr>
              </thead>
              <tbody>
                ${summaries.map(
                  (s) => html`
                    <tr>
                      <td data-label="\u65E5\u4ED8">
                        ${new Date(s.date).toLocaleDateString("ja-JP", {
                          month: "numeric",
                          day: "numeric",
                        })}
                      </td>
                      <td data-label="\u53D6\u5F15">${s.totalTrades}</td>
                      <td data-label="\u52DD\u6557">
                        ${s.totalTrades > 0
                          ? `${s.wins}W ${s.losses}L`
                          : "-"}
                      </td>
                      <td data-label="\u640D\u76CA">${pnlText(Number(s.totalPnl))}</td>
                      <td data-label="PF\u5024">\u00A5${formatYen(Number(s.portfolioValue))}</td>
                    </tr>
                    ${s.aiReview
                      ? html`
                          <tr class="review-row">
                            <td
                              colspan="5"
                              style="font-size:11px;color:#64748b;padding:4px 8px 12px;white-space:pre-wrap"
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
      : html`<div class="card">${emptyState("\u65E5\u6B21\u30B5\u30DE\u30EA\u30FC\u306A\u3057")}</div>`}
  `;

  return c.html(layout("\u5C65\u6B74", "/history", content));
});

export default app;
