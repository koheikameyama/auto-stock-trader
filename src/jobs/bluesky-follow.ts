/**
 * Bluesky フォロー候補の自動発見＋自動フォロー（日次 12:05 JST / GitHub Actions）
 *
 * フォロワー獲得（Phase 0）のための読者候補フォロー。Bluesky は API 経由の
 * フォローが正規操作のため完全自動で行う（KOH-638）。
 *
 *   1. キーワードを日替わりで2つ選び actor 検索
 *   2. bio をスクリーニング（投資/検証系ワード必須・商材系ワード除外・既フォロー除外）
 *   3. 1日 MAX_FOLLOWS 件まで自動フォロー
 *   4. Slack へ実行結果を報告（Threads は API にフォロー機能が無いため
 *      検索ディープリンクを添えて手動フォローに誘導）
 *
 * X のフォロー自動化は規約違反（凍結リスク）のため対象外。
 */

import { getBlueskyAgent } from "../lib/bluesky";
import { notifySlack, SNS_POST_SLACK_WEBHOOK_URL } from "../lib/slack";

/** 1日にフォローする最大件数（スパム的挙動を避けるため少数固定） */
const MAX_FOLLOWS = 5;

const KEYWORDS = [
  "日本株 投資",
  "システムトレード",
  "株 データ分析",
  "投資 検証",
  "クオンツ",
  "株式投資",
  "自動売買",
];

/** bio または表示名に1つ以上含まれていてほしい語 */
const POSITIVE = [
  "株",
  "投資",
  "トレード",
  "シストレ",
  "データ",
  "検証",
  "クオンツ",
  "相場",
  "自動売買",
  "FIRE",
  "資産",
];

/** 1つでも含まれていたら除外する語（商材・勧誘系） */
const NEGATIVE = [
  "無料配布",
  "公式LINE",
  "LINE登録",
  "DMで",
  "DMへ",
  "日利",
  "サロン",
  "必勝",
  "爆益",
  "案内",
  "副業で月",
  "完全無料",
  "稼ぐ",
  "稼げる",
  "月10万",
  "月20万",
  "専門家｜",
  "プレゼント",
];

/** 日付ベースで本日の検索キーワードを2つ選ぶ（同日再実行しても同じ結果） */
function todaysKeywords(): string[] {
  const day = Math.floor(Date.now() / 86_400_000);
  return [KEYWORDS[day % KEYWORDS.length], KEYWORDS[(day + 3) % KEYWORDS.length]];
}

export async function runBlueskyFollow(): Promise<void> {
  const agent = await getBlueskyAgent();
  if (!agent) return;

  const keywords = todaysKeywords();
  const candidates = new Map<
    string,
    { did: string; handle: string; displayName?: string; description?: string }
  >();

  for (const q of keywords) {
    const res = await agent.app.bsky.actor.searchActors({ q, limit: 50 });
    for (const actor of res.data.actors) {
      if (actor.did === agent.session?.did) continue;
      if (actor.viewer?.following) continue; // 既フォロー
      if (actor.viewer?.blocking || actor.viewer?.blockedBy) continue;
      const bio = actor.description ?? "";
      if (!bio) continue;
      const haystack = bio + (actor.displayName ?? "");
      if (!POSITIVE.some((w) => haystack.includes(w))) continue;
      if (NEGATIVE.some((w) => bio.includes(w))) continue;
      candidates.set(actor.did, actor);
    }
  }

  const picked = [...candidates.values()].slice(0, MAX_FOLLOWS);
  const lines: string[] = [];

  for (const actor of picked) {
    const label = `${actor.displayName ?? actor.handle} (@${actor.handle})`;
    try {
      await agent.follow(actor.did);
      lines.push(`✅ フォロー: <https://bsky.app/profile/${actor.handle}|${label}>`);
    } catch (e) {
      lines.push(`❌ 失敗: ${label} — ${e instanceof Error ? e.message.slice(0, 80) : e}`);
    }
  }

  if (lines.length === 0) {
    lines.push("本日の新規候補なし（既フォロー or スクリーニング落ち）");
  }

  const threadsLinks = keywords
    .map(
      (q) =>
        `<https://www.threads.net/search?q=${encodeURIComponent(q)}&serp_type=users|「${q}」>`,
    )
    .join(" / ");

  await notifySlack({
    title: "🤝 Bluesky フォロー自動実行",
    message: [
      `検索キーワード: ${keywords.join(", ")}`,
      ...lines,
      "",
      `📱 Threads は手動で（タップで検索が開きます）: ${threadsLinks}`,
      "_気になるアカウントだけアプリでフォローしてください_",
    ].join("\n"),
    webhookUrl: SNS_POST_SLACK_WEBHOOK_URL,
  });

  console.log(`Bluesky フォロー実行: ${lines.filter((l) => l.startsWith("✅")).length} 件`);
}

// 直接実行時
if (require.main === module) {
  runBlueskyFollow()
    .then(() => process.exit(0))
    .catch((e) => {
      console.error(e);
      process.exit(1);
    });
}
