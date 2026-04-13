/**
 * ウォッチリストページ（GET /watchlist）
 *
 * 全戦略（GU/BO/WB）のエントリー候補を統合表示。
 * サージ比率・戦略判定はポーリング API から取得。
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
import { getTodayForDB } from "../../lib/market-date";

dayjs.extend(utc);
dayjs.extend(timezone);

const app = new Hono();

type WatchlistStatus = "ordered" | "holding" | "watching";

function statusBadgeHtml(status: WatchlistStatus, orderStrategy?: string) {
  switch (status) {
    case "ordered": {
      const label = orderStrategy ? `注文済(${orderStrategy.toUpperCase()})` : "注文済";
      return raw(`<span class="badge badge-triggered">${label}</span>`);
    }
    case "holding":
      return raw(`<span class="badge badge-holding">保有中</span>`);
    case "watching":
      return raw(`<span class="badge badge-cold">監視中</span>`);
  }
}

/** グローバル条件: 時間帯チェック */
function isInEntryTimeWindow(): boolean {
  const now = dayjs().tz(TIMEZONE);
  const [eh, em] = BREAKOUT.GUARD.EARLIEST_ENTRY_TIME.split(":").map(Number);
  const [lh, lm] = BREAKOUT.GUARD.LATEST_ENTRY_TIME.split(":").map(Number);
  const current = now.hour() * 60 + now.minute();
  return current >= eh * 60 + em && current <= lh * 60 + lm;
}

