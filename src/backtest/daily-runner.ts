/**
 * 日次自動バックテスト実行エンジン
 *
 * 候補銘柄マップの構築方法:
 *   - scoring-record: ScoringRecordテーブルから読み込み（既存）
 *   - on-the-fly: メモリ内でスコアリング計算（DB容量ゼロ、長期間対応）
 *   - auto: ScoringRecord十分→scoring-record、不足→on-the-fly
 */

import dayjs from "dayjs";
import { prisma } from "../lib/prisma";
import {
  DAILY_BACKTEST,
  SCREENING,
  type ParameterCondition,
  hasParamOverride,
  hasMultiOverride,
  getSectorGroup,
} from "../lib/constants";
import { fetchMultipleBacktestData, fetchVixData } from "./data-fetcher";
import { runBacktest } from "./simulation-engine";
import {
  buildCandidateMapOnTheFly,
  type StockFundamentals,
} from "./on-the-fly-scorer";
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

export type CandidateMode = "scoring-record" | "on-the-fly" | "auto";

export interface DailyBacktestOptions {
  /** 候補銘柄マップの構築方法（default: "auto"） */
  candidateMode?: CandidateMode;
  /** on-the-fly時のバックテスト期間（月数、default: LOOKBACK_MONTHS） */
  lookbackMonths?: number;
  /** on-the-fly時の最大銘柄数（出来高上位N件、default: 全件） */
  maxStocks?: number;
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
  // dayjs().diff(date, "month") は切り捨てで誤判定するため日数で比較
  const scoringDays = oldest
    ? dayjs().diff(dayjs(oldest.date), "day")
    : 0;
  const minDays = DAILY_BACKTEST.MIN_SCORING_RECORD_MONTHS * 30;
  const needsFallback = !oldest || scoringDays < minDays;

