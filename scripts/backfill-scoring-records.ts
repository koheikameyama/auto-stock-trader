/**
 * ScoringRecord バックフィルスクリプト
 *
 * 過去N ヶ月分の ScoringRecord を生成し、日次バックテストの
 * フォールバックモード（出来高上位100銘柄）を解消する。
 *
 * Usage:
 *   npx tsx scripts/backfill-scoring-records.ts
 *   npx tsx scripts/backfill-scoring-records.ts --months 3
 *   npx tsx scripts/backfill-scoring-records.ts --dry-run --verbose
 */

import { parseArgs } from "node:util";
import dayjs from "dayjs";
import { PrismaClient } from "@prisma/client";
import { analyzeTechnicals } from "../src/core/technical-analysis.js";
import type { OHLCVData } from "../src/core/technical-analysis.js";
import {
  scoreTechnicals,
  calculateRsScores,
} from "../src/core/technical-scorer.js";
import { detectChartPatterns } from "../src/lib/chart-patterns.js";
import { analyzeSingleCandle } from "../src/lib/candlestick-patterns.js";
import {
  aggregateDailyToWeekly,
  analyzeWeeklyTrend,
} from "../src/lib/technical-indicators.js";
import { getSectorGroup } from "../src/lib/constants/trading.js";
import { normalizeTickerCode } from "../src/lib/ticker-utils.js";
import { providerFetchHistoricalBatch } from "../src/lib/market-data-provider.js";
import {
  SCREENING,
} from "../src/lib/constants/trading.js";
import { TECHNICAL_MIN_DATA } from "../src/lib/constants/technical.js";
import { SCORING } from "../src/lib/constants/scoring.js";

const prisma = new PrismaClient();

// ========================================
// CLI引数
// ========================================

const { values: args } = parseArgs({
  options: {
    months: { type: "string", default: "3" },
    limit: { type: "string" },
    "dry-run": { type: "boolean", default: false },
    verbose: { type: "boolean", default: false },
    help: { type: "boolean", default: false },
  },
});

if (args.help) {
  console.log(`
ScoringRecord バックフィル

Usage:
  npx tsx scripts/backfill-scoring-records.ts [オプション]

オプション:
  --months <n>    バックフィル月数（デフォルト: 3）
  --limit <n>     対象銘柄数の上限（デバッグ用）
  --dry-run       DB書き込みせずスコアのみ表示
  --verbose       詳細ログ
  --help          ヘルプ表示
  `);
  process.exit(0);
}

const MONTHS = Number(args.months);
const STOCK_LIMIT = args.limit ? Number(args.limit) : undefined;
const DRY_RUN = args["dry-run"] ?? false;
const VERBOSE = args.verbose ?? false;

// テクニカル指標に必要なルックバック日数
const LOOKBACK_CALENDAR_DAYS = 200;

// yf.download バッチサイズ（1回のAPIリクエストに含める銘柄数）
const DOWNLOAD_BATCH_SIZE = 200;

// ========================================
// メイン処理
// ========================================

