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
import { strategyBadge } from "../views/components";
import { classifyExitReason } from "../../core/exit-reason";

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
  const where: Prisma.RejectedSignalWhereInput = {};
  if (strategy !== "all") where.strategy = strategy;

  const signals = await prisma.rejectedSignal.findMany({
    where,
    orderBy: { rejectedAt: "desc" },
    take: 200,
  });

  // 理由別集計
  const summaryMap = new Map<string, { count: number; sum5d: number; count5d: number; sum10d: number; count10d: number }>();
  for (const s of signals) {
    const entry = summaryMap.get(s.reasonLabel) ?? { count: 0, sum5d: 0, count5d: 0, sum10d: 0, count10d: 0 };
    entry.count++;
    if (s.return5dPct !== null) { entry.sum5d += s.return5dPct; entry.count5d++; }
    if (s.return10dPct !== null) { entry.sum10d += s.return10dPct; entry.count10d++; }
    summaryMap.set(s.reasonLabel, entry);
  }

  const summary = Array.from(summaryMap.entries()).map(([label, v]) => ({
    label,
    count: v.count,
    avg5dPct: v.count5d > 0 ? v.sum5d / v.count5d : null,
    avg10dPct: v.count10d > 0 ? v.sum10d / v.count10d : null,
  }));

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
      postExitReturn5dPct: true,
      postExitReturn10dPct: true,
      postExitMaxHighPct: true,
      postExitMinLowPct: true,
    },
  });

  type ExitAgg = {
    label: string; defensive: boolean;
    count: number;
    sum5d: number; n5d: number;
    sum10d: number; n10d: number;
    sumHigh: number; nHigh: number;
    sumLow: number; nLow: number;
  };
  const exitMap = new Map<string, ExitAgg>();
  for (const p of closedPositions) {
    const reason = (p.exitSnapshot as { exitReason?: string } | null)?.exitReason ?? "";
    const cls = classifyExitReason(reason);
    const e = exitMap.get(cls.code) ?? { label: cls.label, defensive: cls.defensive, count: 0, sum5d: 0, n5d: 0, sum10d: 0, n10d: 0, sumHigh: 0, nHigh: 0, sumLow: 0, nLow: 0 };
    e.count++;
    if (p.postExitReturn5dPct !== null) { e.sum5d += p.postExitReturn5dPct; e.n5d++; }
    if (p.postExitReturn10dPct !== null) { e.sum10d += p.postExitReturn10dPct; e.n10d++; }
    if (p.postExitMaxHighPct !== null) { e.sumHigh += p.postExitMaxHighPct; e.nHigh++; }
    if (p.postExitMinLowPct !== null) { e.sumLow += p.postExitMinLowPct; e.nLow++; }
    exitMap.set(cls.code, e);
  }

  const exitSummary = Array.from(exitMap.values())
    .map((v) => ({
      label: v.label,
      defensive: v.defensive,
      count: v.count,
      avg5dPct: v.n5d > 0 ? v.sum5d / v.n5d : null,
      avg10dPct: v.n10d > 0 ? v.sum10d / v.n10d : null,
      avgHighPct: v.nHigh > 0 ? v.sumHigh / v.nHigh : null,
      avgLowPct: v.nLow > 0 ? v.sumLow / v.nLow : null,
    }))
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
        決済価格を起点にした平均リターン。<strong>損切り・BE撤退</strong>で<strong style="color:#22c55e">プラス</strong>なら「早く切りすぎ」の兆候、<strong style="color:#ef4444">マイナス</strong>なら決済判断が正しい（続落を回避）。BT却下#38では全決済理由で決済後は続落＝現行の早期手仕舞いが正解と確定済み。
      </p>
      ${!exitSummary.length ? html`
        <div style="background:${COLORS.card};border:1px solid ${COLORS.border};border-radius:8px;padding:24px;text-align:center;color:${COLORS.textMuted};margin-bottom:24px">
          決済後フォワードのデータなし（決済から10営業日未経過 or クローズ実績なし）
        </div>
      ` : html`
        <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:12px;margin-bottom:24px">
          ${exitSummary.map((s) => html`
            <div style="background:${COLORS.card};border:1px solid ${s.defensive ? "#f59e0b55" : COLORS.border};border-radius:8px;padding:12px">
              <div style="font-size:0.75rem;color:${COLORS.textMuted};margin-bottom:4px">
                ${s.label}${s.defensive ? html`<span style="color:#f59e0b"> ●守り</span>` : ""}
              </div>
              <div style="font-size:1.1rem;font-weight:700;color:${COLORS.text};margin-bottom:6px">${s.count}件</div>
              <div style="font-size:0.8rem;color:${returnColor(s.avg5dPct)}">決済後5日: ${formatReturnPct(s.avg5dPct)}</div>
              <div style="font-size:0.8rem;color:${returnColor(s.avg10dPct)}">決済後10日: ${formatReturnPct(s.avg10dPct)}</div>
              <div style="font-size:0.7rem;color:${COLORS.textMuted};margin-top:4px">
                H(最大戻り) ${formatReturnPct(s.avgHighPct)} / L(最大続落) ${formatReturnPct(s.avgLowPct)}
              </div>
            </div>
          `)}
        </div>
      `}

      <!-- 個別一覧テーブル -->
      <h2 style="font-size:1.05rem;font-weight:700;margin-bottom:12px;color:${COLORS.text}">弾かれたシグナル一覧</h2>
      <div style="background:${COLORS.card};border:1px solid ${COLORS.border};border-radius:8px;overflow:hidden">
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
    </div>
  `;

  return c.html(layout("弾かれたシグナル", "/rejected-signals", body));
});

export default app;
