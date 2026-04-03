/**
 * 立花証券 時価データクライアント
 *
 * CLMMfdsGetMarketPrice を使って日本株のリアルタイム時価を取得する。
 * レスポンスを YfQuoteResult 形式に変換し、既存のプロバイダー層と互換性を保つ。
 */

import { getTachibanaClient } from "../core/broker-client";
import { tickerToBrokerCode, brokerCodeToTicker } from "./ticker-utils";
import {
  TACHIBANA_CLMID,
  TACHIBANA_QUOTE_COLUMNS,
  TACHIBANA_ORDER,
} from "./constants/broker";
import type { YfQuoteResult } from "./yfinance-client";

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
  pAskPrice?: string;
  pBidPrice?: string;
  pAskSize?: string;
  pBidSize?: string;
  [key: string]: unknown;
}

/**
 * 立花APIから個別銘柄のクォートを取得
 */
export async function tachibanaFetchQuote(
  symbol: string,
): Promise<YfQuoteResult> {
  const client = getTachibanaClient();
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

const PRICE_CONCURRENCY = 10;

/**
 * 立花APIから複数銘柄のクォートをバッチ取得
 *
 * CLMMfdsGetMarketPrice は1銘柄ずつしか取得できないため、
 * p-limit で同時10件に制限しつつ並列呼び出しする。
 * requestPrice はミューテックス不使用のため並列実行可能。
 * セッション切断時は reLoginOnce で1回だけ再ログインし全スロットで共有する。
 */
export async function tachibanaFetchQuotesBatch(
  symbols: string[],
): Promise<(YfQuoteResult | null)[]> {
  const pLimit = (await import("p-limit")).default;
  const limit = pLimit(PRICE_CONCURRENCY);
  const errors: string[] = [];
  const results: (YfQuoteResult | null)[] = new Array(symbols.length).fill(null);

  const tasks = symbols.map((symbol, i) =>
    limit(async () => {
      try {
        results[i] = await tachibanaFetchQuote(symbol);
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        console.warn(`[tachibana-price] Batch: failed for ${symbol}:`, msg);
        errors.push(`${symbol}: ${msg}`);
      }
    }),
  );

  await Promise.all(tasks);

  // 全銘柄失敗 → throw して上位（worker.ts runJob）で通知させる
  if (symbols.length > 0 && errors.length === symbols.length) {
    throw new Error(
      `[tachibana-price] 全${errors.length}銘柄の時価取得に失敗\n${errors.slice(0, 5).join("\n")}${errors.length > 5 ? `\n...他${errors.length - 5}件` : ""}`,
    );
  }

  return results;
}

/**
 * 立花APIの時価レスポンスを YfQuoteResult に変換
 */
function parsePriceData(data: PriceData, symbol: string): YfQuoteResult {
  const ticker = brokerCodeToTicker(data.sTargetIssueCode || tickerToBrokerCode(symbol));
  const price = toNumber(data.pCurrentPrice);
  const previousClose = toNumber(data.pPreviousClose);

  const askPrice = data.pAskPrice ? toNumber(data.pAskPrice) : undefined;
  const bidPrice = data.pBidPrice ? toNumber(data.pBidPrice) : undefined;
  const askSize = data.pAskSize ? toNumber(data.pAskSize) : undefined;
  const bidSize = data.pBidSize ? toNumber(data.pBidSize) : undefined;

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
    // 板情報（0は「取得なし」として除外）
    ...(askPrice && askPrice > 0 ? { askPrice } : {}),
    ...(bidPrice && bidPrice > 0 ? { bidPrice } : {}),
    ...(askSize && askSize > 0 ? { askSize } : {}),
    ...(bidSize && bidSize > 0 ? { bidSize } : {}),
  };
}

function toNumber(value: string | undefined | null): number {
  if (value == null || value === "") return 0;
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}
