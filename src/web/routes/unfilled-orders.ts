/**
 * 未約定注文フォローアップページ（GET /unfilled-orders）
 *
 * 指値が刺さらなかった注文のその後の値動きを追跡・表示する。
 */

import { Hono } from "hono";
import { html } from "hono/html";
import dayjs from "dayjs";
import { prisma } from "../../lib/prisma";
import { QUERY_LIMITS } from "../../lib/constants";
import { layout } from "../views/layout";
import {
  formatYen,
  strategyBadge,
  tickerLink,
  pnlPercent,
  emptyState,
  tt,
  detailRow,
} from "../views/components";
import type { HtmlEscapedString } from "hono/utils/html";

type HtmlContent = HtmlEscapedString | Promise<HtmlEscapedString>;

const app = new Hono();

/** キャンセル理由バッジ */
function cancelReasonBadge(reason: string): HtmlContent {
  const labels: Record<string, string> = {
    expired: "期限切れ",
    cancelled_eod: "EODキャンセル",
  };
  return html`<span class="badge badge-neutral">${labels[reason] ?? reason}</span>`;
}

/** 到達マーク */
function reachedMark(reached: boolean | null): string {
  if (reached === null) return "-";
  return reached ? "●" : "○";
}

/** N日後セル（P&L% + 到達マーク） */
function dayCell(
  pnlPct: number | null,
  reached: boolean | null,
): HtmlContent {
  if (pnlPct === null) return html`<td style="text-align:right">-</td>`;
  const reachedStr = reachedMark(reached);
  return html`<td style="text-align:right">
    ${pnlPercent(pnlPct)}
    <span style="margin-left:4px;opacity:0.6">${reachedStr}</span>
  </td>`;
}

