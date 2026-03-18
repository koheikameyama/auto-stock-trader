/**
 * スコアリングコンポーネント別分析
 *
 * 各スコア要素（MA整列、BO後押し目、プルバック等）と
 * トレード結果（損益）の相関を分析し、どの要素が予測力を持ち
 * どの要素が逆効果かを特定する。
 */

import type { BacktestResult, SimulatedPosition, ScoreBreakdown } from "./types";

interface ComponentBin {
  label: string;
  trades: number;
  wins: number;
  winRate: number;
  avgPnlPct: number;
  expectancy: number;
}

interface ComponentAnalysis {
  name: string;
  maxScore: number;
  bins: ComponentBin[];
  correlation: number;
}

/**
 * コンポーネント別分析を実行してコンソール出力
 */
export function printComponentAnalysis(result: BacktestResult): void {
  const trades = result.trades.filter(
    (t) => t.scoreBreakdown != null && t.pnlPct != null && t.exitReason !== "still_open",
  );

  if (trades.length === 0) {
    console.log("\n[component-analysis] scoreBreakdown 付きのトレードがありません");
    return;
  }

  console.log("");
  console.log("=".repeat(60));
  console.log("  スコアリングコンポーネント別分析");
  console.log(`  対象トレード: ${trades.length}件`);
  console.log("=".repeat(60));

  // カテゴリ別分析
  const categoryAnalyses = analyzeCategoryScores(trades);
  for (const analysis of categoryAnalyses) {
    printAnalysis(analysis);
  }

  // サブコンポーネント別分析
  const subAnalyses = analyzeSubComponentScores(trades);
  for (const analysis of subAnalyses) {
    printAnalysis(analysis);
  }

  // 相関ランキング
  printCorrelationRanking([...categoryAnalyses, ...subAnalyses]);
}

/**
 * カテゴリ（trendQuality/entryTiming/riskQuality/sectorMomentum）別
 */
function analyzeCategoryScores(trades: SimulatedPosition[]): ComponentAnalysis[] {
  const extractors: { name: string; maxScore: number; extract: (b: ScoreBreakdown) => number }[] = [
    { name: "トレンド品質 (40点)", maxScore: 40, extract: (b) => b.trendQuality.total },
    { name: "エントリータイミング (35点)", maxScore: 35, extract: (b) => b.entryTiming.total },
    { name: "リスク品質 (20点)", maxScore: 20, extract: (b) => b.riskQuality.total },
    { name: "セクターモメンタム (5点)", maxScore: 5, extract: (b) => b.sectorMomentum },
  ];

  return extractors.map(({ name, maxScore, extract }) =>
    analyzeComponent(name, maxScore, trades, (t) => extract(t.scoreBreakdown!)),
  );
}

/**
 * サブコンポーネント（maAlignment, pullbackDepth, priorBreakout 等）別
 */
function analyzeSubComponentScores(trades: SimulatedPosition[]): ComponentAnalysis[] {
  const extractors: { name: string; maxScore: number; extract: (b: ScoreBreakdown) => number }[] = [
    // Trend Quality
    { name: "  MA整列 (18点)", maxScore: 18, extract: (b) => b.trendQuality.maAlignment },
    { name: "  週足トレンド (12点)", maxScore: 12, extract: (b) => b.trendQuality.weeklyTrend },
    { name: "  トレンド継続性 (10点)", maxScore: 10, extract: (b) => b.trendQuality.trendContinuity },
    // Entry Timing
    { name: "  プルバック深度 (15点)", maxScore: 15, extract: (b) => b.entryTiming.pullbackDepth },
    { name: "  BO後押し目 (12点)", maxScore: 12, extract: (b) => b.entryTiming.priorBreakout },
    { name: "  ローソク足シグナル (8点)", maxScore: 8, extract: (b) => b.entryTiming.candlestickSignal },
    // Risk Quality
    { name: "  ATR安定性 (10点)", maxScore: 10, extract: (b) => b.riskQuality.atrStability },
    { name: "  レンジ収縮 (8点)", maxScore: 8, extract: (b) => b.riskQuality.rangeContraction },
    { name: "  出来高安定性 (2点)", maxScore: 2, extract: (b) => b.riskQuality.volumeStability },
  ];

  return extractors.map(({ name, maxScore, extract }) =>
    analyzeComponent(name, maxScore, trades, (t) => extract(t.scoreBreakdown!)),
  );
}

/**
 * 1つのコンポーネントについてビン分析 + 相関を計算
 */
