/**
 * マーケットデータプロバイダー（切り替え層）
 *
 * 環境変数 MARKET_DATA_PROVIDER で制御:
 * - "yfinance"   (デフォルト): yfinance のみ
 * - "tachibana"   : 立花APIのみ（失敗時はエラー）
 */

import {
  yfFetchQuote,
  yfFetchQuotesBatch,
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
import {
  tachibanaFetchQuote,
  tachibanaFetchQuotesBatch,
} from "./tachibana-price-client";

type ProviderMode = "yfinance" | "tachibana";

const PROVIDER_MODE: ProviderMode =
  (process.env.MARKET_DATA_PROVIDER as ProviderMode) || "yfinance";

// ========================================
// 公開 API
// ========================================

/**
 * 個別銘柄のクォートを取得
 */
export async function providerFetchQuote(symbol: string): Promise<YfQuoteResult> {
  if (PROVIDER_MODE === "tachibana") {
    return tachibanaFetchQuote(symbol);
  }

  return yfFetchQuote(symbol);
}

/**
 * 複数銘柄のクォートをバッチ取得
 */
export async function providerFetchQuotesBatch(
  symbols: string[],
): Promise<(YfQuoteResult | null)[]> {
  if (PROVIDER_MODE === "tachibana") {
    return tachibanaFetchQuotesBatch(symbols);
  }

  return yfFetchQuotesBatch(symbols);
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
