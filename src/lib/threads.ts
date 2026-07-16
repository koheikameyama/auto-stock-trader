/**
 * Threads (Meta) 投稿ユーティリティ
 *
 * 自動売買システムの日次ログ / 朝の相場局面を Threads に公開投稿する。
 * lib/bluesky と同様、環境変数が未設定なら no-op（警告のみ）で失敗させない。
 *
 * 認証は Bluesky の App Password と違い「長期アクセストークン」方式（Threads Graph API）。
 *   - THREADS_USER_TOKEN  長期アクセストークン（約60日・更新可）。Meta の Threads アプリで発行
 *   - THREADS_USER_ID     省略時 "me"（トークン所有者に解決される Graph API エイリアス）
 *
 * 投稿は2段階（Threads Graph API の仕様）:
 *   1. メディアコンテナ作成 (media_type=TEXT) → creation_id を得る
 *   2. creation_id を publish して確定
 */

const THREADS_USER_TOKEN = process.env.THREADS_USER_TOKEN;
const THREADS_USER_ID = process.env.THREADS_USER_ID ?? "me";
const THREADS_API_BASE = "https://graph.threads.net/v1.0";

/** Threads の1投稿あたり最大文字数 */
const MAX_POST_CHARS = 500;

/**
 * リトライ設定。2段階のどちらも Meta 側の間欠エラーで落ちる実績がある:
 *   - publish: container のサーバー側処理完了前に叩くと `The requested resource
 *     does not exist` が返る（Meta 公式も publish 前の待機を推奨）
 *   - container 作成: `An unknown error occurred`（code 1）が突発的に返る
 * どちらも待機 + 指数バックオフで吸収する。
 */
const MAX_ATTEMPTS = 4;
const BACKOFF_MS = 5_000;
/** container 作成から publish までの待機。メディア処理の完了を待つ */
const PUBLISH_INITIAL_WAIT_MS = 5_000;

/**
 * リトライしても回復しない Meta のエラーコード。
 * これ以外は一時エラーとみなしてリトライする（許可リスト方式だと
 * `An unknown error occurred` のような想定外の文言を取りこぼすため）。
 */
const PERMANENT_ERROR_CODES = new Set([
  100, // 不正なパラメータ（本文が長すぎる等）
  190, // アクセストークン失効・無効
  368, // 一時的にブロックされた操作
]);

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

interface ThreadsApiResponse {
  id?: string;
  error?: { message?: string; type?: string; code?: number };
}

/** code はリトライ可否の判定に使う。type はメッセージに載せて切り分けの手掛かりにする */
class ThreadsApiError extends Error {
  constructor(
    path: string,
    message: string,
    readonly code?: number,
    type?: string,
  ) {
    const detail = [code !== undefined ? `code ${code}` : null, type]
      .filter(Boolean)
      .join("/");
    super(
      `Threads API エラー (${path}): ${message}${detail ? ` [${detail}]` : ""}`,
    );
    this.name = "ThreadsApiError";
  }
}

/** Threads Graph API を POST し、JSON を返す。エラー時は例外を投げる。 */
async function postGraph(
  path: string,
  params: Record<string, string>,
): Promise<ThreadsApiResponse> {
  const body = new URLSearchParams({
    ...params,
    access_token: THREADS_USER_TOKEN!,
  });

  const res = await fetch(`${THREADS_API_BASE}/${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });

  const json = (await res.json().catch(() => ({}))) as ThreadsApiResponse;
  if (!res.ok || json.error || !json.id) {
    throw new ThreadsApiError(
      path,
      json.error?.message ?? `HTTP ${res.status}`,
      json.error?.code,
      json.error?.type,
    );
  }
  return json;
}

/** Meta 側の一時エラーか。恒久エラーは繰り返しても無駄なので即諦める */
function isRetriable(e: unknown): boolean {
  if (!(e instanceof ThreadsApiError)) return true; // ネットワーク断など
  return e.code === undefined || !PERMANENT_ERROR_CODES.has(e.code);
}

/** postGraph を Meta の間欠エラーに備えてリトライする */
async function postGraphWithRetry(
  path: string,
  params: Record<string, string>,
): Promise<ThreadsApiResponse> {
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      return await postGraph(path, params);
    } catch (e) {
      if (attempt === MAX_ATTEMPTS || !isRetriable(e)) throw e;
      const waitMs = BACKOFF_MS * attempt;
      const msg = e instanceof Error ? e.message : String(e);
      console.warn(
        `⚠️  Threads ${path} 失敗（${attempt}/${MAX_ATTEMPTS}）: ${msg} — ${waitMs}ms 後にリトライ`,
      );
      await sleep(waitMs);
    }
  }
  // ループは必ず return か throw で抜ける。TS の到達解析のための保険
  throw new ThreadsApiError(path, "リトライ上限に到達");
}

/**
 * Threads にテキストを投稿する。
 * 上限（500文字）を超える場合は末尾を切り詰める。
 */
export async function postToThreads(text: string): Promise<void> {
  if (!THREADS_USER_TOKEN) {
    console.log("⚠️  THREADS_USER_TOKEN 未設定のため Threads 投稿をスキップ");
    return;
  }

  let body = text;
  const chars = [...body];
  if (chars.length > MAX_POST_CHARS) {
    console.warn(
      `⚠️  Threads 投稿が ${chars.length} 文字で上限超過。末尾を切り詰めます`,
    );
    body = chars.slice(0, MAX_POST_CHARS - 1).join("") + "…";
  }

  // 1. メディアコンテナ作成（テキスト投稿）
  const container = await postGraphWithRetry(`${THREADS_USER_ID}/threads`, {
    media_type: "TEXT",
    text: body,
  });

  // 2. publish して確定。container のサーバー側処理を待ってから叩く。
  await sleep(PUBLISH_INITIAL_WAIT_MS);
  await postGraphWithRetry(`${THREADS_USER_ID}/threads_publish`, {
    creation_id: container.id!,
  });

  console.log("✅ Threads に投稿しました");
}
