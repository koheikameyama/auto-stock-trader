/**
 * ユーティリティ
 */

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Prisma の「一時的な」DB接続系エラーかを判定する。
 *
 * 長時間バッチ（backfill / combined BT のフルスキャン等）では、Railway Postgres が
 * 実行の途中で接続を切ることがあり `P1017 "Server has closed the connection"` で落ちる。
 * これらはコードの不具合ではなく再試行で回復する。次クエリで Prisma が自動再接続する。
 */
export function isTransientDbError(err: unknown): boolean {
  const code = (err as { code?: unknown })?.code;
  if (
    typeof code === "string" &&
    ["P1001", "P1002", "P1008", "P1017", "P2024"].includes(code)
  ) {
    return true;
  }
  const msg = err instanceof Error ? err.message : String(err);
  return (
    msg.includes("Server has closed the connection") ||
    msg.includes("Can't reach database server") ||
    msg.includes("ECONNREFUSED") ||
    msg.includes("ETIMEDOUT") ||
    msg.includes("Connection terminated") ||
    msg.includes("Connection reset")
  );
}

/**
 * DB一時障害向けの汎用リトライ（接続不可・サーバ切断・タイムアウトのみ対象）。
 *
 * `isTransientDbError` に該当するエラーのみ指数バックオフで再試行し、それ以外は即座に
 * 再送出する（本物のバグを握り潰さない）。`fn` は再試行で複数回実行されるため、
 * **冪等な処理のみ**を渡すこと（読み取り、または同値を書くべき更新など）。
 */
export async function withDbRetry<T>(
  fn: () => Promise<T>,
  label = "db",
  opts: { maxAttempts?: number; baseDelayMs?: number } = {},
): Promise<T> {
  const maxAttempts = opts.maxAttempts ?? 3;
  const baseDelayMs = opts.baseDelayMs ?? 1000;
  let lastErr: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (!isTransientDbError(err) || attempt === maxAttempts) throw err;
      const delay = baseDelayMs * 2 ** (attempt - 1);
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(
        `[db-retry] DB一時障害 (${label}, attempt ${attempt}/${maxAttempts}): ${msg} → ${delay}ms後に再試行`,
      );
      await sleep(delay);
    }
  }
  throw lastErr;
}
