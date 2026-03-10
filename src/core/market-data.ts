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
import { YAHOO_FINANCE, DATA_QUALITY } from "../lib/constants";
import { normalizeTickerCode } from "../lib/ticker-utils";
import { sleep, withRetry as _withRetry } from "../lib/retry-utils";

const retry = <T>(fn: () => Promise<T>, label: string) =>
  _withRetry(fn, label, "market-data");

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
  // ファンダメンタルズ
  per: number | null;       // trailingPE
  pbr: number | null;       // priceToBook
  eps: number | null;       // epsTrailingTwelveMonths
  marketCap: number | null; // 時価総額（円）
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
    // ファンダメンタルズ
    per: result.trailingPE ?? null,
    pbr: result.priceToBook ?? null,
    eps: result.epsTrailingTwelveMonths ?? null,
    marketCap: result.marketCap ?? null,
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
    const result: any = await retry(
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
      const batchResults: any[] = await retry(
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
          const result: any = await retry(
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

    const result = await retry(() => yahooFinance.chart(symbol, {
      period1,
      period2: dayjs().toDate(),
      interval: "1d",
    }), symbol);

    const totalBars = result.quotes.length;

    // null/無効なOHLCバーを除外（close=0はテクニカル指標の除算エラーを引き起こす）
    const validBars = result.quotes
      .filter(
        (bar) =>
          bar.open != null &&
          bar.high != null &&
          bar.low != null &&
          bar.close != null &&
          bar.close > 0,
      )
      .map((bar) => ({
        date: dayjs(bar.date).format("YYYY-MM-DD"),
        open: bar.open!,
        high: bar.high!,
        low: bar.low!,
        close: bar.close!,
        volume: bar.volume ?? 0,
      }));

    // 欠損率チェック
    if (totalBars > 0) {
      const missingRate = 1 - validBars.length / totalBars;
      if (missingRate > DATA_QUALITY.MAX_MISSING_RATE) {
        console.warn(
          `[market-data] ${symbol}: 欠損率 ${(missingRate * 100).toFixed(1)}% > ${DATA_QUALITY.MAX_MISSING_RATE * 100}% — データ品質不足`,
        );
      }
    }

    // 最低データ数チェック
    if (validBars.length < DATA_QUALITY.MIN_VALID_BARS) {
      console.warn(
        `[market-data] ${symbol}: 有効バー数 ${validBars.length} < ${DATA_QUALITY.MIN_VALID_BARS} — データ不足`,
      );
      return null;
    }

    // 異常値除外（前日比 ±50% 以上）
    const cleaned = removeAnomalies(validBars);

    // 新しい順にソート（テクニカル分析モジュールが期待する形式）
    cleaned.sort(
      (a, b) => dayjs(b.date).valueOf() - dayjs(a.date).valueOf(),
    );

    return cleaned;
  } catch (error) {
    console.error(
      `[market-data] Failed to fetch historical data for ${symbol}:`,
      error,
    );
    return null;
  }
}

/**
 * 前日比が異常に大きいバーを除外する
 * テクニカル指標の歪みを防ぐが、株式分割日は正常な価格変動なのでスキップする
 *
 * @param bars OHLCVバー
 * @param knownSplitDates 分割日のセット（"YYYY-MM-DD"形式）。該当日は除外しない
 */
function removeAnomalies(
  bars: OHLCVBar[],
  knownSplitDates?: Set<string>,
): OHLCVBar[] {
  if (bars.length < 2) return bars;

  // 日付昇順でソート（古い順）
  const sorted = [...bars].sort(
    (a, b) => dayjs(a.date).valueOf() - dayjs(b.date).valueOf(),
  );

  const result: OHLCVBar[] = [sorted[0]];
  for (let i = 1; i < sorted.length; i++) {
    const prevClose = sorted[i - 1].close;
    const currClose = sorted[i].close;
    const changePct = Math.abs(currClose - prevClose) / prevClose;

    if (changePct <= DATA_QUALITY.MAX_DAILY_CHANGE_PCT) {
      result.push(sorted[i]);
    } else if (knownSplitDates?.has(sorted[i].date)) {
      // 株式分割日: 正常な価格変動なので除外しない
      result.push(sorted[i]);
    } else {
      console.warn(
        `[market-data] 異常値除外: ${sorted[i].date} close=${currClose} (前日比 ${(changePct * 100).toFixed(1)}%)`,
      );
    }
  }

  return result;
}

// ========================================
// 市場指標データ取得
// ========================================

async function fetchIndexQuote(symbol: string): Promise<IndexQuote | null> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result: any = await retry(
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

// ========================================
// コーポレートイベントデータ取得
// ========================================

export interface CorporateEvents {
  nextEarningsDate: Date | null;
  exDividendDate: Date | null;
  dividendPerShare: number | null;
  lastSplitFactor: string | null;
  lastSplitDate: Date | null;
}

/**
 * 銘柄のコーポレートイベント情報を一括取得（quoteSummary API使用）
 *
 * 決算日・配当落ち日・株式分割情報を1回のAPI呼び出しで取得する。
 * 取得失敗時はnullを返す（即死ルール適用せず）。
 */
export async function fetchCorporateEvents(
  tickerCode: string,
): Promise<CorporateEvents> {
  const empty: CorporateEvents = {
    nextEarningsDate: null,
    exDividendDate: null,
    dividendPerShare: null,
    lastSplitFactor: null,
    lastSplitDate: null,
  };
  const symbol = normalizeTickerCode(tickerCode);
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result: any = await retry(
      () =>
        yahooFinance.quoteSummary(symbol, {
          modules: ["calendarEvents", "summaryDetail", "defaultKeyStatistics"],
        }),
      `corporate-events-${symbol}`,
    );

    // 決算日
    let nextEarningsDate: Date | null = null;
    const dates = result.calendarEvents?.earnings?.earningsDate;
    if (dates && dates.length > 0) {
      const now = new Date();
      const futureDates = dates.filter((d: Date) => d >= now);
      nextEarningsDate =
        futureDates.length > 0 ? futureDates[0] : dates[dates.length - 1];
    }

    // 配当落ち日
    const exDividendDate: Date | null =
      result.calendarEvents?.exDividendDate ??
      result.summaryDetail?.exDividendDate ??
      null;

    // 1株あたり配当金額（年間配当を2で割る: 日本株は通常年2回）
    const dividendRate = result.summaryDetail?.dividendRate ?? null;
    const dividendPerShare =
      dividendRate != null && Number.isFinite(dividendRate)
        ? Math.round((dividendRate / 2) * 100) / 100
        : null;

    // 株式分割
    const lastSplitFactor: string | null =
      result.defaultKeyStatistics?.lastSplitFactor ?? null;
    const lastSplitDateRaw = result.defaultKeyStatistics?.lastSplitDate ?? null;
    const lastSplitDate: Date | null =
      lastSplitDateRaw instanceof Date
        ? lastSplitDateRaw
        : typeof lastSplitDateRaw === "number"
          ? new Date(lastSplitDateRaw * 1000)
          : null;

    return {
      nextEarningsDate,
      exDividendDate,
      dividendPerShare,
      lastSplitFactor,
      lastSplitDate,
    };
  } catch {
    return empty;
  }
}

/**
 * @deprecated fetchCorporateEvents() を使用してください
 */
export async function fetchNextEarningsDate(
  tickerCode: string,
): Promise<Date | null> {
  const events = await fetchCorporateEvents(tickerCode);
  return events.nextEarningsDate;
}
