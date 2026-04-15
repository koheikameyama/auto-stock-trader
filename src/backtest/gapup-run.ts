/**
 * ギャップアップバックテスト実行スクリプト
 *
 * Usage:
 *   npm run backtest:gapup
 *   npm run backtest:gapup -- --start 2025-04-01 --end 2026-03-25
 *   npm run backtest:gapup -- --verbose
 *   npm run backtest:gapup -- --compare-entry
 *   npm run backtest:gapup -- --compare-exit
 */

import dayjs from "dayjs";
import { prisma } from "../lib/prisma";
import { GAPUP_BACKTEST_DEFAULTS } from "./gapup-config";
import { getMaxBuyablePrice } from "../core/risk-manager";
import { runGapUpBacktest } from "./gapup-simulation";
import { saveBacktestResult } from "./db-saver";
import { fetchHistoricalFromDB, fetchVixFromDB, fetchIndexFromDB } from "./data-fetcher";
import { calculateCapitalUtilization } from "./metrics";
import type { GapUpBacktestConfig, PerformanceMetrics } from "./types";
import type { OHLCVData } from "../core/technical-analysis";

function getArg(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  return idx >= 0 && idx + 1 < args.length ? args[idx + 1] : undefined;
}

interface EntryComparisonRow {
  label: string;
  gapMinPct: number;
  volSurgeRatio: number;
  marketTrendThreshold?: number;
}

const ENTRY_COMPARISON_GRID: EntryComparisonRow[] = [
  { label: "gap2%+vol1.5x",  gapMinPct: 0.02, volSurgeRatio: 1.5 },
  { label: "gap2%+vol2.0x",  gapMinPct: 0.02, volSurgeRatio: 2.0 },
  { label: "gap3%+vol1.5x",  gapMinPct: 0.03, volSurgeRatio: 1.5 },
  { label: "gap3%+vol2.0x",  gapMinPct: 0.03, volSurgeRatio: 2.0 },
  { label: "gap3%+vol2.5x",  gapMinPct: 0.03, volSurgeRatio: 2.5 },
  { label: "gap5%+vol1.5x",  gapMinPct: 0.05, volSurgeRatio: 1.5 },
  { label: "gap5%+vol2.0x",  gapMinPct: 0.05, volSurgeRatio: 2.0 },
  { label: "brd50%+g3%+v1.5", gapMinPct: 0.03, volSurgeRatio: 1.5, marketTrendThreshold: 0.5 },
  { label: "brd60%+g3%+v1.5", gapMinPct: 0.03, volSurgeRatio: 1.5, marketTrendThreshold: 0.6 },
  { label: "brd70%+g3%+v1.5", gapMinPct: 0.03, volSurgeRatio: 1.5, marketTrendThreshold: 0.7 },
];

function runEntryComparison(
  baseConfig: GapUpBacktestConfig,
  allData: Map<string, OHLCVData[]>,
  vixData: Map<string, number> | undefined,
  indexData: Map<string, number> | undefined,
): void {
  console.log("\n=== Entry Parameter Comparison ===");
  console.log(
    `${"Filter".padEnd(22)}| ${"Trades".padStart(6)} | ${"WinRate".padStart(7)} | ${"PF".padStart(5)} | ${"Expect".padStart(8)} | ${"MaxDD".padStart(7)} | ${"AvgHold".padStart(7)}`,
  );
  console.log("-".repeat(74));

  for (const row of ENTRY_COMPARISON_GRID) {
    const config: GapUpBacktestConfig = {
      ...baseConfig,
      gapMinPct: row.gapMinPct,
      volSurgeRatio: row.volSurgeRatio,
      marketTrendThreshold: row.marketTrendThreshold ?? baseConfig.marketTrendThreshold,
      verbose: false,
    };
    const result = runGapUpBacktest(config, allData, vixData, indexData);
    const m = result.metrics;
    const expectStr = (m.expectancy >= 0 ? "+" : "") + m.expectancy.toFixed(2) + "%";
    console.log(
      `${row.label.padEnd(22)}| ${String(m.totalTrades).padStart(6)} | ${m.winRate.toFixed(1).padStart(6)}% | ${m.profitFactor.toFixed(2).padStart(5)} | ${expectStr.padStart(8)} | ${m.maxDrawdown.toFixed(1).padStart(6)}% | ${m.avgHoldingDays.toFixed(1).padStart(6)}d`,
    );
  }
  console.log("");
}

