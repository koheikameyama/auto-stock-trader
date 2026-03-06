/**
 * トークン認証ミドルウェア
 *
 * クエリパラメータ ?token=xxx で認証。
 * DASHBOARD_TOKEN 環境変数と一致すればOK。
 */

import type { Context, Next } from "hono";

export async function authMiddleware(c: Context, next: Next) {
  const token = c.req.query("token");
  const expected = process.env.DASHBOARD_TOKEN;

  if (!expected) {
    return c.text("DASHBOARD_TOKEN is not configured", 500);
  }

  if (!token || token !== expected) {
    return c.text("Unauthorized", 401);
  }

  await next();
}
