/**
 * 日次自動バックテスト実行エンジン
 *
 * 1. ScoringRecordからS/Aランク銘柄を選定
 * 2. Yahoo Financeからデータを一括取得（1回のみ）
 * 3. 4つの予算ティアでシミュレーション実行
 * 4. 結果を返す（DB保存・通知は呼び出し側で行う）
 */

import dayjs from "dayjs";
import { prisma } from "../lib/prisma";
import { getDaysAgoForDB } from "../lib/date-utils";
import { DAILY_BACKTEST, type BudgetTier } from "../lib/constants";
import { fetchMultipleBacktestData } from "./data-fetcher";
import { runBacktest } from "./simulation-engine";
import type { BacktestConfig, PerformanceMetrics } from "./types";

export interface DailyBacktestTierResult {
  tier: BudgetTier;
  config: BacktestConfig;
  metrics: PerformanceMetrics;
  tickerCount: number;
  executionTimeMs: number;
}

export interface DailyBacktestRunResult {
  tickers: string[];
  periodStart: string;
  periodEnd: string;
  tierResults: DailyBacktestTierResult[];
  dataFetchTimeMs: number;
}

/**
 * ScoringRecordから直近S/Aランク銘柄を選定
 */
async function selectTickers(): Promise<string[]> {
  const { LOOKBACK_DAYS, MIN_TICKERS, TARGET_RANKS, FALLBACK_RANKS } =
    DAILY_BACKTEST.TICKER_SELECTION;

  const sinceDate = getDaysAgoForDB(LOOKBACK_DAYS);

  // S/Aランクのdistinct銘柄を取得
  const records = await prisma.scoringRecord.findMany({
    where: {
      date: { gte: sinceDate },
      rank: { in: [...TARGET_RANKS] },
      isDisqualified: false,
    },
    select: { tickerCode: true },
    distinct: ["tickerCode"],
  });

  let tickers = records.map((r) => r.tickerCode);

  // MIN_TICKERS未満ならBランクも含める
  if (tickers.length < MIN_TICKERS) {
    const fallbackRecords = await prisma.scoringRecord.findMany({
      where: {
        date: { gte: sinceDate },
        rank: { in: [...FALLBACK_RANKS] },
        isDisqualified: false,
      },
      select: { tickerCode: true },
      distinct: ["tickerCode"],
    });
    tickers = fallbackRecords.map((r) => r.tickerCode);
  }

  // ScoringRecordが空の場合、Stockテーブルから出来高上位のアクティブ銘柄を取得
  if (tickers.length === 0) {
    console.log(
      "[daily-backtest] ScoringRecord が空のため、Stockテーブルから出来高上位銘柄を使用",
    );
    const stocks = await prisma.stock.findMany({
      where: {
        isActive: true,
        isRestricted: false,
        latestVolume: { not: null },
      },
      orderBy: { latestVolume: "desc" },
      take: 50,
      select: { tickerCode: true },
    });
    tickers = stocks.map((s) => s.tickerCode);
  }

  return tickers;
}

/**
 * 日次バックテストを実行
 */
export async function runDailyBacktest(): Promise<DailyBacktestRunResult> {
  // 1. 銘柄選定
  const tickers = await selectTickers();
  if (tickers.length === 0) {
    throw new Error("バックテスト対象銘柄が0件です");
  }

  console.log(`[daily-backtest] 対象銘柄: ${tickers.length}件`);

  // 2. 期間設定（6ヶ月ローリング）
  const endDate = dayjs().format("YYYY-MM-DD");
  const startDate = dayjs()
    .subtract(DAILY_BACKTEST.LOOKBACK_MONTHS, "month")
    .format("YYYY-MM-DD");

  // 3. データ一括取得（全ティア共通）
  const fetchStart = Date.now();
  const allData = await fetchMultipleBacktestData(tickers, startDate, endDate);
  const dataFetchTimeMs = Date.now() - fetchStart;

  if (allData.size === 0) {
    throw new Error("ヒストリカルデータを取得できませんでした");
  }

  console.log(
    `[daily-backtest] データ取得完了: ${allData.size}銘柄 (${(dataFetchTimeMs / 1000).toFixed(1)}秒)`,
  );

  // 4. 各ティアでシミュレーション実行
  const tierResults: DailyBacktestTierResult[] = [];
  const { DEFAULT_PARAMS } = DAILY_BACKTEST;

  for (const tier of DAILY_BACKTEST.BUDGET_TIERS) {
    const tierStart = Date.now();

    const config: BacktestConfig = {
      tickers,
      startDate,
      endDate,
      initialBudget: tier.budget,
      maxPositions: tier.maxPositions,
      maxPrice: tier.maxPrice,
      scoreThreshold: DEFAULT_PARAMS.scoreThreshold,
      takeProfitRatio: DEFAULT_PARAMS.takeProfitRatio,
      stopLossRatio: DEFAULT_PARAMS.stopLossRatio,
      atrMultiplier: DEFAULT_PARAMS.atrMultiplier,
      strategy: DEFAULT_PARAMS.strategy,
      verbose: false,
    };

    console.log(`[daily-backtest] ${tier.label}ティア シミュレーション中...`);
    const result = runBacktest(config, allData);

    tierResults.push({
      tier,
      config,
      metrics: result.metrics,
      tickerCount: allData.size,
      executionTimeMs: Date.now() - tierStart,
    });

    const sign = result.metrics.totalReturnPct >= 0 ? "+" : "";
    console.log(
      `[daily-backtest] ${tier.label}: 勝率${result.metrics.winRate}% PF${result.metrics.profitFactor} ${sign}${result.metrics.totalReturnPct}%`,
    );
  }

  return {
    tickers,
    periodStart: startDate,
    periodEnd: endDate,
    tierResults,
    dataFetchTimeMs,
  };
}
