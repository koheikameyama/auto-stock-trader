/**
 * ウォッチリストページ（GET /watchlist）
 */

import dayjs from "dayjs";
import timezone from "dayjs/plugin/timezone.js";
import utc from "dayjs/plugin/utc.js";
import { Hono } from "hono";
import { html, raw } from "hono/html";
import { prisma } from "../../lib/prisma";
import { QUERY_LIMITS, TIMEZONE } from "../../lib/constants";
import { BREAKOUT } from "../../lib/constants/breakout";
import { layout } from "../views/layout";
import { formatYen, tickerLink, emptyState, tt } from "../views/components";
import { getWatchlist } from "../../jobs/watchlist-builder";
import { getScannerState } from "../../jobs/breakout-monitor";
import { getTodayForDB } from "../../lib/date-utils";

dayjs.extend(utc);
dayjs.extend(timezone);

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
    case "hot": return 1;
    case "holding": return 2;
    case "cold": return 3;
    case "rejected": return 4;
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

/** 出来高条件の✓/✗表示 */
function volumeCheckHtml(ratio: number | undefined): string {
  if (ratio === undefined) return `<span style="color: #64748b;">出来高-</span>`;
  const ok = ratio >= BREAKOUT.VOLUME_SURGE.TRIGGER_THRESHOLD;
  const color = ok ? "#22c55e" : "#64748b";
  const mark = ok ? "✓" : "✗";
  return `<span style="color: ${color}; font-size: 11px;">出来高${mark}</span>`;
}

/** グローバル条件: 時間帯チェック */
function isInEntryTimeWindow(): boolean {
  const now = dayjs().tz(TIMEZONE);
  const [eh, em] = BREAKOUT.GUARD.EARLIEST_ENTRY_TIME.split(":").map(Number);
  const [lh, lm] = BREAKOUT.GUARD.LATEST_ENTRY_TIME.split(":").map(Number);
  const h = now.hour();
  const m = now.minute();
  const current = h * 60 + m;
  return current >= eh * 60 + em && current <= lh * 60 + lm;
}

const VALID_STATUSES = new Set<WatchlistStatus>(["ordered", "rejected", "hot", "holding", "cold"]);