interface ExitComparisonRow {
  label: string;
  exitMode: NonNullable<GapUpBacktestConfig["exitMode"]>;
}

const EXIT_COMPARISON_GRID: ExitComparisonRow[] = [
  { label: "trail (current)",  exitMode: "trail" },
  { label: "next_open",        exitMode: "next_open" },
  { label: "next_close",       exitMode: "next_close" },
  { label: "day2_close",       exitMode: "day2_close" },
];

function runExitComparison(
  baseConfig: GapUpBacktestConfig,
  allData: Map<string, OHLCVData[]>,
  vixData: Map<string, number> | undefined,
  indexData: Map<string, number> | undefined,
): void {
  console.log("\n=== Exit Mode Comparison ===");
  console.log(
    `${"ExitMode".padEnd(18)}| ${"Trades".padStart(6)} | ${"WinRate".padStart(7)} | ${"PF".padStart(5)} | ${"Expect".padStart(8)} | ${"AvgWin".padStart(7)} | ${"AvgLoss".padStart(8)} | ${"MaxDD".padStart(7)} | ${"AvgHold".padStart(7)}`,
  );
  console.log("-".repeat(98));

  const rows: { label: string; expectancy: number; pf: number }[] = [];
  for (const row of EXIT_COMPARISON_GRID) {
    const config: GapUpBacktestConfig = {
      ...baseConfig,
      exitMode: row.exitMode,
      verbose: false,
    };
    const result = runGapUpBacktest(config, allData, vixData, indexData);
    const m = result.metrics;
    const expectStr = (m.expectancy >= 0 ? "+" : "") + m.expectancy.toFixed(2) + "%";
    console.log(
      `${row.label.padEnd(18)}| ${String(m.totalTrades).padStart(6)} | ${m.winRate.toFixed(1).padStart(6)}% | ${m.profitFactor.toFixed(2).padStart(5)} | ${expectStr.padStart(8)} | +${m.avgWinPct.toFixed(2).padStart(5)}% | ${m.avgLossPct.toFixed(2).padStart(7)}% | ${m.maxDrawdown.toFixed(1).padStart(6)}% | ${m.avgHoldingDays.toFixed(1).padStart(6)}d`,
    );
    rows.push({ label: row.label, expectancy: m.expectancy, pf: m.profitFactor });
  }

  const bestExpect = rows.reduce((b, r) => r.expectancy > b.expectancy ? r : b, rows[0]);
  const bestPF = rows.reduce((b, r) => r.pf > b.pf ? r : b, rows[0]);
  console.log("");
  console.log(`期待値最大: ${bestExpect.label} (${bestExpect.expectancy >= 0 ? "+" : ""}${bestExpect.expectancy.toFixed(2)}%)`);
  console.log(`PF最大:     ${bestPF.label} (PF=${bestPF.pf.toFixed(2)})`);
  console.log("");
}

function printResult(result: { metrics: PerformanceMetrics; trades: { exitReason: string | null }[] }, label: string): void {
  const m = result.metrics;
  console.log(`\n=== ${label} ===`);
  console.log(`トレード数: ${m.totalTrades} (勝${m.wins} / 負${m.losses} / 未決済${m.stillOpen})`);
  console.log(`勝率: ${m.winRate.toFixed(1)}%`);
  console.log(`PF: ${m.profitFactor.toFixed(2)}`);
  console.log(`平均勝: +${m.avgWinPct.toFixed(2)}%  平均負: ${m.avgLossPct.toFixed(2)}%`);
  console.log(`期待値: ${m.expectancy >= 0 ? "+" : ""}${m.expectancy.toFixed(2)}%`);
  console.log(`RR比: ${m.riskRewardRatio.toFixed(2)}`);
  console.log(`最大DD: ${m.maxDrawdown.toFixed(1)}%`);
  console.log(`平均保有日数: ${m.avgHoldingDays.toFixed(1)}日`);
  console.log(`総損益: ¥${m.totalPnl.toLocaleString()} (${m.totalReturnPct.toFixed(1)}%)`);
  if (m.totalCommission > 0) {
    console.log(`手数料: ¥${m.totalCommission.toLocaleString()}  税金: ¥${m.totalTax.toLocaleString()}`);
    console.log(`純損益: ¥${m.totalNetPnl.toLocaleString()} (${m.netReturnPct.toFixed(1)}%)`);
  }
}

