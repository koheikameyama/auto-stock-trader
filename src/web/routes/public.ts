/**
 * 相場局面プロダクト（KOH-515 Phase 0）の公開ルート。
 *
 * - GET  /live          : 公開ページ（現局面を SSR + ウェイトリスト登録フォーム）
 * - POST /live/waitlist : メールのウェイトリスト登録（需要検証）
 *
 * いずれも公開（Basic認証の外側）。app.ts で認証バイパス済み。
 * Phase 1 でルート（stock-buddy.net /）に host ベースで載せ替える。
 */

import { Hono } from "hono";
import { prisma } from "../../lib/prisma";
import { getRegimeCached } from "../regime-cache";
import {
  getLevelEmoji,
  getLevelLabel,
  getLevelSummary,
} from "../../core/regime-shift-detector";
import {
  publicRegimePage,
  waitlistResultPage,
  type PublicRegimeData,
} from "../views/public-regime";

const app = new Hono();

/** ざっくりしたメール形式チェック（RFC 完全準拠は不要、明らかな誤入力を弾く目的） */
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const EMAIL_MAX_LEN = 254;

/** GET /live — 公開ページ（現局面を SSR） */
app.get("/", async (c) => {
  let data: PublicRegimeData | null = null;
  try {
    const r = await getRegimeCached();
    data = {
      level: r.level,
      levelLabel: getLevelLabel(r.level),
      emoji: getLevelEmoji(r.level),
      summary: getLevelSummary(r.level),
      asOfDate: r.asOfDate.toISOString().slice(0, 10),
    };
  } catch (e) {
    console.error("[public/live] regime unavailable:", e);
  }
  return c.html(publicRegimePage(data));
});

/** POST /live/waitlist — メール登録 */
app.post("/waitlist", async (c) => {
  const body = await c.req.parseBody();
  const email = String(body.email ?? "").trim().toLowerCase();

  if (!EMAIL_RE.test(email) || email.length > EMAIL_MAX_LEN) {
    return c.html(
      waitlistResultPage({
        ok: false,
        message: "メールアドレスの形式が正しくないようです。もう一度お試しください。",
      }),
      400,
    );
  }

  try {
    // 二重登録は静かに成功扱い（冪等）
    await prisma.waitlistEntry.upsert({
      where: { email },
      create: { email, source: "regime-public" },
      update: {},
    });
  } catch (e) {
    console.error("[public/waitlist] save failed:", e);
    return c.html(
      waitlistResultPage({
        ok: false,
        message: "登録に失敗しました。時間をおいて再度お試しください。",
      }),
      500,
    );
  }

  return c.html(
    waitlistResultPage({
      ok: true,
      message: "先行案内リストに登録しました。公開時にメールでご案内します。",
    }),
  );
});

export default app;
