/**
 * 再利用可能な HTML コンポーネント
 */

import { html } from "hono/html";
import type { HtmlEscapedString } from "hono/utils/html";
import { COLORS } from "./styles";
import { CHART_PADDING, CHART_LABEL_THRESHOLD, NIKKEI_CHART_PERIODS } from "../../lib/constants";

type HtmlContent = HtmlEscapedString | Promise<HtmlEscapedString>;

/** 専門用語にツールチップを付与 */
export function tt(text: string, tooltip: string): HtmlContent {
  return html`<span class="tt" data-tooltip="${tooltip}">${text}</span>`;
}

/** 金額フォーマット（円） */
export function formatYen(value: number): string {
  return value.toLocaleString("ja-JP", {
    maximumFractionDigits: 0,
  });
}

/** PnL 表示（色付き） */
export function pnlText(value: number): HtmlContent {
  const cls = value >= 0 ? "pnl-positive" : "pnl-negative";
  const sign = value >= 0 ? "+" : "";
  return html`<span class="${cls}">${sign}¥${formatYen(value)}</span>`;
}

/** PnL パーセント表示 */
export function pnlPercent(value: number): HtmlContent {
  const cls = value >= 0 ? "pnl-positive" : "pnl-negative";
  const sign = value >= 0 ? "+" : "";
  return html`<span class="${cls}">${sign}${value.toFixed(2)}%</span>`;
}

/** Sentiment バッジ */
export function sentimentBadge(sentiment: string | null): HtmlContent {
  if (!sentiment) return html`<span class="badge badge-neutral">N/A</span>`;
  const labels: Record<string, string> = {
    normal: "通常",
    crisis: "危機",
  };
  return html`<span class="badge badge-${sentiment}"
    >${labels[sentiment] ?? sentiment}</span
  >`;
}

/** Regime バッジ */
export function regimeBadge(level: string): HtmlContent {
  const labels: Record<string, string> = {
    normal: "通常",
    elevated: "注意",
    high: "警戒",
    crisis: "危機",
  };
  const colorMap: Record<string, string> = {
    normal: COLORS.profit,
    elevated: COLORS.warning,
    high: "#f97316",
    crisis: COLORS.crisis,
  };
  const color = colorMap[level] ?? COLORS.textMuted;
  return html`<span class="badge" style="background:${color}20;color:${color}"
    >${labels[level] ?? level}</span
  >`;
}

/** Strategy バッジ */
export function strategyBadge(strategy: string): HtmlContent {
  const labels: Record<string, string> = {
    breakout: "ブレイクアウト",
    gapup: "GU（ギャップアップ）",
  };
  return html`<span class="badge badge-${strategy}"
    >${labels[strategy] ?? strategy}</span
  >`;
}

/** ブローカーステータスコードを日本語ラベルに変換 */
export function brokerStatusLabel(brokerStatus: string | null | undefined): string {
  switch (brokerStatus) {
    case "13": return "逆指値待機中";
    case "15": return "逆指値切替中";
    case "16": return "逆指値約定待ち";
    case "1":  return "通常待機中";
    case "9":  return "一部約定";
    default:   return "-";
  }
}

/** Order status バッジ */
export function orderStatusBadge(status: string): HtmlContent {
  const colors: Record<string, string> = {
    pending: COLORS.warning,
    filled: COLORS.profit,
    expired: COLORS.textDim,
    cancelled: COLORS.textDim,
  };
  const labels: Record<string, string> = {
    pending: "待機中",
    filled: "約定",
    expired: "期限切れ",
    cancelled: "キャンセル",
  };
  const color = colors[status] ?? COLORS.textMuted;
  return html`<span
    class="badge"
    style="background:${color}20;color:${color}"
    >${labels[status] ?? status}</span
  >`;
}

/** 銘柄リンク（クリックでモーダル表示） */
export function tickerLink(
  tickerCode: string,
  displayText?: string,
): HtmlContent {
  return html`<span
    class="ticker-link"
    onclick="openStockModal('${tickerCode}')"
    >${displayText ?? tickerCode}</span
  >`;
}

/** 空の状態 */
export function emptyState(message: string): HtmlContent {
  return html`<div class="empty">${message}</div>`;
}

/** Signal light row (信号灯付きラベル: 値) */
export type SignalStatus = "ok" | "warning" | "danger";

