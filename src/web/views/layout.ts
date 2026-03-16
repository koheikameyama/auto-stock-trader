/**
 * HTML レイアウトテンプレート（PWA meta タグ含む）
 */

import { html, raw } from "hono/html";
import type { HtmlEscapedString } from "hono/utils/html";
import { CSS } from "./styles";

type HtmlContent = HtmlEscapedString | Promise<HtmlEscapedString>;

const NAV_ITEMS = [
  {
    path: "/",
    label: "ホーム",
    icon: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 9l9-7 9 7v11a2 2 0 01-2 2H5a2 2 0 01-2-2V9z"/><polyline points="9 22 9 12 15 12 15 22"/></svg>`,
  },
  {
    path: "/positions",
    label: "ポジション",
    icon: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2v20M17 5H9.5a3.5 3.5 0 000 7h5a3.5 3.5 0 010 7H6"/></svg>`,
  },
  {
    path: "/orders",
    label: "注文",
    icon: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M9 9h6M9 13h6M9 17h4"/></svg>`,
  },
  {
    path: "/risk",
    label: "リスク",
    icon: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 9v4M12 17h.01"/><path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/></svg>`,
  },
  {
    path: "/backtest",
    label: "BT",
    icon: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 3v18h18"/><path d="M18 17l-5-5-4 4-3-3"/></svg>`,
  },
  {
    path: "/accuracy",
    label: "精度",
    icon: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 22c5.523 0 10-4.477 10-10S17.523 2 12 2 2 6.477 2 12s4.477 10 10 10z"/><path d="M12 6v6l4 2"/></svg>`,
  },
  {
    path: "/history",
    label: "履歴",
    icon: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg>`,
  },
  {
    path: "/weekly",
    label: "週次",
    icon: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="4" width="18" height="18" rx="2" ry="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>`,
  },
  {
    path: "/news",
    label: "ニュース",
    icon: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 6h16M4 10h16M4 14h10M4 18h8"/></svg>`,
  },
  {
    path: "/scoring",
    label: "スコア",
    icon: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 20V10"/><path d="M18 20V4"/><path d="M6 20v-4"/></svg>`,
  },
];

