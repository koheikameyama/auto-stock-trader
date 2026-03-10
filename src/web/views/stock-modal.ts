/**
 * 銘柄詳細モーダル用コンポーネント
 *
 * layout.ts のクライアントJS文字列連結をサーバーサイドテンプレートに移行。
 * openStockModal() → fetch('/api/stock/:tickerCode/modal') → innerHTML
 */

import { html } from "hono/html";
import type { HtmlEscapedString } from "hono/utils/html";
import type { Stock } from "@prisma/client";
import type { TechnicalSummary, OHLCVData } from "../../core/technical-analysis";
import type { PatternsResponse } from "../../lib/candlestick-patterns";

type HtmlContent = HtmlEscapedString | Promise<HtmlEscapedString>;

/** 分析データ型 */
export interface ModalAnalysis {
  ohlcv: OHLCVData[];
  technical: TechnicalSummary;
  patterns: PatternsResponse;
  scoring: {
    totalScore: number;
    rank: string;
    technicalScore: number;
    patternScore: number;
    liquidityScore: number;
    fundamentalScore: number;
    isDisqualified: boolean;
    disqualifyReason: string | null;
    aiDecision: string | null;
  } | null;
}

// ========================================
// メインコンポーネント
// ========================================

/** モーダル全体（overlay + content） */
export function stockModal(
  stock: Stock,
  analysis: ModalAnalysis | null,
): HtmlContent {
  return html`<div
    class="modal-overlay"
    onclick="if(event.target===this)closeStockModal()"
  >
    <div class="modal-content">
      <div class="modal-header">
        <div>
          <h2>${stock.tickerCode}</h2>
          <div class="modal-sub">${stock.name}</div>
        </div>
        <button class="modal-close" onclick="closeStockModal()">✕</button>
      </div>
      <div class="modal-tabs">
        <button
          class="modal-tab active"
          onclick="switchModalTab(this,'chart')"
        >
          チャート
        </button>
        <button class="modal-tab" onclick="switchModalTab(this,'info')">
          情報
        </button>
        <button class="modal-tab" onclick="switchModalTab(this,'finance')">
          財務
        </button>
      </div>
      <div class="modal-body">
        ${chartTab(analysis)} ${infoTab(stock)} ${financeTab(stock)}
      </div>
    </div>
  </div>`;
}

// ========================================
// タブコンポーネント
// ========================================

/** チャートタブ */
function chartTab(analysis: ModalAnalysis | null): HtmlContent {
  return html`<div class="modal-pane" data-tab="chart" style="display:block">
    <div class="modal-chart">
      ${analysis?.ohlcv && analysis.ohlcv.length >= 2
        ? candlestickChart(analysis.ohlcv, analysis.technical)
        : html`<div
            style="text-align:center;padding:24px;color:#64748b;font-size:12px"
          >
            チャートデータなし
          </div>`}
    </div>
    ${analysis
      ? html`${combinedSignal(analysis.patterns)}
          ${technicalGrid(analysis.technical)}
          ${trendInfo(analysis.technical)}
          ${supportResistanceInfo(analysis.technical)}
          ${chartPatterns(analysis.patterns)}
          ${latestCandle(analysis.patterns)}
          ${scoringSection(analysis.scoring)}`
      : ""}
  </div>`;
}

/** 情報タブ */
function infoTab(s: Stock): HtmlContent {
  const statusText = s.isDelisted
    ? html`<span style="color:#ef4444">上場廃止</span>`
    : s.isActive
      ? html`<span style="color:#22c55e">アクティブ</span>`
      : html`<span style="color:#f59e0b">非アクティブ</span>`;

  return html`<div class="modal-pane" data-tab="info" style="display:none">
    <div class="modal-section">基本情報</div>
    ${modalRow("市場", s.market || "-")}
    ${modalRow("セクター", s.jpxSectorName || s.sector || "-")}

    <div class="modal-section">株価データ</div>
    ${modalRow("現在価格", fmtYen(s.latestPrice))}
    ${modalRow("日次変動", fmtPctHtml(s.dailyChangeRate))}
    ${modalRow("週次変動", fmtPctHtml(s.weekChangeRate))}
    ${modalRow("出来高", s.latestVolume != null ? Number(s.latestVolume).toLocaleString("ja-JP") : "-")}
    ${modalRow("ATR(14)", fmt(s.atr14))}
    ${modalRow("ボラティリティ", fmt(s.volatility, "%"))}
    ${modalRow("更新日", fmtDate(s.latestPriceDate))}

    <div class="modal-section">ステータス</div>
    ${modalRow("上場状態", statusText)}
    ${s.isRestricted ? modalRow("取引制限", html`<span style="color:#ef4444">あり</span>`) : ""}
    ${s.supervisionFlag ? modalRow("監理区分", html`<span style="color:#f59e0b">${s.supervisionFlag}</span>`) : ""}
    ${s.tradingHaltFlag ? modalRow("売買停止", html`<span style="color:#ef4444">停止中</span>`) : ""}
    ${s.delistingDate ? modalRow("廃止予定日", html`<span style="color:#ef4444">${fmtDate(s.delistingDate)}</span>`) : ""}
    ${modalRow("次回決算", fmtDate(s.nextEarningsDate))}
  </div>`;
}

