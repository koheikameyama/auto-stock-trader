/**
 * 統合バックテスト（Breakout + GapUp 共有資金プール）
 *
 * Usage:
 *   npm run backtest:combined
 *   npm run backtest:combined -- --start 2025-04-01 --end 2026-03-25
 *   npm run backtest:combined -- --budget 1000000
 *   npm run backtest:combined -- --verbose
 *   npm run backtest:combined -- --compare-positions
 *   npm run backtest:combined -- --compare-split-positions
 */

import dayjs from "dayjs";
import { prisma } from "../lib/prisma";
import { BREAKOUT_BACKTEST_DEFAULTS } from "./breakout-config";
import { GAPUP_BACKTEST_DEFAULTS } from "./gapup-config";
import { WEEKLY_BREAK_BACKTEST_DEFAULTS } from "./weekly-break-config";
import { PSC_BACKTEST_DEFAULTS } from "./post-surge-consolidation-config";
import { getMaxBuyablePrice } from "../core/risk-manager";
import {
  precomputeSimData,
  precomputeDailySignals,
} from "./breakout-simulation";
import { precomputeGapUpDailySignals } from "./gapup-simulation";
import { precomputeWeeklyBreakSignals } from "./weekly-break-simulation";
import { precomputePSCDailySignals } from "./post-surge-consolidation-simulation";
import { fetchHistoricalFromDB, fetchVixFromDB, fetchIndexFromDB } from "./data-fetcher";
import { calculateCapitalUtilization } from "./metrics";
import { saveBacktestResult } from "./db-saver";
import { runCombinedSimulation, type PositionLimits } from "./combined-simulation";
import type {
  BreakoutBacktestConfig,
  GapUpBacktestConfig,
  WeeklyBreakBacktestConfig,
  PostSurgeConsolidationBacktestConfig,
  PerformanceMetrics,
  BreakdownKey,
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

interface RegimeDef {
  key: string;
  label: string;
  startDate: string;
  endDate: string;
  note: string;
}

const REGIME_DEFS: RegimeDef[] = [
  { key: "A", label: "A:平穏ボックス", startDate: "2024-03-01", endDate: "2024-07-31", note: "暴落前4万円前後持ち合い" },
  { key: "B", label: "B:ブラマン＋余震", startDate: "2024-08-01", endDate: "2024-12-31", note: "8/5暴落→V字回復" },
  { key: "C", label: "C:関税ショック",  startDate: "2025-02-01", endDate: "2025-04-30", note: "MaxDD-26%、4/7底" },
  { key: "D", label: "D:大強気相場",    startDate: "2025-05-01", endDate: "2026-02-28", note: "+60%超の上昇トレンド" },
  { key: "E", label: "E:直近急落",      startDate: "2026-03-01", endDate: "2026-04-16", note: "58,850→51,064 -12%" },
];

async function main() {
  const args = process.argv.slice(2);
  const compareRegimes = args.includes("--compare-regimes");
  // compare-regimes時はフルレンジでデータをロード
  const endDate = compareRegimes
    ? "2026-04-16"
    : (getArg(args, "--end") ?? dayjs().format("YYYY-MM-DD"));
  const startDate = compareRegimes
    ? "2024-03-01"
    : (getArg(args, "--start") ?? dayjs(endDate).subtract(12, "month").format("YYYY-MM-DD"));
  const budget = Number(getArg(args, "--budget") ?? 500_000);
  const monthlyAddAmount = Number(getArg(args, "--monthly-add") ?? 0);
  const maxPriceOverride = getArg(args, "--max-price");
  const verbose = args.includes("--verbose");
  const comparePositions = args.includes("--compare-positions");
  const compareSplitPositions = args.includes("--compare-split-positions");
  const compareEquityFilter = args.includes("--compare-equity-filter");
  const compareVixFilter = args.includes("--compare-vix-filter");
  const compareBudget = args.includes("--budget-compare");
  const compareHolding = args.includes("--compare-holding");
  const compareTurnover = args.includes("--compare-turnover");
  const comparePrice = args.includes("--compare-price");
  const comparePriceTurnover = args.includes("--compare-price-turnover");
  const minPriceOverride = getArg(args, "--min-price");
  const minTurnoverOverride = getArg(args, "--min-turnover");
  const saveResult = args.includes("--save");
  const compareEfficiency = args.includes("--compare-efficiency");
  const compareWbEntry = args.includes("--compare-wb-entry");
  const compareWbHalfsize = args.includes("--compare-wb-halfsize");

  const quietMode = comparePositions || compareSplitPositions || compareEquityFilter || compareVixFilter || compareBudget || compareHolding || compareTurnover || comparePrice || comparePriceTurnover || compareEfficiency || compareWbEntry || compareWbHalfsize || compareRegimes;
  const dynamicMaxPrice = getMaxBuyablePrice(budget);
  const boConfig: BreakoutBacktestConfig = { ...BREAKOUT_BACKTEST_DEFAULTS, startDate, endDate, initialBudget: budget, maxPrice: dynamicMaxPrice, verbose: !quietMode && verbose };
  const guConfig: GapUpBacktestConfig = { ...GAPUP_BACKTEST_DEFAULTS, startDate, endDate, initialBudget: budget, maxPrice: dynamicMaxPrice, verbose: !quietMode && verbose };
  const wbConfig: WeeklyBreakBacktestConfig = { ...WEEKLY_BREAK_BACKTEST_DEFAULTS, startDate, endDate, initialBudget: budget, maxPrice: dynamicMaxPrice, verbose: !quietMode && verbose };
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
    boConfig.maxPrice = Number(maxPriceOverride);
    guConfig.maxPrice = Number(maxPriceOverride);
    wbConfig.maxPrice = Number(maxPriceOverride);
    pscConfig.maxPrice = Number(maxPriceOverride);
  }
  if (minPriceOverride !== undefined) {
    boConfig.minPrice = Number(minPriceOverride);
    guConfig.minPrice = Number(minPriceOverride);
    wbConfig.minPrice = Number(minPriceOverride);
    pscConfig.minPrice = Number(minPriceOverride);
  }
  if (minTurnoverOverride !== undefined) {
    boConfig.minTurnover = Number(minTurnoverOverride);
    guConfig.minTurnover = Number(minTurnoverOverride);
    wbConfig.minTurnover = Number(minTurnoverOverride);
    pscConfig.minTurnover = Number(minTurnoverOverride);
  }

  console.log("=".repeat(60));
  console.log("統合バックテスト（Breakout + GU + WeeklyBreak + PSC）");
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

  // budget-compare時はグリッド最大予算(5M→maxPrice=25,000円)で銘柄をロード
  const maxPriceForData = compareBudget
    ? getMaxBuyablePrice(5_000_000)
    : Math.max(boConfig.maxPrice, guConfig.maxPrice);
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
    boConfig.indexTrendSmaPeriod ?? 50,
    indexData.size > 0 ? indexData : undefined,
    boConfig.indexMomentumFilter ?? false,
    boConfig.indexMomentumDays ?? 60,
    boConfig.indexTrendOffBufferPct ?? 0,
    boConfig.indexTrendOnBufferPct ?? 0,
  );

  const breakoutSignals = precomputeDailySignals(boConfig, allData, precomputed);
  const gapupSignals = precomputeGapUpDailySignals(guConfig, allData, precomputed);
  const weeklyBreakSignals = precomputeWeeklyBreakSignals(wbConfig, allData, precomputed);
  const pscSignals = precomputePSCDailySignals(pscConfig, allData, precomputed);

  const ctx = { boConfig, guConfig, wbConfig, pscConfig, pscSignals, budget, verbose: !quietMode && verbose, allData, precomputed, breakoutSignals, gapupSignals, weeklyBreakSignals, vixData: vixData.size > 0 ? vixData : undefined, monthlyAddAmount, equityCurveSmaPeriod: 20 };

  // デフォルトポジション制限（breakoutは無効化中）
  const defaultLimits: PositionLimits = { boMax: 0, guMax: 3, wbMax: 0, pscMax: 2 };

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
      const bc: BreakoutBacktestConfig = { ...boConfig, initialBudget: row.budget, maxPrice: mp };
      const gc: GapUpBacktestConfig = { ...guConfig, initialBudget: row.budget, maxPrice: mp };
      const wc: WeeklyBreakBacktestConfig = { ...wbConfig, initialBudget: row.budget, maxPrice: mp };
      const pc: PostSurgeConsolidationBacktestConfig = { ...pscConfig, initialBudget: row.budget, maxPrice: mp };
      // maxPriceが変わるためシグナルを再計算
      const boSig = precomputeDailySignals(bc, allData, precomputed);
      const guSig = precomputeGapUpDailySignals(gc, allData, precomputed);
      const wbSig = precomputeWeeklyBreakSignals(wc, allData, precomputed);
      const pSig = precomputePSCDailySignals(pc, allData, precomputed);
      const result = runCombinedSimulation(
        { ...ctx, boConfig: bc, guConfig: gc, wbConfig: wc, pscConfig: pc,
          breakoutSignals: boSig, gapupSignals: guSig, weeklyBreakSignals: wbSig, pscSignals: pSig,
          budget: row.budget },
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

  // WBエントリー厳選比較モード
  if (compareWbEntry) {
    const budgets = [1_000_000, 2_000_000];
    const wbVariants: { label: string; lookback: number | null; volSurge: number | null; wbMax: number }[] = [
      { label: "ベース GU3+PSC2", lookback: null, volSurge: null, wbMax: 0 },
      { label: "WB1 13w/1.3x", lookback: 13, volSurge: 1.3, wbMax: 1 },
      { label: "WB1 13w/1.5x", lookback: 13, volSurge: 1.5, wbMax: 1 },
      { label: "WB1 13w/1.7x", lookback: 13, volSurge: 1.7, wbMax: 1 },
      { label: "WB1 26w/1.3x", lookback: 26, volSurge: 1.3, wbMax: 1 },
      { label: "WB1 26w/1.5x", lookback: 26, volSurge: 1.5, wbMax: 1 },
      { label: "WB1 26w/1.7x", lookback: 26, volSurge: 1.7, wbMax: 1 },
    ];

    for (const b of budgets) {
      const mp = maxPriceOverride ? Number(maxPriceOverride) : getMaxBuyablePrice(b);
      console.log(`\n=== WBエントリー厳選比較 (budget=¥${b.toLocaleString()}, maxPrice=${mp}) ===`);
      console.log(
        `${"パターン".padEnd(20)}| ${"Trades".padStart(6)} | ${"WinR".padStart(6)} | ${"PF".padStart(5)} | ${"Expect".padStart(8)} | ${"MaxDD".padStart(7)} | ${"NetRet".padStart(8)} | ${"WB件".padStart(5)} | ${"WB PF".padStart(6)} | ${"WB Exp".padStart(8)}`,
      );
      console.log("-".repeat(110));
      for (const v of wbVariants) {
        const bc: BreakoutBacktestConfig = { ...boConfig, initialBudget: b, maxPrice: mp };
        const gc: GapUpBacktestConfig = { ...guConfig, initialBudget: b, maxPrice: mp };
        const wc: WeeklyBreakBacktestConfig = {
          ...wbConfig,
          initialBudget: b,
          maxPrice: mp,
          weeklyHighLookback: v.lookback ?? wbConfig.weeklyHighLookback,
          weeklyVolSurgeRatio: v.volSurge ?? wbConfig.weeklyVolSurgeRatio,
        };
        const pc: PostSurgeConsolidationBacktestConfig = { ...pscConfig, initialBudget: b, maxPrice: mp };
        const boSig = precomputeDailySignals(bc, allData, precomputed);
        const guSig = precomputeGapUpDailySignals(gc, allData, precomputed);
        const wbSig = precomputeWeeklyBreakSignals(wc, allData, precomputed);
        const pSig = precomputePSCDailySignals(pc, allData, precomputed);
        const limits: PositionLimits = { boMax: 0, guMax: 3, wbMax: v.wbMax, pscMax: 2 };
        const result = runCombinedSimulation(
          { ...ctx, boConfig: bc, guConfig: gc, wbConfig: wc, pscConfig: pc,
            breakoutSignals: boSig, gapupSignals: guSig, weeklyBreakSignals: wbSig, pscSignals: pSig,
            budget: b },
          limits,
        );
        const m = result.totalMetrics;
        const wm = result.wbMetrics;
        const pfStr = m.profitFactor === Infinity ? "∞" : m.profitFactor.toFixed(2);
        const expectStr = (m.expectancy >= 0 ? "+" : "") + m.expectancy.toFixed(2) + "%";
        const wbPfStr = wm.profitFactor === Infinity ? "∞" : wm.profitFactor.toFixed(2);
        const wbExpStr = (wm.expectancy >= 0 ? "+" : "") + wm.expectancy.toFixed(2) + "%";
        console.log(
          `${v.label.padEnd(20)}| ${String(m.totalTrades).padStart(6)} | ${m.winRate.toFixed(1).padStart(5)}% | ${pfStr.padStart(5)} | ${expectStr.padStart(8)} | ${m.maxDrawdown.toFixed(1).padStart(6)}% | ${m.netReturnPct.toFixed(1).padStart(7)}% | ${String(wm.totalTrades).padStart(5)} | ${wbPfStr.padStart(6)} | ${wbExpStr.padStart(8)}`,
        );
      }
    }
    console.log("");
    await prisma.$disconnect();
    return;
  }

  // WBハーフサイズ＆タイムストップ短縮比較モード
  if (compareWbHalfsize) {
    const budgets = [1_000_000, 2_000_000];
    const variants: { label: string; wbMax: number; riskPct: number | undefined; holdDays: number; extDays: number }[] = [
      { label: "ベース GU3+PSC2",           wbMax: 0, riskPct: undefined, holdDays: 15, extDays: 25 },
      { label: "WB1 フル(2%)・15/25",        wbMax: 1, riskPct: 2,         holdDays: 15, extDays: 25 },
      { label: "WB1 ハーフ(1%)・15/25",      wbMax: 1, riskPct: 1,         holdDays: 15, extDays: 25 },
      { label: "WB1 ハーフ(1%)・10/15",      wbMax: 1, riskPct: 1,         holdDays: 10, extDays: 15 },
      { label: "WB1 ハーフ(1%)・7/10",       wbMax: 1, riskPct: 1,         holdDays: 7,  extDays: 10 },
      { label: "WB2 ハーフ(1%)・10/15",      wbMax: 2, riskPct: 1,         holdDays: 10, extDays: 15 },
      { label: "WB2 ハーフ(1%)・7/10",       wbMax: 2, riskPct: 1,         holdDays: 7,  extDays: 10 },
    ];

    for (const b of budgets) {
      const mp = maxPriceOverride ? Number(maxPriceOverride) : getMaxBuyablePrice(b);
      console.log(`\n=== WBハーフサイズ＆タイムストップ短縮比較 (budget=¥${b.toLocaleString()}, maxPrice=${mp}) ===`);
      console.log(
        `${"パターン".padEnd(26)}| ${"Trades".padStart(6)} | ${"WinR".padStart(6)} | ${"PF".padStart(5)} | ${"Expect".padStart(8)} | ${"MaxDD".padStart(7)} | ${"NetRet".padStart(8)} | ${"WB件".padStart(5)} | ${"WB PF".padStart(6)} | ${"WB Exp".padStart(8)} | ${"WB AvgH".padStart(8)}`,
      );
      console.log("-".repeat(122));
      for (const v of variants) {
        const bc: BreakoutBacktestConfig = { ...boConfig, initialBudget: b, maxPrice: mp };
        const gc: GapUpBacktestConfig = { ...guConfig, initialBudget: b, maxPrice: mp };
        const wc: WeeklyBreakBacktestConfig = {
          ...wbConfig,
          initialBudget: b,
          maxPrice: mp,
          maxHoldingDays: v.holdDays,
          maxExtendedHoldingDays: v.extDays,
        };
        const pc: PostSurgeConsolidationBacktestConfig = { ...pscConfig, initialBudget: b, maxPrice: mp };
        const boSig = precomputeDailySignals(bc, allData, precomputed);
        const guSig = precomputeGapUpDailySignals(gc, allData, precomputed);
        const wbSig = precomputeWeeklyBreakSignals(wc, allData, precomputed);
        const pSig = precomputePSCDailySignals(pc, allData, precomputed);
        const limits: PositionLimits = { boMax: 0, guMax: 3, wbMax: v.wbMax, pscMax: 2 };
        const result = runCombinedSimulation(
          { ...ctx, boConfig: bc, guConfig: gc, wbConfig: wc, pscConfig: pc,
            breakoutSignals: boSig, gapupSignals: guSig, weeklyBreakSignals: wbSig, pscSignals: pSig,
            budget: b, wbRiskPctOverride: v.riskPct },
          limits,
        );
        const m = result.totalMetrics;
        const wm = result.wbMetrics;
        const pfStr = m.profitFactor === Infinity ? "∞" : m.profitFactor.toFixed(2);
        const expectStr = (m.expectancy >= 0 ? "+" : "") + m.expectancy.toFixed(2) + "%";
        const wbPfStr = wm.profitFactor === Infinity ? "∞" : wm.profitFactor.toFixed(2);
        const wbExpStr = (wm.expectancy >= 0 ? "+" : "") + wm.expectancy.toFixed(2) + "%";
        const wbAvgH = wm.totalTrades > 0 ? wm.avgHoldingDays.toFixed(1) + "d" : "-";
        console.log(
          `${v.label.padEnd(26)}| ${String(m.totalTrades).padStart(6)} | ${m.winRate.toFixed(1).padStart(5)}% | ${pfStr.padStart(5)} | ${expectStr.padStart(8)} | ${m.maxDrawdown.toFixed(1).padStart(6)}% | ${m.netReturnPct.toFixed(1).padStart(7)}% | ${String(wm.totalTrades).padStart(5)} | ${wbPfStr.padStart(6)} | ${wbExpStr.padStart(8)} | ${wbAvgH.padStart(8)}`,
        );
      }
    }
    console.log("");
    await prisma.$disconnect();
    return;
  }

  // レジーム別比較モード
  if (compareRegimes) {
    console.log("\n=== レジーム別比較 (現行パラメータ: GU3+PSC2, maxPrice=dyn, budget=¥500,000) ===");
    console.log(
      `${"レジーム".padEnd(20)}| ${"期間".padEnd(23)} | ${"Trades".padStart(6)} | ${"WinR".padStart(6)} | ${"PF".padStart(5)} | ${"Expect".padStart(8)} | ${"MaxDD".padStart(7)} | ${"NetRet".padStart(8)} | ${"Calmar".padStart(7)} | ${"稼働率".padStart(6)}`,
    );
    console.log("-".repeat(130));

    for (const rg of REGIME_DEFS) {
      const bc: BreakoutBacktestConfig = { ...boConfig, startDate: rg.startDate, endDate: rg.endDate };
      const gc: GapUpBacktestConfig = { ...guConfig, startDate: rg.startDate, endDate: rg.endDate };
      const wc: WeeklyBreakBacktestConfig = { ...wbConfig, startDate: rg.startDate, endDate: rg.endDate };
      const pc: PostSurgeConsolidationBacktestConfig = { ...pscConfig, startDate: rg.startDate, endDate: rg.endDate };

      // レジーム期間で precompute を作り直す（ウォームアップ用の日数は allData に既に含まれる）
      const rgPrecomputed = precomputeSimData(
        rg.startDate, rg.endDate, allData,
        true, true,
        boConfig.indexTrendSmaPeriod ?? 50,
        indexData.size > 0 ? indexData : undefined,
        boConfig.indexMomentumFilter ?? false,
        boConfig.indexMomentumDays ?? 60,
        boConfig.indexTrendOffBufferPct ?? 0,
        boConfig.indexTrendOnBufferPct ?? 0,
      );
      const rgBoSig = precomputeDailySignals(bc, allData, rgPrecomputed);
      const rgGuSig = precomputeGapUpDailySignals(gc, allData, rgPrecomputed);
      const rgWbSig = precomputeWeeklyBreakSignals(wc, allData, rgPrecomputed);
      const rgPscSig = precomputePSCDailySignals(pc, allData, rgPrecomputed);

      const result = runCombinedSimulation(
        { ...ctx, boConfig: bc, guConfig: gc, wbConfig: wc, pscConfig: pc,
          precomputed: rgPrecomputed,
          breakoutSignals: rgBoSig, gapupSignals: rgGuSig, weeklyBreakSignals: rgWbSig, pscSignals: rgPscSig },
        defaultLimits,
      );
      const m = result.totalMetrics;
      const gm = result.guMetrics;
      const pm = result.pscMetrics;
      const util = calculateCapitalUtilization(result.equityCurve);
      const pfStr = m.profitFactor === Infinity ? "∞" : m.profitFactor.toFixed(2);
      const expectStr = (m.expectancy >= 0 ? "+" : "") + m.expectancy.toFixed(2) + "%";

      // Calmar比 = 年率NetRet / MaxDD
      const days = dayjs(rg.endDate).diff(dayjs(rg.startDate), "day");
      const years = Math.max(days / 365.25, 0.0001);
      const annualizedRet = Math.pow(1 + m.netReturnPct / 100, 1 / years) - 1;
      const calmar = m.maxDrawdown > 0 ? (annualizedRet * 100) / m.maxDrawdown : 0;
      const calmarStr = m.maxDrawdown > 0 && m.totalTrades > 0 ? calmar.toFixed(2) : "-";

      const periodStr = `${rg.startDate}〜${rg.endDate.substring(5)}`;
      console.log(
        `${rg.label.padEnd(20)}| ${periodStr.padEnd(23)} | ${String(m.totalTrades).padStart(6)} | ${m.winRate.toFixed(1).padStart(5)}% | ${pfStr.padStart(5)} | ${expectStr.padStart(8)} | ${m.maxDrawdown.toFixed(1).padStart(6)}% | ${m.netReturnPct.toFixed(1).padStart(7)}% | ${calmarStr.padStart(7)} | ${util.capitalUtilizationPct.toFixed(1).padStart(5)}%`,
      );
      // 戦略別内訳
      const gmPf = gm.profitFactor === Infinity ? "∞" : gm.profitFactor.toFixed(2);
      const pmPf = pm.profitFactor === Infinity ? "∞" : pm.profitFactor.toFixed(2);
      const gmExp = (gm.expectancy >= 0 ? "+" : "") + gm.expectancy.toFixed(2) + "%";
      const pmExp = (pm.expectancy >= 0 ? "+" : "") + pm.expectancy.toFixed(2) + "%";
      console.log(
        `${("  └GU " + rg.note).padEnd(44)} | ${String(gm.totalTrades).padStart(6)} | ${gm.winRate.toFixed(1).padStart(5)}% | ${gmPf.padStart(5)} | ${gmExp.padStart(8)} |        |          |         |       `,
      );
      console.log(
        `${"  └PSC".padEnd(44)} | ${String(pm.totalTrades).padStart(6)} | ${pm.winRate.toFixed(1).padStart(5)}% | ${pmPf.padStart(5)} | ${pmExp.padStart(8)} |        |          |         |       `,
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
      const result = runCombinedSimulation(ctx, row.maxPos);
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
      { label: "GU3+PSC2（現状）",     limits: { boMax: 0, guMax: 3, wbMax: 0, pscMax: 2 } },
      { label: "GU3+WB2+PSC2",        limits: { boMax: 0, guMax: 3, wbMax: 2, pscMax: 2 } },
      { label: "GU3+WB1+PSC2",        limits: { boMax: 0, guMax: 3, wbMax: 1, pscMax: 2 } },
      { label: "GU3+WB2+PSC2・合算5",  limits: { boMax: 0, guMax: 3, wbMax: 2, pscMax: 2, totalMax: 5 } },
      { label: "GU5+WB2+PSC3",        limits: { boMax: 0, guMax: 5, wbMax: 2, pscMax: 3 } },
      { label: "GU5+WB3+PSC3",        limits: { boMax: 0, guMax: 5, wbMax: 3, pscMax: 3 } },
      { label: "GU3+PSC3",            limits: { boMax: 0, guMax: 3, wbMax: 0, pscMax: 3 } },
      { label: "GU5+PSC3",            limits: { boMax: 0, guMax: 5, wbMax: 0, pscMax: 3 } },
      { label: "GU5+PSC5",            limits: { boMax: 0, guMax: 5, wbMax: 0, pscMax: 5 } },
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
      console.log(
        `${row.label.padEnd(24)}| ${String(m.totalTrades).padStart(6)} | ${m.winRate.toFixed(1).padStart(6)}% | ${pfStr.padStart(5)} | ${expectStr.padStart(8)} | ${m.maxDrawdown.toFixed(1).padStart(6)}% | ${m.netReturnPct.toFixed(1).padStart(7)}% | ${util.capitalUtilizationPct.toFixed(1).padStart(5)}%`,
      );
      const pm = result.pscMetrics;
      const wm = result.wbMetrics;
      console.log(
        `${"  GU".padEnd(24)}| ${String(gm.totalTrades).padStart(6)} | ${gm.winRate.toFixed(1).padStart(6)}% | ${(gm.profitFactor === Infinity ? "∞" : gm.profitFactor.toFixed(2)).padStart(5)} | ${((gm.expectancy >= 0 ? "+" : "") + gm.expectancy.toFixed(2) + "%").padStart(8)}`,
      );
      if (wm.totalTrades > 0) {
        console.log(
          `${"  WB".padEnd(24)}| ${String(wm.totalTrades).padStart(6)} | ${wm.winRate.toFixed(1).padStart(6)}% | ${(wm.profitFactor === Infinity ? "∞" : wm.profitFactor.toFixed(2)).padStart(5)} | ${((wm.expectancy >= 0 ? "+" : "") + wm.expectancy.toFixed(2) + "%").padStart(8)}`,
        );
      }
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

  // VIXレジーム別戦略フィルター比較モード
  if (compareVixFilter) {
    type RL = "normal" | "elevated" | "high" | "crisis";
    const grid: { boSkip: RL | undefined; guSkip: RL | undefined; label: string }[] = [
      { boSkip: undefined,  guSkip: undefined,  label: "現状（crisis停止）" },
      { boSkip: "high",     guSkip: undefined,  label: "BO:high停止 / GU:現状" },
      { boSkip: "high",     guSkip: "crisis",   label: "BO:high停止 / GU:crisis停止" },
      { boSkip: "elevated", guSkip: undefined,  label: "BO:elevated停止 / GU:現状" },
      { boSkip: "elevated", guSkip: "crisis",   label: "BO:elevated停止 / GU:crisis停止" },
    ];

    console.log("\n=== VIXレジーム別戦略フィルター比較 ===");
    console.log(
      `${"パターン".padEnd(30)}| ${"Trades".padStart(6)} | ${"WinRate".padStart(7)} | ${"PF".padStart(5)} | ${"Expect".padStart(8)} | ${"MaxDD".padStart(7)} | ${"NetRet".padStart(8)}`,
    );
    console.log("-".repeat(85));

    for (const row of grid) {
      const result = runCombinedSimulation(
        { ...ctx, boVixSkipLevel: row.boSkip, guVixSkipLevel: row.guSkip },
        defaultLimits,
      );
      const m = result.totalMetrics;
      const expectStr = (m.expectancy >= 0 ? "+" : "") + m.expectancy.toFixed(2) + "%";
      const pfStr = m.profitFactor === Infinity ? "∞" : m.profitFactor.toFixed(2);
      console.log(
        `${row.label.padEnd(30)}| ${String(m.totalTrades).padStart(6)} | ${m.winRate.toFixed(1).padStart(6)}% | ${pfStr.padStart(5)} | ${expectStr.padStart(8)} | ${m.maxDrawdown.toFixed(1).padStart(6)}% | ${m.netReturnPct.toFixed(1).padStart(7)}%`,
      );

      // 戦略別の内訳
      const bm = result.boMetrics;
      const gm = result.guMetrics;
      const bPf = bm.profitFactor === Infinity ? "∞" : bm.profitFactor.toFixed(2);
      const gPf = gm.profitFactor === Infinity ? "∞" : gm.profitFactor.toFixed(2);
      console.log(
        `${"  BO".padEnd(30)}| ${String(bm.totalTrades).padStart(6)} | ${bm.winRate.toFixed(1).padStart(6)}% | ${bPf.padStart(5)} | ${((bm.expectancy >= 0 ? "+" : "") + bm.expectancy.toFixed(2) + "%").padStart(8)} |        |         `,
      );
      console.log(
        `${"  GU".padEnd(30)}| ${String(gm.totalTrades).padStart(6)} | ${gm.winRate.toFixed(1).padStart(6)}% | ${gPf.padStart(5)} | ${((gm.expectancy >= 0 ? "+" : "") + gm.expectancy.toFixed(2) + "%").padStart(8)} |        |         `,
      );
    }
    console.log("");
    await prisma.$disconnect();
    return;
  }

  // 保有日数比較モード（ブレイクアウト）
  if (compareHolding) {
    const holdingGrid = [
      { label: "3日", maxHoldingDays: 3, maxExtendedHoldingDays: 5 },
      { label: "5日 (本番現状)", maxHoldingDays: 5, maxExtendedHoldingDays: 8 },
      { label: "7日 (BT現状)", maxHoldingDays: 7, maxExtendedHoldingDays: 10 },
      { label: "10日", maxHoldingDays: 10, maxExtendedHoldingDays: 14 },
    ];

    console.log("\n=== ブレイクアウト 保有日数比較 (maxHoldingDays) ===");
    console.log(
      `${"設定".padEnd(16)}| ${"全Trades".padStart(8)} | ${"BO Trades".padStart(10)} | ${"BO WinR".padStart(8)} | ${"BO PF".padStart(6)} | ${"BO Exp".padStart(8)} | ${"BO AvgH".padStart(8)} | ${"全DD".padStart(7)} | ${"純リターン".padStart(9)}`,
    );
    console.log("-".repeat(107));

    for (const row of holdingGrid) {
      const bc: BreakoutBacktestConfig = {
        ...boConfig,
        maxHoldingDays: row.maxHoldingDays,
        maxExtendedHoldingDays: row.maxExtendedHoldingDays,
      };
      const result = runCombinedSimulation(
        { ...ctx, boConfig: bc },
        defaultLimits,
      );
      const tm = result.totalMetrics;
      const bm = result.boMetrics;
      const bPf = bm.profitFactor === Infinity ? "∞" : bm.profitFactor.toFixed(2);
      const bExp = (bm.expectancy >= 0 ? "+" : "") + bm.expectancy.toFixed(2) + "%";
      console.log(
        `${row.label.padEnd(16)}| ${String(tm.totalTrades).padStart(8)} | ${String(bm.totalTrades).padStart(10)} | ${bm.winRate.toFixed(1).padStart(7)}% | ${bPf.padStart(6)} | ${bExp.padStart(8)} | ${bm.avgHoldingDays.toFixed(1).padStart(7)}d | ${tm.maxDrawdown.toFixed(1).padStart(6)}% | ${tm.netReturnPct.toFixed(1).padStart(8)}%`,
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
      const bc: BreakoutBacktestConfig = { ...boConfig, minTurnover: row.value };
      const gc: GapUpBacktestConfig = { ...guConfig, minTurnover: row.value };
      // シグナル再計算（minTurnover が変わるとユニバースが変わる）
      const boSig = precomputeDailySignals(bc, allData, precomputed);
      const guSig = precomputeGapUpDailySignals(gc, allData, precomputed);
      const wbC: WeeklyBreakBacktestConfig = { ...wbConfig, minTurnover: row.value };
      const wbSig = precomputeWeeklyBreakSignals(wbC, allData, precomputed);
      const result = runCombinedSimulation(
        { ...ctx, boConfig: bc, guConfig: gc, wbConfig: wbC, breakoutSignals: boSig, gapupSignals: guSig, weeklyBreakSignals: wbSig },
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
      const bc: BreakoutBacktestConfig = { ...boConfig, minPrice: row.value };
      const gc: GapUpBacktestConfig = { ...guConfig, minPrice: row.value };
      const wbC: WeeklyBreakBacktestConfig = { ...wbConfig, minPrice: row.value };
      // シグナル再計算（minPrice が変わるとユニバースが変わる）
      const boSig = precomputeDailySignals(bc, allData, precomputed);
      const guSig = precomputeGapUpDailySignals(gc, allData, precomputed);
      const wbSig = precomputeWeeklyBreakSignals(wbC, allData, precomputed);
      const result = runCombinedSimulation(
        { ...ctx, boConfig: bc, guConfig: gc, wbConfig: wbC, breakoutSignals: boSig, gapupSignals: guSig, weeklyBreakSignals: wbSig },
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
        const bc: BreakoutBacktestConfig = { ...boConfig, minPrice: pr.value, minTurnover: tr.value };
        const gc: GapUpBacktestConfig = { ...guConfig, minPrice: pr.value, minTurnover: tr.value };
        const wbC: WeeklyBreakBacktestConfig = { ...wbConfig, minPrice: pr.value, minTurnover: tr.value };
        const boSig = precomputeDailySignals(bc, allData, precomputed);
        const guSig = precomputeGapUpDailySignals(gc, allData, precomputed);
        const wbSig = precomputeWeeklyBreakSignals(wbC, allData, precomputed);
        const result = runCombinedSimulation(
          { ...ctx, boConfig: bc, guConfig: gc, wbConfig: wbC, breakoutSignals: boSig, gapupSignals: guSig, weeklyBreakSignals: wbSig },
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

  // 通常実行（breakoutは無効化中のためboMax=0）
  console.log(`ポジション枠: GU${defaultLimits.guMax} + WB${defaultLimits.wbMax} + PSC${defaultLimits.pscMax}${defaultLimits.totalMax ? ` (合計上限${defaultLimits.totalMax})` : ""}`);
  const result = runCombinedSimulation(ctx, defaultLimits);

  console.log("\n" + "=".repeat(60));
  console.log("統合バックテスト結果");
  console.log("=".repeat(60));

  printMetrics(result.totalMetrics, "全体");

  const util = calculateCapitalUtilization(result.equityCurve);
  console.log(`\n  平均同時ポジション: ${util.avgConcurrentPositions}`);
  console.log(`  資金稼働率: ${util.capitalUtilizationPct.toFixed(1)}%`);

  printMetrics(result.boMetrics, "Breakout");
  printMetrics(result.guMetrics, "GU");
  printMetrics(result.wbMetrics, "WeeklyBreak");
  printMetrics(result.pscMetrics, "PSC");

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

  // DBに保存（--save フラグがある場合のみ）
  if (saveResult) {
    try {
      const id = await saveBacktestResult(
        {
          config: { startDate, endDate, maxPositions: defaultLimits.totalMax ?? 3, initialBudget: budget },
          trades: result.allTrades,
          equityCurve: result.equityCurve,
          metrics: {
            ...result.totalMetrics,
            breakdown: {
              bo: result.boMetrics,
              gu: result.guMetrics,
              wb: result.wbMetrics,
              psc: result.pscMetrics,
            } satisfies Record<BreakdownKey, PerformanceMetrics>,
          },
        } as unknown as Parameters<typeof saveBacktestResult>[0],
        "combined",
      );
      console.log(`[db] BacktestRun 保存完了: ${id}`);
    } catch (err) {
      console.error("[db] BacktestRun 保存失敗:", err);
    }
  }

  await prisma.$disconnect();
}

main().catch((err) => {
  console.error("統合BTエラー:", err);
  process.exit(1);
});
