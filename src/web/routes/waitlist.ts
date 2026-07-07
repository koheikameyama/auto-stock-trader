/**
 * ウェイトリスト登録メール 管理画面（GET /waitlist, POST /waitlist/:id/delete）
 *
 * 相場局面プロダクト（KOH-515 Phase 0）の `WaitlistEntry`（有料アラート先行案内の
 * メール登録）を一覧・削除する admin 画面。Basic認証の内側で、公開ホスト
 * （stock-buddy.net）には露出しない（app.ts の isPublicAllowedPath に含めない）。
 */

import { Hono } from "hono";
import { html, raw } from "hono/html";
import dayjs from "dayjs";
import { layout } from "../views/layout";
import { emptyState } from "../views/components";
import { COLORS } from "../views/styles";
import { prisma } from "../../lib/prisma";
import { getDaysAgoForDB } from "../../lib/market-date";

const app = new Hono();

/** source コードを日本語ラベルに変換 */
function sourceLabel(source: string | null): string {
  if (!source) return "不明";
  if (source === "regime-public") return "相場局面公開ページ";
  return source;
}

app.get("/", async (c) => {
  const [entries, total, recent7d, bySource] = await Promise.all([
    prisma.waitlistEntry.findMany({ orderBy: { createdAt: "desc" } }),
    prisma.waitlistEntry.count(),
    prisma.waitlistEntry.count({
      where: { createdAt: { gte: getDaysAgoForDB(7) } },
    }),
    prisma.waitlistEntry.groupBy({
      by: ["source"],
      _count: { _all: true },
      orderBy: { _count: { source: "desc" } },
    }),
  ]);

  const content = html`
    <div class="grid-2">
      <div class="card">
        <div class="card-title">総登録数</div>
        <div class="card-value">${total}</div>
      </div>
      <div class="card">
        <div class="card-title">直近7日</div>
        <div class="card-value">${recent7d}</div>
      </div>
    </div>

    ${bySource.length > 0
      ? html`<div class="card">
          <div class="card-title">登録元 別内訳</div>
          ${bySource.map(
            (s) => html`
              <div class="detail-row">
                <span class="detail-label">${sourceLabel(s.source)}</span>
                <span>${s._count._all}</span>
              </div>
            `,
          )}
        </div>`
      : ""}

    <p class="section-title">登録メール一覧（${entries.length}件）</p>
    ${entries.length > 0
      ? html`<div class="card responsive-table" style="padding:0">
          <div class="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>メールアドレス</th>
                  <th>登録元</th>
                  <th>登録日時</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                ${entries.map(
                  (e) => html`
                    <tr>
                      <td data-label="メール" style="white-space:normal;word-break:break-all">
                        ${e.email}
                      </td>
                      <td data-label="登録元">
                        <span class="badge badge-cold">${sourceLabel(e.source)}</span>
                      </td>
                      <td data-label="登録日時" style="color:${COLORS.textMuted}">
                        ${dayjs(e.createdAt).format("YYYY/MM/DD HH:mm")}
                      </td>
                      <td data-label="操作">
                        <form
                          method="post"
                          action="/waitlist/${e.id}/delete"
                          onsubmit="return confirm('${raw(e.email.replace(/'/g, "\\'"))} を削除しますか？')"
                          style="margin:0"
                        >
                          <button type="submit" class="btn-toggle btn-danger">
                            削除
                          </button>
                        </form>
                      </td>
                    </tr>
                  `,
                )}
              </tbody>
            </table>
          </div>
        </div>`
      : html`<div class="card">${emptyState("登録メールはありません")}</div>`}
  `;

  return c.html(layout("メール登録", "/waitlist", content));
});

app.post("/:id/delete", async (c) => {
  const id = c.req.param("id");
  try {
    await prisma.waitlistEntry.delete({ where: { id } });
  } catch (e) {
    // 既に削除済み等（P2025）は無視して一覧に戻す
    console.error("[waitlist-admin] delete failed:", e);
  }
  return c.redirect("/waitlist");
});

export default app;