/** 財務タブ */
function financeTab(s: Stock): HtmlContent {
  const profitText =
    s.isProfitable == null
      ? "-"
      : s.isProfitable
        ? html`<span style="color:#22c55e">黒字</span>`
        : html`<span style="color:#ef4444">赤字</span>`;

  return html`<div
    class="modal-pane"
    data-tab="finance"
    style="display:none"
  >
    <div class="modal-section">財務指標</div>
    ${modalRow("PER", fmt(s.per))}
    ${modalRow("PBR", fmt(s.pbr))}
    ${modalRow("ROE", fmt(s.roe, "%"))}
    ${modalRow("EPS", fmt(s.eps))}
    ${modalRow("配当利回り", fmt(s.dividendYield, "%"))}
    ${modalRow("時価総額", s.marketCap != null ? Number(s.marketCap).toLocaleString("ja-JP") + "億円" : "-")}
    ${modalRow("収益性", profitText)}
  </div>`;
}

// ========================================
// チャートタブ内セクション
// ========================================

/** 総合シグナル */
function combinedSignal(patterns: PatternsResponse): HtmlContent {
  if (!patterns.combined) return html``;
  const cs = patterns.combined;
  const sigCls =
    cs.signal === "buy"
      ? "signal-buy"
      : cs.signal === "sell"
        ? "signal-sell"
        : "signal-neutral";
  const sigLabel =
    cs.signal === "buy" ? "買い" : cs.signal === "sell" ? "売り" : "様子見";

  return html`<div
    style="display:flex;align-items:center;gap:8px;margin-bottom:12px"
  >
    <span class="signal-badge ${sigCls}">${sigLabel} ${cs.strength}%</span>
    ${cs.reasons.length > 0
      ? html`<span style="font-size:11px;color:#94a3b8"
          >${cs.reasons.join("、")}</span
        >`
      : ""}
  </div>`;
}

/** テクニカル指標グリッド */
function technicalGrid(t: TechnicalSummary): HtmlContent {
  return html`<div class="modal-section">テクニカル指標</div>
    <div class="indicator-grid">
      ${indicatorItem("RSI(14)", t.rsi != null ? t.rsi.toFixed(1) : "-", rsiColor(t.rsi))}
      ${indicatorItem("MACD", t.macd.histogram != null ? (t.macd.histogram >= 0 ? "+" : "") + t.macd.histogram.toFixed(2) : "-", t.macd.histogram != null ? (t.macd.histogram >= 0 ? "#22c55e" : "#ef4444") : null)}
      ${indicatorItem("SMA5", t.sma5 != null ? "¥" + Math.round(t.sma5).toLocaleString() : "-", null)}
      ${indicatorItem("SMA25", t.sma25 != null ? "¥" + Math.round(t.sma25).toLocaleString() : "-", null)}
      ${indicatorItem("BB上", t.bollingerBands.upper != null ? "¥" + Math.round(t.bollingerBands.upper).toLocaleString() : "-", null)}
      ${indicatorItem("BB下", t.bollingerBands.lower != null ? "¥" + Math.round(t.bollingerBands.lower).toLocaleString() : "-", null)}
      ${indicatorItem("ATR(14)", t.atr14 != null ? "¥" + t.atr14.toLocaleString() : "-", null)}
      ${indicatorItem("乖離率", t.deviationRate25 != null ? t.deviationRate25 + "%" : "-", t.deviationRate25 != null && Math.abs(t.deviationRate25) > 5 ? "#f59e0b" : null)}
    </div>`;
}

