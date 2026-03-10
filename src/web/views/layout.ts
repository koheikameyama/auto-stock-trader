/**
 * HTML レイアウトテンプレート（PWA meta タグ含む）
 */

import { html, raw } from "hono/html";
import type { HtmlEscapedString } from "hono/utils/html";
import { CSS } from "./styles";
import { MARKET_HOURS_CLIENT, REFRESH_INTERVALS } from "../../lib/constants";

type HtmlContent = HtmlEscapedString | Promise<HtmlEscapedString>;

const NAV_ITEMS = [
  {
    path: "/",
    label: "ホーム",
    icon: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 9l9-7 9 7v11a2 2 0 01-2 2H5a2 2 0 01-2-2V9z"/><polyline points="9 22 9 12 15 12 15 22"/></svg>`,
  },
  {
    path: "/positions",
    label: "ポジション",
    icon: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2v20M17 5H9.5a3.5 3.5 0 000 7h5a3.5 3.5 0 010 7H6"/></svg>`,
  },
  {
    path: "/orders",
    label: "注文",
    icon: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M9 9h6M9 13h6M9 17h4"/></svg>`,
  },
  {
    path: "/risk",
    label: "リスク",
    icon: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 9v4M12 17h.01"/><path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/></svg>`,
  },
  {
    path: "/backtest",
    label: "BT",
    icon: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 3v18h18"/><path d="M18 17l-5-5-4 4-3-3"/></svg>`,
  },
  {
    path: "/contrarian",
    label: "見送り",
    icon: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 17l6-6 4 4 8-8"/><path d="M17 7h4v4"/></svg>`,
  },
  {
    path: "/history",
    label: "履歴",
    icon: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg>`,
  },
  {
    path: "/news",
    label: "ニュース",
    icon: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 6h16M4 10h16M4 14h10M4 18h8"/></svg>`,
  },
  {
    path: "/scoring",
    label: "スコア",
    icon: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 20V10"/><path d="M18 20V4"/><path d="M6 20v-4"/></svg>`,
  },
];

