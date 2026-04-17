/**
 * ウォッチリストページ（GET /watchlist）
 *
 * GU/PSCエントリー候補を表示。
 * 戦略判定はポーリング API から取得。
 */

import dayjs from "dayjs";
import timezone from "dayjs/plugin/timezone.js";
import utc from "dayjs/plugin/utc.js";
import { Hono } from "hono";
import { html, raw } from "hono/html";
import { prisma } from "../../lib/prisma";
import { TIMEZONE } from "../../lib/constants";
import { GAPUP } from "../../lib/constants/gapup";
import { layout } from "../views/layout";
import { tickerLink, tt } from "../views/components";
import { getAllWatchlist } from "../../jobs/watchlist-builder";
import { getTodayForDB } from "../../lib/market-date";

dayjs.extend(utc);
dayjs.extend(timezone);

const app = new Hono();

type WatchlistStatus = "ordered" | "holding" | "watching";

function statusBadgeHtml(status: WatchlistStatus, orderStrategy?: string) {
  switch (status) {
    case "ordered": {
      const label = orderStrategy ? `注文済(${orderStrategy.toUpperCase()})` : "注文済";
      return raw(`<span class="badge badge-triggered">${label}</span>`);
    }
    case "holding":
      return raw(`<span class="badge badge-holding">保有中</span>`);
    case "watching":
      return raw(`<span class="badge badge-cold">監視中</span>`);
  }
}

/** グローバル条件: 時間帯チェック */
function isInEntryTimeWindow(): boolean {
  const now = dayjs().tz(TIMEZONE);
  const [eh, em] = [9, 5]; // 市場エントリー開始 09:05
  const [lh, lm] = [15, 25]; // 市場エントリー終了 15:25
  const current = now.hour() * 60 + now.minute();
  return current >= eh * 60 + em && current <= lh * 60 + lm;
}

