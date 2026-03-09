/**
 * 見送り分析ページ（GET /contrarian）
 *
 * 1. 逆行候補: 市場停止日にスコアリングされた銘柄
 * 2. 見逃し銘柄: 個別にスキップしたが上がった銘柄（ai_no_go / below_threshold）
 * 3. 逆行実績ランキング
 * 4. 逆行ボーナス適用銘柄
 */

import { Hono } from "hono";
import { html } from "hono/html";
import dayjs from "dayjs";
import { prisma } from "../../lib/prisma";
import { getTodayForDB, getDaysAgoForDB } from "../../lib/date-utils";
import { CONTRARIAN, GHOST_TRADING } from "../../lib/constants";
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
    // 今日の逆行候補: Ghost Review 不要（スコア・ランクだけで表示）
    prisma.scoringRecord.findMany({
      where: {
        date: today,
        rejectionReason: "market_halted",
        entryPrice: { not: null },
      },
      orderBy: { totalScore: "desc" },
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
    // ランキング: closingPrice 不要（halt日にスコアされた回数も集計）
    prisma.scoringRecord.findMany({
      where: {
        rejectionReason: "market_halted",
        date: { gte: since90 },
      },
      select: { tickerCode: true, ghostProfitPct: true, totalScore: true },
    }),
  ]);

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

  const content = html`
    <!-- セクション1: 今日の逆行候補 -->
    <p class="section-title">
      今日の逆行候補${isNoTradeDay ? "" : "（取引実行日）"}
    </p>
    ${isNoTradeDay
      ? todayCandidates.length > 0
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
                        <td>
                          ${r.closingPrice != null
                            ? html`¥${formatYen(Number(r.closingPrice))}`
                            : html`<span style="color:#64748b">-</span>`}
                        </td>
                        <td>
                          ${r.ghostProfitPct != null
                            ? pnlPercent(Number(r.ghostProfitPct))
                            : html`<span style="color:#64748b">未確定</span>`}
                        </td>
                      </tr>
                    `,
                  )}
                </tbody>
              </table>
            </div>
          `
        : html`<div class="card">
            ${emptyState("市場停止日ですが、スコアリングされた銘柄はありません")}
          </div>`
      : html`<div class="card">
          ${emptyState(
            todayAssessment
              ? "本日は取引実行日です（逆行候補は市場停止日のみ）"
              : "本日の市場評価はまだ実行されていません",
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
  `;

  return c.html(layout("見送り分析", "/contrarian", content));
});

export default app;
