/**
 * 資金別シミュレーション
 *
 * 異なる初期資金×同時保有数の組み合わせで同じ戦略を回し、
 * PF・期待値・DD・資金利用率を比較する。
 * データ取得は1回のみ、シミュレーションは各シナリオで繰り返す。
 */

import dayjs from "dayjs";
import { prisma } from "../lib/prisma";
import {
  DAILY_BACKTEST,
  SCREENING,
  CAPITAL_SCENARIOS,
  getSectorGroup,
} from "../lib/constants";
import { fetchMultipleBacktestData, fetchVixData } from "./data-fetcher";
import {
  buildCandidateMapOnTheFly,
  type StockFundamentals,
} from "./on-the-fly-scorer";
import { runBacktest } from "./simulation-engine";
import { calculateCapitalUtilization } from "./metrics";
import type { BacktestConfig, PerformanceMetrics } from "./types";
import type { OHLCVData } from "../core/technical-analysis";

export interface CapitalScenarioResult {
  budget: number;
  maxPositions: number;
  maxPrice: number;
  metrics: PerformanceMetrics;
  avgConcurrentPositions: number;
  capitalUtilizationPct: number;
  executionTimeMs: number;
}

export interface CapitalSimulationResult {
  scenarioResults: CapitalScenarioResult[];
  periodStart: string;
  periodEnd: string;
  dataFetchTimeMs: number;
  totalTimeMs: number;
}

/**
 * 資金別シミュレーションを実行
 */