app.get("/", async (c) => {
  const watchlist = await getAllWatchlist();

  // 保有・注文・市場評価を並列取得
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const [holdings, todayOrders, todayAssessment] = await Promise.all([
    prisma.tradingPosition.findMany({
      where: { status: "open" },
      select: { stock: { select: { tickerCode: true } } },
    }),
    prisma.tradingOrder.findMany({
      where: { side: "buy", createdAt: { gte: todayStart } },
      select: { stock: { select: { tickerCode: true } }, strategy: true },
    }),
    prisma.marketAssessment.findUnique({
      where: { date: getTodayForDB() },
      select: { shouldTrade: true },
    }),
  ]);

  const holdingTickers = new Set(holdings.map((h) => h.stock.tickerCode));
  const orderedMap = new Map<string, string>();
  for (const o of todayOrders) {
    orderedMap.set(o.stock.tickerCode, o.strategy ?? "");
  }

  // ステータス付きウォッチリストを作成しソート
  const watchlistWithStatus = watchlist.map((w) => {
    let status: WatchlistStatus = "watching";
    let orderStrategy: string | undefined;
    if (holdingTickers.has(w.ticker)) {
      status = "holding";
    } else if (orderedMap.has(w.ticker)) {
      status = "ordered";
      orderStrategy = orderedMap.get(w.ticker);
    }
    return { ...w, status, orderStrategy };
  });
  // 注文済 → 保有中 → 監視中
  const statusOrder = { ordered: 0, holding: 1, watching: 2 };
  watchlistWithStatus.sort((a, b) => statusOrder[a.status] - statusOrder[b.status]);

  const tickers = watchlist.map((w) => w.ticker);
  const stocks = tickers.length
    ? await prisma.stock.findMany({
        where: { tickerCode: { in: tickers } },
        select: { tickerCode: true, name: true },
      })
    : [];
  const nameMap = new Map(stocks.map((s) => [s.tickerCode, s.name]));

  // サマリー統計
  const orderedCount = watchlistWithStatus.filter((w) => w.status === "ordered").length;
  const holdingCount = watchlistWithStatus.filter((w) => w.status === "holding").length;
  const watchingCount = watchlistWithStatus.filter((w) => w.status === "watching").length;

  // グローバル条件
  const inTimeWindow = isInEntryTimeWindow();
  const shouldTrade = todayAssessment?.shouldTrade ?? false;

  const content = html`
    <p class="section-title">今日のエントリー候補</p>
    <div class="card" style="padding: 8px 12px; margin-bottom: 8px; font-size: 12px;">
      <div style="display: flex; gap: 8px; flex-wrap: wrap; margin-bottom: 6px; align-items: center;">
        <span style="color: #e2e8f0; font-size: 11px; font-weight: 600;">すべて: ${watchlist.length}</span>
        <span data-summary-ordered class="badge badge-triggered" style="opacity: ${orderedCount ? 0.7 : 0.3};">注文済: ${orderedCount}</span>
        <span data-summary-holding class="badge badge-holding" style="opacity: ${holdingCount ? 0.7 : 0.3};">保有中: ${holdingCount}</span>
        <span data-summary-watching class="badge badge-cold" style="opacity: ${watchingCount ? 0.7 : 0.3};">監視中: ${watchingCount}</span>
        <span style="margin-left: auto;"></span>
        <span data-summary-gu class="badge badge-gapup" style="opacity: 0.3;">GU: -</span>
        <span data-summary-psc class="badge badge-psc" style="opacity: 0.3;">PSC: -</span>
      </div>
      <div style="display: flex; gap: 12px; flex-wrap: wrap; color: #94a3b8; font-size: 11px; border-top: 1px solid #334155; padding-top: 6px;">
        <span>${raw(`${tt("時間帯", "09:05〜15:25")}: <span data-global-time style="color: ${inTimeWindow ? "#22c55e" : "#ef4444"};">${inTimeWindow ? "○" : "×"}</span>`)}</span>
        <span>${raw(`${tt("市場評価", "MarketAssessment.shouldTrade")}: <span data-global-market style="color: ${shouldTrade ? "#22c55e" : "#ef4444"};">${shouldTrade ? "取引可" : "見送り"}</span>`)}</span>
      </div>
    </div>
    <div style="display: flex; gap: 4px; margin-bottom: 8px;">
      <button id="tab-gu" onclick="switchTab('gu')" style="padding: 5px 14px; font-size: 12px; border-radius: 6px; border: 1px solid #334155; background: #1e293b; color: #e2e8f0; cursor: pointer;">GU</button>
      <button id="tab-psc" onclick="switchTab('psc')" style="padding: 5px 14px; font-size: 12px; border-radius: 6px; border: 1px solid #334155; background: #1e293b; color: #e2e8f0; cursor: pointer;">PSC</button>
    </div>
    <div id="loading-state" class="card" style="${watchlist.length ? "display:none;" : ""}padding: 16px; text-align: center; color: #94a3b8; font-size: 13px;">
      読み込み中...
    </div>
    <div id="empty-state" class="card" style="display:none; padding: 16px; text-align: center; color: #94a3b8; font-size: 13px;">
      今日のエントリー候補はありません
    </div>
    <div id="candidates-table" class="card table-wrap" style="${watchlist.length ? "" : "display:none;"}">
      <table>
        <thead>
          <tr>
            <th>銘柄</th>
            <th class="col-gu" style="display:none;">${tt("GU条件", "始値Gap≥3% / 終値Gap維持 / 陽線 / 出来高≥1.5x（4x以上でGap1%に緩和）")}</th>
            <th class="col-psc" style="display:none;">${tt("PSC条件", "mom20d≥15% / 高値-5%以内 / 陽線 / 出来高≥1.5x")}</th>
            <th>${tt("現在価格", "リアルタイム価格")}</th>
            <th class="col-gu col-psc" style="display:none;">${tt("始値", "当日始値")}</th>
            <th>${tt("状態", "保有中/注文済/監視中")}</th>
          </tr>
        </thead>
        <tbody>
          ${watchlistWithStatus.map(
            (w) => html`
              <tr data-quote-row data-ticker="${w.ticker}" data-atr14="${w.atr14}">
                <td>${tickerLink(w.ticker, `${w.ticker} ${nameMap.get(w.ticker) ?? w.ticker}`)}</td>
                <td class="col-gu" data-gapup-conditions style="display:none; font-size: 11px; white-space: nowrap;"><span class="quote-loading">...</span></td>
                <td class="col-psc" data-psc-conditions style="display:none; font-size: 11px; white-space: nowrap;"><span class="quote-loading">...</span></td>
                <td data-quote-price><span class="quote-loading">...</span></td>
                <td class="col-gu col-psc" data-open-price style="display:none;"><span class="quote-loading">...</span></td>
                <td data-status-badge>${statusBadgeHtml(w.status, w.orderStrategy)}</td>
              </tr>
            `,
          )}
        </tbody>
      </table>
    </div>
    <script>
      var currentTab = 'gu';
      var currentMarketPhase = 'pre'; // 'pre' | 'intra' | 'post'
      var rowFilterData = {}; // ticker → { isGapOk }

      function applyRowFilter(tab) {
        var allRows = document.querySelectorAll('[data-quote-row]');
        allRows.forEach(function(row) {
          var ticker = row.getAttribute('data-ticker');
          var d = rowFilterData[ticker] || {};
          row.style.display = '';
          if (tab === 'gu' && currentMarketPhase !== 'pre') {
            // GUタブ・場中/場後: gap条件を満たさない行を減衰表示
            row.style.opacity = d.isGapOk ? '1' : '0.3';
          } else if (tab === 'psc') {
            // PSCタブ: mom条件を満たさない行を減衰表示
            row.style.opacity = d.isMomentumOk ? '1' : '0.3';
          } else {
            row.style.opacity = '1';
          }
        });
      }

      function switchTab(tab) {
        currentTab = tab;
        var tabs = ['gu', 'psc'];
        tabs.forEach(function(t) {
          var el = document.getElementById('tab-' + t);
          if (!el) return;
          if (t === tab) {
            el.style.background = '#334155';
            el.style.borderColor = '#64748b';
            el.style.color = '#f1f5f9';
          } else {
            el.style.background = '#1e293b';
            el.style.borderColor = '#334155';
            el.style.color = '#e2e8f0';
          }
        });

        // 列の表示切り替え（同じクラスを持つ要素を一括制御）
        var colGuEls = document.querySelectorAll('.col-gu');
        var colPscEls = document.querySelectorAll('.col-psc');
        colGuEls.forEach(function(el) { el.style.display = tab === 'gu' ? '' : 'none'; });
        colPscEls.forEach(function(el) { el.style.display = tab === 'psc' ? '' : 'none'; });

        applyRowFilter(tab);
      }

      // 初期タブをアクティブ表示
      switchTab('gu');

      (function() {
        var POLL_INTERVAL = 30000;
        var ATR_MULTIPLIER_GU = ${GAPUP.STOP_LOSS.ATR_MULTIPLIER};
        var rows = document.querySelectorAll('[data-quote-row]');

        var fmt = function(v) { return Number(v).toLocaleString('ja-JP', { maximumFractionDigits: 0 }); };

        var STATUS_MAP = {
          ordered: { cls: 'badge-triggered' },
          holding: { label: '保有中', cls: 'badge-holding' },
          watching: { label: '監視中', cls: 'badge-cold' },
          not_target: { label: '対象外', cls: 'badge-cold' }
        };

        if (rows.length === 0) {
          var loadingEl0 = document.getElementById('loading-state');
          if (loadingEl0) loadingEl0.style.display = 'none';
          var emptyEl0 = document.getElementById('empty-state');
          if (emptyEl0) emptyEl0.style.display = '';
          return;
        }

        var tickers = [];
        rows.forEach(function(row) {
          var t = row.getAttribute('data-ticker');
          if (t && tickers.indexOf(t) === -1) tickers.push(t);
        });
        if (tickers.length === 0) return;

        var params = new URLSearchParams(window.location.search);
        var token = params.get('token') || '';
        var url = '/api/watchlist/state?tickers=' + encodeURIComponent(tickers.join(',')) + '&token=' + encodeURIComponent(token);

        var isFirstPoll = true;

        function poll() {
          if (document.hidden) return;
          fetch(url)
            .then(function(r) { return r.json(); })
            .then(function(data) {
              if (!data.tickers) return;
              if (data.global && data.global._error === 'broker_api_failed') {
                var existing = document.getElementById('broker-error-toast');
                if (!existing) {
                  var toast = document.createElement('div');
                  toast.id = 'broker-error-toast';
                  toast.style.cssText = 'position:fixed;bottom:20px;right:20px;background:#ef4444;color:#fff;padding:10px 16px;border-radius:8px;font-size:13px;z-index:9999;box-shadow:0 4px 12px rgba(0,0,0,0.3);';
                  toast.textContent = '⚠ API接続エラー：株価を取得できませんでした';
                  document.body.appendChild(toast);
                  setTimeout(function() { toast.remove(); }, 5000);
                }
              }

              var guCount = 0, pscCount = 0;
              var orderedCount = 0, holdingCount = 0, watchingCount = 0;
              var rowSortData = {};

              rows.forEach(function(row) {
                var ticker = row.getAttribute('data-ticker');
                var d = data.tickers[ticker];
                if (!d) return;

                // ---- ステータス別カウント ----
                if (d.status === 'ordered') orderedCount++;
                else if (d.status === 'holding') holdingCount++;
                else watchingCount++;

                // ソート用データを収集
                var guAllMet = d.gapup && d.gapup.isGapOk && d.gapup.isCloseGapOk && d.gapup.isCandleOk && d.gapup.isVolumeOk;
                var isEntryCandidate = guAllMet ? 1 : 0;

                // GU条件達成数（0〜4）
                var guConditionsMet = 0;
                if (d.gapup) {
                  if (d.gapup.isGapOk) guConditionsMet++;
                  if (d.gapup.isCloseGapOk) guConditionsMet++;
                  if (d.gapup.isCandleOk) guConditionsMet++;
                  if (d.gapup.isVolumeOk) guConditionsMet++;
                }

                // PSC条件達成数（0〜4）
                var pscConditionsMet = 0;
                var pscAllMetFlag = false;
                if (d.psc) {
                  if (d.psc.isMomentum20dOk) pscConditionsMet++;
                  if (d.psc.isHighDistanceOk) pscConditionsMet++;
                  if (d.psc.isCandleOk) pscConditionsMet++;
                  if (d.psc.isVolumeOk) pscConditionsMet++;
                  pscAllMetFlag = pscConditionsMet === 4;
                }

                rowSortData[ticker] = {
                  isEntryCandidate: isEntryCandidate,
                  guAllMet: guAllMet ? 1 : 0,
                  guConditionsMet: guConditionsMet,
                  gapPct: d.gapup ? d.gapup.gapPct : -999,
                  pscAllMet: pscAllMetFlag ? 1 : 0,
                  pscConditionsMet: pscConditionsMet,
                  momentum20d: d.psc ? d.psc.momentum20d : -999,
                  surgeRatio: d.surgeRatio || 0,
                  status: d.status || 'watching'
                };

                // フィルター用データを収集
                rowFilterData[ticker] = {
                  isGapOk: !!(d.gapup && d.gapup.isGapOk),
                  guAllMet: !!(guAllMet),
                  isMomentumOk: !!(d.psc && d.psc.isMomentum20dOk),
                  pscAllMet: pscAllMetFlag
                };

                // ---- ステータスバッジ ----
                var badgeEl = row.querySelector('[data-status-badge]');
                if (badgeEl) {
                  var resolvedStatus = d.status;
                  if (d.status !== 'ordered' && d.status !== 'holding') {
                    resolvedStatus = guAllMet ? 'watching' : 'not_target';
                  }
                  var s = STATUS_MAP[resolvedStatus];
                  if (s) {
                    var label = s.label;
                    if (resolvedStatus === 'ordered') {
                      label = d.orderStrategy ? '注文済(' + d.orderStrategy.toUpperCase() + ')' : '注文済';
                    }
                    badgeEl.innerHTML = '<span class="badge ' + s.cls + '">' + label + '</span>';
                  }
                }

                var strats = d.strategies || [];
                if (strats.indexOf('GU') !== -1) guCount++;
                if (strats.indexOf('PSC') !== -1) pscCount++;

                // ---- GU条件（data-gapup-conditions） ----
                var guEl = row.querySelector('[data-gapup-conditions]');
                if (guEl) {
                  var gu = d.gapup;
                  if (gu) {
                    // 出来高4x以上なら緩和表示
                    var isRelaxed = gu.surgeRatio >= 4.0;
                    var gapThreshold = isRelaxed ? 1 : 3;
                    // 1. 始値ギャップ
                    var gapSign = gu.gapPct >= 0 ? '+' : '';
                    var gapColor = gu.isGapOk ? '#22c55e' : (gu.gapPct >= 1.5 ? '#f59e0b' : '#64748b');
                    // 2. 終値ギャップ維持
                    var closeSign = gu.closePct >= 0 ? '+' : '';
                    var closeColor = gu.isCloseGapOk ? '#22c55e' : '#64748b';
                    // 3. 陽線
                    var candleColor = gu.isCandleOk ? '#22c55e' : '#ef4444';
                    var candleLabel = gu.isCandleOk ? '\u25cb' : '\u00d7';
                    // 4. 出来高サージ
                    var volColor = gu.isVolumeOk ? '#22c55e' : '#64748b';
                    var allMet = gu.isGapOk && gu.isCloseGapOk && gu.isCandleOk && gu.isVolumeOk;
                    guEl.innerHTML =
                      '<span style="color:' + gapColor + ';" title="始値Gap (≥' + gapThreshold + '%' + (isRelaxed ? ' 緩和' : '') + ')">' + gapSign + gu.gapPct.toFixed(1) + '%</span>' +
                      '<span style="color:#475569; margin: 0 2px;">|</span>' +
                      '<span style="color:' + closeColor + ';" title="終値Gap維持 (≥' + gapThreshold + '%)">' + closeSign + gu.closePct.toFixed(1) + '%</span>' +
                      '<span style="color:#475569; margin: 0 2px;">|</span>' +
                      '<span style="color:' + candleColor + ';" title="陽線">' + candleLabel + '</span>' +
                      '<span style="color:#475569; margin: 0 2px;">|</span>' +
                      '<span style="color:' + volColor + ';" title="出来高サージ (≥1.5x' + (isRelaxed ? ', 4x以上で緩和' : '') + ')">' + (d.surgeRatio != null ? d.surgeRatio.toFixed(1) : '-') + 'x</span>' +
                      (allMet ? ' <span style="color:#22c55e; font-weight:600;">\u2714</span>' : '');
                  } else {
                    guEl.innerHTML = '<span style="color: #475569;">-</span>';
                  }
                }

                // ---- PSC条件（data-psc-conditions） ----
                var pscEl = row.querySelector('[data-psc-conditions]');
                if (pscEl) {
                  var psc = d.psc;
                  if (psc) {
                    // 1. 20日モメンタム >= 15%
                    var mom20Sign = psc.momentum20d >= 0 ? '+' : '';
                    var mom20Color = psc.isMomentum20dOk ? '#22c55e' : '#64748b';
                    // 2. 高値圏維持（-5%以内）
                    var highDistSign = psc.highDistancePct >= 0 ? '+' : '';
                    var highDistColor = psc.isHighDistanceOk ? '#22c55e' : '#64748b';
                    // 3. 陽線
                    var pscCandleColor = psc.isCandleOk ? '#22c55e' : '#ef4444';
                    var pscCandleLabel = psc.isCandleOk ? '\u25cb' : '\u00d7';
                    // 4. 出来高サージ
                    var pscVolColor = psc.isVolumeOk ? '#22c55e' : '#64748b';
                    var pscAllMet = psc.isMomentum20dOk && psc.isHighDistanceOk && psc.isCandleOk && psc.isVolumeOk;
                    pscEl.innerHTML =
                      '<span style="color:' + mom20Color + ';" title="20日モメンタム (≥15%)">' + mom20Sign + (psc.momentum20d * 100).toFixed(1) + '%</span>' +
                      '<span style="color:#475569; margin: 0 2px;">|</span>' +
                      '<span style="color:' + highDistColor + ';" title="高値乖離 (≥-5%)">' + highDistSign + (psc.highDistancePct * 100).toFixed(1) + '%</span>' +
                      '<span style="color:#475569; margin: 0 2px;">|</span>' +
                      '<span style="color:' + pscCandleColor + ';" title="陽線">' + pscCandleLabel + '</span>' +
                      '<span style="color:#475569; margin: 0 2px;">|</span>' +
                      '<span style="color:' + pscVolColor + ';" title="出来高サージ (≥1.5x)">' + (d.surgeRatio != null ? d.surgeRatio.toFixed(1) : '-') + 'x</span>' +
                      (pscAllMet ? ' <span style="color:#22c55e; font-weight:600;">\u2714</span>' : '');
                  } else {
                    pscEl.innerHTML = '<span style="color: #475569;">-</span>';
                  }
                }

                // ---- 現在価格（data-quote-price） ----
                if (d.price != null) {
                  var priceEl = row.querySelector('[data-quote-price]');
                  if (priceEl) priceEl.innerHTML = '\u00a5' + fmt(d.price);
                }

                // ---- 始値（data-open-price） ----
                var openEl = row.querySelector('[data-open-price]');
                if (openEl) openEl.innerHTML = d.open != null ? '\u00a5' + fmt(d.open) : '-';
              });

              // ---- 初回ポーリング後: ローディング非表示 ----
              if (isFirstPoll) {
                isFirstPoll = false;
                var loadingEl = document.getElementById('loading-state');
                if (loadingEl) loadingEl.style.display = 'none';
              }

              // ---- テーブル/空状態を切り替え ----
              var tableEl = document.getElementById('candidates-table');
              var emptyEl = document.getElementById('empty-state');
              if (tableEl) tableEl.style.display = rows.length ? '' : 'none';
              if (emptyEl) emptyEl.style.display = rows.length ? 'none' : '';

              // ---- サマリーバッジ更新 ----
              var orderedSummaryEl = document.querySelector('[data-summary-ordered]');
              if (orderedSummaryEl) { orderedSummaryEl.textContent = '注文済: ' + orderedCount; orderedSummaryEl.style.opacity = orderedCount ? '0.7' : '0.3'; }
              var holdingSummaryEl = document.querySelector('[data-summary-holding]');
              if (holdingSummaryEl) { holdingSummaryEl.textContent = '保有中: ' + holdingCount; holdingSummaryEl.style.opacity = holdingCount ? '0.7' : '0.3'; }
              var watchingSummaryEl = document.querySelector('[data-summary-watching]');
              if (watchingSummaryEl) { watchingSummaryEl.textContent = '監視中: ' + watchingCount; watchingSummaryEl.style.opacity = watchingCount ? '0.7' : '0.3'; }
              var guSummaryEl = document.querySelector('[data-summary-gu]');
              if (guSummaryEl) { guSummaryEl.textContent = 'GU: ' + guCount; guSummaryEl.style.opacity = guCount ? '0.7' : '0.3'; }
              var pscSummaryEl = document.querySelector('[data-summary-psc]');
              if (pscSummaryEl) { pscSummaryEl.textContent = 'PSC: ' + pscCount; pscSummaryEl.style.opacity = pscCount ? '0.7' : '0.3'; }

              // ---- グローバル条件更新 ----
              var g = data.global;
              if (g) {
                if (g.marketPhase) currentMarketPhase = g.marketPhase;
                var timeEl = document.querySelector('[data-global-time]');
                if (timeEl) {
                  timeEl.textContent = g.inTimeWindow ? '\u25cb' : '\u00d7';
                  timeEl.style.color = g.inTimeWindow ? '#22c55e' : '#ef4444';
                }
                var marketEl = document.querySelector('[data-global-market]');
                if (marketEl) {
                  marketEl.textContent = g.shouldTrade ? '取引可' : '見送り';
                  marketEl.style.color = g.shouldTrade ? '#22c55e' : '#ef4444';
                }
              }

              // ---- 行ソート ----
              var statusOrder = { ordered: 0, holding: 1, watching: 2 };
              var tbody = document.querySelector('table tbody');
              if (tbody) {
                var rowArr = Array.prototype.slice.call(rows);
                rowArr.sort(function(a, b) {
                  var ta = a.getAttribute('data-ticker');
                  var tb = b.getAttribute('data-ticker');
                  var da = rowSortData[ta] || { isEntryCandidate: 0, guAllMet: 0, guConditionsMet: 0, gapPct: -999, pscAllMet: 0, pscConditionsMet: 0, momentum20d: -999, surgeRatio: 0, status: 'watching' };
                  var db = rowSortData[tb] || { isEntryCandidate: 0, guAllMet: 0, guConditionsMet: 0, gapPct: -999, pscAllMet: 0, pscConditionsMet: 0, momentum20d: -999, surgeRatio: 0, status: 'watching' };

                  // GUタブ: ✔ → 条件達成数 → Gap% → 出来高サージ
                  if (currentTab === 'gu') {
                    // 1. ✔（全条件OK）を最上位
                    var guAllDiff = db.guAllMet - da.guAllMet;
                    if (guAllDiff !== 0) return guAllDiff;
                    // 2. 条件達成数（多い順）
                    var guCondDiff = db.guConditionsMet - da.guConditionsMet;
                    if (guCondDiff !== 0) return guCondDiff;
                    // 3. Gap%（大きい順）
                    var gapDiff = db.gapPct - da.gapPct;
                    if (gapDiff !== 0) return gapDiff;
                    // 4. 出来高サージ（大きい順）
                    return db.surgeRatio - da.surgeRatio;
                  }

                  // PSCタブ: ✔ → 条件達成数 → momentum20d% → 出来高サージ
                  if (currentTab === 'psc') {
                    // 1. ✔（全条件OK）を最上位
                    var pscAllDiff = db.pscAllMet - da.pscAllMet;
                    if (pscAllDiff !== 0) return pscAllDiff;
                    // 2. 条件達成数（多い順）
                    var pscCondDiff = db.pscConditionsMet - da.pscConditionsMet;
                    if (pscCondDiff !== 0) return pscCondDiff;
                    // 3. momentum20d%（大きい順）
                    var momDiff = db.momentum20d - da.momentum20d;
                    if (momDiff !== 0) return momDiff;
                    // 4. 出来高サージ（大きい順）
                    return db.surgeRatio - da.surgeRatio;
                  }

                  // その他: エントリー候補 → ステータス → 出来高サージ
                  var entryDiff = db.isEntryCandidate - da.isEntryCandidate;
                  if (entryDiff !== 0) return entryDiff;
                  // 2. ステータス: 注文済 → 保有中 → 監視中
                  var statusDiff = (statusOrder[da.status] != null ? statusOrder[da.status] : 2) - (statusOrder[db.status] != null ? statusOrder[db.status] : 2);
                  if (statusDiff !== 0) return statusDiff;
                  // 3. サージ比率（出来高が多い順）
                  return db.surgeRatio - da.surgeRatio;
                });
                rowArr.forEach(function(row) { tbody.appendChild(row); });
              }

              // ---- タブ表示状態を再適用（ポーリング後も維持） ----
              switchTab(currentTab);
            })
            .catch(function() { /* エラー時はスキップ */ });
        }

        poll();
        setInterval(poll, POLL_INTERVAL);
      })();
    </script>
  `;

  return c.html(layout("ウォッチリスト", "/watchlist", content));
});

export default app;
