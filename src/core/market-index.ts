/**
 * 日経平均（^N225）の直近確定セッション前日比を DB(StockDailyBar) から取得する。
 *
 * 場中前(08:02 JST)に走る market-assessment は、yfinance ライブ取得だと直近確定セッションの
 * 日足を1営業日取りこぼし、stale な前日比でキルスイッチ/CME乖離が誤作動する問題があった
 * （2026-06-30: 6/29(+0.15%) を読むべき所で 6/26(-4.15%) の stale 値を採用しキルスイッチ誤発火）。
 *
 * breadth(`calculateMarketBreadth`)と同じく DB を権威ソースとし、データが無ければ silent に
 * 古い値を返さず Error を throw する（呼び出し側が stale に気付けるようにする）。
 */

import dayjs from "dayjs";
import { prisma } from "../lib/prisma";
import { getTodayForDB, jstDateAsUTC } from "../lib/market-date";

const NIKKEI_TICKER = "^N225";

export interface IndexChangeResult {
  /** 直近確定セッションの前日比（%） */
  changePercent: number;
  /** 直近確定セッションの終値 */
  close: number;
  /** その1つ前のセッションの終値 */
  previousClose: number;
  /** 算出に使った直近確定セッションの営業日 */
  asOfDate: Date;
}

/**
 * upperBound（既定: JST今日）以前で最も新しい2本の ^N225 日足から前日比を算出する。
 * 場中前に呼ぶ前提のため、当日(まだ未確定)の足は通常 DB に存在せず、直近確定セッションが採用される。
 */
export async function getNikkeiLastSessionChange(
  upperBound: Date = getTodayForDB(),
): Promise<IndexChangeResult> {
  const cutoffDate = jstDateAsUTC(dayjs(upperBound).utc().subtract(20, "day"));

  const bars = await prisma.stockDailyBar.findMany({
    where: {
      tickerCode: NIKKEI_TICKER,
      date: { gte: cutoffDate, lte: upperBound },
    },
    orderBy: { date: "desc" },
    take: 2,
    select: { date: true, close: true },
  });

  if (bars.length < 2) {
    throw new Error(
      `Nikkei last-session change cannot be computed: fewer than 2 ${NIKKEI_TICKER} bars in last 20 days (found ${bars.length})`,
    );
  }

  const [last, prev] = bars;
  if (prev.close <= 0) {
    throw new Error(
      `Nikkei last-session change cannot be computed: invalid previousClose ${prev.close} on ${dayjs(prev.date).format("YYYY-MM-DD")}`,
    );
  }

  return {
    changePercent: ((last.close - prev.close) / prev.close) * 100,
    close: last.close,
    previousClose: prev.close,
    asOfDate: last.date,
  };
}
