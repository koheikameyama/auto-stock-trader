/**
 * HTML レイアウトテンプレート（PWA meta タグ含む）
 */

import { html } from "hono/html";
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
    path: "/history",
    label: "履歴",
    icon: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg>`,
  },
];

export function layout(
  title: string,
  currentPath: string,
  content: HtmlContent,
  token: string,
): HtmlContent {
  const qs = `?token=${token}`;
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
        <link rel="apple-touch-icon" href="/icon-192.png" />
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

        <nav class="bottom-nav">
          ${NAV_ITEMS.map(
            (item) => html`
              <a
                href="${item.path}${qs}"
                class="nav-item ${currentPath === item.path ? "active" : ""}"
              >
                ${{ __html: item.icon }}
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

          // Auto refresh
          const isMarketHours = (() => {
            const now = new Date();
            const h = now.getHours();
            const d = now.getDay();
            return d >= 1 && d <= 5 && h >= 9 && h < 16;
          })();
          const interval = isMarketHours ? 30000 : 60000;
          setTimeout(() => location.reload(), interval);

          // Register SW
          if ("serviceWorker" in navigator) {
            navigator.serviceWorker.register("/sw.js").catch(() => {});
          }
        </script>
      </body>
    </html>`;
}
