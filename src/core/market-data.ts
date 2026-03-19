/**
 * 市場データ取得モジュール
 *
 * market-data-provider を使用して株価・市場指標データを取得する。
 * プライマリ: yfinance (Python sidecar)
 * フォールバック: yahoo-finance2 (Node.js)
 */

import dayjs from "dayjs";

import { prisma } from "../lib/prisma";
import { normalizeTickerCode } from "../lib/ticker-utils";
import { DATA_QUALITY, YAHOO_FINANCE } from "../lib/constants";
import { sleep } from "../lib/retry-utils";
import {
  providerFetchQuote,
  providerFetchQuotesBatch,
  providerFetchHistorical,
  providerFetchHistoricalBatch,
  providerFetchMarket,
  providerFetchEvents,
} from "../lib/market-data-provider";

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
  nasdaq: IndexQuote | null;
  dow: IndexQuote | null;
  sox: IndexQuote | null;
  vix: IndexQuote | null;
  usdjpy: IndexQuote | null;
  cmeFutures: IndexQuote | null;
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
    const result = await providerFetchQuote(symbol);
    return result as StockQuote;
  } catch (error) {
    console.error(`[market-data] Failed to fetch quote for ${symbol}:`, error);
    return null;
  }
}

/**
 * 複数銘柄のクォートをバッチ取得（1リクエストで複数銘柄）
 */
