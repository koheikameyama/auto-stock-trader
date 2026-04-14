// scripts/walk-forward-ma-pullback.ts
/**
 * MA押し目買い戦略 Walk-Forward 分析
 *
 * IS（In-Sample）6ヶ月 / OOS（Out-of-Sample）3ヶ月
 * 3ヶ月スライド × 6ウィンドウ = 24ヶ月
 *
 * Usage:
 *   npm run walk-forward:ma-pullback
 *   npm run walk-forward:ma-pullback -- --max-pf
 */

import dayjs from "dayjs";
import { prisma } from "../src/lib/prisma";
import { fetchHistoricalFromDB, fetchVixFromDB, fetchIndexFromDB } from "../src/backtest/data-fetcher";
import { precomputeSimData } from "../src/backtest/breakout-simulation";
import { runMaPullbackBacktest, precomputeMaPullbackDailySignals } from "../src/backtest/ma-pullback-simulation";
import { MA_PULLBACK_BACKTEST_DEFAULTS, generateMaPullbackParameterCombinations, MA_PULLBACK_PARAMETER_GRID } from "../src/backtest/ma-pullback-config";
import type { MaPullbackBacktestConfig, PerformanceMetrics } from "../src/backtest/types";
import type { OHLCVData } from "../src/core/technical-analysis";

const IS_MONTHS = 6;
const OOS_MONTHS = 3;
const SLIDE_MONTHS = 3;
const NUM_WINDOWS = 6;
const TOTAL_MONTHS = IS_MONTHS + OOS_MONTHS + SLIDE_MONTHS * (NUM_WINDOWS - 1);

/** IS最低PFゲート */
const MIN_IS_PF = 0.5;

interface WindowResult {
  windowIdx: number;
  isStart: string;
  isEnd: string;
  oosStart: string;
  oosEnd: string;
  bestIsParams: Partial<MaPullbackBacktestConfig>;
  isMetrics: PerformanceMetrics;
  oosMetrics: PerformanceMetrics | null;
}

interface ComboResult {
  params: Partial<MaPullbackBacktestConfig>;
  metrics: PerformanceMetrics;
}

function paramComboKey(params: Partial<MaPullbackBacktestConfig>): string {
  return `${params.atrMultiplier}_${params.beActivationMultiplier}_${params.trailMultiplier}`;
}