export async function runCapitalSimulation(): Promise<CapitalSimulationResult> {
  const totalStart = Date.now();
  const lookbackMonths = DAILY_BACKTEST.LOOKBACK_MONTHS;
  const endDate = dayjs().format("YYYY-MM-DD");
  const startDate = dayjs()
    .subtract(lookbackMonths, "month")
    .format("YYYY-MM-DD");

  console.log(
    `[capital-sim] 期間: ${startDate} ~ ${endDate} (${lookbackMonths}ヶ月)`,
  );

  // 1. データ取得（1回のみ）
  const { allData, vixData, candidateMap, sectorMap, dataFetchTimeMs } =
    await fetchSharedData(startDate, endDate);

  // 2. 各シナリオでシミュレーション
  const scenarioResults: CapitalScenarioResult[] = [];
  const { DEFAULT_PARAMS } = DAILY_BACKTEST;

  for (const scenario of CAPITAL_SCENARIOS) {
    const maxPrice = Math.floor(scenario.budget / scenario.maxPositions / 100);
    const condStart = Date.now();

    const config: BacktestConfig = {
      tickers: Array.from(allData.keys()),
      startDate,
      endDate,
      initialBudget: scenario.budget,
      maxPositions: scenario.maxPositions,
      maxPrice,
      scoreThreshold: DEFAULT_PARAMS.scoreThreshold,
      takeProfitRatio: DEFAULT_PARAMS.takeProfitRatio,
      stopLossRatio: DEFAULT_PARAMS.stopLossRatio,
      atrMultiplier: DEFAULT_PARAMS.atrMultiplier,
      trailingActivationMultiplier:
        DEFAULT_PARAMS.trailingActivationMultiplier,
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

    const label = `${(scenario.budget / 10000).toFixed(0)}万×${scenario.maxPositions}銘柄(上限¥${maxPrice.toLocaleString()})`;
    console.log(`[capital-sim] ${label} シミュレーション中...`);

    const result = runBacktest(
      config,
      allData,
      vixData,
      candidateMap,
      sectorMap,
    );
    const utilization = calculateCapitalUtilization(result.equityCurve);
    const executionTimeMs = Date.now() - condStart;

    scenarioResults.push({
      budget: scenario.budget,
      maxPositions: scenario.maxPositions,
      maxPrice,
      metrics: result.metrics,
      avgConcurrentPositions: utilization.avgConcurrentPositions,
      capitalUtilizationPct: utilization.capitalUtilizationPct,
      executionTimeMs,
    });

    const sign = result.metrics.totalReturnPct >= 0 ? "+" : "";
    console.log(
      `[capital-sim]   → 件数${result.metrics.totalTrades} 勝率${result.metrics.winRate}% PF${result.metrics.profitFactor} ${sign}${result.metrics.totalReturnPct}% DD-${result.metrics.maxDrawdown}% 利用率${utilization.capitalUtilizationPct}%`,
    );
  }

  return {
    scenarioResults,
    periodStart: startDate,
    periodEnd: endDate,
    dataFetchTimeMs,
    totalTimeMs: Date.now() - totalStart,
  };
}

/**
 * 比較テーブルをコンソール出力
 */
export function printCapitalSimulationReport(
  result: CapitalSimulationResult,
): void {
  console.log("");
  console.log("=".repeat(100));
  console.log("  資金別シミュレーション結果");
  console.log("=".repeat(100));
  console.log(`  期間: ${result.periodStart} ~ ${result.periodEnd}`);
  console.log(
    `  データ取得: ${(result.dataFetchTimeMs / 1000).toFixed(1)}秒 / 合計: ${(result.totalTimeMs / 1000).toFixed(1)}秒`,
  );
  console.log("");

  // ヘッダー
  console.log(
    "  資金    上限  株価上限   件数  勝率    PF    期待値   DD     利用率  保有数  純損益",
  );
  console.log("  " + "-".repeat(96));

  for (const s of result.scenarioResults) {
    const budgetStr = `${(s.budget / 10000).toFixed(0)}万`.padStart(5);
    const posStr = String(s.maxPositions).padStart(3);
    const priceStr = `¥${s.maxPrice.toLocaleString()}`.padStart(8);
    const tradesStr = String(s.metrics.totalTrades).padStart(5);
    const wrStr = `${s.metrics.winRate}%`.padStart(6);
    const pfVal =
      s.metrics.profitFactor === Infinity ? "∞" : String(s.metrics.profitFactor);
    const pfStr = pfVal.padStart(5);
    const expSign = s.metrics.expectancy >= 0 ? "+" : "";
    const expStr = `${expSign}${s.metrics.expectancy}%`.padStart(7);
    const ddStr = `-${s.metrics.maxDrawdown}%`.padStart(7);
    const utilStr = `${s.capitalUtilizationPct}%`.padStart(6);
    const avgPosStr = String(s.avgConcurrentPositions).padStart(5);
    const pnlSign = s.metrics.totalNetPnl >= 0 ? "+" : "";
    const pnlStr =
      `${pnlSign}¥${s.metrics.totalNetPnl.toLocaleString()}`.padStart(10);

    console.log(
      `  ${budgetStr}  ${posStr}  ${priceStr}  ${tradesStr}  ${wrStr}  ${pfStr}  ${expStr}  ${ddStr}  ${utilStr}  ${avgPosStr}  ${pnlStr}`,
    );
  }

  console.log("");
}

// ====================================================
// 内部ヘルパー: データ取得（daily-runner の runOnTheFlyMode と同等）
// ====================================================

async function fetchSharedData(
  startDate: string,
  endDate: string,
): Promise<{
  allData: Map<string, OHLCVData[]>;
  vixData: Map<string, number>;
  candidateMap: Map<string, string[]>;
  sectorMap: Map<string, string>;
  dataFetchTimeMs: number;
}> {
  // 1. アクティブ銘柄取得
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

  console.log(`[capital-sim] アクティブ銘柄: ${stocks.length}件`);

  // 2. OHLCV + VIX 一括取得
  const fetchStart = Date.now();
  const stockTickers = stocks.map((s) => s.tickerCode);
  const allTickersWithNikkei = [...stockTickers, "^N225"];
  const { ON_THE_FLY } = DAILY_BACKTEST;

  const [allDataWithNikkei, vixData] = await Promise.all([
    fetchMultipleBacktestData(
      allTickersWithNikkei,
      startDate,
      endDate,
      ON_THE_FLY.LOOKBACK_CALENDAR_DAYS,
    ),
    fetchVixData(startDate, endDate).catch((err: unknown) => {
      console.warn("[capital-sim] VIXデータ取得失敗:", err);
      return new Map<string, number>();
    }),
  ]);
  const dataFetchTimeMs = Date.now() - fetchStart;

  const nikkei225Ohlcv = allDataWithNikkei.get("^N225");
  allDataWithNikkei.delete("^N225");
  const allData = allDataWithNikkei;

  if (allData.size === 0) {
    throw new Error("ヒストリカルデータを取得できませんでした");
  }

  console.log(
    `[capital-sim] データ取得完了: ${allData.size}銘柄 VIX${vixData.size}件 (${(dataFetchTimeMs / 1000).toFixed(1)}秒)`,
  );

  // 3. ファンダメンタルマップ
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

  // 4. candidateMap 構築
  const { TARGET_RANKS, FALLBACK_RANKS, MIN_TICKERS } =
    DAILY_BACKTEST.TICKER_SELECTION;

  const { candidateMap } = buildCandidateMapOnTheFly(
    allData,
    fundamentalsMap,
    stocks,
    startDate,
    endDate,
    TARGET_RANKS,
    FALLBACK_RANKS,
    MIN_TICKERS,
    nikkei225Ohlcv ? [...nikkei225Ohlcv] : undefined,
  );

  // 5. セクターマップ
  const sectorMap = new Map<string, string>();
  for (const s of stocks) {
    sectorMap.set(s.tickerCode, getSectorGroup(s.jpxSectorName) ?? "その他");
  }

  return { allData, vixData, candidateMap, sectorMap, dataFetchTimeMs };
}