async function main() {
  const args = process.argv.slice(2);
  const endDate = getArg(args, "--end") ?? dayjs().format("YYYY-MM-DD");
  const startDate = getArg(args, "--start") ?? dayjs(endDate).subtract(12, "month").format("YYYY-MM-DD");
  const budget = Number(getArg(args, "--budget") ?? GAPUP_BACKTEST_DEFAULTS.initialBudget);
  const verbose = args.includes("--verbose");
  const compareEntry = args.includes("--compare-entry");
  const compareExit = args.includes("--compare-exit");
  const noPositionCap = args.includes("--no-position-cap");
  const gapMinPctArg = getArg(args, "--gap-min-pct");
  const gapMinPct = gapMinPctArg != null ? parseFloat(gapMinPctArg) / 100 : undefined;

  console.log("=".repeat(60));
  console.log("ギャップアップ バックテスト");
  console.log("=".repeat(60));
  console.log(`期間: ${startDate} → ${endDate}`);
  console.log(`初期資金: ¥${budget.toLocaleString()}`);

  // データ取得
  const stocks = await prisma.stock.findMany({
    where: { isDelisted: false, isActive: true, isRestricted: false },
    select: { tickerCode: true },
  });
  const tickerCodes = stocks.map((s) => s.tickerCode);
  console.log(`[data] ${tickerCodes.length}銘柄のデータ取得中...`);

  const rawData = await fetchHistoricalFromDB(tickerCodes, startDate, endDate);
  const vixData = await fetchVixFromDB(startDate, endDate);
  const indexData = await fetchIndexFromDB("^N225", startDate, endDate);
  console.log(`[data] ${rawData.size}銘柄, VIX ${vixData.size}日, N225 ${indexData.size}日`);

  // 事前フィルタ: maxPrice以下のバーが1つ以上ある銘柄のみ
  const maxPrice = getMaxBuyablePrice(budget);
  const allData = new Map<string, OHLCVData[]>();
  for (const [ticker, bars] of rawData) {
    if (bars.some((b) => b.close <= maxPrice && b.close > 0)) {
      allData.set(ticker, bars);
    }
  }
  console.log(`[data] ${allData.size}銘柄（フィルタ後）`);

  const baseConfig: GapUpBacktestConfig = {
    ...GAPUP_BACKTEST_DEFAULTS,
    startDate,
    endDate,
    initialBudget: budget,
    maxPrice,
    verbose,
    positionCapEnabled: !noPositionCap,
    ...(gapMinPct != null ? { gapMinPct } : {}),
  };

  const vixArg = vixData.size > 0 ? vixData : undefined;
  const indexArg = indexData.size > 0 ? indexData : undefined;

  // エントリーパラメータ比較モード
  if (compareEntry) {
    runEntryComparison(baseConfig, allData, vixArg, indexArg);
    await prisma.$disconnect();
    return;
  }

  // 出口モード比較
  if (compareExit) {
    runExitComparison(baseConfig, allData, vixArg, indexArg);
    await prisma.$disconnect();
    return;
  }

  // デフォルト実行
  const result = runGapUpBacktest(baseConfig, allData, vixArg, indexArg);
  printResult(result, "ギャップアップ戦略");

  // 資本効率
  const util = calculateCapitalUtilization(result.equityCurve);
  console.log(`\n平均ポジション数: ${util.avgConcurrentPositions}`);
  console.log(`資本稼働率: ${util.capitalUtilizationPct.toFixed(1)}%`);

  // DBに保存
  try {
    const id = await saveBacktestResult(result, "gapup");
    console.log(`[db] BacktestRun 保存完了: ${id}`);
  } catch (err) {
    console.error("[db] BacktestRun 保存失敗:", err);
  }

  await prisma.$disconnect();
}

main().catch((err) => {
  console.error("ギャップアップBTエラー:", err);
  process.exit(1);
});
