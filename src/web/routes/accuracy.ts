/**
 * 精度分析ページ（GET /accuracy）
 *
 * 1. 判断整合性サマリー: Precision/Recall/F1 + 市場停止・AI却下・閾値未達
 * 2. 4象限詳細: 混同行列 + ランク別精度
 * 3. FN分析: 棄却したが上昇した銘柄
 * 4. FP分析: 承認したが下落した銘柄
 * 5. 傾向分析: 勝ち vs 負け比較 / ランク別勝率 / セクター分布
 */

import { Hono } from "hono";
import { html } from "hono/html";
import dayjs from "dayjs";
import { prisma } from "../../lib/prisma";
import { Prisma } from "@prisma/client";
import { getTodayForDB, getDaysAgoForDB } from "../../lib/date-utils";
import { CONTRARIAN, SCORING, getSectorGroup } from "../../lib/constants";
import { layout } from "../views/layout";
import {
  formatYen,
  pnlPercent,
  tickerLink,
  emptyState,
  rankBadge,
  tt,
} from "../views/components";

const app = new Hono();

function rejectionBadge(reason: string | null) {
  if (!reason) return html`<span style="color:#64748b">-</span>`;
  const map: Record<string, { label: string; bg: string; color: string }> = {
    ai_no_go: { label: "AI却下", bg: "#ef444420", color: "#ef4444" },
    below_threshold: { label: "スコア不足", bg: "#f59e0b20", color: "#f59e0b" },
    market_halted: { label: "市場停止", bg: "#fb923c20", color: "#fb923c" },
    disqualified: { label: "即死", bg: "#a855f720", color: "#a855f7" },
  };
  const info = map[reason] ?? { label: reason, bg: "#64748b20", color: "#64748b" };
  return html`<span class="badge" style="background:${info.bg};color:${info.color}">${info.label}</span>`;
}

function parseGhostAnalysis(raw: string | null): { analysis: string; recommendation: string; misjudgmentType: string | null } | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (parsed.analysis) return { analysis: parsed.analysis, recommendation: parsed.recommendation ?? "", misjudgmentType: parsed.misjudgmentType ?? null };
  } catch {}
  return null;
}

