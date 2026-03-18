/**
 * スコアリングコンポーネント分析スクリプト
 *
 * daily-backtestと同じ銘柄セット（on-the-fly、500銘柄）で
 * scoreThreshold=0にして全候補を対象に、コンポーネント別の
 * 相関分析を実行する。
 *
 * Usage:
 *   npx tsx scripts/analyze-scoring-components.ts
 */

import { runBacktest } from "../src/backtest/simulation-engine";
import { printComponentAnalysis } from "../src/backtest/component-analyzer";
import { printBacktestReport } from "../src/backtest/reporter";
import { fetchMultipleBacktestData, fetchVixData } from "../src/backtest/data-fetcher";
import {
  buildCandidateMapOnTheFly,
  type StockFundamentals,
} from "../src/backtest/on-the-fly-scorer";
import type { BacktestConfig } from "../src/backtest/types";
import { DAILY_BACKTEST, SCREENING } from "../src/lib/constants";
import { getSectorGroup } from "../src/lib/constants/trading";
import { prisma } from "../src/lib/prisma";
import dayjs from "dayjs";

async function main() {
  console.log("=== スコアリングコンポーネント分析 ===");
  const startTime = Date.now();

  const lookbackMonths = DAILY_BACKTEST.LOOKBACK_MONTHS;
  const maxStocks = 500;
  const endDate = dayjs().format("YYYY-MM-DD");
  const startDate = dayjs().subtract(lookbackMonths, "month").format("YYYY-MM-DD");

  // 1. 銘柄取得（daily-backtest on-the-flyと同じ条件）
  console.log("[analyze] 銘柄リスト取得中...");
  const stocks = await prisma.stock.findMany({
    where: {
      isDelisted: false,
      isActive: true,
      isRestricted: false,
      latestPrice: { not: null, gte: SCREENING.MIN_PRICE },
      latestVolume: { not: null, gte: SCREENING.MIN_DAILY_VOLUME },
    },
    orderBy: { latestVolume: "desc" },
    take: maxStocks,
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

  if (stocks.length === 0) {
    console.error("エラー: 銘柄が見つかりません");
    process.exit(1);
  }
  console.log(`[analyze] 対象銘柄: ${stocks.length}件`);

  // 2. データ取得（日経225含む）
  console.log("[analyze] データ取得中...");
  const stockTickers = stocks.map((s) => s.tickerCode);
  const { ON_THE_FLY } = DAILY_BACKTEST;
  const allTickersWithNikkei = [...stockTickers, "^N225"];

  const [allDataWithNikkei, vixData] = await Promise.all([
    fetchMultipleBacktestData(
      allTickersWithNikkei,
      startDate,
      endDate,
      ON_THE_FLY.LOOKBACK_CALENDAR_DAYS,
    ),
    fetchVixData(startDate, endDate).catch(() => new Map<string, number>()),
  ]);

  const nikkei225Ohlcv = allDataWithNikkei.get("^N225");
  allDataWithNikkei.delete("^N225");
  const allData = allDataWithNikkei;

  console.log(`[analyze] データ取得完了: ${allData.size}銘柄`);

  // 3. fundamentalsMap構築
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

  // 4. candidateMap構築（B/Cランクも含める）
  console.log("[analyze] candidateMap構築中...");
  const { candidateMap, allTickers } = buildCandidateMapOnTheFly(
    allData,
    fundamentalsMap,
    stocks.map((s) => ({
      tickerCode: s.tickerCode,
      jpxSectorName: s.jpxSectorName,
    })),
    startDate,
    endDate,
    ["S", "A", "B"],
    ["S", "A", "B"],
    1,
    nikkei225Ohlcv ? [...nikkei225Ohlcv] : undefined,
  );

  // sectorMap構築
  const sectorMap = new Map<string, string>();
  for (const stock of stocks) {
    if (stock.jpxSectorName) {
      const group = getSectorGroup(stock.jpxSectorName);
      if (group) sectorMap.set(stock.tickerCode, group);
    }
  }

  // 5. バックテスト実行（scoreThreshold=0で全候補対象）
  const { DEFAULT_PARAMS } = DAILY_BACKTEST;
  const config: BacktestConfig = {
    tickers: allTickers,
    startDate,
    endDate,
    initialBudget: 500_000,
    maxPositions: 3,
    maxPrice: 5000,
    scoreThreshold: 0,
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

  console.log("[analyze] シミュレーション実行中...");
  const result = runBacktest(config, allData, vixData, candidateMap, sectorMap);

  // 6. 結果表示
  printBacktestReport(result);
  printComponentAnalysis(result);

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`[analyze] 完了 (${elapsed}秒)`);
}

main()
  .catch((err) => {
    console.error("分析エラー:", err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
