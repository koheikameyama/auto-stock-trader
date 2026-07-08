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

interface ThreadsApiResponse {
  id?: string;
  error?: { message?: string; type?: string; code?: number };
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
    const msg = json.error?.message ?? `HTTP ${res.status}`;
    throw new Error(`Threads API エラー (${path}): ${msg}`);
  }
  return json;
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
  const container = await postGraph(`${THREADS_USER_ID}/threads`, {
    media_type: "TEXT",
    text: body,
  });

  // 2. publish して確定
  await postGraph(`${THREADS_USER_ID}/threads_publish`, {
    creation_id: container.id!,
  });

  console.log("✅ Threads に投稿しました");
}
