/**
 * マーケットデータプロバイダー
 *
 * - リアルタイムクォート: 立花証券API（20並列、高速）
 * - ヒストリカル・市場指標・ニュース等: yfinance
 */

import {
  tachibanaFetchQuote,
  tachibanaFetchQuotesBatch,
} from "./tachibana-price-client";
import {
  yfFetchHistorical,
  yfFetchHistoricalRange,
  yfFetchHistoricalBatch,
  yfFetchMarket,
  yfFetchEvents,
  yfFetchNews,
  type YfQuoteResult,
  type YfOHLCVBar,
  type YfMarketData,
  type YfCorporateEvents,
  type YfNewsItem,
} from "./yfinance-client";

// ========================================
// 公開 API
// ========================================

/**
 * 個別銘柄のクォートを取得（立花証券API）
 */
export async function providerFetchQuote(symbol: string): Promise<YfQuoteResult> {
  return tachibanaFetchQuote(symbol);
}

/**
 * 複数銘柄のクォートをバッチ取得（立花証券API、20並列）
 */
export async function providerFetchQuotesBatch(
  symbols: string[],
): Promise<(YfQuoteResult | null)[]> {
  return tachibanaFetchQuotesBatch(symbols);
}

/**
 * ヒストリカル OHLCV データを取得（日数指定）
 */
export async function providerFetchHistorical(
  symbol: string,
  days: number,
): Promise<YfOHLCVBar[]> {
  return yfFetchHistorical(symbol, days);
}

/**
 * ヒストリカル OHLCV データを取得（期間指定、バックテスト用）
 */
export async function providerFetchHistoricalRange(
  symbol: string,
  start: string,
  end: string,
): Promise<YfOHLCVBar[]> {
  return yfFetchHistoricalRange(symbol, start, end);
}

/**
 * 複数銘柄のヒストリカルデータをバッチ取得（yf.download 一括）
 */
export async function providerFetchHistoricalBatch(
  symbols: string[],
  start: string,
  end: string,
): Promise<Record<string, YfOHLCVBar[]>> {
  return yfFetchHistoricalBatch(symbols, start, end);
}

/**
 * 市場指標データを一括取得
 */
export async function providerFetchMarket(): Promise<YfMarketData> {
  return yfFetchMarket();
}

/**
 * コーポレートイベント情報を取得
 */
export async function providerFetchEvents(
  symbol: string,
): Promise<YfCorporateEvents> {
  return yfFetchEvents(symbol);
}

/**
 * ニュース検索
 */
export async function providerFetchNews(
  query: string,
  newsCount: number,
): Promise<YfNewsItem[]> {
  return yfFetchNews(query, newsCount);
}
