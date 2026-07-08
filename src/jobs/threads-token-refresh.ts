/**
 * Threads 長期アクセストークンの自動リフレッシュ（週次 / GitHub Actions）
 *
 * Threads の長期トークン（THREADS_USER_TOKEN）は約60日で失効するが、
 * リフレッシュエンドポイントで新しい60日トークンに更新できる
 * （発行から24時間以上経過・有効期限内が条件）。
 *
 *   GET https://graph.threads.net/refresh_access_token
 *       ?grant_type=th_refresh_token&access_token=<現トークン>
 *   → { access_token, token_type, expires_in }
 *
 * 週次で走らせ、新トークンで GitHub リポジトリシークレット THREADS_USER_TOKEN を
 * 上書きする。トークンをログ・ステップ間受け渡しに載せないため、本スクリプト内で
 * gh CLI を stdin 経由で叩いてシークレットを直接更新する。
 *
 * 必要な環境変数:
 *   - THREADS_USER_TOKEN  現在の長期トークン（更新対象）
 *   - GH_PAT              シークレット書き込み可の PAT（gh の GH_TOKEN として使用）
 *   - GITHUB_REPOSITORY   "owner/repo"（Actions が自動設定。未設定時はフォールバック）
 *
 * ローカル .env（Google Drive symlink）は自動更新されない。本番投稿は Actions で
 * 走るためシークレットが新しければ問題なく、ローカルは手動テスト用途なので許容する。
 */

import { spawn } from "node:child_process";
import { notifySlack, SNS_POST_SLACK_WEBHOOK_URL } from "../lib/slack";

const THREADS_USER_TOKEN = process.env.THREADS_USER_TOKEN;
const GH_PAT = process.env.GH_PAT;
const REPO = process.env.GITHUB_REPOSITORY ?? "koheikameyama/auto-stock-trader";
const SECRET_NAME = "THREADS_USER_TOKEN";

const REFRESH_URL = "https://graph.threads.net/refresh_access_token";

interface RefreshResponse {
  access_token?: string;
  token_type?: string;
  expires_in?: number;
  error?: { message?: string };
}

/** 現トークンをリフレッシュして新トークンと有効日数を返す */
async function refreshToken(current: string): Promise<{ token: string; expiresDays: number }> {
  const url = `${REFRESH_URL}?grant_type=th_refresh_token&access_token=${encodeURIComponent(current)}`;
  const res = await fetch(url);
  const json = (await res.json().catch(() => ({}))) as RefreshResponse;

  if (!res.ok || json.error || !json.access_token) {
    const msg = json.error?.message ?? `HTTP ${res.status}`;
    throw new Error(`リフレッシュ失敗: ${msg}`);
  }
  const expiresDays = json.expires_in ? Math.round(json.expires_in / 86400) : 0;
  return { token: json.access_token, expiresDays };
}

/**
 * gh CLI で GitHub リポジトリシークレットを更新する。
 * トークンは stdin で渡し、コマンドライン引数・ログに出さない。
 */
function updateSecret(name: string, value: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn("gh", ["secret", "set", name, "--repo", REPO], {
      env: { ...process.env, GH_TOKEN: GH_PAT },
      stdio: ["pipe", "inherit", "inherit"],
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`gh secret set が exit code ${code} で失敗`));
    });
    child.stdin.write(value);
    child.stdin.end();
  });
}

export async function main() {
  if (!THREADS_USER_TOKEN) {
    console.log("⚠️  THREADS_USER_TOKEN 未設定のためリフレッシュをスキップ");
    return;
  }
  if (!GH_PAT) {
    throw new Error("GH_PAT 未設定のためシークレットを更新できません");
  }

  try {
    const { token, expiresDays } = await refreshToken(THREADS_USER_TOKEN);
    await updateSecret(SECRET_NAME, token);
    console.log(`✅ Threads トークンをリフレッシュし ${SECRET_NAME} を更新（有効 ~${expiresDays}日）`);

    await notifySlack({
      title: "🧵 Threadsトークン更新OK",
      message: [
        `${SECRET_NAME} を新しい長期トークンに更新しました ✅`,
        `有効期限: 約 ${expiresDays} 日`,
        "※ローカル .env は自動更新されません（本番投稿は Actions のシークレットを使用）",
      ].join("\n"),
      color: "good",
      webhookUrl: SNS_POST_SLACK_WEBHOOK_URL,
    });
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    console.error("Threads トークン更新失敗:", detail);
    await notifySlack({
      title: "⚠️ Threadsトークン更新失敗",
      message: [
        "Threads 長期トークンのリフレッシュに失敗しました ❌",
        detail,
        "失効前に手動でトークンを再発行し、GitHub シークレット THREADS_USER_TOKEN を更新してください。",
      ].join("\n"),
      color: "danger",
      webhookUrl: SNS_POST_SLACK_WEBHOOK_URL,
    });
    throw e;
  }
}

const isDirectRun = process.argv[1]?.includes("threads-token-refresh");
if (isDirectRun) {
  main().catch((error) => {
    console.error("threads-token-refresh エラー:", error);
    process.exit(1);
  });
}
