/**
 * ウォッチリストページ（GET /watchlist）
 */

import { Hono } from "hono";
import { html, raw } from "hono/html";
import { prisma } from "../../lib/prisma";
import { QUERY_LIMITS } from "../../lib/constants";
import { BREAKOUT } from "../../lib/constants/breakout";
import { layout } from "../views/layout";
import { formatYen, tickerLink, emptyState, tt } from "../views/components";
import { getWatchlist } from "../../jobs/watchlist-builder";
import { getScannerState } from "../../jobs/breakout-monitor";

const app = new Hono();

type WatchlistStatus = "ordered" | "rejected" | "hot" | "holding" | "cold";

function getTickerStatus(
  ticker: string,
  hotSet: Map<string, unknown>,
  triggeredToday: Set<string>,
  holdingTickers: Set<string>,
  orderedTickers: Set<string>,
): WatchlistStatus {
  if (holdingTickers.has(ticker)) return "holding";
  if (triggeredToday.has(ticker)) {
    return orderedTickers.has(ticker) ? "ordered" : "rejected";
  }
  if (hotSet.has(ticker)) return "hot";
  return "cold";
}

function statusBadgeHtml(status: WatchlistStatus) {
  switch (status) {
    case "ordered":
      return raw(`<span class="badge badge-triggered">注文済</span>`);
    case "rejected":
      return raw(`<span class="badge badge-rejected">却下</span>`);
    case "hot":
      return raw(`<span class="badge badge-hot">急騰中</span>`);
    case "holding":
      return raw(`<span class="badge badge-holding">保有中</span>`);
    case "cold":
      return raw(`<span class="badge badge-cold">監視中</span>`);
  }
}

/** ステータスのソート優先度（小さいほど上） */
function statusOrder(status: WatchlistStatus): number {
  switch (status) {
    case "ordered": return 0;
    case "rejected": return 1;
    case "hot": return 2;
    case "holding": return 3;
    case "cold": return 4;
  }
}

function formatSurgeRatio(ratio: number | undefined): string {
  if (ratio === undefined) return "-";
  return `${ratio.toFixed(1)}x`;
}

function surgeRatioClass(ratio: number | undefined): string {
  if (ratio === undefined) return "";
  if (ratio >= BREAKOUT.VOLUME_SURGE.TRIGGER_THRESHOLD) return "style=\"color: #ef4444; font-weight: 600;\"";
  if (ratio >= BREAKOUT.VOLUME_SURGE.HOT_THRESHOLD) return "style=\"color: #f59e0b; font-weight: 600;\"";
  return "";
}