export function layout(
  title: string,
  currentPath: string,
  content: HtmlContent,
): HtmlContent {
  return html`<!DOCTYPE html>
    <html lang="ja">
      <head>
        <meta charset="UTF-8" />
        <meta
          name="viewport"
          content="width=device-width, initial-scale=1.0, viewport-fit=cover"
        />
        <title>${title} - Stock Buddy</title>
        <meta name="theme-color" content="#0f172a" />
        <meta name="apple-mobile-web-app-capable" content="yes" />
        <meta
          name="apple-mobile-web-app-status-bar-style"
          content="black-translucent"
        />
        <link rel="manifest" href="/manifest.json" />
        <link rel="icon" type="image/svg+xml" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='90'>📈</text></svg>" />
        <link rel="apple-touch-icon" href="/icon-192.svg" />
        <style>
          ${CSS}
        </style>
      </head>
      <body>
        <header class="header">
          <div style="display:flex;align-items:center;gap:8px">
            <span>📈</span>
            <h1>${title}</h1>
          </div>
          <span class="refresh-info" id="lastUpdate"></span>
        </header>

        <main>${content}</main>

        <!-- Stock detail modal -->
        <div id="stock-modal"></div>

        <nav class="bottom-nav">
          ${NAV_ITEMS.map(
            (item) => html`
              <a
                href="${item.path}"
                class="nav-item ${currentPath === item.path ? "active" : ""}"
              >
                ${raw(item.icon)}
                <span>${item.label}</span>
              </a>
            `,
          )}
        </nav>

        <script>
          // Last update time
          function updateTime() {
            const el = document.getElementById("lastUpdate");
            if (el) el.textContent = new Date().toLocaleTimeString("ja-JP");
          }
          updateTime();

          // Register SW
          if ("serviceWorker" in navigator) {
            navigator.serviceWorker.register("/sw.js").catch(() => {});
          }

          // Tooltip (position:fixed で overflow クリップ回避)
          (function() {
            var tip = document.createElement('div');
            tip.id = 'tt-popup';
            document.body.appendChild(tip);
            var active = null;

            function show(el) {
              var text = el.getAttribute('data-tooltip');
              if (!text) return;
              tip.textContent = text;
              tip.style.display = 'block';
              var r = el.getBoundingClientRect();
              var tw = tip.offsetWidth;
              var th = tip.offsetHeight;
              var left = r.left + r.width / 2 - tw / 2;
              left = Math.max(8, Math.min(left, window.innerWidth - tw - 8));
              var top = r.top - th - 6;
              if (top < 8) top = r.bottom + 6;
              tip.style.left = left + 'px';
              tip.style.top = top + 'px';
              active = el;
            }

            function hide() {
              tip.style.display = 'none';
              active = null;
            }

            document.addEventListener('mouseover', function(e) {
              var el = e.target && e.target.closest ? e.target.closest('.tt') : null;
              if (el) show(el); else hide();
            });

            document.addEventListener('click', function(e) {
              var el = e.target && e.target.closest ? e.target.closest('.tt') : null;
              if (el) {
                if (active === el) { hide(); } else { show(el); }
              } else {
                hide();
              }
            }, true);
          })();

          // Chart tooltip
          (function() {
            var ct = document.createElement('div');
            ct.className = 'chart-tip';
            document.body.appendChild(ct);
            var activeBar = null;
            var DAYS = ['日','月','火','水','木','金','土'];

            function fmt(v) {
              return Number(v).toLocaleString('ja-JP');
            }

            function showChart(el, e) {
              var d = el.dataset;
              var parts = d.date.split('-');
              var dt = new Date(+parts[0], +parts[1] - 1, +parts[2]);
              var dayName = DAYS[dt.getDay()];
              var dateStr = +parts[1] + '/' + +parts[2] + '(' + dayName + ')';

              var lines = '<div class="ct-date">' + dateStr + '</div>';
              lines += '<div class="ct-row"><span><span class="ct-label">始</span> ' + fmt(d.open) + '</span><span><span class="ct-label">高</span> ' + fmt(d.high) + '</span></div>';
              lines += '<div class="ct-row"><span><span class="ct-label">安</span> ' + fmt(d.low) + '</span><span><span class="ct-label">終</span> ' + fmt(d.close) + '</span></div>';
              lines += '<div><span class="ct-label">出来高</span> ' + fmt(d.volume) + '</div>';
              if (d.change) {
                var chg = parseFloat(d.change);
                var pct = parseFloat(d.changePct);
                var sign = chg >= 0 ? '+' : '';
                var color = chg >= 0 ? '#22c55e' : '#ef4444';
                lines += '<div style="color:' + color + '">' + sign + fmt(d.change) + ' (' + sign + pct.toFixed(2) + '%)</div>';
              }
              ct.innerHTML = lines;
              ct.style.display = 'block';

              var tw = ct.offsetWidth;
              var th = ct.offsetHeight;
              var left = e.clientX - tw / 2;
              left = Math.max(8, Math.min(left, window.innerWidth - tw - 8));
              var top = e.clientY - th - 12;
              if (top < 8) top = e.clientY + 12;
              ct.style.left = left + 'px';
              ct.style.top = top + 'px';
              activeBar = el;
            }

            function hideChart() {
              ct.style.display = 'none';
              activeBar = null;
            }

            document.addEventListener('click', function(e) {
              var el = e.target && e.target.closest ? e.target.closest('[data-chart-bar]') : null;
              if (el) {
                e.stopPropagation();
                if (activeBar === el) { hideChart(); } else { showChart(el, e); }
              } else {
                hideChart();
              }
            }, true);
          })();

          // Stock detail modal
          function openStockModal(tickerCode) {
            var modal = document.getElementById('stock-modal');
            modal.innerHTML = '<div class="modal-overlay" onclick="if(event.target===this)closeStockModal()"><div class="modal-content"><div class="modal-loading">読み込み中...</div></div></div>';
            fetch('/api/stock/' + encodeURIComponent(tickerCode) + '/modal')
              .then(function(r) { return r.ok ? r.text() : null; })
              .then(function(h) {
                if (!h) { closeStockModal(); return; }
                modal.innerHTML = h;
              })
              .catch(function() { closeStockModal(); });
          }

          function switchModalTab(btn, tab) {
            var tabs = btn.parentNode.querySelectorAll('.modal-tab');
            tabs.forEach(function(t) { t.classList.remove('active'); });
            btn.classList.add('active');
            var panes = btn.closest('.modal-content').querySelectorAll('.modal-pane');
            panes.forEach(function(p) { p.style.display = p.dataset.tab === tab ? 'block' : 'none'; });
          }

          function closeStockModal() {
            document.getElementById('stock-modal').innerHTML = '';
          }

          document.addEventListener('keydown', function(e) {
            if (e.key === 'Escape') closeStockModal();
          });

          // Nikkei 225 chart period switching
          var nikkeiLabels = { '1d': '1日', '5d': '1週', '1mo': '1月', '3mo': '3月' };
          function switchNikkeiPeriod(period) {
            var tabs = document.querySelectorAll('.nikkei-tabs .chart-tab');
            tabs.forEach(function(t) {
              t.classList.toggle('active', t.textContent.trim() === nikkeiLabels[period]);
            });
            var body = document.getElementById('nikkei-chart-body');
            if (body) body.innerHTML = '<div class="empty" style="padding:40px 0">読み込み中...</div>';
            var params = new URLSearchParams(window.location.search);
            var token = params.get('token') || '';
            fetch('/api/nikkei/chart-html?period=' + period + '&token=' + encodeURIComponent(token))
              .then(function(r) { return r.ok ? r.text() : null; })
              .then(function(h) {
                if (h && body) body.innerHTML = h;
                else if (body) body.innerHTML = '<div class="empty">データ取得失敗</div>';
              })
              .catch(function() {
                if (body) body.innerHTML = '<div class="empty">データ取得失敗</div>';
              });
          }
          // Auto-load 1d chart on page load
          if (document.getElementById('nikkei-chart-body')) {
            switchNikkeiPeriod('1d');
          }

          // 株価を非同期取得してDOM更新
          (function() {
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
            fetch('/api/quotes?tickers=' + encodeURIComponent(tickers.join(',')) + '&token=' + encodeURIComponent(token))
              .then(function(r) { return r.json(); })
              .then(function(quotes) {
                var fmt = function(v) { return Number(v).toLocaleString('ja-JP', { maximumFractionDigits: 0 }); };
                var pnlHtml = function(v) {
                  var cls = v >= 0 ? 'pnl-positive' : 'pnl-negative';
                  var sign = v >= 0 ? '+' : '';
                  return '<span class="' + cls + '">' + sign + '¥' + fmt(v) + '</span>';
                };
                var pctHtml = function(v) {
                  var cls = v >= 0 ? 'pnl-positive' : 'pnl-negative';
                  var sign = v >= 0 ? '+' : '';
                  return '<span class="' + cls + '">' + sign + v.toFixed(2) + '%</span>';
                };

                var portfolioInvested = 0;
                var hasPortfolio = !!document.querySelector('[data-portfolio]');

                rows.forEach(function(row) {
                  var ticker = row.getAttribute('data-ticker');
                  var q = quotes[ticker];
                  if (!q) {
                    // 取得失敗時は「-」を表示
                    var loadings = row.querySelectorAll('.quote-loading');
                    loadings.forEach(function(el) { el.textContent = '-'; });
                    // ポートフォリオ計算: 取得失敗時は建値を使用
                    var ep = parseFloat(row.getAttribute('data-entry-price') || '0');
                    var qty = parseInt(row.getAttribute('data-quantity') || '0', 10);
                    if (ep && qty) portfolioInvested += ep * qty;
                    return;
                  }

                  var priceEl = row.querySelector('[data-quote-price]');
                  if (priceEl) priceEl.innerHTML = '¥' + fmt(q.price);

                  var entryPrice = parseFloat(row.getAttribute('data-entry-price') || '0');
                  var quantity = parseInt(row.getAttribute('data-quantity') || '0', 10);

                  // ポジション: 含み損益
                  var pnlEl = row.querySelector('[data-quote-pnl]');
                  if (pnlEl && entryPrice && quantity) {
                    var pnl = (q.price - entryPrice) * quantity;
                    pnlEl.innerHTML = pnlHtml(pnl);
                  }

                  // ポジション: 損益率
                  var rateEl = row.querySelector('[data-quote-pnl-rate]');
                  if (rateEl && entryPrice) {
                    var rate = ((q.price - entryPrice) / entryPrice) * 100;
                    rateEl.innerHTML = pctHtml(rate);
                  }

                  // 注文: 乖離率
                  var devEl = row.querySelector('[data-quote-deviation]');
                  var orderPrice = parseFloat(row.getAttribute('data-order-price') || '0');
                  if (devEl && orderPrice) {
                    var dev = ((q.price - orderPrice) / orderPrice) * 100;
                    devEl.innerHTML = pctHtml(dev);
                  }

                  // ポートフォリオ計算用
                  if (quantity) portfolioInvested += q.price * quantity;
                });

                // ポートフォリオ合計を更新
                if (hasPortfolio) {
                  var pEl = document.querySelector('[data-portfolio]');
                  var cash = parseFloat(pEl.getAttribute('data-cash') || '0');
                  var budget = parseFloat(pEl.getAttribute('data-total-budget') || '0');
                  var total = cash + portfolioInvested;
                  var totalPnl = total - budget;

                  var totalEl = document.querySelector('[data-portfolio-total]');
                  if (totalEl) totalEl.textContent = '¥' + fmt(total);

                  var pnlEl2 = document.querySelector('[data-portfolio-pnl]');
                  if (pnlEl2) pnlEl2.innerHTML = pnlHtml(totalPnl);
                }
              })
              .catch(function() {
                // 取得失敗時はローディング表示を「-」に
                document.querySelectorAll('.quote-loading').forEach(function(el) {
                  el.textContent = '-';
                });
              });
          })();
        </script>
      </body>
    </html>`;
}
