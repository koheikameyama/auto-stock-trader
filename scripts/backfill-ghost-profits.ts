/**
 * ゴースト損益バックフィルスクリプト
 *
 * バックフィル済み ScoringRecord にゴースト損益を後付け計算する。
 *
 * バックフィルの entryPrice は当日終値のため、リアルタイム版と異なり
 * 「翌営業日フォワードリターン」で予測力を検証する:
 *   ghostProfitPct  = (nextDayClose - entryPrice) / entryPrice * 100
 *   nextDayProfitPct = (nextDayClose - closingPrice) / closingPrice * 100
 *   closingPrice    = 当日終値（= entryPrice と同値）
 *
 * Usage:
 *   npx tsx scripts/backfill-ghost-profits.ts
 *   npx tsx scripts/backfill-ghost-profits.ts --rank S,A,B
 *   npx tsx scripts/backfill-ghost-profits.ts --dry-run --verbose
 */

import { parseArgs } from "node:util";
import dayjs from "dayjs";
import { PrismaClient } from "@prisma/client";
import { normalizeTickerCode } from "../src/lib/ticker-utils.js";
import { providerFetchHistoricalBatch } from "../src/lib/market-data-provider.js";
import type { YfOHLCVBar } from "../src/lib/yfinance-client.js";

const prisma = new PrismaClient();

// ========================================
// CLI引数
// ========================================

const { values: args } = parseArgs({
  options: {
    rank: { type: "string" },
    "dry-run": { type: "boolean", default: false },
    verbose: { type: "boolean", default: false },
    help: { type: "boolean", default: false },
  },
});

if (args.help) {
  console.log(`
ゴースト損益バックフィル

Usage:
  npx tsx scripts/backfill-ghost-profits.ts [オプション]

オプション:
  --rank <S,A,B,...>  対象ランク（カンマ区切り、省略時は全ランク）
  --dry-run           DB更新せずサンプル表示のみ
  --verbose           詳細ログ
  --help              ヘルプ表示
  `);
  process.exit(0);
}

const RANK_FILTER = args.rank
  ? args.rank.split(",").map((r) => r.trim().toUpperCase())
  : undefined;
const DRY_RUN = args["dry-run"] ?? false;
const VERBOSE = args.verbose ?? false;

const CUTOFF_DATE = "2026-03-07";
const DOWNLOAD_BATCH_SIZE = 200;

// ========================================
// メイン処理
// ========================================

