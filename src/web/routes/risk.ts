/**
 * リスク管理ページ（GET /risk）
 *
 * マーケットレジーム、ドローダウン状況、セクター集中度、セクターモメンタムを表示する。
 */

import { Hono } from "hono";
import { html } from "hono/html";
import { prisma } from "../../lib/prisma";
import { determineMarketRegime } from "../../core/market-regime";
import { calculateDrawdownStatus } from "../../core/drawdown-manager";
import {
  getSectorConcentration,
  calculateSectorMomentum,
} from "../../core/sector-analyzer";
import { DRAWDOWN, SECTOR_RISK } from "../../lib/constants";
import { layout } from "../views/layout";
import {
  formatYen,
  pnlText,
  detailRow,
  emptyState,
  regimeBadge,
} from "../views/components";

const app = new Hono();

app.get("/", async (c) => {
  // Parallel data fetch
  const [assessment, drawdown, sectorConcentration] = await Promise.all([
    prisma.marketAssessment.findFirst({ orderBy: { date: "desc" } }),
    calculateDrawdownStatus(),
    getSectorConcentration(),
  ]);

  // Market regime from latest VIX
  const vix = assessment?.vix ? Number(assessment.vix) : null;
  const regime = vix !== null ? determineMarketRegime(vix) : null;

  // Sector momentum (use nikkeiChange from assessment as proxy for week change)
  const nikkeiWeekChange = assessment?.nikkeiChange
    ? Number(assessment.nikkeiChange)
    : 0;
  const sectorMomentum = await calculateSectorMomentum(nikkeiWeekChange);
  const sortedMomentum = sectorMomentum.sort(
    (a, b) => b.relativeStrength - a.relativeStrength,
  );

  const content = html`
    <!-- Market Regime -->
    <div class="card">
      <div class="card-title">マーケットレジーム</div>
      ${regime
        ? html`
            <div
              style="display:flex;align-items:center;gap:8px;margin-bottom:8px"
            >
              ${regimeBadge(regime.level)}
              <span style="font-size:13px;color:#94a3b8">
                VIX: ${regime.vix.toFixed(1)}
              </span>
            </div>
            ${detailRow("最大ポジション数", `${regime.maxPositions}`)}
            ${detailRow("最低ランク", regime.minRank ?? "取引停止")}
            ${detailRow(
              "取引",
              regime.shouldHaltTrading
                ? html`<span style="color:#ef4444">停止</span>`
                : html`<span style="color:#22c55e">許可</span>`,
            )}
            <details>
              <summary>判定理由</summary>
              <div class="review-text">${regime.reason}</div>
            </details>
          `
        : emptyState("VIXデータなし")}
    </div>

    <!-- Drawdown Status -->
    <div class="card">
      <div class="card-title">ドローダウン管理</div>
      ${drawdown.shouldHaltTrading
        ? html`<div
            style="background:rgba(239,68,68,0.15);color:#ef4444;padding:8px 12px;border-radius:8px;font-size:13px;margin-bottom:8px"
          >
            取引停止中: ${drawdown.reason}
          </div>`
        : drawdown.maxPositionsOverride !== null
          ? html`<div
              style="background:rgba(245,158,11,0.15);color:#f59e0b;padding:8px 12px;border-radius:8px;font-size:13px;margin-bottom:8px"
            >
              クールダウン中: ${drawdown.reason}
            </div>`
          : ""}
      <div class="grid-2" style="margin:0;gap:8px">
        <div>
          ${detailRow("週次P&L", pnlText(drawdown.weeklyPnl))}
          ${detailRow(
            "週次DD",
            html`<span
              class="${drawdown.weeklyDrawdownPct >= DRAWDOWN.WEEKLY_HALT_PCT ? "pnl-negative" : ""}"
              >${drawdown.weeklyDrawdownPct.toFixed(1)}%
              / ${DRAWDOWN.WEEKLY_HALT_PCT}%</span
            >`,
          )}
        </div>
        <div>
          ${detailRow("月次P&L", pnlText(drawdown.monthlyPnl))}
          ${detailRow(
            "月次DD",
            html`<span
              class="${drawdown.monthlyDrawdownPct >= DRAWDOWN.MONTHLY_HALT_PCT ? "pnl-negative" : ""}"
              >${drawdown.monthlyDrawdownPct.toFixed(1)}%
              / ${DRAWDOWN.MONTHLY_HALT_PCT}%</span
            >`,
          )}
        </div>
      </div>
      ${detailRow(
        "連敗数",
        html`<span
          class="${drawdown.consecutiveLosses >= DRAWDOWN.COOLDOWN_TRIGGER ? "pnl-negative" : ""}"
          >${drawdown.consecutiveLosses}
          ${drawdown.consecutiveLosses >= DRAWDOWN.COOLDOWN_HALT_TRIGGER
            ? `(停止: ${DRAWDOWN.COOLDOWN_HALT_TRIGGER})`
            : drawdown.consecutiveLosses >= DRAWDOWN.COOLDOWN_TRIGGER
              ? `(制限中: ${DRAWDOWN.COOLDOWN_TRIGGER})`
              : ""}</span
        >`,
      )}
      ${detailRow("ピークエクイティ", `¥${formatYen(drawdown.peakEquity)}`)}
    </div>

    <!-- Sector Concentration -->
    <p class="section-title">セクター集中度</p>
    ${sectorConcentration.length > 0
      ? html`
          <div class="card table-wrap">
            <table>
              <thead>
                <tr>
                  <th>セクター</th>
                  <th>保有数</th>
                  <th>上限</th>
                </tr>
              </thead>
              <tbody>
                ${sectorConcentration.map(
                  (sc) => html`
                    <tr>
                      <td>${sc.sectorGroup}</td>
                      <td
                        style="color:${sc.positionCount >= SECTOR_RISK.MAX_SAME_SECTOR_POSITIONS ? "#ef4444" : "#e2e8f0"}"
                      >
                        ${sc.positionCount}
                      </td>
                      <td>${SECTOR_RISK.MAX_SAME_SECTOR_POSITIONS}</td>
                    </tr>
                  `,
                )}
              </tbody>
            </table>
          </div>
        `
      : html`<div class="card">${emptyState("オープンポジションなし")}</div>`}

    <!-- Sector Momentum -->
    <p class="section-title">セクターモメンタム</p>
    ${sortedMomentum.length > 0
      ? html`
          <div class="card table-wrap">
            <table>
              <thead>
                <tr>
                  <th>セクター</th>
                  <th>週間変化</th>
                  <th>相対強度</th>
                  <th>判定</th>
                </tr>
              </thead>
              <tbody>
                ${sortedMomentum.map(
                  (sm) => html`
                    <tr>
                      <td>${sm.sectorGroup}</td>
                      <td
                        class="${sm.avgWeekChange >= 0 ? "pnl-positive" : "pnl-negative"}"
                      >
                        ${sm.avgWeekChange >= 0 ? "+" : ""}${sm.avgWeekChange.toFixed(1)}%
                      </td>
                      <td
                        class="${sm.relativeStrength >= 0 ? "pnl-positive" : "pnl-negative"}"
                      >
                        ${sm.relativeStrength >= 0 ? "+" : ""}${sm.relativeStrength.toFixed(1)}%
                      </td>
                      <td>
                        ${sm.isStrong
                          ? html`<span
                              style="color:#22c55e;font-size:11px;font-weight:600"
                              >強</span
                            >`
                          : sm.isWeak
                            ? html`<span
                                style="color:#ef4444;font-size:11px;font-weight:600"
                                >弱</span
                              >`
                            : html`<span
                                style="color:#94a3b8;font-size:11px"
                                >-</span
                              >`}
                      </td>
                    </tr>
                  `,
                )}
              </tbody>
            </table>
          </div>
        `
      : html`<div class="card">${emptyState("セクターデータなし")}</div>`}
  `;

  return c.html(layout("リスク管理", "/risk", content));
});

export default app;