app.get("/", async (c) => {
  const since90 = getDaysAgoForDB(CONTRARIAN.LOOKBACK_DAYS);

  // 最新の decisionAudit 日付を取得
  // 注: 現行は MarketAssessment から latestDate を取得しているが、
  // 精度分析ページでは decisionAudit の存在する最新日を基準にする（意図的な変更）
  const latestSummary = await prisma.tradingDailySummary.findFirst({
    where: { decisionAudit: { not: Prisma.DbNull } },
    orderBy: { date: "desc" },
    select: { date: true, decisionAudit: true },
  });
  const latestDate = latestSummary?.date ?? getTodayForDB();
  const latestDateLabel = dayjs(latestDate).format("M月D日");

  // decisionAudit を型付きで取得
  type DecisionAuditData = {
    scoringSummary: {
      totalScored: number;
      aiApproved: number;
      rankBreakdown: Record<string, number>;
    };
    marketHalt: {
      wasHalted: boolean;
      sentiment: string;
      nikkeiChange: number | null;
      totalScored: number;
      risingCount: number;
      risingRate: number | null;
    } | null;
    aiRejection: {
      total: number;
      correctlyRejected: number;
      falselyRejected: number;
      accuracy: number | null;
    };
    scoreThreshold: {
      total: number;
      rising: number;
      avgRisingPct: number | null;
    };
    confusionMatrix: {
      tp: number;
      fp: number;
      fn: number;
      tn: number;
      precision: number | null;
      recall: number | null;
      f1: number | null;
    };
    byRank: Record<string, {
      tp: number;
      fp: number;
      fn: number;
      tn: number;
      precision: number | null;
    }>;
    fpAnalysis: Array<{
      tickerCode: string;
      score: number;
      rank: string;
      profitPct: number;
      misjudgmentType: string;
    }>;
    overallVerdict: string;
  };
  const audit = latestSummary?.decisionAudit
    ? (latestSummary.decisionAudit as unknown as DecisionAuditData)
    : null;

  const [
    missedStocks,
    fpStocks,
    highScoreTrendRecords,
  ] = await Promise.all([
    // FN: 全棄却理由で上昇した銘柄（直近30件）
    prisma.scoringRecord.findMany({
      where: {
        rejectionReason: { not: null },
        ghostProfitPct: { gt: 0 },
        closingPrice: { not: null },
        entryPrice: { not: null },
      },
      orderBy: { date: "desc" },
      take: 30,
    }),
    // FP: 承認したが下落した銘柄（直近30件）
    // 注: rejectionReason IS NULL で承認済みを判定（aiDecision は使わない — spec準拠）
    prisma.scoringRecord.findMany({
      where: {
        rejectionReason: null,
        ghostProfitPct: { lt: 0 },
        closingPrice: { not: null },
      },
      orderBy: { date: "desc" },
      take: 30,
    }),
    // 傾向分析: Bランク以上で購入しなかった全銘柄
    // 注: 現行は nextDayProfitPct を select に含めていたが、翌日継続率を削除するため除外
    prisma.scoringRecord.findMany({
      where: {
        rejectionReason: { not: null },
        totalScore: { gte: SCORING.THRESHOLDS.B_RANK },
        closingPrice: { not: null },
        date: { gte: since90 },
      },
      select: {
        tickerCode: true,
        date: true,
        ghostProfitPct: true,
        totalScore: true,
        trendQualityScore: true,
        entryTimingScore: true,
        riskQualityScore: true,
        rank: true,
        closingPrice: true,
        rejectionReason: true,
      },
    }),
  ]);

  // 傾向分析用: Stock テーブルからセクター情報を一括取得（N+1 回避）
  const trendTickers = [...new Set(highScoreTrendRecords.map((r) => r.tickerCode))];
  const stocksForTrend = await prisma.stock.findMany({
    where: { tickerCode: { in: trendTickers } },
    select: { tickerCode: true, jpxSectorName: true, sector: true },
  });
  const sectorMap = new Map(stocksForTrend.map((s) => [s.tickerCode, s.jpxSectorName ?? s.sector]));

  // --- 傾向分析 ---
  // スコア80点以上・購入しなかった全銘柄（closingPrice は既にフィルタ済み）
  const analyzedRecords = highScoreTrendRecords;
  const winners = analyzedRecords.filter(
    (r) => r.ghostProfitPct != null && Number(r.ghostProfitPct) > 0,
  );
  const losers = analyzedRecords.filter(
    (r) => r.ghostProfitPct != null && Number(r.ghostProfitPct) <= 0,
  );

  const avgOf = (
    records: typeof analyzedRecords,
    key: "totalScore" | "trendQualityScore" | "entryTimingScore" | "riskQualityScore",
  ) =>
    records.length > 0
      ? Math.round(
          records.reduce((s, r) => s + r[key], 0) / records.length,
        )
      : null;

  const avgPct = (records: typeof analyzedRecords) =>
    records.length > 0
      ? records.reduce((s, r) => s + Number(r.ghostProfitPct), 0) /
        records.length
      : null;

  const trendSummary = {
    analyzed: analyzedRecords.length,
    winners: winners.length,
    losers: losers.length,
    winnerAvgScore: avgOf(winners, "totalScore"),
    loserAvgScore: avgOf(losers, "totalScore"),
    winnerAvgTrend: avgOf(winners, "trendQualityScore"),
    loserAvgTrend: avgOf(losers, "trendQualityScore"),
    winnerAvgEntry: avgOf(winners, "entryTimingScore"),
    loserAvgEntry: avgOf(losers, "entryTimingScore"),
    winnerAvgRisk: avgOf(winners, "riskQualityScore"),
    loserAvgRisk: avgOf(losers, "riskQualityScore"),
    winnerAvgPct: avgPct(winners),
    loserAvgPct: avgPct(losers),
  };

  // セクター分布集計
  interface SectorBucket {
    wins: number;
    losses: number;
    profitSum: number;
  }
  const sectorBuckets = new Map<string, SectorBucket>();
  for (const r of analyzedRecords) {
    const jpxSector = sectorMap.get(r.tickerCode);
    const sector = getSectorGroup(jpxSector ?? null) ?? "その他";
    let b = sectorBuckets.get(sector);
    if (!b) {
      b = { wins: 0, losses: 0, profitSum: 0 };
      sectorBuckets.set(sector, b);
    }
    if (r.ghostProfitPct != null && Number(r.ghostProfitPct) > 0) {
      b.wins++;
      b.profitSum += Number(r.ghostProfitPct);
    } else {
      b.losses++;
    }
  }
  const sectorStats = [...sectorBuckets.entries()]
    .map(([sector, b]) => ({
      sector,
      total: b.wins + b.losses,
      wins: b.wins,
      winRate: b.wins + b.losses > 0
        ? Math.round((b.wins / (b.wins + b.losses)) * 100)
        : 0,
      avgProfitPct: b.wins > 0 ? b.profitSum / b.wins : null,
    }))
    .sort((a, b) => b.total - a.total)
    .slice(0, 10);

  // ランク分布集計
  const rankDist = { S: { wins: 0, total: 0 }, A: { wins: 0, total: 0 }, B: { wins: 0, total: 0 } } as Record<string, { wins: number; total: number }>;
  for (const r of analyzedRecords) {
    const rank = r.rank as string;
    if (!rankDist[rank]) rankDist[rank] = { wins: 0, total: 0 };
    rankDist[rank].total++;
    if (r.ghostProfitPct != null && Number(r.ghostProfitPct) > 0) {
      rankDist[rank].wins++;
    }
  }

  const content = html`
    <!-- セクション1: 判断整合性サマリー -->
    <p class="section-title">${latestDateLabel}の判断整合性</p>
    ${audit == null
      ? html`<div class="card">
          ${emptyState("scoring-accuracy 実行後に更新されます（16:10 JST 以降）")}
        </div>`
      : html`
          <div class="card">
            <!-- Precision / Recall / F1 概要 -->
            <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:1rem;margin-bottom:1rem;padding-bottom:1rem;border-bottom:1px solid #1e293b">
              <div style="text-align:center">
                <p style="font-size:0.75rem;color:#94a3b8;margin:0 0 0.25rem">${tt("Precision", "承認銘柄のうち実際に上昇した割合")}</p>
                <p style="font-size:1.2rem;font-weight:700;margin:0;color:${audit.confusionMatrix.precision != null && audit.confusionMatrix.precision >= 60 ? "#22c55e" : audit.confusionMatrix.precision != null ? "#ef4444" : "#64748b"}">
                  ${audit.confusionMatrix.precision != null ? `${audit.confusionMatrix.precision.toFixed(1)}%` : "-"}
                </p>
              </div>
              <div style="text-align:center">
                <p style="font-size:0.75rem;color:#94a3b8;margin:0 0 0.25rem">${tt("Recall", "上昇銘柄のうち承認できた割合")}</p>
                <p style="font-size:1.2rem;font-weight:700;margin:0;color:${audit.confusionMatrix.recall != null && audit.confusionMatrix.recall >= 50 ? "#22c55e" : audit.confusionMatrix.recall != null ? "#ef4444" : "#64748b"}">
                  ${audit.confusionMatrix.recall != null ? `${audit.confusionMatrix.recall.toFixed(1)}%` : "-"}
                </p>
              </div>
              <div style="text-align:center">
                <p style="font-size:0.75rem;color:#94a3b8;margin:0 0 0.25rem">${tt("F1", "PrecisionとRecallの調和平均")}</p>
                <p style="font-size:1.2rem;font-weight:700;margin:0;color:${audit.confusionMatrix.f1 != null && audit.confusionMatrix.f1 >= 50 ? "#22c55e" : audit.confusionMatrix.f1 != null ? "#ef4444" : "#64748b"}">
                  ${audit.confusionMatrix.f1 != null ? `${audit.confusionMatrix.f1.toFixed(1)}%` : "-"}
                </p>
              </div>
            </div>

            <!-- 既存の判断整合性 3カラム -->
            <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:1rem;margin-bottom:1rem">
              <!-- 市場停止判断 -->
              <div>
                <p style="font-size:0.75rem;color:#94a3b8;margin:0 0 0.25rem">市場停止判断</p>
                ${audit.marketHalt != null
                  ? html`
                      <p style="font-size:0.85rem;font-weight:600;margin:0 0 0.25rem">
                        ${audit.marketHalt.wasHalted
                          ? html`<span style="color:#f59e0b">停止</span>`
                          : html`<span style="color:#22c55e">取引実行</span>`}
                        <span style="font-weight:400;color:#94a3b8;font-size:0.75rem">
                          (${audit.marketHalt.sentiment})
                        </span>
                      </p>
                      <p style="font-size:0.82rem;margin:0;color:${audit.marketHalt.risingRate != null && audit.marketHalt.risingRate > 50 ? "#f59e0b" : "#64748b"}">
                        上昇率 ${audit.marketHalt.risingRate ?? "-"}%
                        <span style="font-size:0.72rem;color:#94a3b8">
                          (${audit.marketHalt.risingCount}/${audit.marketHalt.totalScored}件)
                        </span>
                      </p>
                    `
                  : html`<p style="font-size:0.82rem;color:#64748b;margin:0">市場評価データなし</p>`}
              </div>

              <!-- AI却下精度 -->
              <div>
                <p style="font-size:0.75rem;color:#94a3b8;margin:0 0 0.25rem">AI却下精度</p>
                <p style="font-size:1.1rem;font-weight:700;margin:0 0 0.25rem;color:${audit.aiRejection.accuracy != null && audit.aiRejection.accuracy >= 60 ? "#22c55e" : audit.aiRejection.accuracy != null ? "#ef4444" : "#64748b"}">
                  ${audit.aiRejection.accuracy != null ? `${audit.aiRejection.accuracy}%` : "-"}
                </p>
                <p style="font-size:0.75rem;color:#94a3b8;margin:0">
                  正確 ${audit.aiRejection.correctlyRejected}件 /
                  誤却下 ${audit.aiRejection.falselyRejected}件
                </p>
              </div>

              <!-- スコアリング閾値 -->
              <div>
                <p style="font-size:0.75rem;color:#94a3b8;margin:0 0 0.25rem">閾値未達で上昇</p>
                <p style="font-size:1.1rem;font-weight:700;margin:0 0 0.25rem;color:${audit.scoreThreshold.rising > 5 ? "#f59e0b" : "#64748b"}">
                  ${audit.scoreThreshold.rising}件
                </p>
                <p style="font-size:0.75rem;color:#94a3b8;margin:0">
                  ${audit.scoreThreshold.total}件中
                  ${audit.scoreThreshold.avgRisingPct != null
                    ? `/ 平均 +${audit.scoreThreshold.avgRisingPct.toFixed(2)}%`
                    : ""}
                </p>
              </div>
            </div>

            ${audit.overallVerdict
              ? html`<p style="font-size:0.82rem;color:#cbd5e1;background:#1e293b;padding:0.75rem;border-radius:6px;margin:0;line-height:1.6">
                  ${audit.overallVerdict}
                </p>`
              : ""}
          </div>

          <!-- セクション2: 4象限詳細 -->
          <p class="section-title">4象限分析</p>

          <!-- 2a. 混同行列 -->
          <div class="card" style="display:grid;grid-template-columns:1fr 1fr;gap:0.5rem">
            <div style="text-align:center;padding:1rem;background:#22c55e15;border-radius:8px">
              <p style="font-size:0.72rem;color:#94a3b8;margin:0 0 0.25rem">TP（正しく承認）</p>
              <p style="font-size:1.5rem;font-weight:700;color:#22c55e;margin:0">${audit.confusionMatrix.tp}</p>
            </div>
            <div style="text-align:center;padding:1rem;background:#ef444415;border-radius:8px">
              <p style="font-size:0.72rem;color:#94a3b8;margin:0 0 0.25rem">FP（誤って承認）</p>
              <p style="font-size:1.5rem;font-weight:700;color:#ef4444;margin:0">${audit.confusionMatrix.fp}</p>
            </div>
            <div style="text-align:center;padding:1rem;background:#f59e0b15;border-radius:8px">
              <p style="font-size:0.72rem;color:#94a3b8;margin:0 0 0.25rem">FN（見逃し）</p>
              <p style="font-size:1.5rem;font-weight:700;color:#f59e0b;margin:0">${audit.confusionMatrix.fn}</p>
            </div>
            <div style="text-align:center;padding:1rem;background:#64748b15;border-radius:8px">
              <p style="font-size:0.72rem;color:#94a3b8;margin:0 0 0.25rem">TN（正しく棄却）</p>
              <p style="font-size:1.5rem;font-weight:700;color:#64748b;margin:0">${audit.confusionMatrix.tn}</p>
            </div>
          </div>

          <!-- 2b. ランク別精度 -->
          <div class="card table-wrap">
            <p style="font-size:0.8rem;color:#94a3b8;margin:0 0 0.75rem">ランク別精度</p>
            <table>
              <thead>
                <tr>
                  <th>ランク</th>
                  <th>TP</th>
                  <th>FP</th>
                  <th>FN</th>
                  <th>TN</th>
                  <th>${tt("Precision", "承認銘柄の正解率")}</th>
                </tr>
              </thead>
              <tbody>
                ${Object.entries(audit.byRank)
                  .sort(([a], [b]) => a.localeCompare(b))
                  .map(
                    ([rank, v]) => html`
                      <tr>
                        <td>${rankBadge(rank)}</td>
                        <td style="color:#22c55e">${v.tp}</td>
                        <td style="color:#ef4444">${v.fp}</td>
                        <td style="color:#f59e0b">${v.fn}</td>
                        <td style="color:#64748b">${v.tn}</td>
                        <td style="font-weight:600;color:${v.precision != null && v.precision >= 60 ? "#22c55e" : v.precision != null ? "#ef4444" : "#64748b"}">
                          ${v.precision != null ? `${v.precision.toFixed(0)}%` : "-"}
                        </td>
                      </tr>
                    `,
                  )}
              </tbody>
            </table>
          </div>
        `}

    <!-- セクション3: FN分析（見逃し銘柄） -->
    <p class="section-title">見逃し銘柄（棄却したが上昇）</p>
    ${missedStocks.length > 0
      ? html`
          <div class="card table-wrap">
            <table>
              <thead>
                <tr>
                  <th>日付</th>
                  <th>銘柄</th>
                  <th>棄却理由</th>
                  <th>スコア</th>
                  <th>ランク</th>
                  <th>騰落率</th>
                </tr>
              </thead>
              <tbody>
                ${missedStocks.map((r) => {
                  const ghost = parseGhostAnalysis(r.ghostAnalysis);
                  return html`
                    <tr>
                      <td>${dayjs(r.date).format("M/D")}</td>
                      <td>${tickerLink(r.tickerCode)}</td>
                      <td>${rejectionBadge(r.rejectionReason)}</td>
                      <td>${r.totalScore}</td>
                      <td>${rankBadge(r.rank)}</td>
                      <td>
                        ${pnlPercent(Number(r.ghostProfitPct))}
                        ${ghost ? html`<span class="ghost-toggle" onclick="toggleGhost(this)" style="cursor:pointer;margin-left:4px">💡</span>` : ""}
                      </td>
                    </tr>
                    ${ghost ? html`
                      <tr class="ghost-detail" style="display:none">
                        <td colspan="6" style="background:#1e293b;padding:0.75rem;font-size:0.82rem;line-height:1.6">
                          <p style="margin:0 0 0.5rem;color:#cbd5e1">${ghost.analysis}</p>
                          ${ghost.recommendation ? html`<p style="margin:0;color:#94a3b8"><strong>改善提案:</strong> ${ghost.recommendation}</p>` : ""}
                        </td>
                      </tr>
                    ` : ""}
                  `;
                })}
              </tbody>
            </table>
          </div>
        `
      : html`<div class="card">
          ${emptyState("見逃し銘柄はまだありません")}
        </div>`}

    <!-- セクション4: FP分析（誤エントリー） -->
    <p class="section-title">誤エントリー（承認したが下落）</p>
    ${fpStocks.length > 0
      ? html`
          <div class="card table-wrap">
            <table>
              <thead>
                <tr>
                  <th>日付</th>
                  <th>銘柄</th>
                  <th>スコア</th>
                  <th>ランク</th>
                  <th>騰落率</th>
                  <th>${tt("誤判断タイプ", "AI分析による誤判断の分類")}</th>
                </tr>
              </thead>
              <tbody>
                ${fpStocks.map((r) => {
                  const ghost = parseGhostAnalysis(r.ghostAnalysis);
                  return html`
                    <tr>
                      <td>${dayjs(r.date).format("M/D")}</td>
                      <td>${tickerLink(r.tickerCode)}</td>
                      <td>${r.totalScore}</td>
                      <td>${rankBadge(r.rank)}</td>
                      <td>
                        ${pnlPercent(Number(r.ghostProfitPct))}
                        ${ghost ? html`<span class="ghost-toggle" onclick="toggleGhost(this)" style="cursor:pointer;margin-left:4px">💡</span>` : ""}
                      </td>
                      <td>
                        ${ghost?.misjudgmentType
                          ? html`<span class="badge" style="background:#ef444420;color:#ef4444">${ghost.misjudgmentType}</span>`
                          : html`<span style="color:#64748b">-</span>`}
                      </td>
                    </tr>
                    ${ghost ? html`
                      <tr class="ghost-detail" style="display:none">
                        <td colspan="6" style="background:#1e293b;padding:0.75rem;font-size:0.82rem;line-height:1.6">
                          <p style="margin:0 0 0.5rem;color:#cbd5e1">${ghost.analysis}</p>
                          ${ghost.recommendation ? html`<p style="margin:0;color:#94a3b8"><strong>改善提案:</strong> ${ghost.recommendation}</p>` : ""}
                        </td>
                      </tr>
                    ` : ""}
                  `;
                })}
              </tbody>
            </table>
          </div>
        `
      : html`<div class="card">
          ${emptyState("誤エントリーはまだありません")}
        </div>`}

    <!-- セクション5: 傾向分析 -->
    <p class="section-title">
      傾向分析（過去${CONTRARIAN.LOOKBACK_DAYS}日 / Bランク以上・未購入）
    </p>
    ${trendSummary.analyzed === 0
      ? html`<div class="card">
          ${emptyState(
            "分析データが蓄積されるまでお待ちください",
          )}
        </div>`
      : html`
          <!-- 勝ち vs 負け比較 -->
          <div
            class="card"
            style="display:grid;grid-template-columns:1fr 1fr;gap:1rem"
          >
            <div>
              <p
                style="font-weight:700;color:#22c55e;margin:0 0 0.5rem;font-size:0.95rem"
              >
                ▲ 勝ち ${trendSummary.winners}件
              </p>
              <table style="width:100%;font-size:0.85rem">
                <tbody>
                  <tr>
                    <td style="color:#94a3b8">平均損益</td>
                    <td style="font-weight:600;color:#22c55e">
                      ${trendSummary.winnerAvgPct != null
                        ? `+${trendSummary.winnerAvgPct.toFixed(2)}%`
                        : "-"}
                    </td>
                  </tr>
                  <tr>
                    <td style="color:#94a3b8">平均スコア</td>
                    <td style="font-weight:600">${trendSummary.winnerAvgScore ?? "-"}</td>
                  </tr>
                  <tr>
                    <td style="color:#94a3b8">トレンド</td>
                    <td>${trendSummary.winnerAvgTrend ?? "-"}</td>
                  </tr>
                  <tr>
                    <td style="color:#94a3b8">エントリー</td>
                    <td>${trendSummary.winnerAvgEntry ?? "-"}</td>
                  </tr>
                  <tr>
                    <td style="color:#94a3b8">リスク</td>
                    <td>${trendSummary.winnerAvgRisk ?? "-"}</td>
                  </tr>
                </tbody>
              </table>
            </div>
            <div>
              <p
                style="font-weight:700;color:#ef4444;margin:0 0 0.5rem;font-size:0.95rem"
              >
                ▼ 負け ${trendSummary.losers}件
              </p>
              <table style="width:100%;font-size:0.85rem">
                <tbody>
                  <tr>
                    <td style="color:#94a3b8">平均損益</td>
                    <td style="font-weight:600;color:#ef4444">
                      ${trendSummary.loserAvgPct != null
                        ? `${trendSummary.loserAvgPct.toFixed(2)}%`
                        : "-"}
                    </td>
                  </tr>
                  <tr>
                    <td style="color:#94a3b8">平均スコア</td>
                    <td style="font-weight:600">${trendSummary.loserAvgScore ?? "-"}</td>
                  </tr>
                  <tr>
                    <td style="color:#94a3b8">トレンド</td>
                    <td>${trendSummary.loserAvgTrend ?? "-"}</td>
                  </tr>
                  <tr>
                    <td style="color:#94a3b8">エントリー</td>
                    <td>${trendSummary.loserAvgEntry ?? "-"}</td>
                  </tr>
                  <tr>
                    <td style="color:#94a3b8">リスク</td>
                    <td>${trendSummary.loserAvgRisk ?? "-"}</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>

          <!-- スコア内訳差分 -->
          <div class="card table-wrap">
            <p style="font-size:0.8rem;color:#94a3b8;margin:0 0 0.75rem">スコア内訳比較（勝ち vs 負け）</p>
            <table>
              <thead>
                <tr>
                  <th>種別</th>
                  <th>勝ち平均</th>
                  <th>負け平均</th>
                  <th>差分</th>
                </tr>
              </thead>
              <tbody>
                ${[
                  {
                    label: "総合",
                    w: trendSummary.winnerAvgScore,
                    l: trendSummary.loserAvgScore,
                  },
                  {
                    label: "トレンド",
                    w: trendSummary.winnerAvgTrend,
                    l: trendSummary.loserAvgTrend,
                  },
                  {
                    label: "エントリー",
                    w: trendSummary.winnerAvgEntry,
                    l: trendSummary.loserAvgEntry,
                  },
                  {
                    label: "リスク",
                    w: trendSummary.winnerAvgRisk,
                    l: trendSummary.loserAvgRisk,
                  },
                ].map((row) => {
                  const diff =
                    row.w != null && row.l != null ? row.w - row.l : null;
                  return html`
                    <tr>
                      <td>${row.label}</td>
                      <td style="color:#22c55e">${row.w ?? "-"}</td>
                      <td style="color:#ef4444">${row.l ?? "-"}</td>
                      <td
                        style="font-weight:600;color:${diff != null && diff > 0 ? "#22c55e" : diff != null && diff < 0 ? "#ef4444" : "#94a3b8"}"
                      >
                        ${diff != null
                          ? diff > 0
                            ? `+${diff}`
                            : `${diff}`
                          : "-"}
                      </td>
                    </tr>
                  `;
                })}
              </tbody>
            </table>
          </div>

          <!-- セクター分布 -->
          ${sectorStats.length > 0
            ? html`
                <div class="card table-wrap">
                  <p style="font-size:0.8rem;color:#94a3b8;margin:0 0 0.75rem">セクター別成績（n≥10 のみ信頼度あり）</p>
                  <table>
                    <thead>
                      <tr>
                        <th>セクター</th>
                        <th>出現</th>
                        <th>勝ち</th>
                        <th>勝率</th>
                        <th>勝ち平均利益率</th>
                      </tr>
                    </thead>
                    <tbody>
                      ${sectorStats.map((s) => {
                        const lowSample = s.total < 10;
                        const rowStyle = lowSample ? "color:#64748b" : "";
                        return html`
                          <tr style="${rowStyle}">
                            <td style="font-weight:600">
                              ${s.sector}${lowSample
                                ? html`<span style="margin-left:4px;font-size:0.7rem;color:#94a3b8">(n=${s.total})</span>`
                                : ""}
                            </td>
                            <td>${s.total}回</td>
                            <td>${s.wins}回</td>
                            <td
                              style="font-weight:600;color:${lowSample ? "#64748b" : s.winRate >= 50 ? "#22c55e" : "#ef4444"}"
                            >
                              ${s.winRate}%${lowSample ? html`<span style="font-size:0.7rem"> ※</span>` : ""}
                            </td>
                            <td>
                              ${s.avgProfitPct != null
                                ? pnlPercent(s.avgProfitPct)
                                : html`<span style="color:#64748b">-</span>`}
                            </td>
                          </tr>
                        `;
                      })}
                    </tbody>
                  </table>
                  <p style="font-size:0.72rem;color:#94a3b8;margin:0.5rem 0 0">※ n<10 はサンプル不足のため参考値</p>
                </div>
              `
            : ""}

          <!-- ランク分布 -->
          <div class="card table-wrap">
            <p style="font-size:0.8rem;color:#94a3b8;margin:0 0 0.75rem">ランク別勝率</p>
            <table>
              <thead>
                <tr>
                  <th>ランク</th>
                  <th>出現</th>
                  <th>勝ち</th>
                  <th>勝率</th>
                </tr>
              </thead>
              <tbody>
                ${Object.entries(rankDist)
                  .filter(([, v]) => v.total > 0)
                  .sort(([a], [b]) => a.localeCompare(b))
                  .map(([rank, v]) => {
                    const wr =
                      v.total > 0
                        ? Math.round((v.wins / v.total) * 100)
                        : 0;
                    return html`
                      <tr>
                        <td>${rankBadge(rank)}</td>
                        <td>${v.total}回</td>
                        <td>${v.wins}回</td>
                        <td
                          style="font-weight:600;color:${wr >= 50 ? "#22c55e" : "#ef4444"}"
                        >
                          ${wr}%
                        </td>
                      </tr>
                    `;
                  })}
              </tbody>
            </table>
          </div>

        `}

    <script>
    function toggleGhost(el) {
      var row = el.closest('tr');
      var detail = row.nextElementSibling;
      if (detail && detail.classList.contains('ghost-detail')) {
        detail.style.display = detail.style.display === 'none' ? '' : 'none';
      }
    }
    </script>
  `;

  return c.html(layout("精度分析", "/accuracy", content));
});

export default app;
