/**
 * バックテスト結果ページ（GET /backtest）
 */

import { Hono } from "hono";
import { html, raw } from "hono/html";
import dayjs from "dayjs";
import { prisma } from "../../lib/prisma";
import { DAILY_BACKTEST } from "../../lib/constants";
import { layout } from "../views/layout";
import { COLORS } from "../views/styles";
import {
  formatYen,
  pnlPercent,
  emptyState,
  tt,
} from "../views/components";
import {
  runMonteCarloSimulation,
  type MonteCarloConfig,
} from "../../core/monte-carlo";

const app = new Hono();

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
    // 履歴データ（過去30日、ベースラインのみ）
    prisma.backtestDailyResult.findMany({
      where: { date: { gte: sinceDate }, conditionKey: "baseline" },
      orderBy: { date: "asc" },
      select: {
        date: true,
        conditionKey: true,
        winRate: true,
        totalReturnPct: true,
        profitFactor: true,
        totalTrades: true,
        fullResult: true,
      },
    }),
  ]);

  const latestDate =
    latestResults.length > 0
      ? dayjs(latestResults[0].date).format("YYYY/M/D")
      : null;

  // 条件キー一覧（モンテカルロ用、latestResultsから導出）
  const conditionKeys = latestResults.map((r) => ({
    conditionKey: r.conditionKey,
    conditionLabel: r.conditionLabel,
  }));

  // 条件定義順にソート
  const conditionTooltips: Record<string, string> = {
    paper_new: "現行ロジック（ATR1.0ベース損切り＋トレール1.0）で前方追跡",
    paper_old: "旧ロジック（固定損切り＋トレール2.0）で前方追跡",
  };

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
        const fr = r.fullResult as Record<string, unknown> | null;
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
          totalTrades: r.totalTrades,
          expectancy: fr?.expectancy != null ? Number(fr.expectancy) : null,
          riskRewardRatio: fr?.riskRewardRatio != null ? Number(fr.riskRewardRatio) : null,
          avgWinPct: fr?.avgWinPct != null ? Number(fr.avgWinPct) : null,
          avgLossPct: fr?.avgLossPct != null ? Number(fr.avgLossPct) : null,
        };
        return acc;
      },
      {} as Record<string, unknown>,
    ),
  );

  // 条件比較チャート用データ
  const comparisonData = sortedLatest.map((r) => {
    const fr = r.fullResult as Record<string, unknown> | null;
    return {
      label: r.conditionLabel,
      key: r.conditionKey,
      expectancy: fr?.expectancy != null ? Number(fr.expectancy) : null,
      profitFactor: Number(r.profitFactor) >= 999 ? null : Number(r.profitFactor),
      riskRewardRatio: fr?.riskRewardRatio != null ? Number(fr.riskRewardRatio) : null,
    };
  });

  // 時系列チャート用データ
  const trendChartData = trendData.map((r) => {
    const fr = (r as unknown as { fullResult: Record<string, unknown> | null }).fullResult;
    return {
      date: dayjs(r.date).format("M/D"),
      expectancy: fr?.expectancy != null ? Number(fr.expectancy) : null,
      profitFactor: Number(r.profitFactor) >= 999 ? null : Number(r.profitFactor),
    };
  });

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
                  <th>${tt("期待値", "1トレードあたりの期待収益率(%)。(勝率×平均利益)+(敗率×平均損失)")}</th>
                  <th>${tt("RR", "リスクリワード比。平均利益÷平均損失（1.5以上が目標）")}</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                ${sortedLatest.map(
                  (r) => html`
                    <tr>
                      <td style="font-weight:${r.conditionKey === "baseline" ? "700" : "400"}">
                        ${conditionTooltips[r.conditionKey]
                          ? tt(r.conditionLabel, conditionTooltips[r.conditionKey])
                          : r.conditionLabel}
                      </td>
                      <td>${Number(r.winRate)}%</td>
                      <td>
                        ${Number(r.profitFactor) >= 999
                          ? "∞"
                          : Number(r.profitFactor)}
                      </td>
                      <td>${pnlPercent(Number(r.totalReturnPct))}</td>
                      <td>${(() => {
                        const fr = r.fullResult as Record<string, unknown> | null;
                        const exp = fr?.expectancy != null ? Number(fr.expectancy) : null;
                        if (exp == null) return "N/A";
                        const color = exp >= 1.0 ? "#22c55e" : exp >= 0.5 ? "#3b82f6" : exp >= 0 ? "#f59e0b" : "#ef4444";
                        return html`<span style="color:${color}">${exp > 0 ? "+" : ""}${exp.toFixed(2)}%</span>`;
                      })()}</td>
                      <td>${(() => {
                        const fr = r.fullResult as Record<string, unknown> | null;
                        const rr = fr?.riskRewardRatio != null ? Number(fr.riskRewardRatio) : null;
                        if (rr == null) return "N/A";
                        const color = rr >= 1.5 ? "#22c55e" : rr >= 1.0 ? "#f59e0b" : "#ef4444";
                        return html`<span style="color:${color}">${rr.toFixed(2)}</span>`;
                      })()}</td>
                      <td><span class="ticker-link" onclick="openBacktestDetail('${r.conditionKey}')">詳細</span></td>
                    </tr>
                  `,
                )}
              </tbody>
            </table>
          </div>
        `
      : html`<div class="card">${emptyState("バックテスト結果なし")}</div>`}

    <!-- 条件比較チャート -->
    ${comparisonData.length > 1
      ? html`
          <p class="section-title">条件比較チャート</p>
          <div class="card" style="padding:16px;overflow-x:auto">
            <div id="comparison-chart"></div>
          </div>
        `
      : ""}

    <!-- 時系列推移チャート -->
    ${trendChartData.length > 1
      ? html`
          <p class="section-title">推移チャート（ベースライン）</p>
          <div class="card" style="padding:16px">
            <div id="trend-chart"></div>
          </div>
        `
      : ""}

    <!-- 履歴テーブル（ベースラインのみ） -->
    <p class="section-title">バックテスト履歴（ベースライン）</p>
    ${trendData.length > 0
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
                ${[...trendData].reverse().map(
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

    <!-- モンテカルロシミュレーション -->
    <p class="section-title">モンテカルロシミュレーション（破産確率）</p>
    <div class="card" style="padding:16px">
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:8px;margin-bottom:12px">
        <label style="font-size:12px;color:${COLORS.textDim}">
          条件
          <select id="mc-condition" style="width:100%;margin-top:4px;padding:6px;background:${COLORS.bg};color:${COLORS.text};border:1px solid ${COLORS.border};border-radius:6px">
            ${conditionKeys.map(
              (k) =>
                html`<option value="${k.conditionKey}" ${k.conditionKey === "baseline" ? "selected" : ""}>
                  ${k.conditionLabel}
                </option>`,
            )}
          </select>
        </label>
        <label style="font-size:12px;color:${COLORS.textDim}">
          初期資金
          <input id="mc-budget" type="number" value="300000" min="100000" max="10000000" step="100000"
            style="width:100%;margin-top:4px;padding:6px;background:${COLORS.bg};color:${COLORS.text};border:1px solid ${COLORS.border};border-radius:6px" />
        </label>
        <label style="font-size:12px;color:${COLORS.textDim}">
          パス数
          <input id="mc-paths" type="number" value="10000" min="1000" max="100000" step="1000"
            style="width:100%;margin-top:4px;padding:6px;background:${COLORS.bg};color:${COLORS.text};border:1px solid ${COLORS.border};border-radius:6px" />
        </label>
        <label style="font-size:12px;color:${COLORS.textDim}">
          トレード数
          <input id="mc-trades" type="number" value="1000" min="100" max="5000" step="100"
            style="width:100%;margin-top:4px;padding:6px;background:${COLORS.bg};color:${COLORS.text};border:1px solid ${COLORS.border};border-radius:6px" />
        </label>
        <label style="font-size:12px;color:${COLORS.textDim}">
          破産閾値(%)
          <input id="mc-ruin" type="number" value="50" min="10" max="90" step="5"
            style="width:100%;margin-top:4px;padding:6px;background:${COLORS.bg};color:${COLORS.text};border:1px solid ${COLORS.border};border-radius:6px" />
        </label>
        <label style="font-size:12px;color:${COLORS.textDim}">
          リスク率(%)
          <input id="mc-risk" type="number" value="2" min="0.5" max="5" step="0.5"
            style="width:100%;margin-top:4px;padding:6px;background:${COLORS.bg};color:${COLORS.text};border:1px solid ${COLORS.border};border-radius:6px" />
        </label>
      </div>
      <button id="mc-run" onclick="runMonteCarlo()"
        style="padding:8px 20px;background:${COLORS.accent};color:#fff;border:none;border-radius:6px;cursor:pointer;font-size:14px">
        シミュレーション実行
      </button>

      <!-- 結果エリア（初期は非表示） -->
      <div id="mc-results" style="display:none;margin-top:16px">
        <!-- サマリカード -->
        <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:12px;margin-bottom:16px">
          <div style="text-align:center;padding:12px;background:${COLORS.bg};border-radius:8px;border:1px solid ${COLORS.border}">
            <div style="font-size:11px;color:${COLORS.textDim}">破産確率</div>
            <div id="mc-ruin-prob" style="font-size:24px;font-weight:700;margin-top:4px">-</div>
          </div>
          <div style="text-align:center;padding:12px;background:${COLORS.bg};border-radius:8px;border:1px solid ${COLORS.border}">
            <div style="font-size:11px;color:${COLORS.textDim}">最大DD(95%)</div>
            <div id="mc-max-dd" style="font-size:24px;font-weight:700;margin-top:4px;color:${COLORS.loss}">-</div>
          </div>
          <div style="text-align:center;padding:12px;background:${COLORS.bg};border-radius:8px;border:1px solid ${COLORS.border}">
            <div style="font-size:11px;color:${COLORS.textDim}">最終資産中央値</div>
            <div id="mc-final-eq" style="font-size:24px;font-weight:700;margin-top:4px">-</div>
          </div>
        </div>

        <!-- DD到達率テーブル -->
        <div class="table-wrap" style="margin-bottom:16px">
          <table>
            <thead><tr><th>ドローダウン</th><th>到達確率</th></tr></thead>
            <tbody id="mc-dd-table"></tbody>
          </table>
        </div>

        <!-- ファンチャート -->
        <div id="mc-chart" style="margin-bottom:16px"></div>

        <!-- 入力データ -->
        <div id="mc-input-stats" style="font-size:12px;color:${COLORS.textDim}"></div>
      </div>

      <!-- ローディング -->
      <div id="mc-loading" style="display:none;text-align:center;padding:24px;color:${COLORS.textDim}">
        シミュレーション実行中...
      </div>

      <!-- エラー -->
      <div id="mc-error" style="display:none;padding:12px;color:${COLORS.loss};background:rgba(239,68,68,0.1);border-radius:8px;margin-top:12px"></div>
    </div>

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
          + '<div class="modal-row"><span class="modal-row-label">期待値</span><span style="color:' + (d.expectancy == null ? 'inherit' : d.expectancy >= 1.0 ? '#22c55e' : d.expectancy >= 0.5 ? '#3b82f6' : d.expectancy >= 0 ? '#f59e0b' : '#ef4444') + '">' + (d.expectancy != null ? (d.expectancy > 0 ? '+' : '') + d.expectancy.toFixed(2) + '%' : 'N/A') + '</span></div>'
          + '<div class="modal-row"><span class="modal-row-label">RR比</span><span style="color:' + (d.riskRewardRatio >= 1.5 ? '#22c55e' : d.riskRewardRatio >= 1.0 ? '#f59e0b' : '#ef4444') + '">' + (d.riskRewardRatio != null ? d.riskRewardRatio.toFixed(2) : 'N/A') + '</span></div>'
          + '<div class="modal-row"><span class="modal-row-label">平均利益</span><span style="color:#22c55e">' + (d.avgWinPct != null ? '+' + d.avgWinPct.toFixed(2) + '%' : 'N/A') + '</span></div>'
          + '<div class="modal-row"><span class="modal-row-label">平均損失</span><span style="color:#ef4444">' + (d.avgLossPct != null ? d.avgLossPct.toFixed(2) + '%' : 'N/A') + '</span></div>'
          + '<div class="modal-row"><span class="modal-row-label">最大DD</span><span style="color:#ef4444">-' + d.maxDrawdown + '%</span></div>'
          + '<div class="modal-row"><span class="modal-row-label">取引数</span><span>' + d.totalTrades + '</span></div>'
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

      // --- モンテカルロシミュレーション ---
      async function runMonteCarlo() {
        var results = document.getElementById('mc-results');
        var loading = document.getElementById('mc-loading');
        var errorEl = document.getElementById('mc-error');
        var btn = document.getElementById('mc-run');

        results.style.display = 'none';
        errorEl.style.display = 'none';
        loading.style.display = 'block';
        btn.disabled = true;

        try {
          var resp = await fetch('/backtest/api/monte-carlo', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              conditionKey: document.getElementById('mc-condition').value,
              initialBudget: Number(document.getElementById('mc-budget').value),
              numPaths: Number(document.getElementById('mc-paths').value),
              tradesPerPath: Number(document.getElementById('mc-trades').value),
              ruinThreshold: Number(document.getElementById('mc-ruin').value),
              riskPerTrade: Number(document.getElementById('mc-risk').value),
            }),
          });

          var data = await resp.json();

          if (!resp.ok) {
            errorEl.textContent = data.error || 'エラーが発生しました';
            errorEl.style.display = 'block';
            return;
          }

          // サマリ更新
          var ruinPct = (data.ruinProbability * 100).toFixed(1);
          var ruinEl = document.getElementById('mc-ruin-prob');
          ruinEl.textContent = ruinPct + '%';
          if (data.ruinProbability < 0.01) {
            ruinEl.style.color = '#22c55e';
          } else if (data.ruinProbability < 0.05) {
            ruinEl.style.color = '#3b82f6';
          } else if (data.ruinProbability < 0.10) {
            ruinEl.style.color = '#f59e0b';
          } else {
            ruinEl.style.color = '#ef4444';
          }

          document.getElementById('mc-max-dd').textContent = '-' + data.maxDrawdownPercentiles.p95 + '%';

          var finalEq = data.finalEquityPercentiles.p50;
          var budget = Number(document.getElementById('mc-budget').value);
          var fEl = document.getElementById('mc-final-eq');
          fEl.textContent = '¥' + finalEq.toLocaleString('ja-JP');
          fEl.style.color = finalEq >= budget ? '#22c55e' : '#ef4444';

          // DD到達率テーブル
          var tbody = document.getElementById('mc-dd-table');
          tbody.innerHTML = [
            ['10%', data.thresholdBreachRates.dd10],
            ['20%', data.thresholdBreachRates.dd20],
            ['30%', data.thresholdBreachRates.dd30],
            ['50%' + (Number(document.getElementById('mc-ruin').value) === 50 ? ' (=破産)' : ''), data.thresholdBreachRates.dd50],
          ].map(function(row) {
            return '<tr><td>' + row[0] + '</td><td>' + (row[1] * 100).toFixed(1) + '%</td></tr>';
          }).join('');

          // ファンチャート描画
          drawFanChart(data, budget);

          // 入力データ
          var s = data.inputStats;
          document.getElementById('mc-input-stats').textContent =
            '入力: 勝率' + s.winRate + '% / 平均利益+' + s.avgWinPct.toFixed(2) + '% / 平均損失' + s.avgLossPct.toFixed(2) + '% / サンプル' + s.totalTrades + 'トレード / 期待値' + s.expectancy.toFixed(2) + '%';

          results.style.display = 'block';
        } catch (e) {
          errorEl.textContent = 'ネットワークエラーが発生しました';
          errorEl.style.display = 'block';
        } finally {
          loading.style.display = 'none';
          btn.disabled = false;
        }
      }

      function drawFanChart(data, budget) {
        var container = document.getElementById('mc-chart');
        var W = 640, H = 280;
        var pad = { top: 20, right: 20, bottom: 30, left: 60 };
        var cw = W - pad.left - pad.right;
        var ch = H - pad.top - pad.bottom;

        var curves = data.equityCurves;
        var len = curves.p50.length;

        // Y軸範囲
        var allVals = curves.p5.concat(curves.p95);
        var minY = Math.min.apply(null, allVals.concat([0]));
        var maxY = Math.max.apply(null, allVals);
        var rangeY = maxY - minY || 1;

        function x(i) { return pad.left + (i / (len - 1)) * cw; }
        function y(v) { return pad.top + ch - ((v - minY) / rangeY) * ch; }

        // SVGパスを生成
        function pathD(arr) {
          return arr.map(function(v, i) {
            return (i === 0 ? 'M' : 'L') + x(i).toFixed(1) + ',' + y(v).toFixed(1);
          }).join(' ');
        }

        // 帯（area）を生成
        function areaD(upper, lower) {
          var fwd = upper.map(function(v, i) { return x(i).toFixed(1) + ',' + y(v).toFixed(1); });
          var rev = lower.slice().reverse().map(function(v, i) {
            var idx = lower.length - 1 - i;
            return x(idx).toFixed(1) + ',' + y(v).toFixed(1);
          });
          return 'M' + fwd.join(' L') + ' L' + rev.join(' L') + ' Z';
        }

        var ruinLevel = budget * (1 - Number(document.getElementById('mc-ruin').value) / 100);

        var svg = '<svg viewBox="0 0 ' + W + ' ' + H + '" style="width:100%;max-width:' + W + 'px">'
          // p5-p95 帯
          + '<path d="' + areaD(curves.p95, curves.p5) + '" fill="#3b82f6" fill-opacity="0.12" />'
          // p25-p75 帯
          + '<path d="' + areaD(curves.p75, curves.p25) + '" fill="#3b82f6" fill-opacity="0.25" />'
          // p50 中央線
          + '<path d="' + pathD(curves.p50) + '" fill="none" stroke="#3b82f6" stroke-width="2" />'
          // 破産ライン
          + '<line x1="' + pad.left + '" y1="' + y(ruinLevel).toFixed(1) + '" x2="' + (W - pad.right) + '" y2="' + y(ruinLevel).toFixed(1) + '" stroke="#ef4444" stroke-dasharray="6,4" stroke-width="1" />'
          + '<text x="' + (W - pad.right - 4) + '" y="' + (y(ruinLevel) - 4).toFixed(1) + '" text-anchor="end" fill="#ef4444" font-size="9">破産ライン</text>'
          // 初期資金ライン
          + '<line x1="' + pad.left + '" y1="' + y(budget).toFixed(1) + '" x2="' + (W - pad.right) + '" y2="' + y(budget).toFixed(1) + '" stroke="#334155" stroke-dasharray="4" stroke-width="1" />'
          // Y軸ラベル
          + '<text x="' + (pad.left - 4) + '" y="' + (pad.top + 4) + '" text-anchor="end" fill="#64748b" font-size="9">¥' + maxY.toLocaleString('ja-JP') + '</text>'
          + '<text x="' + (pad.left - 4) + '" y="' + (pad.top + ch + 4) + '" text-anchor="end" fill="#64748b" font-size="9">¥' + Math.max(0, minY).toLocaleString('ja-JP') + '</text>'
          // X軸ラベル
          + '<text x="' + pad.left + '" y="' + (H - 4) + '" text-anchor="start" fill="#64748b" font-size="9">0</text>'
          + '<text x="' + (W - pad.right) + '" y="' + (H - 4) + '" text-anchor="end" fill="#64748b" font-size="9">' + (len - 1) + ' trades</text>'
          + '</svg>';

        container.innerHTML = svg;
      }

      // --- 条件比較チャート ---
      (function() {
        var el = document.getElementById('comparison-chart');
        if (!el) return;
        var data = ${raw(JSON.stringify(comparisonData))};
        if (data.length < 2) return;

        var metrics = [
          { key: 'expectancy', label: '期待値(%)', target: 0, targetLabel: '0%', fmt: function(v) { return (v > 0 ? '+' : '') + v.toFixed(2); } },
          { key: 'profitFactor', label: 'PF', target: 1.3, targetLabel: '1.3', fmt: function(v) { return v.toFixed(2); } },
          { key: 'riskRewardRatio', label: 'RR比', target: 1.5, targetLabel: '1.5', fmt: function(v) { return v.toFixed(2); } },
        ];

        var barH = 20, gap = 4, labelW = 80, valueW = 50, chartW = 300;
        var svgs = '';

        metrics.forEach(function(m) {
          var vals = data.map(function(d) { return d[m.key]; }).filter(function(v) { return v != null; });
          if (vals.length === 0) return;
          var minV = Math.min.apply(null, vals.concat([m.target]));
          var maxV = Math.max.apply(null, vals.concat([m.target]));
          var range = maxV - minV || 1;
          var pad = range * 0.1;
          minV -= pad; maxV += pad; range = maxV - minV;

          var totalW = labelW + chartW + valueW;
          var totalH = data.length * (barH + gap) + 30;

          var s = '<div style="margin-bottom:16px"><div style="font-size:13px;font-weight:600;margin-bottom:8px;color:${COLORS.text}">' + m.label + '</div>';
          s += '<svg viewBox="0 0 ' + totalW + ' ' + totalH + '" style="width:100%;max-width:' + totalW + 'px">';

          // 目標ライン
          var targetX = labelW + ((m.target - minV) / range) * chartW;
          s += '<line x1="' + targetX.toFixed(1) + '" y1="0" x2="' + targetX.toFixed(1) + '" y2="' + (totalH - 20) + '" stroke="#64748b" stroke-dasharray="4" stroke-width="1" />';
          s += '<text x="' + targetX.toFixed(1) + '" y="' + (totalH - 6) + '" text-anchor="middle" fill="#64748b" font-size="9">' + m.targetLabel + '</text>';

          data.forEach(function(d, i) {
            var v = d[m.key];
            var y = i * (barH + gap);
            var isBaseline = d.key === 'baseline';

            // ラベル
            s += '<text x="' + (labelW - 4) + '" y="' + (y + barH / 2 + 4) + '" text-anchor="end" fill="' + (isBaseline ? '${COLORS.text}' : '${COLORS.textDim}') + '" font-size="' + (isBaseline ? '11' : '10') + '" font-weight="' + (isBaseline ? '700' : '400') + '">' + d.label + '</text>';

            if (v == null) {
              s += '<text x="' + (labelW + 4) + '" y="' + (y + barH / 2 + 4) + '" fill="${COLORS.textDim}" font-size="10">N/A</text>';
              return;
            }

            // バー
            var zeroX = labelW + ((0 - minV) / range) * chartW;
            var barX = labelW + ((v - minV) / range) * chartW;
            var color;
            if (m.key === 'expectancy') {
              color = v >= 1.0 ? '#22c55e' : v >= 0.5 ? '#3b82f6' : v >= 0 ? '#f59e0b' : '#ef4444';
            } else if (m.key === 'riskRewardRatio') {
              color = v >= 1.5 ? '#22c55e' : v >= 1.0 ? '#f59e0b' : '#ef4444';
            } else {
              color = v >= 1.3 ? '#22c55e' : v >= 1.0 ? '#f59e0b' : '#ef4444';
            }

            if (m.key === 'expectancy') {
              var x0 = Math.min(zeroX, barX);
              var w = Math.abs(barX - zeroX);
              s += '<rect x="' + x0.toFixed(1) + '" y="' + y + '" width="' + Math.max(w, 1).toFixed(1) + '" height="' + barH + '" rx="3" fill="' + color + '" fill-opacity="0.7" />';
            } else {
              s += '<rect x="' + labelW + '" y="' + y + '" width="' + Math.max(barX - labelW, 1).toFixed(1) + '" height="' + barH + '" rx="3" fill="' + color + '" fill-opacity="0.7" />';
            }

            // 値ラベル
            s += '<text x="' + (labelW + chartW + 4) + '" y="' + (y + barH / 2 + 4) + '" fill="' + color + '" font-size="10" font-weight="600">' + m.fmt(v) + '</text>';
          });

          s += '</svg></div>';
          svgs += s;
        });

        el.innerHTML = svgs;
      })();

      // --- 時系列推移チャート ---
      (function() {
        var el = document.getElementById('trend-chart');
        if (!el) return;
        var data = ${raw(JSON.stringify(trendChartData))};
        if (data.length < 2) return;

        var W = 640, H = 240;
        var pad = { top: 20, right: 55, bottom: 30, left: 50 };
        var cw = W - pad.left - pad.right;
        var ch = H - pad.top - pad.bottom;
        var len = data.length;

        // 期待値の範囲
        var expVals = data.map(function(d) { return d.expectancy; }).filter(function(v) { return v != null; });
        var pfVals = data.map(function(d) { return d.profitFactor; }).filter(function(v) { return v != null; });

        if (expVals.length < 2 && pfVals.length < 2) return;

        var expMin = Math.min.apply(null, expVals.concat([0]));
        var expMax = Math.max.apply(null, expVals.concat([0]));
        var expRange = expMax - expMin || 1;
        expMin -= expRange * 0.1; expMax += expRange * 0.1; expRange = expMax - expMin;

        var pfMin = Math.min.apply(null, pfVals.concat([1.0]));
        var pfMax = Math.max.apply(null, pfVals.concat([1.3]));
        var pfRange = pfMax - pfMin || 1;
        pfMin -= pfRange * 0.1; pfMax += pfRange * 0.1; pfRange = pfMax - pfMin;

        function xPos(i) { return pad.left + (i / (len - 1)) * cw; }
        function yExp(v) { return pad.top + ch - ((v - expMin) / expRange) * ch; }
        function yPf(v) { return pad.top + ch - ((v - pfMin) / pfRange) * ch; }

        // パス生成
        function buildPath(arr, yFn) {
          var pts = [];
          arr.forEach(function(d, i) {
            var v = yFn === yExp ? d.expectancy : d.profitFactor;
            if (v != null) pts.push((pts.length === 0 ? 'M' : 'L') + xPos(i).toFixed(1) + ',' + yFn(v).toFixed(1));
          });
          return pts.join(' ');
        }

        var svg = '<svg viewBox="0 0 ' + W + ' ' + H + '" style="width:100%;max-width:' + W + 'px">';

        // 期待値0ライン
        var zeroY = yExp(0);
        svg += '<line x1="' + pad.left + '" y1="' + zeroY.toFixed(1) + '" x2="' + (W - pad.right) + '" y2="' + zeroY.toFixed(1) + '" stroke="#64748b" stroke-dasharray="4" stroke-width="1" />';
        svg += '<text x="' + (pad.left - 4) + '" y="' + (zeroY + 3).toFixed(1) + '" text-anchor="end" fill="#64748b" font-size="9">0%</text>';

        // PF 1.3目標ライン
        var pf13Y = yPf(1.3);
        svg += '<line x1="' + pad.left + '" y1="' + pf13Y.toFixed(1) + '" x2="' + (W - pad.right) + '" y2="' + pf13Y.toFixed(1) + '" stroke="#f59e0b" stroke-dasharray="4" stroke-width="1" stroke-opacity="0.5" />';
        svg += '<text x="' + (W - pad.right + 4) + '" y="' + (pf13Y + 3).toFixed(1) + '" text-anchor="start" fill="#f59e0b" font-size="9">PF1.3</text>';

        // 期待値ライン（青）
        if (expVals.length >= 2) {
          svg += '<path d="' + buildPath(data, yExp) + '" fill="none" stroke="#3b82f6" stroke-width="2" />';
        }

        // PFライン（緑）
        if (pfVals.length >= 2) {
          svg += '<path d="' + buildPath(data, yPf) + '" fill="none" stroke="#22c55e" stroke-width="2" />';
        }

        // Y軸ラベル（左: 期待値）
        svg += '<text x="' + (pad.left - 4) + '" y="' + (pad.top + 4) + '" text-anchor="end" fill="#3b82f6" font-size="9">' + expMax.toFixed(1) + '%</text>';
        svg += '<text x="' + (pad.left - 4) + '" y="' + (pad.top + ch + 4) + '" text-anchor="end" fill="#3b82f6" font-size="9">' + expMin.toFixed(1) + '%</text>';

        // Y軸ラベル（右: PF）
        svg += '<text x="' + (W - pad.right + 4) + '" y="' + (pad.top + 4) + '" text-anchor="start" fill="#22c55e" font-size="9">' + pfMax.toFixed(2) + '</text>';
        svg += '<text x="' + (W - pad.right + 4) + '" y="' + (pad.top + ch + 4) + '" text-anchor="start" fill="#22c55e" font-size="9">' + pfMin.toFixed(2) + '</text>';

        // X軸ラベル
        svg += '<text x="' + pad.left + '" y="' + (H - 4) + '" text-anchor="start" fill="#64748b" font-size="9">' + data[0].date + '</text>';
        svg += '<text x="' + (W - pad.right) + '" y="' + (H - 4) + '" text-anchor="end" fill="#64748b" font-size="9">' + data[len - 1].date + '</text>';

        // 凡例
        svg += '<rect x="' + (pad.left + 10) + '" y="6" width="10" height="3" rx="1" fill="#3b82f6" />';
        svg += '<text x="' + (pad.left + 24) + '" y="10" fill="#3b82f6" font-size="9">期待値</text>';
        svg += '<rect x="' + (pad.left + 60) + '" y="6" width="10" height="3" rx="1" fill="#22c55e" />';
        svg += '<text x="' + (pad.left + 74) + '" y="10" fill="#22c55e" font-size="9">PF</text>';

        svg += '</svg>';
        el.innerHTML = svg;
      })();

      document.addEventListener('keydown', function(e) {
        if (e.key === 'Escape' && document.querySelector('#backtest-detail-modal .modal-overlay')) {
          closeBacktestDetail();
        }
      });
    </script>
  `;

  return c.html(layout("バックテスト", "/backtest", content));
});

