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
import { INDEX_TREND_HYSTERESIS } from "../lib/constants";

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

export interface IndexTrendState {
  /** true = 日経がSMA上（エントリー許可） */
  filterOn: boolean;
  /** 判定に使った直近確定セッションの終値 */
  close: number;
  /** 同セッション時点のSMA */
  sma: number;
  /** 判定に使った営業日 */
  asOfDate: Date;
}

/**
 * 日経225の SMA トレンドフィルター状態を DB(StockDailyBar) から算出する。
 *
 * BT側 `precomputeSimData()` の `dailyIndexAboveSma` と同一ロジック（ヒステリシスをリプレイし
 * 現在状態を決める）。バッファは `INDEX_TREND_HYSTERESIS` を共有するので、BT config の
 * `indexTrendOffBufferPct` / `indexTrendOnBufferPct` と値を揃えている限り意味論が一致する。
 *
 * 本番は場中前(08:02 JST)に走るため、参照できるのは直近確定セッションまで。BT が当日終値で
 * 判定するのに対し1営業日遅れる点は breadth と同じ構造的ラグ。
 *
 * @returns データ不足で判定不能なら null（呼び出し側はフィルター不適用として扱う）
 */
export async function getNikkeiTrendFilterState(
  upperBound: Date = getTodayForDB(),
): Promise<IndexTrendState | null> {
  const { SMA_PERIOD, OFF_BUFFER_PCT, ON_BUFFER_PCT, WARMUP_DAYS } = INDEX_TREND_HYSTERESIS;

  const barsDesc = await prisma.stockDailyBar.findMany({
    where: { tickerCode: NIKKEI_TICKER, date: { lte: upperBound } },
    orderBy: { date: "desc" },
    take: SMA_PERIOD + WARMUP_DAYS,
    select: { date: true, close: true },
  });
  if (barsDesc.length < SMA_PERIOD) return null;

  const bars = barsDesc.reverse(); // oldest-first

  let filterOn = true;
  let sma = 0;
  for (let i = SMA_PERIOD - 1; i < bars.length; i++) {
    let sum = 0;
    for (let j = i - SMA_PERIOD + 1; j <= i; j++) sum += bars[j].close;
    sma = sum / SMA_PERIOD;

    if (filterOn) {
      if (bars[i].close < sma * (1 - OFF_BUFFER_PCT)) filterOn = false;
    } else {
      if (bars[i].close > sma * (1 + ON_BUFFER_PCT)) filterOn = true;
    }
  }

  const last = bars[bars.length - 1];
  return { filterOn, close: last.close, sma, asOfDate: last.date };
}
