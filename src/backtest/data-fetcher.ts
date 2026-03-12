/**
 * バックテスト用ヒストリカルデータ取得
 *
 * market-data-provider を経由して指定期間の OHLCV データを取得する。
 * oldest-first（時系列順）で返す。
 */

import pLimit from "p-limit";
import dayjs from "dayjs";
import type { OHLCVData } from "../core/technical-analysis";
import { normalizeTickerCode } from "../lib/ticker-utils";
import {
  providerFetchHistoricalRange,
} from "../lib/market-data-provider";

const LOOKBACK_CALENDAR_DAYS = 120;
const FETCH_CONCURRENCY = 3;

/**
 * 単一銘柄のヒストリカルデータを取得
 * @returns oldest-first の OHLCV 配列
 */
export async function fetchBacktestData(
  tickerCode: string,
  startDate: string,
  endDate: string,
): Promise<OHLCVData[]> {
  const symbol = normalizeTickerCode(tickerCode);
  const adjustedStart = dayjs(startDate)
    .subtract(LOOKBACK_CALENDAR_DAYS, "day")
    .format("YYYY-MM-DD");
  const adjustedEnd = dayjs(endDate).add(1, "day").format("YYYY-MM-DD");

  const bars = await providerFetchHistoricalRange(
    symbol,
    adjustedStart,
    adjustedEnd,
  );

  return bars
    .filter(
      (bar) =>
        bar.open != null &&
        bar.high != null &&
        bar.low != null &&
        bar.close != null,
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
}

/**
 * VIXの過去データを取得（レジーム判定に使用）
 * @returns date -> VIX終値 のMap
 */
export async function fetchVixData(
  startDate: string,
  endDate: string,
): Promise<Map<string, number>> {
  const adjustedStart = dayjs(startDate)
    .subtract(LOOKBACK_CALENDAR_DAYS, "day")
    .format("YYYY-MM-DD");
  const adjustedEnd = dayjs(endDate).add(1, "day").format("YYYY-MM-DD");

  const bars = await providerFetchHistoricalRange(
    "^VIX",
    adjustedStart,
    adjustedEnd,
  );

  const vixMap = new Map<string, number>();
  for (const bar of bars) {
    if (bar.close != null) {
      vixMap.set(bar.date, bar.close);
    }
  }

  console.log(`[backtest] VIXデータ取得完了: ${vixMap.size}件`);
  return vixMap;
}

/**
 * 複数銘柄のヒストリカルデータを一括取得
 */
export async function fetchMultipleBacktestData(
  tickers: string[],
  startDate: string,
  endDate: string,
): Promise<Map<string, OHLCVData[]>> {
  const limit = pLimit(FETCH_CONCURRENCY);
  const results = new Map<string, OHLCVData[]>();

  console.log(`[backtest] ${tickers.length}銘柄のデータを取得中...`);

  const tasks = tickers.map((ticker) =>
    limit(async () => {
      try {
        const data = await fetchBacktestData(ticker, startDate, endDate);
        console.log(`  ${ticker}: ${data.length}本取得`);
        return { ticker, data };
      } catch (error) {
        console.error(`  ${ticker}: 取得失敗`, error);
        return { ticker, data: [] as OHLCVData[] };
      }
    }),
  );

  const fetchResults = await Promise.all(tasks);
  for (const { ticker, data } of fetchResults) {
    if (data.length > 0) {
      results.set(ticker, data);
    }
  }

  console.log(`[backtest] データ取得完了: ${results.size}/${tickers.length}銘柄`);
  return results;
}
