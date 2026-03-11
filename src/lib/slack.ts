/**
 * Slack通知ユーティリティ（自動売買システム用）
 */

const SLACK_WEBHOOK_URL = process.env.SLACK_WEBHOOK_URL;

type SlackColor = "good" | "warning" | "danger" | string;

interface SlackField {
  title: string;
  value: string;
  short?: boolean;
}

interface SlackNotifyOptions {
  title: string;
  message: string;
  color?: SlackColor;
  fields?: SlackField[];
}

/**
 * Slackにメッセージを送信
 */
export async function notifySlack(options: SlackNotifyOptions): Promise<void> {
  if (!SLACK_WEBHOOK_URL) {
    console.log(
      "⚠️  SLACK_WEBHOOK_URL not configured, skipping notification",
    );
    return;
  }

  const payload = {
    attachments: [
      {
        color: options.color || "good",
        title: options.title,
        text: options.message,
        fields: options.fields,
        footer: "Auto Stock Trader",
        ts: Math.floor(Date.now() / 1000),
      },
    ],
  };

  try {
    const response = await fetch(SLACK_WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      console.error(`Slack notification failed: ${response.status}`);
    }
  } catch (error) {
    console.error("Failed to send Slack notification:", error);
  }
}

// ========================================
// 取引専用通知
// ========================================

/** 市場評価通知 */
export async function notifyMarketAssessment(data: {
  shouldTrade: boolean;
  sentiment: string;
  reasoning: string;
  nikkeiChange?: number;
  vix?: number | null;
}): Promise<void> {
  const emoji = data.shouldTrade ? "🟢" : "🔴";
  const action = data.shouldTrade ? "取引実行" : "取引見送り";

  await notifySlack({
    title: `${emoji} 市場評価: ${action}`,
    message: data.reasoning,
    color: data.shouldTrade ? "good" : "warning",
    fields: [
      { title: "センチメント", value: data.sentiment, short: true },
      {
        title: "日経変化率",
        value: data.nikkeiChange != null ? `${data.nikkeiChange}%` : "N/A",
        short: true,
      },
      {
        title: "VIX",
        value: data.vix != null ? `${data.vix}` : "N/A",
        short: true,
      },
    ],
  });
}

/** 銘柄候補通知 */
export async function notifyStockCandidates(
  candidates: Array<{
    tickerCode: string;
    name?: string;
    strategy: string;
    score: number;
    reasoning: string;
  }>,
): Promise<void> {
  const list = candidates
    .map(
      (c, i) =>
        `${i + 1}. ${c.tickerCode}${c.name ? ` ${c.name}` : ""} [${c.strategy}] スコア:${c.score}\n   ${c.reasoning}`,
    )
    .join("\n");

  await notifySlack({
    title: `📊 AI選定銘柄: ${candidates.length}件`,
    message: list,
    color: "#439FE0",
  });
}

/** 注文発行通知 */
export async function notifyOrderPlaced(data: {
  tickerCode: string;
  name?: string;
  side: string;
  strategy: string;
  limitPrice: number;
  takeProfitPrice?: number;
  stopLossPrice?: number;
  quantity: number;
  reasoning: string;
}): Promise<void> {
  const emoji = data.side === "buy" ? "📥" : "📤";
  const fields: SlackField[] = [
    { title: "指値", value: `¥${data.limitPrice.toLocaleString()}`, short: true },
    { title: "数量", value: `${data.quantity}株`, short: true },
    { title: "戦略", value: data.strategy, short: true },
  ];

  if (data.takeProfitPrice) {
    fields.push({
      title: "利確",
      value: `¥${data.takeProfitPrice.toLocaleString()}`,
      short: true,
    });
  }
  if (data.stopLossPrice) {
    fields.push({
      title: "損切り",
      value: `¥${data.stopLossPrice.toLocaleString()}`,
      short: true,
    });
  }

  await notifySlack({
    title: `${emoji} 注文発行: ${data.tickerCode}${data.name ? ` ${data.name}` : ""} [${data.side.toUpperCase()}]`,
    message: data.reasoning,
    color: data.side === "buy" ? "#2196F3" : "#FF9800",
    fields,
  });
}

