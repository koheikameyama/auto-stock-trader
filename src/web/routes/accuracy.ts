/**
 * スコアリング精度ページ（GET /accuracy）
 *
 * 1. ランク別パフォーマンス: S/A/B/C の勝率・期待値・序列チェック
 * 2. スコア帯別パフォーマンス: 5段階のスコア帯ごとの成績
 * 3. カテゴリ別予測力: トレンド/エントリー/リスク/セクターの予測力比較
 * 4. スコアと損益の相関: ピアソン相関係数（全体 + カテゴリ別）
 * 5. AI判断精度（縮小版）: Precision/Recall/F1 + FP/FN一覧
 */

import { Hono } from "hono";
import { html } from "hono/html";
import dayjs from "dayjs";
import { prisma } from "../../lib/prisma";
import { Prisma } from "@prisma/client";
import { getDaysAgoForDB } from "../../lib/date-utils";
import { SCORING, SCORING_VALIDITY, SECTOR_MOMENTUM_SCORING } from "../../lib/constants";
import { layout } from "../views/layout";
import {
  pnlPercent,
  tickerLink,
  emptyState,
  rankBadge,
  tt,
} from "../views/components";

const app = new Hono();

// --- ヘルパー関数 ---

function rejectionBadge(reason: string | null) {
  if (!reason) return html`<span style="color:#64748b">-</span>`;
  const map: Record<string, { label: string; bg: string; color: string }> = {
    ai_no_go: { label: "AI却下", bg: "#ef444420", color: "#ef4444" },
    below_threshold: { label: "スコア不足", bg: "#f59e0b20", color: "#f59e0b" },
    market_halted: { label: "取引見送り", bg: "#fb923c20", color: "#fb923c" },
    disqualified: { label: "即死", bg: "#a855f720", color: "#a855f7" },
  };
  const info = map[reason] ?? { label: reason, bg: "#64748b20", color: "#64748b" };
  return html`<span class="badge" style="background:${info.bg};color:${info.color}">${info.label}</span>`;
}

const recommendationLabels: Record<string, string> = {
  adjust_ai_criteria: "AI判断基準を調整",
  lower_threshold: "閾値を引き下げ",
  tighten_threshold: "閾値を引き上げ",
  add_pattern_rule: "パターンルール追加",
  add_risk_filter: "リスクフィルター追加",
  no_change_needed: "変更不要",
};

function parseGhostAnalysis(raw: string | null): { analysis: string; recommendation: string; misjudgmentType: string | null } | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (parsed.analysis) return { analysis: parsed.analysis, recommendation: parsed.recommendation ?? "", misjudgmentType: parsed.misjudgmentType ?? null };
  } catch {}
  return null;
}

function pearsonCorrelation(xs: number[], ys: number[]): number | null {
  const n = xs.length;
  if (n < 3) return null;
  const meanX = xs.reduce((a, b) => a + b, 0) / n;
  const meanY = ys.reduce((a, b) => a + b, 0) / n;
  let num = 0, denX = 0, denY = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i] - meanX;
    const dy = ys[i] - meanY;
    num += dx * dy;
    denX += dx * dx;
    denY += dy * dy;
  }
  const den = Math.sqrt(denX * denY);
  return den === 0 ? null : num / den;
}

function correlationLabel(r: number | null): { text: string; color: string } {
  if (r == null) return { text: "N/A", color: "#64748b" };
  if (r >= 0.3) return { text: "中程度の正の相関", color: "#22c55e" };
  if (r >= 0.1) return { text: "弱い正の相関", color: "#f59e0b" };
  if (r > -0.1) return { text: "相関なし", color: "#64748b" };
  return { text: "負の相関", color: "#ef4444" };
}

function fmtR(r: number | null): string {
  return r != null ? r.toFixed(3) : "N/A";
}

