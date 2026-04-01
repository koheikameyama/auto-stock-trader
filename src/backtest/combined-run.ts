/**
 * 統合バックテスト（Breakout + GapUp 共有資金プール）
 *
 * Usage:
 *   npm run backtest:combined
 *   npm run backtest:combined -- --start 2025-04-01 --end 2026-03-25
 *   npm run backtest:combined -- --budget 1000000
 *   npm run backtest:combined -- --verbose
 *   npm run backtest:combined -- --compare-positions
 */

import dayjs from "dayjs";
import { prisma } from "../lib/prisma";
import { BREAKOUT_BACKTEST_DEFAULTS } from "./breakout-config";
import { GAPUP_BACKTEST_DEFAULTS } from "./gapup-config";
import {
  precomputeSimData,
  precomputeDailySignals,
} from "./breakout-simulation";
import { precomputeGapUpDailySignals } from "./gapup-simulation";
import { fetchHistoricalFromDB, fetchVixFromDB, fetchIndexFromDB } from "./data-fetcher";
import { calculateCapitalUtilization } from "./metrics";
import { saveBacktestResult } from "./db-saver";
import { runCombinedSimulation } from "./combined-simulation";
import type {
  BreakoutBacktestConfig,
  GapUpBacktestConfig,
  PerformanceMetrics,
} from "./types";

function getArg(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  return idx >= 0 && idx + 1 < args.length ? args[idx + 1] : undefined;
}

function printMetrics(m: PerformanceMetrics, label: string): void {
  console.log(`\n[${label}]`);
  console.log(`  トレード数: ${m.totalTrades} (勝${m.wins} / 負${m.losses} / 未決済${m.stillOpen})`);
  console.log(`  勝率: ${m.winRate.toFixed(1)}%`);
  console.log(`  PF: ${m.profitFactor === Infinity ? "∞" : m.profitFactor.toFixed(2)}`);
  console.log(`  期待値: ${m.expectancy >= 0 ? "+" : ""}${m.expectancy.toFixed(2)}%`);
  console.log(`  RR比: ${m.riskRewardRatio.toFixed(2)}`);
  console.log(`  最大DD: ${m.maxDrawdown.toFixed(1)}%`);
  console.log(`  平均保有日数: ${m.avgHoldingDays.toFixed(1)}`);
  console.log(`  総損益: ¥${m.totalPnl.toLocaleString()} (${m.totalReturnPct.toFixed(1)}%)`);
  if (m.totalCommission > 0) {
    console.log(`  手数料: ¥${m.totalCommission.toLocaleString()}  税金: ¥${m.totalTax.toLocaleString()}`);
    console.log(`  純損益: ¥${m.totalNetPnl.toLocaleString()} (${m.netReturnPct.toFixed(1)}%)`);
  }
}

