/**
 * バックテスト結果ページ（GET /backtest）
 */

import { Hono } from "hono";
import { html, raw } from "hono/html";
import dayjs from "dayjs";
import { prisma } from "../../lib/prisma";
import { DAILY_BACKTEST } from "../../lib/constants";
import { layout } from "../views/layout";
import {
  formatYen,
  pnlPercent,
  emptyState,
  tt,
} from "../views/components";

const app = new Hono();

/** Chart.js 条件別カラー */
const CONDITION_COLORS: Record<string, string> = {
  baseline: "#ffffff",
  "ts_act_1.5": "#93c5fd",
  "ts_act_2.0": "#3b82f6",
  "ts_act_2.5": "#1d4ed8",
  score_60: "#86efac",
  score_65: "#22c55e",
  score_70: "#15803d",
  "atr_0.8": "#fdba74",
  "atr_1.0": "#f97316",
  "atr_1.5": "#c2410c",
  "trail_0.8": "#d8b4fe",
  "trail_1.0": "#a855f7",
  "trail_1.5": "#7e22ce",
  trend_on: "#f472b6",
  pullback_on: "#fb923c",
  trend_pullback: "#ef4444",
};

app.get("/", async (c) => {
  const trendDays = DAILY_BACKTEST.TREND_DAYS;
  const sinceDate = dayjs().subtract(trendDays, "day").toDate();

  const conditionCount = DAILY_BACKTEST.PARAMETER_CONDITIONS.length;

  const [latestResults, trendData] = await Promise.all([
    // 最新日の結果（全条件）
    prisma.backtestDailyResult.findMany({
      orderBy: { date: "desc" },
      take: conditionCount,
      distinct: ["conditionKey"],
    }),
    // トレンドデータ（過去30日、全条件）
    prisma.backtestDailyResult.findMany({
      where: { date: { gte: sinceDate } },
      orderBy: [{ date: "asc" }, { conditionKey: "asc" }],
      select: {
        date: true,
        conditionKey: true,
        conditionLabel: true,
        winRate: true,
        totalReturnPct: true,
        profitFactor: true,
        totalPnl: true,
        totalTrades: true,
        maxDrawdown: true,
      },
    }),
  ]);

  const latestDate =
    latestResults.length > 0
      ? dayjs(latestResults[0].date).format("YYYY/M/D")
      : null;

  // 条件定義順にソート
  const conditionOrder = DAILY_BACKTEST.PARAMETER_CONDITIONS.map((c) => c.key);
  const sortedLatest = [...latestResults].sort(
    (a, b) =>
      conditionOrder.indexOf(a.conditionKey) -
      conditionOrder.indexOf(b.conditionKey),
  );

  // モーダル用データ
  const detailDataJson = JSON.stringify(
    sortedLatest.reduce(
      (acc, r) => {
        acc[r.conditionKey] = {
          label: r.conditionLabel,
          initialBudget: r.initialBudget,
          maxPrice: r.maxPrice,
          winRate: Number(r.winRate),
          wins: r.wins,
          losses: r.losses,
          totalPnl: r.totalPnl,
          totalReturnPct: Number(r.totalReturnPct),
          profitFactor: Number(r.profitFactor),
          maxDrawdown: Number(r.maxDrawdown),
          sharpeRatio: r.sharpeRatio != null ? Number(r.sharpeRatio) : null,
          avgHoldingDays: Number(r.avgHoldingDays),
          tickerCount: r.tickerCount,
          periodStart: r.periodStart,
          periodEnd: r.periodEnd,
          executionTimeMs: r.executionTimeMs,
        };
        return acc;
      },
      {} as Record<string, unknown>,
    ),
  );

  // チャート用データ: conditionKey でグルーピング
  const chartGrouped: Record<string, { labels: string[]; data: number[] }> = {};
  for (const d of trendData) {
    const key = d.conditionKey;
    if (!chartGrouped[key]) chartGrouped[key] = { labels: [], data: [] };
    chartGrouped[key].labels.push(dayjs(d.date).format("M/D"));
    chartGrouped[key].data.push(Number(d.totalReturnPct));
  }
  const chartDataJson = JSON.stringify(chartGrouped);

  const conditionLabelsJson = JSON.stringify(
    DAILY_BACKTEST.PARAMETER_CONDITIONS.reduce(
      (acc, c) => {
        acc[c.key] = c.label;
        return acc;
      },
      {} as Record<string, string>,
    ),
  );

  const chartColorsJson = JSON.stringify(CONDITION_COLORS);

  // 履歴テーブル用: ベースラインのみ
  const baselineTrend = trendData.filter((d) => d.conditionKey === "baseline");

  const content = html`
    <!-- 最新結果 -->
    <p class="section-title">
      最新バックテスト結果${latestDate ? html` (${latestDate})` : ""}
    </p>
    ${sortedLatest.length > 0
      ? html`
          <div class="card table-wrap">
            <table>
              <thead>
                <tr>
                  <th>${tt("条件", "パラメータ条件")}</th>
                  <th>${tt("勝率", "取引のうち利益が出た割合")}</th>
                  <th>${tt("PF", "プロフィットファクター。総利益÷総損失（1超が黒字）")}</th>
                  <th>${tt("リターン", "期間中の総収益率")}</th>
                  <th>${tt("DD", "最大ドローダウン。期間中の最大下落率")}</th>
                  <th>取引</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                ${sortedLatest.map(
                  (r) => html`
                    <tr>
                      <td style="font-weight:${r.conditionKey === "baseline" ? "700" : "400"}">
                        ${r.conditionLabel}
                      </td>
                      <td>${Number(r.winRate)}%</td>
                      <td>
                        ${Number(r.profitFactor) >= 999
                          ? "∞"
                          : Number(r.profitFactor)}
                      </td>
                      <td>${pnlPercent(Number(r.totalReturnPct))}</td>
                      <td style="color:#ef4444">
                        -${Number(r.maxDrawdown)}%
                      </td>
                      <td>${r.totalTrades}</td>
                      <td><span class="ticker-link" onclick="openBacktestDetail('${r.conditionKey}')">詳細</span></td>
                    </tr>
                  `,
                )}
              </tbody>
            </table>
          </div>
        `
      : html`<div class="card">${emptyState("バックテスト結果なし")}</div>`}

    <!-- リターン推移チャート -->
    <p class="section-title">リターン推移（過去${trendDays}日・全条件）</p>
    ${trendData.length > 0
      ? html`
          <div class="card" style="padding:12px">
            <canvas id="backtest-chart"></canvas>
          </div>
          <script src="https://cdn.jsdelivr.net/npm/chart.js@4.4/dist/chart.umd.min.js"></script>
          <script>
            (function() {
              if (typeof Chart === 'undefined') {
                document.getElementById('backtest-chart').parentNode.innerHTML = '<div class="empty">チャートを読み込めませんでした</div>';
                return;
              }

              var COLORS = ${raw(chartColorsJson)};
              var raw = ${raw(chartDataJson)};
              var conditionLabels = ${raw(conditionLabelsJson)};

              var labels = raw['baseline'] ? raw['baseline'].labels : Object.values(raw)[0].labels;

              var datasets = Object.keys(raw).map(function(key) {
                return {
                  label: conditionLabels[key] || key,
                  data: raw[key].data,
                  borderColor: COLORS[key] || '#888',
                  borderWidth: key === 'baseline' ? 3 : 1.5,
                  pointRadius: 0,
                  tension: 0.3,
                  fill: false
                };
              });

              new Chart(document.getElementById('backtest-chart'), {
                type: 'line',
                data: { labels: labels, datasets: datasets },
                options: {
                  responsive: true,
                  maintainAspectRatio: true,
                  aspectRatio: 2,
                  interaction: { mode: 'index', intersect: false },
                  plugins: {
                    legend: {
                      position: 'top',
                      labels: { color: '#94a3b8', font: { size: 11 }, boxWidth: 12, padding: 8 }
                    },
                    tooltip: {
                      callbacks: {
                        label: function(ctx) {
                          var v = ctx.parsed.y;
                          var sign = v >= 0 ? '+' : '';
                          return ctx.dataset.label + ': ' + sign + v.toFixed(2) + '%';
                        }
                      }
                    }
                  },
                  scales: {
                    x: {
                      ticks: { color: '#64748b', font: { size: 10 } },
                      grid: { color: 'rgba(100,116,139,0.2)' }
                    },
                    y: {
                      ticks: {
                        color: '#64748b',
                        font: { size: 10 },
                        callback: function(v) { return v + '%'; }
                      },
                      grid: { color: 'rgba(100,116,139,0.2)' }
                    }
                  }
                }
              });
            })();
          </script>
        `
      : html`<div class="card">${emptyState("トレンドデータなし")}</div>`}

    <!-- 履歴テーブル（ベースラインのみ） -->
    <p class="section-title">バックテスト履歴（ベースライン）</p>
    ${baselineTrend.length > 0
      ? html`
          <div class="card table-wrap">
            <table>
              <thead>
                <tr>
                  <th>日付</th>
                  <th>勝率</th>
                  <th>リターン</th>
                  <th>PF</th>
                  <th>取引</th>
                </tr>
              </thead>
              <tbody>
                ${[...baselineTrend].reverse().map(
                  (r) => html`
                    <tr>
                      <td>${dayjs(r.date).format("M/D")}</td>
                      <td>${Number(r.winRate)}%</td>
                      <td>${pnlPercent(Number(r.totalReturnPct))}</td>
                      <td>
                        ${Number(r.profitFactor) >= 999
                          ? "∞"
                          : Number(r.profitFactor)}
                      </td>
                      <td>${r.totalTrades}</td>
                    </tr>
                  `,
                )}
              </tbody>
            </table>
          </div>
        `
      : html`<div class="card">${emptyState("履歴なし")}</div>`}

    <!-- 詳細モーダル -->
    <div id="backtest-detail-modal"></div>

    <script>
      var btDetailData = ${raw(detailDataJson)};

      function openBacktestDetail(key) {
        var d = btDetailData[key];
        if (!d) return;
        var modal = document.getElementById('backtest-detail-modal');
        var pnlCls = d.totalPnl >= 0 ? 'pnl-positive' : 'pnl-negative';
        var pnlSign = d.totalPnl >= 0 ? '+' : '';
        var retCls = d.totalReturnPct >= 0 ? 'pnl-positive' : 'pnl-negative';
        var retSign = d.totalReturnPct >= 0 ? '+' : '';
        var fmt = function(v) { return Number(v).toLocaleString('ja-JP'); };

        modal.innerHTML = '<div class="modal-overlay" onclick="if(event.target===this)closeBacktestDetail()">'
          + '<div class="modal-content">'
          + '<div class="modal-header"><div><h2>' + d.label + '</h2></div>'
          + '<button class="modal-close" onclick="closeBacktestDetail()">&times;</button></div>'
          + '<div class="modal-body">'
          + '<div class="modal-row"><span class="modal-row-label">初期資金</span><span>&yen;' + fmt(d.initialBudget) + '</span></div>'
          + '<div class="modal-row"><span class="modal-row-label">価格上限</span><span>&yen;' + fmt(d.maxPrice) + '</span></div>'
          + '<div class="modal-row"><span class="modal-row-label">勝率</span><span>' + d.winRate + '%</span></div>'
          + '<div class="modal-row"><span class="modal-row-label">勝敗</span><span>' + d.wins + '勝 ' + d.losses + '敗</span></div>'
          + '<div class="modal-row"><span class="modal-row-label">累計損益</span><span class="' + pnlCls + '">' + pnlSign + '&yen;' + fmt(Math.abs(d.totalPnl)) + '</span></div>'
          + '<div class="modal-row"><span class="modal-row-label">リターン</span><span class="' + retCls + '">' + retSign + d.totalReturnPct.toFixed(2) + '%</span></div>'
          + '<div class="modal-row"><span class="modal-row-label">PF</span><span>' + (d.profitFactor >= 999 ? '&infin;' : d.profitFactor) + '</span></div>'
          + '<div class="modal-row"><span class="modal-row-label">最大DD</span><span style="color:#ef4444">-' + d.maxDrawdown + '%</span></div>'
          + '<div class="modal-row"><span class="modal-row-label">シャープレシオ</span><span>' + (d.sharpeRatio != null ? d.sharpeRatio : 'N/A') + '</span></div>'
          + '<div class="modal-row"><span class="modal-row-label">平均保有日数</span><span>' + d.avgHoldingDays + '日</span></div>'
          + '<div class="modal-row"><span class="modal-row-label">対象銘柄数</span><span>' + d.tickerCount + '</span></div>'
          + '<div class="modal-row"><span class="modal-row-label">期間</span><span>' + d.periodStart + ' ~ ' + d.periodEnd + '</span></div>'
          + '<div class="modal-row"><span class="modal-row-label">実行時間</span><span>' + (d.executionTimeMs / 1000).toFixed(1) + '秒</span></div>'
          + '</div></div></div>';
      }

      function closeBacktestDetail() {
        document.getElementById('backtest-detail-modal').innerHTML = '';
      }

      document.addEventListener('keydown', function(e) {
        if (e.key === 'Escape' && document.querySelector('#backtest-detail-modal .modal-overlay')) {
          closeBacktestDetail();
        }
      });
    </script>
  `;

  return c.html(layout("バックテスト", "/backtest", content));
});

export default app;
