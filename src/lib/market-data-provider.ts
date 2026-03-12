/**
 * マーケットデータプロバイダー（ハイブリッド切り替え層）
 *
 * yfinance (Python) をプライマリ、yahoo-finance2 (Node.js) をフォールバックとして
 * 市場データを取得する。
 *
 * 環境変数 MARKET_DATA_PROVIDER で制御:
 * - "yfinance"      (デフォルト): yfinance → yahoo-finance2 フォールバック
 * - "yahoo"          : yahoo-finance2 のみ（従来動作、緊急切り戻し用）
 * - "yfinance_only"  : yfinance のみ（yahoo-finance2 削除後の最終形）
 */

import {
  yfFetchQuote,
  yfFetchQuotesBatch,
  yfFetchHistorical,
  yfFetchHistoricalRange,
  yfFetchMarket,
  yfFetchEvents,
  yfFetchNews,
  type YfQuoteResult,
  type YfOHLCVBar,
  type YfMarketData,
  type YfCorporateEvents,
  type YfNewsItem,
} from "./yfinance-client";
import { getYahooFinance } from "./yahoo-finance-client";
import { throttledYahooRequest } from "./yahoo-finance-throttle";
import { withRetry } from "./retry-utils";

type ProviderMode = "yfinance" | "yahoo" | "yfinance_only";

const PROVIDER_MODE: ProviderMode =
  (process.env.MARKET_DATA_PROVIDER as ProviderMode) || "yfinance";

// ========================================
// フォールバックヘルパー
// ========================================

/**
 * プライマリ → フォールバックの順で試行
 */
async function withFallback<T>(
  label: string,
  primaryFn: () => Promise<T>,
  fallbackFn: () => Promise<T>,
): Promise<T> {
  if (PROVIDER_MODE === "yahoo") {
    return fallbackFn();
  }

  try {
    const result = await primaryFn();
    return result;
  } catch (primaryError) {
    if (PROVIDER_MODE === "yfinance_only") {
      throw primaryError;
    }
    console.warn(
      `[market-data-provider] yfinance failed for ${label}, falling back to yahoo-finance2:`,
      primaryError instanceof Error ? primaryError.message : primaryError,
    );
    return fallbackFn();
  }
}

// ========================================
// yahoo-finance2 フォールバック実装
// ========================================

const retry = <T>(fn: () => Promise<T>, label: string) =>
  withRetry(fn, label, "market-data-provider");

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function yahooParseQuote(result: any, symbol: string): YfQuoteResult {
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
    per: result.trailingPE ?? null,
    pbr: result.priceToBook ?? null,
    eps: result.epsTrailingTwelveMonths ?? null,
    marketCap: result.marketCap ?? null,
  };
}

// ========================================
// 公開 API
// ========================================

/**
 * 個別銘柄のクォートを取得
 */
export async function providerFetchQuote(symbol: string): Promise<YfQuoteResult> {
  return withFallback(
    `quote:${symbol}`,
    () => yfFetchQuote(symbol),
    () =>
      retry(
        () =>
          throttledYahooRequest(async () => {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const result: any = await (await getYahooFinance()).quote(symbol);
            return yahooParseQuote(result, symbol);
          }),
        symbol,
      ),
  );
}

/**
 * 複数銘柄のクォートをバッチ取得
 */
export async function providerFetchQuotesBatch(
  symbols: string[],
): Promise<(YfQuoteResult | null)[]> {
  return withFallback(
    `quotes:batch[${symbols.length}]`,
    () => yfFetchQuotesBatch(symbols),
    async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const results: any[] = await retry(
        () =>
          throttledYahooRequest(async () =>
            (await getYahooFinance()).quote(symbols),
          ),
        `batch[${symbols.length}]`,
      );
      return results.map((result) => {
        const sym = result?.symbol as string;
        return sym ? yahooParseQuote(result, sym) : null;
      });
    },
  );
}

/**
 * ヒストリカル OHLCV データを取得（日数指定）
 */
export async function providerFetchHistorical(
  symbol: string,
  days: number,
): Promise<YfOHLCVBar[]> {
  return withFallback(
    `historical:${symbol}`,
    () => yfFetchHistorical(symbol, days),
    async () => {
      const dayjs = (await import("dayjs")).default;
      const period1 = dayjs().subtract(days, "day").toDate();
      const result = await retry(
        () =>
          throttledYahooRequest(async () =>
            (await getYahooFinance()).chart(symbol, {
              period1,
              period2: dayjs().toDate(),
              interval: "1d",
            }),
          ),
        symbol,
      );
      return result.quotes
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
    },
  );
}

/**
 * ヒストリカル OHLCV データを取得（期間指定、バックテスト用）
 */
