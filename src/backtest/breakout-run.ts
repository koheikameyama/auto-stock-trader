/**
 * ブレイクアウトバックテスト実行スクリプト
 *
 * Usage:
 *   npm run backtest:breakout
 *   npm run backtest:breakout -- --start 2025-04-01 --end 2026-03-25
 *   npm run backtest:breakout -- --verbose
 *   npm run backtest:breakout -- --budget 1000000
 */

import dayjs from "dayjs";
import { prisma } from "../lib/prisma";
import { BREAKOUT_BACKTEST_DEFAULTS } from "./breakout-config";
import { runBreakoutBacktest } from "./breakout-simulation";
import { fetchHistoricalFromDB, fetchVixFromDB } from "./data-fetcher";
import { calculateCapitalUtilization } from "./metrics";
import type { BreakoutBacktestConfig, BreakoutBacktestResult, PerformanceMetrics, ScoreFilterConfig } from "./types";
import { saveBacktestResult } from "./db-saver";
import type { OHLCVData } from "../core/technical-analysis";

function getArg(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  return idx >= 0 && idx + 1 < args.length ? args[idx + 1] : undefined;
}

interface ComparisonRow {
  label: string;
  filter: ScoreFilterConfig | undefined;
}

const COMPARISON_GRID: ComparisonRow[] = [
  { label: "(none)", filter: undefined },
  { label: "total >= 40", filter: { category: "total", minScore: 40 } },
  { label: "total >= 50", filter: { category: "total", minScore: 50 } },
  { label: "total >= 60", filter: { category: "total", minScore: 60 } },
  { label: "total >= 70", filter: { category: "total", minScore: 70 } },
  { label: "trend >= 15", filter: { category: "trend", minScore: 15 } },
  { label: "trend >= 20", filter: { category: "trend", minScore: 20 } },
  { label: "trend >= 25", filter: { category: "trend", minScore: 25 } },
  { label: "timing >= 15", filter: { category: "timing", minScore: 15 } },
  { label: "timing >= 20", filter: { category: "timing", minScore: 20 } },
  { label: "timing >= 25", filter: { category: "timing", minScore: 25 } },
  { label: "risk >= 10", filter: { category: "risk", minScore: 10 } },
  { label: "risk >= 15", filter: { category: "risk", minScore: 15 } },
  { label: "risk >= 20", filter: { category: "risk", minScore: 20 } },
];

function runScoreComparison(
  baseConfig: BreakoutBacktestConfig,
  allData: Map<string, OHLCVData[]>,
  vixData: Map<string, number> | undefined,
): void {
  console.log("\n=== Score Filter Comparison ===");
  console.log(
    `${"Filter".padEnd(16)}| ${"Trades".padStart(6)} | ${"WinRate".padStart(7)} | ${"PF".padStart(5)} | ${"Expect".padStart(8)} | ${"MaxDD".padStart(7)} | ${"RR".padStart(5)}`,
  );
  console.log("-".repeat(68));

  for (const row of COMPARISON_GRID) {
    const config: BreakoutBacktestConfig = {
      ...baseConfig,
      scoreFilter: row.filter,
      verbose: false,
    };
    const result = runBreakoutBacktest(config, allData, vixData);
    const m = result.metrics;
    const expectStr = (m.expectancy >= 0 ? "+" : "") + m.expectancy.toFixed(2) + "%";
    console.log(
      `${row.label.padEnd(16)}| ${String(m.totalTrades).padStart(6)} | ${m.winRate.toFixed(1).padStart(6)}% | ${m.profitFactor.toFixed(2).padStart(5)} | ${expectStr.padStart(8)} | ${m.maxDrawdown.toFixed(1).padStart(6)}% | ${m.riskRewardRatio.toFixed(1).padStart(5)}`,
    );
  }
  console.log("");
}

const STRATEGY_GRID = [
  { label: "3pos (default)", maxPositions: 3 },
  { label: "5pos", maxPositions: 5 },
  { label: "10pos", maxPositions: 10 },
  { label: "20pos", maxPositions: 20 },
  { label: "50pos", maxPositions: 50 },
];

