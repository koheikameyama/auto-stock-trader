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
        title: "勝敗",
        value: `${data.wins}勝${data.losses}敗`,
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
  conditionResults: Array<{
    key: string;
    label: string;
    winRate: number;
    expectancy: number;
    profitFactor: number;
    totalReturnPct: number;
    totalPnl: number;
    totalTrades: number;
    maxDrawdown: number;
  }>;
  paperTradeResult?: {
    newLabel: string;
    oldLabel: string;
    newPf: number;
    newWinRate: number;
    newExpectancy: number;
    newReturnPct: number;
    newMaxDd: number;
    newTrades: number;
    oldPf: number;
    oldWinRate: number;
    oldExpectancy: number;
    oldReturnPct: number;
    oldMaxDd: number;
    oldTrades: number;
    elapsedDays: number;
    targetDays: number;
    judgment: "go" | "tracking" | "no_go";
    judgmentReasons: string[];
  };
}): Promise<void> {
  const lines: string[] = [];

  // ベースラインを先頭に表示
  const baseline = data.conditionResults.find((c) => c.key === "baseline");
  if (baseline) {
    const pf = baseline.profitFactor === Infinity ? "∞" : baseline.profitFactor.toFixed(2);
    const sign = baseline.totalReturnPct >= 0 ? "+" : "";
    const expSign = baseline.expectancy >= 0 ? "+" : "";
    lines.push(`*${baseline.label}*: 期待値${expSign}${baseline.expectancy.toFixed(2)}% | PF ${pf} | ${sign}${baseline.totalReturnPct}% | DD -${baseline.maxDrawdown}% | ${baseline.totalTrades}件`);
    lines.push("");
  }

  // パラメータ軸ごとにグループ化して1行ずつ表示
  const axisOrder = ["ts_act", "score", "atr", "trail"];
  for (const axis of axisOrder) {
    const conditions = data.conditionResults.filter(
      (c) => c.key !== "baseline" && c.key.startsWith(axis),
    );
    if (conditions.length === 0) continue;

    const condLine = conditions
      .map((c) => {
        const pf = c.profitFactor === Infinity ? "∞" : c.profitFactor.toFixed(2);
        return `${c.label}: PF ${pf}`;
      })
      .join(" | ");
    lines.push(condLine);
  }

  // ペーパートレード追跡セクション
  if (data.paperTradeResult) {
    const pt = data.paperTradeResult;
    lines.push("");

    const icon = pt.judgment === "go" ? "🎯" : pt.judgment === "no_go" ? "⚠️" : "📊";
    const judgmentLabel = pt.judgment === "go" ? "✅ Go" : pt.judgment === "no_go" ? "❌ No-Go" : "追跡中";
    lines.push(`${icon} ペーパートレード追跡（${pt.elapsedDays}/${pt.targetDays}営業日）`);

    const fmtPf = (pf: number) => (pf === Infinity ? "∞" : pf.toFixed(2));
    const fmtSign = (v: number) => (v >= 0 ? "+" : "");
    const fmtExp = (v: number) => (v >= 0 ? "+" : "") + v.toFixed(2);

    lines.push(
      `${pt.newLabel}: PF ${fmtPf(pt.newPf)} | 期待値${fmtExp(pt.newExpectancy)}% | ${fmtSign(pt.newReturnPct)}${pt.newReturnPct}% | DD -${pt.newMaxDd}% | ${pt.newTrades}件`,
    );
    lines.push(
      `${pt.oldLabel}: PF ${fmtPf(pt.oldPf)} | 期待値${fmtExp(pt.oldExpectancy)}% | ${fmtSign(pt.oldReturnPct)}${pt.oldReturnPct}% | DD -${pt.oldMaxDd}% | ${pt.oldTrades}件`,
    );
    lines.push(`Go判定: ${judgmentLabel}（${pt.judgmentReasons.join(" ")}）`);

    if (pt.judgment === "go") {
      lines.push("→ 本番投入を推奨");
    } else if (pt.judgment === "no_go") {
      lines.push("→ パラメータ再検討を推奨");
    }
  }

  await notifySlack({
    title: "📊 日次バックテスト完了",
    message: lines.join("\n"),
    color: "#439FE0",
    fields: [
      {
        title: "対象銘柄",
        value: `${data.tickers}銘柄`,
        short: true,
      },
      { title: "期間", value: data.period, short: true },
      {
        title: "条件数",
        value: `${data.conditionResults.length}条件`,
        short: true,
      },
      {
        title: "実行時間",
        value: `${(data.totalTimeMs / 1000).toFixed(1)}秒`,
        short: true,
      },
    ],
  });
}