function calcMedian(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

function selectByMaxPF(comboResults: Map<string, ComboResult>): ComboResult | null {
  let bestPF = -Infinity;
  let best: ComboResult | null = null;
  for (const result of comboResults.values()) {
    if (result.metrics.profitFactor > bestPF) {
      bestPF = result.metrics.profitFactor;
      best = result;
    }
  }
  return best;
}

function selectByRobustness(comboResults: Map<string, ComboResult>): ComboResult | null {
  const gridArrays: number[][] = [
    [...MA_PULLBACK_PARAMETER_GRID.atrMultiplier],
    [...MA_PULLBACK_PARAMETER_GRID.beActivationMultiplier],
    [...MA_PULLBACK_PARAMETER_GRID.trailMultiplier],
  ];
  const gridSizes = gridArrays.map((a) => a.length);

  let bestScore = -Infinity;
  let best: ComboResult | null = null;

  for (const result of comboResults.values()) {
    const p = result.params;
    const indices = [
      gridArrays[0].indexOf(p.atrMultiplier!),
      gridArrays[1].indexOf(p.beActivationMultiplier!),
      gridArrays[2].indexOf(p.trailMultiplier!),
    ];

    const neighborPFs: number[] = [];
    const ranges = indices.map((idx, dim) => {
      const vals: number[] = [];
      for (let i = Math.max(0, idx - 1); i <= Math.min(gridSizes[dim] - 1, idx + 1); i++) {
        vals.push(i);
      }
      return vals;
    });

    function collectNeighbors(dim: number, current: number[]): void {
      if (dim === ranges.length) {
        const nKey = current.map((i, d) => gridArrays[d][i]).join("_");
        const nResult = comboResults.get(nKey);
        if (nResult) neighborPFs.push(nResult.metrics.profitFactor);
        return;
      }
      for (const idx of ranges[dim]) {
        collectNeighbors(dim + 1, [...current, idx]);
      }
    }
    collectNeighbors(0, []);

    const score = calcMedian(neighborPFs);
    if (score > bestScore) {
      bestScore = score;
      best = result;
    }
  }

  return best;
}

function generateWindows(startDate: string): Array<{
  isStart: string; isEnd: string; oosStart: string; oosEnd: string;
}> {
  const windows = [];
  for (let w = 0; w < NUM_WINDOWS; w++) {
    const isStart = dayjs(startDate).add(w * SLIDE_MONTHS, "month").format("YYYY-MM-DD");
    const isEnd = dayjs(isStart).add(IS_MONTHS, "month").subtract(1, "day").format("YYYY-MM-DD");
    const oosStart = dayjs(isEnd).add(1, "day").format("YYYY-MM-DD");
    const oosEnd = dayjs(oosStart).add(OOS_MONTHS, "month").subtract(1, "day").format("YYYY-MM-DD");
    windows.push({ isStart, isEnd, oosStart, oosEnd });
  }
  return windows;
}

function judge(oosAggregatePF: number, isOosRatio: number): string {
  if (oosAggregatePF >= 1.3 && isOosRatio <= 2.0) return "堅牢 ✓";
  if (oosAggregatePF >= 1.0 && isOosRatio <= 3.0) return "要注意 △";
  return "過学習 ✗";
}

function formatPF(pf: number): string {
  if (pf === Infinity) return "∞";
  return pf.toFixed(2);
}

function padPF(pf: number): string {
  return formatPF(pf).padStart(7);
}

async function main() {
  const args = process.argv.slice(2);
  const useRobust = !args.includes("--max-pf");
  const maxDailyEntriesArg = args.find((a) => a.startsWith("--max-daily-entries="));
  const maxDailyEntries = maxDailyEntriesArg ? parseInt(maxDailyEntriesArg.split("=")[1], 10) : undefined;
  const endDate = dayjs().format("YYYY-MM-DD");
  const startDate = dayjs().subtract(TOTAL_MONTHS, "month").format("YYYY-MM-DD");

  console.log("=".repeat(70));
  console.log("MA押し目買い戦略 Walk-Forward 分析");
  console.log("=".repeat(70));
  console.log(`分析期間: ${startDate} → ${endDate} (${TOTAL_MONTHS}ヶ月)`);
  console.log(`IS: ${IS_MONTHS}ヶ月 / OOS: ${OOS_MONTHS}ヶ月 / スライド: ${SLIDE_MONTHS}ヶ月`);
  console.log(`ウィンドウ数: ${NUM_WINDOWS}`);
  console.log(`選択方式: ${useRobust ? "ロバスト（近傍中央値PF）" : "最大PF"}`);
  if (maxDailyEntries != null) console.log(`1日最大エントリー: ${maxDailyEntries}件`);

  const paramCombos = generateMaPullbackParameterCombinations();
  console.log(`パラメータ組み合わせ: ${paramCombos.length}通り`);
  console.log("");

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
  console.log(`[data] ${rawData.size}銘柄（raw）, VIX ${vixData.size}日, N225 ${indexData.size}日`);

  const maxPrice = MA_PULLBACK_BACKTEST_DEFAULTS.maxPrice;
  const allData = new Map<string, OHLCVData[]>();
  for (const [ticker, bars] of rawData) {
    if (bars.some((b) => b.close <= maxPrice && b.close > 0)) {
      allData.set(ticker, bars);
    }
  }
  console.log(`[data] ${allData.size}銘柄（フィルタ後）`);
  console.log("");

  const windows = generateWindows(startDate);
  const filterCfg = MA_PULLBACK_BACKTEST_DEFAULTS;
  const vixArg = vixData.size > 0 ? vixData : undefined;
  const indexArg = indexData.size > 0 ? indexData : undefined;

  const results: WindowResult[] = [];

  for (let w = 0; w < windows.length; w++) {
    const { isStart, isEnd, oosStart, oosEnd } = windows[w];
    console.log(`━━━ Window ${w + 1}/${NUM_WINDOWS} ━━━`);
    console.log(`  IS:  ${isStart} → ${isEnd}`);
    console.log(`  OOS: ${oosStart} → ${oosEnd}`);

    // IS 事前計算
    const isPrecomputed = precomputeSimData(
      isStart, isEnd, allData,
      filterCfg.marketTrendFilter ?? false,
      filterCfg.indexTrendFilter ?? false,
      filterCfg.indexTrendSmaPeriod ?? 50,
      indexArg,
      undefined,
      undefined,
      filterCfg.indexTrendOffBufferPct ?? 0,
      filterCfg.indexTrendOnBufferPct ?? 0,
    );
    const isSignals = precomputeMaPullbackDailySignals(filterCfg, allData, isPrecomputed);

    // IS: 全パラメータ組み合わせテスト
    const comboResults = new Map<string, ComboResult>();

    for (const params of paramCombos) {
      const config: MaPullbackBacktestConfig = {
        ...MA_PULLBACK_BACKTEST_DEFAULTS,
        ...params,
        startDate: isStart,
        endDate: isEnd,
        verbose: false,
        ...(maxDailyEntries != null ? { maxDailyEntries } : {}),
      };
      const result = runMaPullbackBacktest(config, allData, vixArg, indexArg, isPrecomputed, isSignals);
      if (result.metrics.totalTrades < 3) continue;
      comboResults.set(paramComboKey(params), { params, metrics: result.metrics });
    }

    const selected = useRobust ? selectByRobustness(comboResults) : selectByMaxPF(comboResults);

    if (!selected) {
      console.log("  ⚠ IS期間でトレードが発生しなかったためスキップ");
      console.log("");
      continue;
    }

    const bestParams = selected.params;
    const bestIsMetrics = selected.metrics;

    // IS PFゲート
    if (bestIsMetrics.profitFactor < MIN_IS_PF) {
      console.log(`  IS  最適PF: ${formatPF(bestIsMetrics.profitFactor)} (${bestIsMetrics.totalTrades}tr, 勝率${bestIsMetrics.winRate}%)`);
      console.log(`  ⏸ IS最適PF < ${MIN_IS_PF} → OOS期間は休止`);
      console.log("");
      results.push({
        windowIdx: w, isStart, isEnd, oosStart, oosEnd,
        bestIsParams: bestParams, isMetrics: bestIsMetrics, oosMetrics: null,
      });
      continue;
    }

    // OOS 事前計算 & 評価
    const oosPrecomputed = precomputeSimData(
      oosStart, oosEnd, allData,
      filterCfg.marketTrendFilter ?? false,
      filterCfg.indexTrendFilter ?? false,
      filterCfg.indexTrendSmaPeriod ?? 50,
      indexArg,
      undefined,
      undefined,
      filterCfg.indexTrendOffBufferPct ?? 0,
      filterCfg.indexTrendOnBufferPct ?? 0,
    );
    const oosSignals = precomputeMaPullbackDailySignals(filterCfg, allData, oosPrecomputed);

    const oosConfig: MaPullbackBacktestConfig = {
      ...MA_PULLBACK_BACKTEST_DEFAULTS,
      ...bestParams,
      startDate: oosStart,
      endDate: oosEnd,
      verbose: false,
      ...(maxDailyEntries != null ? { maxDailyEntries } : {}),
    };
    const oosResult = runMaPullbackBacktest(oosConfig, allData, vixArg, indexArg, oosPrecomputed, oosSignals);

    results.push({
      windowIdx: w, isStart, isEnd, oosStart, oosEnd,
      bestIsParams: bestParams, isMetrics: bestIsMetrics, oosMetrics: oosResult.metrics,
    });

    console.log(`  IS  最適PF: ${formatPF(bestIsMetrics.profitFactor)} (${bestIsMetrics.totalTrades}tr, 勝率${bestIsMetrics.winRate}%)`);
    console.log(`  OOS PF:     ${formatPF(oosResult.metrics.profitFactor)} (${oosResult.metrics.totalTrades}tr, 勝率${oosResult.metrics.winRate}%)`);
    console.log(`  最適パラメータ: atr=${bestParams.atrMultiplier}, be=${bestParams.beActivationMultiplier}, trail=${bestParams.trailMultiplier}`);
    console.log("");
  }

  // サマリー
  printSummary(results);

  await prisma.$disconnect();
}

function printSummary(results: WindowResult[]): void {
  console.log("=".repeat(70));
  console.log("Walk-Forward サマリー");
  console.log("=".repeat(70));

  if (!results.length) {
    console.log("結果なし");
    return;
  }

  const activeResults = results.filter((r) => r.oosMetrics !== null);
  const skippedCount = results.length - activeResults.length;

  let oosGrossProfit = 0;
  let oosGrossLoss = 0;
  let oosTotalTrades = 0;
  let oosWins = 0;

  for (const r of activeResults) {
    const oos = r.oosMetrics!;
    oosTotalTrades += oos.totalTrades;
    oosWins += oos.wins;
    if (oos.wins > 0) oosGrossProfit += oos.avgWinPct * oos.wins;
    if (oos.losses > 0) oosGrossLoss += Math.abs(oos.avgLossPct) * oos.losses;
  }

  const oosAggregatePF = oosGrossLoss > 0 ? oosGrossProfit / oosGrossLoss : oosGrossProfit > 0 ? Infinity : 0;
  const oosWinRate = oosTotalTrades > 0 ? (oosWins / oosTotalTrades) * 100 : 0;
  const isAvgPF = results.reduce((s, r) => s + r.isMetrics.profitFactor, 0) / results.length;
  const oosAvgPF = activeResults.length > 0
    ? activeResults.reduce((s, r) => s + r.oosMetrics!.profitFactor, 0) / activeResults.length
    : 0;
  const isOosRatio = oosAvgPF > 0 ? isAvgPF / oosAvgPF : Infinity;

  console.log(`\nOOS集計:`);
  console.log(`  アクティブウィンドウ: ${activeResults.length}/${results.length}（休止: ${skippedCount}）`);
  console.log(`  総トレード: ${oosTotalTrades}`);
  console.log(`  勝率: ${oosWinRate.toFixed(1)}%`);
  console.log(`  集計PF: ${formatPF(oosAggregatePF)}`);
  console.log(`  IS平均PF: ${formatPF(isAvgPF)}`);
  console.log(`  OOS平均PF: ${formatPF(oosAvgPF)}`);
  console.log(`  IS/OOS PF比: ${isOosRatio.toFixed(2)}`);

  const judgment = judge(oosAggregatePF, isOosRatio);
  console.log(`\n${"━".repeat(30)}`);
  console.log(`判定: ${judgment}`);
  console.log(`${"━".repeat(30)}`);

  // ウィンドウ別
  console.log("\n[ウィンドウ別]");
  console.log("Window | IS PF   | OOS PF  | OOS勝率 | OOSトレード | 最適パラメータ");
  console.log("-".repeat(90));
  for (const r of results) {
    const p = r.bestIsParams;
    const paramStr = `atr=${p.atrMultiplier} be=${p.beActivationMultiplier} trail=${p.trailMultiplier}`;
    if (r.oosMetrics === null) {
      console.log(
        `  ${r.windowIdx + 1}    | ${padPF(r.isMetrics.profitFactor)} |    休止 |      -  |           - | ${paramStr}`,
      );
    } else {
      console.log(
        `  ${r.windowIdx + 1}    | ${padPF(r.isMetrics.profitFactor)} | ${padPF(r.oosMetrics.profitFactor)} | ` +
        `${r.oosMetrics.winRate.toFixed(1).padStart(5)}%  | ${String(r.oosMetrics.totalTrades).padStart(11)} | ${paramStr}`,
      );
    }
  }

  // パラメータ安定性
  console.log("\n[パラメータ安定性]");
  const paramKeys = ["atrMultiplier", "beActivationMultiplier", "trailMultiplier"] as const;
  for (const key of paramKeys) {
    const values = activeResults.map((r) => r.bestIsParams[key]);
    const uniqueValues = [...new Set(values)];
    const stability = uniqueValues.length === 1 ? "安定" : uniqueValues.length <= 2 ? "やや安定" : "不安定";
    console.log(`  ${key}: ${uniqueValues.join(", ")} → ${stability}`);
  }
}

main().catch((err) => {
  console.error("Walk-Forward分析エラー:", err);
  process.exit(1);
});