async function main() {
  const args = process.argv.slice(2);
  const endDate = getArg(args, "--end") ?? dayjs().format("YYYY-MM-DD");
  const startDate = getArg(args, "--start") ?? dayjs(endDate).subtract(12, "month").format("YYYY-MM-DD");
  const budget = Number(getArg(args, "--budget") ?? 500_000);
  const verbose = args.includes("--verbose");
  const comparePositions = args.includes("--compare-positions");

  const boConfig: BreakoutBacktestConfig = { ...BREAKOUT_BACKTEST_DEFAULTS, startDate, endDate, initialBudget: budget, verbose: !comparePositions && verbose };
  const guConfig: GapUpBacktestConfig = { ...GAPUP_BACKTEST_DEFAULTS, startDate, endDate, initialBudget: budget, verbose: !comparePositions && verbose };

  console.log("=".repeat(60));
  console.log("統合バックテスト（Breakout + GapUp）");
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

  const maxPrice = Math.max(boConfig.maxPrice, guConfig.maxPrice);
  const allData = new Map<string, import("../core/technical-analysis").OHLCVData[]>();
  for (const [ticker, bars] of rawData) {
    if (bars.some((b) => b.close <= maxPrice && b.close > 0)) {
      allData.set(ticker, bars);
    }
  }
  console.log(`[data] ${allData.size}銘柄（フィルタ後）, VIX ${vixData.size}日, N225 ${indexData.size}日`);

  const precomputed = precomputeSimData(
    startDate, endDate, allData,
    true, true,
    boConfig.indexTrendSmaPeriod ?? 50,
    indexData.size > 0 ? indexData : undefined,
    boConfig.indexMomentumFilter ?? false,
    boConfig.indexMomentumDays ?? 60,
    boConfig.indexTrendOffBufferPct ?? 0,
    boConfig.indexTrendOnBufferPct ?? 0,
  );

  const breakoutSignals = precomputeDailySignals(boConfig, allData, precomputed);
  const gapupSignals = precomputeGapUpDailySignals(guConfig, allData, precomputed);

  const ctx = { boConfig, guConfig, budget, verbose: !comparePositions && verbose, allData, precomputed, breakoutSignals, gapupSignals, vixData: vixData.size > 0 ? vixData : undefined };

  // ポジション比較モード
  if (comparePositions) {
    const grid = [
      { bo: 3, gu: 3, label: "3:3（現状）" },
      { bo: 5, gu: 2, label: "5:2" },
      { bo: 3, gu: 5, label: "3:5" },
      { bo: 5, gu: 5, label: "5:5" },
    ];

    console.log("\n=== ポジション枠比較 ===");
    console.log(
      `${"枠(BO:GU)".padEnd(14)}| ${"Trades".padStart(6)} | ${"WinRate".padStart(7)} | ${"PF".padStart(5)} | ${"Expect".padStart(8)} | ${"MaxDD".padStart(7)} | ${"NetRet".padStart(8)} | ${"稼働率".padStart(6)}`,
    );
    console.log("-".repeat(78));

    for (const row of grid) {
      const result = runCombinedSimulation(ctx, row.bo, row.gu);
      const m = result.totalMetrics;
      const util = calculateCapitalUtilization(result.equityCurve);
      const expectStr = (m.expectancy >= 0 ? "+" : "") + m.expectancy.toFixed(2) + "%";
      const pfStr = m.profitFactor === Infinity ? "∞" : m.profitFactor.toFixed(2);
      console.log(
        `${row.label.padEnd(14)}| ${String(m.totalTrades).padStart(6)} | ${m.winRate.toFixed(1).padStart(6)}% | ${pfStr.padStart(5)} | ${expectStr.padStart(8)} | ${m.maxDrawdown.toFixed(1).padStart(6)}% | ${m.netReturnPct.toFixed(1).padStart(7)}% | ${util.capitalUtilizationPct.toFixed(1).padStart(5)}%`,
      );
    }
    console.log("");
    await prisma.$disconnect();
    return;
  }

  // 通常実行
  console.log(`ポジション枠: Breakout ${boConfig.maxPositions} / GapUp ${guConfig.maxPositions}`);
  const result = runCombinedSimulation(ctx, boConfig.maxPositions, guConfig.maxPositions);

  console.log("\n" + "=".repeat(60));
  console.log("統合バックテスト結果");
  console.log("=".repeat(60));

  printMetrics(result.totalMetrics, "全体");

  const util = calculateCapitalUtilization(result.equityCurve);
  console.log(`\n  平均同時ポジション: ${util.avgConcurrentPositions}`);
  console.log(`  資金稼働率: ${util.capitalUtilizationPct.toFixed(1)}%`);

  printMetrics(result.boMetrics, "Breakout");
  printMetrics(result.guMetrics, "GapUp");

  const exitReasons = new Map<string, number>();
  for (const t of result.allTrades) {
    if (t.exitReason && t.exitReason !== "still_open") {
      exitReasons.set(t.exitReason, (exitReasons.get(t.exitReason) ?? 0) + 1);
    }
  }
  console.log("\n[出口理由]");
  for (const [reason, count] of exitReasons) {
    console.log(`  ${reason}: ${count}`);
  }

  console.log("\n" + "=".repeat(60));
  const pfOk = result.totalMetrics.profitFactor >= 1.3;
  const expOk = result.totalMetrics.expectancy > 0;
  const rrOk = result.totalMetrics.riskRewardRatio >= 1.5;
  console.log(`判定: PF >= 1.3 ${pfOk ? "✓" : "✗"} / 期待値 > 0 ${expOk ? "✓" : "✗"} / RR >= 1.5 ${rrOk ? "✓" : "✗"}`);

  // DBに保存
  try {
    const id = await saveBacktestResult(
      {
        config: { startDate, endDate, boMaxPositions: boConfig.maxPositions, guMaxPositions: guConfig.maxPositions, initialBudget: budget },
        trades: result.allTrades,
        equityCurve: result.equityCurve,
        metrics: result.totalMetrics,
      } as Parameters<typeof saveBacktestResult>[0],
      "combined",
    );
    console.log(`[db] BacktestRun 保存完了: ${id}`);
  } catch (err) {
    console.error("[db] BacktestRun 保存失敗:", err);
  }

  await prisma.$disconnect();
}

main().catch((err) => {
  console.error("統合BTエラー:", err);
  process.exit(1);
});