app.get("/", async (c) => {
  const watchlist = await getWatchlist();

  // スキャナー状態を取得（市場時間外は null）
  const scannerInfo = getScannerState();
  const hotSet = scannerInfo?.state.hotSet ?? new Map();
  const triggeredToday = scannerInfo?.state.triggeredToday ?? new Set();
  const holdingTickers = scannerInfo?.holdingTickers ?? new Set();
  const surgeRatios = scannerInfo?.state.lastSurgeRatios ?? new Map();

  // 当日のブレイクアウト買い注文ティッカーを取得（triggered → ordered/rejected 判定用）
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const todayOrders = triggeredToday.size
    ? await prisma.tradingOrder.findMany({
        where: {
          side: "buy",
          strategy: "breakout",
          createdAt: { gte: todayStart },
        },
        select: { stock: { select: { tickerCode: true } } },
      })
    : [];
  const orderedTickers = new Set(todayOrders.map((o) => o.stock.tickerCode));

  // ステータス付きウォッチリストを作成しソート
  const watchlistWithStatus = watchlist.map((w) => {
    const status = getTickerStatus(w.ticker, hotSet, triggeredToday, holdingTickers, orderedTickers);
    const surgeRatio = surgeRatios.get(w.ticker);
    return { ...w, status, surgeRatio };
  });
  watchlistWithStatus.sort((a, b) => {
    const orderDiff = statusOrder(a.status) - statusOrder(b.status);
    if (orderDiff !== 0) return orderDiff;
    // 同じステータス内ではサージ比率降順
    return (b.surgeRatio ?? 0) - (a.surgeRatio ?? 0);
  });

  // ページネーション
  const perPage = QUERY_LIMITS.WATCHLIST_PER_PAGE;
  const totalPages = Math.max(1, Math.ceil(watchlistWithStatus.length / perPage));
  const page = Math.min(Math.max(1, Number(c.req.query("page")) || 1), totalPages);
  const start = (page - 1) * perPage;
  const pagedWatchlist = watchlistWithStatus.slice(start, start + perPage);

  const tickers = watchlist.map((w) => w.ticker);
  const stocks = tickers.length
    ? await prisma.stock.findMany({
        where: { tickerCode: { in: tickers } },
        select: { tickerCode: true, name: true },
      })
    : [];
  const nameMap = new Map(stocks.map((s) => [s.tickerCode, s.name]));

  // サマリー統計
  const orderedCount = watchlistWithStatus.filter((w) => w.status === "ordered").length;
  const rejectedCount = watchlistWithStatus.filter((w) => w.status === "rejected").length;
  const hotCount = watchlistWithStatus.filter((w) => w.status === "hot").length;
  const holdingCount = watchlistWithStatus.filter((w) => w.status === "holding").length;

  const content = html`
    <p class="section-title">${tt("監視中のウォッチリスト", "毎朝8:00に構築。ブレイクアウト候補銘柄")} (${watchlist.length})</p>
    ${scannerInfo
      ? html`
          <div class="card" style="padding: 8px 12px; margin-bottom: 8px; display: flex; gap: 12px; flex-wrap: wrap; font-size: 12px;">
            ${orderedCount ? html`<span class="badge badge-triggered">注文済: ${orderedCount}</span>` : ""}
            ${rejectedCount ? html`<span class="badge badge-rejected">却下: ${rejectedCount}</span>` : ""}
            ${hotCount ? html`<span class="badge badge-hot">急騰中: ${hotCount}</span>` : ""}
            ${holdingCount ? html`<span class="badge badge-holding">保有中: ${holdingCount}</span>` : ""}
            <span style="color: #94a3b8;">監視中: ${watchlistWithStatus.filter((w) => w.status === "cold").length}</span>
          </div>
        `
      : ""}
    ${watchlist.length
      ? html`
          <div class="card table-wrap">
            <table>
              <thead>
                <tr>
                  <th>銘柄</th>
                  <th>${tt("状態", "監視中→急騰中→注文済/却下")}</th>
                  <th>${tt("サージ", "出来高サージ比率（1.5x=Hot, 2.0x=Trigger）")}</th>
                  <th>${tt("現在価格", "リアルタイム価格")}</th>
                  <th>${tt("20日高値", "ブレイクアウト基準価格")}</th>
                  <th>${tt("乖離", "現在価格と20日高値の差（%）")}</th>
                </tr>
              </thead>
              <tbody>
                ${pagedWatchlist.map(
                  (w) => html`
                    <tr data-quote-row data-ticker="${w.ticker}" data-order-price="${w.high20}">
                      <td>${tickerLink(w.ticker, nameMap.get(w.ticker) ?? w.ticker)}</td>
                      <td>${statusBadgeHtml(w.status)}</td>
                      <td>${raw(`<span ${surgeRatioClass(w.surgeRatio)}>${formatSurgeRatio(w.surgeRatio)}</span>`)}</td>
                      <td data-quote-price><span class="quote-loading">...</span></td>
                      <td>¥${formatYen(w.high20)}</td>
                      <td data-quote-deviation><span class="quote-loading">...</span></td>
                    </tr>
                  `,
                )}
              </tbody>
            </table>
          </div>
          ${totalPages > 1
            ? html`
                <div class="pagination">
                  ${page > 1
                    ? html`<a href="/watchlist?page=${page - 1}" class="pagination-link">← 前へ</a>`
                    : html`<span class="pagination-link disabled">← 前へ</span>`}
                  <span class="pagination-info">${page} / ${totalPages}</span>
                  ${page < totalPages
                    ? html`<a href="/watchlist?page=${page + 1}" class="pagination-link">次へ →</a>`
                    : html`<span class="pagination-link disabled">次へ →</span>`}
                </div>
              `
            : ""}
        `
      : html`<div class="card">${emptyState("監視銘柄なし（8:00に構築）")}</div>`}
  `;

  return c.html(layout("ウォッチリスト", "/watchlist", content));
});

export default app;
