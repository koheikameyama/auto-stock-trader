/**
 * ウォークフォワード検証スクリプト
 * IS 6ヶ月 / OOS 3ヶ月 × 6ウィンドウで過学習を検出する
 */

import dayjs from "dayjs";
import { prisma } from "../src/lib/prisma";
import {
  DAILY_BACKTEST,
  SCREENING,
  hasParamOverride,
  hasMultiOverride,
  getSectorGroup,
} from "../src/lib/constants";
import {
  fetchMultipleBacktestData,
  fetchVixData,
} from "../src/backtest/data-fetcher";
import { runBacktest } from "../src/backtest/simulation-engine";
import {
  buildCandidateMapOnTheFly,
  type StockFundamentals,
} from "../src/backtest/on-the-fly-scorer";
import type { BacktestConfig, BacktestResult } from "../src/backtest/types";

// --- 型定義 ---

interface Window {
  label: string;
  isStart: string;
  isEnd: string;
  oosStart: string;
  oosEnd: string;
}

interface PeriodMetrics {
  pf: number;
  winRate: number;
  trades: number;
  winCount: number;
  grossProfit: number;
  grossLoss: number;
  expectancy: number;
  maxDrawdown: number;
}

interface WindowResult {
  window: Window;
  is: PeriodMetrics;
  oos: PeriodMetrics;
}

interface ConditionSummary {
  label: string;
  windows: WindowResult[];
  oosAggregatePf: number;
  isAggregatePf: number;
  isOosRatio: number;
  oosWinRate: number;
  oosTotalTrades: number;
  judgment: "堅牢" | "要注意" | "過学習";
}

// --- 定数 ---

const IS_MONTHS = 6;
const OOS_MONTHS = 3;
const SLIDE_MONTHS = 3;
const TOTAL_MONTHS = 24;
const MIN_OOS_TRADES = 10;

// --- ウィンドウ生成 ---

function generateWindows(baseDate: dayjs.Dayjs): Window[] {
  const windows: Window[] = [];
  const totalStart = baseDate.subtract(TOTAL_MONTHS, "month");
  const numWindows = Math.floor(
    (TOTAL_MONTHS - IS_MONTHS - OOS_MONTHS) / SLIDE_MONTHS
  ) + 1;

  for (let i = 0; i < numWindows; i++) {
    const isStart = totalStart.add(i * SLIDE_MONTHS, "month");
    const isEnd = isStart.add(IS_MONTHS, "month").subtract(1, "day");
    const oosStart = isEnd.add(1, "day");
    const oosEnd = oosStart.add(OOS_MONTHS, "month").subtract(1, "day");

    windows.push({
      label: `W${i + 1}`,
      isStart: isStart.format("YYYY-MM-DD"),
      isEnd: isEnd.format("YYYY-MM-DD"),
      oosStart: oosStart.format("YYYY-MM-DD"),
      oosEnd: oosEnd.format("YYYY-MM-DD"),
    });
  }
  return windows;
}

// --- フォーマットヘルパー ---

function fmtPf(pf: number): string {
  if (pf === Infinity) return "∞";
  return pf.toFixed(2);
}

function fmtPct(pct: number): string {
  return `${pct.toFixed(1)}%`;
}

function fmtRatio(ratio: number): string {
  if (ratio === Infinity) return "∞";
  return ratio.toFixed(2);
}

function judgmentIcon(judgment: "堅牢" | "要注意" | "過学習"): string {
  switch (judgment) {
    case "堅牢": return "[OK]";
    case "要注意": return "[!!]";
    case "過学習": return "[NG]";
  }
}

// --- メイン ---