/** MA トレンド情報 */
function trendInfo(t: TechnicalSummary): HtmlContent {
  const trend = t.maAlignment;
  if (!trend) return html``;
  const trendLabel =
    trend.trend === "uptrend"
      ? "上昇"
      : trend.trend === "downtrend"
        ? "下降"
        : "横ばい";
  const trendColor =
    trend.trend === "uptrend"
      ? "#22c55e"
      : trend.trend === "downtrend"
        ? "#ef4444"
        : "#94a3b8";

  return html`<div style="margin-top:8px;font-size:12px;color:#94a3b8">
    MA方向:
    <span style="color:${trendColor}">${trendLabel}</span>
    ${trend.orderAligned
      ? html`<span style="color:#22c55e;font-size:11px">整列</span>`
      : ""}
  </div>`;
}

/** サポート・レジスタンス情報 */
function supportResistanceInfo(t: TechnicalSummary): HtmlContent {
  if (
    (!t.supports || t.supports.length === 0) &&
    (!t.resistances || t.resistances.length === 0)
  )
    return html``;

  return html`<div style="margin-top:8px;font-size:12px">
    ${t.supports.length > 0
      ? html`<span style="color:#22c55e"
          >支持: ¥${t.supports
            .map((v) => v.toLocaleString())
            .join(", ¥")}</span
        > `
      : ""}
    ${t.resistances.length > 0
      ? html`<span style="color:#ef4444"
          >抵抗: ¥${t.resistances
            .map((v) => v.toLocaleString())
            .join(", ¥")}</span
        >`
      : ""}
  </div>`;
}

/** チャートパターン一覧 */
function chartPatterns(patterns: PatternsResponse): HtmlContent {
  if (!patterns.chartPatterns || patterns.chartPatterns.length === 0)
    return html``;

  const rankColors: Record<string, string> = {
    S: "#f59e0b",
    A: "#3b82f6",
    B: "#22c55e",
    C: "#94a3b8",
    D: "#64748b",
  };

  return html`<div class="modal-section">チャートパターン</div>
    ${patterns.chartPatterns.map((p) => {
      const rc = rankColors[p.rank] || "#64748b";
      const sigCls =
        p.signal === "buy"
          ? "signal-buy"
          : p.signal === "sell"
            ? "signal-sell"
            : "signal-neutral";
      const sigLabel =
        p.signal === "buy" ? "買い" : p.signal === "sell" ? "売り" : "中立";
      return html`<div class="pattern-card">
        <div class="pattern-card-header">
          <span class="pattern-card-name">${p.patternName}</span>
          <span>
            <span
              class="badge"
              style="background:${rc}20;color:${rc}"
              >${p.rank}級</span
            >
            <span
              class="signal-badge ${sigCls}"
              style="font-size:11px;padding:2px 8px"
              >${sigLabel}</span
            >
          </span>
        </div>
        <div class="pattern-card-meta">
          勝率 ${p.winRate}% / 強度 ${p.strength}% — ${p.description}
        </div>
      </div>`;
    })}`;
}

/** 直近ローソク足パターン */
function latestCandle(patterns: PatternsResponse): HtmlContent {
  if (!patterns.latest) return html``;
  const lp = patterns.latest;
  const sigCls =
    lp.signal === "buy"
      ? "signal-buy"
      : lp.signal === "sell"
        ? "signal-sell"
        : "signal-neutral";

  return html`<div class="modal-section">直近ローソク足</div>
    <div style="display:flex;align-items:center;gap:8px;font-size:13px">
      <span
        class="signal-badge ${sigCls}"
        style="font-size:11px;padding:2px 8px"
        >${lp.description}</span
      >
      <span style="color:#94a3b8;font-size:11px">${lp.learnMore}</span>
    </div>`;
}

