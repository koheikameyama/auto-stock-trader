/**
 * ブレイクアウト戦略 Walk-Forward 分析
 *
 * IS（In-Sample）6ヶ月 / OOS（Out-of-Sample）3ヶ月
 * 3ヶ月スライド × 6ウィンドウ = 24ヶ月
 *
 * パラメータグリッド（81通り）を IS で最適化し、
 * OOS で汎化性能を検証する。
 *
 * 選択方式:
 *   デフォルト: ロバスト（近傍中央値PF） — 孤立ピークを避ける
 *   --max-pf:   従来の最大PF選択
 *
 * Usage:
 *   npm run walk-forward:breakout
 *   npm run walk-forward:breakout -- --max-pf
 */

import dayjs from "dayjs";
import { prisma } from "../src/lib/prisma";
import { fetchHistoricalFromDB, fetchVixFromDB, fetchIndexFromDB } from "../src/backtest/data-fetcher";
import { runBreakoutBacktest, precomputeSimData, precomputeDailySignals } from "../src/backtest/breakout-simulation";
import { BREAKOUT_BACKTEST_DEFAULTS, generateParameterCombinations, PARAMETER_GRID } from "../src/backtest/breakout-config";
import type { BreakoutBacktestConfig, PerformanceMetrics } from "../src/backtest/types";

const IS_MONTHS = 6;
const OOS_MONTHS = 3;
const SLIDE_MONTHS = 3;
const NUM_WINDOWS = 6;
const TOTAL_MONTHS = IS_MONTHS + OOS_MONTHS + SLIDE_MONTHS * (NUM_WINDOWS - 1);

/** IS最低PFゲート: IS最適PFがこの値未満ならOOS期間はトレードしない（休止） */
const MIN_IS_PF = 0.5;

interface WindowResult {
  windowIdx: number;
  isStart: string;
  isEnd: string;
  oosStart: string;
  oosEnd: string;
  bestIsParams: Partial<BreakoutBacktestConfig>;
  isMetrics: PerformanceMetrics;
  oosMetrics: PerformanceMetrics | null; // null = IS PFゲートで休止
}

// --- パラメータ選択ヘルパー ---

interface ComboResult {
  params: Partial<BreakoutBacktestConfig>;
  metrics: PerformanceMetrics;
}

function paramComboKey(params: Partial<BreakoutBacktestConfig>): string {
  return `${params.atrMultiplier}_${params.beActivationMultiplier}_${params.trailMultiplier}_${params.tsActivationMultiplier}`;
}

