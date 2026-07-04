/**
 * Hono アプリ定義・ルート登録
 */

import { Hono } from "hono";
import { basicAuth } from "hono/basic-auth";

import dashboardRoute from "./routes/dashboard";
import positionsRoute from "./routes/positions";
import ordersRoute from "./routes/orders";
import watchlistRoute from "./routes/watchlist";
import historyRoute from "./routes/history";
import riskRoute from "./routes/risk";
import weeklyRoute from "./routes/weekly";
import unfilledOrdersRoute from "./routes/unfilled-orders";
import newsRoute from "./routes/news";
import apiRoute from "./routes/api";
import cronRoute from "./routes/cron";
import rejectedSignalsRoute from "./routes/rejected-signals";
import regimeRoute from "./routes/regime";
import publicRoute, { renderPublicRegimePage } from "./routes/public";

export const app = new Hono();

/**
 * host 分離:
 *   - stock-buddy.net (apex/www) = 公開プロダクト（相場局面）。admin は露出しない
 *   - admin.stock-buddy.net / localhost / その他 = 従来の個人 admin（Basic認証）
 */
const PUBLIC_HOSTS = new Set(["stock-buddy.net", "www.stock-buddy.net"]);

function isPublicHost(hostHeader: string | undefined): boolean {
  const host = (hostHeader ?? "").toLowerCase().split(":")[0];
  return PUBLIC_HOSTS.has(host);
}

/**
 * 公開ホストで許可するパス（これ以外は 404 で admin を隠す）。
 * /api/cron は cron-job.org / GitHub Actions が stock-buddy.net を叩くため許可する
 * （cronRoute 側で Bearer CRON_SECRET 認証されており、公開ホストでも安全）。
 */
function isPublicAllowedPath(path: string): boolean {
  return (
    path === "/" ||
    path === "/live" ||
    path.startsWith("/live/") ||
    path === "/api/regime" ||
    path === "/api/health" ||
    path.startsWith("/api/cron")
  );
}

// Health check (no auth)
app.get("/api/health", (c) => {
  return c.json({ status: "ok", timestamp: new Date().toISOString() });
});

// 公開ホスト（stock-buddy.net）は公開パス以外を 404。admin ルート・認証プロンプトを露出させない
app.use("*", async (c, next) => {
  if (isPublicHost(c.req.header("host")) && !isPublicAllowedPath(c.req.path)) {
    return c.notFound();
  }
  return next();
});

// Basic認証（ヘルスチェック・cron・公開レジームAPIは除外）
// 注: /api/regime は公開（無料サブセット）。/api/regime/full は除外しないので認証内側のまま。
app.use("*", async (c, next) => {
  if (
    isPublicHost(c.req.header("host")) ||
    c.req.path === "/api/health" ||
    c.req.path.startsWith("/api/cron") ||
    c.req.path === "/api/regime" ||
    c.req.path === "/live" ||
    c.req.path.startsWith("/live/")
  ) {
    return next();
  }
  const auth = basicAuth({
    username: process.env.BASIC_AUTH_USER || "admin",
    password: process.env.BASIC_AUTH_PASS || "",
  });
  return auth(c, next);
});

// PWA assets (no auth)
app.get("/manifest.json", async (c) => {
  const manifest = {
    name: "Auto Stock Trader",
    short_name: "StockBuddy",
    description: "自動売買シミュレーション ダッシュボード",
    start_url: "/",
    display: "standalone",
    background_color: "#0f172a",
    theme_color: "#0f172a",
    icons: [
      {
        src: "/icon-192.svg",
        sizes: "192x192",
        type: "image/svg+xml",
        purpose: "any",
      },
      {
        src: "/icon-512.svg",
        sizes: "512x512",
        type: "image/svg+xml",
        purpose: "any",
      },
    ],
  };
  return c.json(manifest);
});

app.get("/sw.js", (c) => {
  const sw = `
const CACHE_NAME = 'stock-buddy-v1';
const STATIC_ASSETS = ['/manifest.json'];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(STATIC_ASSETS))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  // API/HTML: network-first
  if (url.pathname.startsWith('/api') || e.request.headers.get('accept')?.includes('text/html')) {
    e.respondWith(
      fetch(e.request).catch(() => caches.match(e.request))
    );
    return;
  }
  // Static: cache-first
  e.respondWith(
    caches.match(e.request).then((r) => r || fetch(e.request))
  );
});
`;
  c.header("Content-Type", "application/javascript");
  return c.body(sw);
});

// SVG icon endpoints
const ICON_SVG_192 =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 192 192"><rect width="192" height="192" rx="32" fill="#0f172a"/><text x="96" y="130" text-anchor="middle" font-size="120">📈</text></svg>';

const ICON_SVG_512 =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><rect width="512" height="512" rx="64" fill="#0f172a"/><text x="256" y="350" text-anchor="middle" font-size="300">📈</text></svg>';

app.get("/icon-192.svg", (c) => {
  c.header("Content-Type", "image/svg+xml");
  c.header("Cache-Control", "public, max-age=604800");
  return c.body(ICON_SVG_192);
});

app.get("/icon-512.svg", (c) => {
  c.header("Content-Type", "image/svg+xml");
  c.header("Cache-Control", "public, max-age=604800");
  return c.body(ICON_SVG_512);
});

// ルート「/」は host で出し分け: 公開ホスト → 公開ページ / admin ホスト → dashboard
app.get("/", async (c, next) => {
  if (isPublicHost(c.req.header("host"))) {
    return renderPublicRegimePage(c);
  }
  await next();
});

// Page routes
app.route("/", dashboardRoute);
app.route("/positions", positionsRoute);
app.route("/orders", ordersRoute);
app.route("/watchlist", watchlistRoute);
app.route("/history", historyRoute);
app.route("/risk", riskRoute);
app.route("/weekly", weeklyRoute);
app.route("/unfilled-orders", unfilledOrdersRoute);
app.route("/news", newsRoute);
app.route("/rejected-signals", rejectedSignalsRoute);

// 相場局面プロダクト 公開ページ（/live は公開）
app.route("/live", publicRoute);

// 相場局面 API（/api/regime は公開、/api/regime/full は認証内側）
app.route("/api/regime", regimeRoute);

// API routes (authenticated)
app.route("/api", apiRoute);

// Cron routes (Bearer CRON_SECRET auth)
app.route("/api/cron", cronRoute);