export function signalRow(
  label: string | HtmlContent,
  valueText: string,
  status: SignalStatus,
): HtmlContent {
  const emoji =
    status === "ok" ? "\u{1F7E2}" : status === "warning" ? "\u{1F7E1}" : "\u{1F534}";
  const color =
    status === "ok"
      ? COLORS.profit
      : status === "warning"
        ? COLORS.warning
        : COLORS.loss;
  return html`<div class="detail-row">
    <span class="detail-label">${label}</span>
    <span style="color:${color}">${emoji} ${valueText}</span>
  </div>`;
}

/** Detail row (ラベル: 値) */
export function detailRow(
  label: string | HtmlContent,
  value: HtmlContent | string,
): HtmlContent {
  return html`<div class="detail-row">
    <span class="detail-label">${label}</span>
    <span>${value}</span>
  </div>`;
}

/** 日経225チャート ボディ（SVGライン + メタ情報） */
export interface NikkeiChartData {
  bars: { datetime: string; close: number }[];
  meta: {
    price: number;
    previousClose: number;
    change: number;
    changePercent: number;
    high: number;
    low: number;
  } | null;
}

export function nikkeiChartBody(
  data: NikkeiChartData,
  activePeriod: string,
): HtmlContent {
  const meta = data.meta;
  const isPositive = meta ? meta.change >= 0 : true;
  const lineColor = isPositive ? COLORS.profit : COLORS.loss;

  if (!data.bars || data.bars.length < 2) {
    return html`
      ${meta ? nikkeiMetaHtml(meta, isPositive) : ""}
      ${emptyState("チャートデータなし")}
    `;
  }

  const isIntraday = activePeriod === "1d";

  // SVG dimensions
  const W = 388;
  const H = 160;
  const padT = 12;
  const padB = 20;
  const padL = 48;
  const padR = 8;
  const chartW = W - padL - padR;
  const chartH = H - padT - padB;

  const closes = data.bars.map((b) => b.close);
  const minP = Math.min(...closes);
  const maxP = Math.max(...closes);
  const rangeP = maxP - minP || 1;

  const yPrice = (v: number) =>
    padT + chartH - ((v - minP) / rangeP) * chartH;
  const xPos = (i: number) =>
    padL + (i / (data.bars.length - 1)) * chartW;

  const points = data.bars.map((b, i) => `${xPos(i)},${yPrice(b.close)}`);

  // Gradient fill polygon
  const fillPoints = [
    `${xPos(0)},${padT + chartH}`,
    ...points,
    `${xPos(data.bars.length - 1)},${padT + chartH}`,
  ].join(" ");

  // X-axis labels (5 points)
  const labelCount = 5;
  const step = Math.floor(data.bars.length / (labelCount - 1));
  const labelIndices = Array.from(
    { length: labelCount },
    (_, i) => Math.min(i * step, data.bars.length - 1),
  );

  function formatLabel(datetime: string): string {
    if (isIntraday) {
      const match = datetime.match(/T(\d{2}):(\d{2})/);
      return match ? `${match[1]}:${match[2]}` : "";
    }
    const match = datetime.match(/\d{4}-(\d{2})-(\d{2})/);
    return match ? `${parseInt(match[1])}/${parseInt(match[2])}` : "";
  }

  // Previous close reference line (1d only)
  const prevCloseY =
    meta && activePeriod === "1d" ? yPrice(meta.previousClose) : null;
  const showPrevLine =
    prevCloseY != null && prevCloseY > padT && prevCloseY < padT + chartH;

  return html`
    ${meta ? nikkeiMetaHtml(meta, isPositive) : ""}
    <svg viewBox="0 0 ${W} ${H}" style="width:100%">
      <defs>
        <linearGradient id="nkGrad" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="${lineColor}" stop-opacity="0.2" />
          <stop offset="100%" stop-color="${lineColor}" stop-opacity="0.02" />
        </linearGradient>
      </defs>
      ${showPrevLine
        ? html`<line
            x1="${padL}"
            y1="${prevCloseY}"
            x2="${W - padR}"
            y2="${prevCloseY}"
            stroke="${COLORS.border}"
            stroke-dasharray="4"
            stroke-width="0.8"
          />`
        : ""}
      <polygon points="${fillPoints}" fill="url(#nkGrad)" />
      <polyline
        fill="none"
        stroke="${lineColor}"
        stroke-width="1.5"
        points="${points.join(" ")}"
      />
      <text
        x="${padL - 4}"
        y="${padT + 4}"
        text-anchor="end"
        fill="${COLORS.textDim}"
        font-size="9"
      >
        ¥${formatYen(maxP)}
      </text>
      <text
        x="${padL - 4}"
        y="${padT + chartH + 4}"
        text-anchor="end"
        fill="${COLORS.textDim}"
        font-size="9"
      >
        ¥${formatYen(minP)}
      </text>
      ${labelIndices.map(
        (idx) =>
          html`<text
            x="${xPos(idx)}"
            y="${H - 2}"
            text-anchor="middle"
            fill="${COLORS.textDim}"
            font-size="8"
          >
            ${formatLabel(data.bars[idx].datetime)}
          </text>`,
      )}
    </svg>
  `;
}