function calcMedian(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

/** IS最大PFで選択（従来方式） */
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

/** 近傍中央値PFで選択（ロバスト方式） */
function selectByRobustness(comboResults: Map<string, ComboResult>): ComboResult | null {
  const gridArrays: number[][] = [
    [...PARAMETER_GRID.atrMultiplier],
    [...PARAMETER_GRID.beActivationMultiplier],
    [...PARAMETER_GRID.trailMultiplier],
    [...PARAMETER_GRID.tsActivationMultiplier],
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
      gridArrays[3].indexOf(p.tsActivationMultiplier!),
    ];

    // 近傍 (±1 grid step in each dimension) のPFを収集
    const neighborPFs: number[] = [];
    const ranges = indices.map((idx, dim) => {
      const vals: number[] = [];
      for (let i = Math.max(0, idx - 1); i <= Math.min(gridSizes[dim] - 1, idx + 1); i++) {
        vals.push(i);
      }
      return vals;
    });

    // 4次元の近傍を再帰的に列挙
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

async function main() {
  const args = process.argv.slice(2);
  const useRobust = !args.includes("--max-pf"); // デフォルトはロバスト方式
  const endDate = dayjs().format("YYYY-MM-DD");
  const startDate = dayjs().subtract(TOTAL_MONTHS, "month").format("YYYY-MM-DD");

  console.log("=".repeat(70));
  console.log("ブレイクアウト戦略 Walk-Forward 分析");
  console.log("=".repeat(70));
  console.log(`分析期間: ${startDate} → ${endDate} (${TOTAL_MONTHS}ヶ月)`);
  console.log(`IS: ${IS_MONTHS}ヶ月 / OOS: ${OOS_MONTHS}ヶ月 / スライド: ${SLIDE_MONTHS}ヶ月`);
  console.log(`ウィンドウ数: ${NUM_WINDOWS}`);
  console.log(`選択方式: ${useRobust ? "ロバスト（近傍中央値PF）" : "最大PF"}`);

  // パラメータグリッド
  const paramCombos = generateParameterCombinations();
  console.log(`パラメータ組み合わせ: ${paramCombos.length}通り`);
  console.log(`総バックテスト回数: ${paramCombos.length * NUM_WINDOWS * 2}`);
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

  // 事前フィルタ: maxPrice以下のバーが1つ以上ある銘柄のみ残す（高速化）
  const maxPrice = BREAKOUT_BACKTEST_DEFAULTS.maxPrice;
  const allData = new Map<string, Awaited<ReturnType<typeof fetchHistoricalFromDB>> extends Map<string, infer V> ? V : never>();
  for (const [ticker, bars] of rawData) {
    if (bars.some((b) => b.close <= maxPrice && b.close > 0)) {
      allData.set(ticker, bars);
    }
  }
  console.log(`[data] ${allData.size}銘柄（フィルタ後）`);
  console.log("");

  // ウィンドウ生成
  const windows = generateWindows(startDate);

  // 各ウィンドウの実行
  const results: WindowResult[] = [];

  // デフォルト設定からフィルター設定を取得（全コンボ共通）
  const filterCfg = BREAKOUT_BACKTEST_DEFAULTS;
  const vixArg = vixData.size > 0 ? vixData : undefined;
  const indexArg = indexData.size > 0 ? indexData : undefined;

  for (let w = 0; w < windows.length; w++) {
    const { isStart, isEnd, oosStart, oosEnd } = windows[w];
    console.log(`━━━ Window ${w + 1}/${NUM_WINDOWS} ━━━`);
    console.log(`  IS:  ${isStart} → ${isEnd}`);
    console.log(`  OOS: ${oosStart} → ${oosEnd}`);

    // IS期間の共有データを1回だけ事前計算（240コンボで使い回す）
    const isPrecomputed = precomputeSimData(
      isStart, isEnd, allData,
      filterCfg.marketTrendFilter ?? false,
      filterCfg.indexTrendFilter ?? false,
      filterCfg.indexTrendSmaPeriod ?? 50,
      indexArg,
      filterCfg.indexMomentumFilter ?? false,
      filterCfg.indexMomentumDays ?? 60,
    );
    // IS期間のエントリーシグナルも1回だけ計算（analyzeTechnicals を240→1回に削減）
    const isSignals = precomputeDailySignals(filterCfg, allData, isPrecomputed);

    // IS: 全パラメータ組み合わせをテスト → 結果を蓄積
    const comboResults = new Map<string, ComboResult>();

    for (const params of paramCombos) {
      const config: BreakoutBacktestConfig = {
        ...BREAKOUT_BACKTEST_DEFAULTS,
        ...params,
        startDate: isStart,
        endDate: isEnd,
        verbose: false,
      };

      const result = runBreakoutBacktest(config, allData, vixArg, indexArg, isPrecomputed, isSignals);

      // トレード数が少なすぎる場合はスキップ
      if (result.metrics.totalTrades < 5) continue;

      comboResults.set(paramComboKey(params), { params, metrics: result.metrics });
    }

    // パラメータ選択（ロバスト or 最大PF）
    const selected = useRobust ? selectByRobustness(comboResults) : selectByMaxPF(comboResults);

    if (!selected) {
      console.log("  ⚠ IS期間でトレードが発生しなかったためスキップ");
      continue;
    }

    const bestParams = selected.params;
    const bestIsMetrics = selected.metrics;

    // IS最低PFゲート: ISで全パラメータが負ける環境はOOSもトレードしない
    if (bestIsMetrics.profitFactor < MIN_IS_PF) {
      console.log(`  IS  最適PF: ${formatPF(bestIsMetrics.profitFactor)} (${bestIsMetrics.totalTrades}トレード, 勝率${bestIsMetrics.winRate}%)`);
      console.log(`  ⏸ IS最適PF < ${MIN_IS_PF} → OOS期間は休止（トレードしない）`);
      console.log(`  最適パラメータ: atr=${bestParams.atrMultiplier}, be=${bestParams.beActivationMultiplier}, trail=${bestParams.trailMultiplier}, ts=${bestParams.tsActivationMultiplier}`);
      console.log("");
      results.push({
        windowIdx: w,
        isStart,
        isEnd,
        oosStart,
        oosEnd,
        bestIsParams: bestParams,
        isMetrics: bestIsMetrics,
        oosMetrics: null, // 休止
      });
      continue;
    }

    // OOS期間の共有データとシグナルを1回だけ事前計算
    const oosPrecomputed = precomputeSimData(
      oosStart, oosEnd, allData,
      filterCfg.marketTrendFilter ?? false,
      filterCfg.indexTrendFilter ?? false,
      filterCfg.indexTrendSmaPeriod ?? 50,
      indexArg,
      filterCfg.indexMomentumFilter ?? false,
      filterCfg.indexMomentumDays ?? 60,
    );
    const oosSignals = precomputeDailySignals(filterCfg, allData, oosPrecomputed);

    // OOS: ISで最適なパラメータで実行
    const oosConfig: BreakoutBacktestConfig = {
      ...BREAKOUT_BACKTEST_DEFAULTS,
      ...bestParams,
      startDate: oosStart,
      endDate: oosEnd,
      verbose: false,
    };

    const oosResult = runBreakoutBacktest(oosConfig, allData, vixArg, indexArg, oosPrecomputed, oosSignals);

    results.push({
      windowIdx: w,
      isStart,
      isEnd,
      oosStart,
      oosEnd,
      bestIsParams: bestParams,
      isMetrics: bestIsMetrics,
      oosMetrics: oosResult.metrics,
    });

    console.log(`  IS  最適PF: ${formatPF(bestIsMetrics.profitFactor)} (${bestIsMetrics.totalTrades}トレード, 勝率${bestIsMetrics.winRate}%)`);
    console.log(`  OOS PF:     ${formatPF(oosResult.metrics.profitFactor)} (${oosResult.metrics.totalTrades}トレード, 勝率${oosResult.metrics.winRate}%)`);
    console.log(`  最適パラメータ: atr=${bestParams.atrMultiplier}, be=${bestParams.beActivationMultiplier}, trail=${bestParams.trailMultiplier}, ts=${bestParams.tsActivationMultiplier}`);
    console.log("");
  }

  // サマリー
  printSummary(results);

  await prisma.$disconnect();
}

function generateWindows(startDate: string): Array<{
  isStart: string;
  isEnd: string;
  oosStart: string;
  oosEnd: string;
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

function printSummary(results: WindowResult[]): void {
  console.log("=".repeat(70));
  console.log("Walk-Forward サマリー");
  console.log("=".repeat(70));

  if (!results.length) {
    console.log("結果なし（全ウィンドウでトレードが発生しなかった）");
    return;
  }

  // OOS集計（休止ウィンドウは除外）
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

  // IS平均PF（全ウィンドウ）, OOS平均PF（アクティブのみ）
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

  // 判定
  const judgment = judge(oosAggregatePF, isOosRatio);
  console.log(`\n${"━".repeat(30)}`);
  console.log(`判定: ${judgment}`);
  console.log(`${"━".repeat(30)}`);

  // ウィンドウ別一覧
  console.log("\n[ウィンドウ別]");
  console.log("Window | IS PF   | OOS PF  | OOS勝率 | OOSトレード | 最適パラメータ");
  console.log("-".repeat(90));
  for (const r of results) {
    const p = r.bestIsParams;
    const paramStr = `atr=${p.atrMultiplier} be=${p.beActivationMultiplier} trail=${p.trailMultiplier} ts=${p.tsActivationMultiplier}`;
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

  // パラメータ安定性分析（アクティブウィンドウのみ）
  console.log("\n[パラメータ安定性]");
  const paramKeys = ["atrMultiplier", "beActivationMultiplier", "trailMultiplier", "tsActivationMultiplier"] as const;
  for (const key of paramKeys) {
    const values = activeResults.map((r) => r.bestIsParams[key]);
    const uniqueValues = [...new Set(values)];
    const stability = uniqueValues.length === 1 ? "安定" : uniqueValues.length <= 2 ? "やや安定" : "不安定";
    console.log(`  ${key}: ${uniqueValues.join(", ")} → ${stability}`);
  }
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

main().catch((err) => {
  console.error("Walk-Forward分析エラー:", err);
  process.exit(1);
});
