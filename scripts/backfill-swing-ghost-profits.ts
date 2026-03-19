/**
 * スイングゴースト損益バックフィルスクリプト
 *
 * ScoringRecord に5営業日後・10営業日後のリターンを後付け計算する。
 *   ghost5DayProfitPct  = (day5Close - entryPrice) / entryPrice * 100
 *   ghost10DayProfitPct = (day10Close - entryPrice) / entryPrice * 100
 *
 * Usage:
 *   npx tsx scripts/backfill-swing-ghost-profits.ts
 *   npx tsx scripts/backfill-swing-ghost-profits.ts --dry-run --verbose
 */

import { parseArgs } from "node:util";
import dayjs from "dayjs";
import { PrismaClient } from "@prisma/client";
import { normalizeTickerCode } from "../src/lib/ticker-utils.js";
import { providerFetchHistoricalBatch } from "../src/lib/market-data-provider.js";
import type { YfOHLCVBar } from "../src/lib/yfinance-client.js";

const prisma = new PrismaClient();

const { values: args } = parseArgs({
  options: {
    "dry-run": { type: "boolean", default: false },
    verbose: { type: "boolean", default: false },
    help: { type: "boolean", default: false },
  },
});

if (args.help) {
  console.log(`
スイングゴースト損益バックフィル（5日/10日リターン）

Usage:
  npx tsx scripts/backfill-swing-ghost-profits.ts [オプション]

オプション:
  --dry-run   DB更新せずサンプル表示のみ
  --verbose   詳細ログ
  --help      ヘルプ表示
  `);
  process.exit(0);
}

const DRY_RUN = args["dry-run"] ?? false;
const VERBOSE = args.verbose ?? false;
const DOWNLOAD_BATCH_SIZE = 200;
const SQL_BATCH_SIZE = 500;
const DAY5_OFFSET = 5;
const DAY10_OFFSET = 10;

