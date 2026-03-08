/**
 * 再利用可能な HTML コンポーネント
 */

import { html } from "hono/html";
import type { HtmlEscapedString } from "hono/utils/html";
import { COLORS } from "./styles";
import { CHART_PADDING, CHART_LABEL_THRESHOLD } from "../../lib/constants";

type HtmlContent = HtmlEscapedString | Promise<HtmlEscapedString>;

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
    bullish: "強気",
    bearish: "弱気",
    neutral: "中立",
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
    day_trade: "デイ",
    swing: "スイング",
  };
  return html`<span class="badge badge-${strategy}"
    >${labels[strategy] ?? strategy}</span
  >`;
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

/** 空の状態 */
export function emptyState(message: string): HtmlContent {
  return html`<div class="empty">${message}</div>`;
}

/** Detail row (ラベル: 値) */
export function detailRow(
  label: string,
  value: HtmlContent | string,
): HtmlContent {
  return html`<div class="detail-row">
    <span class="detail-label">${label}</span>
    <span>${value}</span>
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