/** スコアリングセクション */
function scoringSection(
  scoring: ModalAnalysis["scoring"],
): HtmlContent {
  if (!scoring) return html``;
  const rc =
    { S: "#f59e0b", A: "#3b82f6", B: "#22c55e", C: "#94a3b8" }[
      scoring.rank
    ] ?? "#94a3b8";

  return html`<div class="modal-section">スコアリング</div>
    <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px">
      <span style="font-size:24px;font-weight:700">${scoring.totalScore}</span>
      <span style="font-size:12px;color:#94a3b8">/100</span>
      <span class="badge" style="background:${rc}20;color:${rc}"
        >${scoring.rank}ランク</span
      >
      ${scoring.isDisqualified
        ? html`<span
            class="badge"
            style="background:rgba(239,68,68,0.15);color:#ef4444"
            >即死</span
          >`
        : ""}
      ${scoring.aiDecision
        ? (() => {
            const aiColor =
              scoring.aiDecision === "go" ? "#22c55e" : "#ef4444";
            const aiLabel = scoring.aiDecision === "go" ? "GO" : "NO GO";
            return html`<span
              class="badge"
              style="background:${aiColor}20;color:${aiColor}"
              >${aiLabel}</span
            >`;
          })()
        : ""}
    </div>
    ${scoreBar("テクニカル", scoring.technicalScore, 40, "#3b82f6")}
    ${scoreBar("パターン", scoring.patternScore, 20, "#a855f7")}
    ${scoreBar("流動性", scoring.liquidityScore, 25, "#22c55e")}
    ${scoreBar("ファンダ", scoring.fundamentalScore, 15, "#f59e0b")}`;
}

// ========================================
// SVG チャート
// ========================================

/** ローソク足チャート（サーバーサイドSVG生成） */
function candlestickChart(
  data: OHLCVData[],
  technical: TechnicalSummary,
): HtmlContent {
  const W = 388;
  const H = 200;
  const padT = 16;
  const padB = 24;
  const padL = 48;
  const padR = 8;
  const volH = 40;
  const chartH = H - padT - padB - volH;
  const chartW = W - padL - padR;

  const highs = data.map((d) => d.high);
  const lows = data.map((d) => d.low);
  const volumes = data.map((d) => d.volume);
  const minP = Math.min(...lows);
  const maxP = Math.max(...highs);
  const rangeP = maxP - minP || 1;
  const maxVol = Math.max(...volumes) || 1;

  const yPrice = (v: number) => padT + chartH - ((v - minP) / rangeP) * chartH;
  const xPos = (i: number) => padL + (i / (data.length - 1)) * chartW;

  // サポート・レジスタンスライン
  const srLines = [
    ...technical.supports
      .map((s) => ({ y: yPrice(s), color: "#22c55e" }))
      .filter((l) => l.y > padT && l.y < padT + chartH),
    ...technical.resistances
      .map((r) => ({ y: yPrice(r), color: "#ef4444" }))
      .filter((l) => l.y > padT && l.y < padT + chartH),
  ];

  // SMA25ライン
  const smaPoints: string[] = [];
  if (technical.sma25 != null && data.length >= 25) {
    for (let i = 24; i < data.length; i++) {
      let sum = 0;
      for (let j = i - 24; j <= i; j++) sum += data[j].close;
      const sma = sum / 25;
      smaPoints.push(`${xPos(i)},${yPrice(sma)}`);
    }
  }

  // ローソク足 or ラインチャート
  const useCandles = data.length <= 80;
  const barW = useCandles
    ? Math.max(1, (chartW / data.length) * 0.6)
    : 0;

  // X軸ラベル
  const labelIndices = [0, Math.floor(data.length / 2), data.length - 1];

  // 出来高
  const volTop = padT + chartH + 4;
  const volBarW = Math.max(1, (chartW / data.length) * 0.5);

  return html`<svg viewBox="0 0 ${W} ${H}">
    <!-- Y軸ラベル -->
    <text
      x="${padL - 4}"
      y="${padT + 4}"
      text-anchor="end"
      fill="#64748b"
      font-size="9"
    >
      ¥${Math.round(maxP).toLocaleString()}
    </text>
    <text
      x="${padL - 4}"
      y="${padT + chartH + 4}"
      text-anchor="end"
      fill="#64748b"
      font-size="9"
    >
      ¥${Math.round(minP).toLocaleString()}
    </text>

    <!-- サポート・レジスタンス -->
    ${srLines.map(
      (l) =>
        html`<line
          x1="${padL}"
          y1="${l.y}"
          x2="${W - padR}"
          y2="${l.y}"
          stroke="${l.color}"
          stroke-width="0.7"
          stroke-dasharray="3,3"
          opacity="0.5"
        />`,
    )}

    <!-- SMA25 -->
    ${smaPoints.length > 0
      ? html`<polyline
          fill="none"
          stroke="#f59e0b"
          stroke-width="1"
          opacity="0.6"
          points="${smaPoints.join(" ")}"
        />`
      : ""}

    <!-- 価格 -->
    ${useCandles
      ? data.map((d, i) => {
          const x = xPos(i);
          const isUp = d.close >= d.open;
          const color = isUp ? "#22c55e" : "#ef4444";
          const bodyTop = yPrice(Math.max(d.open, d.close));
          const bodyBot = yPrice(Math.min(d.open, d.close));
          const bodyH = Math.max(1, bodyBot - bodyTop);
          return html`<line
              x1="${x}"
              y1="${yPrice(d.high)}"
              x2="${x}"
              y2="${yPrice(d.low)}"
              stroke="${color}"
              stroke-width="0.8"
            />
            <rect
              x="${x - barW / 2}"
              y="${bodyTop}"
              width="${barW}"
              height="${bodyH}"
              fill="${isUp ? "none" : color}"
              stroke="${color}"
              stroke-width="0.8"
            />`;
        })
      : html`<polyline
          fill="none"
          stroke="#3b82f6"
          stroke-width="1.5"
          points="${data.map((d, i) => `${xPos(i)},${yPrice(d.close)}`).join(" ")}"
        />`}

    <!-- 出来高 -->
    ${data.map((d, i) => {
      const x = xPos(i);
      const vBarH = (d.volume / maxVol) * (volH - 8);
      const color = d.close >= d.open ? "#22c55e" : "#ef4444";
      return html`<rect
        x="${x - volBarW / 2}"
        y="${volTop + volH - 8 - vBarH}"
        width="${volBarW}"
        height="${vBarH}"
        fill="${color}"
        opacity="0.3"
      />`;
    })}

    <!-- X軸ラベル -->
    ${labelIndices.map((idx) => {
      const parts = data[idx].date.split("-");
      const label = parts[1] + "/" + parts[2];
      return html`<text
        x="${xPos(idx)}"
        y="${H - 2}"
        text-anchor="middle"
        fill="#64748b"
        font-size="8"
      >
        ${label}
      </text>`;
    })}
  </svg>`;
}

