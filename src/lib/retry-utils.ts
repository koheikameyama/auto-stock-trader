/**
 * リトライユーティリティ
 *
 * ネットワークエラー・レートリミット時の指数バックオフリトライ
 */

import { YAHOO_FINANCE } from "./constants";
import { markFailure, markSuccess } from "./yahoo-finance-client";

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** ネットワーク系のエラーコード */
const RETRYABLE_NETWORK_CODES = [
  "ETIMEDOUT",
  "ECONNRESET",
  "ECONNREFUSED",
  "ENETUNREACH",
  "EAI_AGAIN",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_SOCKET",
] as const;

/**
 * リトライ可能なエラーか判定（429 + ネットワークエラー + タイムアウト）
 */
export function isRetryableError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const msg = error.message;
  // 429 Rate Limit
  if (msg.includes("Too Many Requests") || msg.includes("429")) return true;
  // fetch failed（crumb取得含む）
  if (msg.includes("fetch failed")) return true;
  // AbortError（タイムアウト）
  if (error.name === "TimeoutError" || error.name === "AbortError") return true;
  // ネットワークエラー
  if (RETRYABLE_NETWORK_CODES.some((code) => msg.includes(code))) return true;
  // cause チェーン（undici のネストされたエラー）
  const cause = (error as { cause?: { code?: string; message?: string } }).cause;
  if (cause) {
    if (RETRYABLE_NETWORK_CODES.some((code) => cause.code === code)) return true;
    if (cause.message && RETRYABLE_NETWORK_CODES.some((code) => cause.message!.includes(code))) return true;
  }
  return false;
}

/**
 * リトライ可能エラー時に指数バックオフでリトライ
 *
 * crumb/fetch 失敗時は YahooFinance インスタンスのリセットも行う。
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  label: string,
  prefix = "",
): Promise<T> {
  for (let attempt = 0; attempt < YAHOO_FINANCE.RETRY_MAX_ATTEMPTS; attempt++) {
    try {
      const result = await fn();
      markSuccess();
      return result;
    } catch (error: unknown) {
      markFailure();
      if (
        !isRetryableError(error) ||
        attempt >= YAHOO_FINANCE.RETRY_MAX_ATTEMPTS - 1
      ) {
        throw error;
      }
      const delay = YAHOO_FINANCE.RETRY_BASE_DELAY_MS * 2 ** attempt;
      const errCode =
        error instanceof Error ? error.message.slice(0, 40) : "unknown";
      const tag = prefix ? `[${prefix}]` : "";
      console.warn(
        `${tag} ${label}: リトライ ${attempt + 1}/${YAHOO_FINANCE.RETRY_MAX_ATTEMPTS} after ${delay}ms [${errCode}]`,
      );
      await sleep(delay);
    }
  }
  throw new Error("unreachable");
}