async function main(): Promise<void> {
  const startTime = Date.now();

  console.log("[backfill-ghost] ゴースト損益バックフィル開始");
  if (RANK_FILTER) console.log(`  対象ランク: ${RANK_FILTER.join(", ")}`);
  if (DRY_RUN) console.log("  ※ dry-run モード（DB更新なし）");

  // 1. 対象レコードの銘柄・日付範囲を特定
  console.log("[1/4] 対象レコードを確認中...");

  const whereCondition: Record<string, unknown> = {
    date: { lt: new Date(CUTOFF_DATE) },
    closingPrice: null,
    entryPrice: { not: null },
  };
  if (RANK_FILTER) {
    whereCondition.rank = { in: RANK_FILTER };
  }

  const targetCount = await prisma.scoringRecord.count({
    where: whereCondition,
  });

  const distinctTickers = await prisma.scoringRecord.findMany({
    where: whereCondition,
    select: { tickerCode: true },
    distinct: ["tickerCode"],
  });
  const tickerCodes = distinctTickers.map((r) => r.tickerCode);

  const dateRange = await prisma.scoringRecord.aggregate({
    where: whereCondition,
    _min: { date: true },
    _max: { date: true },
  });

  const minDate = dayjs(dateRange._min.date).format("YYYY-MM-DD");
  const maxDate = dayjs(dateRange._max.date).format("YYYY-MM-DD");

  console.log(`  対象レコード: ${targetCount.toLocaleString()}件`);
  console.log(`  対象銘柄: ${tickerCodes.length}件`);
  console.log(`  期間: ${minDate} ~ ${maxDate}`);

  if (targetCount === 0) {
    console.log("  更新対象なし。終了します。");
    return;
  }

  // 2. 株価データ一括取得
  console.log("[2/4] ヒストリカルデータを取得中...");
  const fetchStart = minDate;
  // nextDayClosingPrice のため最終日+数日分を取得
  const fetchEnd = dayjs(maxDate).add(5, "day").format("YYYY-MM-DD");

  const allSymbols = tickerCodes.map((t) => normalizeTickerCode(t));
  const tickerBySymbol = new Map(
    tickerCodes.map((t) => [normalizeTickerCode(t), t]),
  );

  // {tickerCode → {dateStr → closePrice}}
  const closePriceMap = new Map<string, Map<string, number>>();
  // 営業日リスト（ソート済）
  const tradingDaySet = new Set<string>();

  for (let i = 0; i < allSymbols.length; i += DOWNLOAD_BATCH_SIZE) {
    const batchSymbols = allSymbols.slice(i, i + DOWNLOAD_BATCH_SIZE);
    const batchNum = Math.floor(i / DOWNLOAD_BATCH_SIZE) + 1;
    const totalBatches = Math.ceil(allSymbols.length / DOWNLOAD_BATCH_SIZE);
    console.log(
      `  バッチ ${batchNum}/${totalBatches}: ${batchSymbols.length}銘柄`,
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

        const bars: YfOHLCVBar[] | undefined = batchResult[symbol];
        if (!bars || bars.length === 0) continue;

        const dateCloseMap = new Map<string, number>();
        for (const bar of bars) {
          if (bar.close != null && bar.close > 0) {
            dateCloseMap.set(bar.date, bar.close);
            tradingDaySet.add(bar.date);
          }
        }

        if (dateCloseMap.size > 0) {
          closePriceMap.set(ticker, dateCloseMap);
        }
      }
    } catch (error) {
      console.error(`  バッチ${batchNum}取得失敗:`, error);
    }
  }

  console.log(
    `  データ取得完了: ${closePriceMap.size}/${tickerCodes.length}銘柄`,
  );

  // 営業日リスト（翌営業日検索用）
  const tradingDays = [...tradingDaySet].sort();

  // 翌営業日ルックアップ
  const nextTradingDayMap = new Map<string, string>();
  for (let i = 0; i < tradingDays.length - 1; i++) {
    nextTradingDayMap.set(tradingDays[i], tradingDays[i + 1]);
  }

  // 3. ゴースト損益計算 + DB更新
  console.log("[3/4] ゴースト損益計算 + DB更新中...");

  // 日付ごとにレコードを取得して更新
  const targetDates = await prisma.scoringRecord.findMany({
    where: whereCondition,
    select: { date: true },
    distinct: ["date"],
    orderBy: { date: "asc" },
  });

  let totalUpdated = 0;
  let totalSkipped = 0;
  const rankStats: Record<string, { count: number; sumPnl: number }> = {};

  for (let dayIdx = 0; dayIdx < targetDates.length; dayIdx++) {
    const targetDate = targetDates[dayIdx].date;
    const dateStr = dayjs(targetDate).format("YYYY-MM-DD");
    const nextDay = nextTradingDayMap.get(dateStr);

    // この日付のレコードを取得
    const records = await prisma.scoringRecord.findMany({
      where: {
        date: targetDate,
        closingPrice: null,
        entryPrice: { not: null },
        ...(RANK_FILTER ? { rank: { in: RANK_FILTER } } : {}),
      },
      select: {
        id: true,
        tickerCode: true,
        entryPrice: true,
        rank: true,
      },
    });

    const updates: {
      id: string;
      closingPrice: number;
      ghostProfitPct: number;
      nextDayClosingPrice: number | null;
      nextDayProfitPct: number | null;
    }[] = [];

    for (const record of records) {
      const tickerCloses = closePriceMap.get(record.tickerCode);
      if (!tickerCloses) {
        totalSkipped++;
        continue;
      }

      const closingPrice = tickerCloses.get(dateStr);
      if (closingPrice == null) {
        totalSkipped++;
        continue;
      }

      // 翌営業日終値が必要（フォワードリターン計算のため）
      if (!nextDay) {
        totalSkipped++;
        continue;
      }
      const nextDayClosingPrice = tickerCloses.get(nextDay);
      if (nextDayClosingPrice == null) {
        totalSkipped++;
        continue;
      }

      const entryPrice = Number(record.entryPrice);
      // ghostProfitPct = 翌営業日フォワードリターン（entryPrice → nextDayClose）
      const ghostProfitPct =
        ((nextDayClosingPrice - entryPrice) / entryPrice) * 100;
      // nextDayProfitPct = 翌日騰落率（closingPrice → nextDayClose）
      const nextDayProfitPct =
        ((nextDayClosingPrice - closingPrice) / closingPrice) * 100;

      updates.push({
        id: record.id,
        closingPrice,
        ghostProfitPct,
        nextDayClosingPrice,
        nextDayProfitPct,
      });

      // ランク別統計
      const rank = record.rank;
      if (!rankStats[rank]) rankStats[rank] = { count: 0, sumPnl: 0 };
      rankStats[rank].count++;
      rankStats[rank].sumPnl += ghostProfitPct;
    }

    // raw SQL バッチ更新（UPDATE FROM VALUES で一括更新）
    if (!DRY_RUN && updates.length > 0) {
      const SQL_BATCH_SIZE = 500;
      for (let bi = 0; bi < updates.length; bi += SQL_BATCH_SIZE) {
        const batch = updates.slice(bi, bi + SQL_BATCH_SIZE);
        const valuesList = batch
          .map(
            (u) =>
              `('${u.id}', ${u.closingPrice}, ${u.ghostProfitPct}, ${u.nextDayClosingPrice ?? "NULL"}, ${u.nextDayProfitPct ?? "NULL"})`,
          )
          .join(",\n");

        await prisma.$executeRawUnsafe(`
          UPDATE "ScoringRecord" AS sr SET
            "closingPrice" = v.closing_price,
            "ghostProfitPct" = v.ghost_profit,
            "nextDayClosingPrice" = v.next_day_close,
            "nextDayProfitPct" = v.next_day_profit
          FROM (VALUES ${valuesList})
            AS v(id, closing_price, ghost_profit, next_day_close, next_day_profit)
          WHERE sr.id = v.id
        `);
      }
    }

    totalUpdated += updates.length;

    if (VERBOSE || (dayIdx + 1) % 20 === 0) {
      console.log(
        `  ${dateStr}: ${updates.length}件更新 [${dayIdx + 1}/${targetDates.length}]`,
      );
    }
  }

  // 4. 結果サマリ
  console.log("[4/4] 結果サマリ");
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`\n[backfill-ghost] 完了 (${elapsed}秒)`);
  console.log(`  更新: ${totalUpdated.toLocaleString()}件`);
  console.log(`  スキップ: ${totalSkipped.toLocaleString()}件（株価データなし）`);

  console.log("\n  ランク別平均ゴースト損益:");
  for (const rank of ["S", "A", "B"]) {
    const stat = rankStats[rank];
    if (!stat) continue;
    const avgPnl = (stat.sumPnl / stat.count).toFixed(3);
    console.log(
      `    ${rank}: ${stat.count.toLocaleString()}件  avg: ${avgPnl}%`,
    );
  }

  if (DRY_RUN) {
    console.log("\n  ※ dry-run のためDB更新はスキップしました");
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
