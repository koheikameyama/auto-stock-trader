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
  ORDER_HISTORY: 50,
  POSITIONS_CLOSED: 20,
  HISTORY_SUMMARIES: 30,
  SCORING_RECORDS: 50,
  WEEKLY_SUMMARIES: 12,
} as const;

// 日経225チャートの期間→インターバルマッピング
export const NIKKEI_CHART_PERIODS: Record<string, { interval: string; label: string }> = {
  "1d": { interval: "5m", label: "1日" },
  "5d": { interval: "15m", label: "1週" },
  "1mo": { interval: "1d", label: "1月" },
  "3mo": { interval: "1d", label: "3月" },
};

// ルートのルックバック日数
export const ROUTE_LOOKBACK_DAYS = {
  POSITIONS_CLOSED: 7,
  HISTORY: 30,
  SCORING_HISTORY: 30,
} as const;
