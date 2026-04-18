/**
 * 統合バックテスト（GapUp + PSC 共有資金プール）
 *
 * Usage:
 *   npm run backtest:combined
 *   npm run backtest:combined -- --start 2025-04-01 --end 2026-03-25
 *   npm run backtest:combined -- --budget 1000000
 *   npm run backtest:combined -- --verbose
 *   npm run backtest:combined -- --compare-positions
 *   npm run backtest:combined -- --compare-split-positions
 *   npm run backtest:combined -- --compare-breadth
 */

import dayjs from "dayjs";
import { prisma } from "../lib/prisma";
import { GAPUP_BACKTEST_DEFAULTS } from "./gapup-config";
import { PSC_BACKTEST_DEFAULTS } from "./post-surge-consolidation-config";
import { getMaxBuyablePrice } from "../core/risk-manager";
import {
  precomputeSimData,
} from "./breakout-simulation";
import { precomputeGapUpDailySignals } from "./gapup-simulation";
import { precomputePSCDailySignals } from "./post-surge-consolidation-simulation";
import { fetchHistoricalFromDB, fetchVixFromDB, fetchIndexFromDB } from "./data-fetcher";
import { calculateCapitalUtilization } from "./metrics";
import { runCombinedSimulation, type PositionLimits } from "./combined-simulation";
import type {
  GapUpBacktestConfig,
  PostSurgeConsolidationBacktestConfig,
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

function printMonthlyEquitySummary(
  equityCurve: import("./types").DailyEquity[],
  totalCapitalAdded: number,
  initialBudget: number,
): void {
  // 月末エクイティを抽出
  const monthlyData: { month: string; equity: number; cumulativeAdded: number }[] = [];
  let cumulativeAdded = initialBudget;

  for (let i = 0; i < equityCurve.length; i++) {
    const day = equityCurve[i];
    if (day.capitalAdded) {
      cumulativeAdded += day.capitalAdded;
    }
    const isLastDayOfMonth =
      i === equityCurve.length - 1 ||
      equityCurve[i + 1].date.substring(0, 7) !== day.date.substring(0, 7);
    if (isLastDayOfMonth) {
      monthlyData.push({
        month: day.date.substring(0, 7),
        equity: day.totalEquity,
        cumulativeAdded,
      });
    }
  }

  console.log("\n[月次エクイティ推移]");
  console.log(
    `  ${"月".padEnd(9)} | ${"累計入金".padStart(11)} | ${"月末エクイティ".padStart(12)} | ${"損益".padStart(12)} | ${"損益率".padStart(7)}`,
  );
  console.log("  " + "-".repeat(65));

  for (const row of monthlyData) {
    const pnl = row.equity - row.cumulativeAdded;
    const pnlPct = row.cumulativeAdded > 0 ? (pnl / row.cumulativeAdded) * 100 : 0;
    const sign = pnl >= 0 ? "+" : "";
    console.log(
      `  ${row.month.padEnd(9)} | ¥${row.cumulativeAdded.toLocaleString().padStart(10)} | ¥${row.equity.toLocaleString().padStart(11)} | ${sign}¥${pnl.toLocaleString().padStart(10)} | ${sign}${pnlPct.toFixed(1)}%`,
    );
  }

  // 最終サマリー
  const finalEquity = equityCurve[equityCurve.length - 1]?.totalEquity ?? 0;
  const netProfit = finalEquity - totalCapitalAdded;
  const growthPct = totalCapitalAdded > 0 ? (netProfit / totalCapitalAdded) * 100 : 0;
  const sign = netProfit >= 0 ? "+" : "";

  console.log("\n[資金追加サマリー]");
  console.log(`  累計入金額: ¥${totalCapitalAdded.toLocaleString()}`);
  console.log(`  最終エクイティ: ¥${finalEquity.toLocaleString()}`);
  console.log(`  純利益: ${sign}¥${netProfit.toLocaleString()}`);
  console.log(`  資金増加率: ${sign}${growthPct.toFixed(1)}%`);
}

async function main() {
  const args = process.argv.slice(2);
  const endDate = getArg(args, "--end") ?? dayjs().format("YYYY-MM-DD");
  const startDate = getArg(args, "--start") ?? dayjs(endDate).subtract(12, "month").format("YYYY-MM-DD");
  const budget = Number(getArg(args, "--budget") ?? 500_000);
  const monthlyAddAmount = Number(getArg(args, "--monthly-add") ?? 0);
  const maxPriceOverride = getArg(args, "--max-price");
  const verbose = args.includes("--verbose");
  const comparePositions = args.includes("--compare-positions");
  const compareSplitPositions = args.includes("--compare-split-positions");
  const compareEquityFilter = args.includes("--compare-equity-filter");
  const compareBudget = args.includes("--budget-compare");
  const compareTurnover = args.includes("--compare-turnover");
  const comparePrice = args.includes("--compare-price");
  const comparePriceTurnover = args.includes("--compare-price-turnover");
  const minPriceOverride = getArg(args, "--min-price");
  const minTurnoverOverride = getArg(args, "--min-turnover");
  const compareEfficiency = args.includes("--compare-efficiency");
  const compareBreadth = args.includes("--compare-breadth");

  const quietMode = comparePositions || compareSplitPositions || compareEquityFilter || compareBudget || compareTurnover || comparePrice || comparePriceTurnover || compareEfficiency || compareBreadth;
  const dynamicMaxPrice = getMaxBuyablePrice(budget);
  const guConfig: GapUpBacktestConfig = { ...GAPUP_BACKTEST_DEFAULTS, startDate, endDate, initialBudget: budget, maxPrice: dynamicMaxPrice, verbose: !quietMode && verbose };
  const pscConfig: PostSurgeConsolidationBacktestConfig = {
    ...PSC_BACKTEST_DEFAULTS,
    startDate, endDate, initialBudget: budget, maxPrice: dynamicMaxPrice,
    verbose: !quietMode && verbose,
    // WF最適パラメータ
    atrMultiplier: 0.8,
    beActivationMultiplier: 0.3,
    trailMultiplier: 0.5,
  };
  if (maxPriceOverride) {
    guConfig.maxPrice = Number(maxPriceOverride);
    pscConfig.maxPrice = Number(maxPriceOverride);
  }
  if (minPriceOverride !== undefined) {
    guConfig.minPrice = Number(minPriceOverride);
    pscConfig.minPrice = Number(minPriceOverride);
  }
  if (minTurnoverOverride !== undefined) {
    guConfig.minTurnover = Number(minTurnoverOverride);
    pscConfig.minTurnover = Number(minTurnoverOverride);
  }

  console.log("=".repeat(60));
  console.log("統合バックテスト（GapUp + PSC）");
  console.log("=".repeat(60));
  console.log(`期間: ${startDate} → ${endDate}`);
  console.log(`初期資金: ¥${budget.toLocaleString()}`);
  if (monthlyAddAmount > 0) {
    console.log(`月次追加: ¥${monthlyAddAmount.toLocaleString()}`);
  }

  // データ取得（Stockテーブルが空の場合はStockDailyBarから直接取得）
  const stocks = await prisma.stock.findMany({
    where: { isDelisted: false, isActive: true, isRestricted: false },
    select: { tickerCode: true },
  });
  let tickerCodes: string[];
  if (stocks.length > 0) {
    tickerCodes = stocks.map((s) => s.tickerCode);
  } else {
    const distinctTickers = await prisma.stockDailyBar.findMany({
      where: { market: "JP" },
      distinct: ["tickerCode"],
      select: { tickerCode: true },
    });
    tickerCodes = distinctTickers.map((s) => s.tickerCode);
  }
  console.log(`[data] ${tickerCodes.length}銘柄のデータ取得中...`);

  const rawData = await fetchHistoricalFromDB(tickerCodes, startDate, endDate);
  const vixData = await fetchVixFromDB(startDate, endDate);
  const indexData = await fetchIndexFromDB("^N225", startDate, endDate);

  // budget-compare時はグリッド最大予算(20M)で銘柄をロード
  const maxPriceForData = compareBudget
    ? getMaxBuyablePrice(20_000_000)
    : guConfig.maxPrice;
  const allData = new Map<string, import("../core/technical-analysis").OHLCVData[]>();
  for (const [ticker, bars] of rawData) {
    if (bars.some((b) => b.close <= maxPriceForData && b.close > 0)) {
      allData.set(ticker, bars);
    }
  }
  console.log(`[data] ${allData.size}銘柄（フィルタ後）, VIX ${vixData.size}日, N225 ${indexData.size}日`);

  const precomputed = precomputeSimData(
    startDate, endDate, allData,
    true, true,
    guConfig.indexTrendSmaPeriod ?? 50,
    indexData.size > 0 ? indexData : undefined,
    false, 60,
    guConfig.indexTrendOffBufferPct ?? 0,
    guConfig.indexTrendOnBufferPct ?? 0,
  );

  const gapupSignals = precomputeGapUpDailySignals(guConfig, allData, precomputed);
  const pscSignals = precomputePSCDailySignals(pscConfig, allData, precomputed);

  const ctx = { guConfig, pscConfig, pscSignals, budget, verbose: !quietMode && verbose, allData, precomputed, gapupSignals, vixData: vixData.size > 0 ? vixData : undefined, monthlyAddAmount, equityCurveSmaPeriod: 20 };

  const defaultLimits: PositionLimits = { boMax: 0, guMax: 3, pscMax: 2 };

  // 資金比較モード
  if (compareBudget) {
    const budgetGrid = [
      { label: "500K (現状)", budget: 500_000 },
      { label: "750K", budget: 750_000 },
      { label: "1M", budget: 1_000_000 },
      { label: "1.5M", budget: 1_500_000 },
      { label: "2M", budget: 2_000_000 },
      { label: "3M", budget: 3_000_000 },
      { label: "5M", budget: 5_000_000 },
      { label: "7.5M", budget: 7_500_000 },
      { label: "10M", budget: 10_000_000 },
      { label: "15M", budget: 15_000_000 },
      { label: "20M", budget: 20_000_000 },
    ];

    console.log("\n=== 資金規模比較 ===");
    console.log(
      `${"資金".padEnd(14)}| ${"maxP".padStart(5)} | ${"Trades".padStart(6)} | ${"WinRate".padStart(7)} | ${"PF".padStart(5)} | ${"Expect".padStart(8)} | ${"MaxDD".padStart(7)} | ${"NetRet".padStart(8)} | ${"稼働率".padStart(6)}`,
    );
    console.log("-".repeat(95));

    for (const row of budgetGrid) {
      const mp = maxPriceOverride ? Number(maxPriceOverride) : getMaxBuyablePrice(row.budget);
      const gc: GapUpBacktestConfig = { ...guConfig, initialBudget: row.budget, maxPrice: mp };
      const pc: PostSurgeConsolidationBacktestConfig = { ...pscConfig, initialBudget: row.budget, maxPrice: mp };
      const guSig = precomputeGapUpDailySignals(gc, allData, precomputed);
      const pSig = precomputePSCDailySignals(pc, allData, precomputed);
      const result = runCombinedSimulation(
        { ...ctx, guConfig: gc, pscConfig: pc, gapupSignals: guSig, pscSignals: pSig, budget: row.budget },
        defaultLimits,
      );
      const m = result.totalMetrics;
      const util = calculateCapitalUtilization(result.equityCurve);
      const expectStr = (m.expectancy >= 0 ? "+" : "") + m.expectancy.toFixed(2) + "%";
      const pfStr = m.profitFactor === Infinity ? "∞" : m.profitFactor.toFixed(2);
      console.log(
        `${row.label.padEnd(14)}| ${String(mp).padStart(5)} | ${String(m.totalTrades).padStart(6)} | ${m.winRate.toFixed(1).padStart(6)}% | ${pfStr.padStart(5)} | ${expectStr.padStart(8)} | ${m.maxDrawdown.toFixed(1).padStart(6)}% | ${m.netReturnPct.toFixed(1).padStart(7)}% | ${util.capitalUtilizationPct.toFixed(1).padStart(5)}%`,
      );
    }
    console.log("");
    await prisma.$disconnect();
    return;
  }

  // 資金効率比較モード（T+2 / リスク%）
  if (compareEfficiency) {
    const grid: { label: string; settlementDays: number; riskPct: number | undefined }[] = [
      { label: "現状(T+2,2%)", settlementDays: 2, riskPct: undefined },
      { label: "T+0,2%", settlementDays: 0, riskPct: undefined },
      { label: "T+2,3%", settlementDays: 2, riskPct: 3 },
      { label: "T+2,4%", settlementDays: 2, riskPct: 4 },
      { label: "T+0,3%", settlementDays: 0, riskPct: 3 },
      { label: "T+0,4%", settlementDays: 0, riskPct: 4 },
    ];

    console.log("\n=== 資金効率比較（受渡日数 × リスク%） ===");
    console.log(
      `${"条件".padEnd(16)}| ${"Trades".padStart(6)} | ${"WinRate".padStart(7)} | ${"PF".padStart(5)} | ${"Expect".padStart(8)} | ${"MaxDD".padStart(7)} | ${"NetRet".padStart(8)} | ${"稼働率".padStart(6)}`,
    );
    console.log("-".repeat(82));

    for (const row of grid) {
      const result = runCombinedSimulation(
        { ...ctx, settlementDays: row.settlementDays, riskPctOverride: row.riskPct },
        defaultLimits,
      );
      const m = result.totalMetrics;
      const util = calculateCapitalUtilization(result.equityCurve);
      const expectStr = (m.expectancy >= 0 ? "+" : "") + m.expectancy.toFixed(2) + "%";
      const pfStr = m.profitFactor === Infinity ? "∞" : m.profitFactor.toFixed(2);
      console.log(
        `${row.label.padEnd(16)}| ${String(m.totalTrades).padStart(6)} | ${m.winRate.toFixed(1).padStart(6)}% | ${pfStr.padStart(5)} | ${expectStr.padStart(8)} | ${m.maxDrawdown.toFixed(1).padStart(6)}% | ${m.netReturnPct.toFixed(1).padStart(7)}% | ${util.capitalUtilizationPct.toFixed(1).padStart(5)}%`,
      );
    }
    console.log("");
    await prisma.$disconnect();
    return;
  }

  // breadthフィルター比較モード
  if (compareBreadth) {
    const grid: { label: string; threshold: number; filterOn: boolean }[] = [
      { label: "OFF (0%)", threshold: 0, filterOn: false },
      { label: "40%", threshold: 0.4, filterOn: true },
      { label: "50%", threshold: 0.5, filterOn: true },
      { label: "60% (現状)", threshold: 0.6, filterOn: true },
      { label: "70%", threshold: 0.7, filterOn: true },
      { label: "80%", threshold: 0.8, filterOn: true },
    ];

    console.log("\n=== breadthフィルター比較 ===");
    console.log(
      `${"閾値".padEnd(16)}| ${"Trades".padStart(6)} | ${"WinRate".padStart(7)} | ${"PF".padStart(5)} | ${"Expect".padStart(8)} | ${"MaxDD".padStart(7)} | ${"NetRet".padStart(8)} | ${"稼働率".padStart(6)}`,
    );
    console.log("-".repeat(82));

    for (const row of grid) {
      const gc: GapUpBacktestConfig = { ...guConfig, marketTrendFilter: row.filterOn, marketTrendThreshold: row.threshold };
      const pc: PostSurgeConsolidationBacktestConfig = { ...pscConfig, marketTrendFilter: row.filterOn, marketTrendThreshold: row.threshold };
      const guSig = precomputeGapUpDailySignals(gc, allData, precomputed);
      const pSig = precomputePSCDailySignals(pc, allData, precomputed);
      const result = runCombinedSimulation(
        { ...ctx, guConfig: gc, pscConfig: pc, gapupSignals: guSig, pscSignals: pSig },
        defaultLimits,
      );
      const m = result.totalMetrics;
      const util = calculateCapitalUtilization(result.equityCurve);
      const expectStr = (m.expectancy >= 0 ? "+" : "") + m.expectancy.toFixed(2) + "%";
      const pfStr = m.profitFactor === Infinity ? "∞" : m.profitFactor.toFixed(2);
      console.log(
        `${row.label.padEnd(16)}| ${String(m.totalTrades).padStart(6)} | ${m.winRate.toFixed(1).padStart(6)}% | ${pfStr.padStart(5)} | ${expectStr.padStart(8)} | ${m.maxDrawdown.toFixed(1).padStart(6)}% | ${m.netReturnPct.toFixed(1).padStart(7)}% | ${util.capitalUtilizationPct.toFixed(1).padStart(5)}%`,
      );
      // 戦略別内訳
      const gm = result.guMetrics;
      const pm = result.pscMetrics;
      console.log(
        `${"  GU".padEnd(16)}| ${String(gm.totalTrades).padStart(6)} | ${gm.winRate.toFixed(1).padStart(6)}% | ${(gm.profitFactor === Infinity ? "∞" : gm.profitFactor.toFixed(2)).padStart(5)} | ${((gm.expectancy >= 0 ? "+" : "") + gm.expectancy.toFixed(2) + "%").padStart(8)}`,
      );
      console.log(
        `${"  PSC".padEnd(16)}| ${String(pm.totalTrades).padStart(6)} | ${pm.winRate.toFixed(1).padStart(6)}% | ${(pm.profitFactor === Infinity ? "∞" : pm.profitFactor.toFixed(2)).padStart(5)} | ${((pm.expectancy >= 0 ? "+" : "") + pm.expectancy.toFixed(2) + "%").padStart(8)}`,
      );
    }
    console.log("");
    await prisma.$disconnect();
    return;
  }

  // ポジション比較モード
  if (comparePositions) {
    const grid = [
      { maxPos: 2, label: "2枠" },
      { maxPos: 3, label: "3枠（現状）" },
      { maxPos: 5, label: "5枠" },
      { maxPos: 10, label: "10枠" },
    ];

    console.log("\n=== ポジション枠比較（全戦略合計） ===");
    console.log(
      `${"枠数".padEnd(14)}| ${"Trades".padStart(6)} | ${"WinRate".padStart(7)} | ${"PF".padStart(5)} | ${"Expect".padStart(8)} | ${"MaxDD".padStart(7)} | ${"NetRet".padStart(8)} | ${"稼働率".padStart(6)}`,
    );
    console.log("-".repeat(78));

    for (const row of grid) {
      const limits: PositionLimits = { boMax: 0, guMax: row.maxPos, pscMax: row.maxPos };
      const result = runCombinedSimulation(ctx, limits);
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

  // 戦略別ポジション分離比較モード
  if (compareSplitPositions) {
    const grid: { label: string; limits: PositionLimits }[] = [
      { label: "GU3+PSC2（現状）",     limits: { boMax: 0, guMax: 3, pscMax: 2 } },
      { label: "GU3+PSC3",            limits: { boMax: 0, guMax: 3, pscMax: 3 } },
      { label: "GU5+PSC3",            limits: { boMax: 0, guMax: 5, pscMax: 3 } },
      { label: "GU5+PSC5",            limits: { boMax: 0, guMax: 5, pscMax: 5 } },
    ];

    console.log("\n=== 戦略別ポジション分離比較 ===");
    console.log(
      `${"パターン".padEnd(24)}| ${"Trades".padStart(6)} | ${"WinRate".padStart(7)} | ${"PF".padStart(5)} | ${"Expect".padStart(8)} | ${"MaxDD".padStart(7)} | ${"NetRet".padStart(8)} | ${"稼働率".padStart(6)}`,
    );
    console.log("-".repeat(92));

    for (const row of grid) {
      const result = runCombinedSimulation(ctx, row.limits);
      const m = result.totalMetrics;
      const util = calculateCapitalUtilization(result.equityCurve);
      const expectStr = (m.expectancy >= 0 ? "+" : "") + m.expectancy.toFixed(2) + "%";
      const pfStr = m.profitFactor === Infinity ? "∞" : m.profitFactor.toFixed(2);
      const gm = result.guMetrics;
      const pm = result.pscMetrics;
      console.log(
        `${row.label.padEnd(24)}| ${String(m.totalTrades).padStart(6)} | ${m.winRate.toFixed(1).padStart(6)}% | ${pfStr.padStart(5)} | ${expectStr.padStart(8)} | ${m.maxDrawdown.toFixed(1).padStart(6)}% | ${m.netReturnPct.toFixed(1).padStart(7)}% | ${util.capitalUtilizationPct.toFixed(1).padStart(5)}%`,
      );
      console.log(
        `${"  GU".padEnd(24)}| ${String(gm.totalTrades).padStart(6)} | ${gm.winRate.toFixed(1).padStart(6)}% | ${(gm.profitFactor === Infinity ? "∞" : gm.profitFactor.toFixed(2)).padStart(5)} | ${((gm.expectancy >= 0 ? "+" : "") + gm.expectancy.toFixed(2) + "%").padStart(8)}`,
      );
      console.log(
        `${"  PSC".padEnd(24)}| ${String(pm.totalTrades).padStart(6)} | ${pm.winRate.toFixed(1).padStart(6)}% | ${(pm.profitFactor === Infinity ? "∞" : pm.profitFactor.toFixed(2)).padStart(5)} | ${((pm.expectancy >= 0 ? "+" : "") + pm.expectancy.toFixed(2) + "%").padStart(8)}`,
      );
    }
    console.log("");
    await prisma.$disconnect();
    return;
  }

  // エクイティカーブフィルター比較モード
  if (compareEquityFilter) {
    const grid = [0, 10, 20, 40];

    console.log("\n=== エクイティカーブフィルター比較 ===");
    console.log(
      `${"SMA期間".padEnd(10)}| ${"Trades".padStart(6)} | ${"WinRate".padStart(7)} | ${"PF".padStart(5)} | ${"Expect".padStart(8)} | ${"MaxDD".padStart(7)} | ${"NetRet".padStart(8)} | ${"ハルト日".padStart(6)}`,
    );
    console.log("-".repeat(78));

    for (const sma of grid) {
      const result = runCombinedSimulation(
        { ...ctx, equityCurveSmaPeriod: sma },
        defaultLimits,
      );
      const m = result.totalMetrics;
      const expectStr = (m.expectancy >= 0 ? "+" : "") + m.expectancy.toFixed(2) + "%";
      const pfStr = m.profitFactor === Infinity ? "∞" : m.profitFactor.toFixed(2);
      const label = sma === 0 ? "なし" : `SMA${sma}`;
      console.log(
        `${label.padEnd(10)}| ${String(m.totalTrades).padStart(6)} | ${m.winRate.toFixed(1).padStart(6)}% | ${pfStr.padStart(5)} | ${expectStr.padStart(8)} | ${m.maxDrawdown.toFixed(1).padStart(6)}% | ${m.netReturnPct.toFixed(1).padStart(7)}% | ${String(result.haltDays).padStart(6)}`,
      );
    }
    console.log("");
    await prisma.$disconnect();
    return;
  }

  // 売買代金フィルター比較モード
  if (compareTurnover) {
    const turnoverGrid = [
      { label: "なし (0)", value: 0 },
      { label: "3000万円", value: 30_000_000 },
      { label: "5000万円 (現状)", value: 50_000_000 },
      { label: "1億円", value: 100_000_000 },
      { label: "2億円", value: 200_000_000 },
    ];

    console.log("\n=== 売買代金フィルター比較 ===");
    console.log(
      `${"売買代金下限".padEnd(18)}| ${"Trades".padStart(6)} | ${"WinRate".padStart(7)} | ${"PF".padStart(5)} | ${"Expect".padStart(8)} | ${"MaxDD".padStart(7)} | ${"NetRet".padStart(8)} | ${"稼働率".padStart(6)}`,
    );
    console.log("-".repeat(84));

    for (const row of turnoverGrid) {
      const gc: GapUpBacktestConfig = { ...guConfig, minTurnover: row.value };
      const pc: PostSurgeConsolidationBacktestConfig = { ...pscConfig, minTurnover: row.value };
      const guSig = precomputeGapUpDailySignals(gc, allData, precomputed);
      const pSig = precomputePSCDailySignals(pc, allData, precomputed);
      const result = runCombinedSimulation(
        { ...ctx, guConfig: gc, pscConfig: pc, gapupSignals: guSig, pscSignals: pSig },
        defaultLimits,
      );
      const m = result.totalMetrics;
      const utilResult = calculateCapitalUtilization(result.equityCurve);
      const expectStr = (m.expectancy >= 0 ? "+" : "") + m.expectancy.toFixed(2) + "%";
      const pfStr = m.profitFactor === Infinity ? "∞" : m.profitFactor.toFixed(2);
      console.log(
        `${row.label.padEnd(18)}| ${String(m.totalTrades).padStart(6)} | ${m.winRate.toFixed(1).padStart(6)}% | ${pfStr.padStart(5)} | ${expectStr.padStart(8)} | ${m.maxDrawdown.toFixed(1).padStart(6)}% | ${m.netReturnPct.toFixed(1).padStart(7)}% | ${utilResult.capitalUtilizationPct.toFixed(1).padStart(5)}%`,
      );
    }
    console.log("");
    await prisma.$disconnect();
    return;
  }

  // 最低株価フィルター比較モード
  if (comparePrice) {
    const priceGrid = [
      { label: "なし (0)", value: 0 },
      { label: "100円", value: 100 },
      { label: "200円", value: 200 },
      { label: "300円 (現状)", value: 300 },
      { label: "500円", value: 500 },
      { label: "1000円", value: 1_000 },
    ];

    console.log("\n=== 最低株価フィルター比較 ===");
    console.log(
      `${"最低株価".padEnd(18)}| ${"Trades".padStart(6)} | ${"WinRate".padStart(7)} | ${"PF".padStart(5)} | ${"Expect".padStart(8)} | ${"MaxDD".padStart(7)} | ${"NetRet".padStart(8)} | ${"稼働率".padStart(6)}`,
    );
    console.log("-".repeat(84));

    for (const row of priceGrid) {
      const gc: GapUpBacktestConfig = { ...guConfig, minPrice: row.value };
      const pc: PostSurgeConsolidationBacktestConfig = { ...pscConfig, minPrice: row.value };
      const guSig = precomputeGapUpDailySignals(gc, allData, precomputed);
      const pSig = precomputePSCDailySignals(pc, allData, precomputed);
      const result = runCombinedSimulation(
        { ...ctx, guConfig: gc, pscConfig: pc, gapupSignals: guSig, pscSignals: pSig },
        defaultLimits,
      );
      const m = result.totalMetrics;
      const utilResult = calculateCapitalUtilization(result.equityCurve);
      const expectStr = (m.expectancy >= 0 ? "+" : "") + m.expectancy.toFixed(2) + "%";
      const pfStr = m.profitFactor === Infinity ? "∞" : m.profitFactor.toFixed(2);
      console.log(
        `${row.label.padEnd(18)}| ${String(m.totalTrades).padStart(6)} | ${m.winRate.toFixed(1).padStart(6)}% | ${pfStr.padStart(5)} | ${expectStr.padStart(8)} | ${m.maxDrawdown.toFixed(1).padStart(6)}% | ${m.netReturnPct.toFixed(1).padStart(7)}% | ${utilResult.capitalUtilizationPct.toFixed(1).padStart(5)}%`,
      );
    }
    console.log("");
    await prisma.$disconnect();
    return;
  }

  // 最低株価 × 売買代金 組み合わせ比較モード
  if (comparePriceTurnover) {
    const priceRows = [
      { label: "0円", value: 0 },
      { label: "100円", value: 100 },
      { label: "300円(現状)", value: 300 },
    ];
    const turnoverCols = [
      { label: "5000万(現状)", value: 50_000_000 },
      { label: "1億円", value: 100_000_000 },
      { label: "2億円", value: 200_000_000 },
    ];

    console.log("\n=== 最低株価 × 売買代金 組み合わせ比較 ===");
    const header = `${"最低株価".padEnd(14)}` + turnoverCols.map((c) => ` | ${c.label.padStart(18)}`).join("");
    console.log(header);
    console.log("-".repeat(14 + turnoverCols.length * 21));

    for (const pr of priceRows) {
      const cols: string[] = [];
      for (const tr of turnoverCols) {
        const gc: GapUpBacktestConfig = { ...guConfig, minPrice: pr.value, minTurnover: tr.value };
        const pc: PostSurgeConsolidationBacktestConfig = { ...pscConfig, minPrice: pr.value, minTurnover: tr.value };
        const guSig = precomputeGapUpDailySignals(gc, allData, precomputed);
        const pSig = precomputePSCDailySignals(pc, allData, precomputed);
        const result = runCombinedSimulation(
          { ...ctx, guConfig: gc, pscConfig: pc, gapupSignals: guSig, pscSignals: pSig },
          defaultLimits,
        );
        const m = result.totalMetrics;
        const pfStr = m.profitFactor === Infinity ? "∞" : m.profitFactor.toFixed(2);
        const retStr = (m.netReturnPct >= 0 ? "+" : "") + m.netReturnPct.toFixed(1) + "%";
        cols.push(`PF${pfStr} Ret${retStr} (${m.totalTrades}件)`.padStart(18));
      }
      console.log(`${pr.label.padEnd(14)}` + cols.map((c) => ` | ${c}`).join(""));
    }
    console.log("");
    await prisma.$disconnect();
    return;
  }

  // 通常実行
  console.log(`ポジション枠: GU${defaultLimits.guMax} + PSC${defaultLimits.pscMax ?? 0}`);
  const result = runCombinedSimulation(ctx, defaultLimits);

  console.log("\n" + "=".repeat(60));
  console.log("統合バックテスト結果");
  console.log("=".repeat(60));

  printMetrics(result.totalMetrics, "全体");

  const util = calculateCapitalUtilization(result.equityCurve);
  console.log(`\n  平均同時ポジション: ${util.avgConcurrentPositions}`);
  console.log(`  資金稼働率: ${util.capitalUtilizationPct.toFixed(1)}%`);

  printMetrics(result.guMetrics, "GapUp");
  printMetrics(result.pscMetrics, "PostSurgeConsolidation");

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

  const totalDays = result.equityCurve.length;
  console.log(`\n[ドローダウンハルト]`);
  console.log(`  ハルト日数: ${result.haltDays} / ${totalDays}営業日 (${totalDays > 0 ? ((result.haltDays / totalDays) * 100).toFixed(1) : "0.0"}%)`);

  console.log("\n" + "=".repeat(60));
  const pfOk = result.totalMetrics.profitFactor >= 1.3;
  const expOk = result.totalMetrics.expectancy > 0;
  const rrOk = result.totalMetrics.riskRewardRatio >= 1.5;
  console.log(`判定: PF >= 1.3 ${pfOk ? "✓" : "✗"} / 期待値 > 0 ${expOk ? "✓" : "✗"} / RR >= 1.5 ${rrOk ? "✓" : "✗"}`);

  // 月次エクイティサマリー（月次追加時のみ）
  if (monthlyAddAmount > 0) {
    printMonthlyEquitySummary(result.equityCurve, result.totalCapitalAdded, budget);
  }


  await prisma.$disconnect();
}

main().catch((err) => {
  console.error("統合BTエラー:", err);
  process.exit(1);
});
