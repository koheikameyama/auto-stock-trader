/**
 * ポジションページ（GET /positions）
 */

import { Hono } from "hono";
import { html } from "hono/html";
import dayjs from "dayjs";
import { prisma } from "../../lib/prisma";
import { QUERY_LIMITS, ROUTE_LOOKBACK_DAYS, POSITION_DEFAULTS } from "../../lib/constants";
import { calculateTrailingStop } from "../../core/trailing-stop";
import { layout } from "../views/layout";
import {
  formatYen,
  pnlText,
  strategyBadge,
  tickerLink,
  emptyState,
  tt,
} from "../views/components";
import type { TradingStrategy } from "../../core/market-regime";
const app = new Hono();

app.get("/", async (c) => {


  const [openPositions, closedPositions] = await Promise.all([
    prisma.tradingPosition.findMany({
      where: { status: "open" },
      include: { stock: true },
      orderBy: { createdAt: "desc" },
    }),
    prisma.tradingPosition.findMany({
      where: {
        status: "closed",
        exitedAt: { gte: dayjs().subtract(ROUTE_LOOKBACK_DAYS.POSITIONS_CLOSED, "day").toDate() },
      },
      include: { stock: true },
      orderBy: { exitedAt: "desc" },
      take: QUERY_LIMITS.POSITIONS_CLOSED,
    }),
  ]);

  const content = html`
    <p class="section-title">オープンポジション (${openPositions.length})</p>
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
                  <th>${tt("損益率", "（現在価格 − 建値）÷ 建値 × 100")}</th>
                  <th>${tt("損切", "現在有効な損切り価格（固定SL/BE/TS）")}</th>
                  <th>${tt("出口状態", "SL=固定損切り、BE=建値撤退、TS=トレーリングストップ")}</th>
                </tr>
              </thead>
              <tbody>
                ${openPositions.map(
                  (p) => {
                    const tickerCode = p.stock?.tickerCode ?? p.stockId;
                    const entryPrice = Number(p.entryPrice);

                    return html`
                    <tr data-quote-row data-ticker="${tickerCode}" data-entry-price="${entryPrice}" data-quantity="${p.quantity}">
                      <td>${tickerLink(tickerCode, `${tickerCode} ${p.stock?.name ?? p.stockId}`)}</td>
                      <td>${strategyBadge(p.strategy)}</td>
                      <td>¥${formatYen(entryPrice)}</td>
                      <td>${p.quantity}</td>
                      <td data-quote-price><span class="quote-loading">...</span></td>
                      <td data-quote-pnl><span class="quote-loading">...</span></td>
                      <td data-quote-pnl-rate><span class="quote-loading">...</span></td>
                      ${(() => {
                        const sl = p.stopLossPrice ? Number(p.stopLossPrice) : entryPrice * POSITION_DEFAULTS.STOP_LOSS_RATIO;
                        const tp = p.takeProfitPrice ? Number(p.takeProfitPrice) : entryPrice * POSITION_DEFAULTS.TAKE_PROFIT_RATIO;
                        const entryAtr = p.entryAtr ? Number(p.entryAtr) : null;
                        const maxHigh = p.maxHighDuringHold ? Number(p.maxHighDuringHold) : entryPrice;
                        const currentTS = p.trailingStopPrice ? Number(p.trailingStopPrice) : null;

                        const tsResult = calculateTrailingStop({
                          entryPrice,
                          maxHighDuringHold: maxHigh,
                          currentTrailingStop: currentTS,
                          originalStopLoss: sl,
                          originalTakeProfit: tp,
                          entryAtr,
                          strategy: p.strategy as TradingStrategy,
                        });

                        const effectiveSL = tsResult.effectiveStopLoss;
                        let statusLabel: string;
                        let statusColor: string;
                        let activationInfo = "";
                        if (tsResult.isActivated) {
                          statusLabel = `TS ¥${formatYen(effectiveSL)}`;
                          statusColor = "#3b82f6";
                        } else if (effectiveSL >= entryPrice) {
                          statusLabel = `BE ¥${formatYen(effectiveSL)}`;
                          statusColor = "#22c55e";
                        } else {
                          statusLabel = `SL ¥${formatYen(effectiveSL)}`;
                          statusColor = "#94a3b8";
                          activationInfo = `BE ¥${formatYen(tsResult.beActivationPrice)}`;
                        }

                        return html`
                          <td>¥${formatYen(effectiveSL)}</td>
                          <td>
                            <span class="badge" style="background:${statusColor}20;color:${statusColor}">${statusLabel}</span>
                            ${activationInfo ? html`<div style="font-size:0.7rem;color:#94a3b8;margin-top:2px">${activationInfo}</div>` : ""}
                          </td>
                        `;
                      })()}
                    </tr>
                  `;
                  },
                )}
              </tbody>
            </table>
          </div>
        `
      : html`<div class="card">${emptyState("オープンポジションなし")}</div>`}

    <p class="section-title">クローズ済み (直近7日)</p>
    ${closedPositions.length > 0
      ? html`
          <div class="card table-wrap">
            <table>
              <thead>
                <tr>
                  <th>銘柄</th>
                  <th>戦略</th>
                  <th>${tt("建値", "エントリー時の購入価格")}</th>
                  <th>${tt("決済", "ポジションを閉じた時の価格")}</th>
                  <th>${tt("損益", "実現損益（税引前）")}</th>
                  <th>${tt("決済理由", "損切り・利確・トレーリング・タイムストップ等")}</th>
                  <th>${tt("決済日", "ポジションを閉じた日付")}</th>
                </tr>
              </thead>
              <tbody>
                ${closedPositions.map(
                  (p) => html`
                    <tr>
                      <td>${tickerLink(p.stock?.tickerCode ?? p.stockId, p.stock?.name ?? p.stockId)}</td>
                      <td>${strategyBadge(p.strategy)}</td>
                      <td>¥${formatYen(Number(p.entryPrice))}</td>
                      <td>
                        ${p.exitPrice
                          ? `¥${formatYen(Number(p.exitPrice))}`
                          : "-"}
                      </td>
                      <td>
                        ${p.realizedPnl
                          ? pnlText(Number(p.realizedPnl))
                          : "-"}
                      </td>
                      <td style="white-space:nowrap">${(() => {
                        const snap = p.exitSnapshot as { exitReason?: string } | null;
                        return snap?.exitReason ?? "-";
                      })()}</td>
                      <td style="white-space:nowrap">${p.exitedAt ? dayjs(p.exitedAt).format("M/D") : "-"}</td>
                    </tr>
                  `,
                )}
              </tbody>
            </table>
          </div>
        `
      : html`<div class="card">${emptyState("直近7日のクローズポジションなし")}</div>`}
  `;

  return c.html(layout("ポジション", "/positions", content));
});

export default app;