/** 約定通知 */
export async function notifyOrderFilled(data: {
  tickerCode: string;
  name?: string;
  side: string;
  filledPrice: number;
  quantity: number;
  pnl?: number;
}): Promise<void> {
  const emoji = data.side === "buy" ? "✅" : "💰";
  const fields: SlackField[] = [
    {
      title: "約定価格",
      value: `¥${data.filledPrice.toLocaleString()}`,
      short: true,
    },
    { title: "数量", value: `${data.quantity}株`, short: true },
  ];

  if (data.pnl != null) {
    const pnlEmoji = data.pnl >= 0 ? "📈" : "📉";
    fields.push({
      title: "損益",
      value: `${pnlEmoji} ¥${data.pnl.toLocaleString()}`,
      short: true,
    });
  }

  await notifySlack({
    title: `${emoji} 約定: ${data.tickerCode}${data.name ? ` ${data.name}` : ""} [${data.side.toUpperCase()}]`,
    message: `約定価格 ¥${data.filledPrice.toLocaleString()} × ${data.quantity}株`,
    color: data.pnl != null ? (data.pnl >= 0 ? "good" : "danger") : "#439FE0",
    fields,
  });
}

/** 日次レポート通知 */
export async function notifyDailyReport(data: {
  date: string;
  totalTrades: number;
  wins: number;
  losses: number;
  totalPnl: number;
  portfolioValue: number;
  cashBalance: number;
  aiReview?: string;
}): Promise<void> {
  const winRate =
    data.totalTrades > 0
      ? Math.round((data.wins / data.totalTrades) * 100)
      : 0;
  const pnlEmoji = data.totalPnl >= 0 ? "📈" : "📉";

  await notifySlack({
    title: `📋 日次レポート: ${data.date}`,
    message: data.aiReview || "",
    color: data.totalPnl >= 0 ? "good" : "danger",
    fields: [
      {
        title: "損益",
        value: `${pnlEmoji} ¥${data.totalPnl.toLocaleString()}`,
        short: true,
      },
      {
        title: "勝率",
        value: `${data.wins}勝${data.losses}敗 (${winRate}%)`,
        short: true,
      },
      {
        title: "ポートフォリオ",
        value: `¥${data.portfolioValue.toLocaleString()}`,
        short: true,
      },
      {
        title: "現金残高",
        value: `¥${data.cashBalance.toLocaleString()}`,
        short: true,
      },
    ],
  });
}

/** リスクアラート */
export async function notifyRiskAlert(data: {
  type: string;
  message: string;
}): Promise<void> {
  await notifySlack({
    title: `🚨 リスクアラート: ${data.type}`,
    message: data.message,
    color: "danger",
  });
}

/** 日次バックテスト結果通知 */
export async function notifyBacktestResult(data: {
  tickers: number;
  period: string;
  dataFetchTimeMs: number;
  totalTimeMs: number;
  tierResults: Array<{
    label: string;
    winRate: number;
    profitFactor: number;
    totalReturnPct: number;
    totalPnl: number;
    totalTrades: number;
    maxDrawdown: number;
  }>;
}): Promise<void> {
  const tierLines = data.tierResults
    .map((t) => {
      const pnlSign = t.totalPnl >= 0 ? "+" : "";
      const pf =
        t.profitFactor === Infinity ? "∞" : t.profitFactor.toFixed(2);
      return `${t.label}: 勝率${t.winRate}% | PF ${pf} | ${pnlSign}${t.totalReturnPct}% (${pnlSign}¥${t.totalPnl.toLocaleString()}) | DD -${t.maxDrawdown}% | ${t.totalTrades}件`;
    })
    .join("\n");

  await notifySlack({
    title: "📊 日次バックテスト完了",
    message: tierLines,
    color: "#439FE0",
    fields: [
      {
        title: "対象銘柄",
        value: `${data.tickers}銘柄`,
        short: true,
      },
      { title: "期間", value: data.period, short: true },
      {
        title: "実行時間",
        value: `${(data.totalTimeMs / 1000).toFixed(1)}秒`,
        short: true,
      },
    ],
  });
}

/** 逆行ウィナー通知（市場停止日に上昇した銘柄） */
export async function notifyContrarianWinners(data: {
  totalHalted: number;
  winners: Array<{
    tickerCode: string;
    score: number;
    rank: string;
    ghostProfitPct: number;
    contrarianWins?: number;
  }>;
}): Promise<void> {
  if (data.winners.length === 0) return;

  const winnerList = data.winners
    .map(
      (w, i) =>
        `${i + 1}. ${w.tickerCode} [${w.rank}:${w.score}点] +${w.ghostProfitPct.toFixed(2)}%${
          w.contrarianWins != null && w.contrarianWins > 0
            ? ` (過去90日: ${w.contrarianWins}回逆行勝ち)`
            : ""
        }`,
    )
    .join("\n");

  await notifySlack({
    title: `🦬 逆行ウィナー: ${data.winners.length}銘柄が市場停止日に上昇`,
    message: winnerList,
    color: "#FF6B35",
    fields: [
      {
        title: "市場停止銘柄数",
        value: `${data.totalHalted}件`,
        short: true,
      },
      {
        title: "上昇銘柄数",
        value: `${data.winners.length}件`,
        short: true,
      },
    ],
  });
}

