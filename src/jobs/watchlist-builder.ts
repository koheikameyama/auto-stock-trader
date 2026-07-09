/**
 * ウォッチリストビルダージョブ（8:00 JST / 平日）
 *
 * 朝8:00に実行し、GU/WBエントリー候補リストを構築する。
 * 結果はDBに永続化し、gapup-monitor・Web UIから参照される。
 */

import dayjs from "dayjs";
import { Prisma } from "@prisma/client";
import { buildGuWatchlist, type GuWatchlistEntry } from "../core/gapup/gu-watchlist-builder";
import { notifySlack } from "../lib/slack";
import { prisma } from "../lib/prisma";
import { getTodayForDB } from "../lib/market-date";

const CACHE_TTL_MS = 5 * 60 * 1000;

/** 各銘柄の20日MAをStockDailyBarから計算してWatchlistEntryを更新 */
async function updateMa20ForWatchlist(tickerCodes: string[], today: Date): Promise<void> {
  const MA_PERIOD = 20;

  const startDate = dayjs(today).subtract(MA_PERIOD * 3, "day").toDate(); // 営業日換算で余裕を持たせる

  const bars = await prisma.stockDailyBar.findMany({
    where: {
      tickerCode: { in: tickerCodes },
      date: { gte: startDate, lte: today },
    },
    orderBy: [{ tickerCode: "asc" }, { date: "asc" }],
    select: { tickerCode: true, close: true },
  });

  // tickerCode ごとにグループ化
  const barsByTicker = new Map<string, number[]>();
  for (const bar of bars) {
    const closes = barsByTicker.get(bar.tickerCode) ?? [];
    closes.push(Number(bar.close));
    barsByTicker.set(bar.tickerCode, closes);
  }

  // MA20を計算し、単一の一括UPDATEで反映（銘柄ごとに個別クエリを投げると
  // 接続プール上限(5)を超過してタイムアウトするため VALUES で一括更新する）
  const valueRows: Prisma.Sql[] = [];
  for (const ticker of tickerCodes) {
    const closes = barsByTicker.get(ticker);
    if (!closes || closes.length < MA_PERIOD) continue;
    const recent = closes.slice(-MA_PERIOD);
    const ma20 = recent.reduce((s, v) => s + v, 0) / MA_PERIOD;
    valueRows.push(Prisma.sql`(${ticker}, ${ma20}::double precision)`);
  }
  if (valueRows.length > 0) {
    await prisma.$executeRaw`
      UPDATE "WatchlistEntry" AS w
      SET "ma20" = v.ma20
      FROM (VALUES ${Prisma.join(valueRows)}) AS v(ticker, ma20)
      WHERE w."tickerCode" = v.ticker AND w."date" = ${today}::date
    `;
  }
  console.log(`[watchlist-builder] MA20計算完了: ${valueRows.length}/${tickerCodes.length}銘柄`);
}

async function saveGuWatchlistToDB(entries: GuWatchlistEntry[]): Promise<void> {
  const today = getTodayForDB();
  await prisma.watchlistEntry.deleteMany({ where: { date: today } });
  if (entries.length > 0) {
    await prisma.watchlistEntry.createMany({
      data: entries.map((e) => ({
        date: today,
        tickerCode: e.ticker,
        avgVolume25: e.avgVolume25,
        atr14: e.atr14,
        latestClose: e.latestClose,
        momentum5d: e.momentum5d,
        weeklyHigh13: e.weeklyHigh13 ?? null,
      })),
    });
    // MA20を計算してWatchlistEntryを更新
    await updateMa20ForWatchlist(entries.map((e) => e.ticker), today);
  }
}

let cachedAllWatchlist: GuWatchlistEntry[] | null = null;
let allCacheExpiry = 0;

async function getAllWatchlistEntries(): Promise<GuWatchlistEntry[]> {
  const now = dayjs().valueOf();
  if (cachedAllWatchlist !== null && now < allCacheExpiry) {
    return cachedAllWatchlist;
  }
  const today = getTodayForDB();
  const rows = await prisma.watchlistEntry.findMany({ where: { date: today } });
  const entries: GuWatchlistEntry[] = rows.map((r) => ({
    ticker: r.tickerCode,
    avgVolume25: r.avgVolume25,
    high20: 0,
    atr14: r.atr14,
    latestClose: r.latestClose,
    weeklyHigh13: r.weeklyHigh13 ?? undefined,
    momentum5d: r.momentum5d,
  }));
  cachedAllWatchlist = entries;
  allCacheExpiry = now + CACHE_TTL_MS;
  return entries;
}

/** GUエントリー候補: momentum5d > 0 の銘柄のみ */
export async function getGuWatchlist(): Promise<GuWatchlistEntry[]> {
  const all = await getAllWatchlistEntries();
  return all.filter((e) => e.momentum5d > 0);
}

/** PSCエントリー候補: momentum5d の正負に関わらず全銘柄 */
export async function getAllWatchlist(): Promise<GuWatchlistEntry[]> {
  return getAllWatchlistEntries();
}

export async function main(): Promise<void> {
  console.log("=== Watchlist Builder 開始 ===");

  try {
    const { entries: guEntries, stats: guStats } = await buildGuWatchlist();
    await saveGuWatchlistToDB(guEntries);
    console.log(`GUウォッチリスト構築完了: ${guEntries.length}銘柄`);

    await notifySlack({
      title: "GUウォッチリスト構築完了",
      message:
        `GU監視対象: *${guStats.passed}銘柄*\n` +
        `対象: ${guStats.totalStocks} → OHLCV: ${guStats.historicalLoaded}\n` +
        `データ不足: -${guStats.skipInsufficientData} / ゲート落ち: -${guStats.skipGate} ` +
        `(決算前=${guStats.skipGateEarnings}, 決算後=${guStats.skipGateEarningsRecent})\n` +
        `週足下降: -${guStats.skipWeeklyTrend} / モメンタム不足: -${guStats.skipMomentum}`,
      color: "good",
    });
  } catch (err) {
    console.error("[watchlist-builder] エラー:", err);
    await notifySlack({
      title: "ウォッチリスト構築エラー",
      message: err instanceof Error ? err.message : String(err),
      color: "danger",
    });
    throw err;
  }

  console.log("=== Watchlist Builder 終了 ===");
}

const isDirectRun = process.argv[1]?.includes("watchlist-builder");
if (isDirectRun) {
  main()
    .catch((error) => {
      console.error("Watchlist Builder エラー:", error);
      process.exit(1);
    })
    .finally(async () => {
      await prisma.$disconnect();
    });
}
