/**
 * 日次自動バックテスト実行エンジン
 *
 * 1. ScoringRecordから日付別S/Aランク銘柄マップを構築（生存者バイアス除去）
 * 2. Yahoo Financeからデータを一括取得（1回のみ）
 * 3. 4つの予算ティアでシミュレーション実行
 * 4. 結果を返す（DB保存・通知は呼び出し側で行う）
 */

import dayjs from "dayjs";
import { prisma } from "../lib/prisma";
import { DAILY_BACKTEST, type BudgetTier } from "../lib/constants";
import { fetchMultipleBacktestData, fetchNikkeiViData } from "./data-fetcher";
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

interface CandidateMapResult {
  /** 日付別の候補銘柄マップ（生存者バイアス除去） */
  candidateMap: Map<string, string[]> | null;
  /** データ取得用の全ユニーク銘柄 */
  allTickers: string[];
  /** バックテスト開始日（ScoringRecord蓄積量に基づく動的期間） */
  startDate: string;
}

/**
 * ScoringRecordから日付別の候補銘柄マップを構築
 *
 * 各日付に「その日のScoringRecordでS/Aだった銘柄」を使うことで
 * 生存者バイアスを除去する。
 */
async function buildCandidateMap(): Promise<CandidateMapResult> {
  const { TARGET_RANKS, FALLBACK_RANKS } = DAILY_BACKTEST.TICKER_SELECTION;

  // ScoringRecordの最古日を取得 → 動的なバックテスト期間
  const oldest = await prisma.scoringRecord.findFirst({
    where: { isDisqualified: false },
    orderBy: { date: "asc" },
    select: { date: true },
  });

  if (!oldest) {
    // ScoringRecordが空 → Stockテーブルから出来高上位銘柄でフォールバック
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
    const tickers = stocks.map((s) => s.tickerCode);
    const startDate = dayjs()
      .subtract(DAILY_BACKTEST.LOOKBACK_MONTHS, "month")
      .format("YYYY-MM-DD");
    return { candidateMap: null, allTickers: tickers, startDate };
  }

  const startDate = dayjs(oldest.date).format("YYYY-MM-DD");

  // 全期間のS/Aランク ScoringRecord を一括取得
  const records = await prisma.scoringRecord.findMany({
    where: {
      date: { gte: oldest.date },
      rank: { in: [...TARGET_RANKS, ...FALLBACK_RANKS] },
      isDisqualified: false,
    },
    select: { date: true, tickerCode: true, rank: true },
    orderBy: { date: "asc" },
  });

  // Map<dateString, tickerCode[]> を構築（TARGET_RANKS優先、不足時FALLBACK_RANKS追加）
  const dateTargetMap = new Map<string, Set<string>>();
  const dateFallbackMap = new Map<string, Set<string>>();

  for (const r of records) {
    const dateStr = dayjs(r.date).format("YYYY-MM-DD");
    if ((TARGET_RANKS as readonly string[]).includes(r.rank)) {
      if (!dateTargetMap.has(dateStr)) dateTargetMap.set(dateStr, new Set());
      dateTargetMap.get(dateStr)!.add(r.tickerCode);
    }
    if (!dateFallbackMap.has(dateStr)) dateFallbackMap.set(dateStr, new Set());
    dateFallbackMap.get(dateStr)!.add(r.tickerCode);
  }

  // TARGET_RANKSの候補が少ない日はFALLBACK_RANKSで補完
  const candidateMap = new Map<string, string[]>();
  const allTickerSet = new Set<string>();
  const { MIN_TICKERS } = DAILY_BACKTEST.TICKER_SELECTION;

  for (const dateStr of dateFallbackMap.keys()) {
    const targetTickers = dateTargetMap.get(dateStr);
    const tickers =
      targetTickers && targetTickers.size >= MIN_TICKERS
        ? [...targetTickers]
        : [...(dateFallbackMap.get(dateStr) ?? [])];
    candidateMap.set(dateStr, tickers);
    for (const t of tickers) allTickerSet.add(t);
  }

  console.log(
    `[daily-backtest] ScoringRecord期間: ${startDate}〜 (${candidateMap.size}営業日, ${allTickerSet.size}銘柄)`,
  );

  return {
    candidateMap,
    allTickers: [...allTickerSet],
    startDate,
  };
}

/**
 * 日次バックテストを実行
 */
export async function runDailyBacktest(): Promise<DailyBacktestRunResult> {
  // 1. 日付別候補銘柄マップを構築（生存者バイアス除去）
  const { candidateMap, allTickers, startDate } = await buildCandidateMap();
  if (allTickers.length === 0) {
    throw new Error("バックテスト対象銘柄が0件です");
  }

  console.log(`[daily-backtest] 対象銘柄: ${allTickers.length}件`);

  // 2. 期間設定（ScoringRecord蓄積量に基づく動的期間）
  const endDate = dayjs().format("YYYY-MM-DD");

  // 3. データ一括取得（全ティア共通）
  const fetchStart = Date.now();
  const [allData, nikkeiViData] = await Promise.all([
    fetchMultipleBacktestData(allTickers, startDate, endDate),
    fetchNikkeiViData(startDate, endDate).catch((err: unknown) => {
      console.warn("[daily-backtest] 日経VIデータ取得失敗（レジーム集計なし）:", err);
      return new Map<string, number>();
    }),
  ]);
  const dataFetchTimeMs = Date.now() - fetchStart;

  if (allData.size === 0) {
    throw new Error("ヒストリカルデータを取得できませんでした");
  }

  console.log(
    `[daily-backtest] データ取得完了: ${allData.size}銘柄 日経VI${nikkeiViData.size}件 (${(dataFetchTimeMs / 1000).toFixed(1)}秒)`,
  );

  // 4. 各ティアでシミュレーション実行
  const tierResults: DailyBacktestTierResult[] = [];
  const { DEFAULT_PARAMS } = DAILY_BACKTEST;

  for (const tier of DAILY_BACKTEST.BUDGET_TIERS) {
    const tierStart = Date.now();

    const config: BacktestConfig = {
      tickers: allTickers,
      startDate,
      endDate,
      initialBudget: tier.budget,
      maxPositions: tier.maxPositions,
      maxPrice: tier.maxPrice,
      scoreThreshold: DEFAULT_PARAMS.scoreThreshold,
      takeProfitRatio: DEFAULT_PARAMS.takeProfitRatio,
      stopLossRatio: DEFAULT_PARAMS.stopLossRatio,
      atrMultiplier: DEFAULT_PARAMS.atrMultiplier,
      trailingActivationMultiplier: DEFAULT_PARAMS.trailingActivationMultiplier,
      strategy: DEFAULT_PARAMS.strategy,
      trailingStopEnabled: DEFAULT_PARAMS.trailingStopEnabled,
      costModelEnabled: true,
      priceLimitEnabled: true,
      gapRiskEnabled: true,
      verbose: false,
    };

    console.log(`[daily-backtest] ${tier.label}ティア シミュレーション中...`);
    const result = runBacktest(config, allData, nikkeiViData, candidateMap);

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
    tickers: allTickers,
    periodStart: startDate,
    periodEnd: endDate,
    tierResults,
    dataFetchTimeMs,
  };
}