// ========================================
// 小さなヘルパーコンポーネント
// ========================================

/** モーダル行（ラベル: 値） */
function modalRow(
  label: string,
  value: string | HtmlContent,
): HtmlContent {
  return html`<div class="modal-row">
    <span class="modal-row-label">${label}</span>
    <span>${value}</span>
  </div>`;
}

/** テクニカル指標1個 */
function indicatorItem(
  label: string,
  value: string,
  color: string | null,
): HtmlContent {
  return html`<div class="indicator-item">
    <div class="indicator-label">${label}</div>
    <div class="indicator-value" ${color ? html`style="color:${color}"` : ""}>
      ${value}
    </div>
  </div>`;
}

/** スコアバー */
function scoreBar(
  label: string,
  value: number,
  max: number,
  color: string,
): HtmlContent {
  const pct = max > 0 ? Math.round((value / max) * 100) : 0;
  return html`<div class="score-bar-wrap">
    <div class="score-bar-label">
      <span>${label}</span><span>${value}/${max}</span>
    </div>
    <div class="score-bar-track">
      <div
        class="score-bar-fill"
        style="width:${pct}%;background:${color}"
      ></div>
    </div>
  </div>`;
}

// ========================================
// フォーマットヘルパー
// ========================================

// Prisma Decimal 互換（Decimal | number | null を受け取る）
function fmt(v: unknown, suffix?: string): string {
  return v != null ? String(v) + (suffix || "") : "-";
}

function fmtYen(v: unknown): string {
  return v != null
    ? "¥" + Number(v).toLocaleString("ja-JP", { maximumFractionDigits: 0 })
    : "-";
}

function fmtPctHtml(v: unknown): HtmlContent {
  if (v == null) return html`-`;
  const n = Number(v);
  const sign = n >= 0 ? "+" : "";
  const color = n >= 0 ? "#22c55e" : "#ef4444";
  return html`<span style="color:${color}">${sign}${n.toFixed(2)}%</span>`;
}

function fmtDate(v: Date | string | null | undefined): string {
  if (!v) return "-";
  const d = new Date(v);
  return d.getMonth() + 1 + "/" + d.getDate();
}

function rsiColor(rsi: number | null): string | null {
  if (rsi == null) return null;
  if (rsi >= 70) return "#ef4444";
  if (rsi <= 30) return "#22c55e";
  return null;
}