function nikkeiMetaHtml(
  meta: NonNullable<NikkeiChartData["meta"]>,
  isPositive: boolean,
): HtmlContent {
  return html`
    <div class="card-value">¥${formatYen(meta.price)}</div>
    <div class="card-sub" style="margin-bottom:8px">
      <span class="${isPositive ? "pnl-positive" : "pnl-negative"}">
        ${isPositive ? "+" : ""}¥${formatYen(Math.abs(meta.change))}
        (${isPositive ? "+" : ""}${meta.changePercent.toFixed(2)}%)
      </span>
      <span style="margin-left:8px;color:${COLORS.textDim}">
        高 ¥${formatYen(meta.high)} / 安 ¥${formatYen(meta.low)}
      </span>
    </div>
  `;
}

/** 日経225チャート ウィジェットシェル（初回レンダリング用） */
export function nikkeiChartShell(): HtmlContent {
  const periods = Object.entries(NIKKEI_CHART_PERIODS);
  return html`
    <div class="card" id="nikkei-chart-card">
      <div class="nikkei-header">
        <div class="card-title">日経225</div>
        <div class="nikkei-tabs">
          ${periods.map(
            ([key, { label }], i) =>
              html`<button
                class="chart-tab ${i === 0 ? "active" : ""}"
                onclick="switchNikkeiPeriod('${key}')"
              >
                ${label}
              </button>`,
          )}
        </div>
      </div>
      <div id="nikkei-chart-body">
        <div class="empty" style="padding:40px 0">読み込み中...</div>
      </div>
    </div>
  `;
}

/**
 * エクイティカーブ SVG（バックテスト用）
 * totalEquity の推移を折れ線で表示する。
 */
export function equityCurveChart(
  equityCurve: { date: string; totalEquity: number }[],
  width = 600,
  height = 180,
): HtmlContent {
  if (equityCurve.length < 2) return emptyState("データ不足");

  const padding = {
    top: CHART_PADDING.TOP,
    right: CHART_PADDING.RIGHT,
    bottom: 30,
    left: CHART_PADDING.LEFT + 10,
  };
  const w = width - padding.left - padding.right;
  const h = height - padding.top - padding.bottom;

  const values = equityCurve.map((d) => d.totalEquity);
  const minV = Math.min(...values);
  const maxV = Math.max(...values);
  const range = maxV - minV || 1;

  const points = equityCurve.map((d, i) => {
    const x = padding.left + (i / (equityCurve.length - 1)) * w;
    const y = padding.top + h - ((d.totalEquity - minV) / range) * h;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });

  const lastVal = values[values.length - 1];
  const firstVal = values[0];
  const color = lastVal >= firstVal ? COLORS.profit : COLORS.loss;

  // 月次ラベル（最大8件）
  const monthLabels: { x: number; label: string }[] = [];
  let lastMonth = "";
  equityCurve.forEach((d, i) => {
    const month = d.date.substring(0, 7); // YYYY-MM
    if (month !== lastMonth) {
      const x = padding.left + (i / (equityCurve.length - 1)) * w;
      monthLabels.push({ x, label: d.date.substring(5, 7) + "月" });
      lastMonth = month;
    }
  });
  // 最大8ラベルに間引く
  const step = Math.ceil(monthLabels.length / 8);
  const visibleLabels = monthLabels.filter((_, i) => i % step === 0);

  return html`<svg
    viewBox="0 0 ${width} ${height}"
    style="width:100%;max-width:${width}px"
  >
    <!-- Y軸ラベル -->
    <text
      x="${padding.left - 4}"
      y="${padding.top + 4}"
      text-anchor="end"
      fill="${COLORS.textDim}"
      font-size="9"
    >¥${formatYen(maxV)}</text>
    <text
      x="${padding.left - 4}"
      y="${padding.top + h + 4}"
      text-anchor="end"
      fill="${COLORS.textDim}"
      font-size="9"
    >¥${formatYen(minV)}</text>
    <!-- ライン -->
    <polyline
      fill="none"
      stroke="${color}"
      stroke-width="2"
      points="${points.join(" ")}"
    />
    <!-- X軸ラベル（月次） -->
    ${visibleLabels.map(
      (lb) =>
        html`<text
          x="${lb.x}"
          y="${height - 4}"
          text-anchor="middle"
          fill="${COLORS.textDim}"
          font-size="8"
        >${lb.label}</text>`,
    )}
  </svg>`;
}

