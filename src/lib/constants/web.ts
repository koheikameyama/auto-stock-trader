/**
 * Web UI・ルート設定
 */

// チャートSVGパディング
export const CHART_PADDING = {
  TOP: 10,
  RIGHT: 10,
  BOTTOM: 20,
  LEFT: 50,
} as const;

// チャートのx軸ラベル表示閾値
export const CHART_LABEL_THRESHOLD = 15;

// ルートのクエリ制限
export const QUERY_LIMITS = {
  ORDERS_TODAY: 30,
  POSITIONS_CLOSED: 20,
  HISTORY_SUMMARIES: 30,
  SCORING_RECORDS: 50,
  WEEKLY_SUMMARIES: 12,
} as const;

// ルートのルックバック日数
export const ROUTE_LOOKBACK_DAYS = {
  POSITIONS_CLOSED: 7,
  HISTORY: 30,
  SCORING_HISTORY: 30,
} as const;
