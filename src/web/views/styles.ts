/**
 * ダッシュボード CSS スタイル定義（ダークテーマ）
 */

export const COLORS = {
  bg: "#0f172a",
  card: "#1e293b",
  cardHover: "#334155",
  border: "#334155",
  text: "#e2e8f0",
  textMuted: "#94a3b8",
  textDim: "#64748b",
  accent: "#3b82f6",
  accentHover: "#2563eb",
  profit: "#22c55e",
  loss: "#ef4444",
  warning: "#f59e0b",
  bullish: "#22c55e",
  bearish: "#ef4444",
  neutral: "#94a3b8",
  crisis: "#dc2626",
  navBg: "#0b1120",
} as const;

export const CSS = `
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    background: ${COLORS.bg};
    color: ${COLORS.text};
    line-height: 1.5;
    padding-bottom: 72px;
    -webkit-text-size-adjust: 100%;
  }
  a { color: ${COLORS.accent}; text-decoration: none; }

  /* Header */
  .header {
    background: ${COLORS.navBg};
    padding: 12px 16px;
    display: flex;
    align-items: center;
    justify-content: space-between;
    border-bottom: 1px solid ${COLORS.border};
    position: sticky;
    top: 0;
    z-index: 100;
  }
  .header h1 {
    font-size: 16px;
    font-weight: 600;
  }
  .header .status-dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: ${COLORS.profit};
    display: inline-block;
    margin-right: 6px;
  }

  /* Cards */
  .card {
    background: ${COLORS.card};
    border-radius: 12px;
    padding: 16px;
    margin: 8px 16px;
    border: 1px solid ${COLORS.border};
  }
  .card-title {
    font-size: 12px;
    color: ${COLORS.textMuted};
    text-transform: uppercase;
    letter-spacing: 0.5px;
    margin-bottom: 8px;
  }
  .card-value {
    font-size: 24px;
    font-weight: 700;
  }
  .card-sub {
    font-size: 12px;
    color: ${COLORS.textMuted};
    margin-top: 4px;
  }

  /* Grid */
  .grid-2 {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 8px;
    margin: 8px 16px;
  }
  .grid-2 .card { margin: 0; }

  /* Badge */
  .badge {
    display: inline-block;
    padding: 2px 8px;
    border-radius: 9999px;
    font-size: 11px;
    font-weight: 600;
    text-transform: uppercase;
  }
  .badge-bullish { background: rgba(34,197,94,0.15); color: ${COLORS.bullish}; }
  .badge-bearish { background: rgba(239,68,68,0.15); color: ${COLORS.bearish}; }
  .badge-neutral { background: rgba(148,163,184,0.15); color: ${COLORS.neutral}; }
  .badge-crisis { background: rgba(220,38,38,0.15); color: ${COLORS.crisis}; }
  .badge-day_trade { background: rgba(59,130,246,0.15); color: ${COLORS.accent}; }
  .badge-swing { background: rgba(168,85,247,0.15); color: #a855f7; }

  /* Table */
  .table-wrap { overflow-x: auto; }
  table {
    width: 100%;
    border-collapse: collapse;
    font-size: 13px;
  }
  th {
    text-align: left;
    padding: 8px;
    color: ${COLORS.textMuted};
    font-weight: 500;
    font-size: 11px;
    text-transform: uppercase;
    border-bottom: 1px solid ${COLORS.border};
    white-space: nowrap;
  }
  td {
    padding: 8px;
    border-bottom: 1px solid ${COLORS.border};
    white-space: nowrap;
  }
  tr:last-child td { border-bottom: none; }

  /* PnL colors */
  .pnl-positive { color: ${COLORS.profit}; }
  .pnl-negative { color: ${COLORS.loss}; }

  /* Bottom nav */
  .bottom-nav {
    position: fixed;
    bottom: 0;
    left: 0;
    right: 0;
    background: ${COLORS.navBg};
    border-top: 1px solid ${COLORS.border};
    display: flex;
    justify-content: space-around;
    padding: 8px 0;
    padding-bottom: max(8px, env(safe-area-inset-bottom));
    z-index: 100;
  }
  .nav-item {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 2px;
    font-size: 10px;
    color: ${COLORS.textDim};
    text-decoration: none;
    padding: 4px 12px;
  }
  .nav-item.active { color: ${COLORS.accent}; }
  .nav-item svg { width: 20px; height: 20px; }

  /* Section */
  .section-title {
    font-size: 14px;
    font-weight: 600;
    padding: 16px 16px 4px;
    color: ${COLORS.textMuted};
  }

  /* Empty state */
  .empty {
    text-align: center;
    padding: 24px;
    color: ${COLORS.textDim};
    font-size: 13px;
  }

  /* Detail row */
  .detail-row {
    display: flex;
    justify-content: space-between;
    padding: 4px 0;
    font-size: 13px;
  }
  .detail-label { color: ${COLORS.textMuted}; }

  /* Chart */
  .chart-container {
    margin: 8px 16px;
    background: ${COLORS.card};
    border-radius: 12px;
    padding: 16px;
    border: 1px solid ${COLORS.border};
  }

  /* Expandable */
  details summary {
    cursor: pointer;
    font-size: 13px;
    color: ${COLORS.accent};
    margin-top: 8px;
  }
  details[open] summary { margin-bottom: 8px; }
  details .review-text {
    font-size: 13px;
    color: ${COLORS.textMuted};
    line-height: 1.6;
  }

  /* Refresh indicator */
  .refresh-info {
    font-size: 10px;
    color: ${COLORS.textDim};
  }
`;
