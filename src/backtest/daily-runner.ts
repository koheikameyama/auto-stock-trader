/**
 * 日次自動バックテスト実行エンジン
 *
 * 1. ScoringRecordから日付別S/Aランク銘柄マップを構築（生存者バイアス除去）
 * 2. Yahoo Financeからデータを一括取得（1回のみ）
 * 3. 13のパラメータ条件でシミュレーション実行
 * 4. 結果を返す（DB保存・通知は呼び出し側で行う）
 */

import dayjs from "dayjs";
import { prisma } from "../lib/prisma";
import {
  DAILY_BACKTEST,
  type ParameterCondition,
  hasParamOverride,
  hasMultiOverride,
  getSectorGroup,
} from "../lib/constants";
import { fetchMultipleBacktestData, fetchVixData } from "./data-fetcher";
import { runBacktest } from "./simulation-engine";
import type { BacktestConfig, PerformanceMetrics } from "./types";

export interface DailyBacktestConditionResult {
  condition: ParameterCondition;
  config: BacktestConfig;
  metrics: PerformanceMetrics;
  tickerCount: number;
  executionTimeMs: number;
}

export interface DailyBacktestRunResult {
  tickers: string[];
  periodStart: string;
  periodEnd: string;
  conditionResults: DailyBacktestConditionResult[];
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

  // ScoringRecordが空 or 蓄積期間が短い場合はフォールバック
  const scoringMonths = oldest
    ? dayjs().diff(dayjs(oldest.date), "month")
    : 0;
  const needsFallback =
    !oldest || scoringMonths < DAILY_BACKTEST.MIN_SCORING_RECORD_MONTHS;

  if (needsFallback) {
    const reason = !oldest
      ? "ScoringRecord が空"
      : `ScoringRecord 蓄積期間が短い (${scoringMonths}ヶ月 < ${DAILY_BACKTEST.MIN_SCORING_RECORD_MONTHS}ヶ月)`;
    console.log(
      `[daily-backtest] ${reason} → Stockテーブルから出来高上位銘柄を使用（${DAILY_BACKTEST.LOOKBACK_MONTHS}ヶ月ルックバック）`,
    );
    const stocks = await prisma.stock.findMany({
      where: {
        isActive: true,
        isRestricted: false,
        latestVolume: { not: null },
      },
      orderBy: { latestVolume: "desc" },
      take: 100,
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

  // 3. データ一括取得（全条件共通）
  const fetchStart = Date.now();
  const [allData, vixData] = await Promise.all([
    fetchMultipleBacktestData(allTickers, startDate, endDate),
    fetchVixData(startDate, endDate).catch((err: unknown) => {
      console.warn("[daily-backtest] VIXデータ取得失敗（レジーム集計なし）:", err);
      return new Map<string, number>();
    }),
  ]);
  const dataFetchTimeMs = Date.now() - fetchStart;

  if (allData.size === 0) {
    throw new Error("ヒストリカルデータを取得できませんでした");
  }

  console.log(
    `[daily-backtest] データ取得完了: ${allData.size}銘柄 VIX${vixData.size}件 (${(dataFetchTimeMs / 1000).toFixed(1)}秒)`,
  );

  // 3.5. セクターデータ取得（RS計算用）
  const stocks = await prisma.stock.findMany({
    where: { tickerCode: { in: allTickers } },
    select: { tickerCode: true, jpxSectorName: true },
  });
  const sectorMap = new Map<string, string>();
  for (const s of stocks) {
    sectorMap.set(s.tickerCode, getSectorGroup(s.jpxSectorName) ?? "その他");
  }
  console.log(`[daily-backtest] セクターデータ: ${sectorMap.size}銘柄`);

  // 4. 各パラメータ条件でシミュレーション実行
  const conditionResults: DailyBacktestConditionResult[] = [];
  const { DEFAULT_PARAMS, FIXED_BUDGET, PARAMETER_CONDITIONS } = DAILY_BACKTEST;

  for (const condition of PARAMETER_CONDITIONS) {
    const condStart = Date.now();

    // ベースconfig: デフォルトパラメータ + 固定予算
    const config: BacktestConfig = {
      tickers: allTickers,
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
      strategy: DEFAULT_PARAMS.strategy,
      costModelEnabled: true,
      cooldownDays: DEFAULT_PARAMS.cooldownDays,
      overrideTpSl: DEFAULT_PARAMS.overrideTpSl,
      priceLimitEnabled: true,
      gapRiskEnabled: true,
      trendFilterEnabled: false,
      pullbackFilterEnabled: false,
      verbose: false,
    };

    // 条件のパラメータオーバーライドを適用
    if (hasParamOverride(condition)) {
      if (condition.param === "trailMultiplier") {
        config.trailMultiplier = condition.value;
      } else {
        (config as unknown as Record<string, unknown>)[condition.param] = condition.value;
      }
      if (condition.overrideTpSl) {
        config.overrideTpSl = true;
      }
    } else if (hasMultiOverride(condition)) {
      for (const [key, val] of Object.entries(condition.overrides)) {
        (config as unknown as Record<string, unknown>)[key] = val;
      }
    }

    console.log(`[daily-backtest] ${condition.label} シミュレーション中...`);
    const result = runBacktest(config, allData, vixData, candidateMap, sectorMap);

    conditionResults.push({
      condition,
      config,
      metrics: result.metrics,
      tickerCount: allData.size,
      executionTimeMs: Date.now() - condStart,
    });

    const sign = result.metrics.totalReturnPct >= 0 ? "+" : "";
    console.log(
      `[daily-backtest] ${condition.label}: 勝率${result.metrics.winRate}% PF${result.metrics.profitFactor} ${sign}${result.metrics.totalReturnPct}%`,
    );
  }

  return {
    tickers: allTickers,
    periodStart: startDate,
    periodEnd: endDate,
    conditionResults,
    dataFetchTimeMs,
  };
}
