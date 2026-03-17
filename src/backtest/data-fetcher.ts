/**
 * バックテスト用ヒストリカルデータ取得
 *
 * market-data-provider を経由して指定期間の OHLCV データを取得する。
 * oldest-first（時系列順）で返す。
 */

import dayjs from "dayjs";
import type { OHLCVData } from "../core/technical-analysis";
import { normalizeTickerCode } from "../lib/ticker-utils";
import { DATA_QUALITY } from "../lib/constants";
import {
  providerFetchHistoricalRange,
  providerFetchHistoricalBatch,
} from "../lib/market-data-provider";

const LOOKBACK_CALENDAR_DAYS = 120;
const DOWNLOAD_BATCH_SIZE = 200;

/**
 * 前日比が異常に大きいバーを除外（株式分割誤データ等を排除）
 * market-data.ts の removeAnomalies と同等ロジック。
 * DATA_QUALITY.MAX_DAILY_CHANGE_PCT (±50%) を閾値として使用。
 */
function removeAnomalousData(bars: OHLCVData[]): OHLCVData[] {
  if (bars.length < 2) return bars;

  const result: OHLCVData[] = [bars[0]];
  let removedCount = 0;
  for (let i = 1; i < bars.length; i++) {
    const lastKeptClose = result[result.length - 1].close;
    const currClose = bars[i].close;
    if (lastKeptClose > 0) {
      const changePct = Math.abs(currClose - lastKeptClose) / lastKeptClose;
      if (changePct > DATA_QUALITY.MAX_DAILY_CHANGE_PCT) {
        removedCount++;
        continue;
      }
    }
    result.push(bars[i]);
  }
  if (removedCount > 0) {
    console.log(`[backtest] 異常バー除外: ${removedCount}件`);
  }
  return result;
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
  const adjustedStart = dayjs(startDate)
    .subtract(LOOKBACK_CALENDAR_DAYS, "day")
    .format("YYYY-MM-DD");
  const adjustedEnd = dayjs(endDate).add(1, "day").format("YYYY-MM-DD");

  const bars = await providerFetchHistoricalRange(
    symbol,
    adjustedStart,
    adjustedEnd,
  );

  const cleaned = bars
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

  return removeAnomalousData(cleaned);
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
 * 複数銘柄のヒストリカルデータを一括取得（yf.download バッチ）
 */
export async function fetchMultipleBacktestData(
  tickers: string[],
  startDate: string,
  endDate: string,
  lookbackCalendarDays?: number,
): Promise<Map<string, OHLCVData[]>> {
  const results = new Map<string, OHLCVData[]>();
  const symbols = tickers.map(normalizeTickerCode);
  const lookback = lookbackCalendarDays ?? LOOKBACK_CALENDAR_DAYS;

  const adjustedStart = dayjs(startDate)
    .subtract(lookback, "day")
    .format("YYYY-MM-DD");
  const adjustedEnd = dayjs(endDate).add(1, "day").format("YYYY-MM-DD");

  console.log(`[backtest] ${tickers.length}銘柄のデータを yf.download バッチ取得中...`);

  // バッチごとに分割して取得（大量銘柄のタイムアウト防止）
  for (let batchStart = 0; batchStart < symbols.length; batchStart += DOWNLOAD_BATCH_SIZE) {
    const batchSymbols = symbols.slice(batchStart, batchStart + DOWNLOAD_BATCH_SIZE);
    const batchTickers = tickers.slice(batchStart, batchStart + DOWNLOAD_BATCH_SIZE);

    if (symbols.length > DOWNLOAD_BATCH_SIZE) {
      console.log(
        `  バッチ ${Math.floor(batchStart / DOWNLOAD_BATCH_SIZE) + 1}/${Math.ceil(symbols.length / DOWNLOAD_BATCH_SIZE)}: ${batchSymbols.length}銘柄`,
      );
    }

    try {
      const batchResult = await providerFetchHistoricalBatch(
        batchSymbols,
        adjustedStart,
        adjustedEnd,
      );

      for (let i = 0; i < batchTickers.length; i++) {
        const ticker = batchTickers[i];
        const symbol = batchSymbols[i];
        const bars = batchResult[symbol];
        if (bars && bars.length > 0) {
          const sorted = bars
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
          const data = removeAnomalousData(sorted);
          if (data.length > 0) {
            results.set(ticker, data);
          }
        }
      }
    } catch (error) {
      console.error(`[backtest] バッチ取得失敗、個別取得にフォールバック:`, error);
      for (const ticker of batchTickers) {
        try {
          const data = await fetchBacktestData(ticker, startDate, endDate);
          if (data.length > 0) {
            results.set(ticker, data);
          }
        } catch (e) {
          console.error(`  ${ticker}: 取得失敗`, e);
        }
      }
    }
  }

  console.log(`[backtest] データ取得完了: ${results.size}/${tickers.length}銘柄`);
  return results;
}