export async function providerFetchHistoricalRange(
  symbol: string,
  start: string,
  end: string,
): Promise<YfOHLCVBar[]> {
  return withFallback(
    `historical-range:${symbol}`,
    () => yfFetchHistoricalRange(symbol, start, end),
    async () => {
      const dayjs = (await import("dayjs")).default;
      const result = await retry(
        () =>
          throttledYahooRequest(async () =>
            (await getYahooFinance()).chart(symbol, {
              period1: new Date(start),
              period2: new Date(end),
              interval: "1d",
            }),
          ),
        symbol,
      );
      return result.quotes
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
        }));
    },
  );
}

/**
 * 市場指標データを一括取得
 */
export async function providerFetchMarket(): Promise<YfMarketData> {
  return withFallback(
    "market",
    () => yfFetchMarket(),
    async () => {
      const symbols = {
        nikkei: "^N225",
        sp500: "^GSPC",
        vix: "^VIX",
        usdjpy: "JPY=X",
        cmeFutures: "NKD=F",
      } as const;

      type IndexKey = keyof typeof symbols;
      const result = {} as Record<IndexKey, YfMarketData[IndexKey]>;

      const entries = Object.entries(symbols) as [IndexKey, string][];
      await Promise.all(
        entries.map(async ([key, sym]) => {
          try {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const data: any = await retry(
              () =>
                throttledYahooRequest(async () =>
                  (await getYahooFinance()).quote(sym),
                ),
              sym,
            );
            result[key] = {
              price: data.regularMarketPrice ?? 0,
              previousClose: data.regularMarketPreviousClose ?? 0,
              change: data.regularMarketChange ?? 0,
              changePercent: data.regularMarketChangePercent ?? 0,
            };
          } catch {
            result[key] = null;
          }
        }),
      );

      return result as YfMarketData;
    },
  );
}

/**
 * コーポレートイベント情報を取得
 */
export async function providerFetchEvents(
  symbol: string,
): Promise<YfCorporateEvents> {
  const empty: YfCorporateEvents = {
    nextEarningsDate: null,
    exDividendDate: null,
    dividendPerShare: null,
    lastSplitFactor: null,
    lastSplitDate: null,
  };

  return withFallback(
    `events:${symbol}`,
    () => yfFetchEvents(symbol),
    async () => {
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const result: any = await retry(
          () =>
            throttledYahooRequest(async () =>
              (await getYahooFinance()).quoteSummary(symbol, {
                modules: [
                  "calendarEvents",
                  "summaryDetail",
                  "defaultKeyStatistics",
                ],
              }),
            ),
          `events-${symbol}`,
        );

        let nextEarningsDate: string | null = null;
        const dates = result.calendarEvents?.earnings?.earningsDate;
        if (dates && dates.length > 0) {
          const now = new Date();
          const futureDates = dates.filter((d: Date) => d >= now);
          const chosen =
            futureDates.length > 0 ? futureDates[0] : dates[dates.length - 1];
          nextEarningsDate = chosen instanceof Date ? chosen.toISOString() : null;
        }

        const exDivRaw =
          result.calendarEvents?.exDividendDate ??
          result.summaryDetail?.exDividendDate ??
          null;
        const exDividendDate =
          exDivRaw instanceof Date ? exDivRaw.toISOString() : null;

        const dividendRate = result.summaryDetail?.dividendRate ?? null;
        const dividendPerShare =
          dividendRate != null && Number.isFinite(dividendRate)
            ? Math.round((dividendRate / 2) * 100) / 100
            : null;

        const lastSplitFactor: string | null =
          result.defaultKeyStatistics?.lastSplitFactor ?? null;
        const lsdRaw = result.defaultKeyStatistics?.lastSplitDate ?? null;
        let lastSplitDate: string | null = null;
        if (lsdRaw instanceof Date) {
          lastSplitDate = lsdRaw.toISOString();
        } else if (typeof lsdRaw === "number") {
          lastSplitDate = new Date(lsdRaw * 1000).toISOString();
        }

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
    },
  );
}

/**
 * ニュース検索
 */
export async function providerFetchNews(
  query: string,
  newsCount: number,
): Promise<YfNewsItem[]> {
  return withFallback(
    `search:${query}`,
    () => yfFetchNews(query, newsCount),
    async () => {
      const result = await throttledYahooRequest(async () =>
        (await getYahooFinance()).search(query, { newsCount }),
      );

      if (!result.news || result.news.length === 0) return [];

      return result.news
        .filter((n) => n.title && n.link)
        .map((n) => ({
          title: n.title,
          link: n.link,
          providerPublishTime: n.providerPublishTime
            ? new Date(n.providerPublishTime).toISOString()
            : null,
        }));
    },
  );
}
