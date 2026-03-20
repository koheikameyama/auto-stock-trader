/**
 * 立花証券 時価データクライアント
 *
 * CLMMfdsGetMarketPrice を使って日本株のリアルタイム時価を取得する。
 * レスポンスを YfQuoteResult 形式に変換し、既存のプロバイダー層と互換性を保つ。
 */

import pLimit from "p-limit";
import { getTachibanaClient } from "../core/broker-client";
import { tickerToBrokerCode, brokerCodeToTicker } from "./ticker-utils";
import {
  TACHIBANA_CLMID,
  TACHIBANA_QUOTE_COLUMNS,
  TACHIBANA_ORDER,
} from "./constants/broker";
import type { YfQuoteResult } from "./yfinance-client";

const CONCURRENCY = 5;
const limit = pLimit(CONCURRENCY);

interface PriceData {
  pCurrentPrice: string;
  pOpenPrice: string;
  pHighPrice: string;
  pLowPrice: string;
  pPreviousClose: string;
  pVolume: string;
  pChange: string;
  pChangePercent: string;
  sTargetIssueCode: string;
  [key: string]: unknown;
}

/**
 * 立花APIから個別銘柄のクォートを取得
 */
export async function tachibanaFetchQuote(
  symbol: string,
): Promise<YfQuoteResult> {
  const client = getTachibanaClient();
  if (!client.isLoggedIn()) {
    throw new Error("[tachibana-price] Not logged in");
  }

  const brokerCode = tickerToBrokerCode(symbol);

  const res = await client.requestPrice({
    sCLMID: TACHIBANA_CLMID.MARKET_PRICE,
    sTargetIssueCode: brokerCode,
    sTargetSizyouC: TACHIBANA_ORDER.EXCHANGE.TSE,
    sTargetColumn: TACHIBANA_QUOTE_COLUMNS,
  });

  if (res.sResultCode !== "0") {
    throw new Error(
      `[tachibana-price] ${symbol}: [${res.sResultCode}] ${res.sResultText ?? "Unknown error"}`,
    );
  }

  const list = res.aMarketPriceList as PriceData[] | undefined;
  if (!list || list.length === 0) {
    throw new Error(`[tachibana-price] ${symbol}: No data returned`);
  }

  return parsePriceData(list[0], symbol);
}

/**
 * 立花APIから複数銘柄のクォートをバッチ取得
 *
 * CLMMfdsGetMarketPrice は1銘柄ずつしか取得できないため、
 * p-limit で並行度を制御しつつ並列呼び出しする。
 */
export async function tachibanaFetchQuotesBatch(
  symbols: string[],
): Promise<(YfQuoteResult | null)[]> {
  const tasks = symbols.map((symbol) =>
    limit(async (): Promise<YfQuoteResult | null> => {
      try {
        return await tachibanaFetchQuote(symbol);
      } catch (error) {
        console.warn(
          `[tachibana-price] Batch: failed for ${symbol}:`,
          error instanceof Error ? error.message : error,
        );
        return null;
      }
    }),
  );

  return Promise.all(tasks);
}

/**
 * 立花APIの時価レスポンスを YfQuoteResult に変換
 */
function parsePriceData(data: PriceData, symbol: string): YfQuoteResult {
  const ticker = brokerCodeToTicker(data.sTargetIssueCode || tickerToBrokerCode(symbol));
  const price = toNumber(data.pCurrentPrice);
  const previousClose = toNumber(data.pPreviousClose);

  return {
    tickerCode: ticker,
    price,
    previousClose,
    change: toNumber(data.pChange),
    changePercent: toNumber(data.pChangePercent),
    volume: toNumber(data.pVolume),
    high: toNumber(data.pHighPrice),
    low: toNumber(data.pLowPrice),
    open: toNumber(data.pOpenPrice),
    // ファンダメンタルズは立花APIでは取得不可
    per: null,
    pbr: null,
    eps: null,
    marketCap: null,
  };
}

function toNumber(value: string | undefined | null): number {
  if (value == null || value === "") return 0;
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}