/** 横棒グラフ（エグジット分類用） */
export function miniBarChart(
  items: { label: string; count: number; color: string }[],
  total: number,
): HtmlContent {
  if (total === 0) return emptyState("データなし");
  const maxCount = Math.max(...items.map((i) => i.count));
  return html`<div style="display:flex;flex-direction:column;gap:6px">
    ${items.map((item) => {
      const pct = total > 0 ? (item.count / total) * 100 : 0;
      const barW = maxCount > 0 ? (item.count / maxCount) * 100 : 0;
      return html`<div style="display:flex;align-items:center;gap:8px;font-size:12px">
        <span style="width:90px;color:${COLORS.textMuted};flex-shrink:0">${item.label}</span>
        <div style="flex:1;height:16px;background:${COLORS.border};border-radius:4px;overflow:hidden">
          <div style="width:${barW}%;height:100%;background:${item.color};border-radius:4px;transition:width 0.3s"></div>
        </div>
        <span style="width:60px;text-align:right;color:${COLORS.text};flex-shrink:0">${item.count} (${pct.toFixed(0)}%)</span>
      </div>`;
    })}
  </div>`;
}

/** SVG 折れ線チャート（累積PnL） */
export function sparklineChart(
  data: { label: string; value: number }[],
  width = 320,
  height = 120,
): HtmlContent {
  if (data.length < 2) return emptyState("データ不足");

  const padding = { top: CHART_PADDING.TOP, right: CHART_PADDING.RIGHT, bottom: CHART_PADDING.BOTTOM, left: CHART_PADDING.LEFT };
  const w = width - padding.left - padding.right;
  const h = height - padding.top - padding.bottom;

  const values = data.map((d) => d.value);
  const minV = Math.min(0, ...values);
  const maxV = Math.max(0, ...values);
  const range = maxV - minV || 1;

  const points = data.map((d, i) => {
    const x = padding.left + (i / (data.length - 1)) * w;
    const y = padding.top + h - ((d.value - minV) / range) * h;
    return `${x},${y}`;
  });

  const zeroY = padding.top + h - ((0 - minV) / range) * h;
  const lastValue = values[values.length - 1];
  const color = lastValue >= 0 ? COLORS.profit : COLORS.loss;

  return html`<svg
    viewBox="0 0 ${width} ${height}"
    style="width:100%;max-width:${width}px"
  >
    <!-- Zero line -->
    <line
      x1="${padding.left}"
      y1="${zeroY}"
      x2="${width - padding.right}"
      y2="${zeroY}"
      stroke="${COLORS.border}"
      stroke-dasharray="4"
    />
    <!-- Line -->
    <polyline
      fill="none"
      stroke="${color}"
      stroke-width="2"
      points="${points.join(" ")}"
    />
    <!-- Labels -->
    <text
      x="${padding.left - 4}"
      y="${padding.top + 4}"
      text-anchor="end"
      fill="${COLORS.textDim}"
      font-size="9"
    >
      ¥${formatYen(maxV)}
    </text>
    <text
      x="${padding.left - 4}"
      y="${padding.top + h + 4}"
      text-anchor="end"
      fill="${COLORS.textDim}"
      font-size="9"
    >
      ¥${formatYen(minV)}
    </text>
    ${data.length <= CHART_LABEL_THRESHOLD
      ? data.map(
          (d, i) =>
            html`<text
              x="${padding.left + (i / (data.length - 1)) * w}"
              y="${height - 2}"
              text-anchor="middle"
              fill="${COLORS.textDim}"
              font-size="8"
            >
              ${d.label}
            </text>`,
        )
      : ""}
  </svg>`;
}
