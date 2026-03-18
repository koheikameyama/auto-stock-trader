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
import type { OHLCVData } from "../src/core/technical-analysis.js";
import { normalizeTickerCode } from "../src/lib/ticker-utils.js";
import { providerFetchHistoricalBatch } from "../src/lib/market-data-provider.js";
import { SCREENING } from "../src/lib/constants/trading.js";
import { TECHNICAL_MIN_DATA } from "../src/lib/constants/technical.js";
import {
  scoreDayForAllStocks,
  extractTradingDays,
  type ScoredRecord,
  type StockFundamentals,
} from "../src/backtest/on-the-fly-scorer.js";

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
  const allTradingDays = extractTradingDays(allOhlcv, startDate, endDate);
  console.log(`  営業日: ${allTradingDays.length}日`);

  // 既存データがある日付をスキップ
  const existingDates = await prisma.scoringRecord.findMany({
    where: { date: { gte: new Date(startDate), lte: new Date(endDate) } },
    select: { date: true },
    distinct: ["date"],
  });
  const existingDateSet = new Set(
    existingDates.map((r) => dayjs(r.date).format("YYYY-MM-DD")),
  );
  const tradingDays = allTradingDays.filter((d) => !existingDateSet.has(d));
  if (existingDateSet.size > 0) {
    console.log(`  既存データ: ${existingDateSet.size}日分スキップ`);
  }
  console.log(`  処理対象: ${tradingDays.length}日`);

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
  const rankDistribution: Record<string, number> = { S: 0, A: 0, B: 0 };

  for (let dayIdx = 0; dayIdx < tradingDays.length; dayIdx++) {
    const targetDate = tradingDays[dayIdx];

    // 各銘柄のデータをスライスしてスコアリング
    const dayRecords = scoreDayForAllStocks(
      targetDate,
      allOhlcv,
      fundamentalsMap,
      stocks,
      undefined,
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
        trendQualityScore: r.trendQualityScore,
        trendQualityBreakdown: r.trendQualityBreakdown,
        entryTimingScore: r.entryTimingScore,
        entryTimingBreakdown: r.entryTimingBreakdown,
        riskQualityScore: r.riskQualityScore,
        riskQualityBreakdown: r.riskQualityBreakdown,
        sectorMomentumScore: r.sectorMomentumScore,
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
    `  ランク分布: S=${rankDistribution.S} A=${rankDistribution.A} B=${rankDistribution.B}`,
  );
  if (DRY_RUN) {
    console.log(`  ※ dry-run のためDB書き込みはスキップしました`);
  }
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