/** 逆行ウィナー通知（取引見送り日に上昇した銘柄） */
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
    title: `🦬 逆行ウィナー: ${data.winners.length}銘柄が取引見送り日に上昇`,
    message: winnerList,
    color: "#FF6B35",
    fields: [
      {
        title: "見送り銘柄数",
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

/** スコアリング精度分析 日次通知 */
export async function notifyScoringAccuracy(data: {
  confusionMatrix: {
    tp: number;
    fp: number;
    fn: number;
    tn: number;
    precision: number | null;
    recall: number | null;
    f1: number | null;
  };
  byRank: Record<string, { tp: number; fp: number; fn: number; tn: number; precision: number | null }>;
  fpList: Array<{
    tickerCode: string;
    score: number;
    rank: string;
    profitPct: number;
    misjudgmentType?: string;
  }>;
  fnList: Array<{
    tickerCode: string;
    score: number;
    rank: string;
    profitPct: number;
    rejectionReason: string;
    misjudgmentType?: string;
  }>;
}): Promise<void> {
  const { tp, fp, fn, tn, precision, recall, f1 } = data.confusionMatrix;

  const precisionStr = precision != null ? `${precision.toFixed(1)}%` : "N/A";
  const recallStr = recall != null ? `${recall.toFixed(1)}%` : "N/A";
  const f1Str = f1 != null ? `${f1.toFixed(1)}%` : "N/A";

  // ランク別 Precision
  const rankLines = Object.entries(data.byRank)
    .filter(([, v]) => v.tp + v.fp > 0)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([rank, v]) => {
      const total = v.tp + v.fp;
      const pStr = v.precision != null ? `${v.precision.toFixed(1)}%` : "N/A";
      return `${rank}: ${pStr} (${v.tp}/${total})`;
    })
    .join(" | ");

  const reasonLabel: Record<string, string> = {
    below_threshold: "閾値未達",
    ai_no_go: "AI見送り",
    disqualified: "即死ルール",
    market_halted: "取引見送り",
  };

  // FP注目銘柄
  const fpLines =
    data.fpList
      .map(
        (m, i) =>
          `${i + 1}. ${m.tickerCode} [${m.rank}:${m.score}点] ${m.profitPct.toFixed(2)}%${m.misjudgmentType ? ` → ${m.misjudgmentType}` : ""}`,
      )
      .join("\n") || "なし";

  // FN注目銘柄
  const fnLines =
    data.fnList
      .map(
        (m, i) =>
          `${i + 1}. ${m.tickerCode} [${m.rank}:${m.score}点] +${m.profitPct.toFixed(2)}% (${reasonLabel[m.rejectionReason] || m.rejectionReason})${m.misjudgmentType ? ` → ${m.misjudgmentType}` : ""}`,
      )
      .join("\n") || "なし";

  const message = [
    "━━ 精度メトリクス ━━",
    `Precision: ${precisionStr} | Recall: ${recallStr} | F1: ${f1Str}`,
    "",
    "━━ 4象限 ━━",
    `✅ TP（買い→上昇）: ${tp}件  |  ❌ FP（買い→下落）: ${fp}件`,
    `⚠️ FN（見送り→上昇）: ${fn}件 | ✅ TN（見送り→下落）: ${tn}件`,
    "",
    rankLines ? `━━ ランク別 Precision ━━\n${rankLines}` : "",
    "",
    "━━ FP注目銘柄（買ったが下落） ━━",
    fpLines,
    "",
    "━━ FN注目銘柄（見逃し） ━━",
    fnLines,
  ]
    .filter(Boolean)
    .join("\n");

  await notifySlack({
    title: "📊 スコアリング精度分析",
    message,
    color: fp > 0 || fn > 0 ? "warning" : "good",
    fields: [
      { title: "Precision", value: precisionStr, short: true },
      { title: "Recall", value: recallStr, short: true },
      { title: "総スコアリング数", value: `${tp + fp + fn + tn}件`, short: true },
      { title: "F1", value: f1Str, short: true },
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
  precisionTrend: { weekly: number | null; monthly: number | null };
  recallTrend: { weekly: number | null; monthly: number | null };
  f1Trend: { weekly: number | null; monthly: number | null };
  fpPatternDist: Record<string, number>;
}): Promise<void> {
  const reasonLabel: Record<string, string> = {
    below_threshold: "閾値未達",
    ai_no_go: "AI見送り",
    disqualified: "即死ルール",
    market_halted: "取引見送り",
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

  const fmtPct = (v: number | null) =>
    v != null ? `${v.toFixed(1)}%` : "N/A";

  const matrixTrend = [
    "━━ 4象限メトリクス推移 ━━",
    `Precision: 週次${fmtPct(data.precisionTrend.weekly)} / 月次${fmtPct(data.precisionTrend.monthly)}`,
    `Recall: 週次${fmtPct(data.recallTrend.weekly)} / 月次${fmtPct(data.recallTrend.monthly)}`,
    `F1: 週次${fmtPct(data.f1Trend.weekly)} / 月次${fmtPct(data.f1Trend.monthly)}`,
  ].join("\n");

  const fpPatternLabel: Record<string, string> = {
    score_inflated: "スコア過大評価",
    ai_overconfident: "AI楽観",
    market_shift: "市場変化",
    acceptable_loss: "許容範囲",
  };
  const fpPatternEntries = Object.entries(data.fpPatternDist);
  const fpPatternLines = fpPatternEntries.length > 0
    ? fpPatternEntries
        .sort(([, a], [, b]) => b - a)
        .map(([type, count]) => `${fpPatternLabel[type] || type}: ${count}件`)
        .join(" / ")
    : "データなし";
  const fpPatternSection = `━━ FPパターン分布 ━━\n${fpPatternLines}`;

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
    "",
    matrixTrend,
    "",
    fpPatternSection,
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
