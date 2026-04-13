/**
 * ウォッチリストビルダージョブ（8:00 JST / 平日）
 *
 * 朝8:00に実行し、GU/WBエントリー候補リストを構築する。
 * 結果はDBに永続化し、gapup-monitor・weekly-break-monitor・Web UIから参照される。
 */

import dayjs from "dayjs";
import { buildGuWatchlist, type GuWatchlistEntry } from "../core/gapup/gu-watchlist-builder";
import { notifySlack } from "../lib/slack";
import { prisma } from "../lib/prisma";
import { getTodayForDB } from "../lib/market-date";

const CACHE_TTL_MS = 5 * 60 * 1000;

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
  }
}

let cachedGuWatchlist: GuWatchlistEntry[] | null = null;
let guCacheExpiry = 0;

export async function getGuWatchlist(): Promise<GuWatchlistEntry[]> {
  const now = dayjs().valueOf();
  if (cachedGuWatchlist !== null && now < guCacheExpiry) {
    return cachedGuWatchlist;
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
  cachedGuWatchlist = entries;
  guCacheExpiry = now + CACHE_TTL_MS;
  return entries;
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
        `データ不足: -${guStats.skipInsufficientData} / ゲート落ち: -${guStats.skipGate}\n` +
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