app.get("/", async (c) => {
  const since = getDaysAgoForDB(SCORING_VALIDITY.LOOKBACK_DAYS);

  // --- データ取得（並列） ---
  const [
    allScoredRecords,
    latestSummary,
    fpStocks,
    fnStocks,
  ] = await Promise.all([
    // セクション1-4用: 90日分の全ScoringRecord（結果確定済み）
    prisma.scoringRecord.findMany({
      where: {
        closingPrice: { not: null },
        ghostProfitPct: { not: null },
        date: { gte: since },
      },
      select: {
        tickerCode: true,
        date: true,
        totalScore: true,
        rank: true,
        trendQualityScore: true,
        entryTimingScore: true,
        riskQualityScore: true,
        sectorMomentumScore: true,
        ghostProfitPct: true,
        ghost5DayProfitPct: true,
        ghost10DayProfitPct: true,
      },
    }),
    // セクション5用: 最新 decisionAudit
    prisma.tradingDailySummary.findFirst({
      where: { decisionAudit: { not: Prisma.DbNull } },
      orderBy: { date: "desc" },
      select: { date: true, decisionAudit: true },
    }),
    // FP一覧（承認+下落）
    prisma.scoringRecord.findMany({
      where: {
        rejectionReason: null,
        ghostProfitPct: { lt: 0 },
        closingPrice: { not: null },
      },
      orderBy: { date: "desc" },
      take: SCORING_VALIDITY.FP_FN_DISPLAY_LIMIT,
    }),
    // FN一覧（Aランク以上+棄却+上昇）
    prisma.scoringRecord.findMany({
      where: {
        totalScore: { gte: SCORING.THRESHOLDS.A_RANK },
        rejectionReason: { not: null },
        ghostProfitPct: { gt: 0 },
        closingPrice: { not: null },
      },
      orderBy: { date: "desc" },
      take: SCORING_VALIDITY.FP_FN_DISPLAY_LIMIT,
    }),
  ]);

  // --- セクション1: ランク別パフォーマンス ---
  interface RankPerf {
    rank: string;
    count: number;
    wins: number;
    winRate: number | null;
    avgPnl: number | null;
    expectancy: number | null;
  }

  const rankBuckets: Record<string, { count: number; wins: number; pnlSum: number }> = {
    S: { count: 0, wins: 0, pnlSum: 0 },
    A: { count: 0, wins: 0, pnlSum: 0 },
    B: { count: 0, wins: 0, pnlSum: 0 },
  };

  for (const r of allScoredRecords) {
    const rank = r.rank as string;
    if (!rankBuckets[rank]) rankBuckets[rank] = { count: 0, wins: 0, pnlSum: 0 };
    const pnl = Number(r.ghostProfitPct);
    rankBuckets[rank].count++;
    rankBuckets[rank].pnlSum += pnl;
    if (pnl > 0) rankBuckets[rank].wins++;
  }

  const rankPerfs: RankPerf[] = ["S", "A", "B"].map((rank) => {
    const b = rankBuckets[rank];
    return {
      rank,
      count: b.count,
      wins: b.wins,
      winRate: b.count > 0 ? (b.wins / b.count) * 100 : null,
      avgPnl: b.count > 0 ? b.pnlSum / b.count : null,
      expectancy: b.count > 0 ? b.pnlSum / b.count : null,
    };
  });

  // 序列チェック: 期待値が S > A > B か
  const inversions: string[] = [];
  const rankOrder = ["S", "A", "B"];
  for (let i = 0; i < rankOrder.length - 1; i++) {
    const higher = rankPerfs[i];
    const lower = rankPerfs[i + 1];
    if (
      higher.expectancy != null && lower.expectancy != null &&
      higher.count >= 5 && lower.count >= 5 &&
      higher.expectancy < lower.expectancy
    ) {
      inversions.push(`${lower.rank} > ${higher.rank}`);
    }
  }

  // --- セクション2: スコア帯別パフォーマンス ---
  interface PeriodPerf {
    count: number;
    wins: number;
    winRate: number | null;
    expectancy: number | null;
  }

  interface ScoreBandPerf {
    label: string;
    day1: PeriodPerf;
    day5: PeriodPerf;
    day10: PeriodPerf;
  }

  function calcPeriodPerf(
    records: typeof allScoredRecords,
    field: "ghostProfitPct" | "ghost5DayProfitPct" | "ghost10DayProfitPct",
  ): PeriodPerf {
    const valid = records.filter((r) => r[field] != null);
    const wins = valid.filter((r) => Number(r[field]) > 0).length;
    const pnlSum = valid.reduce((s, r) => s + Number(r[field]), 0);
    return {
      count: valid.length,
      wins,
      winRate: valid.length > 0 ? (wins / valid.length) * 100 : null,
      expectancy: valid.length > 0 ? pnlSum / valid.length : null,
    };
  }

  const scoreBandPerfs: ScoreBandPerf[] = SCORING_VALIDITY.SCORE_BANDS.map((band) => {
    const records = allScoredRecords.filter(
      (r) => r.totalScore >= band.min && r.totalScore <= band.max,
    );
    return {
      label: band.label,
      day1: calcPeriodPerf(records, "ghostProfitPct"),
      day5: calcPeriodPerf(records, "ghost5DayProfitPct"),
      day10: calcPeriodPerf(records, "ghost10DayProfitPct"),
    };
  });

  // --- セクション3: カテゴリ別予測力 ---
  const winners = allScoredRecords.filter((r) => Number(r.ghostProfitPct) > 0);
  const losers = allScoredRecords.filter((r) => Number(r.ghostProfitPct) <= 0);

  const avgScore = (
    records: typeof allScoredRecords,
    key: "totalScore" | "trendQualityScore" | "entryTimingScore" | "riskQualityScore" | "sectorMomentumScore",
  ) =>
    records.length > 0
      ? records.reduce((s, r) => s + r[key], 0) / records.length
      : null;

  interface CategoryPrediction {
    category: string;
    maxScore: number;
    winnerAvg: number | null;
    loserAvg: number | null;
    differential: number | null;
    normalizedDiff: number | null;
  }

  const categoryPredictions: CategoryPrediction[] = [
    { category: "トレンド品質", maxScore: SCORING.CATEGORY_MAX.TREND_QUALITY, key: "trendQualityScore" as const },
    { category: "エントリータイミング", maxScore: SCORING.CATEGORY_MAX.ENTRY_TIMING, key: "entryTimingScore" as const },
    { category: "リスク品質", maxScore: SCORING.CATEGORY_MAX.RISK_QUALITY, key: "riskQualityScore" as const },
    { category: "セクターボーナス", maxScore: SECTOR_MOMENTUM_SCORING.BONUS_MAX, key: "sectorMomentumScore" as const },
  ].map(({ category, maxScore, key }) => {
    const wAvg = avgScore(winners, key);
    const lAvg = avgScore(losers, key);
    const diff = wAvg != null && lAvg != null ? wAvg - lAvg : null;
    return {
      category,
      maxScore,
      winnerAvg: wAvg,
      loserAvg: lAvg,
      differential: diff,
      normalizedDiff: diff != null ? (diff / maxScore) * 100 : null,
    };
  }).sort((a, b) => (b.normalizedDiff ?? -Infinity) - (a.normalizedDiff ?? -Infinity));

  // --- セクション4: スコアと損益の相関 ---
  // 5日/10日データがあるレコードのみで相関を計算
  const records5 = allScoredRecords.filter((r) => r.ghost5DayProfitPct != null);
  const records10 = allScoredRecords.filter((r) => r.ghost10DayProfitPct != null);

  function buildCorrelations(
    recs: typeof allScoredRecords,
    pnlField: "ghostProfitPct" | "ghost5DayProfitPct" | "ghost10DayProfitPct",
  ) {
    const scores = recs.map((r) => r.totalScore);
    const pnl = recs.map((r) => Number(r[pnlField]));
    return [
      { category: "総合スコア", r: pearsonCorrelation(scores, pnl) },
      { category: "トレンド品質", r: pearsonCorrelation(recs.map((r) => r.trendQualityScore), pnl) },
      { category: "エントリータイミング", r: pearsonCorrelation(recs.map((r) => r.entryTimingScore), pnl) },
      { category: "リスク品質", r: pearsonCorrelation(recs.map((r) => r.riskQualityScore), pnl) },
      { category: "セクターモメンタム", r: pearsonCorrelation(recs.map((r) => r.sectorMomentumScore), pnl) },
    ];
  }

  const categoryCorrelations = buildCorrelations(allScoredRecords, "ghostProfitPct");
  const categoryCorrelations5 = buildCorrelations(records5, "ghost5DayProfitPct");
  const categoryCorrelations10 = buildCorrelations(records10, "ghost10DayProfitPct");

  // --- セクション5: AI判断精度（decisionAudit） ---
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

  const auditRaw = latestSummary?.decisionAudit
    ? (latestSummary.decisionAudit as unknown as DecisionAuditData)
    : null;
  const audit = auditRaw
    ? {
        ...auditRaw,
        confusionMatrix: auditRaw.confusionMatrix ?? { tp: 0, fp: 0, fn: 0, tn: 0, precision: null, recall: null, f1: null },
        byRank: auditRaw.byRank ?? {},
        fpAnalysis: auditRaw.fpAnalysis ?? [],
      }
    : null;
  const latestDateLabel = latestSummary
    ? dayjs(latestSummary.date).format("M月D日")
    : null;

  // --- HTML ---
  const content = html`
    <!-- セクション1: ランク別パフォーマンス -->
    <p class="section-title">${tt("ランク別パフォーマンス", "S/A/B/Cランクごとの過去90日の成績")}（過去${SCORING_VALIDITY.LOOKBACK_DAYS}日）</p>

    ${allScoredRecords.length === 0
      ? html`<div class="card">${emptyState("スコアリングデータが蓄積されるまでお待ちください")}</div>`
      : html`
          <div class="card" style="display:grid;grid-template-columns:repeat(4,1fr);gap:0.5rem">
            ${rankPerfs.map((rp) => {
              const lowSample = rp.count < 10;
              const dimStyle = lowSample ? "opacity:0.5" : "";
              return html`
                <div style="text-align:center;padding:0.75rem 0.25rem;${dimStyle}">
                  <p style="margin:0 0 0.5rem">${rankBadge(rp.rank)}</p>
                  <p style="font-size:0.72rem;color:#94a3b8;margin:0">${rp.count}件</p>
                  <p style="font-size:0.85rem;font-weight:700;margin:0.25rem 0;color:${rp.winRate != null && rp.winRate >= 50 ? "#22c55e" : rp.winRate != null ? "#ef4444" : "#64748b"}">
                    ${rp.winRate != null ? `${rp.winRate.toFixed(0)}%` : "-"}
                  </p>
                  <p style="font-size:0.72rem;color:#94a3b8;margin:0 0 0.25rem">${tt("期待値", "1トレードあたりの平均損益率(%)")}</p>
                  <p style="font-size:0.95rem;font-weight:700;margin:0;color:${rp.expectancy != null ? (rp.expectancy >= 0.5 ? "#22c55e" : rp.expectancy >= 0 ? "#3b82f6" : "#ef4444") : "#64748b"}">
                    ${rp.expectancy != null ? `${rp.expectancy > 0 ? "+" : ""}${rp.expectancy.toFixed(2)}%` : "-"}
                  </p>
                  ${lowSample ? html`<p style="font-size:0.65rem;color:#94a3b8;margin:0.25rem 0 0">n<10</p>` : ""}
                </div>
              `;
            })}
          </div>

          ${inversions.length > 0
            ? html`<div class="card" style="background:#f59e0b10;border:1px solid #f59e0b30;padding:0.75rem">
                <p style="font-size:0.82rem;color:#f59e0b;margin:0;font-weight:600">
                  序列逆転を検出: ${inversions.join(", ")}
                </p>
                <p style="font-size:0.72rem;color:#94a3b8;margin:0.25rem 0 0">
                  上位ランクの期待値が下位を下回っています。スコアリングロジックの見直しを検討してください。
                </p>
              </div>`
            : html`<div class="card" style="background:#22c55e10;border:1px solid #22c55e30;padding:0.75rem">
                <p style="font-size:0.82rem;color:#22c55e;margin:0;font-weight:600">
                  序列正常: S > A > B > C
                </p>
              </div>`}

          <!-- セクション2: スコア帯別パフォーマンス -->
          <p class="section-title">${tt("スコア帯別パフォーマンス", "スコアの点数帯ごとの成績（1日/5日/10日リターン）")}</p>

          <div class="card table-wrap">
            <table>
              <thead>
                <tr>
                  <th rowspan="2">スコア帯</th>
                  <th colspan="3" style="text-align:center;border-bottom:1px solid #334155">1日</th>
                  <th colspan="3" style="text-align:center;border-bottom:1px solid #334155">5日</th>
                  <th colspan="3" style="text-align:center;border-bottom:1px solid #334155">10日</th>
                </tr>
                <tr>
                  <th>件数</th><th>勝率</th><th>${tt("期待値", "平均損益率(%)")}</th>
                  <th>件数</th><th>勝率</th><th>${tt("期待値", "平均損益率(%)")}</th>
                  <th>件数</th><th>勝率</th><th>${tt("期待値", "平均損益率(%)")}</th>
                </tr>
              </thead>
              <tbody>
                ${scoreBandPerfs.map((sb) => {
                  const fmtPerf = (p: PeriodPerf) => {
                    const low = p.count < 10;
                    const dim = low ? "color:#64748b" : "";
                    return {
                      count: html`<td style="${dim}">${p.count}${low ? html`<span style="font-size:0.65rem"> ※</span>` : ""}</td>`,
                      winRate: html`<td style="font-weight:600;${!low && p.winRate != null ? `color:${p.winRate >= 50 ? "#22c55e" : "#ef4444"}` : "color:#64748b"}">
                        ${p.winRate != null ? `${p.winRate.toFixed(0)}%` : "-"}
                      </td>`,
                      expectancy: html`<td style="font-weight:600;${!low && p.expectancy != null ? `color:${p.expectancy >= 0.5 ? "#22c55e" : p.expectancy >= 0 ? "#3b82f6" : "#ef4444"}` : "color:#64748b"}">
                        ${p.expectancy != null ? `${p.expectancy > 0 ? "+" : ""}${p.expectancy.toFixed(2)}%` : "-"}
                      </td>`,
                    };
                  };
                  const d1 = fmtPerf(sb.day1);
                  const d5 = fmtPerf(sb.day5);
                  const d10 = fmtPerf(sb.day10);
                  return html`
                    <tr>
                      <td style="font-weight:600">${sb.label}</td>
                      ${d1.count}${d1.winRate}${d1.expectancy}
                      ${d5.count}${d5.winRate}${d5.expectancy}
                      ${d10.count}${d10.winRate}${d10.expectancy}
                    </tr>
                  `;
                })}
              </tbody>
            </table>
            <p style="font-size:0.72rem;color:#94a3b8;margin:0.5rem 0 0">※ n<10 はサンプル不足のため参考値。5日/10日は蓄積中のためデータが少ない場合があります</p>
          </div>

          <!-- セクション3: カテゴリ別予測力 -->
          <p class="section-title">${tt("カテゴリ別予測力", "勝ち銘柄と負け銘柄のスコア差分から各カテゴリの予測力を測定")}</p>

          <div class="card table-wrap">
            <table>
              <thead>
                <tr>
                  <th>カテゴリ</th>
                  <th>最大</th>
                  <th style="color:#22c55e">勝ち平均</th>
                  <th style="color:#ef4444">負け平均</th>
                  <th>差分</th>
                  <th>${tt("予測力", "正規化差分（差分/最大点×100）。大きいほど予測に寄与")}</th>
                </tr>
              </thead>
              <tbody>
                ${categoryPredictions.map((cp) => {
                  return html`
                    <tr>
                      <td style="font-weight:600">${cp.category}</td>
                      <td style="color:#94a3b8">${cp.maxScore}</td>
                      <td style="color:#22c55e">${cp.winnerAvg != null ? cp.winnerAvg.toFixed(1) : "-"}</td>
                      <td style="color:#ef4444">${cp.loserAvg != null ? cp.loserAvg.toFixed(1) : "-"}</td>
                      <td style="font-weight:600;color:${cp.differential != null && cp.differential > 0 ? "#22c55e" : cp.differential != null && cp.differential < 0 ? "#ef4444" : "#94a3b8"}">
                        ${cp.differential != null ? `${cp.differential > 0 ? "+" : ""}${cp.differential.toFixed(1)}` : "-"}
                      </td>
                      <td style="font-weight:700;color:${cp.normalizedDiff != null && cp.normalizedDiff >= 5 ? "#22c55e" : cp.normalizedDiff != null && cp.normalizedDiff >= 2 ? "#3b82f6" : "#94a3b8"}">
                        ${cp.normalizedDiff != null ? `${cp.normalizedDiff.toFixed(1)}%` : "-"}
                      </td>
                    </tr>
                  `;
                })}
              </tbody>
            </table>
            <p style="font-size:0.72rem;color:#94a3b8;margin:0.5rem 0 0">
              勝ち: ${winners.length}件 / 負け: ${losers.length}件（過去${SCORING_VALIDITY.LOOKBACK_DAYS}日・全ランク）
            </p>
          </div>

          <!-- セクション4: スコアと損益の相関 -->
          <p class="section-title">${tt("スコアと損益の相関", "ピアソン相関係数によるスコア予測力の定量評価（1日/5日/10日）")}</p>

          <div class="card">
            <div class="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>カテゴリ</th>
                    <th colspan="2" style="text-align:center;border-bottom:1px solid #334155">1日 (n=${allScoredRecords.length})</th>
                    <th colspan="2" style="text-align:center;border-bottom:1px solid #334155">5日 (n=${records5.length})</th>
                    <th colspan="2" style="text-align:center;border-bottom:1px solid #334155">10日 (n=${records10.length})</th>
                  </tr>
                  <tr>
                    <th></th>
                    <th>r</th><th>解釈</th>
                    <th>r</th><th>解釈</th>
                    <th>r</th><th>解釈</th>
                  </tr>
                </thead>
                <tbody>
                  ${categoryCorrelations.map((cc, i) => {
                    const l1 = correlationLabel(cc.r);
                    const cc5 = categoryCorrelations5[i];
                    const l5 = correlationLabel(cc5?.r ?? null);
                    const cc10 = categoryCorrelations10[i];
                    const l10 = correlationLabel(cc10?.r ?? null);
                    return html`
                      <tr>
                        <td style="font-weight:600">${cc.category}</td>
                        <td style="font-weight:700;color:${l1.color}">${fmtR(cc.r)}</td>
                        <td style="color:${l1.color};font-size:0.75rem">${l1.text}</td>
                        <td style="font-weight:700;color:${l5.color}">${fmtR(cc5?.r ?? null)}</td>
                        <td style="color:${l5.color};font-size:0.75rem">${l5.text}</td>
                        <td style="font-weight:700;color:${l10.color}">${fmtR(cc10?.r ?? null)}</td>
                        <td style="color:${l10.color};font-size:0.75rem">${l10.text}</td>
                      </tr>
                    `;
                  })}
                </tbody>
              </table>
            </div>
            <p style="font-size:0.72rem;color:#94a3b8;margin:0.5rem 0 0">
              過去${SCORING_VALIDITY.LOOKBACK_DAYS}日・全ランク。5日/10日は蓄積中のため件数が少ない場合があります
            </p>
          </div>
        `}

    <!-- セクション5: AI判断精度（縮小版） -->
    <p class="section-title">AI判断精度${latestDateLabel ? `（${latestDateLabel}）` : ""}</p>

    ${audit == null
      ? html`<div class="card">${emptyState("scoring-accuracy 実行後に更新されます（16:10 JST 以降）")}</div>`
      : html`
          <div class="card">
            <!-- Precision / Recall / F1 インライン -->
            <div style="display:flex;gap:1.5rem;align-items:center;margin-bottom:1rem;padding-bottom:1rem;border-bottom:1px solid #1e293b;flex-wrap:wrap">
              <div>
                <span style="font-size:0.72rem;color:#94a3b8">${tt("Precision", "承認銘柄のうち実際に上昇した割合")}</span>
                <span style="font-weight:700;margin-left:0.5rem;color:${audit.confusionMatrix.precision != null && audit.confusionMatrix.precision >= 60 ? "#22c55e" : audit.confusionMatrix.precision != null ? "#ef4444" : "#64748b"}">
                  ${audit.confusionMatrix.precision != null ? `${audit.confusionMatrix.precision.toFixed(1)}%` : "-"}
                </span>
              </div>
              <div>
                <span style="font-size:0.72rem;color:#94a3b8">${tt("Recall", "上昇銘柄のうち承認できた割合")}</span>
                <span style="font-weight:700;margin-left:0.5rem;color:${audit.confusionMatrix.recall != null && audit.confusionMatrix.recall >= 50 ? "#22c55e" : audit.confusionMatrix.recall != null ? "#ef4444" : "#64748b"}">
                  ${audit.confusionMatrix.recall != null ? `${audit.confusionMatrix.recall.toFixed(1)}%` : "-"}
                </span>
              </div>
              <div>
                <span style="font-size:0.72rem;color:#94a3b8">${tt("F1", "PrecisionとRecallの調和平均")}</span>
                <span style="font-weight:700;margin-left:0.5rem;color:${audit.confusionMatrix.f1 != null && audit.confusionMatrix.f1 >= 50 ? "#22c55e" : audit.confusionMatrix.f1 != null ? "#ef4444" : "#64748b"}">
                  ${audit.confusionMatrix.f1 != null ? `${audit.confusionMatrix.f1.toFixed(1)}%` : "-"}
                </span>
              </div>
              <div style="font-size:0.75rem;color:#64748b">
                TP=${audit.confusionMatrix.tp} FP=${audit.confusionMatrix.fp} FN=${audit.confusionMatrix.fn} TN=${audit.confusionMatrix.tn}
              </div>
            </div>

            <!-- AI却下・取引見送り・閾値未達 3カラム -->
            <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:1rem">
              <!-- 取引見送り判断 -->
              <div>
                <p style="font-size:0.75rem;color:#94a3b8;margin:0 0 0.25rem">取引見送り判断</p>
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
          </div>

          <!-- ランク別精度（折りたたみ） -->
          <div class="card">
            <details>
              <summary style="cursor:pointer;font-size:0.82rem;color:#94a3b8;user-select:none">ランク別精度テーブル</summary>
              <div class="table-wrap" style="margin-top:0.75rem">
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
            </details>
          </div>
        `}

    <!-- FP: 誤エントリー -->
    <p class="section-title">誤エントリー（承認したが下落）</p>
    ${fpStocks.length > 0
      ? html`
          <div class="card table-wrap">
            <table>
              <thead>
                <tr>
                  <th style="width:12%">日付</th>
                  <th style="width:18%">銘柄</th>
                  <th style="width:14%">スコア</th>
                  <th style="width:14%">ランク</th>
                  <th style="width:20%">騰落率</th>
                  <th style="width:22%">${tt("誤判断タイプ", "AI分析による誤判断の分類")}</th>
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
                        <td colspan="6" style="background:#1e293b;padding:0.75rem;font-size:0.82rem;line-height:1.6;word-break:break-word;white-space:normal">
                          <p style="margin:0 0 0.5rem;color:#cbd5e1">${ghost.analysis}</p>
                          ${ghost.recommendation ? html`<p style="margin:0;color:#94a3b8"><strong>改善提案:</strong> ${recommendationLabels[ghost.recommendation] ?? ghost.recommendation}</p>` : ""}
                        </td>
                      </tr>
                    ` : ""}
                  `;
                })}
              </tbody>
            </table>
          </div>
        `
      : html`<div class="card">${emptyState("誤エントリーはまだありません")}</div>`}

    <!-- FN: 見逃し銘柄（Aランク以上のみ） -->
    <p class="section-title">見逃し銘柄（Aランク以上・棄却したが上昇）</p>
    ${fnStocks.length > 0
      ? html`
          <div class="card table-wrap">
            <table>
              <thead>
                <tr>
                  <th style="width:12%">日付</th>
                  <th style="width:18%">銘柄</th>
                  <th style="width:22%">棄却理由</th>
                  <th style="width:14%">スコア</th>
                  <th style="width:14%">ランク</th>
                  <th style="width:20%">騰落率</th>
                </tr>
              </thead>
              <tbody>
                ${fnStocks.map((r) => {
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
                        <td colspan="6" style="background:#1e293b;padding:0.75rem;font-size:0.82rem;line-height:1.6;word-break:break-word;white-space:normal">
                          <p style="margin:0 0 0.5rem;color:#cbd5e1">${ghost.analysis}</p>
                          ${ghost.recommendation ? html`<p style="margin:0;color:#94a3b8"><strong>改善提案:</strong> ${recommendationLabels[ghost.recommendation] ?? ghost.recommendation}</p>` : ""}
                        </td>
                      </tr>
                    ` : ""}
                  `;
                })}
              </tbody>
            </table>
          </div>
        `
      : html`<div class="card">${emptyState("見逃し銘柄はまだありません")}</div>`}

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

  return c.html(layout("スコアリング精度", "/accuracy", content));
});

export default app;