async function main(): Promise<void> {
  const startTime = Date.now();

  console.log("[backfill-swing] スイングゴースト損益バックフィル開始");
  if (DRY_RUN) console.log("  ※ dry-run モード（DB更新なし）");

  // 1. 対象レコード確認
  console.log("[1/4] 対象レコードを確認中...");

  // 5日 or 10日のどちらかが未計算のレコード
  const targetRecords = await prisma.scoringRecord.findMany({
    where: {
      entryPrice: { not: null },
      OR: [
        { ghost5DayProfitPct: null },
        { ghost10DayProfitPct: null },
      ],
    },
    select: {
      id: true,
      date: true,
      tickerCode: true,
      entryPrice: true,
      rank: true,
      ghost5DayProfitPct: true,
      ghost10DayProfitPct: true,
    },
    orderBy: { date: "asc" },
  });

  if (targetRecords.length === 0) {
    console.log("  更新対象なし。終了します。");
    return;
  }

  const tickerCodes = [...new Set(targetRecords.map((r) => r.tickerCode))];
  const minDate = dayjs(targetRecords[0].date).format("YYYY-MM-DD");
  const maxDate = dayjs(targetRecords[targetRecords.length - 1].date).format("YYYY-MM-DD");

  console.log(`  対象レコード: ${targetRecords.length.toLocaleString()}件`);
  console.log(`  対象銘柄: ${tickerCodes.length}件`);
  console.log(`  期間: ${minDate} ~ ${maxDate}`);

  // 2. 株価データ一括取得
  console.log("[2/4] ヒストリカルデータを取得中...");
  const fetchStart = minDate;
  // 10営業日後のデータが必要なので+20日余裕を持たせる
  const fetchEnd = dayjs(maxDate).add(20, "day").format("YYYY-MM-DD");

  const allSymbols = tickerCodes.map((t) => normalizeTickerCode(t));
  const tickerBySymbol = new Map(
    tickerCodes.map((t) => [normalizeTickerCode(t), t]),
  );

  // {tickerCode → {dateStr → closePrice}}
  const closePriceMap = new Map<string, Map<string, number>>();
  // 全銘柄共通の営業日リスト
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

  // 営業日リスト（N営業日後の検索用）
  const tradingDays = [...tradingDaySet].sort();
  const tradingDayIndex = new Map<string, number>();
  for (let i = 0; i < tradingDays.length; i++) {
    tradingDayIndex.set(tradingDays[i], i);
  }

  /** N営業日後の日付を返す */
  function getNthTradingDay(dateStr: string, n: number): string | undefined {
    const idx = tradingDayIndex.get(dateStr);
    if (idx == null) return undefined;
    const targetIdx = idx + n;
    return targetIdx < tradingDays.length ? tradingDays[targetIdx] : undefined;
  }

  // 3. スイングリターン計算 + DB更新
  console.log("[3/4] スイングリターン計算 + DB更新中...");

  let updated5 = 0;
  let updated10 = 0;
  let skipped = 0;

  interface SwingUpdate {
    id: string;
    ghost5DayProfitPct: number | null;
    ghost10DayProfitPct: number | null;
  }

  const allUpdates: SwingUpdate[] = [];

  for (const record of targetRecords) {
    const dateStr = dayjs(record.date).format("YYYY-MM-DD");
    const tickerCloses = closePriceMap.get(record.tickerCode);
    if (!tickerCloses) {
      skipped++;
      continue;
    }

    const entryPrice = Number(record.entryPrice);
    if (entryPrice <= 0) {
      skipped++;
      continue;
    }

    let g5: number | null = record.ghost5DayProfitPct != null
      ? Number(record.ghost5DayProfitPct)
      : null;
    let g10: number | null = record.ghost10DayProfitPct != null
      ? Number(record.ghost10DayProfitPct)
      : null;

    // 5営業日後
    if (g5 == null) {
      const day5 = getNthTradingDay(dateStr, DAY5_OFFSET);
      const day5Close = day5 ? tickerCloses.get(day5) : undefined;
      if (day5Close != null) {
        g5 = ((day5Close - entryPrice) / entryPrice) * 100;
        updated5++;
      }
    }

    // 10営業日後
    if (g10 == null) {
      const day10 = getNthTradingDay(dateStr, DAY10_OFFSET);
      const day10Close = day10 ? tickerCloses.get(day10) : undefined;
      if (day10Close != null) {
        g10 = ((day10Close - entryPrice) / entryPrice) * 100;
        updated10++;
      }
    }

    // いずれかが新規計算された場合のみ更新対象
    if (
      (record.ghost5DayProfitPct == null && g5 != null) ||
      (record.ghost10DayProfitPct == null && g10 != null)
    ) {
      allUpdates.push({ id: record.id, ghost5DayProfitPct: g5, ghost10DayProfitPct: g10 });
    } else {
      skipped++;
    }
  }

  // raw SQL バッチ更新
  if (!DRY_RUN && allUpdates.length > 0) {
    console.log(`  DB更新中: ${allUpdates.length}件...`);
    for (let bi = 0; bi < allUpdates.length; bi += SQL_BATCH_SIZE) {
      const batch = allUpdates.slice(bi, bi + SQL_BATCH_SIZE);
      const valuesList = batch
        .map(
          (u) =>
            `('${u.id}', ${u.ghost5DayProfitPct ?? "NULL"}, ${u.ghost10DayProfitPct ?? "NULL"})`,
        )
        .join(",\n");

      await prisma.$executeRawUnsafe(`
        UPDATE "ScoringRecord" AS sr SET
          "ghost5DayProfitPct" = COALESCE(v.g5, sr."ghost5DayProfitPct"),
          "ghost10DayProfitPct" = COALESCE(v.g10, sr."ghost10DayProfitPct")
        FROM (VALUES ${valuesList})
          AS v(id, g5, g10)
        WHERE sr.id = v.id
      `);

      if (VERBOSE) {
        console.log(`    バッチ ${Math.floor(bi / SQL_BATCH_SIZE) + 1}/${Math.ceil(allUpdates.length / SQL_BATCH_SIZE)} 完了`);
      }
    }
  }

  // 4. 結果サマリ
  console.log("[4/4] 結果サマリ");
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`\n[backfill-swing] 完了 (${elapsed}秒)`);
  console.log(`  5日リターン更新: ${updated5.toLocaleString()}件`);
  console.log(`  10日リターン更新: ${updated10.toLocaleString()}件`);
  console.log(`  スキップ: ${skipped.toLocaleString()}件（株価データなし or 十分な営業日なし）`);

  if (DRY_RUN) {
    // サンプル表示
    const samples = allUpdates.slice(0, 10);
    console.log(`\n  サンプル（先頭${samples.length}件）:`);
    for (const s of samples) {
      const rec = targetRecords.find((r) => r.id === s.id);
      console.log(
        `    ${rec?.tickerCode} ${dayjs(rec?.date).format("YYYY-MM-DD")} 5d=${s.ghost5DayProfitPct?.toFixed(2) ?? "N/A"}% 10d=${s.ghost10DayProfitPct?.toFixed(2) ?? "N/A"}%`,
      );
    }
    console.log("\n  ※ dry-run のためDB更新はスキップしました");
  }
}

main()
  .catch((err) => {
    console.error("バックフィルエラー:", err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
