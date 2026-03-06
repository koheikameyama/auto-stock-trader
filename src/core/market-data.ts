/**
 * 市場データ取得モジュール
 *
 * yahoo-finance2 を使用して株価・市場指標データを取得する
 */

import YahooFinance from "yahoo-finance2";
import pLimit from "p-limit";

const yahooFinance = new YahooFinance({
  suppressNotices: ["yahooSurvey"],
});
import { YAHOO_FINANCE } from "../lib/constants";
import { normalizeTickerCode } from "../lib/ticker-utils";

// ========================================
// インターフェース
// ========================================

export interface StockQuote {
  tickerCode: string;
  price: number;
  previousClose: number;
  change: number;
  changePercent: number;
  volume: number;
  high: number;
  low: number;
  open: number;
}

export interface OHLCVBar {
  date: string; // ISO date string
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface IndexQuote {
  price: number;
  previousClose: number;
  change: number;
  changePercent: number;
}

export interface MarketData {
  nikkei: IndexQuote | null;
  sp500: IndexQuote | null;
  vix: IndexQuote | null;
  usdjpy: IndexQuote | null;
  cmeFutures: IndexQuote | null;
}

// ========================================
// 市場指標シンボル
// ========================================

const MARKET_SYMBOLS = {
  NIKKEI: "^N225",
  SP500: "^GSPC",
  VIX: "^VIX",
  USDJPY: "JPY=X",
  CME_FUTURES: "NKD=F",
} as const;

// ========================================
// ユーティリティ
// ========================================

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ========================================
// 個別銘柄データ取得
// ========================================

/**
 * 個別銘柄のリアルタイムクォートを取得
 */
export async function fetchStockQuote(
  tickerCode: string,
): Promise<StockQuote | null> {
  const symbol = normalizeTickerCode(tickerCode);

  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result: any = await yahooFinance.quote(symbol);

    return {
      tickerCode: symbol,
      price: result.regularMarketPrice ?? 0,
      previousClose: result.regularMarketPreviousClose ?? 0,
      change: result.regularMarketChange ?? 0,
      changePercent: result.regularMarketChangePercent ?? 0,
      volume: result.regularMarketVolume ?? 0,
      high: result.regularMarketDayHigh ?? 0,
      low: result.regularMarketDayLow ?? 0,
      open: result.regularMarketOpen ?? 0,
    };
  } catch (error) {
    console.error(`[market-data] Failed to fetch quote for ${symbol}:`, error);
    return null;
  }
}

/**
 * 複数銘柄のクォートをバッチ取得
 */
export async function fetchStockQuotes(
  tickerCodes: string[],
): Promise<(StockQuote | null)[]> {
  const limit = pLimit(5);
  const results: (StockQuote | null)[] = [];

  for (let i = 0; i < tickerCodes.length; i += YAHOO_FINANCE.BATCH_SIZE) {
    const batch = tickerCodes.slice(i, i + YAHOO_FINANCE.BATCH_SIZE);

    const batchResults = await Promise.all(
      batch.map((ticker) => limit(() => fetchStockQuote(ticker))),
    );
    results.push(...batchResults);

    if (i + YAHOO_FINANCE.BATCH_SIZE < tickerCodes.length) {
      await sleep(YAHOO_FINANCE.RATE_LIMIT_DELAY_MS);
    }
  }

  return results;
}

// ========================================
// ヒストリカルデータ取得
// ========================================

/**
 * 過去60日間のOHLCVデータを取得（テクニカル分析用）
 * @returns OHLCVデータ配列（新しい順 = newest-first）
 */
export async function fetchHistoricalData(
  tickerCode: string,
): Promise<OHLCVBar[] | null> {
  const symbol = normalizeTickerCode(tickerCode);

  try {
    const period1 = new Date();
    period1.setDate(period1.getDate() - YAHOO_FINANCE.HISTORICAL_DAYS);

    const result = await yahooFinance.chart(symbol, {
      period1,
      period2: new Date(),
      interval: "1d",
    });

    // 新しい順にソート（テクニカル分析モジュールが期待する形式）
    const sorted = result.quotes.sort(
      (a, b) => new Date(b.date).getTime() - new Date(a.date).getTime(),
    );

    return sorted.map((bar) => ({
      date: new Date(bar.date).toISOString().split("T")[0],
      open: bar.open ?? 0,
      high: bar.high ?? 0,
      low: bar.low ?? 0,
      close: bar.close ?? 0,
      volume: bar.volume ?? 0,
    }));
  } catch (error) {
    console.error(
      `[market-data] Failed to fetch historical data for ${symbol}:`,
      error,
    );
    return null;
  }
}

// ========================================
// 市場指標データ取得
// ========================================

async function fetchIndexQuote(symbol: string): Promise<IndexQuote | null> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result: any = await yahooFinance.quote(symbol);

    return {
      price: result.regularMarketPrice ?? 0,
      previousClose: result.regularMarketPreviousClose ?? 0,
      change: result.regularMarketChange ?? 0,
      changePercent: result.regularMarketChangePercent ?? 0,
    };
  } catch (error) {
    console.error(
      `[market-data] Failed to fetch index quote for ${symbol}:`,
      error,
    );
    return null;
  }
}

/**
 * 市場指標データを一括取得
 */
export async function fetchMarketData(): Promise<MarketData> {
  const [nikkei, sp500, vix, usdjpy, cmeFutures] = await Promise.all([
    fetchIndexQuote(MARKET_SYMBOLS.NIKKEI),
    fetchIndexQuote(MARKET_SYMBOLS.SP500),
    fetchIndexQuote(MARKET_SYMBOLS.VIX),
    fetchIndexQuote(MARKET_SYMBOLS.USDJPY),
    fetchIndexQuote(MARKET_SYMBOLS.CME_FUTURES),
  ]);

  return { nikkei, sp500, vix, usdjpy, cmeFutures };
}