async function main() {
  console.log("=== ウォークフォワード検証 ===\n");

  const baseDate = dayjs();
  const windows = generateWindows(baseDate);

  console.log(`ウィンドウ数: ${windows.length}`);
  for (const w of windows) {
    console.log(`  ${w.label}: IS [${w.isStart}→${w.isEnd}] → OOS [${w.oosStart}→${w.oosEnd}]`);
  }

  // 全体の日付範囲
  const startDate = windows[0].isStart;
  const endDate = windows[windows.length - 1].oosEnd;
  console.log(`\nデータ範囲: ${startDate} → ${endDate}\n`);

  // 1. 銘柄・ファンダメンタルズ取得
  const stocks = await prisma.stock.findMany({
    where: {
      isDelisted: false,
      isActive: true,
      isRestricted: false,
      latestPrice: { not: null, gte: SCREENING.MIN_PRICE },
      latestVolume: { not: null, gte: SCREENING.MIN_DAILY_VOLUME },
    },
    orderBy: { latestVolume: "desc" },
    take: 500,
    select: {
      tickerCode: true,
      jpxSectorName: true,
      latestPrice: true,
      latestVolume: true,
      volatility: true,
      per: true,
      pbr: true,
      eps: true,
      marketCap: true,
      nextEarningsDate: true,
      exDividendDate: true,
    },
  });
  console.log(`対象銘柄: ${stocks.length}件`);

  const fundamentalsMap = new Map<string, StockFundamentals>();
  for (const s of stocks) {
    fundamentalsMap.set(s.tickerCode, {
      per: s.per ? Number(s.per) : null,
      pbr: s.pbr ? Number(s.pbr) : null,
      eps: s.eps ? Number(s.eps) : null,
      marketCap: s.marketCap ? Number(s.marketCap) : null,
      latestPrice: s.latestPrice ? Number(s.latestPrice) : 0,
      volatility: s.volatility ? Number(s.volatility) : null,
      nextEarningsDate: s.nextEarningsDate,
      exDividendDate: s.exDividendDate,
      latestVolume: s.latestVolume ? Number(s.latestVolume) : 0,
      jpxSectorName: s.jpxSectorName,
    });
  }

  const sectorMap = new Map<string, string>();
  for (const s of stocks) {
    sectorMap.set(s.tickerCode, getSectorGroup(s.jpxSectorName) ?? "その他");
  }

  // 2. データ一括取得
  const stockTickers = stocks.map((s) => s.tickerCode);
  console.log("データ取得中...");
  const [allData, vixData] = await Promise.all([
    fetchMultipleBacktestData(stockTickers, startDate, endDate, DAILY_BACKTEST.ON_THE_FLY.LOOKBACK_CALENDAR_DAYS),
    fetchVixData(startDate, endDate).catch(() => new Map<string, number>()),
  ]);
  console.log(`データ: ${allData.size}銘柄, VIX ${vixData.size}件\n`);

  // 3. candidateMap事前構築（12マップ）
  const { TARGET_RANKS, FALLBACK_RANKS, MIN_TICKERS } = DAILY_BACKTEST.TICKER_SELECTION;

  type CandidateMapEntry = {
    candidateMap: Map<string, string[]>;
    allTickers: string[];
  };
  const candidateMaps = new Map<string, CandidateMapEntry>();

  console.log("candidateMap構築中（12マップ）...");
  for (const w of windows) {
    for (const period of [
      { key: `${w.label}_IS`, start: w.isStart, end: w.isEnd },
      { key: `${w.label}_OOS`, start: w.oosStart, end: w.oosEnd },
    ]) {
      const result = buildCandidateMapOnTheFly(
        allData, fundamentalsMap, stocks, period.start, period.end,
        TARGET_RANKS, FALLBACK_RANKS, MIN_TICKERS,
      );
      candidateMaps.set(period.key, result);
      process.stdout.write(".");
    }
  }
  console.log(` 完了 (${candidateMaps.size}マップ)\n`);

  // --- ヘルパー関数 ---

  function buildBaseConfig(startDate: string, endDate: string, tickers: string[]): BacktestConfig {
    const { DEFAULT_PARAMS, FIXED_BUDGET } = DAILY_BACKTEST;
    return {
      tickers,
      startDate,
      endDate,
      initialBudget: FIXED_BUDGET.budget,
      maxPositions: FIXED_BUDGET.maxPositions,
      maxPrice: FIXED_BUDGET.maxPrice,
      scoreThreshold: DEFAULT_PARAMS.scoreThreshold,
      takeProfitRatio: DEFAULT_PARAMS.takeProfitRatio,
      stopLossRatio: DEFAULT_PARAMS.stopLossRatio,
      atrMultiplier: DEFAULT_PARAMS.atrMultiplier,
      trailingActivationMultiplier: DEFAULT_PARAMS.trailingActivationMultiplier,
      trailMultiplier: DEFAULT_PARAMS.trailMultiplier,
      strategy: DEFAULT_PARAMS.strategy,
      costModelEnabled: true,
      cooldownDays: DEFAULT_PARAMS.cooldownDays,
      overrideTpSl: DEFAULT_PARAMS.overrideTpSl,
      priceLimitEnabled: true,
      gapRiskEnabled: true,
      trendFilterEnabled: true,
      pullbackFilterEnabled: false,
      volatilityFilterEnabled: true,
      rsFilterEnabled: false,
      verbose: false,
    };
  }

  function applyCondition(
    baseConfig: BacktestConfig,
    condition: (typeof DAILY_BACKTEST.PARAMETER_CONDITIONS)[number],
  ): BacktestConfig {
    const config = { ...baseConfig };
    if (hasParamOverride(condition)) {
      if (condition.param === "trailMultiplier") {
        config.trailMultiplier = condition.value;
      } else {
        (config as unknown as Record<string, unknown>)[condition.param] = condition.value;
      }
      if (condition.overrideTpSl) config.overrideTpSl = true;
    } else if (hasMultiOverride(condition)) {
      for (const [key, val] of Object.entries(condition.overrides)) {
        (config as unknown as Record<string, unknown>)[key] = val;
      }
    }
    return config;
  }

  function extractPeriodMetrics(result: BacktestResult): PeriodMetrics {
    const trades = result.trades.filter((t) => t.exitReason !== "still_open");
    const wins = trades.filter((t) => (t.pnlPct ?? 0) > 0);
    const grossProfit = wins.reduce((s, t) => s + (t.pnlPct ?? 0), 0);
    const grossLoss = Math.abs(
      trades.filter((t) => (t.pnlPct ?? 0) <= 0).reduce((s, t) => s + (t.pnlPct ?? 0), 0)
    );
    return {
      pf: calcAggregatePf(grossProfit, grossLoss),
      winRate: result.metrics.winRate,
      trades: trades.length,
      winCount: wins.length,
      grossProfit,
      grossLoss,
      expectancy: result.metrics.expectancy,
      maxDrawdown: result.metrics.maxDrawdown,
    };
  }

  function calcAggregatePf(grossProfit: number, grossLoss: number): number {
    if (grossLoss === 0) return grossProfit > 0 ? Infinity : 0;
    return grossProfit / grossLoss;
  }

  function judge(
    oosAggregatePf: number,
    isOosRatio: number,
  ): "堅牢" | "要注意" | "過学習" {
    if (oosAggregatePf >= 1.3 && isOosRatio <= 2.0) return "堅牢";
    if (oosAggregatePf >= 1.0 && isOosRatio <= 3.0) return "要注意";
    return "過学習";
  }

  // --- 条件ループ ---

  const conditions = DAILY_BACKTEST.PARAMETER_CONDITIONS;
  const allSummaries: ConditionSummary[] = [];

  console.log(`全${conditions.length}条件 × ${windows.length}ウィンドウ × 2 = ${conditions.length * windows.length * 2}回のバックテストを実行...\n`);

  for (const condition of conditions) {
    const windowResults: WindowResult[] = [];

    for (const w of windows) {
      const isCm = candidateMaps.get(`${w.label}_IS`)!;
      const oosCm = candidateMaps.get(`${w.label}_OOS`)!;

      const isConfig = applyCondition(buildBaseConfig(w.isStart, w.isEnd, isCm.allTickers), condition);
      const oosConfig = applyCondition(buildBaseConfig(w.oosStart, w.oosEnd, oosCm.allTickers), condition);

      const isResult = runBacktest(isConfig, allData, vixData, isCm.candidateMap, sectorMap);
      const oosResult = runBacktest(oosConfig, allData, vixData, oosCm.candidateMap, sectorMap);

      windowResults.push({
        window: w,
        is: extractPeriodMetrics(isResult),
        oos: extractPeriodMetrics(oosResult),
      });
    }

    // OOSトレードをプールしてPF集計（10件未満のウィンドウは除外）
    let oosGrossProfit = 0;
    let oosGrossLoss = 0;
    let isGrossProfit = 0;
    let isGrossLoss = 0;
    let oosTotalTrades = 0;
    let oosWinCount = 0;
    let oosTotalCount = 0;

    for (const wr of windowResults) {
      if (wr.oos.trades >= MIN_OOS_TRADES) {
        oosGrossProfit += wr.oos.grossProfit;
        oosGrossLoss += wr.oos.grossLoss;
        oosTotalTrades += wr.oos.trades;
        oosWinCount += wr.oos.winCount;
        oosTotalCount += wr.oos.trades;
      }
      isGrossProfit += wr.is.grossProfit;
      isGrossLoss += wr.is.grossLoss;
    }

    const oosAggregatePf = calcAggregatePf(oosGrossProfit, oosGrossLoss);
    const isAggregatePf = calcAggregatePf(isGrossProfit, isGrossLoss);
    const isOosRatio = oosAggregatePf > 0 && isFinite(oosAggregatePf)
      ? isAggregatePf / oosAggregatePf
      : Infinity;
    const oosWinRate = oosTotalCount > 0 ? (oosWinCount / oosTotalCount) * 100 : 0;

    allSummaries.push({
      label: condition.label,
      windows: windowResults,
      oosAggregatePf,
      isAggregatePf,
      isOosRatio,
      oosWinRate,
      oosTotalTrades,
      judgment: judge(oosAggregatePf, isOosRatio),
    });

    process.stdout.write(`  ${condition.label} → OOS PF ${oosAggregatePf === Infinity ? "∞" : oosAggregatePf.toFixed(2)} [${judge(oosAggregatePf, isOosRatio)}]\n`);
  }

  // --- 出力 ---

  // 1. ベースラインのウィンドウ別詳細
  const baseline = allSummaries.find((s) => s.label === "ベースライン");
  if (baseline) {
    console.log("\n=== ベースライン ウィンドウ別詳細 ===");
    const { DEFAULT_PARAMS } = DAILY_BACKTEST;
    console.log(
      `パラメータ: scoreThreshold=${DEFAULT_PARAMS.scoreThreshold} atrMultiplier=${DEFAULT_PARAMS.atrMultiplier} TS起動=${DEFAULT_PARAMS.trailingActivationMultiplier} トレール=${DEFAULT_PARAMS.trailMultiplier}\n`
    );
    console.log(
      "Window | IS期間              | OOS期間             | IS PF  | OOS PF | IS勝率 | OOS勝率 | IS件数 | OOS件数 | IS期待値 | OOS期待値 | IS maxDD | OOS maxDD"
    );
    console.log(
      "-------|---------------------|---------------------|--------|--------|--------|---------|--------|---------|----------|-----------|----------|----------"
    );
    for (const wr of baseline.windows) {
      const w = wr.window;
      const insufficientMark = wr.oos.trades < MIN_OOS_TRADES ? " *" : "";
      console.log(
        `${w.label.padEnd(6)} | ${w.isStart}→${w.isEnd} | ${w.oosStart}→${w.oosEnd} | ${fmtPf(wr.is.pf).padStart(6)} | ${fmtPf(wr.oos.pf).padStart(6)} | ${fmtPct(wr.is.winRate).padStart(6)} | ${fmtPct(wr.oos.winRate).padStart(7)} | ${String(wr.is.trades).padStart(6)} | ${String(wr.oos.trades).padStart(6)}${insufficientMark} | ${wr.is.expectancy.toFixed(2).padStart(8)} | ${wr.oos.expectancy.toFixed(2).padStart(9)} | ${fmtPct(wr.is.maxDrawdown).padStart(8)} | ${fmtPct(wr.oos.maxDrawdown).padStart(9)}`
      );
    }
    if (baseline.windows.some((wr) => wr.oos.trades < MIN_OOS_TRADES)) {
      console.log(`  * OOSトレード${MIN_OOS_TRADES}件未満: サマリー集計から除外`);
    }

    console.log(`\n=== サマリー ===`);
    console.log(`IS集計PF:  ${fmtPf(baseline.isAggregatePf)}    OOS集計PF: ${fmtPf(baseline.oosAggregatePf)}`);
    console.log(`IS/OOS比:  ${baseline.isOosRatio === Infinity ? "∞" : baseline.isOosRatio.toFixed(2)}`);

    const oosPfs = baseline.windows
      .filter((wr) => wr.oos.trades >= MIN_OOS_TRADES)
      .map((wr) => ({ pf: wr.oos.pf, label: wr.window.label }));
    if (oosPfs.length > 0) {
      const worst = oosPfs.reduce((a, b) => (a.pf < b.pf ? a : b));
      const best = oosPfs.reduce((a, b) => (a.pf > b.pf ? a : b));
      console.log(`OOS PF最悪: ${fmtPf(worst.pf)} (${worst.label})`);
      console.log(`OOS PF最良: ${fmtPf(best.pf)} (${best.label})`);
    }
    console.log(`\n判定: ${judgmentIcon(baseline.judgment)} ${baseline.judgment}`);
  }

  // 2. 条件別OOS堅牢性一覧（OOS集計PF降順）
  console.log("\n=== 条件別OOS堅牢性（OOS PF降順） ===");
  console.log(
    "条件              | OOS集計PF | IS/OOS比 | OOS勝率 | OOS件数 | 判定"
  );
  console.log(
    "------------------|-----------|----------|---------|---------|------"
  );

  const sorted = [...allSummaries].sort((a, b) => {
    if (a.oosAggregatePf === Infinity && b.oosAggregatePf === Infinity) return 0;
    if (a.oosAggregatePf === Infinity) return -1;
    if (b.oosAggregatePf === Infinity) return 1;
    return b.oosAggregatePf - a.oosAggregatePf;
  });

  for (const s of sorted) {
    console.log(
      `${s.label.padEnd(18)} | ${fmtPf(s.oosAggregatePf).padStart(9)} | ${fmtRatio(s.isOosRatio).padStart(8)} | ${fmtPct(s.oosWinRate).padStart(7)} | ${String(s.oosTotalTrades).padStart(7)} | ${judgmentIcon(s.judgment)} ${s.judgment}`
    );
  }

  // 堅牢な条件のカウント
  const robustCount = allSummaries.filter((s) => s.judgment === "堅牢").length;
  const cautionCount = allSummaries.filter((s) => s.judgment === "要注意").length;
  const overfitCount = allSummaries.filter((s) => s.judgment === "過学習").length;
  console.log(`\n堅牢: ${robustCount}件  要注意: ${cautionCount}件  過学習: ${overfitCount}件`);

  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