/** ゴースト・トレーディング分析通知 */
export async function notifyGhostReview(data: {
  totalRejected: number;
  totalProfitable: number;
  totalLoss: number;
  avgProfitPct: number;
  topMissed: Array<{
    tickerCode: string;
    score: number;
    rank: string;
    rejectionReason: string;
    ghostProfitPct: number;
    misjudgmentType?: string;
  }>;
}): Promise<void> {
  const reasonLabel: Record<string, string> = {
    below_threshold: "閾値未達",
    ai_no_go: "AI見送り",
    disqualified: "即死ルール",
  };

  const missedList =
    data.topMissed
      .map(
        (m, i) =>
          `${i + 1}. ${m.tickerCode} [${m.rank}:${m.score}点] +${m.ghostProfitPct.toFixed(2)}% (${reasonLabel[m.rejectionReason] || m.rejectionReason})${m.misjudgmentType ? ` → ${m.misjudgmentType}` : ""}`,
      )
      .join("\n") || "利益が出ていた見送り銘柄はありませんでした";

  await notifySlack({
    title: `👻 ゴースト・トレード分析: ${data.totalProfitable}件の機会損失`,
    message: missedList,
    color: data.totalProfitable > 0 ? "warning" : "good",
    fields: [
      {
        title: "見送り銘柄数",
        value: `${data.totalRejected}件`,
        short: true,
      },
      {
        title: "利益/損失",
        value: `📈${data.totalProfitable}件 / 📉${data.totalLoss}件`,
        short: true,
      },
      {
        title: "平均利益率(利益銘柄)",
        value:
          data.totalProfitable > 0
            ? `+${data.avgProfitPct.toFixed(2)}%`
            : "N/A",
        short: true,
      },
    ],
  });
}

/** スコアリング精度レポート通知 */
export async function notifyScoringAccuracyReport(data: {
  periodLabel: string;
  totalRecords: number;
  missedCount: number;
  categoryWeakness: Array<{
    category: string;
    avgDeficit: number;
    maxScore: number;
  }>;
  rankAccuracy: Array<{
    rank: string;
    avgProfitPct: number;
    positiveRate: number;
    count: number;
  }>;
  rejectionCost: Array<{
    reason: string;
    count: number;
    profitableCount: number;
    avgMissedProfit: number;
  }>;
  weeklyStats: { positiveRate: number; avgProfit: number };
  monthlyStats: { positiveRate: number; avgProfit: number };
}): Promise<void> {
  const reasonLabel: Record<string, string> = {
    below_threshold: "閾値未達",
    ai_no_go: "AI見送り",
    disqualified: "即死ルール",
    market_halted: "市場停止",
  };

  // カテゴリ別弱点
  const categoryLines = data.categoryWeakness
    .sort((a, b) => b.avgDeficit - a.avgDeficit)
    .map(
      (c, i) =>
        `${i + 1}. ${c.category}: 平均 -${c.avgDeficit.toFixed(1)}pt / ${c.maxScore}pt`,
    )
    .join("\n");

  // ランク別実績
  const rankLines = data.rankAccuracy
    .map((r) => {
      const sign = r.avgProfitPct >= 0 ? "+" : "";
      return `${r.rank}: 平均${sign}${r.avgProfitPct.toFixed(2)}% / 上昇率${r.positiveRate.toFixed(0)}% (${r.count}件)`;
    })
    .join("\n");

  // 却下理由別
  const rejectionLines = data.rejectionCost
    .filter((r) => r.count > 0)
    .map((r) => {
      const label = reasonLabel[r.reason] || r.reason;
      const avgStr =
        r.profitableCount > 0
          ? `平均+${r.avgMissedProfit.toFixed(2)}%`
          : "N/A";
      return `${label}: ${r.count}件中${r.profitableCount}件上昇 → ${avgStr}`;
    })
    .join("\n");

  // トレンド
  const trendArrow =
    data.weeklyStats.positiveRate > data.monthlyStats.positiveRate
      ? "↗ 改善"
      : data.weeklyStats.positiveRate < data.monthlyStats.positiveRate
        ? "↘ 低下"
        : "→ 横ばい";

  const trendLines = [
    `今週: 上昇率${data.weeklyStats.positiveRate.toFixed(0)}% / 平均${data.weeklyStats.avgProfit >= 0 ? "+" : ""}${data.weeklyStats.avgProfit.toFixed(2)}%`,
    `月次: 上昇率${data.monthlyStats.positiveRate.toFixed(0)}% / 平均${data.monthlyStats.avgProfit >= 0 ? "+" : ""}${data.monthlyStats.avgProfit.toFixed(2)}%`,
  ].join("\n");

  const message = [
    "━━ カテゴリ別弱点 ━━",
    categoryLines || "データなし",
    "",
    "━━ ランク別実績 ━━",
    rankLines || "データなし",
    "",
    "━━ 却下理由別の機会損失 ━━",
    rejectionLines || "データなし",
    "",
    "━━ トレンド ━━",
    trendLines,
  ].join("\n");

  // Sランクの上昇率を取得
  const sRank = data.rankAccuracy.find((r) => r.rank === "S");
  const sRankPositiveRate = sRank ? `${sRank.positiveRate.toFixed(0)}%` : "N/A";

  await notifySlack({
    title: `🎯 スコアリング精度レポート（${data.periodLabel}）`,
    message,
    color: data.missedCount > 0 ? "warning" : "good",
    fields: [
      {
        title: "対象レコード数",
        value: `${data.totalRecords}件`,
        short: true,
      },
      {
        title: "見逃し銘柄数",
        value: `${data.missedCount}件`,
        short: true,
      },
      {
        title: "Sランク上昇率",
        value: sRankPositiveRate,
        short: true,
      },
      {
        title: "トレンド",
        value: trendArrow,
        short: true,
      },
    ],
  });
}