function analyzeComponent(
  name: string,
  maxScore: number,
  trades: SimulatedPosition[],
  getScore: (t: SimulatedPosition) => number,
): ComponentAnalysis {
  // スコアの分布に基づいて適切なビンを作成
  const scores = trades.map(getScore);
  const uniqueScores = [...new Set(scores)].sort((a, b) => a - b);

  let bins: ComponentBin[];
  if (uniqueScores.length <= 5) {
    // ユニーク値が少ない場合は各値ごとにビン化
    bins = uniqueScores.map((score) => {
      const binTrades = trades.filter((t) => getScore(t) === score);
      return createBin(String(score), binTrades);
    });
  } else {
    // 三分位でビン化（低・中・高）
    const sorted = [...scores].sort((a, b) => a - b);
    const p33 = sorted[Math.floor(sorted.length / 3)];
    const p67 = sorted[Math.floor((sorted.length * 2) / 3)];

    const lowTrades = trades.filter((t) => getScore(t) <= p33);
    const midTrades = trades.filter((t) => getScore(t) > p33 && getScore(t) <= p67);
    const highTrades = trades.filter((t) => getScore(t) > p67);

    bins = [
      createBin(`低 (0-${p33})`, lowTrades),
      createBin(`中 (${p33 + 1}-${p67})`, midTrades),
      createBin(`高 (${p67 + 1}-${maxScore})`, highTrades),
    ].filter((b) => b.trades > 0);
  }

  // ピアソン相関係数
  const correlation = computeCorrelation(
    trades.map(getScore),
    trades.map((t) => t.pnlPct!),
  );

  return { name, maxScore, bins, correlation };
}

function createBin(label: string, trades: SimulatedPosition[]): ComponentBin {
  if (trades.length === 0) {
    return { label, trades: 0, wins: 0, winRate: 0, avgPnlPct: 0, expectancy: 0 };
  }
  const wins = trades.filter((t) => (t.pnlPct ?? 0) > 0).length;
  const pnls = trades.map((t) => t.pnlPct!);
  const avgPnlPct = pnls.reduce((s, p) => s + p, 0) / pnls.length;
  const winRate = (wins / trades.length) * 100;

  return {
    label,
    trades: trades.length,
    wins,
    winRate: Math.round(winRate * 10) / 10,
    avgPnlPct: Math.round(avgPnlPct * 100) / 100,
    expectancy: Math.round(avgPnlPct * 100) / 100,
  };
}

function computeCorrelation(x: number[], y: number[]): number {
  const n = x.length;
  if (n < 3) return 0;

  const meanX = x.reduce((s, v) => s + v, 0) / n;
  const meanY = y.reduce((s, v) => s + v, 0) / n;

  let sumXY = 0;
  let sumX2 = 0;
  let sumY2 = 0;

  for (let i = 0; i < n; i++) {
    const dx = x[i] - meanX;
    const dy = y[i] - meanY;
    sumXY += dx * dy;
    sumX2 += dx * dx;
    sumY2 += dy * dy;
  }

  const denom = Math.sqrt(sumX2 * sumY2);
  if (denom === 0) return 0;
  return Math.round((sumXY / denom) * 1000) / 1000;
}

function printAnalysis(analysis: ComponentAnalysis): void {
  const corrLabel = analysis.correlation > 0.05
    ? `+${analysis.correlation} ✅`
    : analysis.correlation < -0.05
      ? `${analysis.correlation} ❌`
      : `${analysis.correlation} ➖`;

  console.log("");
  console.log(`--- ${analysis.name}  相関: ${corrLabel} ---`);
  console.log("  帯         件数    勝率     平均損益    期待値");
  for (const bin of analysis.bins) {
    const pnlSign = bin.avgPnlPct >= 0 ? "+" : "";
    console.log(
      `  ${bin.label.padEnd(12)} ${String(bin.trades).padStart(5)}   ${String(bin.winRate + "%").padStart(6)}   ${(pnlSign + bin.avgPnlPct + "%").padStart(8)}   ${(pnlSign + bin.expectancy + "%").padStart(8)}`,
    );
  }
}

function printCorrelationRanking(analyses: ComponentAnalysis[]): void {
  console.log("");
  console.log("=".repeat(60));
  console.log("  相関ランキング（スコア要素 × 損益の相関係数）");
  console.log("=".repeat(60));

  const sorted = [...analyses].sort((a, b) => b.correlation - a.correlation);

  for (const a of sorted) {
    const bar = a.correlation > 0
      ? "█".repeat(Math.round(a.correlation * 20))
      : "░".repeat(Math.round(Math.abs(a.correlation) * 20));
    const sign = a.correlation > 0.05 ? "✅" : a.correlation < -0.05 ? "❌" : "➖";
    console.log(`  ${sign} ${a.correlation > 0 ? "+" : ""}${a.correlation.toFixed(3)}  ${bar}  ${a.name}`);
  }

  console.log("");
  console.log("  ✅ = 正の相関（高スコア → 高リターン）");
  console.log("  ❌ = 負の相関（高スコア → 低リターン = 逆効果）");
  console.log("  ➖ = 相関なし（予測力なし）");
  console.log("");
}
