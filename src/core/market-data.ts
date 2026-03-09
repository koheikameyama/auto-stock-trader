/**
 * 市場データ取得モジュール
 *
 * yahoo-finance2 を使用して株価・市場指標データを取得する
 */

import YahooFinance from "yahoo-finance2";
import pLimit from "p-limit";
import dayjs from "dayjs";

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

/**
 * リトライ可能なエラーか判定（429 + ネットワークエラー）
 */
function isRetryableError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const msg = error.message;
  if (msg.includes("Too Many Requests") || msg.includes("429")) return true;
  if (msg.includes("ETIMEDOUT") || msg.includes("ECONNRESET") ||
      msg.includes("ECONNREFUSED") || msg.includes("fetch failed") ||
      msg.includes("ENETUNREACH") || msg.includes("EAI_AGAIN")) return true;
  const cause = (error as { cause?: { code?: string } }).cause;
  if (cause?.code === "ETIMEDOUT" || cause?.code === "ECONNRESET") return true;
  return false;
}

/**
 * リトライ可能エラー時に指数バックオフでリトライ
 */
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
      console.warn(
        `[market-data] ${label}: リトライ ${attempt + 1}/${YAHOO_FINANCE.RETRY_MAX_ATTEMPTS} after ${delay}ms [${errCode}]`,
      );
      await sleep(delay);
    }
  }
  throw new Error("unreachable");
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function parseQuoteResult(result: any, symbol: string): StockQuote {
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
    const result: any = await withRetry(
      () => yahooFinance.quote(symbol),
      symbol,
    );
    return parseQuoteResult(result, symbol);
  } catch (error) {
    console.error(`[market-data] Failed to fetch quote for ${symbol}:`, error);
    return null;
  }
}

/**
 * 複数銘柄のクォートをバッチ取得（yahoo-finance2のネイティブバッチAPI使用）
 * 1リクエストで複数銘柄を取得するため、個別取得よりはるかに高速
 */
export async function fetchStockQuotesBatch(
  tickerCodes: string[],
): Promise<Map<string, StockQuote>> {
  const results = new Map<string, StockQuote>();
  const symbols = tickerCodes.map(normalizeTickerCode);

  for (let i = 0; i < symbols.length; i += YAHOO_FINANCE.BATCH_SIZE) {
    const batch = symbols.slice(i, i + YAHOO_FINANCE.BATCH_SIZE);

    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const batchResults: any[] = await withRetry(
        () => yahooFinance.quote(batch),
        `batch[${i}..${i + batch.length}]`,
      );

      for (const result of batchResults) {
        const symbol = result.symbol as string;
        if (symbol) {
          results.set(symbol, parseQuoteResult(result, symbol));
        }
      }
    } catch (error) {
      console.error(
        `[market-data] Batch quote failed for [${i}..${i + batch.length}]:`,
        error,
      );
      // バッチ失敗時は個別にフォールバック
      for (const symbol of batch) {
        try {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const result: any = await withRetry(
            () => yahooFinance.quote(symbol),
            symbol,
          );
          results.set(symbol, parseQuoteResult(result, symbol));
        } catch {
          console.error(`[market-data] Individual fallback failed: ${symbol}`);
        }
      }
    }

    if (i + YAHOO_FINANCE.BATCH_SIZE < symbols.length) {
      await sleep(YAHOO_FINANCE.RATE_LIMIT_DELAY_MS);
    }
  }

  return results;
}

/**
 * 複数銘柄のクォートをバッチ取得（配列で返す互換API）
 */
export async function fetchStockQuotes(
  tickerCodes: string[],
): Promise<(StockQuote | null)[]> {
  const batchMap = await fetchStockQuotesBatch(tickerCodes);
  return tickerCodes.map((ticker) => {
    const symbol = normalizeTickerCode(ticker);
    return batchMap.get(symbol) ?? null;
  });
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
    const period1 = dayjs().subtract(YAHOO_FINANCE.HISTORICAL_DAYS, "day").toDate();

    const result = await withRetry(() => yahooFinance.chart(symbol, {
      period1,
      period2: dayjs().toDate(),
      interval: "1d",
    }), symbol);

    // 新しい順にソート（テクニカル分析モジュールが期待する形式）
    const sorted = result.quotes.sort(
      (a, b) => dayjs(b.date).valueOf() - dayjs(a.date).valueOf(),
    );

    return sorted.map((bar) => ({
      date: dayjs(bar.date).format("YYYY-MM-DD"),
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
    const result: any = await withRetry(
      () => yahooFinance.quote(symbol),
      symbol,
    );

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