function runStrategyComparison(
  baseConfig: BreakoutBacktestConfig,
  allData: Map<string, OHLCVData[]>,
  vixData: Map<string, number> | undefined,
): void {
  console.log("\n=== Strategy Comparison (BE→Trail integrated) ===");
  console.log(
    `${"Strategy".padEnd(18)}| ${"Trades".padStart(6)} | ${"WinRate".padStart(7)} | ${"PF".padStart(5)} | ${"Expect".padStart(8)} | ${"MaxDD".padStart(7)} | ${"RR".padStart(5)} | ${"AvgHold".padStart(7)} | ${"Return".padStart(8)}`,
  );
  console.log("-".repeat(95));

  for (const row of STRATEGY_GRID) {
    const config: BreakoutBacktestConfig = {
      ...baseConfig,
      maxPositions: row.maxPositions,
      verbose: false,
    };
    const result = runBreakoutBacktest(config, allData, vixData);
    const m = result.metrics;
    const expectStr = (m.expectancy >= 0 ? "+" : "") + m.expectancy.toFixed(2) + "%";
    const returnStr = (m.totalReturnPct >= 0 ? "+" : "") + m.totalReturnPct.toFixed(1) + "%";
    console.log(
      `${row.label.padEnd(18)}| ${String(m.totalTrades).padStart(6)} | ${m.winRate.toFixed(1).padStart(6)}% | ${m.profitFactor.toFixed(2).padStart(5)} | ${expectStr.padStart(8)} | ${m.maxDrawdown.toFixed(1).padStart(6)}% | ${m.riskRewardRatio.toFixed(1).padStart(5)} | ${m.avgHoldingDays.toFixed(1).padStart(6)}d | ${returnStr.padStart(8)}`,
    );
  }
  console.log("");
}

interface EntryFilterRow {
  label: string;
  marketTrendFilter: boolean;
  confirmationEntry: boolean;
}

const ENTRY_FILTER_GRID: EntryFilterRow[] = [
  { label: "baseline", marketTrendFilter: false, confirmationEntry: false },
  { label: "A: breadth", marketTrendFilter: true, confirmationEntry: false },
  { label: "B: confirm", marketTrendFilter: false, confirmationEntry: true },
  { label: "A+B", marketTrendFilter: true, confirmationEntry: true },
];

function runEntryFilterComparison(
  baseConfig: BreakoutBacktestConfig,
  allData: Map<string, OHLCVData[]>,
  vixData: Map<string, number> | undefined,
): void {
  console.log("\n=== Entry Filter Comparison ===");
  console.log(
    `${"Filter".padEnd(16)}| ${"Trades".padStart(6)} | ${"WinRate".padStart(7)} | ${"PF".padStart(5)} | ${"Expect".padStart(8)} | ${"MaxDD".padStart(7)} | ${"RR".padStart(5)} | ${"AvgHold".padStart(7)} | ${"Return".padStart(8)}`,
  );
  console.log("-".repeat(95));

  for (const row of ENTRY_FILTER_GRID) {
    const config: BreakoutBacktestConfig = {
      ...baseConfig,
      marketTrendFilter: row.marketTrendFilter,
      confirmationEntry: row.confirmationEntry,
      verbose: false,
    };
    const result = runBreakoutBacktest(config, allData, vixData);
    const m = result.metrics;
    const expectStr = (m.expectancy >= 0 ? "+" : "") + m.expectancy.toFixed(2) + "%";
    const returnStr = (m.totalReturnPct >= 0 ? "+" : "") + m.totalReturnPct.toFixed(1) + "%";
    console.log(
      `${row.label.padEnd(16)}| ${String(m.totalTrades).padStart(6)} | ${m.winRate.toFixed(1).padStart(6)}% | ${m.profitFactor.toFixed(2).padStart(5)} | ${expectStr.padStart(8)} | ${m.maxDrawdown.toFixed(1).padStart(6)}% | ${m.riskRewardRatio.toFixed(1).padStart(5)} | ${m.avgHoldingDays.toFixed(1).padStart(6)}d | ${returnStr.padStart(8)}`,
    );
  }
  console.log("");
}

interface ExitParamRow {
  label: string;
  atrMultiplier: number;
  beActivationMultiplier: number;
  tsActivationMultiplier: number;
  trailMultiplier: number;
}