app.get("/", async (c) => {
  const statusFilter = c.req.query("status") as WatchlistStatus | undefined;
  const activeFilter = statusFilter && VALID_STATUSES.has(statusFilter) ? statusFilter : null;

  const watchlist = await getWatchlist();

  // スキャナー状態を取得（市場時間外は null）
  const scannerInfo = getScannerState();
  const hotSet = scannerInfo?.state.hotSet ?? new Map();
  const triggeredToday = scannerInfo?.state.triggeredToday ?? new Set();
  const holdingTickers = scannerInfo?.holdingTickers ?? new Set();
  const surgeRatios = scannerInfo?.state.lastSurgeRatios ?? new Map();

  // グローバル条件 + 当日注文ティッカーを並列取得
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const [todayOrders, todayAssessment] = await Promise.all([
    triggeredToday.size
      ? prisma.tradingOrder.findMany({
          where: {
            side: "buy",
            strategy: "breakout",
            createdAt: { gte: todayStart },
          },
          select: { stock: { select: { tickerCode: true } } },
        })
      : Promise.resolve([]),
    prisma.marketAssessment.findUnique({
      where: { date: getTodayForDB() },
      select: { shouldTrade: true },
    }),
  ]);
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

  // フィルター適用
  const filteredWatchlist = activeFilter
    ? watchlistWithStatus.filter((w) => w.status === activeFilter)
    : watchlistWithStatus;

  // ページネーション
  const perPage = QUERY_LIMITS.WATCHLIST_PER_PAGE;
  const totalPages = Math.max(1, Math.ceil(filteredWatchlist.length / perPage));
  const page = Math.min(Math.max(1, Number(c.req.query("page")) || 1), totalPages);
  const start = (page - 1) * perPage;
  const pagedWatchlist = filteredWatchlist.slice(start, start + perPage);
  const filterQuery = activeFilter ? `&status=${activeFilter}` : "";

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

  // グローバル条件
  const inTimeWindow = isInEntryTimeWindow();
  const shouldTrade = todayAssessment?.shouldTrade ?? false;

  const coldCount = watchlistWithStatus.filter((w) => w.status === "cold").length;

  /** フィルターバッジリンクを生成 */
  function filterBadge(status: WatchlistStatus, label: string, count: number, badgeClass: string) {
    const isActive = activeFilter === status;
    const href = isActive ? "/watchlist" : `/watchlist?status=${status}`;
    const activeStyle = isActive ? "outline: 2px solid currentColor; outline-offset: 1px;" : "opacity: 0.7;";
    return raw(`<a href="${href}" class="badge ${badgeClass}" style="text-decoration: none; cursor: pointer; ${count ? activeStyle : "opacity: 0.3; pointer-events: none;"}">${label}: ${count}</a>`);
  }

  const content = html`
    <p class="section-title">${tt("監視中のウォッチリスト", "毎朝8:00に構築。ブレイクアウト候補銘柄")} (${watchlist.length})</p>
    ${scannerInfo
      ? html`
          <div class="card" style="padding: 8px 12px; margin-bottom: 8px; font-size: 12px;">
            <div style="display: flex; gap: 8px; flex-wrap: wrap; margin-bottom: 6px; align-items: center;">
              <a href="/watchlist" style="text-decoration: none; color: ${!activeFilter ? "#e2e8f0" : "#94a3b8"}; font-size: 11px; ${!activeFilter ? "font-weight: 600;" : ""}">すべて</a>
              ${filterBadge("ordered", "注文済", orderedCount, "badge-triggered")}
              ${filterBadge("rejected", "却下", rejectedCount, "badge-rejected")}
              ${filterBadge("hot", "急騰中", hotCount, "badge-hot")}
              ${filterBadge("holding", "保有中", holdingCount, "badge-holding")}
              ${filterBadge("cold", "監視中", coldCount, "badge-cold")}
            </div>
            <div style="display: flex; gap: 12px; flex-wrap: wrap; color: #94a3b8; font-size: 11px; border-top: 1px solid #334155; padding-top: 6px;">
              <span>${raw(`${tt("時間帯", `${BREAKOUT.GUARD.EARLIEST_ENTRY_TIME}〜${BREAKOUT.GUARD.LATEST_ENTRY_TIME}`)}: <span data-global-time style="color: ${inTimeWindow ? "#22c55e" : "#ef4444"};">${inTimeWindow ? "○" : "×"}</span>`)}</span>
              <span>${raw(`${tt("市場評価", "MarketAssessment.shouldTrade")}: <span data-global-market style="color: ${shouldTrade ? "#22c55e" : "#ef4444"};">${shouldTrade ? "取引可" : "見送り"}</span>`)}</span>
            </div>
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
                  <th>${tt("条件", "出来高≥2.0x かつ 価格>20日高値 で注文")}</th>
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
                      <td>${tickerLink(w.ticker, `${w.ticker} ${nameMap.get(w.ticker) ?? w.ticker}`)}</td>
                      <td data-status-badge>${statusBadgeHtml(w.status)}</td>
                      <td style="font-size: 11px; white-space: nowrap;"><span data-volume-check>${raw(volumeCheckHtml(w.surgeRatio))}</span> <span data-price-check style="color: #64748b;">価格-</span></td>
                      <td data-surge-ratio>${raw(`<span ${surgeRatioClass(w.surgeRatio)}>${formatSurgeRatio(w.surgeRatio)}</span>`)}</td>
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
                    ? html`<a href="/watchlist?page=${page - 1}${filterQuery}" class="pagination-link">← 前へ</a>`
                    : html`<span class="pagination-link disabled">← 前へ</span>`}
                  <span class="pagination-info">${page} / ${totalPages}</span>
                  ${page < totalPages
                    ? html`<a href="/watchlist?page=${page + 1}${filterQuery}" class="pagination-link">次へ →</a>`
                    : html`<span class="pagination-link disabled">次へ →</span>`}
                </div>
              `
            : ""}
        `
      : html`<div class="card">${emptyState("監視銘柄なし（8:00に構築）")}</div>`}
    <script>
      (function() {
        var POLL_INTERVAL = 30000;
        var SURGE_HOT = ${BREAKOUT.VOLUME_SURGE.HOT_THRESHOLD};
        var SURGE_TRIGGER = ${BREAKOUT.VOLUME_SURGE.TRIGGER_THRESHOLD};
        var rows = document.querySelectorAll('[data-quote-row]');
        if (rows.length === 0) return;

        var tickers = [];
        rows.forEach(function(row) {
          var t = row.getAttribute('data-ticker');
          if (t && tickers.indexOf(t) === -1) tickers.push(t);
        });
        if (tickers.length === 0) return;

        var params = new URLSearchParams(window.location.search);
        var token = params.get('token') || '';
        var url = '/api/watchlist/state?tickers=' + encodeURIComponent(tickers.join(',')) + '&token=' + encodeURIComponent(token);

        var fmt = function(v) { return Number(v).toLocaleString('ja-JP', { maximumFractionDigits: 0 }); };

        var STATUS_MAP = {
          ordered: { label: '注文済', cls: 'badge-triggered' },
          rejected: { label: '却下', cls: 'badge-rejected' },
          hot: { label: '急騰中', cls: 'badge-hot' },
          holding: { label: '保有中', cls: 'badge-holding' },
          cold: { label: '監視中', cls: 'badge-cold' }
        };

        function poll() {
          if (document.hidden) return;
          fetch(url)
            .then(function(r) { return r.json(); })
            .then(function(data) {
              if (!data.tickers) return;

              // 行ごとに更新
              rows.forEach(function(row) {
                var ticker = row.getAttribute('data-ticker');
                var d = data.tickers[ticker];
                if (!d) return;

                // ステータスバッジ
                var badgeEl = row.querySelector('[data-status-badge]');
                if (badgeEl && d.status) {
                  var s = STATUS_MAP[d.status];
                  if (s) badgeEl.innerHTML = '<span class="badge ' + s.cls + '">' + s.label + '</span>';
                }

                // サージ比率
                var surgeEl = row.querySelector('[data-surge-ratio]');
                if (surgeEl) {
                  var ratio = d.surgeRatio;
                  var txt = ratio != null ? ratio.toFixed(1) + 'x' : '-';
                  var style = '';
                  if (ratio != null && ratio >= SURGE_TRIGGER) style = 'color: #ef4444; font-weight: 600;';
                  else if (ratio != null && ratio >= SURGE_HOT) style = 'color: #f59e0b; font-weight: 600;';
                  surgeEl.innerHTML = '<span style="' + style + '">' + txt + '</span>';
                }

                // 出来高チェック
                var volEl = row.querySelector('[data-volume-check]');
                if (volEl) {
                  var r2 = d.surgeRatio;
                  if (r2 != null) {
                    var ok = r2 >= SURGE_TRIGGER;
                    var color = ok ? '#22c55e' : '#64748b';
                    var mark = ok ? '\u2713' : '\u2717';
                    volEl.innerHTML = '<span style="color: ' + color + '; font-size: 11px;">出来高' + mark + '</span>';
                  }
                }

                // 価格
                if (d.price != null) {
                  var priceEl = row.querySelector('[data-quote-price]');
                  if (priceEl) priceEl.innerHTML = '\u00a5' + fmt(d.price);

                  var orderPrice = parseFloat(row.getAttribute('data-order-price') || '0');
                  // 乖離率
                  var devEl = row.querySelector('[data-quote-deviation]');
                  if (devEl && orderPrice) {
                    var dev = ((d.price - orderPrice) / orderPrice) * 100;
                    var cls = dev >= 0 ? 'pnl-positive' : 'pnl-negative';
                    var sign = dev >= 0 ? '+' : '';
                    devEl.innerHTML = '<span class="' + cls + '">' + sign + dev.toFixed(2) + '%</span>';
                  }

                  // 価格チェック
                  var priceCheckEl = row.querySelector('[data-price-check]');
                  if (priceCheckEl && orderPrice) {
                    var priceOk = d.price > orderPrice;
                    priceCheckEl.innerHTML = '\u4fa1\u683c' + (priceOk ? '\u2713' : '\u2717');
                    priceCheckEl.style.color = priceOk ? '#22c55e' : '#64748b';
                  }
                }
              });

              // グローバル条件
              var g = data.global;
              if (g) {
                var timeEl = document.querySelector('[data-global-time]');
                if (timeEl) {
                  timeEl.textContent = g.inTimeWindow ? '\u25cb' : '\u00d7';
                  timeEl.style.color = g.inTimeWindow ? '#22c55e' : '#ef4444';
                }
                var marketEl = document.querySelector('[data-global-market]');
                if (marketEl) {
                  marketEl.textContent = g.shouldTrade ? '取引可' : '見送り';
                  marketEl.style.color = g.shouldTrade ? '#22c55e' : '#ef4444';
                }
              }

              // サマリーバッジの件数更新は行わない（フィルターリンクのためページ遷移が必要）
            })
            .catch(function() { /* エラー時はスキップ */ });
        }

        setInterval(poll, POLL_INTERVAL);
      })();
    </script>
  `;

  return c.html(layout("ウォッチリスト", "/watchlist", content));
});

export default app;
