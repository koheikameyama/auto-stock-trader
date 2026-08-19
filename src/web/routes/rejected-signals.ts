/**
 * 弾かれたシグナル一覧ページ（GET /rejected-signals）
 */

import { Hono } from "hono";
import { html } from "hono/html";
import { Prisma } from "@prisma/client";
import { prisma } from "../../lib/prisma";
import { COLORS } from "../views/styles";
import { layout } from "../views/layout";
import { strategyShortLabel, strategyColor } from "../views/strategy-labels";
import { strategyBadge, pagination, parsePage } from "../views/components";
import { classifyExitReason } from "../../core/exit-reason";
import { QUERY_LIMITS } from "../../lib/constants";

const app = new Hono();

function formatReturnPct(val: number | null): string {
  if (val === null) return "-";
  const sign = val >= 0 ? "+" : "";
  return `${sign}${val.toFixed(1)}%`;
}

function returnColor(val: number | null): string {
  if (val === null) return COLORS.textMuted;
  if (val >= 3) return "#22c55e";
  if (val <= -3) return "#ef4444";
  return COLORS.text;
}


app.get("/", async (c) => {
  const strategy = c.req.query("strategy") ?? "all";
  const page = parsePage(c.req.query("page"));
  const pageSize = QUERY_LIMITS.REJECTED_SIGNALS;
  const where: Prisma.RejectedSignalWhereInput = {};
  if (strategy !== "all") where.strategy = strategy;

  // 一覧はページ送りで全件辿れる。理由別集計はページではなく全件が母数
  // （ページごとに集計が変わると傾向の指標にならないため DB 側で集計する）
  const [total, signals, grouped] = await Promise.all([
    prisma.rejectedSignal.count({ where }),
    prisma.rejectedSignal.findMany({
      where,
      orderBy: { rejectedAt: "desc" },
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
    prisma.rejectedSignal.groupBy({
      by: ["reasonLabel"],
      where,
      _count: { _all: true },
      _avg: { return5dPct: true, return10dPct: true },
    }),
  ]);

  const totalPages = Math.max(1, Math.ceil(total / pageSize));

  // 範囲外のページは空表示のまま戻れなくなるので最終ページへ寄せる
  if (page > totalPages) {
    const query = new URLSearchParams({ strategy, page: String(totalPages) });
    return c.redirect(`/rejected-signals?${query.toString()}`);
  }

  // 理由別集計（_avg は null を除外して平均するため、従来の「非nullのみ平均」と同じ）
  const summary = grouped
    .map((g) => ({
      label: g.reasonLabel,
      count: g._count._all,
      avg5dPct: g._avg.return5dPct,
      avg10dPct: g._avg.return10dPct,
    }))
    .sort((a, b) => b.count - a.count);

  // === 決済後フォワード（決済理由別） ===
  // rejected（＝入らなかった判断）とは別問い：「切った後に上がったか＝早く切りすぎか」
  const posWhere: Prisma.TradingPositionWhereInput = {
    status: "closed",
    exitedAt: { not: null },
    OR: [{ postExitReturn5dPct: { not: null } }, { postExitReturn10dPct: { not: null } }],
  };
  if (strategy !== "all") posWhere.strategy = strategy;

  const closedPositions = await prisma.tradingPosition.findMany({
    where: posWhere,
    orderBy: { exitedAt: "desc" },
    take: 500,
    select: {
      strategy: true,
      exitSnapshot: true,
      exitedAt: true,
      postExitReturn5dPct: true,
      postExitReturn10dPct: true,
      postExitMaxHighPct: true,
      postExitMinLowPct: true,
      stock: { select: { tickerCode: true } },
    },
  });

  // サンプルが少ない層は平均・中央値が外れ値（例: 建値撤退後 +35% の1件）に
  // 引きずられて誤読を招く。n<MIN_SAMPLE の層は数値を伏せる。
  const MIN_EXIT_SAMPLE = 5;

  const median = (arr: number[]): number | null => {
    if (arr.length === 0) return null;
    const s = [...arr].sort((a, b) => a - b);
    const mid = Math.floor(s.length / 2);
    return s.length % 2 === 0 ? (s[mid - 1] + s[mid]) / 2 : s[mid];
  };
  const avg = (arr: number[]): number | null =>
    arr.length > 0 ? arr.reduce((a, b) => a + b, 0) / arr.length : null;

  type ExitMember = { ticker: string; exitedAt: Date | null; ret5d: number | null; ret10d: number | null };
  type ExitAgg = {
    label: string; defensive: boolean;
    count: number;
    ret5d: number[];
    ret10d: number[];
    high: number[];
    low: number[];
    members: ExitMember[];
  };
  const exitMap = new Map<string, ExitAgg>();
  for (const p of closedPositions) {
    const reason = (p.exitSnapshot as { exitReason?: string } | null)?.exitReason ?? "";
    const cls = classifyExitReason(reason);
    const e = exitMap.get(cls.code) ?? { label: cls.label, defensive: cls.defensive, count: 0, ret5d: [], ret10d: [], high: [], low: [], members: [] };
    e.count++;
    if (p.postExitReturn5dPct !== null) e.ret5d.push(p.postExitReturn5dPct);
    if (p.postExitReturn10dPct !== null) e.ret10d.push(p.postExitReturn10dPct);
    if (p.postExitMaxHighPct !== null) e.high.push(p.postExitMaxHighPct);
    if (p.postExitMinLowPct !== null) e.low.push(p.postExitMinLowPct);
    e.members.push({
      ticker: p.stock?.tickerCode ?? "-",
      exitedAt: p.exitedAt,
      ret5d: p.postExitReturn5dPct,
      ret10d: p.postExitReturn10dPct,
    });
    exitMap.set(cls.code, e);
  }

  // 勝ち負け内訳は決済後10日を優先し、無ければ5日で判定
  const forwardOf = (m: ExitMember): number | null => m.ret10d ?? m.ret5d;

  const exitSummary = Array.from(exitMap.values())
    .map((v) => {
      const forwards = v.members.map(forwardOf).filter((x): x is number => x !== null);
      const nForward = forwards.length;
      const positives = forwards.filter((x) => x > 0);
      const enoughSample = v.count >= MIN_EXIT_SAMPLE;
      return {
        label: v.label,
        defensive: v.defensive,
        count: v.count,
        enoughSample,
        // n<MIN_EXIT_SAMPLE では数値を出さない（外れ値誤読防止）
        avg5dPct: enoughSample ? avg(v.ret5d) : null,
        median5dPct: enoughSample ? median(v.ret5d) : null,
        avg10dPct: enoughSample ? avg(v.ret10d) : null,
        median10dPct: enoughSample ? median(v.ret10d) : null,
        avgHighPct: enoughSample ? avg(v.high) : null,
        avgLowPct: enoughSample ? avg(v.low) : null,
        // 勝ち負け内訳とレンジ（サンプル数に関わらず出す：偏りは常に有用）
        nForward,
        winCount: positives.length,
        lossCount: nForward - positives.length,
        minForward: nForward > 0 ? Math.min(...forwards) : null,
        maxForward: nForward > 0 ? Math.max(...forwards) : null,
        members: v.members.sort((a, b) => (forwardOf(b) ?? -Infinity) - (forwardOf(a) ?? -Infinity)),
      };
    })
    // 守りの決済（損切り・BE）を先頭に、あとは件数順
    .sort((a, b) => (Number(b.defensive) - Number(a.defensive)) || (b.count - a.count));

  const strategyOptions = ["all", "gapup", "post-surge-consolidation"];

  const body = html`
    <div style="max-width:1100px;margin:0 auto;padding:16px">
      <h1 style="font-size:1.25rem;font-weight:700;margin-bottom:16px;color:${COLORS.text}">弾かれたシグナル</h1>

      <!-- 戦略フィルター -->
      <div style="display:flex;gap:8px;margin-bottom:20px">
        ${strategyOptions.map((s) => {
          const activeBg = s === "all" ? COLORS.accent : strategyColor(s);
          return html`
          <a href="/rejected-signals?strategy=${s}"
             style="padding:4px 12px;border-radius:4px;font-size:0.8rem;text-decoration:none;
                    background:${strategy === s ? activeBg : COLORS.card};
                    color:${strategy === s ? "#fff" : COLORS.textMuted};
                    border:1px solid ${COLORS.border}">
            ${s === "all" ? "すべて" : strategyShortLabel(s)}
          </a>
        `;
        })}
      </div>

      <!-- 理由別集計カード -->
      <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:12px;margin-bottom:24px">
        ${summary.map((s) => html`
          <div style="background:${COLORS.card};border:1px solid ${COLORS.border};border-radius:8px;padding:12px">
            <div style="font-size:0.75rem;color:${COLORS.textMuted};margin-bottom:4px">${s.label}</div>
            <div style="font-size:1.1rem;font-weight:700;color:${COLORS.text};margin-bottom:6px">${s.count}件</div>
            <div style="font-size:0.8rem;color:${returnColor(s.avg5dPct)}">5日: ${formatReturnPct(s.avg5dPct)}</div>
            <div style="font-size:0.8rem;color:${returnColor(s.avg10dPct)}">10日: ${formatReturnPct(s.avg10dPct)}</div>
          </div>
        `)}
      </div>

      <!-- 決済後フォワード（決済理由別）: 「切った後に上がったか＝早く切りすぎか」 -->
      <div style="border-top:1px solid ${COLORS.border};margin:8px 0 20px"></div>
      <h2 style="font-size:1.05rem;font-weight:700;margin-bottom:4px;color:${COLORS.text}">決済後フォワード（決済理由別）</h2>
      <p style="font-size:0.75rem;color:${COLORS.textMuted};margin-bottom:14px;line-height:1.5">
        決済価格を起点にしたリターン。<strong>損切り・BE撤退</strong>で<strong style="color:#22c55e">プラス</strong>なら「早く切りすぎ」の兆候、<strong style="color:#ef4444">マイナス</strong>なら決済判断が正しい（続落を回避）。
        <strong>平均は1件のスパイクに引っ張られる</strong>ので<strong>中央値</strong>と<strong>勝ち/負け内訳</strong>を併記。サンプル ${MIN_EXIT_SAMPLE}件未満の層は数値を伏せる（外れ値誤読防止）。BT却下#38では全決済理由で決済後は続落＝現行の早期手仕舞いが正解と確定済み。
      </p>
      ${!exitSummary.length ? html`
        <div style="background:${COLORS.card};border:1px solid ${COLORS.border};border-radius:8px;padding:24px;text-align:center;color:${COLORS.textMuted};margin-bottom:24px">
          決済後フォワードのデータなし（決済から10営業日未経過 or クローズ実績なし）
        </div>
      ` : html`
        <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(240px,1fr));gap:12px;margin-bottom:24px">
          ${exitSummary.map((s) => html`
            <div style="background:${COLORS.card};border:1px solid ${s.defensive ? "#f59e0b55" : COLORS.border};border-radius:8px;padding:12px">
              <div style="font-size:0.75rem;color:${COLORS.textMuted};margin-bottom:4px">
                ${s.label}${s.defensive ? html`<span style="color:#f59e0b"> ●守り</span>` : ""}
              </div>
              <div style="font-size:1.1rem;font-weight:700;color:${COLORS.text};margin-bottom:6px">${s.count}件</div>
              ${!s.enoughSample ? html`
                <div style="font-size:0.8rem;color:${COLORS.textMuted};margin-bottom:6px">
                  サンプル不足（判定不能・${MIN_EXIT_SAMPLE}件以上で表示）
                </div>
              ` : html`
                <div style="font-size:0.8rem;color:${returnColor(s.median10dPct)}">
                  決済後10日 中央値: <strong>${formatReturnPct(s.median10dPct)}</strong>
                  <span style="color:${COLORS.textMuted};font-size:0.72rem">（平均 ${formatReturnPct(s.avg10dPct)}）</span>
                </div>
                <div style="font-size:0.8rem;color:${returnColor(s.median5dPct)}">
                  決済後5日 中央値: <strong>${formatReturnPct(s.median5dPct)}</strong>
                  <span style="color:${COLORS.textMuted};font-size:0.72rem">（平均 ${formatReturnPct(s.avg5dPct)}）</span>
                </div>
                <div style="font-size:0.7rem;color:${COLORS.textMuted};margin-top:4px">
                  H(最大戻り) ${formatReturnPct(s.avgHighPct)} / L(最大続落) ${formatReturnPct(s.avgLowPct)}
                </div>
              `}
              <div style="font-size:0.72rem;color:${COLORS.textMuted};margin-top:6px;padding-top:6px;border-top:1px dashed ${COLORS.border}">
                決済後の値動き:
                <span style="color:#22c55e">↑${s.winCount}件</span> /
                <span style="color:#ef4444">↓${s.lossCount}件</span>
                ${s.minForward !== null ? html`<br>レンジ ${formatReturnPct(s.minForward)} 〜 ${formatReturnPct(s.maxForward)}` : ""}
              </div>
              ${s.members.length ? html`
                <details style="margin-top:6px">
                  <summary style="font-size:0.72rem;color:${COLORS.textMuted};cursor:pointer">個別銘柄を表示</summary>
                  <div style="margin-top:6px;font-size:0.72rem">
                    ${s.members.map((m) => html`
                      <div style="display:flex;justify-content:space-between;gap:8px;padding:2px 0;border-bottom:1px solid ${COLORS.border}">
                        <span style="color:${COLORS.text};font-weight:600">${m.ticker}</span>
                        <span style="color:${COLORS.textMuted}">${m.exitedAt ? new Date(m.exitedAt).toLocaleDateString("ja-JP", { month: "2-digit", day: "2-digit" }) : "-"}</span>
                        <span style="color:${returnColor(m.ret10d ?? m.ret5d)};min-width:52px;text-align:right">${formatReturnPct(m.ret10d ?? m.ret5d)}</span>
                      </div>
                    `)}
                  </div>
                </details>
              ` : ""}
            </div>
          `)}
        </div>
      `}

      <!-- 個別一覧テーブル -->
      <h2 style="font-size:1.05rem;font-weight:700;margin-bottom:12px;color:${COLORS.text}">弾かれたシグナル一覧 ${total}件</h2>
      <div class="table-wrap" style="background:${COLORS.card};border:1px solid ${COLORS.border};border-radius:8px">
        <table style="width:100%;border-collapse:collapse;font-size:0.82rem">
          <thead>
            <tr style="border-bottom:1px solid ${COLORS.border};color:${COLORS.textMuted}">
              <th style="padding:8px 12px;text-align:left">日付</th>
              <th style="padding:8px 12px;text-align:left">銘柄</th>
              <th style="padding:8px 12px;text-align:left">戦略</th>
              <th style="padding:8px 12px;text-align:left">理由</th>
              <th style="padding:8px 12px;text-align:right">価格</th>
              <th style="padding:8px 12px;text-align:right">5日後</th>
              <th style="padding:8px 12px;text-align:right">10日後</th>
            </tr>
          </thead>
          <tbody>
            ${!signals.length ? html`
              <tr><td colspan="7" style="padding:24px;text-align:center;color:${COLORS.textMuted}">データなし</td></tr>
            ` : signals.map((s) => html`
              <tr style="border-bottom:1px solid ${COLORS.border}">
                <td style="padding:8px 12px;color:${COLORS.textMuted}">${new Date(s.rejectedAt).toLocaleDateString("ja-JP")}</td>
                <td style="padding:8px 12px;color:${COLORS.text};font-weight:600">${s.ticker}</td>
                <td style="padding:8px 12px">${strategyBadge(s.strategy)}</td>
                <td style="padding:8px 12px;color:${COLORS.text}">${s.reasonLabel}</td>
                <td style="padding:8px 12px;text-align:right;color:${COLORS.text}">¥${s.entryPrice.toLocaleString()}</td>
                <td style="padding:8px 12px;text-align:right;color:${returnColor(s.return5dPct)}">${formatReturnPct(s.return5dPct)}</td>
                <td style="padding:8px 12px;text-align:right;color:${returnColor(s.return10dPct)}">${formatReturnPct(s.return10dPct)}</td>
              </tr>
            `)}
          </tbody>
        </table>
      </div>
      ${pagination("/rejected-signals", page, totalPages, { strategy })}
    </div>
  `;

  return c.html(layout("弾かれたシグナル", "/rejected-signals", body));
});

export default app;
