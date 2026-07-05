/**
 * メール送信ユーティリティ（Resend REST API）
 *
 * Slack通知（slack.ts）と同様、環境変数が未設定なら no-op（ログのみ）で
 * 呼び出し側を失敗させない。到達率のため送信元ドメインは Resend で
 * SPF/DKIM 認証しておくこと。
 *
 * 必要な環境変数:
 *   RESEND_API_KEY … Resend の APIキー（re_xxx）
 *   MAIL_FROM      … 送信元（例: "相場局面モニター <noreply@stock-buddy.net>"）
 */

import { PUBLIC_SITE_URL } from "./constants/web";

const RESEND_API_KEY = process.env.RESEND_API_KEY;
const MAIL_FROM = process.env.MAIL_FROM;
const RESEND_ENDPOINT = "https://api.resend.com/emails";

interface SendEmailOptions {
  to: string;
  subject: string;
  html: string;
  text: string;
}

/**
 * メールを1通送信する。
 * @returns 送信できたら true、未設定でスキップ or 失敗なら false
 */
export async function sendEmail(options: SendEmailOptions): Promise<boolean> {
  if (!RESEND_API_KEY || !MAIL_FROM) {
    console.log(
      "⚠️  RESEND_API_KEY / MAIL_FROM not configured, skipping email",
    );
    return false;
  }

  try {
    const response = await fetch(RESEND_ENDPOINT, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${RESEND_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: MAIL_FROM,
        to: options.to,
        subject: options.subject,
        html: options.html,
        text: options.text,
      }),
    });

    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      console.error(`Email send failed: ${response.status} ${detail}`);
      return false;
    }
    return true;
  } catch (error) {
    console.error("Failed to send email:", error);
    return false;
  }
}

/**
 * 先行案内リスト登録の確認メール（新規登録時のみ送る想定）。
 * 送信の成否は呼び出し側の処理（登録成功）に影響させないこと。
 */
export async function sendWaitlistWelcomeEmail(to: string): Promise<boolean> {
  const subject = "【相場局面モニター】先行案内リストに登録しました";

  const text = [
    "相場局面モニターの先行案内リストにご登録いただきありがとうございます。",
    "",
    "公開の準備が整い次第、このメールアドレス宛にご案内をお送りします。",
    "しばらくお待ちください。",
    "",
    "▼ 現在の相場局面はこちらから今すぐご覧いただけます",
    PUBLIC_SITE_URL,
    "",
    "※このメールに心当たりがない場合は、破棄していただいて問題ありません。",
    "※本メールは送信専用です。ご返信いただいても対応できません。",
  ].join("\n");

  const html = `<!doctype html>
<html lang="ja">
<body style="margin:0;padding:24px;background:#0f172a;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif;">
  <div style="max-width:480px;margin:0 auto;background:#ffffff;border-radius:12px;overflow:hidden;">
    <div style="background:#0f172a;padding:20px 24px;">
      <span style="color:#ffffff;font-size:18px;font-weight:700;">相場局面モニター</span>
    </div>
    <div style="padding:24px;color:#0f172a;line-height:1.7;font-size:15px;">
      <p style="margin:0 0 16px;">先行案内リストにご登録いただきありがとうございます。</p>
      <p style="margin:0 0 24px;">公開の準備が整い次第、このメールアドレス宛にご案内をお送りします。しばらくお待ちください。</p>
      <p style="margin:0 0 8px;">現在の相場局面は、今すぐこちらからご覧いただけます。</p>
      <p style="margin:0 0 8px;">
        <a href="${PUBLIC_SITE_URL}" style="display:inline-block;background:#0f172a;color:#ffffff;text-decoration:none;padding:12px 24px;border-radius:8px;font-weight:600;font-size:15px;">今すぐ現在の相場局面を見る →</a>
      </p>
      <p style="margin:0;color:#64748b;font-size:13px;">
        ボタンが開けない場合はこちら: <a href="${PUBLIC_SITE_URL}" style="color:#2563eb;">${PUBLIC_SITE_URL}</a>
      </p>
      <p style="margin:24px 0 0;color:#64748b;font-size:13px;">
        ※このメールに心当たりがない場合は、破棄していただいて問題ありません。<br>
        ※本メールは送信専用です。ご返信いただいても対応できません。
      </p>
    </div>
  </div>
</body>
</html>`;

  return sendEmail({ to, subject, html, text });
}