async function main(): Promise<void> {
  const startTime = Date.now();
  const endDate = dayjs().format("YYYY-MM-DD");
  const startDate = dayjs().subtract(MONTHS, "month").format("YYYY-MM-DD");

  console.log(`[backfill] ScoringRecord バックフィル開始`);
  console.log(`  期間: ${startDate} ~ ${endDate} (${MONTHS}ヶ月)`);
  if (DRY_RUN) console.log(`  ※ dry-run モード（DB書き込みなし）`);

  // 1. アクティブ銘柄一覧を取得
  console.log("[1/4] アクティブ銘柄を取得中...");
  let stocks = await prisma.stock.findMany({
    where: {
      isDelisted: false,
      isActive: true,
      isRestricted: false,
      latestPrice: {
        not: null,
        gte: SCREENING.MIN_PRICE,
      },
      latestVolume: { not: null, gte: SCREENING.MIN_DAILY_VOLUME },
    },
    select: {
      tickerCode: true,
      name: true,
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

  if (STOCK_LIMIT && stocks.length > STOCK_LIMIT) {
    stocks = stocks.slice(0, STOCK_LIMIT);
    console.log(`  対象銘柄: ${stocks.length}件 (--limit ${STOCK_LIMIT})`);
  } else {
    console.log(`  対象銘柄: ${stocks.length}件`);
  }

  // 2. OHLCV データを一括取得（yf.download バッチ）
  console.log("[2/4] ヒストリカルデータを取得中...");
  const fetchStart = dayjs(startDate)
    .subtract(LOOKBACK_CALENDAR_DAYS, "day")
    .format("YYYY-MM-DD");
  const fetchEnd = dayjs(endDate).add(1, "day").format("YYYY-MM-DD");

  const allOhlcv = new Map<string, OHLCVData[]>();
  const allSymbols = stocks.map((s) => normalizeTickerCode(s.tickerCode));
  const tickerBySymbol = new Map(
    stocks.map((s) => [normalizeTickerCode(s.tickerCode), s.tickerCode]),
  );

  // バッチごとに yf.download で一括取得
  for (let i = 0; i < allSymbols.length; i += DOWNLOAD_BATCH_SIZE) {
    const batchSymbols = allSymbols.slice(i, i + DOWNLOAD_BATCH_SIZE);
    console.log(
      `  バッチ ${Math.floor(i / DOWNLOAD_BATCH_SIZE) + 1}/${Math.ceil(allSymbols.length / DOWNLOAD_BATCH_SIZE)}: ${batchSymbols.length}銘柄`,
    );

    try {
      const batchResult = await providerFetchHistoricalBatch(
        batchSymbols,
        fetchStart,
        fetchEnd,
      );

      for (const symbol of batchSymbols) {
        const ticker = tickerBySymbol.get(symbol);
        if (!ticker) continue;

        const bars = batchResult[symbol];
        if (!bars || bars.length === 0) continue;

        const data = bars
          .filter(
            (bar) =>
              bar.open != null &&
              bar.high != null &&
              bar.low != null &&
              bar.close != null &&
              bar.close > 0,
          )
          .map((bar) => ({
            date: bar.date,
            open: bar.open,
            high: bar.high,
            low: bar.low,
            close: bar.close,
            volume: bar.volume ?? 0,
          }))
          .sort((a, b) => a.date.localeCompare(b.date));

        if (data.length >= TECHNICAL_MIN_DATA.SCANNER_MIN_BARS) {
          allOhlcv.set(ticker, data);
        }
      }
    } catch (error) {
      console.error(`  バッチ取得失敗:`, error);
    }
  }

  console.log(
    `  データ取得完了: ${allOhlcv.size}/${stocks.length}銘柄`,
  );

  // 3. 営業日リストを生成（OHLCV データから共通日付を抽出）
  console.log("[3/4] 営業日リストを生成中...");
  const tradingDays = extractTradingDays(allOhlcv, startDate, endDate);
  console.log(`  営業日: ${tradingDays.length}日`);

  // 4. 各営業日についてスコアリング
  console.log("[4/4] スコアリング実行中...");

  // ファンダメンタルデータをマップ化（現在値を使用）
  const fundamentalsMap = new Map(
    stocks.map((s) => [
      s.tickerCode,
      {
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
      },
    ]),
  );

  let totalRecords = 0;
  const rankDistribution: Record<string, number> = { S: 0, A: 0, B: 0, C: 0 };

  for (let dayIdx = 0; dayIdx < tradingDays.length; dayIdx++) {
    const targetDate = tradingDays[dayIdx];

    // 各銘柄のデータをスライスしてスコアリング
    const dayRecords = scoreDayForAllStocks(
      targetDate,
      allOhlcv,
      fundamentalsMap,
      stocks,
    );

    if (dayRecords.length === 0) continue;

    // ランク分布を集計
    for (const r of dayRecords) {
      rankDistribution[r.rank] = (rankDistribution[r.rank] ?? 0) + 1;
    }

    if (!DRY_RUN) {
      // DB書き込み
      const dateForDb = new Date(
        Date.UTC(
          Number(targetDate.slice(0, 4)),
          Number(targetDate.slice(5, 7)) - 1,
          Number(targetDate.slice(8, 10)),
        ),
      );

      const dbRecords = dayRecords.map((r) => ({
        date: dateForDb,
        tickerCode: r.tickerCode,
        totalScore: r.totalScore,
        rank: r.rank,
        technicalScore: r.technicalScore,
        technicalBreakdown: r.technicalBreakdown,
        patternScore: r.patternScore,
        patternBreakdown: r.patternBreakdown,
        liquidityScore: r.liquidityScore,
        liquidityBreakdown: r.liquidityBreakdown,
        fundamentalScore: r.fundamentalScore,
        fundamentalBreakdown: r.fundamentalBreakdown,
        isDisqualified: r.isDisqualified,
        disqualifyReason: r.disqualifyReason,
        aiDecision: null,
        aiReasoning: null,
        rejectionReason: r.rejectionReason,
        entryPrice: r.entryPrice,
        contrarianBonus: 0,
        contrarianWins: 0,
      }));

      await prisma.scoringRecord.createMany({
        data: dbRecords,
        skipDuplicates: true,
      });
    }

    totalRecords += dayRecords.length;

    if (VERBOSE || (dayIdx + 1) % 10 === 0) {
      const sCount = dayRecords.filter((r) => r.rank === "S").length;
      const aCount = dayRecords.filter((r) => r.rank === "A").length;
      console.log(
        `  ${targetDate}: ${dayRecords.length}銘柄スコア済 (S:${sCount} A:${aCount}) [${dayIdx + 1}/${tradingDays.length}]`,
      );
    }
  }

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`\n[backfill] 完了 (${elapsed}秒)`);
  console.log(`  総レコード: ${totalRecords}件 (${tradingDays.length}営業日)`);
  console.log(
    `  ランク分布: S=${rankDistribution.S} A=${rankDistribution.A} B=${rankDistribution.B} C=${rankDistribution.C}`,
  );
  if (DRY_RUN) {
    console.log(`  ※ dry-run のためDB書き込みはスキップしました`);
  }
}

// ========================================
// 日次スコアリング
// ========================================

interface ScoredRecord {
  tickerCode: string;
  totalScore: number;
  rank: string;
  technicalScore: number;
  technicalBreakdown: {
    rsi: number;
    ma: number;
    volume: number;
    volumeDirection: string;
    macd: number;
    rs: number;
    weeklyTrendPenalty: number;
  };
  patternScore: number;
  patternBreakdown: { chart: number; candlestick: number };
  liquidityScore: number;
  liquidityBreakdown: {
    tradingValue: number;
    spreadProxy: number;
    stability: number;
  };
  fundamentalScore: number;
  fundamentalBreakdown: {
    per: number;
    pbr: number;
    profitability: number;
    marketCap: number;
  };
  isDisqualified: boolean;
  disqualifyReason: string | null;
  rejectionReason: string | null;
  entryPrice: number | null;
}

interface StockFundamentals {
  per: number | null;
  pbr: number | null;
  eps: number | null;
  marketCap: number | null;
  latestPrice: number;
  volatility: number | null;
  nextEarningsDate: Date | null;
  exDividendDate: Date | null;
  latestVolume: number;
  jpxSectorName: string | null;
}

function scoreDayForAllStocks(
  targetDate: string,
  allOhlcv: Map<string, OHLCVData[]>,
  fundamentalsMap: Map<string, StockFundamentals>,
  stocks: { tickerCode: string; jpxSectorName: string | null }[],
): ScoredRecord[] {
  // 各銘柄の targetDate 以前のデータをスライス
  const stockSlices = new Map<string, OHLCVData[]>();
  for (const [ticker, data] of allOhlcv) {
    // data は oldest-first
    const sliceEnd = data.findIndex((d) => d.date > targetDate);
    const slice =
      sliceEnd === -1 ? data : data.slice(0, sliceEnd);
    if (slice.length >= TECHNICAL_MIN_DATA.SCANNER_MIN_BARS) {
      stockSlices.set(ticker, slice);
    }
  }

  if (stockSlices.size === 0) return [];

  // weekChangeRate を計算し、RS スコアを算出
  const rsInput: {
    tickerCode: string;
    weekChangeRate: number | null;
    sector: string;
  }[] = [];
  const sectorMap: Record<string, number[]> = {};

  for (const [ticker, slice] of stockSlices) {
    const stock = stocks.find((s) => s.tickerCode === ticker);
    const sector = getSectorGroup(stock?.jpxSectorName ?? null) ?? "その他";

    // slice は oldest-first なので末尾が最新
    const latestIdx = slice.length - 1;
    let weekChangeRate: number | null = null;
    if (slice.length >= 5) {
      const current = slice[latestIdx].close;
      const weekAgo = slice[latestIdx - 4].close;
      if (weekAgo > 0) {
        weekChangeRate =
          Math.round(((current - weekAgo) / weekAgo) * 10000) / 100;
      }
    }

    rsInput.push({ tickerCode: ticker, weekChangeRate, sector });
    if (weekChangeRate != null) {
      if (!sectorMap[sector]) sectorMap[sector] = [];
      sectorMap[sector].push(weekChangeRate);
    }
  }

  const sectorAvgs: Record<string, number> = {};
  for (const [sector, rates] of Object.entries(sectorMap)) {
    sectorAvgs[sector] = rates.reduce((a, b) => a + b, 0) / rates.length;
  }

  const rsScoreMap = calculateRsScores(rsInput, sectorAvgs);

  // 各銘柄をスコアリング
  const results: ScoredRecord[] = [];

  for (const [ticker, slice] of stockSlices) {
    try {
      const fund = fundamentalsMap.get(ticker);
      if (!fund) continue;

      // analyzeTechnicals は newest-first を期待
      const newestFirst = [...slice].reverse();
      const summary = analyzeTechnicals(newestFirst);

      // detectChartPatterns は oldest-first を期待
      const chartPatterns = detectChartPatterns(
        slice.map((d) => ({
          date: d.date,
          open: d.open,
          high: d.high,
          low: d.low,
          close: d.close,
        })),
      );

      // 最新のローソク足
      const latest = newestFirst[0];
      const candlestickPattern = analyzeSingleCandle({
        date: latest.date,
        open: latest.open,
        high: latest.high,
        low: latest.low,
        close: latest.close,
      });

      // 週足トレンド
      const weeklyBars = aggregateDailyToWeekly(
        slice.map((d) => ({
          date: d.date,
          open: d.open,
          high: d.high,
          low: d.low,
          close: d.close,
          volume: d.volume,
        })),
      );
      const weeklyTrend =
        weeklyBars.length >= SCORING.WEEKLY_TREND.MIN_WEEKLY_BARS
          ? analyzeWeeklyTrend(weeklyBars)
          : null;

      // スコアリング
      const score = scoreTechnicals({
        summary,
        chartPatterns,
        candlestickPattern,
        historicalData: newestFirst,
        latestPrice: latest.close,
        latestVolume: latest.volume,
        weeklyVolatility: fund.volatility,
        weeklyTrend,
        fundamentals: {
          per: fund.per,
          pbr: fund.pbr,
          eps: fund.eps,
          marketCap: fund.marketCap,
          latestPrice: latest.close,
        },
        nextEarningsDate: fund.nextEarningsDate,
        exDividendDate: fund.exDividendDate,
        rsScore: rsScoreMap.get(ticker) ?? 0,
      });

      // rejectionReason を設定
      let rejectionReason: string | null = null;
      if (score.isDisqualified) {
        rejectionReason = "disqualified";
      } else if (score.totalScore < 65) {
        rejectionReason = "below_threshold";
      }

      results.push({
        tickerCode: ticker,
        totalScore: score.totalScore,
        rank: score.rank,
        technicalScore: score.technical.total,
        technicalBreakdown: {
          rsi: score.technical.rsi,
          ma: score.technical.ma,
          volume: score.technical.volume,
          volumeDirection: score.technical.volumeDirection,
          macd: score.technical.macd,
          rs: score.technical.rs,
          weeklyTrendPenalty: score.weeklyTrendPenalty,
        },
        patternScore: score.pattern.total,
        patternBreakdown: {
          chart: score.pattern.chart,
          candlestick: score.pattern.candlestick,
        },
        liquidityScore: score.liquidity.total,
        liquidityBreakdown: {
          tradingValue: score.liquidity.tradingValue,
          spreadProxy: score.liquidity.spreadProxy,
          stability: score.liquidity.stability,
        },
        fundamentalScore: score.fundamental.total,
        fundamentalBreakdown: {
          per: score.fundamental.per,
          pbr: score.fundamental.pbr,
          profitability: score.fundamental.profitability,
          marketCap: score.fundamental.marketCap,
        },
        isDisqualified: score.isDisqualified,
        disqualifyReason: score.disqualifyReason,
        rejectionReason,
        entryPrice: latest.close,
      });
    } catch {
      if (VERBOSE) {
        console.warn(`  ${ticker}: スコアリング失敗 (${targetDate})`);
      }
    }
  }

  return results;
}

// ========================================
// ユーティリティ
// ========================================

/**
 * OHLCV データから指定期間の営業日リストを抽出
 */
function extractTradingDays(
  allOhlcv: Map<string, OHLCVData[]>,
  startDate: string,
  endDate: string,
): string[] {
  const daySet = new Set<string>();
  for (const data of allOhlcv.values()) {
    for (const bar of data) {
      if (bar.date >= startDate && bar.date <= endDate) {
        daySet.add(bar.date);
      }
    }
  }
  return [...daySet].sort();
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ========================================
// 実行
// ========================================

main()
  .catch((err) => {
    console.error("バックフィルエラー:", err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
