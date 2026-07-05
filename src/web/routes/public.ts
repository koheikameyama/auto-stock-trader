/**
 * 相場局面プロダクト（KOH-515 Phase 0）の公開ルート。
 *
 * - GET  /live          : 公開ページ（現局面を SSR + ウェイトリスト登録フォーム）
 * - POST /live/waitlist : メールのウェイトリスト登録（需要検証）
 *
 * いずれも公開（Basic認証の外側）。app.ts で認証バイパス済み。
 * Phase 1 でルート（stock-buddy.net /）に host ベースで載せ替える。
 */

import { Hono, type Context } from "hono";
import { prisma } from "../../lib/prisma";
import { sendWaitlistWelcomeEmail } from "../../lib/mail";
import { getRegimeCached } from "../regime-cache";
import {
  getLevelEmoji,
  getLevelLabel,
  getLevelSummary,
  SIGNAL_LABELS,
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

/** 公開ページ（現局面を SSR）をレンダリング。/live と 公開ホストのルート「/」で共用。 */
export async function renderPublicRegimePage(c: Context): Promise<Response> {
  let data: PublicRegimeData | null = null;
  try {
    const r = await getRegimeCached();
    data = {
      level: r.level,
      levelLabel: getLevelLabel(r.level),
      emoji: getLevelEmoji(r.level),
      summary: getLevelSummary(r.level),
      asOfDate: r.asOfDate.toISOString().slice(0, 10),
      breadth: r.current.breadth,
      vix: Number.isFinite(r.current.vix) ? r.current.vix : null,
      signalCount: r.signalCount,
      signalTotal: Object.keys(SIGNAL_LABELS).length,
    };
  } catch (e) {
    console.error("[public/live] regime unavailable:", e);
  }
  return c.html(publicRegimePage(data));
}

/** GET /live — 公開ページ */
app.get("/", (c) => renderPublicRegimePage(c));

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
    // 二重登録は静かに成功扱い（冪等）。新規登録時のみ確認メールを送る。
    const existing = await prisma.waitlistEntry.findUnique({
      where: { email },
      select: { id: true },
    });
    if (!existing) {
      try {
        await prisma.waitlistEntry.create({
          data: { email, source: "regime-public" },
        });
        // メール送信の失敗は登録成功を妨げない（no-op 設定時も含めて握りつぶす）
        await sendWaitlistWelcomeEmail(email).catch((e) => {
          console.error("[public/waitlist] welcome email failed:", e);
        });
      } catch (e) {
        // 同時二重送信での unique 制約違反(P2002)は既登録として成功扱い（メールは送らない）
        if (
          !(
            e &&
            typeof e === "object" &&
            "code" in e &&
            (e as { code?: string }).code === "P2002"
          )
        ) {
          throw e;
        }
      }
    }
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
