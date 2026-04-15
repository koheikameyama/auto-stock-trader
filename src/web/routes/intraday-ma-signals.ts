/**
 * イントラデイ MA シグナルページ（GET /intraday-ma-signals）
 *
 * IntraDayMaPullbackSignal のフォワードテスト結果を一覧表示。
 * リタッチ対応: タッチ回数・最新タッチ価格を表示し、PnLは最新タッチ価格ベースで計算。
 */

import dayjs from "dayjs";
import timezone from "dayjs/plugin/timezone.js";
import utc from "dayjs/plugin/utc.js";
import { Hono } from "hono";
import { html } from "hono/html";
import { prisma } from "../../lib/prisma";
import { layout } from "../views/layout";

dayjs.extend(utc);
dayjs.extend(timezone);

const app = new Hono();

const TIMEZONE = "Asia/Tokyo";

/** エントリー価格を決定（リタッチがあれば最新タッチ価格を使用） */
function getEntryPrice(
  detectedPrice: number,
  lastTouchPrice: number | null,
): number {
  return lastTouchPrice ?? detectedPrice;
}

/** PnL を計算して文字列と色で返す */
function calcPnl(
  detectedPrice: number,
  lastTouchPrice: number | null,
  closePrice: number | null,
  stopLossPrice: number,
): { text: string; color: string } | null {
  if (closePrice === null) {
    return null; // 結果待ち
  }
  const entryPrice = getEntryPrice(detectedPrice, lastTouchPrice);
  let pct: number;
  if (closePrice < stopLossPrice) {
    // SL 発動: 負の PnL
    pct = -((stopLossPrice - entryPrice) / entryPrice) * 100;
  } else {
    pct = ((closePrice - entryPrice) / entryPrice) * 100;
  }
  const sign = pct >= 0 ? "+" : "";
  const color = pct >= 0 ? "#22c55e" : "#ef4444";
  return { text: `${sign}${pct.toFixed(2)}%`, color };
}

app.get("/", async (c) => {
  const query = c.req.query();

  // デフォルト: 過去30日
  const defaultFrom = dayjs().tz(TIMEZONE).subtract(30, "day").format("YYYY-MM-DD");
  const defaultTo = dayjs().tz(TIMEZONE).format("YYYY-MM-DD");

  const fromStr = query.from ?? defaultFrom;
  const toStr = query.to ?? defaultTo;

  // date フィルタ（JST 日付を UTC 00:00 として扱う）
  const fromDate = new Date(`${fromStr}T00:00:00Z`);
  const toDate = new Date(`${toStr}T00:00:00Z`);

  const signals = await prisma.intraDayMaPullbackSignal.findMany({
    where: {
      date: {
        gte: fromDate,
        lte: toDate,
      },
    },
    orderBy: [{ date: "desc" }, { detectedAt: "asc" }],
  });

  const content = html`
    <p class="section-title">イントラデイ MA プルバック シグナル</p>

    <!-- 日付範囲フィルター -->
    <div class="card" style="padding: 10px 12px; margin-bottom: 8px;">
      <form method="get" action="/intraday-ma-signals" style="display: flex; gap: 8px; flex-wrap: wrap; align-items: center;">
        <label style="font-size: 12px; color: #94a3b8;">
          From:
          <input
            type="date"
            name="from"
            value="${fromStr}"
            style="margin-left: 4px; background: #1e293b; border: 1px solid #334155; border-radius: 4px; color: #e2e8f0; padding: 2px 6px; font-size: 12px;"
          />
        </label>
        <label style="font-size: 12px; color: #94a3b8;">
          To:
          <input
            type="date"
            name="to"
            value="${toStr}"
            style="margin-left: 4px; background: #1e293b; border: 1px solid #334155; border-radius: 4px; color: #e2e8f0; padding: 2px 6px; font-size: 12px;"
          />
        </label>
        <button
          type="submit"
          style="background: #3b82f6; color: #fff; border: none; border-radius: 4px; padding: 3px 12px; font-size: 12px; cursor: pointer;"
        >
          絞り込み
        </button>
        <span style="font-size: 11px; color: #64748b; margin-left: auto;">${signals.length} 件</span>
      </form>
    </div>

    ${signals.length > 0
      ? html`
          <div class="card table-wrap responsive-table">
            <table>
              <thead>
                <tr>
                  <th>日付</th>
                  <th>銘柄</th>
                  <th>タッチ</th>
                  <th>初回時刻</th>
                  <th>MA20</th>
                  <th>エントリー</th>
                  <th>終値</th>
                  <th>仮想PnL</th>
                  <th>仮想SL</th>
                </tr>
              </thead>
              <tbody>
                ${signals.map((s) => {
                  const dateStr = dayjs(s.date).tz(TIMEZONE).format("YYYY-MM-DD");
                  const detectedAtStr = dayjs(s.detectedAt).tz(TIMEZONE).format("HH:mm");
                  const ma20 = Math.round(s.ma20);
                  const entryPrice = getEntryPrice(s.detectedPrice, s.lastTouchPrice);
                  const closePrice = s.closePrice !== null ? Math.round(s.closePrice) : null;
                  const stopLossPrice = Math.round(s.stopLossPrice);
                  const pnl = calcPnl(s.detectedPrice, s.lastTouchPrice, s.closePrice, s.stopLossPrice);

                  // タッチ回数バッジ: 2回以上は強調表示
                  const touchBadge =
                    s.touchCount >= 2
                      ? html`<span style="background: #22c55e20; color: #22c55e; padding: 1px 6px; border-radius: 8px; font-size: 11px; font-weight: 600;">${s.touchCount}</span>`
                      : html`<span style="color: #64748b; font-size: 11px;">1</span>`;

                  // エントリー価格: リタッチありなら最新タッチ時刻も表示
                  const entryCell =
                    s.lastTouchPrice != null && s.lastTouchAt != null
                      ? html`${Math.round(entryPrice)}<br /><span style="font-size: 10px; color: #94a3b8;">${dayjs(s.lastTouchAt).tz(TIMEZONE).format("HH:mm")} 更新</span>`
                      : String(Math.round(entryPrice));

                  const closePriceCell =
                    closePrice !== null
                      ? String(closePrice)
                      : html`<span style="color: #64748b;">—</span>`;

                  const pnlCell =
                    pnl !== null
                      ? html`<span style="color: ${pnl.color}; font-weight: 600;">${pnl.text}</span>`
                      : html`<span style="color: #64748b;">結果待ち</span>`;

                  return html`
                    <tr>
                      <td data-label="日付" style="white-space: nowrap;">${dateStr}</td>
                      <td data-label="銘柄">${s.tickerCode}</td>
                      <td data-label="タッチ" style="text-align: center;">${touchBadge}</td>
                      <td data-label="初回時刻" style="white-space: nowrap;">${detectedAtStr}</td>
                      <td data-label="MA20">${ma20}</td>
                      <td data-label="エントリー">${entryCell}</td>
                      <td data-label="終値">${closePriceCell}</td>
                      <td data-label="仮想PnL">${pnlCell}</td>
                      <td data-label="仮想SL">${stopLossPrice}</td>
                    </tr>
                  `;
                })}
              </tbody>
            </table>
          </div>
        `
      : html`
          <div class="card" style="padding: 24px; text-align: center; color: #64748b; font-size: 13px;">
            指定期間にシグナルがありません
          </div>
        `}
  `;

  return c.html(layout("MA シグナル", "/intraday-ma-signals", content));
});

export default app;