/** 未約定注文フォローアップ通知 */
export async function notifyUnfilledOrderFollowUp(data: {
  newCount: number;
  updatedCount: number;
  completedCount: number;
  totalTracking: number;
  stats: {
    totalCompleted: number;
    reachRate: number;
    avgDay5Pnl: number;
    avgGapPct: number;
    profitableIfReachedCount: number;
    reachedCount: number;
  };
  topMissed: Array<{
    tickerCode: string;
    limitPrice: number;
    day5Price: number;
    day5PnlPct: number;
    gapPct: number;
  }>;
}): Promise<void> {
  const missedList =
    data.topMissed
      .map(
        (m, i) =>
          `${i + 1}. ${m.tickerCode} 指値¥${m.limitPrice.toLocaleString()} → 5日後¥${m.day5Price.toLocaleString()} (+${m.day5PnlPct.toFixed(2)}%) 乖離${m.gapPct.toFixed(2)}%`,
      )
      .join("\n") || "指値到達かつ利益の見逃し銘柄なし";

  const message = [
    `新規: ${data.newCount}件 | 更新: ${data.updatedCount}件 | 完了: ${data.completedCount}件`,
    "",
    `[完了分サマリ（直近${data.stats.totalCompleted}件）]`,
    `指値到達率: ${data.stats.reachRate.toFixed(0)}% (${data.stats.reachedCount}/${data.stats.totalCompleted}件)`,
    `5日後平均損益: ${data.stats.avgDay5Pnl >= 0 ? "+" : ""}${data.stats.avgDay5Pnl.toFixed(2)}%（指値で買えていた場合）`,
    `平均指値乖離: ${data.stats.avgGapPct.toFixed(2)}%`,
    "",
    "[見逃し上位]",
    missedList,
  ].join("\n");

  await notifySlack({
    title: `📋 未約定注文フォローアップ: ${data.totalTracking}件追跡中`,
    message,
    color: data.stats.profitableIfReachedCount > 0 ? "warning" : "good",
    fields: [
      {
        title: "指値到達率",
        value: `${data.stats.reachRate.toFixed(0)}%`,
        short: true,
      },
      {
        title: "5日後平均損益",
        value: `${data.stats.avgDay5Pnl >= 0 ? "+" : ""}${data.stats.avgDay5Pnl.toFixed(2)}%`,
        short: true,
      },
      {
        title: "平均指値乖離",
        value: `${data.stats.avgGapPct.toFixed(2)}%`,
        short: true,
      },
      {
        title: "到達+利益",
        value: `${data.stats.profitableIfReachedCount}件`,
        short: true,
      },
    ],
  });
}