const EXIT_PARAM_GRID: ExitParamRow[] = [
  // 現行デフォルト
  { label: "default", atrMultiplier: 1.0, beActivationMultiplier: 1.5, tsActivationMultiplier: 2.5, trailMultiplier: 1.5 },
  // --- trail幅の細かい探索 (BE=0.5, TS=1.0) ---
  { label: "t0.3", atrMultiplier: 1.0, beActivationMultiplier: 0.5, tsActivationMultiplier: 1.0, trailMultiplier: 0.3 },
  { label: "t0.4", atrMultiplier: 1.0, beActivationMultiplier: 0.5, tsActivationMultiplier: 1.0, trailMultiplier: 0.4 },
  { label: "t0.5", atrMultiplier: 1.0, beActivationMultiplier: 0.5, tsActivationMultiplier: 1.0, trailMultiplier: 0.5 },
  { label: "t0.6", atrMultiplier: 1.0, beActivationMultiplier: 0.5, tsActivationMultiplier: 1.0, trailMultiplier: 0.6 },
  { label: "t0.7", atrMultiplier: 1.0, beActivationMultiplier: 0.5, tsActivationMultiplier: 1.0, trailMultiplier: 0.7 },
  { label: "t0.8", atrMultiplier: 1.0, beActivationMultiplier: 0.5, tsActivationMultiplier: 1.0, trailMultiplier: 0.8 },
  // --- BE発動タイミング変化 (trail=0.6固定) ---
  { label: "BE0.3 t0.6", atrMultiplier: 1.0, beActivationMultiplier: 0.3, tsActivationMultiplier: 1.0, trailMultiplier: 0.6 },
  { label: "BE0.5 t0.6", atrMultiplier: 1.0, beActivationMultiplier: 0.5, tsActivationMultiplier: 1.0, trailMultiplier: 0.6 },
  { label: "BE0.8 t0.6", atrMultiplier: 1.0, beActivationMultiplier: 0.8, tsActivationMultiplier: 1.0, trailMultiplier: 0.6 },
  // --- ベストtrail + SL広め ---
  { label: "SL1.5 t0.5", atrMultiplier: 1.5, beActivationMultiplier: 0.5, tsActivationMultiplier: 1.0, trailMultiplier: 0.5 },
  { label: "SL1.5 t0.6", atrMultiplier: 1.5, beActivationMultiplier: 0.5, tsActivationMultiplier: 1.0, trailMultiplier: 0.6 },
  { label: "SL2.0 t0.5", atrMultiplier: 2.0, beActivationMultiplier: 0.5, tsActivationMultiplier: 1.0, trailMultiplier: 0.5 },
  { label: "SL2.0 t0.6", atrMultiplier: 2.0, beActivationMultiplier: 0.5, tsActivationMultiplier: 1.0, trailMultiplier: 0.6 },
];

function runExitParamComparison(
  baseConfig: BreakoutBacktestConfig,
  allData: Map<string, OHLCVData[]>,
  vixData: Map<string, number> | undefined,
): void {
  console.log("\n=== Exit Parameter Comparison ===");
  console.log(
    `${"Params".padEnd(18)}| ${"Trades".padStart(6)} | ${"WinRate".padStart(7)} | ${"PF".padStart(5)} | ${"Expect".padStart(8)} | ${"MaxDD".padStart(7)} | ${"RR".padStart(5)} | ${"AvgHold".padStart(7)} | ${"Return".padStart(8)}`,
  );
  console.log("-".repeat(95));

  for (const row of EXIT_PARAM_GRID) {
    const config: BreakoutBacktestConfig = {
      ...baseConfig,
      atrMultiplier: row.atrMultiplier,
      beActivationMultiplier: row.beActivationMultiplier,
      tsActivationMultiplier: row.tsActivationMultiplier,
      trailMultiplier: row.trailMultiplier,
      verbose: false,
    };
    const result = runBreakoutBacktest(config, allData, vixData);
    const m = result.metrics;
    const expectStr = (m.expectancy >= 0 ? "+" : "") + m.expectancy.toFixed(2) + "%";
    const returnStr = (m.totalReturnPct >= 0 ? "+" : "") + m.totalReturnPct.toFixed(1) + "%";
    console.log(
      `${row.label.padEnd(18)}| ${String(m.totalTrades).padStart(6)} | ${m.winRate.toFixed(1).padStart(6)}% | ${m.profitFactor.toFixed(2).padStart(5)} | ${expectStr.padStart(8)} | ${m.maxDrawdown.toFixed(1).padStart(6)}% | ${m.riskRewardRatio.toFixed(1).padStart(5)} | ${m.avgHoldingDays.toFixed(1).padStart(6)}d | ${returnStr.padStart(8)}`,
    );
  }
  console.log("");
}

