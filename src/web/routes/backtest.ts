/**
 * バックテスト結果ページ（GET /backtest）
 *
 * クエリパラメータ:
 *   ?strategy=breakout|gapup  戦略フィルタ（デフォルト: breakout）
 *   ?id=xxx                   特定の実行を表示（省略時は最新）
 */

import { Hono } from "hono";
import { html } from "hono/html";
import dayjs from "dayjs";
import utc from "dayjs/plugin/utc.js";
import timezone from "dayjs/plugin/timezone.js";
import { prisma } from "../../lib/prisma";
import { TIMEZONE } from "../../lib/constants/timezone";
import { layout } from "../views/layout";
import {
  emptyState,
  detailRow,
  equityCurveChart,
  pnlPercent,
} from "../views/components";
import type { PerformanceMetrics, SimulatedPosition, DailyEquity } from "../../backtest/types";

dayjs.extend(utc);
dayjs.extend(timezone);

const STRATEGIES = [
  { key: "breakout", label: "ブレイクアウト" },
  { key: "gapup", label: "ギャップアップ" },
] as const;

const app = new Hono();

app.get("/", async (c) => {
  const strategy = c.req.query("strategy") === "gapup" ? "gapup" : "breakout";
  const selectedId = c.req.query("id");

  // 直近10件の履歴一覧（戦略フィルタ）
  const history = await prisma.backtestRun.findMany({
    where: { strategy },
    orderBy: { runAt: "desc" },
    take: 10,
    select: {
      id: true,
      runAt: true,
      startDate: true,
      endDate: true,
      profitFactor: true,
      winRate: true,
      netReturnPct: true,
      totalTrades: true,
    },
  });

  // 表示対象（指定IDまたは最新）
  const targetId = selectedId ?? history[0]?.id;
  const run = targetId
    ? await prisma.backtestRun.findUnique({ where: { id: targetId } })
    : null;

  const metrics = run ? (run.metricsJson as unknown as PerformanceMetrics) : null;
  const equityCurve = run ? (run.equityCurveJson as unknown as DailyEquity[]) : [];
  const trades = run
    ? (run.tradesJson as unknown as SimulatedPosition[]).filter(
        (t) => t.exitReason !== "still_open",
      )
    : [];

  // 出口理由の日本語ラベル
  const exitReasonLabel: Record<string, string> = {
    stop_loss: "SL",
    trailing_profit: "TS",
    take_profit: "TP",
    time_stop: "タイム",
    defensive_exit: "防御",
  };

  const pfColor = (pf: number) => {
    if (pf >= 9999) return "#22c55e";
    if (pf >= 1.3) return "#22c55e";
    if (pf >= 1.0) return "#f59e0b";
    return "#ef4444";
  };

  const fmtPf = (pf: number) => (pf >= 9999 ? "∞" : pf.toFixed(2));

  const content = html`
    <!-- 戦略タブ -->
    <div style="display:flex;gap:0;margin-bottom:16px;border-bottom:2px solid #334155">
      ${STRATEGIES.map(
        (s) => html`
          <a
            href="/backtest?strategy=${s.key}"
            style="padding:10px 20px;font-size:14px;font-weight:600;text-decoration:none;border-bottom:2px solid ${s.key === strategy ? "#3b82f6" : "transparent"};margin-bottom:-2px;color:${s.key === strategy ? "#3b82f6" : "#94a3b8"};transition:color 0.2s"
          >${s.label}</a>
        `,
      )}
    </div>

    <!-- 履歴リスト -->
    <p class="section-title">実行履歴</p>
    ${history.length === 0
      ? html`<div class="card">${emptyState("バックテスト未実行")}</div>`
      : html`<div class="card">
          ${history.map(
            (h) => html`
              <a
                href="/backtest?strategy=${strategy}&id=${h.id}"
                style="display:flex;justify-content:space-between;align-items:center;padding:8px 0;border-bottom:1px solid #1e293b;text-decoration:none;color:inherit;${h.id === targetId ? "font-weight:bold;" : ""}"
              >
                <span style="font-size:13px">${dayjs(h.runAt).tz(TIMEZONE).format("MM/DD HH:mm")}</span>
                <span style="display:flex;gap:12px;font-size:12px">
                  <span style="color:${pfColor(h.profitFactor)}">PF ${fmtPf(h.profitFactor)}</span>
                  ${pnlPercent(h.netReturnPct)}
                  <span style="color:#64748b">${h.totalTrades}件</span>
                </span>
              </a>
            `,
          )}
        </div>`}

    <!-- 詳細（選択された実行） -->
    ${run && metrics
      ? html`
          <p class="section-title">
            サマリー（${run.startDate} 〜 ${run.endDate}）
          </p>

          <!-- 指標カード -->
          <div class="grid-2">
            <div class="card">
              ${detailRow("Profit Factor", html`<span style="color:${pfColor(run.profitFactor)};font-weight:bold">${fmtPf(run.profitFactor)}</span>`)}
              ${detailRow("勝率", `${run.winRate}%`)}
              ${detailRow("期待値", pnlPercent(run.expectancy))}
              ${detailRow("RR比", run.riskRewardRatio.toFixed(2))}
            </div>
            <div class="card">
              ${detailRow("最大DD", html`<span class="pnl-negative">-${run.maxDrawdown}%</span>`)}
              ${detailRow("純リターン", pnlPercent(run.netReturnPct))}
              ${detailRow("総トレード数", `${run.totalTrades}件（${run.wins}勝 ${run.losses}敗）`)}
              ${detailRow("平均保有日数", `${run.avgHoldingDays}日`)}
            </div>
          </div>

          <!-- エクイティカーブ -->
          <p class="section-title">エクイティカーブ</p>
          <div class="card">
            ${equityCurve.length > 0
              ? equityCurveChart(equityCurve, 600, 180)
              : emptyState("データなし")}
          </div>

          <!-- トレード一覧 -->
          <p class="section-title">トレード一覧（${trades.length}件）</p>
          <div class="card table-wrap">
            <table>
              <thead>
                <tr>
                  <th>銘柄</th>
                  <th>エントリー</th>
                  <th>イグジット</th>
                  <th>損益%</th>
                  <th>保有日数</th>
                  <th>出口理由</th>
                </tr>
              </thead>
              <tbody>
                ${trades.map(
                  (t) => html`
                    <tr>
                      <td>${t.ticker}</td>
                      <td style="font-size:12px">${t.entryDate}</td>
                      <td style="font-size:12px">${t.exitDate ?? "-"}</td>
                      <td>${t.pnlPct != null ? pnlPercent(t.pnlPct) : "-"}</td>
                      <td>${t.holdingDays ?? "-"}</td>
                      <td style="font-size:11px;color:#94a3b8">${exitReasonLabel[t.exitReason ?? ""] ?? (t.exitReason ?? "-")}</td>
                    </tr>
                  `,
                )}
              </tbody>
            </table>
          </div>
        `
      : history.length > 0
      ? html`<div class="card">${emptyState("履歴を選択してください")}</div>`
      : ""}
  `;

  return c.html(layout("バックテスト", "/backtest", content));
});

export default app;