  if (needsFallback) {
    const reason = !oldest
      ? "ScoringRecord が空"
      : `ScoringRecord 蓄積期間が短い (${scoringDays}日 < ${minDays}日)`;
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
 * 候補銘柄マップの構築モードを自動判定
 */
async function resolveCandidateMode(
  requested: CandidateMode,
): Promise<"scoring-record" | "on-the-fly"> {
  if (requested !== "auto") return requested;

  const oldest = await prisma.scoringRecord.findFirst({
    where: { isDisqualified: false },
    orderBy: { date: "asc" },
    select: { date: true },
  });
  const scoringDays = oldest
    ? dayjs().diff(dayjs(oldest.date), "day")
    : 0;
  const minDays = DAILY_BACKTEST.MIN_SCORING_RECORD_MONTHS * 30;

  if (!oldest || scoringDays < minDays) {
    const reason = !oldest
      ? "ScoringRecord が空"
      : `ScoringRecord 蓄積期間が短い (${scoringDays}日 < ${minDays}日)`;
    console.log(`[daily-backtest] ${reason} → オンザフライモードを使用`);
    return "on-the-fly";
  }

  console.log(
    `[daily-backtest] ScoringRecord十分 (${scoringDays}日) → ScoringRecordモード`,
  );
  return "scoring-record";
}

/**
 * オンザフライモード: メモリ内でスコアリング → candidateMap構築
 */
async function runOnTheFlyMode(
  lookbackMonths: number,
  maxStocks?: number,
): Promise<{
  candidateMap: Map<string, string[]>;
  allTickers: string[];
  allData: Map<string, import("../core/technical-analysis").OHLCVData[]>;
  vixData: Map<string, number>;
  sectorMap: Map<string, string>;
  startDate: string;
  endDate: string;
  dataFetchTimeMs: number;
}> {
  const endDate = dayjs().format("YYYY-MM-DD");
  const startDate = dayjs()
    .subtract(lookbackMonths, "month")
    .format("YYYY-MM-DD");

  console.log(
    `[daily-backtest] オンザフライモード: ${startDate}〜${endDate} (${lookbackMonths}ヶ月)`,
  );

  // 1. アクティブ銘柄 + ファンダメンタルを取得
  const stocks = await prisma.stock.findMany({
    where: {
      isDelisted: false,
      isActive: true,
      isRestricted: false,
      latestPrice: { not: null, gte: SCREENING.MIN_PRICE },
      latestVolume: { not: null, gte: SCREENING.MIN_DAILY_VOLUME },
    },
    orderBy: { latestVolume: "desc" },
    ...(maxStocks ? { take: maxStocks } : {}),
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

  const stockTickers = stocks.map((s) => s.tickerCode);
  console.log(`[daily-backtest] アクティブ銘柄: ${stocks.length}件`);

  // 2. OHLCV一括取得（スコアリング用の長めのルックバック）
  const fetchStart = Date.now();
  const { ON_THE_FLY } = DAILY_BACKTEST;
  const [allData, vixData] = await Promise.all([
    fetchMultipleBacktestData(
      stockTickers,
      startDate,
      endDate,
      ON_THE_FLY.LOOKBACK_CALENDAR_DAYS,
    ),
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

  // 3. ファンダメンタルマップ構築
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

  // 4. オンザフライでcandidateMap構築
  const { TARGET_RANKS, FALLBACK_RANKS, MIN_TICKERS } =
    DAILY_BACKTEST.TICKER_SELECTION;

  const scoringStart = Date.now();
  const { candidateMap, allTickers } = buildCandidateMapOnTheFly(
    allData,
    fundamentalsMap,
    stocks,
    startDate,
    endDate,
    TARGET_RANKS,
    FALLBACK_RANKS,
    MIN_TICKERS,
  );
  console.log(
    `[daily-backtest] スコアリング完了 (${((Date.now() - scoringStart) / 1000).toFixed(1)}秒)`,
  );

  // 5. セクターマップ構築
  const sectorMap = new Map<string, string>();
  for (const s of stocks) {
    sectorMap.set(s.tickerCode, getSectorGroup(s.jpxSectorName) ?? "その他");
  }

  return {
    candidateMap,
    allTickers,
    allData,
    vixData,
    sectorMap,
    startDate,
    endDate,
    dataFetchTimeMs,
  };
}

/**
 * ScoringRecordモード: DBからcandidateMap読み込み（既存ロジック）
 */
async function runScoringRecordMode(): Promise<{
  candidateMap: Map<string, string[]> | null;
  allTickers: string[];
  allData: Map<string, import("../core/technical-analysis").OHLCVData[]>;
  vixData: Map<string, number>;
  sectorMap: Map<string, string>;
  startDate: string;
  endDate: string;
  dataFetchTimeMs: number;
}> {
  const { candidateMap, allTickers, startDate } = await buildCandidateMap();
  if (allTickers.length === 0) {
    throw new Error("バックテスト対象銘柄が0件です");
  }

  console.log(`[daily-backtest] 対象銘柄: ${allTickers.length}件`);
  const endDate = dayjs().format("YYYY-MM-DD");

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

  const stocks = await prisma.stock.findMany({
    where: { tickerCode: { in: allTickers } },
    select: { tickerCode: true, jpxSectorName: true },
  });
  const sectorMap = new Map<string, string>();
  for (const s of stocks) {
    sectorMap.set(s.tickerCode, getSectorGroup(s.jpxSectorName) ?? "その他");
  }
  console.log(`[daily-backtest] セクターデータ: ${sectorMap.size}銘柄`);

  return {
    candidateMap,
    allTickers,
    allData,
    vixData,
    sectorMap,
    startDate,
    endDate,
    dataFetchTimeMs,
  };
}

/**
 * 日次バックテストを実行
 */
export async function runDailyBacktest(
  options?: DailyBacktestOptions,
): Promise<DailyBacktestRunResult> {
  const requestedMode = options?.candidateMode ?? "auto";
  const lookbackMonths =
    options?.lookbackMonths ?? DAILY_BACKTEST.LOOKBACK_MONTHS;

  // 1. モード判定 & データ取得 + candidateMap構築
  const mode = await resolveCandidateMode(requestedMode);
  const {
    candidateMap,
    allTickers,
    allData,
    vixData,
    sectorMap,
    startDate,
    endDate,
    dataFetchTimeMs,
  } =
    mode === "on-the-fly"
      ? await runOnTheFlyMode(lookbackMonths, options?.maxStocks)
      : await runScoringRecordMode();

  if (allTickers.length === 0) {
    throw new Error("バックテスト対象銘柄が0件です");
  }

  // 2. 各パラメータ条件でシミュレーション実行
  const conditionResults: DailyBacktestConditionResult[] = [];
  const { DEFAULT_PARAMS, FIXED_BUDGET, PARAMETER_CONDITIONS } = DAILY_BACKTEST;

  for (const condition of PARAMETER_CONDITIONS) {
    const condStart = Date.now();

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

    if (hasParamOverride(condition)) {
      if (condition.param === "trailMultiplier") {
        config.trailMultiplier = condition.value;
      } else {
        (config as unknown as Record<string, unknown>)[condition.param] =
          condition.value;
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