async function main() {
  const args = process.argv.slice(2);
  const startDate = getArg(args, "--start") ?? dayjs().subtract(12, "month").format("YYYY-MM-DD");
  const endDate = getArg(args, "--end") ?? dayjs().format("YYYY-MM-DD");
  const verbose = args.includes("--verbose") || args.includes("-v");
  const budgetStr = getArg(args, "--budget");
  const scoreCompare = args.includes("--score-compare");
  const strategyCompare = args.includes("--strategy-compare");
  const entryCompare = args.includes("--entry-compare");
  const exitCompare = args.includes("--exit-compare");
  const noCost = args.includes("--no-cost");

  const config: BreakoutBacktestConfig = {
    ...BREAKOUT_BACKTEST_DEFAULTS,
    startDate,
    endDate,
    verbose,
  };
  if (budgetStr) config.initialBudget = Number(budgetStr);
  if (noCost) config.costModelEnabled = false;

  console.log("=".repeat(60));
  console.log("ブレイクアウトバックテスト");
  console.log("=".repeat(60));
  console.log(`期間: ${startDate} → ${endDate}`);
  console.log(`初期資金: ¥${config.initialBudget.toLocaleString()}`);
  console.log(`最大同時保有: ${config.maxPositions}`);
  console.log(`出来高サージ閾値: ${config.triggerThreshold}x`);
  console.log(`高値ルックバック: ${config.highLookbackDays}日`);
  console.log(`SL ATR倍率: ${config.atrMultiplier}`);
  console.log(`TS発動: ATR×${config.tsActivationMultiplier}, トレール: ATR×${config.trailMultiplier}`);
  console.log("");

  // 1. 候補銘柄の取得
  const stocks = await prisma.stock.findMany({
    where: { isDelisted: false, isActive: true, isRestricted: false },
    select: { tickerCode: true },
  });
  const tickerCodes = stocks.map((s) => s.tickerCode);
  console.log(`[data] ${tickerCodes.length}銘柄のデータ取得中...`);

  // 2. 日足データ取得
  const allData = await fetchHistoricalFromDB(tickerCodes, startDate, endDate);
  console.log(`[data] ${allData.size}銘柄のデータ取得完了`);

  // 3. VIXデータ取得
  const vixData = await fetchVixFromDB(startDate, endDate);
  if (vixData.size > 0) {
    console.log(`[data] VIXデータ: ${vixData.size}日`);
  }

  // 4a. スコア比較モード
  if (scoreCompare) {
    const vix = vixData.size > 0 ? vixData : undefined;
    runScoreComparison(config, allData, vix);
    await prisma.$disconnect();
    return;
  }

  // 4b. 戦略比較モード（maxPositions変化）
  if (strategyCompare) {
    const vix = vixData.size > 0 ? vixData : undefined;
    runStrategyComparison(config, allData, vix);
    await prisma.$disconnect();
    return;
  }

  // 4c. エントリーフィルター比較モード
  if (entryCompare) {
    const vix = vixData.size > 0 ? vixData : undefined;
    runEntryFilterComparison(config, allData, vix);
    await prisma.$disconnect();
    return;
  }

  // 4d. 出口パラメータ比較モード
  if (exitCompare) {
    const vix = vixData.size > 0 ? vixData : undefined;
    runExitParamComparison(config, allData, vix);
    await prisma.$disconnect();
    return;
  }

  // 4. バックテスト実行
  console.log("[sim] シミュレーション実行中...\n");
  const result = runBreakoutBacktest(config, allData, vixData.size > 0 ? vixData : undefined);

  // 5. レポート出力
  printReport(result);

  // DBに保存
  try {
    const id = await saveBacktestResult(result);
    console.log(`[db] BacktestRun 保存完了: ${id}`);
  } catch (err) {
    console.error("[db] BacktestRun 保存失敗:", err);
  }

  await prisma.$disconnect();
}

