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
import { YAHOO_FINANCE } from "../lib/constants";

const yahooFinance = new YahooFinance({
  suppressNotices: ["yahooSurvey"],
});

const LOOKBACK_CALENDAR_DAYS = 120;
const FETCH_CONCURRENCY = 3;

function isRetryableError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const msg = error.message;
  // 429 Rate Limit
  if (msg.includes("Too Many Requests") || msg.includes("429")) return true;
  // ネットワークエラー
  if (msg.includes("ETIMEDOUT") || msg.includes("ECONNRESET") ||
      msg.includes("ECONNREFUSED") || msg.includes("fetch failed") ||
      msg.includes("ENETUNREACH") || msg.includes("EAI_AGAIN")) return true;
  // cause チェーン
  const cause = (error as { cause?: { code?: string } }).cause;
  if (cause?.code === "ETIMEDOUT" || cause?.code === "ECONNRESET") return true;
  return false;
}

async function withRetry<T>(
  fn: () => Promise<T>,
  label: string,
): Promise<T> {
  for (let attempt = 0; attempt < YAHOO_FINANCE.RETRY_MAX_ATTEMPTS; attempt++) {
    try {
      return await fn();
    } catch (error: unknown) {
      if (!isRetryableError(error) || attempt >= YAHOO_FINANCE.RETRY_MAX_ATTEMPTS - 1) {
        throw error;
      }
      const delay = YAHOO_FINANCE.RETRY_BASE_DELAY_MS * 2 ** attempt;
      const errCode = error instanceof Error ? error.message.slice(0, 40) : "unknown";
      console.log(`  [backtest] ${label}: リトライ ${attempt + 1}/${YAHOO_FINANCE.RETRY_MAX_ATTEMPTS} (${delay}ms) [${errCode}]`);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw new Error("unreachable");
}

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

  const result = await withRetry(
    () =>
      yahooFinance.chart(symbol, {
        period1,
        period2,
        interval: "1d",
      }),
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
