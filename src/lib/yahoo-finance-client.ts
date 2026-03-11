/**
 * Yahoo Finance クライアント管理
 *
 * YahooFinance インスタンスを共有し、crumb 失敗時にリセットする。
 * _getCrumb が失敗するとライブラリ内部で crumb がキャッシュされ、
 * 以降のリトライも同じ壊れた状態を使い続ける問題を解決する。
 */

import YahooFinance from "yahoo-finance2";
import { YAHOO_FINANCE } from "./constants";

const FETCH_TIMEOUT_MS = 30_000;

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

function createInstance(): YahooFinance {
  return new YahooFinance({
    suppressNotices: ["yahooSurvey"],
    fetchOptions: {
      headers: { "User-Agent": USER_AGENT },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    },
  });
}

let instance = createInstance();
let consecutiveFailures = 0;

/**
 * 共有 YahooFinance インスタンスを返す。
 *
 * crumb/fetch 失敗が連続した場合、インスタンスを再生成して
 * 内部キャッシュをクリアする。
 */
export function getYahooFinance(): YahooFinance {
  return instance;
}

/**
 * リクエスト成功時に呼ぶ。連続失敗カウンタをリセットする。
 */
export function markSuccess(): void {
  consecutiveFailures = 0;
}

/**
 * crumb/fetch エラー発生時に呼ぶ。
 * 連続失敗がしきい値を超えたらインスタンスを再生成する。
 */
export function markFailure(): void {
  consecutiveFailures++;
  if (consecutiveFailures >= YAHOO_FINANCE.RETRY_MAX_ATTEMPTS) {
    console.warn(
      `[yahoo-finance-client] ${consecutiveFailures}回連続失敗 — インスタンスを再生成します`,
    );
    instance = createInstance();
    consecutiveFailures = 0;
  }
}
