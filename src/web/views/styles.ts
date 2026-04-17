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
  cautious: "#f59e0b",
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
    white-space: nowrap;
    flex-shrink: 0;
  }
  .badge-normal { background: rgba(34,197,94,0.15); color: ${COLORS.bullish}; }
  .badge-neutral { background: rgba(148,163,184,0.15); color: ${COLORS.neutral}; }
  .badge-crisis { background: rgba(220,38,38,0.15); color: ${COLORS.crisis}; }
  .badge-breakout { background: rgba(59,130,246,0.15); color: ${COLORS.accent}; }
  .badge-gapup { background: rgba(168,85,247,0.15); color: #a855f7; }
  .badge-psc { background: rgba(251,146,60,0.15); color: #fb923c; }
  .badge-hot { background: rgba(245,158,11,0.15); color: #f59e0b; }
  .badge-triggered { background: rgba(59,130,246,0.15); color: ${COLORS.accent}; }
  .badge-rejected { background: rgba(239,68,68,0.15); color: ${COLORS.loss}; }
  .badge-holding { background: rgba(34,197,94,0.15); color: ${COLORS.bullish}; }
  .badge-cold { background: rgba(148,163,184,0.1); color: ${COLORS.neutral}; }

  /* Table */
  .table-wrap { overflow-x: auto; -webkit-overflow-scrolling: touch; }
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

  @media (max-width: 430px) {
    th { padding: 5px 4px; font-size: 10px; letter-spacing: 0; }
    td { padding: 5px 4px; font-size: 11px; }
    .card { padding: 12px 10px; margin: 6px 10px; }
    .grid-2 { margin: 6px 10px; gap: 6px; }
    .section-title { padding: 12px 10px 4px; }
    .chart-container { margin: 6px 10px; }

    /* Responsive table → card layout */
    .responsive-table { overflow-x: visible; }
    .responsive-table table,
    .responsive-table thead,
    .responsive-table tbody,
    .responsive-table tr,
    .responsive-table td { display: block; }
    .responsive-table thead { display: none; }
    .responsive-table tr {
      border-bottom: 1px solid ${COLORS.border};
      padding: 8px 0;
    }
    .responsive-table tr:last-child { border-bottom: none; }
    .responsive-table td {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 3px 0;
      border-bottom: none;
      white-space: normal;
    }
    .responsive-table td::before {
      content: attr(data-label);
      font-size: 11px;
      font-weight: 500;
      color: ${COLORS.textMuted};
      flex-shrink: 0;
      margin-right: 8px;
    }
    .responsive-table td[data-label="日付"],
    .responsive-table td[data-label="セクター"] {
      font-weight: 600;
      font-size: 13px;
      padding-bottom: 4px;
    }
    .responsive-table td[data-label="日付"]::before,
    .responsive-table td[data-label="セクター"]::before { display: none; }
    .responsive-table td[data-label="概要"] {
      flex-direction: column;
      align-items: flex-start;
      gap: 2px;
    }
    .responsive-table .review-row td {
      padding: 4px 0 0;
    }
    .responsive-table .review-row td::before { display: none; }
  }

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
    overflow-x: auto;
    -webkit-overflow-scrolling: touch;
    scrollbar-width: none;
    padding: 8px 0;
    padding-bottom: max(8px, env(safe-area-inset-bottom));
    z-index: 100;
  }
  .bottom-nav::-webkit-scrollbar { display: none; }
  .nav-item {
    display: flex;
    flex-direction: column;
    align-items: center;
    flex-shrink: 0;
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

  /* Chart tab */
  .chart-tab {
    padding: 4px 12px;
    border: 1px solid ${COLORS.border};
    border-radius: 6px;
    font-size: 11px;
    font-weight: 500;
    cursor: pointer;
    background: transparent;
    color: ${COLORS.textDim};
    transition: all 0.2s;
  }
  .chart-tab:hover { border-color: ${COLORS.accent}; color: ${COLORS.accent}; }
  .chart-tab.active { background: ${COLORS.accent}; color: #fff; border-color: ${COLORS.accent}; }

  /* Nikkei chart widget */
  .nikkei-header {
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
    margin-bottom: 8px;
  }
  .nikkei-tabs { display: flex; gap: 4px; flex-shrink: 0; }
  @media (max-width: 430px) {
    .nikkei-header { flex-direction: column; gap: 8px; }
    .nikkei-tabs { align-self: flex-end; }
  }

  /* Toggle button */
  .btn-toggle {
    padding: 4px 12px;
    border: none;
    border-radius: 6px;
    font-size: 11px;
    font-weight: 600;
    cursor: pointer;
    transition: opacity 0.2s;
  }
  .btn-toggle:hover { opacity: 0.8; }
  .btn-toggle:disabled { opacity: 0.5; cursor: not-allowed; }
  .btn-danger { background: ${COLORS.loss}; color: white; }
  .btn-success { background: ${COLORS.profit}; color: white; }

  /* Refresh indicator */
  .refresh-info {
    font-size: 10px;
    color: ${COLORS.textDim};
  }

  /* Tooltip */
  .tt {
    border-bottom: 1px dashed ${COLORS.textDim};
    cursor: help;
  }
  #tt-popup {
    position: fixed;
    background: #0b1120;
    border: 1px solid ${COLORS.border};
    color: ${COLORS.text};
    font-size: 11px;
    font-weight: normal;
    letter-spacing: 0;
    text-transform: none;
    padding: 6px 10px;
    border-radius: 6px;
    max-width: 180px;
    white-space: normal;
    line-height: 1.4;
    z-index: 9999;
    pointer-events: none;
    display: none;
  }

  /* Ticker link */
  .ticker-link {
    color: ${COLORS.accent};
    cursor: pointer;
    font-weight: 600;
  }
  .ticker-link:hover { text-decoration: underline; }

  /* Stock modal */
  .modal-overlay {
    position: fixed;
    top: 0; left: 0; right: 0; bottom: 0;
    background: rgba(0,0,0,0.6);
    z-index: 1000;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 16px;
  }
  .modal-content {
    background: ${COLORS.card};
    border: 1px solid ${COLORS.border};
    border-radius: 12px;
    width: 100%;
    max-width: 420px;
    max-height: 80vh;
    overflow-y: auto;
    -webkit-overflow-scrolling: touch;
  }
  .modal-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 16px;
    border-bottom: 1px solid ${COLORS.border};
    position: sticky;
    top: 0;
    background: ${COLORS.card};
    z-index: 1;
  }
  .modal-header h2 {
    font-size: 16px;
    font-weight: 700;
    margin: 0;
  }
  .modal-header .modal-sub {
    font-size: 12px;
    color: ${COLORS.textMuted};
    margin-top: 2px;
  }
  .modal-close {
    background: none;
    border: none;
    color: ${COLORS.textMuted};
    font-size: 20px;
    cursor: pointer;
    padding: 4px 8px;
    line-height: 1;
  }
  .modal-close:hover { color: ${COLORS.text}; }
  .modal-body { padding: 16px; }
  .modal-section {
    font-size: 11px;
    font-weight: 600;
    color: ${COLORS.textMuted};
    text-transform: uppercase;
    letter-spacing: 0.5px;
    margin: 16px 0 8px;
  }
  .modal-section:first-child { margin-top: 0; }
  .modal-row {
    display: flex;
    justify-content: space-between;
    padding: 4px 0;
    font-size: 13px;
  }
  .modal-row-label { color: ${COLORS.textMuted}; }
  .modal-loading {
    text-align: center;
    padding: 32px;
    color: ${COLORS.textDim};
    font-size: 13px;
  }

  /* Modal tabs */
  .modal-tabs {
    display: flex;
    border-bottom: 1px solid ${COLORS.border};
    padding: 0 16px;
    gap: 0;
  }
  .modal-tab {
    padding: 8px 12px;
    font-size: 12px;
    font-weight: 600;
    color: ${COLORS.textDim};
    cursor: pointer;
    border-bottom: 2px solid transparent;
    background: none;
    border-top: none;
    border-left: none;
    border-right: none;
  }
  .modal-tab.active {
    color: ${COLORS.accent};
    border-bottom-color: ${COLORS.accent};
  }

  /* Modal chart */
  .modal-chart {
    padding: 12px 0;
  }
  .modal-chart svg {
    width: 100%;
    display: block;
  }

  /* Chart tooltip */
  .chart-tip {
    position: fixed;
    z-index: 10001;
    background: #1e293b;
    border: 1px solid #334155;
    border-radius: 6px;
    padding: 8px 10px;
    font-size: 11px;
    line-height: 1.6;
    color: #e2e8f0;
    pointer-events: none;
    display: none;
    white-space: nowrap;
    box-shadow: 0 4px 12px rgba(0,0,0,0.3);
  }
  .chart-tip .ct-date {
    font-weight: 600;
    margin-bottom: 2px;
  }
  .chart-tip .ct-row {
    display: flex;
    gap: 12px;
  }
  .chart-tip .ct-label {
    color: #94a3b8;
  }

  /* Signal badge */
  .signal-badge {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    padding: 3px 10px;
    border-radius: 9999px;
    font-size: 12px;
    font-weight: 600;
    white-space: nowrap;
    flex-shrink: 0;
  }
  .signal-buy { background: rgba(34,197,94,0.15); color: ${COLORS.profit}; }
  .signal-sell { background: rgba(239,68,68,0.15); color: ${COLORS.loss}; }
  .signal-neutral { background: rgba(148,163,184,0.15); color: ${COLORS.neutral}; }

  /* Pattern card */
  .pattern-card {
    background: ${COLORS.bg};
    border: 1px solid ${COLORS.border};
    border-radius: 8px;
    padding: 10px 12px;
    margin-top: 8px;
  }
  .pattern-card-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
  }
  .pattern-card-name {
    font-size: 13px;
    font-weight: 600;
  }
  .pattern-card-meta {
    font-size: 11px;
    color: ${COLORS.textMuted};
    margin-top: 4px;
  }

  /* Indicator grid */
  .indicator-grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 6px;
    margin-top: 8px;
  }
  .indicator-item {
    background: ${COLORS.bg};
    border: 1px solid ${COLORS.border};
    border-radius: 8px;
    padding: 8px 10px;
  }
  .indicator-label {
    font-size: 10px;
    color: ${COLORS.textDim};
    text-transform: uppercase;
    letter-spacing: 0.3px;
  }
  .indicator-value {
    font-size: 14px;
    font-weight: 600;
    margin-top: 2px;
  }

  /* Scoring bar */
  .score-bar-wrap {
    margin-top: 6px;
  }
  .score-bar-label {
    display: flex;
    justify-content: space-between;
    font-size: 11px;
    margin-bottom: 3px;
  }
  .score-bar-label span:first-child { color: ${COLORS.textMuted}; }
  .score-bar-track {
    height: 6px;
    background: ${COLORS.bg};
    border-radius: 3px;
    overflow: hidden;
  }
  .score-bar-fill {
    height: 100%;
    border-radius: 3px;
    transition: width 0.3s;
  }
  .quote-loading {
    color: ${COLORS.textDim};
    font-size: 12px;
  }
  .pagination {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 12px;
    margin-top: 12px;
  }
  .pagination-link {
    color: ${COLORS.accent};
    text-decoration: none;
    padding: 6px 12px;
    border-radius: 6px;
    font-size: 14px;
    transition: background 0.2s;
  }
  .pagination-link:hover { background: ${COLORS.cardHover}; }
  .pagination-link.disabled {
    color: ${COLORS.textDim};
    pointer-events: none;
  }
  .pagination-info {
    color: ${COLORS.textMuted};
    font-size: 14px;
  }
`;
