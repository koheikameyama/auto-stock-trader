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
import { getTodayForDB, getDaysAgoForDB } from "../../lib/date-utils";
import { CONTRARIAN, GHOST_TRADING, getSectorGroup } from "../../lib/constants";
import { calculateContrarianBonus } from "../../core/contrarian-analyzer";
import { layout } from "../views/layout";
import {
  formatYen,
  pnlPercent,
  emptyState,
  rankBadge,
} from "../views/components";

const app = new Hono();

app.get("/", async (c) => {
  const today = getTodayForDB();
  const since90 = getDaysAgoForDB(CONTRARIAN.LOOKBACK_DAYS);

  const [
    todayAssessment,
    todayCandidates,
    missedStocks,
    recentBonusRecords,
    allHaltedRecords,
  ] = await Promise.all([
    prisma.marketAssessment.findUnique({ where: { date: today } }),
    // 今日の上昇確認銘柄: ghost-review 後に ghostProfitPct > 0 のもののみ表示
    prisma.scoringRecord.findMany({
      where: {
        date: today,
        rejectionReason: "market_halted",
        entryPrice: { not: null },
        ghostProfitPct: { gt: 0 },
      },
      orderBy: { ghostProfitPct: "desc" },
    }),
    // 見逃し銘柄: AI却下 or スコア不足だが上がった銘柄（直近30件）
    prisma.scoringRecord.findMany({
      where: {
        rejectionReason: { in: ["ai_no_go", "below_threshold"] },
        ghostProfitPct: { gt: 0 },
        closingPrice: { not: null },
        entryPrice: { not: null },
      },
      orderBy: { date: "desc" },
      take: 30,
    }),
    prisma.scoringRecord.findMany({
      where: { contrarianBonus: { gt: 0 } },
      orderBy: { date: "desc" },
      take: 50,
    }),
    // ランキング用: market_halted 銘柄のみ（逆行実績ランキング）
    prisma.scoringRecord.findMany({
      where: {
        rejectionReason: "market_halted",
        date: { gte: since90 },
      },
      select: {
        tickerCode: true,
        ghostProfitPct: true,
        totalScore: true,
        technicalScore: true,
        patternScore: true,
        liquidityScore: true,
        rank: true,
        closingPrice: true,
      },
    }),
  ]);

  // 傾向分析用: スコア80点以上で購入しなかった全銘柄（market_halted + ai_no_go + below_threshold）
  const highScoreTrendRecords = await prisma.scoringRecord.findMany({
    where: {
      rejectionReason: { not: null },
      totalScore: { gte: 80 },
      closingPrice: { not: null },
      date: { gte: since90 },
    },
    select: {
      tickerCode: true,
      ghostProfitPct: true,
      totalScore: true,
      technicalScore: true,
      patternScore: true,
      liquidityScore: true,
      rank: true,
      closingPrice: true,
      rejectionReason: true,
    },
  });

  // 低スコア上昇銘柄: ghost追跡下限(60点)以上80点未満で ghostProfitPct > 0
  const lowScoreWinners = await prisma.scoringRecord.findMany({
    where: {
      rejectionReason: { not: null },
      totalScore: { gte: GHOST_TRADING.MIN_SCORE_FOR_TRACKING, lt: 80 },
      closingPrice: { not: null },
      ghostProfitPct: { gt: 0 },
      date: { gte: since90 },
    },
    select: {
      tickerCode: true,
      ghostProfitPct: true,
      totalScore: true,
      technicalScore: true,
      patternScore: true,
      liquidityScore: true,
      rank: true,
      rejectionReason: true,
    },
    orderBy: { ghostProfitPct: "desc" },
  });

  // 傾向分析用: Stock テーブルからセクター情報を一括取得（N+1 回避）
  const trendTickers = [
    ...new Set([
      ...highScoreTrendRecords.map((r) => r.tickerCode),
      ...lowScoreWinners.map((r) => r.tickerCode),
    ]),
  ];
  const stocksForTrend = await prisma.stock.findMany({
    where: { tickerCode: { in: trendTickers } },
    select: { tickerCode: true, jpxSectorName: true },
  });
  const sectorMap = new Map(stocksForTrend.map((s) => [s.tickerCode, s.jpxSectorName]));

  const isNoTradeDay = todayAssessment?.shouldTrade === false;

  // --- セクション2: 逆行実績ランキング集計 ---
  const buckets = new Map<
    string,
    { wins: number; totalDays: number; profitSum: number; scoreSum: number }
  >();

  for (const r of allHaltedRecords) {
    const pct = r.ghostProfitPct != null ? Number(r.ghostProfitPct) : null;
    let bucket = buckets.get(r.tickerCode);
    if (!bucket) {
      bucket = { wins: 0, totalDays: 0, profitSum: 0, scoreSum: 0 };
      buckets.set(r.tickerCode, bucket);
    }
    bucket.totalDays++;
    bucket.scoreSum += r.totalScore;
    if (pct != null && pct >= CONTRARIAN.MIN_PROFIT_PCT) {
      bucket.wins++;
      bucket.profitSum += pct;
    }
  }

  const ranking = [...buckets.entries()]
    .map(([ticker, b]) => ({
      tickerCode: ticker,
      wins: b.wins,
      totalDays: b.totalDays,
      winRate: b.wins > 0 ? Math.round((b.wins / b.totalDays) * 100) : null,
      avgProfitPct: b.wins > 0 ? b.profitSum / b.wins : null,
      avgScore: Math.round(b.scoreSum / b.totalDays),
      bonus: calculateContrarianBonus(b.wins),
    }))
    .sort(
      (a, b) =>
        b.wins - a.wins ||
        (b.avgProfitPct ?? 0) - (a.avgProfitPct ?? 0) ||
        b.avgScore - a.avgScore,
    )
    .slice(0, 30);

  // --- セクション5: 傾向分析 ---
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
    key: "totalScore" | "technicalScore" | "patternScore" | "liquidityScore",
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
    winnerAvgTech: avgOf(winners, "technicalScore"),
    loserAvgTech: avgOf(losers, "technicalScore"),
    winnerAvgPattern: avgOf(winners, "patternScore"),
    loserAvgPattern: avgOf(losers, "patternScore"),
    winnerAvgLiquidity: avgOf(winners, "liquidityScore"),
    loserAvgLiquidity: avgOf(losers, "liquidityScore"),
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

  // 低スコア上昇銘柄のセクター集計
  interface LowScoreSectorBucket { count: number; profitSum: number }
  const lowScoreSectorBuckets = new Map<string, LowScoreSectorBucket>();
  for (const r of lowScoreWinners) {
    const jpxSector = sectorMap.get(r.tickerCode);
    const sector = getSectorGroup(jpxSector ?? null) ?? "その他";
    let b = lowScoreSectorBuckets.get(sector);
    if (!b) {
      b = { count: 0, profitSum: 0 };
      lowScoreSectorBuckets.set(sector, b);
    }
    b.count++;
    b.profitSum += Number(r.ghostProfitPct);
  }
  const lowScoreSectorStats = [...lowScoreSectorBuckets.entries()]
    .map(([sector, b]) => ({
      sector,
      count: b.count,
      avgProfitPct: b.profitSum / b.count,
    }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 8);

  const lowScoreAvgTech =
    lowScoreWinners.length > 0
      ? Math.round(lowScoreWinners.reduce((s, r) => s + r.technicalScore, 0) / lowScoreWinners.length)
      : null;
  const lowScoreAvgPattern =
    lowScoreWinners.length > 0
      ? Math.round(lowScoreWinners.reduce((s, r) => s + r.patternScore, 0) / lowScoreWinners.length)
      : null;
  const lowScoreAvgLiquidity =
    lowScoreWinners.length > 0
      ? Math.round(lowScoreWinners.reduce((s, r) => s + r.liquidityScore, 0) / lowScoreWinners.length)
      : null;
  const lowScoreAvgPct =
    lowScoreWinners.length > 0
      ? lowScoreWinners.reduce((s, r) => s + Number(r.ghostProfitPct), 0) / lowScoreWinners.length
      : null;

  const content = html`
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
                  <th>スコア</th>
                  <th>ランク</th>
                  <th>エントリー</th>
                  <th>終値</th>
                  <th>騰落率</th>
                </tr>
              </thead>
              <tbody>
                ${todayCandidates.map(
                  (r) => html`
                    <tr>
                      <td style="font-weight:600">${r.tickerCode}</td>
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
            "本日の上昇確認銘柄はありません（ゴーストレビュー後に更新されます）",
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
                      <td style="font-weight:600">${r.tickerCode}</td>
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
                  <th>出現</th>
                  <th>平均スコア</th>
                  <th>逆行勝ち</th>
                  <th>勝率</th>
                  <th>平均利益率</th>
                  <th>ボーナス</th>
                </tr>
              </thead>
              <tbody>
                ${ranking.map(
                  (r) => html`
                    <tr>
                      <td style="font-weight:600">${r.tickerCode}</td>
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
                      <td style="font-weight:600">${r.tickerCode}</td>
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
                    <td style="color:#94a3b8">平均スコア</td>
                    <td style="font-weight:600">${trendSummary.winnerAvgScore ?? "-"}</td>
                  </tr>
                  <tr>
                    <td style="color:#94a3b8">技術</td>
                    <td>${trendSummary.winnerAvgTech ?? "-"}</td>
                  </tr>
                  <tr>
                    <td style="color:#94a3b8">パターン</td>
                    <td>${trendSummary.winnerAvgPattern ?? "-"}</td>
                  </tr>
                  <tr>
                    <td style="color:#94a3b8">流動性</td>
                    <td>${trendSummary.winnerAvgLiquidity ?? "-"}</td>
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
                    <td style="color:#94a3b8">技術</td>
                    <td>${trendSummary.loserAvgTech ?? "-"}</td>
                  </tr>
                  <tr>
                    <td style="color:#94a3b8">パターン</td>
                    <td>${trendSummary.loserAvgPattern ?? "-"}</td>
                  </tr>
                  <tr>
                    <td style="color:#94a3b8">流動性</td>
                    <td>${trendSummary.loserAvgLiquidity ?? "-"}</td>
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
                    label: "技術",
                    w: trendSummary.winnerAvgTech,
                    l: trendSummary.loserAvgTech,
                  },
                  {
                    label: "パターン",
                    w: trendSummary.winnerAvgPattern,
                    l: trendSummary.loserAvgPattern,
                  },
                  {
                    label: "流動性",
                    w: trendSummary.winnerAvgLiquidity,
                    l: trendSummary.loserAvgLiquidity,
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
                  <p style="font-size:0.8rem;color:#94a3b8;margin:0 0 0.75rem">セクター別成績</p>
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
                      ${sectorStats.map(
                        (s) => html`
                          <tr>
                            <td style="font-weight:600">${s.sector}</td>
                            <td>${s.total}回</td>
                            <td>${s.wins}回</td>
                            <td
                              style="font-weight:600;color:${s.winRate >= 50 ? "#22c55e" : "#ef4444"}"
                            >
                              ${s.winRate}%
                            </td>
                            <td>
                              ${s.avgProfitPct != null
                                ? pnlPercent(s.avgProfitPct)
                                : html`<span style="color:#64748b">-</span>`}
                            </td>
                          </tr>
                        `,
                      )}
                    </tbody>
                  </table>
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
                    低スコア上昇銘柄（${GHOST_TRADING.MIN_SCORE_FOR_TRACKING}〜79点）— ${lowScoreWinners.length}件
                    <span style="margin-left:0.5rem;font-size:0.75rem;color:#f59e0b">スコアリングが見逃した上昇パターン</span>
                  </p>
                  <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:0.5rem;margin-bottom:0.75rem;font-size:0.85rem">
                    <div style="text-align:center">
                      <div style="color:#94a3b8;font-size:0.75rem">平均利益率</div>
                      <div style="font-weight:700;color:#22c55e">
                        ${lowScoreAvgPct != null ? `+${lowScoreAvgPct.toFixed(2)}%` : "-"}
                      </div>
                    </div>
                    <div style="text-align:center">
                      <div style="color:#94a3b8;font-size:0.75rem">技術avg</div>
                      <div style="font-weight:600">${lowScoreAvgTech ?? "-"}</div>
                    </div>
                    <div style="text-align:center">
                      <div style="color:#94a3b8;font-size:0.75rem">パターンavg</div>
                      <div style="font-weight:600">${lowScoreAvgPattern ?? "-"}</div>
                    </div>
                    <div style="text-align:center">
                      <div style="color:#94a3b8;font-size:0.75rem">流動性avg</div>
                      <div style="font-weight:600">${lowScoreAvgLiquidity ?? "-"}</div>
                    </div>
                  </div>
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
                    低スコア上昇銘柄（${GHOST_TRADING.MIN_SCORE_FOR_TRACKING}〜79点）— 該当なし
                  </p>
                </div>
              `}
        `}
  `;

  return c.html(layout("見送り分析", "/contrarian", content));
});

export default app;
