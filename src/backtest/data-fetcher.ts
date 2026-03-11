/**
 * バックテスト用ヒストリカルデータ取得
 *
 * Yahoo Finance から指定期間の OHLCV データを取得する。
 * oldest-first（時系列順）で返す。
 */

import YahooFinance from "yahoo-finance2";
import pLimit from "p-limit";
import dayjs from "dayjs";
import type { OHLCVData } from "../core/technical-analysis";
import { normalizeTickerCode } from "../lib/ticker-utils";
import { withRetry as _withRetry } from "../lib/retry-utils";
import { throttledYahooRequest } from "../lib/yahoo-finance-throttle";

const yahooFinance = new YahooFinance({
  suppressNotices: ["yahooSurvey"],
});

const LOOKBACK_CALENDAR_DAYS = 120;
const FETCH_CONCURRENCY = 3;

const retry = <T>(fn: () => Promise<T>, label: string) =>
  _withRetry(fn, label, "backtest");

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
  const period1 = dayjs(startDate)
    .subtract(LOOKBACK_CALENDAR_DAYS, "day")
    .toDate();
  const period2 = dayjs(endDate).add(1, "day").toDate();

  const result = await retry(
    () =>
      throttledYahooRequest(() =>
        yahooFinance.chart(symbol, {
          period1,
          period2,
          interval: "1d",
        }),
      ),
    symbol,
  );

  const bars: OHLCVData[] = result.quotes
    .filter(
      (bar) =>
        bar.open != null &&
        bar.high != null &&
        bar.low != null &&
        bar.close != null,
    )
    .map((bar) => ({
      date: dayjs(bar.date).format("YYYY-MM-DD"),
      open: bar.open!,
      high: bar.high!,
      low: bar.low!,
      close: bar.close!,
      volume: bar.volume ?? 0,
    }))
    .sort((a, b) => a.date.localeCompare(b.date));

  return bars;
}

/**
 * 日経VI（日経平均ボラティリティー・インデックス）の過去データを取得
 * 取得できない場合はVIXデータ × 1.3 で日経VIを近似する
 * @returns date -> 日経VI終値 のMap
 */
export async function fetchNikkeiViData(
  startDate: string,
  endDate: string,
): Promise<Map<string, number>> {
  const period1 = dayjs(startDate).subtract(LOOKBACK_CALENDAR_DAYS, "day").toDate();
  const period2 = dayjs(endDate).add(1, "day").toDate();

  // 日経VIを試行
  try {
    const result = await retry(
      () =>
        throttledYahooRequest(() =>
          yahooFinance.chart("^JNV", {
            period1,
            period2,
            interval: "1d",
          }),
        ),
      "^JNV",
    );

    const nikkeiViMap = new Map<string, number>();
    for (const bar of result.quotes) {
      if (bar.close != null) {
        nikkeiViMap.set(dayjs(bar.date).format("YYYY-MM-DD"), bar.close);
      }
    }

    if (nikkeiViMap.size > 0) {
      console.log(`[backtest] 日経VIデータ取得完了: ${nikkeiViMap.size}件`);
      return nikkeiViMap;
    }
  } catch {
    console.warn("[backtest] 日経VI (^JNV) 取得失敗。VIXデータでフォールバック");
  }

  // フォールバック: VIXデータ × 1.3 で日経VIを近似
  const result = await retry(
    () =>
      throttledYahooRequest(() =>
        yahooFinance.chart("^VIX", {
          period1,
          period2,
          interval: "1d",
        }),
      ),
    "^VIX (fallback)",
  );

  const nikkeiViMap = new Map<string, number>();
  for (const bar of result.quotes) {
    if (bar.close != null) {
      nikkeiViMap.set(dayjs(bar.date).format("YYYY-MM-DD"), bar.close * 1.3);
    }
  }

  console.log(`[backtest] 日経VIデータ取得完了（VIX×1.3近似）: ${nikkeiViMap.size}件`);
  return nikkeiViMap;
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