function printReport(result: BreakoutBacktestResult): void {
  const m = result.metrics;
  const cu = calculateCapitalUtilization(result.equityCurve);

  console.log("\n" + "=".repeat(60));
  console.log("バックテスト結果");
  console.log("=".repeat(60));

  printSection("トレード統計", [
    `総トレード数: ${m.totalTrades}`,
    `勝ち: ${m.wins} / 負け: ${m.losses} / 未決済: ${m.stillOpen}`,
    `勝率: ${m.winRate}%`,
    `平均保有日数: ${m.avgHoldingDays}`,
  ]);

  printSection("損益", [
    `総損益: ¥${m.totalPnl.toLocaleString()}`,
    `総リターン: ${m.totalReturnPct}%`,
    `純損益: ¥${m.totalNetPnl.toLocaleString()} (手数料¥${m.totalCommission.toLocaleString()}, 税¥${m.totalTax.toLocaleString()})`,
    `純リターン: ${m.netReturnPct}%`,
    `コストインパクト: ${m.costImpactPct}%`,
  ]);

  printSection("リスク指標", [
    `Profit Factor: ${formatPF(m.profitFactor)}`,
    `期待値: ${m.expectancy}%`,
    `RR比: ${m.riskRewardRatio}`,
    `最大ドローダウン: ${m.maxDrawdown}%${m.maxDrawdownPeriod ? ` (${m.maxDrawdownPeriod.start} → ${m.maxDrawdownPeriod.end})` : ""}`,
    `シャープレシオ: ${m.sharpeRatio ?? "N/A"}`,
    `平均勝ち: +${m.avgWinPct}% / 平均負け: ${m.avgLossPct}%`,
  ]);

  printSection("資金効率", [
    `平均同時ポジション: ${cu.avgConcurrentPositions}`,
    `資金稼働率: ${cu.capitalUtilizationPct}%`,
  ]);

  // レジーム別
  if (Object.keys(m.byRegime).length > 0) {
    console.log("\n[レジーム別]");
    for (const [regime, rm] of Object.entries(m.byRegime)) {
      console.log(`  ${regime}: ${rm.totalTrades}トレード, 勝率${rm.winRate}%, 平均${rm.avgPnlPct}%`);
    }
  }

  // 出口理由の内訳
  const exitCounts: Record<string, number> = {};
  for (const t of result.trades) {
    if (t.exitReason && t.exitReason !== "still_open") {
      exitCounts[t.exitReason] = (exitCounts[t.exitReason] ?? 0) + 1;
    }
  }
  if (Object.keys(exitCounts).length > 0) {
    console.log("\n[出口理由]");
    for (const [reason, count] of Object.entries(exitCounts).sort((a, b) => b[1] - a[1])) {
      console.log(`  ${reason}: ${count}`);
    }
  }

  console.log("\n" + "=".repeat(60));
  printJudgment(m);
}

function printSection(title: string, lines: string[]): void {
  console.log(`\n[${title}]`);
  for (const line of lines) {
    console.log(`  ${line}`);
  }
}

function formatPF(pf: number): string {
  if (pf === Infinity) return "∞";
  return pf.toFixed(2);
}

function printJudgment(m: PerformanceMetrics): void {
  const judgments: string[] = [];

  if (m.profitFactor >= 1.3) {
    judgments.push("PF >= 1.3 ✓");
  } else if (m.profitFactor >= 1.0) {
    judgments.push("PF >= 1.0 △");
  } else {
    judgments.push("PF < 1.0 ✗");
  }

  if (m.expectancy > 0) {
    judgments.push("期待値 > 0 ✓");
  } else {
    judgments.push("期待値 <= 0 ✗");
  }

  if (m.riskRewardRatio >= 1.5) {
    judgments.push("RR >= 1.5 ✓");
  } else {
    judgments.push(`RR = ${m.riskRewardRatio} △`);
  }

  console.log(`判定: ${judgments.join(" / ")}`);
}

main().catch((err) => {
  console.error("バックテスト実行エラー:", err);
  process.exit(1);
});
