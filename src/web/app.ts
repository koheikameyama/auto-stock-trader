/**
 * Hono アプリ定義・ルート登録
 */

import { Hono } from "hono";
import { basicAuth } from "hono/basic-auth";

import dashboardRoute from "./routes/dashboard";
import positionsRoute from "./routes/positions";
import ordersRoute from "./routes/orders";
import historyRoute from "./routes/history";
import riskRoute from "./routes/risk";
import apiRoute from "./routes/api";

export const app = new Hono();

// Health check (no auth)
app.get("/api/health", (c) => {
  return c.json({ status: "ok", timestamp: new Date().toISOString() });
});

// Basic認証（ヘルスチェックは除外）
app.use("*", async (c, next) => {
  if (c.req.path === "/api/health") {
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
    name: "Stock Buddy",
    short_name: "StockBuddy",
    description: "自動売買シミュレーション ダッシュボード",
    start_url: "/",
    display: "standalone",
    background_color: "#0f172a",
    theme_color: "#0f172a",
    icons: [
      { src: "/icon-192.png", sizes: "192x192", type: "image/png" },
      { src: "/icon-512.png", sizes: "512x512", type: "image/png" },
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

// SVG icon endpoints (no auth)
app.get("/icon-192.png", (c) => {
  return c.redirect(
    "data:image/svg+xml," +
      encodeURIComponent(
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 192 192"><rect width="192" height="192" rx="32" fill="#0f172a"/><text x="96" y="130" text-anchor="middle" font-size="120">📈</text></svg>',
      ),
  );
});

app.get("/icon-512.png", (c) => {
  return c.redirect(
    "data:image/svg+xml," +
      encodeURIComponent(
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><rect width="512" height="512" rx="64" fill="#0f172a"/><text x="256" y="350" text-anchor="middle" font-size="300">📈</text></svg>',
      ),
  );
});

// Page routes
app.route("/", dashboardRoute);
app.route("/positions", positionsRoute);
app.route("/orders", ordersRoute);
app.route("/history", historyRoute);
app.route("/risk", riskRoute);

// API routes (authenticated)
app.route("/api", apiRoute);
