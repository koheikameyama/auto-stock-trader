/**
 * Bluesky (AT Protocol) 投稿ユーティリティ
 *
 * 自動売買システムの日次ログを Bluesky に公開投稿する。
 * SLACK_WEBHOOK_URL と同様、環境変数が未設定なら no-op（警告のみ）で失敗させない。
 *
 * 認証は「ハンドル + App Password」。通常のログインパスワードは使わない。
 *   - BLUESKY_HANDLE        例: stockbuddy.bsky.social
 *   - BLUESKY_APP_PASSWORD  設定 → Privacy and Security → App Passwords で発行
 *   - BLUESKY_SERVICE       省略時 https://bsky.social
 */

import { AtpAgent, RichText } from "@atproto/api";

const BLUESKY_HANDLE = process.env.BLUESKY_HANDLE;
const BLUESKY_APP_PASSWORD = process.env.BLUESKY_APP_PASSWORD;
const BLUESKY_SERVICE = process.env.BLUESKY_SERVICE ?? "https://bsky.social";

/** Bluesky の1投稿あたり最大 grapheme 数 */
const MAX_POST_GRAPHEMES = 300;

let cachedAgent: AtpAgent | null = null;

async function getAgent(): Promise<AtpAgent | null> {
  if (!BLUESKY_HANDLE || !BLUESKY_APP_PASSWORD) {
    console.log(
      "⚠️  BLUESKY_HANDLE / BLUESKY_APP_PASSWORD 未設定のため Bluesky 投稿をスキップ",
    );
    return null;
  }
  if (cachedAgent) return cachedAgent;

  const agent = new AtpAgent({ service: BLUESKY_SERVICE });
  await agent.login({
    identifier: BLUESKY_HANDLE,
    password: BLUESKY_APP_PASSWORD,
  });
  cachedAgent = agent;
  return agent;
}

/**
 * Bluesky にテキストを投稿する。
 * URL やメンションは RichText で自動的にリンク化（facet 付与）される。
 * 上限（300 grapheme）を超える場合は末尾を切り詰める。
 */
export async function postToBluesky(text: string): Promise<void> {
  const agent = await getAgent();
  if (!agent) return;

  let body = text;
  const graphemes = [...body];
  if (graphemes.length > MAX_POST_GRAPHEMES) {
    console.warn(
      `⚠️  Bluesky 投稿が ${graphemes.length} grapheme で上限超過。末尾を切り詰めます`,
    );
    body = graphemes.slice(0, MAX_POST_GRAPHEMES - 1).join("") + "…";
  }

  const rt = new RichText({ text: body });
  await rt.detectFacets(agent);

  await agent.post({
    text: rt.text,
    facets: rt.facets,
    createdAt: new Date().toISOString(),
  });
  console.log("✅ Bluesky に投稿しました");
}

/** キャッシュしたセッションを破棄する（テスト用） */
export function resetBlueskyAgent(): void {
  cachedAgent = null;
}
