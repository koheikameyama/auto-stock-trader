/**
 * 朝の相場局面 SNS 公開投稿（寄り前 / 平日）
 *
 * morning-analysis ワークフロー（cron-job.org 8:00 JST 起動）内で
 * market-assessment 成功後に実行される（KOH-521）。
 *
 * 夜の日次ログ（daily-social-post、17:30 JST）が「結果」担当なのに対し、
 * 本ジョブは「状態」担当。相場局面モニター（KOH-515 Phase 0）の利用シーンは
 * 朝・寄り前なので、その時間帯に局面レベルだけの短い投稿を流して公開ページへ誘導する。
 *
 * レジーム判定は前日終値ベース（DB由来）で朝の時点で確定済み。
 * マスキングポリシーは夜投稿と同一（銘柄名・戦略パラメータ・絶対額は出さない）。
 * 開示するのはレベル + breadth / VIX のみで、夜投稿・公開ページと同じ範囲。
 */

import dayjs from "dayjs";
import utc from "dayjs/plugin/utc";
import timezone from "dayjs/plugin/timezone";
import { prisma } from "../lib/prisma";
import { postToBluesky } from "../lib/bluesky";
import { notifySlack } from "../lib/slack";
import { TIMEZONE, PUBLIC_SITE_URL } from "../lib/constants";
import {
  detectRegimeShift,
  getLevelEmoji,
  getLevelLabel,
} from "../core/regime-shift-detector";
import { DISCLAIMER, buildXIntentUrl } from "./daily-social-post";

dayjs.extend(utc);
dayjs.extend(timezone);

const WEEKDAY_JA = ["日", "月", "火", "水", "木", "金", "土"];

export async function buildMorningSocialText(): Promise<string> {
  const now = new Date();
  const dayLabel = `${dayjs(now).tz(TIMEZONE).format("M/D")}(${WEEKDAY_JA[dayjs(now).tz(TIMEZONE).day()]})`;

  // 夜投稿と違い局面が本文のすべてなので、取得失敗時はフォールバックせずジョブごと失敗させる
  const regime = await detectRegimeShift({ asOfDate: now });
  const breadthPct = (regime.current.breadth * 100).toFixed(1);
  const vix = regime.current.vix;
  const vixStr = Number.isFinite(vix) ? vix.toFixed(1) : "N/A";

  const lines = [
    `🌅 今朝の相場局面 ${dayLabel}`,
    "",
    `${getLevelEmoji(regime.level)} ${getLevelLabel(regime.level)}（強気シグナル ${regime.signalCount}/5）`,
    `breadth ${breadthPct}% ／ VIX ${vixStr}`,
    "",
    "▼今日の局面をチェック",
    PUBLIC_SITE_URL,
    "",
    DISCLAIMER,
  ];

  return lines.join("\n");
}

export async function main() {
  const text = await buildMorningSocialText();
  console.log("--- 投稿内容 ---\n" + text + "\n----------------");
  await postToBluesky(text);

  // 夜投稿と同じく、投稿内容を Slack にも流して目視確認できるようにし、
  // X の Web Intent リンクを添えて手動投稿を1タップにする。
  const xIntentUrl = buildXIntentUrl(text);
  await notifySlack({
    title: "🌅 Bluesky 朝の局面投稿",
    message: `${text}\n\n<${xIntentUrl}|📱 タップして X に投稿（下書きが開きます）>`,
    color: "good",
  });
}

const isDirectRun = process.argv[1]?.includes("morning-social-post");
if (isDirectRun) {
  main()
    .catch((error) => {
      console.error("morning-social-post エラー:", error);
      process.exit(1);
    })
    .finally(async () => {
      await prisma.$disconnect();
    });
}