app.post("/api/monte-carlo", async (c) => {
  const body = await c.req.json<{
    conditionKey?: string;
    initialBudget?: number;
    numPaths?: number;
    tradesPerPath?: number;
    ruinThreshold?: number;
    riskPerTrade?: number;
  }>();

  const conditionKey = body.conditionKey ?? "baseline";
  const initialBudget = Math.min(
    Math.max(body.initialBudget ?? 300000, 100000),
    10_000_000,
  );
  const numPaths = Math.min(Math.max(body.numPaths ?? 10000, 1000), 100000);
  const tradesPerPath = Math.min(
    Math.max(body.tradesPerPath ?? 1000, 100),
    5000,
  );
  const ruinThreshold = Math.min(
    Math.max(body.ruinThreshold ?? 50, 10),
    90,
  );
  const riskPerTrade = Math.min(
    Math.max(body.riskPerTrade ?? 2, 0.5),
    5,
  );

  // パラメータ上限チェック
  if (numPaths * tradesPerPath >= 500_000_000) {
    return c.json(
      { error: "パラメータが大きすぎます。パス数またはトレード数を減らしてください" },
      400,
    );
  }

  // 最新のバックテスト結果を取得
  const latest = await prisma.backtestDailyResult.findFirst({
    where: { conditionKey },
    orderBy: { date: "desc" },
    select: { fullResult: true },
  });

  if (!latest) {
    return c.json(
      { error: "指定された条件キーが見つかりません" },
      400,
    );
  }

  const fullResult = latest.fullResult as Record<string, unknown> | null;
  const tradeReturns = fullResult?.tradeReturns as number[] | undefined;

  if (!tradeReturns || !Array.isArray(tradeReturns)) {
    return c.json(
      { error: "トレードデータがありません。バックテストを再実行してください" },
      400,
    );
  }

  if (tradeReturns.length < 30) {
    return c.json(
      { error: "統計的に有意なシミュレーションには最低30トレードが必要です" },
      400,
    );
  }

  // avgStopLossPct = abs(avgLossPct)
  const avgLossPct = (fullResult?.avgLossPct as number) ?? 0;
  const avgStopLossPct = Math.abs(avgLossPct) || 3; // フォールバック 3%

  const config: MonteCarloConfig = {
    tradeReturns,
    initialBudget,
    numPaths,
    tradesPerPath,
    ruinThresholdPct: ruinThreshold,
    riskPerTradePct: riskPerTrade,
    avgStopLossPct,
  };

  const result = runMonteCarloSimulation(config);
  return c.json(result);
});

export default app;