export async function fetchStockQuotesBatch(
  tickerCodes: string[],
): Promise<Map<string, StockQuote>> {
  const results = new Map<string, StockQuote>();
  const symbols = tickerCodes.map(normalizeTickerCode);

  for (let i = 0; i < symbols.length; i += YAHOO_FINANCE.BATCH_SIZE) {
    const batch = symbols.slice(i, i + YAHOO_FINANCE.BATCH_SIZE);

    try {
      const batchResults = await providerFetchQuotesBatch(batch);

      for (const result of batchResults) {
        if (result && result.tickerCode) {
          results.set(result.tickerCode, result as StockQuote);
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
          const result = await providerFetchQuote(symbol);
          results.set(result.tickerCode, result as StockQuote);
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
 * 過去のOHLCVデータを取得（テクニカル分析用）
 * @returns OHLCVデータ配列（新しい順 = newest-first）
 */
export async function fetchHistoricalData(
  tickerCode: string,
): Promise<OHLCVBar[] | null> {
  const symbol = normalizeTickerCode(tickerCode);

  try {
    const bars = await providerFetchHistorical(symbol, YAHOO_FINANCE.HISTORICAL_DAYS);

    const totalBars = bars.length;

    // 有効なバーのみ残す（provider 側でフィルタ済みだが念のため）
    const validBars = bars.filter(
      (bar) =>
        bar.open != null &&
        bar.high != null &&
        bar.low != null &&
        bar.close != null &&
        bar.close > 0,
    );

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

const DOWNLOAD_BATCH_SIZE = 200;

/**
 * 複数銘柄のヒストリカルデータをバッチ一括取得
 * yf.download で一括DLし、fetchHistoricalData と同じ後処理を適用する。
 * バッチ失敗時は fetchHistoricalData で個別フォールバック。
 */
export async function fetchHistoricalDataBatch(
  tickerCodes: string[],
): Promise<Map<string, OHLCVBar[]>> {
  const results = new Map<string, OHLCVBar[]>();
  const start = dayjs().subtract(YAHOO_FINANCE.HISTORICAL_DAYS, "day").format("YYYY-MM-DD");
  const end = dayjs().add(1, "day").format("YYYY-MM-DD");

  for (let i = 0; i < tickerCodes.length; i += DOWNLOAD_BATCH_SIZE) {
    const batchTickers = tickerCodes.slice(i, i + DOWNLOAD_BATCH_SIZE);
    const batchSymbols = batchTickers.map(normalizeTickerCode);
    const batchIndex = Math.floor(i / DOWNLOAD_BATCH_SIZE) + 1;
    const totalBatches = Math.ceil(tickerCodes.length / DOWNLOAD_BATCH_SIZE);
    const batchStart = Date.now();

    try {
      const batchResult = await providerFetchHistoricalBatch(batchSymbols, start, end);

      for (let j = 0; j < batchTickers.length; j++) {
        const ticker = batchTickers[j];
        const symbol = batchSymbols[j];
        const bars = batchResult[symbol];
        if (!bars || bars.length === 0) continue;

        const validBars = bars.filter(
          (bar) => bar.open != null && bar.high != null && bar.low != null && bar.close != null && bar.close > 0,
        );

        if (validBars.length < DATA_QUALITY.MIN_VALID_BARS) continue;

        const cleaned = removeAnomalies(
          validBars.map((bar) => ({
            date: bar.date,
            open: bar.open,
            high: bar.high,
            low: bar.low,
            close: bar.close,
            volume: bar.volume ?? 0,
          })),
        );

        cleaned.sort((a, b) => dayjs(b.date).valueOf() - dayjs(a.date).valueOf());
        results.set(ticker, cleaned);
      }

      const elapsed = ((Date.now() - batchStart) / 1000).toFixed(1);
      console.log(
        `  [DL ${batchIndex}/${totalBatches}] ${Math.min(i + DOWNLOAD_BATCH_SIZE, tickerCodes.length)}/${tickerCodes.length}銘柄取得完了（${elapsed}s）`,
      );
    } catch (error) {
      console.error(`  [DL ${batchIndex}/${totalBatches}] バッチ取得失敗、個別フォールバック:`, error);
      for (const ticker of batchTickers) {
        try {
          const data = await fetchHistoricalData(ticker);
          if (data) results.set(ticker, data);
        } catch {
          // fetchHistoricalData 内部でエラーログ済み
        }
      }
    }
  }

  return results;
}

// ========================================
// DBからヒストリカルデータ読み取り
// ========================================

/**
 * DBに保存済みのOHLCV日足を一括読み取り
 * backfill-prices で事前保存されたデータを使用する。
 * @returns Map<tickerCode, OHLCVBar[]> (newest-first)
 */
export async function readHistoricalFromDB(
  tickerCodes: string[],
  days: number = YAHOO_FINANCE.HISTORICAL_DAYS,
): Promise<Map<string, OHLCVBar[]>> {
  const results = new Map<string, OHLCVBar[]>();
  if (tickerCodes.length === 0) return results;

  const cutoffDate = dayjs().subtract(days, "day").toDate();

  const rows = await prisma.stockDailyBar.findMany({
    where: {
      tickerCode: { in: tickerCodes },
      date: { gte: cutoffDate },
    },
    orderBy: { date: "desc" },
    select: {
      tickerCode: true,
      date: true,
      open: true,
      high: true,
      low: true,
      close: true,
      volume: true,
    },
  });

  for (const row of rows) {
    const bar: OHLCVBar = {
      date: dayjs(row.date).format("YYYY-MM-DD"),
      open: row.open,
      high: row.high,
      low: row.low,
      close: row.close,
      volume: Number(row.volume),
    };

    const existing = results.get(row.tickerCode);
    if (existing) {
      existing.push(bar);
    } else {
      results.set(row.tickerCode, [bar]);
    }
  }

  return results;
}

/**
 * 前日比が異常に大きいバーを除外する
 * テクニカル指標の歪みを防ぐが、株式分割日は正常な価格変動なのでスキップする
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

/**
 * 市場指標データを一括取得
 */
export async function fetchMarketData(): Promise<MarketData> {
  try {
    return await providerFetchMarket();
  } catch (error) {
    console.error("[market-data] Failed to fetch market data:", error);
    return {
      nikkei: null,
      sp500: null,
      nasdaq: null,
      dow: null,
      sox: null,
      vix: null,
      usdjpy: null,
      cmeFutures: null,
    };
  }
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
 * 銘柄のコーポレートイベント情報を一括取得
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
    const result = await providerFetchEvents(symbol);
    return {
      nextEarningsDate: result.nextEarningsDate
        ? new Date(result.nextEarningsDate)
        : null,
      exDividendDate: result.exDividendDate
        ? new Date(result.exDividendDate)
        : null,
      dividendPerShare: result.dividendPerShare,
      lastSplitFactor: result.lastSplitFactor,
      lastSplitDate: result.lastSplitDate
        ? new Date(result.lastSplitDate)
        : null,
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
