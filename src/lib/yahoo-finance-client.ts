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
const COOLDOWN_AFTER_RECREATE_MS = 5_000;

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

/**
 * リクエストごとに新しい AbortSignal.timeout を付与するカスタム fetch。
 *
 * AbortSignal.timeout() はインスタンス作成時にタイマーが開始されるため、
 * fetchOptions.signal に固定で渡すと、インスタンス作成から30秒後に
 * すべてのリクエストが即座に TimeoutError になる致命的なバグがあった。
 *
 * ヘッダーは fetchOptions.headers でライブラリに任せ、ここでは signal のみ付与する。
 */
function fetchWithTimeout(
  input: Parameters<typeof fetch>[0],
  init?: Parameters<typeof fetch>[1],
): Promise<Response> {
  return fetch(input, {
    ...init,
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
}

function createInstance(): InstanceType<typeof YahooFinance> {
  return new YahooFinance({
    suppressNotices: ["yahooSurvey"],
    fetch: fetchWithTimeout,
    fetchOptions: {
      headers: { "User-Agent": USER_AGENT },
    },
  });
}

let instance = createInstance();
let consecutiveFailures = 0;
/** インスタンス再生成後にクールダウン中なら resolve を待つ Promise */
let cooldownPromise: Promise<void> | null = null;

/**
 * 共有 YahooFinance インスタンスを返す。
 *
 * crumb/fetch 失敗が連続した場合、インスタンスを再生成して
 * 内部キャッシュをクリアする。
 * 再生成直後はクールダウン期間を設けて _getCrumb の即時再失敗を防ぐ。
 */
export async function getYahooFinance(): Promise<InstanceType<typeof YahooFinance>> {
  if (cooldownPromise) {
    await cooldownPromise;
  }
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
 * 連続失敗がしきい値を超えたらインスタンスを再生成し、
 * クールダウン期間を設ける。
 */
export function markFailure(): void {
  consecutiveFailures++;
  if (consecutiveFailures >= YAHOO_FINANCE.RETRY_MAX_ATTEMPTS) {
    console.warn(
      `[yahoo-finance-client] ${consecutiveFailures}回連続失敗 — インスタンスを再生成します（${COOLDOWN_AFTER_RECREATE_MS}ms クールダウン）`,
    );
    instance = createInstance();
    consecutiveFailures = 0;
    cooldownPromise = new Promise((resolve) =>
      setTimeout(() => {
        cooldownPromise = null;
        resolve();
      }, COOLDOWN_AFTER_RECREATE_MS),
    );
  }
}