app.get("/", async (c) => {
  const watchlist = await getWatchlist();

  // 保有・注文・市場評価を並列取得
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const [holdings, todayOrders, todayAssessment] = await Promise.all([
    prisma.tradingPosition.findMany({
      where: { status: "open" },
      select: { stock: { select: { tickerCode: true } } },
    }),
    prisma.tradingOrder.findMany({
      where: { side: "buy", createdAt: { gte: todayStart } },
      select: { stock: { select: { tickerCode: true } }, strategy: true },
    }),
    prisma.marketAssessment.findUnique({
      where: { date: getTodayForDB() },
      select: { shouldTrade: true },
    }),
  ]);

  const holdingTickers = new Set(holdings.map((h) => h.stock.tickerCode));
  const orderedMap = new Map<string, string>();
  for (const o of todayOrders) {
    orderedMap.set(o.stock.tickerCode, o.strategy ?? "");
  }

  // ステータス付きウォッチリストを作成しソート
  const watchlistWithStatus = watchlist.map((w) => {
    let status: WatchlistStatus = "watching";
    let orderStrategy: string | undefined;
    if (holdingTickers.has(w.ticker)) {
      status = "holding";
    } else if (orderedMap.has(w.ticker)) {
      status = "ordered";
      orderStrategy = orderedMap.get(w.ticker);
    }
    return { ...w, status, orderStrategy };
  });
  // 注文済 → 保有中 → 監視中
  const statusOrder = { ordered: 0, holding: 1, watching: 2 };
  watchlistWithStatus.sort((a, b) => statusOrder[a.status] - statusOrder[b.status]);

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
  const holdingCount = watchlistWithStatus.filter((w) => w.status === "holding").length;
  const watchingCount = watchlistWithStatus.filter((w) => w.status === "watching").length;

  // グローバル条件
  const inTimeWindow = isInEntryTimeWindow();
  const shouldTrade = todayAssessment?.shouldTrade ?? false;
  const isFriday = dayjs().tz(TIMEZONE).day() === 5;

  const content = html`
    <p class="section-title">${tt("ウォッチリスト", "毎朝8:00に構築。全戦略共通の候補銘柄")} (${watchlist.length})</p>
    <div class="card" style="padding: 8px 12px; margin-bottom: 8px; font-size: 12px;">
      <div style="display: flex; gap: 8px; flex-wrap: wrap; margin-bottom: 6px; align-items: center;">
        <span style="color: #e2e8f0; font-size: 11px; font-weight: 600;">すべて: ${watchlist.length}</span>
        <span class="badge badge-triggered" style="opacity: ${orderedCount ? 0.7 : 0.3};">注文済: ${orderedCount}</span>
        <span class="badge badge-holding" style="opacity: ${holdingCount ? 0.7 : 0.3};">保有中: ${holdingCount}</span>
        <span class="badge badge-cold" style="opacity: ${watchingCount ? 0.7 : 0.3};">監視中: ${watchingCount}</span>
        <span style="margin-left: auto;"></span>
        <span data-summary-gu class="badge badge-gapup" style="opacity: 0.3;">GU: -</span>
        <span data-summary-bo class="badge badge-hot" style="opacity: 0.3;">BO: -</span>
        ${isFriday ? html`<span data-summary-wb class="badge badge-wb" style="opacity: 0.3;">WB: -</span>` : ""}
      </div>
      <div style="display: flex; gap: 12px; flex-wrap: wrap; color: #94a3b8; font-size: 11px; border-top: 1px solid #334155; padding-top: 6px;">
        <span>${raw(`${tt("時間帯", `${BREAKOUT.GUARD.EARLIEST_ENTRY_TIME}〜${BREAKOUT.GUARD.LATEST_ENTRY_TIME}`)}: <span data-global-time style="color: ${inTimeWindow ? "#22c55e" : "#ef4444"};">${inTimeWindow ? "○" : "×"}</span>`)}</span>
        <span>${raw(`${tt("市場評価", "MarketAssessment.shouldTrade")}: <span data-global-market style="color: ${shouldTrade ? "#22c55e" : "#ef4444"};">${shouldTrade ? "取引可" : "見送り"}</span>`)}</span>
      </div>
    </div>
    ${watchlist.length
      ? html`
          <div class="card table-wrap">
            <table>
              <thead>
                <tr>
                  <th>銘柄</th>
                  <th>${tt("状態", "保有中/注文済/監視中")}</th>
                  <th>${tt("GU条件", "Gap≥3% / 陽線(終値≥始値) / 出来高≥1.5x")}</th>
                  <th>${tt("サージ", "出来高サージ比率（時間帯加重）")}</th>
                  <th>${tt("現在価格", "リアルタイム価格")}</th>
                  <th>${tt("20日高値", "ブレイクアウト基準価格")}</th>
                  <th>${tt("乖離", "現在価格と20日高値の差（%）")}</th>
                  ${isFriday ? html`<th>${tt("WB乖離", "現在価格 vs 13週高値（金曜のみ）")}</th>` : ""}
                </tr>
              </thead>
              <tbody>
                ${pagedWatchlist.map(
                  (w) => html`
                    <tr data-quote-row data-ticker="${w.ticker}" data-order-price="${w.high20}">
                      <td>${tickerLink(w.ticker, `${w.ticker} ${nameMap.get(w.ticker) ?? w.ticker}`)}</td>
                      <td data-status-badge>${statusBadgeHtml(w.status, w.orderStrategy)}</td>
                      <td data-gapup-conditions style="font-size: 11px; white-space: nowrap;"><span class="quote-loading">...</span></td>
                      <td data-surge-ratio><span class="quote-loading">...</span></td>
                      <td data-quote-price><span class="quote-loading">...</span></td>
                      <td>¥${formatYen(w.high20)}</td>
                      <td data-quote-deviation><span class="quote-loading">...</span></td>
                      ${isFriday ? html`<td data-wb-deviation><span class="quote-loading">...</span></td>` : ""}
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

        var STRATEGY_BADGE = {
          GU: '<span class="badge badge-gapup" style="font-size: 10px; padding: 1px 5px;">GU</span>',
          BO: '<span class="badge badge-hot" style="font-size: 10px; padding: 1px 5px;">BO</span>',
          WB: '<span class="badge badge-wb" style="font-size: 10px; padding: 1px 5px;">WB</span>'
        };

        var STATUS_MAP = {
          ordered: { cls: 'badge-triggered' },
          holding: { label: '保有中', cls: 'badge-holding' },
          watching: { label: '監視中', cls: 'badge-cold' }
        };

        function poll() {
          if (document.hidden) return;
          fetch(url)
            .then(function(r) { return r.json(); })
            .then(function(data) {
              if (!data.tickers) return;
              if (data.global && data.global._error === 'broker_api_failed') {
                var existing = document.getElementById('broker-error-toast');
                if (!existing) {
                  var toast = document.createElement('div');
                  toast.id = 'broker-error-toast';
                  toast.style.cssText = 'position:fixed;bottom:20px;right:20px;background:#ef4444;color:#fff;padding:10px 16px;border-radius:8px;font-size:13px;z-index:9999;box-shadow:0 4px 12px rgba(0,0,0,0.3);';
                  toast.textContent = '⚠ API接続エラー：株価を取得できませんでした';
                  document.body.appendChild(toast);
                  setTimeout(function() { toast.remove(); }, 5000);
                }
              }

              var guCount = 0, boCount = 0, wbCount = 0;
              var rowSortData = {};

              rows.forEach(function(row) {
                var ticker = row.getAttribute('data-ticker');
                var d = data.tickers[ticker];
                if (!d) return;

                // ソート用データを収集
                var guAllMet = d.gapup && d.gapup.isGapOk && d.gapup.isCandleOk && d.gapup.isVolumeOk;
                rowSortData[ticker] = {
                  guAllMet: guAllMet ? 1 : 0,
                  surgeRatio: d.surgeRatio || 0,
                  status: d.status || 'watching'
                };

                // ステータスバッジ
                var badgeEl = row.querySelector('[data-status-badge]');
                if (badgeEl && d.status) {
                  var s = STATUS_MAP[d.status];
                  if (s) {
                    var label = s.label;
                    if (d.status === 'ordered') {
                      label = d.orderStrategy ? '注文済(' + d.orderStrategy.toUpperCase() + ')' : '注文済';
                    }
                    badgeEl.innerHTML = '<span class="badge ' + s.cls + '">' + label + '</span>';
                  }
                }

                // 戦略バッジ
                var stratEl = row.querySelector('[data-strategies]');
                if (stratEl) {
                  var strats = d.strategies || [];
                  if (strats.length > 0) {
                    stratEl.innerHTML = strats.map(function(s) { return STRATEGY_BADGE[s] || s; }).join(' ');
                  } else {
                    stratEl.innerHTML = '<span style="color: #475569; font-size: 11px;">-</span>';
                  }
                  // サマリー集計
                  if (strats.indexOf('GU') !== -1) guCount++;
                  if (strats.indexOf('BO') !== -1) boCount++;
                  if (strats.indexOf('WB') !== -1) wbCount++;
                }

                // GU条件
                var guEl = row.querySelector('[data-gapup-conditions]');
                if (guEl) {
                  var gu = d.gapup;
                  if (gu) {
                    var gapSign = gu.gapPct >= 0 ? '+' : '';
                    var gapColor = gu.isGapOk ? '#22c55e' : (gu.gapPct >= 1.5 ? '#f59e0b' : '#64748b');
                    var candleColor = gu.isCandleOk ? '#22c55e' : '#ef4444';
                    var candleLabel = gu.isCandleOk ? '\u25cb' : '\u00d7';
                    var volColor = gu.isVolumeOk ? '#22c55e' : '#64748b';
                    var allMet = gu.isGapOk && gu.isCandleOk && gu.isVolumeOk;
                    guEl.innerHTML =
                      '<span style="color:' + gapColor + ';">' + gapSign + gu.gapPct.toFixed(1) + '%</span>' +
                      '<span style="color:#475569; margin: 0 2px;">|</span>' +
                      '<span style="color:' + candleColor + ';">' + candleLabel + '</span>' +
                      '<span style="color:#475569; margin: 0 2px;">|</span>' +
                      '<span style="color:' + volColor + ';">' + d.surgeRatio.toFixed(1) + 'x</span>' +
                      (allMet ? ' <span style="color:#22c55e; font-weight:600;">\u2714</span>' : '');
                  } else {
                    guEl.innerHTML = '<span style="color: #475569;">-</span>';
                  }
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

                // 価格
                if (d.price != null) {
                  var priceEl = row.querySelector('[data-quote-price]');
                  if (priceEl) priceEl.innerHTML = '\u00a5' + fmt(d.price);

                  var orderPrice = parseFloat(row.getAttribute('data-order-price') || '0');
                  var devEl = row.querySelector('[data-quote-deviation]');
                  if (devEl && orderPrice) {
                    var dev = ((d.price - orderPrice) / orderPrice) * 100;
                    var cls = dev >= 0 ? 'pnl-positive' : 'pnl-negative';
                    var sign = dev >= 0 ? '+' : '';
                    devEl.innerHTML = '<span class="' + cls + '">' + sign + dev.toFixed(2) + '%</span>';
                  }
                }

                // WB乖離（金曜のみ）
                var wbDevEl = row.querySelector('[data-wb-deviation]');
                if (wbDevEl) {
                  var wb = d.wbDeviation;
                  if (wb != null) {
                    var wbSign = wb >= 0 ? '+' : '';
                    var wbColor = wb >= 0 ? '#22c55e' : '#64748b';
                    wbDevEl.innerHTML = '<span style="color:' + wbColor + '; font-weight:' + (wb >= 0 ? '600' : '400') + ';">' + wbSign + wb.toFixed(2) + '%</span>';
                  } else {
                    wbDevEl.innerHTML = '<span style="color: #475569;">-</span>';
                  }
                }
              });

              // 行をエントリー可能性順にソート（ステータス → GU全条件OK → サージ比率）
              var statusOrder = { ordered: 0, holding: 1, watching: 2 };
              var tbody = document.querySelector('table tbody');
              if (tbody) {
                var rowArr = Array.prototype.slice.call(rows);
                rowArr.sort(function(a, b) {
                  var ta = a.getAttribute('data-ticker');
                  var tb = b.getAttribute('data-ticker');
                  var da = rowSortData[ta] || { guAllMet: 0, surgeRatio: 0, status: 'watching' };
                  var db = rowSortData[tb] || { guAllMet: 0, surgeRatio: 0, status: 'watching' };
                  var statusDiff = (statusOrder[da.status] != null ? statusOrder[da.status] : 2) - (statusOrder[db.status] != null ? statusOrder[db.status] : 2);
                  if (statusDiff !== 0) return statusDiff;
                  var guDiff = db.guAllMet - da.guAllMet;
                  if (guDiff !== 0) return guDiff;
                  return db.surgeRatio - da.surgeRatio;
                });
                rowArr.forEach(function(row) { tbody.appendChild(row); });
              }

              // サマリーバッジ更新
              var guEl = document.querySelector('[data-summary-gu]');
              if (guEl) { guEl.textContent = 'GU: ' + guCount; guEl.style.opacity = guCount ? '0.7' : '0.3'; }
              var boEl = document.querySelector('[data-summary-bo]');
              if (boEl) { boEl.textContent = 'BO: ' + boCount; boEl.style.opacity = boCount ? '0.7' : '0.3'; }
              var wbEl = document.querySelector('[data-summary-wb]');
              if (wbEl) { wbEl.textContent = 'WB: ' + wbCount; wbEl.style.opacity = wbCount ? '0.7' : '0.3'; }

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
            })
            .catch(function() { /* エラー時はスキップ */ });
        }

        poll();
        setInterval(poll, POLL_INTERVAL);
      })();
    </script>
  `;

  return c.html(layout("ウォッチリスト", "/watchlist", content));
});

export default app;