export function layout(
  title: string,
  currentPath: string,
  content: HtmlContent,
): HtmlContent {
  return html`<!DOCTYPE html>
    <html lang="ja">
      <head>
        <meta charset="UTF-8" />
        <meta
          name="viewport"
          content="width=device-width, initial-scale=1.0, viewport-fit=cover"
        />
        <title>${title} - Stock Buddy</title>
        <meta name="theme-color" content="#0f172a" />
        <meta name="apple-mobile-web-app-capable" content="yes" />
        <meta
          name="apple-mobile-web-app-status-bar-style"
          content="black-translucent"
        />
        <link rel="manifest" href="/manifest.json" />
        <link rel="icon" type="image/svg+xml" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='90'>📈</text></svg>" />
        <link rel="apple-touch-icon" href="/icon-192.svg" />
        <style>
          ${CSS}
        </style>
      </head>
      <body>
        <header class="header">
          <div style="display:flex;align-items:center;gap:8px">
            <span>📈</span>
            <h1>${title}</h1>
          </div>
          <span class="refresh-info" id="lastUpdate"></span>
        </header>

        <main>${content}</main>

        <!-- Stock detail modal -->
        <div id="stock-modal"></div>

        <nav class="bottom-nav">
          ${NAV_ITEMS.map(
            (item) => html`
              <a
                href="${item.path}"
                class="nav-item ${currentPath === item.path ? "active" : ""}"
              >
                ${raw(item.icon)}
                <span>${item.label}</span>
              </a>
            `,
          )}
        </nav>

        <script>
          // Last update time
          function updateTime() {
            const el = document.getElementById("lastUpdate");
            if (el) el.textContent = new Date().toLocaleTimeString("ja-JP");
          }
          updateTime();

          // Auto refresh
          const isMarketHours = (() => {
            const now = new Date();
            const h = now.getHours();
            const d = now.getDay();
            return d >= ${MARKET_HOURS_CLIENT.START_DAY} && d <= ${MARKET_HOURS_CLIENT.END_DAY} && h >= ${MARKET_HOURS_CLIENT.START_HOUR} && h < ${MARKET_HOURS_CLIENT.END_HOUR};
          })();
          const interval = isMarketHours ? ${REFRESH_INTERVALS.MARKET_HOURS} : ${REFRESH_INTERVALS.OFF_HOURS};
          setTimeout(() => location.reload(), interval);

          // Register SW
          if ("serviceWorker" in navigator) {
            navigator.serviceWorker.register("/sw.js").catch(() => {});
          }

          // Tooltip (position:fixed で overflow クリップ回避)
          (function() {
            var tip = document.createElement('div');
            tip.id = 'tt-popup';
            document.body.appendChild(tip);
            var active = null;

            function show(el) {
              var text = el.getAttribute('data-tooltip');
              if (!text) return;
              tip.textContent = text;
              tip.style.display = 'block';
              var r = el.getBoundingClientRect();
              var tw = tip.offsetWidth;
              var th = tip.offsetHeight;
              var left = r.left + r.width / 2 - tw / 2;
              left = Math.max(8, Math.min(left, window.innerWidth - tw - 8));
              var top = r.top - th - 6;
              if (top < 8) top = r.bottom + 6;
              tip.style.left = left + 'px';
              tip.style.top = top + 'px';
              active = el;
            }

            function hide() {
              tip.style.display = 'none';
              active = null;
            }

            document.addEventListener('mouseover', function(e) {
              var el = e.target && e.target.closest ? e.target.closest('.tt') : null;
              if (el) show(el); else hide();
            });

            document.addEventListener('click', function(e) {
              var el = e.target && e.target.closest ? e.target.closest('.tt') : null;
              if (el) {
                if (active === el) { hide(); } else { show(el); }
              } else {
                hide();
              }
            }, true);
          })();

          // Stock detail modal
          var _modalAnalysis = null;

          function openStockModal(tickerCode) {
            var modal = document.getElementById('stock-modal');
            _modalAnalysis = null;
            modal.innerHTML = '<div class="modal-overlay" onclick="if(event.target===this)closeStockModal()"><div class="modal-content"><div class="modal-loading">読み込み中...</div></div></div>';

            // 基本データと分析データを並列取得
            var stockP = fetch('/api/stock/' + encodeURIComponent(tickerCode)).then(function(r) { return r.ok ? r.json() : null; });
            var analysisP = fetch('/api/stock/' + encodeURIComponent(tickerCode) + '/analysis').then(function(r) { return r.ok ? r.json() : null; }).catch(function() { return null; });

            Promise.all([stockP, analysisP]).then(function(results) {
              var s = results[0];
              var a = results[1];
              _modalAnalysis = a;
              if (!s || s.error) { closeStockModal(); return; }

              var fmt = function(v, suffix) { return v != null ? v + (suffix || '') : '-'; };
              var fmtYen = function(v) { return v != null ? '¥' + Number(v).toLocaleString('ja-JP', {maximumFractionDigits:0}) : '-'; };
              var fmtVol = function(v) { return v != null ? Number(v).toLocaleString('ja-JP') : '-'; };
              var fmtPct = function(v) {
                if (v == null) return '-';
                var n = Number(v);
                var sign = n >= 0 ? '+' : '';
                var color = n >= 0 ? '#22c55e' : '#ef4444';
                return '<span style="color:' + color + '">' + sign + n.toFixed(2) + '%</span>';
              };
              var fmtDate = function(v) {
                if (!v) return '-';
                var d = new Date(v);
                return (d.getMonth()+1) + '/' + d.getDate();
              };

              var h = '<div class="modal-overlay" onclick="if(event.target===this)closeStockModal()">'
                + '<div class="modal-content">'
                + '<div class="modal-header"><div><h2>' + s.tickerCode + '</h2><div class="modal-sub">' + s.name + '</div></div><button class="modal-close" onclick="closeStockModal()">✕</button></div>'
                + '<div class="modal-tabs">'
                + '<button class="modal-tab active" onclick="switchModalTab(this,\\'chart\\')">チャート</button>'
                + '<button class="modal-tab" onclick="switchModalTab(this,\\'info\\')">情報</button>'
                + '<button class="modal-tab" onclick="switchModalTab(this,\\'finance\\')">財務</button>'
                + '</div>'
                + '<div class="modal-body">'
                + buildChartTab(s, a)
                + buildInfoTab(s, fmt, fmtYen, fmtVol, fmtPct, fmtDate)
                + buildFinanceTab(s, fmt, fmtDate)
                + '</div></div></div>';
              modal.innerHTML = h;

              // チャート描画
              if (a && a.ohlcv) drawModalChart(a);
            }).catch(function() {
              modal.innerHTML = '<div class="modal-overlay" onclick="if(event.target===this)closeStockModal()"><div class="modal-content"><div class="modal-loading">データ取得に失敗しました</div></div></div>';
            });
          }

          function switchModalTab(btn, tab) {
            var tabs = btn.parentNode.querySelectorAll('.modal-tab');
            tabs.forEach(function(t) { t.classList.remove('active'); });
            btn.classList.add('active');
            var panes = btn.closest('.modal-content').querySelectorAll('.modal-pane');
            panes.forEach(function(p) { p.style.display = p.dataset.tab === tab ? 'block' : 'none'; });
          }

          function buildChartTab(s, a) {
            var h = '<div class="modal-pane" data-tab="chart" style="display:block">';

            // チャートエリア
            h += '<div class="modal-chart" id="modal-chart-area">';
            if (!a || !a.ohlcv) {
              h += '<div style="text-align:center;padding:24px;color:#64748b;font-size:12px">チャートデータなし</div>';
            }
            h += '</div>';

            if (a) {
              // 総合シグナル
              if (a.patterns && a.patterns.combined) {
                var cs = a.patterns.combined;
                var sigCls = cs.signal === 'buy' ? 'signal-buy' : cs.signal === 'sell' ? 'signal-sell' : 'signal-neutral';
                var sigLabel = cs.signal === 'buy' ? '買い' : cs.signal === 'sell' ? '売り' : '様子見';
                h += '<div style="display:flex;align-items:center;gap:8px;margin-bottom:12px">'
                  + '<span class="signal-badge ' + sigCls + '">' + sigLabel + ' ' + cs.strength + '%</span>';
                if (cs.reasons && cs.reasons.length > 0) {
                  h += '<span style="font-size:11px;color:#94a3b8">' + cs.reasons.join('、') + '</span>';
                }
                h += '</div>';
              }

              // テクニカル指標
              if (a.technical) {
                h += '<div class="modal-section">テクニカル指標</div>';
                h += '<div class="indicator-grid">';
                h += buildIndicator('RSI(14)', a.technical.rsi != null ? a.technical.rsi.toFixed(1) : '-', rsiColor(a.technical.rsi));
                h += buildIndicator('MACD', a.technical.macd && a.technical.macd.histogram != null ? (a.technical.macd.histogram >= 0 ? '+' : '') + a.technical.macd.histogram.toFixed(2) : '-', a.technical.macd && a.technical.macd.histogram != null ? (a.technical.macd.histogram >= 0 ? '#22c55e' : '#ef4444') : null);
                h += buildIndicator('SMA5', a.technical.sma5 != null ? '¥' + Math.round(a.technical.sma5).toLocaleString() : '-', null);
                h += buildIndicator('SMA25', a.technical.sma25 != null ? '¥' + Math.round(a.technical.sma25).toLocaleString() : '-', null);
                h += buildIndicator('BB上', a.technical.bollingerBands && a.technical.bollingerBands.upper != null ? '¥' + Math.round(a.technical.bollingerBands.upper).toLocaleString() : '-', null);
                h += buildIndicator('BB下', a.technical.bollingerBands && a.technical.bollingerBands.lower != null ? '¥' + Math.round(a.technical.bollingerBands.lower).toLocaleString() : '-', null);
                h += buildIndicator('ATR(14)', a.technical.atr14 != null ? '¥' + a.technical.atr14.toLocaleString() : '-', null);
                h += buildIndicator('乖離率', a.technical.deviationRate25 != null ? a.technical.deviationRate25 + '%' : '-', a.technical.deviationRate25 != null ? (Math.abs(a.technical.deviationRate25) > 5 ? '#f59e0b' : null) : null);
                h += '</div>';

                // トレンド
                var trend = a.technical.maAlignment;
                if (trend) {
                  var trendLabel = trend.trend === 'uptrend' ? '上昇' : trend.trend === 'downtrend' ? '下降' : '横ばい';
                  var trendColor = trend.trend === 'uptrend' ? '#22c55e' : trend.trend === 'downtrend' ? '#ef4444' : '#94a3b8';
                  h += '<div style="margin-top:8px;font-size:12px;color:#94a3b8">MA方向: <span style="color:' + trendColor + '">' + trendLabel + '</span>';
                  if (trend.orderAligned) h += ' <span style="color:#22c55e;font-size:11px">整列</span>';
                  h += '</div>';
                }

                // サポート・レジスタンス
                if ((a.technical.supports && a.technical.supports.length > 0) || (a.technical.resistances && a.technical.resistances.length > 0)) {
                  h += '<div style="margin-top:8px;font-size:12px">';
                  if (a.technical.supports && a.technical.supports.length > 0) {
                    h += '<span style="color:#22c55e">支持: ¥' + a.technical.supports.map(function(v){return v.toLocaleString()}).join(', ¥') + '</span> ';
                  }
                  if (a.technical.resistances && a.technical.resistances.length > 0) {
                    h += '<span style="color:#ef4444">抵抗: ¥' + a.technical.resistances.map(function(v){return v.toLocaleString()}).join(', ¥') + '</span>';
                  }
                  h += '</div>';
                }
              }

              // チャートパターン
              if (a.patterns && a.patterns.chartPatterns && a.patterns.chartPatterns.length > 0) {
                h += '<div class="modal-section">チャートパターン</div>';
                a.patterns.chartPatterns.forEach(function(p) {
                  var rankColors = {S:'#f59e0b',A:'#3b82f6',B:'#22c55e',C:'#94a3b8',D:'#64748b'};
                  var rc = rankColors[p.rank] || '#64748b';
                  var sigCls = p.signal === 'buy' ? 'signal-buy' : p.signal === 'sell' ? 'signal-sell' : 'signal-neutral';
                  var sigLabel = p.signal === 'buy' ? '買い' : p.signal === 'sell' ? '売り' : '中立';
                  h += '<div class="pattern-card">'
                    + '<div class="pattern-card-header">'
                    + '<span class="pattern-card-name">' + p.patternName + '</span>'
                    + '<span><span class="badge" style="background:' + rc + '20;color:' + rc + '">' + p.rank + '級</span> '
                    + '<span class="signal-badge ' + sigCls + '" style="font-size:11px;padding:2px 8px">' + sigLabel + '</span></span>'
                    + '</div>'
                    + '<div class="pattern-card-meta">勝率 ' + p.winRate + '% / 強度 ' + p.strength + '% — ' + p.description + '</div>'
                    + '</div>';
                });
              }

              // ローソク足パターン
              if (a.patterns && a.patterns.latest) {
                var lp = a.patterns.latest;
                h += '<div class="modal-section">直近ローソク足</div>';
                var sigCls = lp.signal === 'buy' ? 'signal-buy' : lp.signal === 'sell' ? 'signal-sell' : 'signal-neutral';
                h += '<div style="display:flex;align-items:center;gap:8px;font-size:13px">'
                  + '<span class="signal-badge ' + sigCls + '" style="font-size:11px;padding:2px 8px">' + lp.description + '</span>'
                  + '<span style="color:#94a3b8;font-size:11px">' + lp.learnMore + '</span>'
                  + '</div>';
              }

              // スコアリング
              if (a.scoring) {
                var sc = a.scoring;
                h += '<div class="modal-section">スコアリング</div>';
                var rankColors = {S:'#f59e0b',A:'#3b82f6',B:'#22c55e',C:'#94a3b8'};
                var rc = rankColors[sc.rank] || '#94a3b8';
                h += '<div style="display:flex;align-items:center;gap:8px;margin-bottom:8px">'
                  + '<span style="font-size:24px;font-weight:700">' + sc.totalScore + '</span>'
                  + '<span style="font-size:12px;color:#94a3b8">/100</span>'
                  + '<span class="badge" style="background:' + rc + '20;color:' + rc + '">' + sc.rank + 'ランク</span>';
                if (sc.isDisqualified) {
                  h += '<span class="badge" style="background:rgba(239,68,68,0.15);color:#ef4444">即死</span>';
                }
                if (sc.aiDecision) {
                  var aiColor = sc.aiDecision === 'go' ? '#22c55e' : '#ef4444';
                  var aiLabel = sc.aiDecision === 'go' ? 'GO' : 'NO GO';
                  h += '<span class="badge" style="background:' + aiColor + '20;color:' + aiColor + '">' + aiLabel + '</span>';
                }
                h += '</div>';
                h += buildScoreBar('テクニカル', sc.technicalScore, 40, '#3b82f6');
                h += buildScoreBar('パターン', sc.patternScore, 20, '#a855f7');
                h += buildScoreBar('流動性', sc.liquidityScore, 25, '#22c55e');
                h += buildScoreBar('ファンダ', sc.fundamentalScore, 15, '#f59e0b');
              }
            }

            h += '</div>';
            return h;
          }

          function buildInfoTab(s, fmt, fmtYen, fmtVol, fmtPct, fmtDate) {
            var statusText = s.isDelisted ? '<span style="color:#ef4444">上場廃止</span>' : s.isActive ? '<span style="color:#22c55e">アクティブ</span>' : '<span style="color:#f59e0b">非アクティブ</span>';
            var h = '<div class="modal-pane" data-tab="info" style="display:none">'
              + '<div class="modal-section">基本情報</div>'
              + '<div class="modal-row"><span class="modal-row-label">市場</span><span>' + (s.market || '-') + '</span></div>'
              + '<div class="modal-row"><span class="modal-row-label">セクター</span><span>' + (s.jpxSectorName || s.sector || '-') + '</span></div>'
              + '<div class="modal-section">株価データ</div>'
              + '<div class="modal-row"><span class="modal-row-label">現在価格</span><span>' + fmtYen(s.latestPrice) + '</span></div>'
              + '<div class="modal-row"><span class="modal-row-label">日次変動</span><span>' + fmtPct(s.dailyChangeRate) + '</span></div>'
              + '<div class="modal-row"><span class="modal-row-label">週次変動</span><span>' + fmtPct(s.weekChangeRate) + '</span></div>'
              + '<div class="modal-row"><span class="modal-row-label">出来高</span><span>' + fmtVol(s.latestVolume) + '</span></div>'
              + '<div class="modal-row"><span class="modal-row-label">ATR(14)</span><span>' + fmt(s.atr14) + '</span></div>'
              + '<div class="modal-row"><span class="modal-row-label">ボラティリティ</span><span>' + fmt(s.volatility, '%') + '</span></div>'
              + '<div class="modal-row"><span class="modal-row-label">更新日</span><span>' + fmtDate(s.latestPriceDate) + '</span></div>'
              + '<div class="modal-section">ステータス</div>'
              + '<div class="modal-row"><span class="modal-row-label">上場状態</span><span>' + statusText + '</span></div>'
              + (s.isRestricted ? '<div class="modal-row"><span class="modal-row-label">取引制限</span><span style="color:#ef4444">あり</span></div>' : '')
              + (s.supervisionFlag ? '<div class="modal-row"><span class="modal-row-label">監理区分</span><span style="color:#f59e0b">' + s.supervisionFlag + '</span></div>' : '')
              + (s.tradingHaltFlag ? '<div class="modal-row"><span class="modal-row-label">売買停止</span><span style="color:#ef4444">停止中</span></div>' : '')
              + (s.delistingDate ? '<div class="modal-row"><span class="modal-row-label">廃止予定日</span><span style="color:#ef4444">' + fmtDate(s.delistingDate) + '</span></div>' : '')
              + '<div class="modal-row"><span class="modal-row-label">次回決算</span><span>' + fmtDate(s.nextEarningsDate) + '</span></div>'
              + '</div>';
            return h;
          }

          function buildFinanceTab(s, fmt, fmtDate) {
            var profitText = s.isProfitable == null ? '-' : s.isProfitable ? '<span style="color:#22c55e">黒字</span>' : '<span style="color:#ef4444">赤字</span>';
            var h = '<div class="modal-pane" data-tab="finance" style="display:none">'
              + '<div class="modal-section">財務指標</div>'
              + '<div class="modal-row"><span class="modal-row-label">PER</span><span>' + fmt(s.per) + '</span></div>'
              + '<div class="modal-row"><span class="modal-row-label">PBR</span><span>' + fmt(s.pbr) + '</span></div>'
              + '<div class="modal-row"><span class="modal-row-label">ROE</span><span>' + fmt(s.roe, '%') + '</span></div>'
              + '<div class="modal-row"><span class="modal-row-label">EPS</span><span>' + fmt(s.eps) + '</span></div>'
              + '<div class="modal-row"><span class="modal-row-label">配当利回り</span><span>' + fmt(s.dividendYield, '%') + '</span></div>'
              + '<div class="modal-row"><span class="modal-row-label">時価総額</span><span>' + (s.marketCap != null ? Number(s.marketCap).toLocaleString('ja-JP') + '億円' : '-') + '</span></div>'
              + '<div class="modal-row"><span class="modal-row-label">収益性</span><span>' + profitText + '</span></div>'
              + '</div>';
            return h;
          }

          function buildIndicator(label, value, color) {
            return '<div class="indicator-item">'
              + '<div class="indicator-label">' + label + '</div>'
              + '<div class="indicator-value"' + (color ? ' style="color:' + color + '"' : '') + '>' + value + '</div>'
              + '</div>';
          }

          function buildScoreBar(label, value, max, color) {
            var pct = max > 0 ? Math.round((value / max) * 100) : 0;
            return '<div class="score-bar-wrap">'
              + '<div class="score-bar-label"><span>' + label + '</span><span>' + value + '/' + max + '</span></div>'
              + '<div class="score-bar-track"><div class="score-bar-fill" style="width:' + pct + '%;background:' + color + '"></div></div>'
              + '</div>';
          }

          function rsiColor(rsi) {
            if (rsi == null) return null;
            if (rsi >= 70) return '#ef4444';
            if (rsi <= 30) return '#22c55e';
            return null;
          }

          // SVG チャート描画
          function drawModalChart(a) {
            var el = document.getElementById('modal-chart-area');
            if (!el || !a.ohlcv || a.ohlcv.length < 2) return;

            var data = a.ohlcv;
            var W = 388, H = 200, padT = 16, padB = 24, padL = 48, padR = 8;
            var volH = 40; // 出来高エリアの高さ
            var chartH = H - padT - padB - volH;
            var chartW = W - padL - padR;

            var closes = data.map(function(d){return d.close});
            var highs = data.map(function(d){return d.high});
            var lows = data.map(function(d){return d.low});
            var volumes = data.map(function(d){return d.volume});
            var minP = Math.min.apply(null, lows);
            var maxP = Math.max.apply(null, highs);
            var rangeP = maxP - minP || 1;
            var maxVol = Math.max.apply(null, volumes) || 1;

            var yPrice = function(v) { return padT + chartH - ((v - minP) / rangeP) * chartH; };
            var xPos = function(i) { return padL + (i / (data.length - 1)) * chartW; };

            var svg = '<svg viewBox="0 0 ' + W + ' ' + H + '">';

            // Y軸ラベル
            svg += '<text x="' + (padL - 4) + '" y="' + (padT + 4) + '" text-anchor="end" fill="#64748b" font-size="9">¥' + Math.round(maxP).toLocaleString() + '</text>';
            svg += '<text x="' + (padL - 4) + '" y="' + (padT + chartH + 4) + '" text-anchor="end" fill="#64748b" font-size="9">¥' + Math.round(minP).toLocaleString() + '</text>';

            // サポート・レジスタンスライン
            if (a.technical) {
              (a.technical.supports || []).forEach(function(s) {
                var y = yPrice(s);
                if (y > padT && y < padT + chartH) {
                  svg += '<line x1="' + padL + '" y1="' + y + '" x2="' + (W - padR) + '" y2="' + y + '" stroke="#22c55e" stroke-width="0.7" stroke-dasharray="3,3" opacity="0.5"/>';
                }
              });
              (a.technical.resistances || []).forEach(function(r) {
                var y = yPrice(r);
                if (y > padT && y < padT + chartH) {
                  svg += '<line x1="' + padL + '" y1="' + y + '" x2="' + (W - padR) + '" y2="' + y + '" stroke="#ef4444" stroke-width="0.7" stroke-dasharray="3,3" opacity="0.5"/>';
                }
              });
            }

            // SMA線
            if (a.technical && a.technical.sma25 != null && data.length >= 25) {
              // SMA25ラインを簡易描画（終値の25日移動平均）
              var smaPoints = [];
              for (var i = 24; i < data.length; i++) {
                var sum = 0;
                for (var j = i - 24; j <= i; j++) sum += data[j].close;
                var sma = sum / 25;
                smaPoints.push(xPos(i) + ',' + yPrice(sma));
              }
              svg += '<polyline fill="none" stroke="#f59e0b" stroke-width="1" opacity="0.6" points="' + smaPoints.join(' ') + '"/>';
            }

            // ローソク足（簡易版：バーが多い場合は終値ライン）
            if (data.length <= 80) {
              var barW = Math.max(1, chartW / data.length * 0.6);
              data.forEach(function(d, i) {
                var x = xPos(i);
                var isUp = d.close >= d.open;
                var color = isUp ? '#22c55e' : '#ef4444';
                var bodyTop = yPrice(Math.max(d.open, d.close));
                var bodyBot = yPrice(Math.min(d.open, d.close));
                var bodyH = Math.max(1, bodyBot - bodyTop);
                // ヒゲ
                svg += '<line x1="' + x + '" y1="' + yPrice(d.high) + '" x2="' + x + '" y2="' + yPrice(d.low) + '" stroke="' + color + '" stroke-width="0.8"/>';
                // 実体
                svg += '<rect x="' + (x - barW/2) + '" y="' + bodyTop + '" width="' + barW + '" height="' + bodyH + '" fill="' + (isUp ? 'none' : color) + '" stroke="' + color + '" stroke-width="0.8"/>';
              });
            } else {
              // 終値ラインチャート
              var points = data.map(function(d, i) { return xPos(i) + ',' + yPrice(d.close); });
              svg += '<polyline fill="none" stroke="#3b82f6" stroke-width="1.5" points="' + points.join(' ') + '"/>';
            }

            // 出来高バー
            var volTop = padT + chartH + 4;
            data.forEach(function(d, i) {
              var x = xPos(i);
              var barW = Math.max(1, chartW / data.length * 0.5);
              var volBarH = (d.volume / maxVol) * (volH - 8);
              var color = d.close >= d.open ? '#22c55e' : '#ef4444';
              svg += '<rect x="' + (x - barW/2) + '" y="' + (volTop + volH - 8 - volBarH) + '" width="' + barW + '" height="' + volBarH + '" fill="' + color + '" opacity="0.3"/>';
            });

            // X軸ラベル（最初・中間・最後）
            var labelIndices = [0, Math.floor(data.length / 2), data.length - 1];
            labelIndices.forEach(function(idx) {
              var d = data[idx].date;
              var parts = d.split('-');
              var label = parts[1] + '/' + parts[2];
              svg += '<text x="' + xPos(idx) + '" y="' + (H - 2) + '" text-anchor="middle" fill="#64748b" font-size="8">' + label + '</text>';
            });

            svg += '</svg>';
            el.innerHTML = svg;
          }

          function closeStockModal() {
            document.getElementById('stock-modal').innerHTML = '';
            _modalAnalysis = null;
          }

          document.addEventListener('keydown', function(e) {
            if (e.key === 'Escape') closeStockModal();
          });
        </script>
      </body>
    </html>`;
}