app.get("/", async (c) => {
  const [pending, completed, stats] = await Promise.all([
    prisma.unfilledOrderFollowUp.findMany({
      where: { isComplete: false },
      orderBy: { orderDate: "desc" },
    }),
    prisma.unfilledOrderFollowUp.findMany({
      where: { isComplete: true },
      orderBy: { orderDate: "desc" },
      take: QUERY_LIMITS.UNFILLED_FOLLOWUP,
    }),
    prisma.unfilledOrderFollowUp.findMany({
      where: { isComplete: true },
      orderBy: { orderDate: "desc" },
      take: 100,
    }),
  ]);

  const allTickers = [...new Set([...pending, ...completed].map((f) => f.tickerCode))];
  const stockNames = await prisma.stock.findMany({
    where: { tickerCode: { in: allTickers } },
    select: { tickerCode: true, name: true },
  });
  const nameMap = new Map(stockNames.map((s) => [s.tickerCode, s.name]));

  // サマリー統計
  const totalCompleted = stats.length;
  const day5Reached = stats.filter((f) => f.day5ReachedLimit === true);
  const reachRate =
    totalCompleted > 0
      ? (day5Reached.length / totalCompleted) * 100
      : 0;
  const day5Pnls = stats.map((f) => Number(f.day5PnlPct));
  const avgDay5Pnl =
    day5Pnls.length > 0
      ? day5Pnls.reduce((sum, v) => sum + v, 0) / day5Pnls.length
      : 0;
  const avgGapPct =
    totalCompleted > 0
      ? stats.reduce((sum, f) => sum + Number(f.gapPct), 0) / totalCompleted
      : 0;

  const content = html`
    <!-- サマリー -->
    <div class="card-grid">
      <div class="card">
        ${detailRow(
          tt("指値到達率", "5営業日以内に指値価格に到達した割合"),
          html`<span style="font-size:1.2em;font-weight:600">${reachRate.toFixed(0)}%</span>
            <span style="opacity:0.6;margin-left:4px">(${day5Reached.length}/${totalCompleted})</span>`,
        )}
      </div>
      <div class="card">
        ${detailRow(
          tt("5日後平均損益", "指値で買えていた場合の5営業日後の平均損益"),
          html`<span style="font-size:1.2em;font-weight:600">${pnlPercent(avgDay5Pnl)}</span>`,
        )}
      </div>
      <div class="card">
        ${detailRow(
          tt("平均指値乖離", "市場価格に対する指値の乖離率"),
          html`<span style="font-size:1.2em;font-weight:600">${avgGapPct >= 0 ? "+" : ""}${avgGapPct.toFixed(2)}%</span>`,
        )}
      </div>
      <div class="card">
        ${detailRow(
          "追跡状況",
          html`<span style="font-size:1.2em;font-weight:600">${pending.length}</span>
            <span style="opacity:0.6">追跡中</span>
            <span style="margin:0 4px">/</span>
            <span style="font-size:1.2em;font-weight:600">${totalCompleted}</span>
            <span style="opacity:0.6">完了</span>`,
        )}
      </div>
    </div>

    <!-- 追跡中 -->
    <p class="section-title">追跡中 (${pending.length})</p>
    ${pending.length
      ? html`
          <div class="card table-wrap">
            <table>
              <thead>
                <tr>
                  <th>銘柄</th>
                  <th>戦略</th>
                  <th>注文日</th>
                  <th style="text-align:right">指値</th>
                  <th style="text-align:right">${tt("乖離", "市場価格との乖離%")}</th>
                  <th>理由</th>
                  <th style="text-align:right">${tt("1日後", "1営業日後P&L% ● = 指値到達")}</th>
                  <th style="text-align:right">${tt("3日後", "3営業日後P&L% ● = 指値到達")}</th>
                  <th style="text-align:right">${tt("5日後", "5営業日後P&L% ● = 指値到達")}</th>
                </tr>
              </thead>
              <tbody>
                ${pending.map(
                  (f) => html`
                    <tr>
                      <td>${tickerLink(f.tickerCode, `${f.tickerCode} ${nameMap.get(f.tickerCode) ?? f.tickerCode}`)}</td>
                      <td>${strategyBadge(f.strategy)}</td>
                      <td style="white-space:nowrap">${dayjs(f.orderDate).format("M/D")}</td>
                      <td style="text-align:right">¥${formatYen(Number(f.limitPrice))}</td>
                      <td style="text-align:right">${pnlPercent(Number(f.gapPct))}</td>
                      <td>${cancelReasonBadge(f.cancelReason)}</td>
                      ${dayCell(
                        f.day1PnlPct !== null ? Number(f.day1PnlPct) : null,
                        f.day1ReachedLimit,
                      )}
                      ${dayCell(
                        f.day3PnlPct !== null ? Number(f.day3PnlPct) : null,
                        f.day3ReachedLimit,
                      )}
                      ${dayCell(
                        f.day5PnlPct !== null ? Number(f.day5PnlPct) : null,
                        f.day5ReachedLimit,
                      )}
                    </tr>
                  `,
                )}
              </tbody>
            </table>
          </div>
        `
      : html`<div class="card">${emptyState("追跡中の注文なし")}</div>`}

    <!-- 完了済み -->
    <p class="section-title">完了済み (直近${QUERY_LIMITS.UNFILLED_FOLLOWUP}件)</p>
    ${completed.length
      ? html`
          <div class="card table-wrap">
            <table>
              <thead>
                <tr>
                  <th>銘柄</th>
                  <th>戦略</th>
                  <th>注文日</th>
                  <th style="text-align:right">指値</th>
                  <th style="text-align:right">${tt("乖離", "市場価格との乖離%")}</th>
                  <th>理由</th>
                  <th style="text-align:right">${tt("1日後", "1営業日後P&L% ● = 指値到達")}</th>
                  <th style="text-align:right">${tt("3日後", "3営業日後P&L% ● = 指値到達")}</th>
                  <th style="text-align:right">${tt("5日後", "5営業日後P&L% ● = 指値到達")}</th>
                </tr>
              </thead>
              <tbody>
                ${completed.map(
                  (f) => html`
                    <tr>
                      <td>${tickerLink(f.tickerCode, `${f.tickerCode} ${nameMap.get(f.tickerCode) ?? f.tickerCode}`)}</td>
                      <td>${strategyBadge(f.strategy)}</td>
                      <td style="white-space:nowrap">${dayjs(f.orderDate).format("M/D")}</td>
                      <td style="text-align:right">¥${formatYen(Number(f.limitPrice))}</td>
                      <td style="text-align:right">${pnlPercent(Number(f.gapPct))}</td>
                      <td>${cancelReasonBadge(f.cancelReason)}</td>
                      ${dayCell(Number(f.day1PnlPct), f.day1ReachedLimit)}
                      ${dayCell(Number(f.day3PnlPct), f.day3ReachedLimit)}
                      ${dayCell(Number(f.day5PnlPct), f.day5ReachedLimit)}
                    </tr>
                  `,
                )}
              </tbody>
            </table>
          </div>
        `
      : html`<div class="card">${emptyState("完了済みデータなし")}</div>`}
  `;

  return c.html(layout("未約定FU", "/unfilled-orders", content));
});

export default app;
