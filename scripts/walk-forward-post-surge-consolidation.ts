// scripts/walk-forward-post-surge-consolidation.ts
/**
 * 高騰後押し目（Post-Surge Consolidation）Walk-Forward 分析
 *
 * IS（In-Sample）6ヶ月 / OOS（Out-of-Sample）3ヶ月
 * 3ヶ月スライド × 7ウィンドウ = 27ヶ月
 *
 * Usage:
 *   npm run walk-forward:psc
 *   npm run walk-forward:psc -- --max-pf
 */

import dayjs from "dayjs";
import { prisma } from "../src/lib/prisma";
import { fetchHistoricalFromDB, fetchVixFromDB, fetchIndexFromDB } from "../src/backtest/data-fetcher";
import { precomputeSimData } from "../src/backtest/breakout-simulation";
import { runPSCBacktest, precomputePSCDailySignals } from "../src/backtest/post-surge-consolidation-simulation";
import { PSC_BACKTEST_DEFAULTS, generatePSCParameterCombinations } from "../src/backtest/post-surge-consolidation-config";
import type { PostSurgeConsolidationBacktestConfig, PerformanceMetrics } from "../src/backtest/types";
import type { OHLCVData } from "../src/core/technical-analysis";

const IS_MONTHS = 6;
const OOS_MONTHS = 3;
const SLIDE_MONTHS = 3;
const NUM_WINDOWS = 7;
const TOTAL_MONTHS = IS_MONTHS + OOS_MONTHS + SLIDE_MONTHS * (NUM_WINDOWS - 1);

/** IS最低PFゲート */
const MIN_IS_PF = 0.5;

interface WindowResult {
  windowIdx: number;
  isStart: string;
  isEnd: string;
  oosStart: string;
  oosEnd: string;
  bestIsParams: Partial<PostSurgeConsolidationBacktestConfig>;
  isMetrics: PerformanceMetrics;
  oosMetrics: PerformanceMetrics | null;
}

interface ComboResult {
  params: Partial<PostSurgeConsolidationBacktestConfig>;
  metrics: PerformanceMetrics;
}

function paramComboKey(params: Partial<PostSurgeConsolidationBacktestConfig>): string {
  return `atr${params.atrMultiplier}_be${params.beActivationMultiplier}_trail${params.trailMultiplier}`;
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
  const maxDailyEntriesArg = args.find((a) => a.startsWith("--max-daily-entries="));
  const maxDailyEntries = maxDailyEntriesArg ? parseInt(maxDailyEntriesArg.split("=")[1], 10) : undefined;
  const endDate = dayjs().format("YYYY-MM-DD");
  const startDate = dayjs().subtract(TOTAL_MONTHS, "month").format("YYYY-MM-DD");

  console.log("=".repeat(70));
  console.log("高騰後押し目（Post-Surge Consolidation）Walk-Forward 分析");
  console.log("=".repeat(70));
  console.log(`分析期間: ${startDate} → ${endDate} (${TOTAL_MONTHS}ヶ月)`);
  console.log(`IS: ${IS_MONTHS}ヶ月 / OOS: ${OOS_MONTHS}ヶ月 / スライド: ${SLIDE_MONTHS}ヶ月`);
  console.log(`ウィンドウ数: ${NUM_WINDOWS}`);
  console.log(`選択方式: 最大PF`);
  if (maxDailyEntries != null) console.log(`1日最大エントリー: ${maxDailyEntries}件`);

  const paramCombos = generatePSCParameterCombinations();
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

  const maxPrice = PSC_BACKTEST_DEFAULTS.maxPrice;
  const allData = new Map<string, OHLCVData[]>();
  for (const [ticker, bars] of rawData) {
    if (bars.some((b) => b.close <= maxPrice && b.close > 0)) {
      allData.set(ticker, bars);
    }
  }
  console.log(`[data] ${allData.size}銘柄（フィルタ後）`);
  console.log("");

  const windows = generateWindows(startDate);
  const filterCfg = PSC_BACKTEST_DEFAULTS;
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
      filterCfg.marketTrendFilter ?? true,
      filterCfg.indexTrendFilter ?? false,
      filterCfg.indexTrendSmaPeriod ?? 50,
      indexArg,
      undefined,
      undefined,
      filterCfg.indexTrendOffBufferPct ?? 0,
      filterCfg.indexTrendOnBufferPct ?? 0,
    );
    const isSignals = precomputePSCDailySignals(filterCfg, allData, isPrecomputed);

    // IS: 全パラメータ組み合わせテスト
    const comboResults = new Map<string, ComboResult>();

    for (const params of paramCombos) {
      const config: PostSurgeConsolidationBacktestConfig = {
        ...PSC_BACKTEST_DEFAULTS,
        ...params,
        startDate: isStart,
        endDate: isEnd,
        verbose: false,
        ...(maxDailyEntries != null ? { maxDailyEntries } : {}),
      };
      const result = runPSCBacktest(config, allData, vixArg, indexArg, isPrecomputed, isSignals);
      if (result.metrics.totalTrades < 3) continue;
      comboResults.set(paramComboKey(params), { params, metrics: result.metrics });
    }

    const selected = selectByMaxPF(comboResults);

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
      filterCfg.marketTrendFilter ?? true,
      filterCfg.indexTrendFilter ?? false,
      filterCfg.indexTrendSmaPeriod ?? 50,
      indexArg,
      undefined,
      undefined,
      filterCfg.indexTrendOffBufferPct ?? 0,
      filterCfg.indexTrendOnBufferPct ?? 0,
    );
    const oosSignals = precomputePSCDailySignals(filterCfg, allData, oosPrecomputed);

    const oosConfig: PostSurgeConsolidationBacktestConfig = {
      ...PSC_BACKTEST_DEFAULTS,
      ...bestParams,
      startDate: oosStart,
      endDate: oosEnd,
      verbose: false,
      ...(maxDailyEntries != null ? { maxDailyEntries } : {}),
    };
    const oosResult = runPSCBacktest(oosConfig, allData, vixArg, indexArg, oosPrecomputed, oosSignals);

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
  console.log("-".repeat(85));
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
  const exitKeys = ["atrMultiplier", "beActivationMultiplier", "trailMultiplier"] as const;
  for (const key of exitKeys) {
    const values = activeResults.map((r) => r.bestIsParams[key]);
    const uniqueValues = [...new Set(values)];
    const stability = uniqueValues.length === 1 ? "安定" : uniqueValues.length <= 2 ? "やや安定" : "不安定";
    console.log(`  ${key}: ${uniqueValues.join(", ")} → ${stability}`);
  }
}

main().catch((err) => {
  console.error("PSC WFエラー:", err);
  process.exit(1);
});
