/**
 * Yahoo Finance スロットルキュー
 *
 * 全てのYahoo Finance APIリクエストをこのキューを通して実行することで、
 * レートリミット（429）を回避する。
 *
 * - 同時実行数: 1（直列実行）
 * - リクエスト間ディレイ: 1〜2秒（Jitter付き）
 */

import pLimit from "p-limit";
import { YAHOO_FINANCE } from "./constants";

const queue = pLimit(YAHOO_FINANCE.THROTTLE_CONCURRENCY);

function jitterDelay(): Promise<void> {
  const delay =
    YAHOO_FINANCE.THROTTLE_MIN_DELAY_MS +
    Math.random() *
      (YAHOO_FINANCE.THROTTLE_MAX_DELAY_MS -
        YAHOO_FINANCE.THROTTLE_MIN_DELAY_MS);
  return new Promise((resolve) => setTimeout(resolve, delay));
}

/**
 * Yahoo Finance APIリクエストをスロットルキュー経由で実行する
 *
 * 同時に1リクエストのみ実行し、各リクエスト後に1〜2秒のランダム待機を入れる。
 * 呼び出し元のp-limitと共存可能（呼び出し元はタスクの論理的な並列度を制御し、
 * このキューが実際のHTTPリクエストの発行レートを制御する）。
 */
export function throttledYahooRequest<T>(fn: () => Promise<T>): Promise<T> {
  return queue(async () => {
    const result = await fn();
    await jitterDelay();
    return result;
  });
}
