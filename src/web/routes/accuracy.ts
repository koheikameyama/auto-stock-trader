/**
 * 見送り分析ページ（GET /contrarian）
 *
 * 1. 逆行候補: 市場停止日にスコアリングされた銘柄
 * 2. 見逃し銘柄: 個別にスキップしたが上がった銘柄（ai_no_go / below_threshold）
 * 3. 逆行実績ランキング
 * 4. 逆行ボーナス適用銘柄
 * 5. 傾向分析: 勝ち vs 負け比較 / セクター分布 / スコア内訳
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
    <!-- セクション0: 判断整合性 -->
    <p class="section-title">${latestDateLabel}の判断整合性</p>
    ${audit == null
      ? html`<div class="card">
          ${emptyState("ゴーストレビュー後に更新されます（16:10 JST 以降）")}
        </div>`
      : html`
          <div class="card">
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
                      ${audit.marketHalt.risingRate != null && audit.marketHalt.risingRate > 50 && audit.marketHalt.wasHalted
                        ? html`<p style="font-size:0.72rem;color:#f59e0b;margin:0.25rem 0 0">⚠ 過剰な停止判断の可能性</p>`
                        : ""}
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
        `}

    <!-- セクション1: 今日の上昇確認銘柄 -->
    <p class="section-title">
      今日の上昇確認銘柄${isNoTradeDay
        ? html`<span style="margin-left:0.5rem;font-size:0.75rem;color:#f59e0b;background:#f59e0b20;padding:2px 8px;border-radius:9999px">市場停止日</span>`
        : ""}
    </p>
    ${todayCandidates.length > 0
      ? html`
          <div class="card table-wrap">
            <table>
              <thead>
                <tr>
                  <th>銘柄</th>
                  <th>${tt("スコア", "トレンド品質・エントリータイミング・リスク品質を合算した100点満点のスコア")}</th>
                  <th>ランク</th>
                  <th>${tt("エントリー", "仮想エントリー価格（市場停止日の始値）")}</th>
                  <th>終値</th>
                  <th>${tt("騰落率", "エントリー価格に対する終値の変化率")}</th>
                </tr>
              </thead>
              <tbody>
                ${todayCandidates.map(
                  (r) => html`
                    <tr>
                      <td>${tickerLink(r.tickerCode)}</td>
                      <td>${r.totalScore}</td>
                      <td>${rankBadge(r.rank)}</td>
                      <td>¥${formatYen(Number(r.entryPrice))}</td>
                      <td>¥${formatYen(Number(r.closingPrice))}</td>
                      <td>${pnlPercent(Number(r.ghostProfitPct))}</td>
                    </tr>
                  `,
                )}
              </tbody>
            </table>
          </div>
        `
      : html`<div class="card">
          ${emptyState(
            `${latestDateLabel}の上昇確認銘柄はありません（ゴーストレビュー後に更新されます）`,
          )}
        </div>`}

    <!-- セクション2: 見逃し銘柄 -->
    <p class="section-title">見逃し銘柄（スキップしたが上昇）</p>
    ${missedStocks.length > 0
      ? html`
          <div class="card table-wrap">
            <table>
              <thead>
                <tr>
                  <th>日付</th>
                  <th>銘柄</th>
                  <th>理由</th>
                  <th>スコア</th>
                  <th>ランク</th>
                  <th>騰落率</th>
                </tr>
              </thead>
              <tbody>
                ${missedStocks.map(
                  (r) => html`
                    <tr>
                      <td>${dayjs(r.date).format("M/D")}</td>
                      <td>${tickerLink(r.tickerCode)}</td>
                      <td>
                        ${r.rejectionReason === "ai_no_go"
                          ? html`<span class="badge" style="background:#ef444420;color:#ef4444">AI却下</span>`
                          : html`<span class="badge" style="background:#f59e0b20;color:#f59e0b">スコア不足</span>`}
                      </td>
                      <td>${r.totalScore}</td>
                      <td>${rankBadge(r.rank)}</td>
                      <td>${pnlPercent(Number(r.ghostProfitPct))}</td>
                    </tr>
                  `,
                )}
              </tbody>
            </table>
          </div>
        `
      : html`<div class="card">
          ${emptyState("見逃し銘柄はまだありません")}
        </div>`}

    <!-- セクション3: 逆行実績ランキング -->
    <p class="section-title">
      逆行実績ランキング（過去${CONTRARIAN.LOOKBACK_DAYS}日）
    </p>
    ${ranking.length > 0
      ? html`
          <div class="card table-wrap">
            <table>
              <thead>
                <tr>
                  <th>銘柄</th>
                  <th>${tt("出現", "市場停止日にスコアリングされた回数")}</th>
                  <th>平均スコア</th>
                  <th>${tt("逆行勝ち", "市場停止日に実際に上昇した回数")}</th>
                  <th>${tt("勝率", "市場停止日の上昇確率")}</th>
                  <th>平均利益率</th>
                  <th>${tt("ボーナス", "逆行実績に基づきスコアに加算されるポイント")}</th>
                </tr>
              </thead>
              <tbody>
                ${ranking.map(
                  (r) => html`
                    <tr>
                      <td>${tickerLink(r.tickerCode)}</td>
                      <td>${r.totalDays}回</td>
                      <td>${r.avgScore}</td>
                      <td>${r.wins > 0 ? `${r.wins}回` : "-"}</td>
                      <td>
                        ${r.winRate != null
                          ? `${r.winRate}%`
                          : html`<span style="color:#64748b">未確定</span>`}
                      </td>
                      <td>
                        ${r.avgProfitPct != null
                          ? pnlPercent(r.avgProfitPct)
                          : html`<span style="color:#64748b">-</span>`}
                      </td>
                      <td>
                        ${r.bonus > 0
                          ? html`<span class="pnl-positive"
                              >+${r.bonus}点</span
                            >`
                          : "-"}
                      </td>
                    </tr>
                  `,
                )}
              </tbody>
            </table>
          </div>
        `
      : html`<div class="card">
          ${emptyState("逆行実績のある銘柄はまだありません")}
        </div>`}

    <!-- セクション3: 逆行ボーナス適用銘柄 -->
    <p class="section-title">直近の逆行ボーナス適用銘柄</p>
    ${recentBonusRecords.length > 0
      ? html`
          <div class="card table-wrap">
            <table>
              <thead>
                <tr>
                  <th>日付</th>
                  <th>銘柄</th>
                  <th>ベース</th>
                  <th>ボーナス</th>
                  <th>合計</th>
                  <th>ランク</th>
                  <th>勝ち数</th>
                </tr>
              </thead>
              <tbody>
                ${recentBonusRecords.map(
                  (r) => html`
                    <tr>
                      <td>${dayjs(r.date).format("M/D")}</td>
                      <td>${tickerLink(r.tickerCode)}</td>
                      <td>${r.totalScore - r.contrarianBonus}</td>
                      <td>
                        <span class="pnl-positive"
                          >+${r.contrarianBonus}</span
                        >
                      </td>
                      <td style="font-weight:600">${r.totalScore}</td>
                      <td>${rankBadge(r.rank)}</td>
                      <td>${r.contrarianWins}回</td>
                    </tr>
                  `,
                )}
              </tbody>
            </table>
          </div>
        `
      : html`<div class="card">
          ${emptyState("逆行ボーナスが適用された銘柄はまだありません")}
        </div>`}

    <!-- セクション5: 傾向分析 -->
    <p class="section-title">
      傾向分析（過去${CONTRARIAN.LOOKBACK_DAYS}日 / スコア80点以上・未購入）
    </p>
    ${trendSummary.analyzed === 0
      ? html`<div class="card">
          ${emptyState(
            "分析データが蓄積されるまでお待ちください（市場停止日のゴーストレビュー後に表示されます）",
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
                    <td style="color:#94a3b8">翌日継続率</td>
                    <td style="font-weight:600;color:${trendSummary.nextDayContinuationRate != null && trendSummary.nextDayContinuationRate >= 50 ? "#22c55e" : "#94a3b8"}">
                      ${trendSummary.nextDayContinuationRate != null
                        ? `${trendSummary.nextDayContinuationRate}% (n=${trendSummary.nextDaySampleSize})`
                        : html`<span style="color:#64748b">データ蓄積中</span>`}
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

          <!-- 低スコア上昇銘柄 -->
          ${lowScoreWinners.length > 0
            ? html`
                <div class="card">
                  <p style="font-size:0.8rem;color:#94a3b8;margin:0 0 0.75rem">
                    低スコア上昇銘柄（${SCORING_ACCURACY.MIN_SCORE_FOR_TRACKING}〜79点）— ${lowScoreWinners.length}件
                    <span style="margin-left:0.5rem;font-size:0.75rem;color:#f59e0b">スコアリングが見逃した上昇パターン</span>
                  </p>
                  <div style="display:grid;grid-template-columns:repeat(5,1fr);gap:0.5rem;margin-bottom:0.75rem;font-size:0.85rem">
                    <div style="text-align:center">
                      <div style="color:#94a3b8;font-size:0.75rem">平均利益率</div>
                      <div style="font-weight:700;color:#22c55e">
                        ${lowScoreAvgPct != null ? `+${lowScoreAvgPct.toFixed(2)}%` : "-"}
                      </div>
                    </div>
                    <div style="text-align:center">
                      <div style="color:#94a3b8;font-size:0.75rem">日経avg</div>
                      <div style="font-weight:600;color:#94a3b8">
                        ${baselineNikkeiAvg != null
                          ? `${baselineNikkeiAvg >= 0 ? "+" : ""}${baselineNikkeiAvg.toFixed(2)}%`
                          : "-"}
                      </div>
                    </div>
                    <div style="text-align:center">
                      <div style="color:#94a3b8;font-size:0.75rem">トレンドavg</div>
                      <div style="font-weight:600">${lowScoreAvgTrend ?? "-"}</div>
                    </div>
                    <div style="text-align:center">
                      <div style="color:#94a3b8;font-size:0.75rem">エントリーavg</div>
                      <div style="font-weight:600">${lowScoreAvgEntry ?? "-"}</div>
                    </div>
                    <div style="text-align:center">
                      <div style="color:#94a3b8;font-size:0.75rem">リスクavg</div>
                      <div style="font-weight:600">${lowScoreAvgRisk ?? "-"}</div>
                    </div>
                  </div>
                  ${baselineNikkeiAvg != null && lowScoreAvgPct != null
                    ? html`<p style="font-size:0.75rem;color:${lowScoreAvgPct > baselineNikkeiAvg ? "#22c55e" : "#94a3b8"};margin:0 0 0.75rem">
                        ${lowScoreAvgPct > baselineNikkeiAvg
                          ? `▲ 日経比 +${(lowScoreAvgPct - baselineNikkeiAvg).toFixed(2)}pt のアルファあり`
                          : `日経と同等（アルファなし）`}
                      </p>`
                    : ""}
                  <!-- セクター分布 -->
                  ${lowScoreSectorStats.length > 0
                    ? html`
                        <div class="table-wrap">
                          <table style="font-size:0.82rem">
                            <thead>
                              <tr><th>セクター</th><th>件数</th><th>平均利益率</th></tr>
                            </thead>
                            <tbody>
                              ${lowScoreSectorStats.map(
                                (s) => html`
                                  <tr>
                                    <td style="font-weight:600">${s.sector}</td>
                                    <td>${s.count}件</td>
                                    <td>${pnlPercent(s.avgProfitPct)}</td>
                                  </tr>
                                `,
                              )}
                            </tbody>
                          </table>
                        </div>
                      `
                    : ""}
                </div>
              `
            : html`
                <div class="card">
                  <p style="font-size:0.8rem;color:#94a3b8;margin:0">
                    低スコア上昇銘柄（${SCORING_ACCURACY.MIN_SCORE_FOR_TRACKING}〜79点）— 該当なし
                  </p>
                </div>
              `}
        `}
  `;

  return c.html(layout("精度分析", "/accuracy", content));
});

export default app;
