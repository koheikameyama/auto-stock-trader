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
    path: "/contrarian",
    label: "見送り",
    icon: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 17l6-6 4 4 8-8"/><path d="M17 7h4v4"/></svg>`,
  },
  {
    path: "/history",
    label: "履歴",
    icon: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg>`,
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
        </script>
      </body>
    </html>`;
}
