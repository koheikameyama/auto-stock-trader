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
  tt,
} from "../views/components";

const app = new Hono();

app.get("/", async (c) => {
  // Parallel data fetch
  const [assessment, drawdown, sectorConcentration] = await Promise.all([
    prisma.marketAssessment.findFirst({ orderBy: { date: "desc" } }),
    calculateDrawdownStatus(),
    getSectorConcentration(),
  ]);

  // Market regime from VIX
  const vix = assessment?.vix ? Number(assessment.vix) : null;
  const regime = vix !== null
    ? determineMarketRegime(vix)
    : null;

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
                ${tt("VIX", "恐怖指数。高いほど市場の不安が大きい（30超で危機）")}: ${regime.vix.toFixed(1)}
              </span>
            </div>
            ${detailRow("最大ポジション数", `${regime.maxPositions}`)}
            ${detailRow("最低ランク", regime.minRank ?? "-")}
          `
        : emptyState("VIXデータなし")}
    </div>

    <!-- Drawdown Status -->
    <div class="card">
      <div class="card-title">ドローダウン管理</div>
      <div class="grid-2" style="margin:0;gap:8px">
        <div>
          ${detailRow(tt("週次P&L", "今週の実現損益合計"), pnlText(drawdown.weeklyPnl))}
          ${detailRow(
            tt("週次DD", "今週の資産ピークからの最大下落率"),
            html`<span
              class="${drawdown.weeklyDrawdownPct >= DRAWDOWN.WEEKLY_HALT_PCT ? "pnl-negative" : ""}"
              >${drawdown.weeklyDrawdownPct.toFixed(1)}%
              / ${DRAWDOWN.WEEKLY_HALT_PCT}%</span
            >`,
          )}
        </div>
        <div>
          ${detailRow(tt("月次P&L", "今月の実現損益合計"), pnlText(drawdown.monthlyPnl))}
          ${detailRow(
            tt("月次DD", "今月の資産ピークからの最大下落率"),
            html`<span
              class="${drawdown.monthlyDrawdownPct >= DRAWDOWN.MONTHLY_HALT_PCT ? "pnl-negative" : ""}"
              >${drawdown.monthlyDrawdownPct.toFixed(1)}%
              / ${DRAWDOWN.MONTHLY_HALT_PCT}%</span
            >`,
          )}
        </div>
      </div>
      ${detailRow(
        tt("連敗数", "連続して発生した損失トレードの回数"),
        `${drawdown.consecutiveLosses}`,
      )}
      ${detailRow(tt("ピークエクイティ", "運用開始以来の資産最高値"), `¥${formatYen(drawdown.peakEquity)}`)}
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
                  <th>${tt("週間変化", "セクター内銘柄の週次平均騰落率")}</th>
                  <th>${tt("相対強度", "市場平均に対するセクターのパフォーマンス差")}</th>
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
