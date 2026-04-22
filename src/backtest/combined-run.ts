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
 *   npm run backtest:combined -- --compare-breadth-modes --start 2024-03-01
 *   npm run backtest:combined -- --compare-breadth-zoom --start 2024-03-01
 */

import dayjs from "dayjs";
import { prisma } from "../lib/prisma";
import { GAPUP_BACKTEST_DEFAULTS } from "./gapup-config";
import { PSC_BACKTEST_DEFAULTS, PSC_PRODUCTION_PARAMS } from "./post-surge-consolidation-config";
import { getMaxBuyablePrice } from "../core/risk-manager";
import {
  precomputeSimData,
} from "./breakout-simulation";
import { precomputeGapUpDailySignals } from "./gapup-simulation";
import { precomputePSCDailySignals } from "./post-surge-consolidation-simulation";
import { precomputeMomentumSignals } from "./momentum-simulation";
import { MOMENTUM_BACKTEST_DEFAULTS, MOMENTUM_LARGECAP_PARAMS } from "./momentum-config";
import { precomputeWeeklyBreakSignals } from "./weekly-break-simulation";
import { WEEKLY_BREAK_BACKTEST_DEFAULTS, WEEKLY_BREAK_LARGECAP_PARAMS } from "./weekly-break-config";
import { fetchHistoricalFromDB, fetchVixFromDB, fetchIndexFromDB } from "./data-fetcher";
import { calculateCapitalUtilization, calculateMetrics } from "./metrics";
import { runCombinedSimulation, type PositionLimits, type BreadthMode } from "./combined-simulation";
import type {
  GapUpBacktestConfig,
  PostSurgeConsolidationBacktestConfig,
  MomentumBacktestConfig,
  WeeklyBreakBacktestConfig,
  PerformanceMetrics,
  SimulatedPosition,
  DailyEquity,
} from "./types";
import type { PrecomputedMomentumSignal } from "./momentum-simulation";
import type { PrecomputedWeeklyBreakSignals } from "./weekly-break-simulation";

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
  const compareBreadthModes = args.includes("--compare-breadth-modes");
  const compareBreadthZoom = args.includes("--compare-breadth-zoom");
  const compareMaxPrice = args.includes("--compare-max-price");
  const enableMomentum = args.includes("--enable-momentum");
  const momMaxArg = getArg(args, "--mom-max");
  const enableWbLargecap = args.includes("--enable-wb-largecap");
  const wbMaxArg = getArg(args, "--wb-max");
  const maxPerSectorArg = getArg(args, "--max-per-sector");
  const compareSector = args.includes("--compare-sector");
  const compareVixRisk = args.includes("--compare-vix-risk");
  const compareStreak = args.includes("--compare-streak");
  const compareCooldown = args.includes("--compare-cooldown");

  const quietMode = comparePositions || compareSplitPositions || compareEquityFilter || compareBudget || compareTurnover || comparePrice || comparePriceTurnover || compareEfficiency || compareBreadth || compareBreadthModes || compareBreadthZoom || compareMaxPrice || compareSector || compareVixRisk || compareStreak || compareCooldown;
  const dynamicMaxPrice = getMaxBuyablePrice(budget);
  const guConfig: GapUpBacktestConfig = { ...GAPUP_BACKTEST_DEFAULTS, startDate, endDate, initialBudget: budget, maxPrice: dynamicMaxPrice, verbose: !quietMode && verbose };
  const pscConfig: PostSurgeConsolidationBacktestConfig = {
    ...PSC_BACKTEST_DEFAULTS,
    startDate, endDate, initialBudget: budget, maxPrice: dynamicMaxPrice,
    verbose: !quietMode && verbose,
    // WF最適パラメータ（config/production-params から参照）
    ...PSC_PRODUCTION_PARAMS,
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

  // budget-compare時はグリッド最大予算(20M)で銘柄をロード、max-price比較時はグリッド最大値で銘柄をロード
  // --enable-momentum / --enable-wb-largecap 時は大型株を含むため maxPriceForData を広げる
  const maxPriceForData = compareBudget
    ? getMaxBuyablePrice(20_000_000)
    : compareMaxPrice
    ? 50_000
    : (enableMomentum || enableWbLargecap)
    ? 100_000
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

  // セクターマップをロード（--max-per-sector / --compare-sector で使用）
  let tickerSectorMap: Map<string, string> | undefined;
  if (maxPerSectorArg !== undefined || compareSector) {
    const stocksWithSector = await prisma.stock.findMany({
      where: { isDelisted: false, isActive: true, isRestricted: false, sector: { not: null } },
      select: { tickerCode: true, sector: true },
    });
    tickerSectorMap = new Map();
    for (const s of stocksWithSector) {
      if (s.sector) tickerSectorMap.set(s.tickerCode, s.sector);
    }
    console.log(`[data] sectorマップ: ${tickerSectorMap.size}銘柄`);
  }

  // --enable-wb-largecap: 大型株WB戦略のシグナル計算
  let wbConfig: WeeklyBreakBacktestConfig | undefined;
  let weeklyBreakSignals: PrecomputedWeeklyBreakSignals | undefined;
  if (enableWbLargecap) {
    wbConfig = {
      ...WEEKLY_BREAK_BACKTEST_DEFAULTS,
      ...WEEKLY_BREAK_LARGECAP_PARAMS,
      startDate,
      endDate,
      initialBudget: budget,
      verbose: !quietMode && verbose,
    };

    const wbLargecapStocks = await prisma.stock.findMany({
      where: {
        isDelisted: false,
        isActive: true,
        isRestricted: false,
        marketCap: { gte: wbConfig.minMarketCap! },
      },
      select: { tickerCode: true },
    });
    const wbLargecapTickers = new Set(wbLargecapStocks.map((s) => s.tickerCode));
    console.log(`[data] WB大型株universe: ${wbLargecapTickers.size}銘柄 (時価総額 >= ¥${(wbConfig.minMarketCap! / 1_000_000_000).toLocaleString()}B)`);

    const allDataForWb = new Map<string, import("../core/technical-analysis").OHLCVData[]>();
    for (const [ticker, bars] of allData) {
      if (wbLargecapTickers.has(ticker)) allDataForWb.set(ticker, bars);
    }
    weeklyBreakSignals = precomputeWeeklyBreakSignals(wbConfig, allDataForWb, precomputed);
  }

  // --enable-momentum: 大型株モメンタム戦略のシグナル計算
  let momConfig: MomentumBacktestConfig | undefined;
  let momSignals: Map<string, PrecomputedMomentumSignal[]> | undefined;
  if (enableMomentum) {
    momConfig = {
      ...MOMENTUM_BACKTEST_DEFAULTS,
      ...MOMENTUM_LARGECAP_PARAMS,
      startDate,
      endDate,
      initialBudget: budget,
      verbose: !quietMode && verbose,
    };

    // 大型株tickerをDBからロード
    const largecapStocks = await prisma.stock.findMany({
      where: {
        isDelisted: false,
        isActive: true,
        isRestricted: false,
        marketCap: { gte: momConfig.minMarketCap! },
      },
      select: { tickerCode: true },
    });
    const largecapTickers = new Set(largecapStocks.map((s) => s.tickerCode));
    console.log(`[data] momentum大型株universe: ${largecapTickers.size}銘柄 (時価総額 >= ¥${(momConfig.minMarketCap! / 1_000_000_000).toLocaleString()}B)`);

    // precompute前に大型株だけの allData を作って渡す（top N選択が小型株に取られないように）
    const allDataForMom = new Map<string, import("../core/technical-analysis").OHLCVData[]>();
    for (const [ticker, bars] of allData) {
      if (largecapTickers.has(ticker)) allDataForMom.set(ticker, bars);
    }
    momSignals = precomputeMomentumSignals(momConfig, allDataForMom, precomputed);
  }

  const ctx = {
    guConfig,
    pscConfig,
    pscSignals,
    wbConfig,
    weeklyBreakSignals,
    momConfig,
    momSignals,
    budget,
    verbose: !quietMode && verbose,
    allData,
    precomputed,
    gapupSignals,
    vixData: vixData.size > 0 ? vixData : undefined,
    monthlyAddAmount,
    // equity SMA filter は Phase 0 の検証(2026-04-22)で全戦略に逆効果と判明したため既定は無効(0)
    // --compare-equity-filter モードでのみ値を上書きして検証する
    equityCurveSmaPeriod: 0,
    tickerSectorMap,
  };

  const defaultLimits: PositionLimits = {
    boMax: 0,
    guMax: 3,
    pscMax: 2,
    ...(enableMomentum ? { momMax: Number(momMaxArg ?? 2) } : {}),
    ...(enableWbLargecap ? { wbMax: Number(wbMaxArg ?? 2) } : {}),
    ...(maxPerSectorArg !== undefined ? { maxPerSector: Number(maxPerSectorArg) } : {}),
  };

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

  // maxPrice比較モード（大型株を含めるとエッジが残るか）
  if (compareMaxPrice) {
    const maxPriceGrid: { label: string; value: number }[] = [
      { label: "≤2,500 (現状/小中型)", value: 2_500 },
      { label: "≤5,000", value: 5_000 },
      { label: "≤10,000", value: 10_000 },
      { label: "≤20,000", value: 20_000 },
      { label: "≤50,000 (実質無制限)", value: 50_000 },
    ];

    // 価格帯別内訳用のバケット
    const priceBuckets: { label: string; min: number; max: number }[] = [
      { label: "¥0-2,500", min: 0, max: 2_500 },
      { label: "¥2,500-5,000", min: 2_500, max: 5_000 },
      { label: "¥5,000-10,000", min: 5_000, max: 10_000 },
      { label: "¥10,000-20,000", min: 10_000, max: 20_000 },
      { label: "¥20,000+", min: 20_000, max: Infinity },
    ];

    console.log(`\n=== maxPrice比較（大型株追加でエッジが残るか） ===`);
    console.log(`予算: ¥${budget.toLocaleString()}, 期間: ${startDate} → ${endDate}`);
    console.log(
      `${"maxPrice".padEnd(22)}| ${"Trades".padStart(6)} | ${"WinR".padStart(5)} | ${"PF".padStart(5)} | ${"Expect".padStart(7)} | ${"MaxDD".padStart(6)} | ${"NetRet".padStart(7)} | ${"Calmar".padStart(6)} | ${"稼働率".padStart(6)}`,
    );
    console.log("-".repeat(100));

    const years = dayjs(endDate).diff(dayjs(startDate), "day") / 365;
    const overallResults: { label: string; maxPrice: number; allTrades: SimulatedPosition[]; equityCurve: DailyEquity[] }[] = [];

    for (const row of maxPriceGrid) {
      const gc: GapUpBacktestConfig = { ...guConfig, maxPrice: row.value };
      const pc: PostSurgeConsolidationBacktestConfig = { ...pscConfig, maxPrice: row.value };
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
      const annualizedRet = years > 0 ? m.netReturnPct / years : m.netReturnPct;
      const calmar = m.maxDrawdown > 0 ? annualizedRet / m.maxDrawdown : 0;
      console.log(
        `${row.label.padEnd(22)}| ${String(m.totalTrades).padStart(6)} | ${m.winRate.toFixed(1).padStart(4)}% | ${pfStr.padStart(5)} | ${expectStr.padStart(7)} | ${m.maxDrawdown.toFixed(1).padStart(5)}% | ${m.netReturnPct.toFixed(1).padStart(6)}% | ${calmar.toFixed(2).padStart(6)} | ${util.capitalUtilizationPct.toFixed(1).padStart(5)}%`,
      );
      overallResults.push({ label: row.label, maxPrice: row.value, allTrades: result.allTrades, equityCurve: result.equityCurve });
    }

    // エントリー価格帯別内訳（新帯域の玉にエッジがあるか検証）
    console.log(`\n=== エントリー価格帯別内訳 (maxPrice=${maxPriceGrid[maxPriceGrid.length - 1].value.toLocaleString()} のBTから分割) ===`);
    const lastResult = overallResults[overallResults.length - 1];
    console.log(
      `${"価格帯".padEnd(18)}| ${"Trades".padStart(6)} | ${"WinR".padStart(5)} | ${"PF".padStart(5)} | ${"Expect".padStart(7)} | ${"AvgPnL%".padStart(7)} | ${"NetPnL".padStart(12)}`,
    );
    console.log("-".repeat(82));

    for (const bucket of priceBuckets) {
      const inBucket = lastResult.allTrades.filter(
        (t) => t.entryPrice >= bucket.min && t.entryPrice < bucket.max,
      );
      if (inBucket.length === 0) {
        console.log(`${bucket.label.padEnd(18)}| ${"0".padStart(6)} | ${"-".padStart(5)} | ${"-".padStart(5)} | ${"-".padStart(7)} | ${"-".padStart(7)} | ${"¥0".padStart(12)}`);
        continue;
      }
      const sub = calculateMetrics(inBucket, lastResult.equityCurve, budget);
      const pfStr = sub.profitFactor === Infinity ? "∞" : sub.profitFactor.toFixed(2);
      const expStr = (sub.expectancy >= 0 ? "+" : "") + sub.expectancy.toFixed(2) + "%";
      const avgPnlPct = inBucket.reduce((sum, t) => sum + (t.pnlPct ?? 0), 0) / inBucket.length;
      const avgPnlStr = (avgPnlPct >= 0 ? "+" : "") + avgPnlPct.toFixed(2) + "%";
      const netPnlStr = (sub.totalNetPnl >= 0 ? "+" : "") + `¥${sub.totalNetPnl.toLocaleString()}`;
      console.log(
        `${bucket.label.padEnd(18)}| ${String(sub.totalTrades).padStart(6)} | ${sub.winRate.toFixed(1).padStart(4)}% | ${pfStr.padStart(5)} | ${expStr.padStart(7)} | ${avgPnlStr.padStart(7)} | ${netPnlStr.padStart(12)}`,
      );
    }

    console.log("");
    await prisma.$disconnect();
    return;
  }

  // 資金効率比較モード（T+2 / リスク% / 信用金利）
  if (compareEfficiency) {
    const grid: { label: string; settlementDays: number; riskPct: number | undefined; marginInterestRate: number }[] = [
      { label: "現物T+2,2%", settlementDays: 2, riskPct: undefined, marginInterestRate: 0 },
      { label: "T+0,2%,金利0%", settlementDays: 0, riskPct: undefined, marginInterestRate: 0 },
      { label: "T+0,2%,金利2.5%", settlementDays: 0, riskPct: undefined, marginInterestRate: 0.025 },
      { label: "T+0,2%,金利3.0%", settlementDays: 0, riskPct: undefined, marginInterestRate: 0.030 },
      { label: "T+0,2%,金利3.5%", settlementDays: 0, riskPct: undefined, marginInterestRate: 0.035 },
      { label: "T+0,3%,金利3.0%", settlementDays: 0, riskPct: 3, marginInterestRate: 0.030 },
      { label: "T+0,4%,金利3.0%", settlementDays: 0, riskPct: 4, marginInterestRate: 0.030 },
    ];

    console.log("\n=== 資金効率比較（受渡日数 × リスク% × 信用金利） ===");
    console.log(
      `${"条件".padEnd(20)}| ${"Trades".padStart(6)} | ${"WinR".padStart(5)} | ${"PF".padStart(5)} | ${"Expect".padStart(7)} | ${"MaxDD".padStart(6)} | ${"NetRet".padStart(7)} | ${"Calmar".padStart(6)} | ${"稼働率".padStart(6)}`,
    );
    console.log("-".repeat(96));

    const years = dayjs(endDate).diff(dayjs(startDate), "day") / 365;

    for (const row of grid) {
      const result = runCombinedSimulation(
        {
          ...ctx,
          settlementDays: row.settlementDays,
          riskPctOverride: row.riskPct,
          marginInterestRate: row.marginInterestRate,
        },
        defaultLimits,
      );
      const m = result.totalMetrics;
      const util = calculateCapitalUtilization(result.equityCurve);
      const expectStr = (m.expectancy >= 0 ? "+" : "") + m.expectancy.toFixed(2) + "%";
      const pfStr = m.profitFactor === Infinity ? "∞" : m.profitFactor.toFixed(2);
      const annualizedRet = years > 0 ? m.netReturnPct / years : m.netReturnPct;
      const calmar = m.maxDrawdown > 0 ? annualizedRet / m.maxDrawdown : 0;
      console.log(
        `${row.label.padEnd(20)}| ${String(m.totalTrades).padStart(6)} | ${m.winRate.toFixed(1).padStart(4)}% | ${pfStr.padStart(5)} | ${expectStr.padStart(7)} | ${m.maxDrawdown.toFixed(1).padStart(5)}% | ${m.netReturnPct.toFixed(1).padStart(6)}% | ${calmar.toFixed(2).padStart(6)} | ${util.capitalUtilizationPct.toFixed(1).padStart(5)}%`,
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

  // breadthゲーティング方式の比較
  if (compareBreadthModes) {
    const REGIMES: { label: string; from: string; to: string }[] = [
      { label: "A: 平穏ボックス", from: "2024-03-01", to: "2024-07-31" },
      { label: "B: ブラマン+余震", from: "2024-08-01", to: "2024-12-31" },
      { label: "C: 関税ショック", from: "2025-02-01", to: "2025-04-30" },
      { label: "D: 大強気相場", from: "2025-05-01", to: "2026-02-28" },
      { label: "E: 直近急落", from: "2026-03-01", to: "2026-04-20" },
    ];

    type ModeSpec = { label: string; mode?: BreadthMode; modeGu?: BreadthMode; modePsc?: BreadthMode };
    const modes: ModeSpec[] = [
      // === ベースライン（前回の上位勢） ===
      { label: "現状 hard 55%", mode: { type: "hard", threshold: 0.55 } },
      { label: "hard 60%", mode: { type: "hard", threshold: 0.60 } },
      { label: "velocity 10d+55%", mode: { type: "velocity", window: 10, minLevel: 0.55 } },

      // === 異端1: Bullish band（過熱もveto） ===
      { label: "band 55-80%", mode: { type: "band", lower: 0.55, upper: 0.80 } },
      { label: "band 60-80%", mode: { type: "band", lower: 0.60, upper: 0.80 } },
      { label: "band 60-75%", mode: { type: "band", lower: 0.60, upper: 0.75 } },

      // === 異端2: 戦略別 threshold ===
      // GU は個別momentum、PSCは broad strength要求 → PSC厳しめ
      { label: "split GU50/PSC65",
        modeGu: { type: "hard", threshold: 0.50 },
        modePsc: { type: "hard", threshold: 0.65 } },
      { label: "split GU55/PSC65",
        modeGu: { type: "hard", threshold: 0.55 },
        modePsc: { type: "hard", threshold: 0.65 } },
      { label: "split GU50/PSC70",
        modeGu: { type: "hard", threshold: 0.50 },
        modePsc: { type: "hard", threshold: 0.70 } },

      // === 異端3: Z-score（regime-adaptive） ===
      { label: "zscore 60d -1σ", mode: { type: "zscore", window: 60, sigmaBelow: 1.0 } },
      { label: "zscore 60d -0.5σ", mode: { type: "zscore", window: 60, sigmaBelow: 0.5 } },
      { label: "zscore 30d -1σ", mode: { type: "zscore", window: 30, sigmaBelow: 1.0 } },

      // === 異端4: hard 60% + velocity 10d AND ===
      { label: "hard60 AND vel10",
        mode: { type: "and", modes: [
          { type: "hard", threshold: 0.60 },
          { type: "velocity", window: 10 },
        ] } },
      { label: "hard55 AND vel10",
        mode: { type: "and", modes: [
          { type: "hard", threshold: 0.55 },
          { type: "velocity", window: 10 },
        ] } },
      // 戦略別 + AND の合体技
      { label: "split GU55/PSC60+vel",
        modeGu: { type: "hard", threshold: 0.55 },
        modePsc: { type: "and", modes: [
          { type: "hard", threshold: 0.60 },
          { type: "velocity", window: 10 },
        ] } },

      // === 最終決戦: split + band の複合 ===
      // band 55-80(Calmar 9.38) と split GU55/PSC65(NetRet 222%) の長所合わせ
      { label: "split-band 55-80/65-80",
        modeGu: { type: "band", lower: 0.55, upper: 0.80 },
        modePsc: { type: "band", lower: 0.65, upper: 0.80 } },
      { label: "split-band 50-80/65-80",
        modeGu: { type: "band", lower: 0.50, upper: 0.80 },
        modePsc: { type: "band", lower: 0.65, upper: 0.80 } },
      { label: "split-band 55-80/60-80",
        modeGu: { type: "band", lower: 0.55, upper: 0.80 },
        modePsc: { type: "band", lower: 0.60, upper: 0.80 } },
    ];

    // 比較時は precompute 側のbreadthフィルターを切り、simulation側で判定
    const guCfgNoFilter: GapUpBacktestConfig = { ...guConfig, marketTrendFilter: false };
    const pscCfgNoFilter: PostSurgeConsolidationBacktestConfig = { ...pscConfig, marketTrendFilter: false };
    const guSigOpen = precomputeGapUpDailySignals(guCfgNoFilter, allData, precomputed);
    const pSigOpen = precomputePSCDailySignals(pscCfgNoFilter, allData, precomputed);

    console.log("\n=== breadthゲーティング方式の比較 ===");
    console.log(`期間: ${startDate} → ${endDate}`);
    console.log(
      `${"モード".padEnd(24)}| ${"Trades".padStart(6)} | ${"WinR".padStart(5)} | ${"PF".padStart(5)} | ${"Expect".padStart(7)} | ${"MaxDD".padStart(6)} | ${"NetRet".padStart(7)} | ${"Calmar".padStart(6)} | ${"稼働率".padStart(6)}`,
    );
    console.log("-".repeat(102));

    const overallResults: { label: string; metrics: PerformanceMetrics; util: number; allTrades: SimulatedPosition[]; equityCurve: DailyEquity[] }[] = [];

    for (const { label, mode, modeGu, modePsc } of modes) {
      const result = runCombinedSimulation(
        { ...ctx, guConfig: guCfgNoFilter, pscConfig: pscCfgNoFilter, gapupSignals: guSigOpen, pscSignals: pSigOpen, breadthMode: mode, breadthModeGu: modeGu, breadthModePsc: modePsc },
        defaultLimits,
      );
      const m = result.totalMetrics;
      const util = calculateCapitalUtilization(result.equityCurve);
      const expectStr = (m.expectancy >= 0 ? "+" : "") + m.expectancy.toFixed(2) + "%";
      const pfStr = m.profitFactor === Infinity ? "∞" : m.profitFactor.toFixed(2);
      // 年換算リターン = NetRet / (期間年数) で割ってからMaxDDで割る
      const years = dayjs(endDate).diff(dayjs(startDate), "day") / 365;
      const annualizedRet = years > 0 ? m.netReturnPct / years : m.netReturnPct;
      const calmar = m.maxDrawdown > 0 ? annualizedRet / m.maxDrawdown : 0;
      console.log(
        `${label.padEnd(24)}| ${String(m.totalTrades).padStart(6)} | ${m.winRate.toFixed(1).padStart(4)}% | ${pfStr.padStart(5)} | ${expectStr.padStart(7)} | ${m.maxDrawdown.toFixed(1).padStart(5)}% | ${m.netReturnPct.toFixed(1).padStart(6)}% | ${calmar.toFixed(2).padStart(6)} | ${util.capitalUtilizationPct.toFixed(1).padStart(5)}%`,
      );
      overallResults.push({ label, metrics: m, util: util.capitalUtilizationPct, allTrades: result.allTrades, equityCurve: result.equityCurve });
    }

    // レジーム別内訳（トレードベース）
    console.log("\n=== レジーム別トレード指標 (entryDateで分割) ===");
    for (const regime of REGIMES) {
      console.log(`\n[${regime.label}] ${regime.from} 〜 ${regime.to}`);
      console.log(
        `  ${"モード".padEnd(24)}| ${"Trades".padStart(6)} | ${"WinR".padStart(5)} | ${"PF".padStart(5)} | ${"Expect".padStart(7)} | ${"NetPnL".padStart(10)}`,
      );
      console.log("  " + "-".repeat(76));

      for (const r of overallResults) {
        const inRange = r.allTrades.filter(
          (t) => t.entryDate >= regime.from && t.entryDate <= regime.to,
        );
        const sub = calculateMetrics(inRange, r.equityCurve, budget);
        const pfStr = sub.profitFactor === Infinity ? "∞" : sub.profitFactor.toFixed(2);
        const expStr = (sub.expectancy >= 0 ? "+" : "") + sub.expectancy.toFixed(2) + "%";
        const netPnlStr = (sub.totalNetPnl >= 0 ? "+" : "") + `¥${sub.totalNetPnl.toLocaleString()}`;
        console.log(
          `  ${r.label.padEnd(24)}| ${String(sub.totalTrades).padStart(6)} | ${sub.winRate.toFixed(1).padStart(4)}% | ${pfStr.padStart(5)} | ${expStr.padStart(7)} | ${netPnlStr.padStart(10)}`,
        );
      }
    }

    console.log("");
    await prisma.$disconnect();
    return;
  }

  // breadth 下限ゾーンの個別BT（52-55% 帯の個別調査 + 下限を段階的に緩和した版）
  if (compareBreadthZoom) {
    const REGIMES: { label: string; from: string; to: string }[] = [
      { label: "A: 平穏ボックス", from: "2024-03-01", to: "2024-07-31" },
      { label: "B: ブラマン+余震", from: "2024-08-01", to: "2024-12-31" },
      { label: "C: 関税ショック", from: "2025-02-01", to: "2025-04-30" },
      { label: "D: 大強気相場", from: "2025-05-01", to: "2026-02-28" },
      { label: "E: 直近急落", from: "2026-03-01", to: "2026-04-20" },
    ];

    type ZoomSpec = { label: string; mode: BreadthMode };
    const modes: ZoomSpec[] = [
      // === sub-threshold 帯だけエントリー（今日のようなケースの過去版を直接見る） ===
      { label: "band 50-55% only", mode: { type: "band", lower: 0.50, upper: 0.55 } },
      { label: "band 52-55% only", mode: { type: "band", lower: 0.52, upper: 0.55 } },
      { label: "band 53-55% only", mode: { type: "band", lower: 0.53, upper: 0.55 } },
      { label: "band 54-55% only", mode: { type: "band", lower: 0.54, upper: 0.55 } },

      // === 下限を段階的に緩和（現在 55-80% と比較） ===
      { label: "band 50-80%", mode: { type: "band", lower: 0.50, upper: 0.80 } },
      { label: "band 52-80%", mode: { type: "band", lower: 0.52, upper: 0.80 } },
      { label: "band 53-80%", mode: { type: "band", lower: 0.53, upper: 0.80 } },
      { label: "band 54-80%", mode: { type: "band", lower: 0.54, upper: 0.80 } },
      { label: "band 55-80% (現状)", mode: { type: "band", lower: 0.55, upper: 0.80 } },
    ];

    // 比較時は precompute 側のbreadthフィルターを切り、simulation側で判定
    const guCfgNoFilter: GapUpBacktestConfig = { ...guConfig, marketTrendFilter: false };
    const pscCfgNoFilter: PostSurgeConsolidationBacktestConfig = { ...pscConfig, marketTrendFilter: false };
    const guSigOpen = precomputeGapUpDailySignals(guCfgNoFilter, allData, precomputed);
    const pSigOpen = precomputePSCDailySignals(pscCfgNoFilter, allData, precomputed);

    console.log("\n=== breadth 下限ゾーンの個別BT ===");
    console.log(`期間: ${startDate} → ${endDate}`);
    console.log(
      `${"モード".padEnd(22)}| ${"Trades".padStart(6)} | ${"WinR".padStart(5)} | ${"PF".padStart(5)} | ${"Expect".padStart(7)} | ${"MaxDD".padStart(6)} | ${"NetRet".padStart(7)} | ${"Calmar".padStart(6)} | ${"稼働率".padStart(6)}`,
    );
    console.log("-".repeat(100));

    const overallResults: { label: string; metrics: PerformanceMetrics; guMetrics: PerformanceMetrics; pscMetrics: PerformanceMetrics; allTrades: SimulatedPosition[]; equityCurve: DailyEquity[] }[] = [];
    const years = dayjs(endDate).diff(dayjs(startDate), "day") / 365;

    for (const { label, mode } of modes) {
      const result = runCombinedSimulation(
        { ...ctx, guConfig: guCfgNoFilter, pscConfig: pscCfgNoFilter, gapupSignals: guSigOpen, pscSignals: pSigOpen, breadthMode: mode },
        defaultLimits,
      );
      const m = result.totalMetrics;
      const util = calculateCapitalUtilization(result.equityCurve);
      const expectStr = (m.expectancy >= 0 ? "+" : "") + m.expectancy.toFixed(2) + "%";
      const pfStr = m.profitFactor === Infinity ? "∞" : m.profitFactor.toFixed(2);
      const annualizedRet = years > 0 ? m.netReturnPct / years : m.netReturnPct;
      const calmar = m.maxDrawdown > 0 ? annualizedRet / m.maxDrawdown : 0;
      console.log(
        `${label.padEnd(22)}| ${String(m.totalTrades).padStart(6)} | ${m.winRate.toFixed(1).padStart(4)}% | ${pfStr.padStart(5)} | ${expectStr.padStart(7)} | ${m.maxDrawdown.toFixed(1).padStart(5)}% | ${m.netReturnPct.toFixed(1).padStart(6)}% | ${calmar.toFixed(2).padStart(6)} | ${util.capitalUtilizationPct.toFixed(1).padStart(5)}%`,
      );
      overallResults.push({ label, metrics: m, guMetrics: result.guMetrics, pscMetrics: result.pscMetrics, allTrades: result.allTrades, equityCurve: result.equityCurve });
    }

    // 戦略別内訳（GU vs PSC で挙動が違うので分離）
    console.log("\n=== 戦略別内訳 (GU / PSC) ===");
    console.log(
      `${"モード".padEnd(22)}| ${"GU Trd".padStart(6)} | ${"GU PF".padStart(5)} | ${"GU Exp".padStart(7)} | ${"PSC Trd".padStart(7)} | ${"PSC PF".padStart(6)} | ${"PSC Exp".padStart(8)}`,
    );
    console.log("-".repeat(88));
    for (const r of overallResults) {
      const gm = r.guMetrics;
      const pm = r.pscMetrics;
      const gPf = gm.profitFactor === Infinity ? "∞" : gm.profitFactor.toFixed(2);
      const pPf = pm.profitFactor === Infinity ? "∞" : pm.profitFactor.toFixed(2);
      const gExp = (gm.expectancy >= 0 ? "+" : "") + gm.expectancy.toFixed(2) + "%";
      const pExp = (pm.expectancy >= 0 ? "+" : "") + pm.expectancy.toFixed(2) + "%";
      console.log(
        `${r.label.padEnd(22)}| ${String(gm.totalTrades).padStart(6)} | ${gPf.padStart(5)} | ${gExp.padStart(7)} | ${String(pm.totalTrades).padStart(7)} | ${pPf.padStart(6)} | ${pExp.padStart(8)}`,
      );
    }

    // レジーム別内訳（A: 平穏ボックスで破綻していないか特に注意）
    console.log("\n=== レジーム別トレード指標 (entryDateで分割) ===");
    for (const regime of REGIMES) {
      console.log(`\n[${regime.label}] ${regime.from} 〜 ${regime.to}`);
      console.log(
        `  ${"モード".padEnd(22)}| ${"Trades".padStart(6)} | ${"WinR".padStart(5)} | ${"PF".padStart(5)} | ${"Expect".padStart(7)} | ${"NetPnL".padStart(10)}`,
      );
      console.log("  " + "-".repeat(74));

      for (const r of overallResults) {
        const inRange = r.allTrades.filter(
          (t) => t.entryDate >= regime.from && t.entryDate <= regime.to,
        );
        const sub = calculateMetrics(inRange, r.equityCurve, budget);
        const pfStr = sub.profitFactor === Infinity ? "∞" : sub.profitFactor.toFixed(2);
        const expStr = (sub.expectancy >= 0 ? "+" : "") + sub.expectancy.toFixed(2) + "%";
        const netPnlStr = (sub.totalNetPnl >= 0 ? "+" : "") + `¥${sub.totalNetPnl.toLocaleString()}`;
        console.log(
          `  ${r.label.padEnd(22)}| ${String(sub.totalTrades).padStart(6)} | ${sub.winRate.toFixed(1).padStart(4)}% | ${pfStr.padStart(5)} | ${expStr.padStart(7)} | ${netPnlStr.padStart(10)}`,
        );
      }
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
    const REGIMES: { label: string; from: string; to: string }[] = [
      { label: "A: 平穏ボックス", from: "2024-03-01", to: "2024-07-31" },
      { label: "B: ブラマン+余震", from: "2024-08-01", to: "2024-12-31" },
      { label: "C: 関税ショック", from: "2025-02-01", to: "2025-04-30" },
      { label: "D: 大強気相場", from: "2025-05-01", to: "2026-02-28" },
      { label: "E: 直近急落", from: "2026-03-01", to: "2026-04-20" },
    ];

    const grid = [0, 10, 20, 40, 60];

    console.log("\n=== エクイティカーブフィルター比較（全戦略に適用） ===");
    console.log(`期間: ${startDate} → ${endDate}`);
    console.log(
      `${"SMA期間".padEnd(10)}| ${"Trades".padStart(6)} | ${"WinR".padStart(5)} | ${"PF".padStart(5)} | ${"Expect".padStart(7)} | ${"MaxDD".padStart(6)} | ${"NetRet".padStart(7)} | ${"Calmar".padStart(6)} | ${"ハルト日".padStart(7)}`,
    );
    console.log("-".repeat(96));

    const years = dayjs(endDate).diff(dayjs(startDate), "day") / 365;
    const overallResults: { label: string; allTrades: SimulatedPosition[]; equityCurve: DailyEquity[] }[] = [];

    for (const sma of grid) {
      const result = runCombinedSimulation(
        { ...ctx, equityCurveSmaPeriod: sma },
        defaultLimits,
      );
      const m = result.totalMetrics;
      const expectStr = (m.expectancy >= 0 ? "+" : "") + m.expectancy.toFixed(2) + "%";
      const pfStr = m.profitFactor === Infinity ? "∞" : m.profitFactor.toFixed(2);
      const annualizedRet = years > 0 ? m.netReturnPct / years : m.netReturnPct;
      const calmar = m.maxDrawdown > 0 ? annualizedRet / m.maxDrawdown : 0;
      const label = sma === 0 ? "なし" : `SMA${sma}`;
      console.log(
        `${label.padEnd(10)}| ${String(m.totalTrades).padStart(6)} | ${m.winRate.toFixed(1).padStart(4)}% | ${pfStr.padStart(5)} | ${expectStr.padStart(7)} | ${m.maxDrawdown.toFixed(1).padStart(5)}% | ${m.netReturnPct.toFixed(1).padStart(6)}% | ${calmar.toFixed(2).padStart(6)} | ${String(result.haltDays).padStart(7)}`,
      );
      overallResults.push({ label, allTrades: result.allTrades, equityCurve: result.equityCurve });
    }

    // レジーム別内訳（A期DD縮小 vs D期NetRet低下のトレードオフ確認）
    console.log("\n=== レジーム別トレード指標 (entryDateで分割) ===");
    for (const regime of REGIMES) {
      console.log(`\n[${regime.label}] ${regime.from} 〜 ${regime.to}`);
      console.log(
        `  ${"SMA期間".padEnd(10)}| ${"Trades".padStart(6)} | ${"WinR".padStart(5)} | ${"PF".padStart(5)} | ${"Expect".padStart(7)} | ${"NetPnL".padStart(10)}`,
      );
      console.log("  " + "-".repeat(62));

      for (const r of overallResults) {
        const inRange = r.allTrades.filter(
          (t) => t.entryDate >= regime.from && t.entryDate <= regime.to,
        );
        const sub = calculateMetrics(inRange, r.equityCurve, budget);
        const pfStr = sub.profitFactor === Infinity ? "∞" : sub.profitFactor.toFixed(2);
        const expStr = (sub.expectancy >= 0 ? "+" : "") + sub.expectancy.toFixed(2) + "%";
        const netPnlStr = (sub.totalNetPnl >= 0 ? "+" : "") + `¥${sub.totalNetPnl.toLocaleString()}`;
        console.log(
          `  ${r.label.padEnd(10)}| ${String(sub.totalTrades).padStart(6)} | ${sub.winRate.toFixed(1).padStart(4)}% | ${pfStr.padStart(5)} | ${expStr.padStart(7)} | ${netPnlStr.padStart(10)}`,
        );
      }
    }

    console.log("");
    await prisma.$disconnect();
    return;
  }

  // セクター分散上限比較モード
  if (compareSector) {
    const REGIMES: { label: string; from: string; to: string }[] = [
      { label: "A: 平穏ボックス", from: "2024-03-01", to: "2024-07-31" },
      { label: "B: ブラマン+余震", from: "2024-08-01", to: "2024-12-31" },
      { label: "C: 関税ショック", from: "2025-02-01", to: "2025-04-30" },
      { label: "D: 大強気相場", from: "2025-05-01", to: "2026-02-28" },
      { label: "E: 直近急落", from: "2026-03-01", to: "2026-04-20" },
    ];

    const grid: { label: string; limit: number | undefined }[] = [
      { label: "制限なし (現状)", limit: undefined },
      { label: "3件/セクター", limit: 3 },
      { label: "2件/セクター", limit: 2 },
      { label: "1件/セクター", limit: 1 },
    ];

    console.log("\n=== セクター分散上限比較 ===");
    console.log(`期間: ${startDate} → ${endDate}, 予算: ¥${budget.toLocaleString()}`);
    console.log(
      `${"上限".padEnd(18)}| ${"Trades".padStart(6)} | ${"WinR".padStart(5)} | ${"PF".padStart(5)} | ${"Expect".padStart(7)} | ${"MaxDD".padStart(6)} | ${"NetRet".padStart(7)} | ${"Calmar".padStart(6)} | ${"稼働率".padStart(6)}`,
    );
    console.log("-".repeat(96));

    const years = dayjs(endDate).diff(dayjs(startDate), "day") / 365;
    const overallResults: { label: string; allTrades: SimulatedPosition[]; equityCurve: DailyEquity[] }[] = [];

    for (const row of grid) {
      const limits: PositionLimits = {
        ...defaultLimits,
        ...(row.limit !== undefined ? { maxPerSector: row.limit } : { maxPerSector: undefined }),
      };
      const result = runCombinedSimulation(ctx, limits);
      const m = result.totalMetrics;
      const util = calculateCapitalUtilization(result.equityCurve);
      const expectStr = (m.expectancy >= 0 ? "+" : "") + m.expectancy.toFixed(2) + "%";
      const pfStr = m.profitFactor === Infinity ? "∞" : m.profitFactor.toFixed(2);
      const annualizedRet = years > 0 ? m.netReturnPct / years : m.netReturnPct;
      const calmar = m.maxDrawdown > 0 ? annualizedRet / m.maxDrawdown : 0;
      console.log(
        `${row.label.padEnd(18)}| ${String(m.totalTrades).padStart(6)} | ${m.winRate.toFixed(1).padStart(4)}% | ${pfStr.padStart(5)} | ${expectStr.padStart(7)} | ${m.maxDrawdown.toFixed(1).padStart(5)}% | ${m.netReturnPct.toFixed(1).padStart(6)}% | ${calmar.toFixed(2).padStart(6)} | ${util.capitalUtilizationPct.toFixed(1).padStart(5)}%`,
      );
      overallResults.push({ label: row.label, allTrades: result.allTrades, equityCurve: result.equityCurve });
    }

    // レジーム別内訳
    console.log("\n=== レジーム別トレード指標 ===");
    for (const regime of REGIMES) {
      console.log(`\n[${regime.label}] ${regime.from} 〜 ${regime.to}`);
      console.log(
        `  ${"上限".padEnd(18)}| ${"Trades".padStart(6)} | ${"WinR".padStart(5)} | ${"PF".padStart(5)} | ${"Expect".padStart(7)} | ${"NetPnL".padStart(10)}`,
      );
      console.log("  " + "-".repeat(68));

      for (const r of overallResults) {
        const inRange = r.allTrades.filter(
          (t) => t.entryDate >= regime.from && t.entryDate <= regime.to,
        );
        const sub = calculateMetrics(inRange, r.equityCurve, budget);
        const pfStr = sub.profitFactor === Infinity ? "∞" : sub.profitFactor.toFixed(2);
        const expStr = (sub.expectancy >= 0 ? "+" : "") + sub.expectancy.toFixed(2) + "%";
        const netPnlStr = (sub.totalNetPnl >= 0 ? "+" : "") + `¥${sub.totalNetPnl.toLocaleString()}`;
        console.log(
          `  ${r.label.padEnd(18)}| ${String(sub.totalTrades).padStart(6)} | ${sub.winRate.toFixed(1).padStart(4)}% | ${pfStr.padStart(5)} | ${expStr.padStart(7)} | ${netPnlStr.padStart(10)}`,
        );
      }
    }

    console.log("");
    await prisma.$disconnect();
    return;
  }

  // VIXレジーム別リスク%比較モード
  if (compareVixRisk) {
    const REGIMES: { label: string; from: string; to: string }[] = [
      { label: "A: 平穏ボックス", from: "2024-03-01", to: "2024-07-31" },
      { label: "B: ブラマン+余震", from: "2024-08-01", to: "2024-12-31" },
      { label: "C: 関税ショック", from: "2025-02-01", to: "2025-04-30" },
      { label: "D: 大強気相場", from: "2025-05-01", to: "2026-02-28" },
      { label: "E: 直近急落", from: "2026-03-01", to: "2026-04-20" },
    ];

    type RegimeScaleSpec = { label: string; scale: Partial<Record<import("./types").RegimeLevel, number>> | undefined };
    const grid: RegimeScaleSpec[] = [
      { label: "規定(0.5/0.25)", scale: undefined },
      { label: "旧規定(0.5/1.0)", scale: { elevated: 0.5, high: 1.0 } },
      { label: "厳格(0.25/0.125)", scale: { elevated: 0.25, high: 0.125 } },
      { label: "緩和(0.75/0.5)", scale: { elevated: 0.75, high: 0.5 } },
      { label: "一定(0.5/0.5)", scale: { elevated: 0.5, high: 0.5 } },
    ];

    console.log("\n=== VIXレジーム別リスク%比較 ===");
    console.log(`期間: ${startDate} → ${endDate}, 予算: ¥${budget.toLocaleString()}`);
    console.log(
      `${"パターン".padEnd(24)}| ${"Trades".padStart(6)} | ${"WinR".padStart(5)} | ${"PF".padStart(5)} | ${"Expect".padStart(7)} | ${"MaxDD".padStart(6)} | ${"NetRet".padStart(7)} | ${"Calmar".padStart(6)} | ${"稼働率".padStart(6)}`,
    );
    console.log("-".repeat(102));

    const years = dayjs(endDate).diff(dayjs(startDate), "day") / 365;
    const overallResults: { label: string; allTrades: SimulatedPosition[]; equityCurve: DailyEquity[] }[] = [];

    for (const row of grid) {
      const result = runCombinedSimulation(
        { ...ctx, riskScaleByRegime: row.scale },
        defaultLimits,
      );
      const m = result.totalMetrics;
      const util = calculateCapitalUtilization(result.equityCurve);
      const expectStr = (m.expectancy >= 0 ? "+" : "") + m.expectancy.toFixed(2) + "%";
      const pfStr = m.profitFactor === Infinity ? "∞" : m.profitFactor.toFixed(2);
      const annualizedRet = years > 0 ? m.netReturnPct / years : m.netReturnPct;
      const calmar = m.maxDrawdown > 0 ? annualizedRet / m.maxDrawdown : 0;
      console.log(
        `${row.label.padEnd(24)}| ${String(m.totalTrades).padStart(6)} | ${m.winRate.toFixed(1).padStart(4)}% | ${pfStr.padStart(5)} | ${expectStr.padStart(7)} | ${m.maxDrawdown.toFixed(1).padStart(5)}% | ${m.netReturnPct.toFixed(1).padStart(6)}% | ${calmar.toFixed(2).padStart(6)} | ${util.capitalUtilizationPct.toFixed(1).padStart(5)}%`,
      );
      overallResults.push({ label: row.label, allTrades: result.allTrades, equityCurve: result.equityCurve });
    }

    // レジーム別内訳
    console.log("\n=== レジーム別トレード指標 ===");
    for (const regime of REGIMES) {
      console.log(`\n[${regime.label}] ${regime.from} 〜 ${regime.to}`);
      console.log(
        `  ${"パターン".padEnd(24)}| ${"Trades".padStart(6)} | ${"WinR".padStart(5)} | ${"PF".padStart(5)} | ${"Expect".padStart(7)} | ${"NetPnL".padStart(12)}`,
      );
      console.log("  " + "-".repeat(76));

      for (const r of overallResults) {
        const inRange = r.allTrades.filter(
          (t) => t.entryDate >= regime.from && t.entryDate <= regime.to,
        );
        const sub = calculateMetrics(inRange, r.equityCurve, budget);
        const pfStr = sub.profitFactor === Infinity ? "∞" : sub.profitFactor.toFixed(2);
        const expStr = (sub.expectancy >= 0 ? "+" : "") + sub.expectancy.toFixed(2) + "%";
        const netPnlStr = (sub.totalNetPnl >= 0 ? "+" : "") + `¥${sub.totalNetPnl.toLocaleString()}`;
        console.log(
          `  ${r.label.padEnd(24)}| ${String(sub.totalTrades).padStart(6)} | ${sub.winRate.toFixed(1).padStart(4)}% | ${pfStr.padStart(5)} | ${expStr.padStart(7)} | ${netPnlStr.padStart(12)}`,
        );
      }
    }

    console.log("");
    await prisma.$disconnect();
    return;
  }

  // 連敗スロットル比較モード
  if (compareStreak) {
    const REGIMES: { label: string; from: string; to: string }[] = [
      { label: "A: 平穏ボックス", from: "2024-03-01", to: "2024-07-31" },
      { label: "B: ブラマン+余震", from: "2024-08-01", to: "2024-12-31" },
      { label: "C: 関税ショック", from: "2025-02-01", to: "2025-04-30" },
      { label: "D: 大強気相場", from: "2025-05-01", to: "2026-02-28" },
      { label: "E: 直近急落", from: "2026-03-01", to: "2026-04-20" },
    ];

    type StreakSpec = {
      label: string;
      cfg: { window: number; threshold: number; scale: number; minSample: number } | undefined;
    };
    const grid: StreakSpec[] = [
      { label: "OFF (現状)", cfg: undefined },
      { label: "w20 t40% s0.5", cfg: { window: 20, threshold: 0.40, scale: 0.5, minSample: 10 } },
      { label: "w30 t40% s0.5", cfg: { window: 30, threshold: 0.40, scale: 0.5, minSample: 10 } },
      { label: "w20 t40% s0.25", cfg: { window: 20, threshold: 0.40, scale: 0.25, minSample: 10 } },
      { label: "w20 t45% s0.5", cfg: { window: 20, threshold: 0.45, scale: 0.5, minSample: 10 } },
      { label: "w20 t35% s0.5", cfg: { window: 20, threshold: 0.35, scale: 0.5, minSample: 10 } },
    ];

    console.log("\n=== 連敗スロットル比較 (直近N件の全戦略WinRate<閾値でサイズ縮小) ===");
    console.log(`期間: ${startDate} → ${endDate}, 予算: ¥${budget.toLocaleString()}`);
    console.log(
      `${"設定".padEnd(20)}| ${"Trades".padStart(6)} | ${"WinR".padStart(5)} | ${"PF".padStart(5)} | ${"Expect".padStart(7)} | ${"MaxDD".padStart(6)} | ${"NetRet".padStart(7)} | ${"Calmar".padStart(6)} | ${"稼働率".padStart(6)}`,
    );
    console.log("-".repeat(98));

    const years = dayjs(endDate).diff(dayjs(startDate), "day") / 365;
    const overallResults: { label: string; allTrades: SimulatedPosition[]; equityCurve: DailyEquity[] }[] = [];

    for (const row of grid) {
      const result = runCombinedSimulation(
        { ...ctx, loseStreakScaling: row.cfg },
        defaultLimits,
      );
      const m = result.totalMetrics;
      const util = calculateCapitalUtilization(result.equityCurve);
      const expectStr = (m.expectancy >= 0 ? "+" : "") + m.expectancy.toFixed(2) + "%";
      const pfStr = m.profitFactor === Infinity ? "∞" : m.profitFactor.toFixed(2);
      const annualizedRet = years > 0 ? m.netReturnPct / years : m.netReturnPct;
      const calmar = m.maxDrawdown > 0 ? annualizedRet / m.maxDrawdown : 0;
      console.log(
        `${row.label.padEnd(20)}| ${String(m.totalTrades).padStart(6)} | ${m.winRate.toFixed(1).padStart(4)}% | ${pfStr.padStart(5)} | ${expectStr.padStart(7)} | ${m.maxDrawdown.toFixed(1).padStart(5)}% | ${m.netReturnPct.toFixed(1).padStart(6)}% | ${calmar.toFixed(2).padStart(6)} | ${util.capitalUtilizationPct.toFixed(1).padStart(5)}%`,
      );
      overallResults.push({ label: row.label, allTrades: result.allTrades, equityCurve: result.equityCurve });
    }

    // レジーム別内訳
    console.log("\n=== レジーム別トレード指標 ===");
    for (const regime of REGIMES) {
      console.log(`\n[${regime.label}] ${regime.from} 〜 ${regime.to}`);
      console.log(
        `  ${"設定".padEnd(20)}| ${"Trades".padStart(6)} | ${"WinR".padStart(5)} | ${"PF".padStart(5)} | ${"Expect".padStart(7)} | ${"NetPnL".padStart(12)}`,
      );
      console.log("  " + "-".repeat(72));

      for (const r of overallResults) {
        const inRange = r.allTrades.filter(
          (t) => t.entryDate >= regime.from && t.entryDate <= regime.to,
        );
        const sub = calculateMetrics(inRange, r.equityCurve, budget);
        const pfStr = sub.profitFactor === Infinity ? "∞" : sub.profitFactor.toFixed(2);
        const expStr = (sub.expectancy >= 0 ? "+" : "") + sub.expectancy.toFixed(2) + "%";
        const netPnlStr = (sub.totalNetPnl >= 0 ? "+" : "") + `¥${sub.totalNetPnl.toLocaleString()}`;
        console.log(
          `  ${r.label.padEnd(20)}| ${String(sub.totalTrades).padStart(6)} | ${sub.winRate.toFixed(1).padStart(4)}% | ${pfStr.padStart(5)} | ${expStr.padStart(7)} | ${netPnlStr.padStart(12)}`,
        );
      }
    }

    console.log("");
    await prisma.$disconnect();
    return;
  }

  // cooldownDays 比較モード (GU + PSC 同値で振る)
  if (compareCooldown) {
    const REGIMES: { label: string; from: string; to: string }[] = [
      { label: "A: 平穏ボックス", from: "2024-03-01", to: "2024-07-31" },
      { label: "B: ブラマン+余震", from: "2024-08-01", to: "2024-12-31" },
      { label: "C: 関税ショック", from: "2025-02-01", to: "2025-04-30" },
      { label: "D: 大強気相場", from: "2025-05-01", to: "2026-02-28" },
      { label: "E: 直近急落", from: "2026-03-01", to: "2026-04-20" },
    ];

    const grid: { label: string; days: number }[] = [
      { label: "0日 (クールダウン無し)", days: 0 },
      { label: "3日 (現状)", days: 3 },
      { label: "5日", days: 5 },
      { label: "10日", days: 10 },
      { label: "20日 (月1回まで)", days: 20 },
    ];

    console.log("\n=== cooldownDays 比較 (GU + PSC 同値) ===");
    console.log(`期間: ${startDate} → ${endDate}, 予算: ¥${budget.toLocaleString()}`);
    console.log(
      `${"設定".padEnd(24)}| ${"Trades".padStart(6)} | ${"WinR".padStart(5)} | ${"PF".padStart(5)} | ${"Expect".padStart(7)} | ${"MaxDD".padStart(6)} | ${"NetRet".padStart(7)} | ${"Calmar".padStart(6)} | ${"稼働率".padStart(6)}`,
    );
    console.log("-".repeat(102));

    const years = dayjs(endDate).diff(dayjs(startDate), "day") / 365;
    const overallResults: { label: string; allTrades: SimulatedPosition[]; equityCurve: DailyEquity[] }[] = [];

    for (const row of grid) {
      const gc: GapUpBacktestConfig = { ...guConfig, cooldownDays: row.days };
      const pc: PostSurgeConsolidationBacktestConfig = { ...pscConfig, cooldownDays: row.days };
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
      const annualizedRet = years > 0 ? m.netReturnPct / years : m.netReturnPct;
      const calmar = m.maxDrawdown > 0 ? annualizedRet / m.maxDrawdown : 0;
      console.log(
        `${row.label.padEnd(24)}| ${String(m.totalTrades).padStart(6)} | ${m.winRate.toFixed(1).padStart(4)}% | ${pfStr.padStart(5)} | ${expectStr.padStart(7)} | ${m.maxDrawdown.toFixed(1).padStart(5)}% | ${m.netReturnPct.toFixed(1).padStart(6)}% | ${calmar.toFixed(2).padStart(6)} | ${util.capitalUtilizationPct.toFixed(1).padStart(5)}%`,
      );
      overallResults.push({ label: row.label, allTrades: result.allTrades, equityCurve: result.equityCurve });
    }

    // レジーム別内訳
    console.log("\n=== レジーム別トレード指標 ===");
    for (const regime of REGIMES) {
      console.log(`\n[${regime.label}] ${regime.from} 〜 ${regime.to}`);
      console.log(
        `  ${"設定".padEnd(24)}| ${"Trades".padStart(6)} | ${"WinR".padStart(5)} | ${"PF".padStart(5)} | ${"Expect".padStart(7)} | ${"NetPnL".padStart(12)}`,
      );
      console.log("  " + "-".repeat(76));

      for (const r of overallResults) {
        const inRange = r.allTrades.filter(
          (t) => t.entryDate >= regime.from && t.entryDate <= regime.to,
        );
        const sub = calculateMetrics(inRange, r.equityCurve, budget);
        const pfStr = sub.profitFactor === Infinity ? "∞" : sub.profitFactor.toFixed(2);
        const expStr = (sub.expectancy >= 0 ? "+" : "") + sub.expectancy.toFixed(2) + "%";
        const netPnlStr = (sub.totalNetPnl >= 0 ? "+" : "") + `¥${sub.totalNetPnl.toLocaleString()}`;
        console.log(
          `  ${r.label.padEnd(24)}| ${String(sub.totalTrades).padStart(6)} | ${sub.winRate.toFixed(1).padStart(4)}% | ${pfStr.padStart(5)} | ${expStr.padStart(7)} | ${netPnlStr.padStart(12)}`,
        );
      }
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
  const slotsParts = [`GU${defaultLimits.guMax}`, `PSC${defaultLimits.pscMax ?? 0}`];
  if (enableWbLargecap) slotsParts.push(`WB${defaultLimits.wbMax ?? 0}`);
  if (enableMomentum) slotsParts.push(`MOM${defaultLimits.momMax ?? 0}`);
  console.log(`ポジション枠: ${slotsParts.join(" + ")}`);
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
  if (enableWbLargecap) {
    printMetrics(result.wbMetrics, "WeeklyBreak (大型株)");
  }
  if (enableMomentum) {
    printMetrics(result.momMetrics, "Momentum (大型株)");
  }

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
