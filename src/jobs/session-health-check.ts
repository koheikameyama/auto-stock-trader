/**
 * セッションヘルスチェックジョブ
 *
 * 15:24のポストマーケット処理（gapup/weekly-break/PSCモニター）前に
 * ブローカーセッションの生存を確認し、電話番号認証が必要な場合を
 * 早期に検出する。
 *
 * スケジュール:
 *   - 8:50 JST（プレマーケット）: 朝一のセッション確認
 *   - 15:15 JST（プレクローズ）: 15:24のエントリー発注に備えた最終確認（9分の再ログイン余裕）
 *
 * 仕組み:
 *   getBuyingPower() → client.request() → requestWithRetry() → ensureSession()
 *   セッション切れの場合は reLoginOnce() → login() が自動で走る。
 *   login() で電話番号認証（10089）が検出されると handleAccountLock() が
 *   Slack通知を送信し、ユーザーが15:20前に対応できる。
 */

import { fetchBuyingPower } from "../core/broker-orders";
import { TACHIBANA_BUSY_RESULT_CODE } from "../lib/constants/broker";
import { notifySlack } from "../lib/slack";

export async function main(): Promise<void> {
  const tag = "[session-health-check]";

  console.log(`${tag} セッション生存確認を開始...`);

  // client.request() 内でシステム混雑(-2)は指数バックオフでリトライ済み。
  const { buyingPower, resultCode, resultText } = await fetchBuyingPower();

  if (buyingPower !== null) {
    console.log(
      `${tag} ✅ セッション正常（買付余力: ${buyingPower.toLocaleString()}円）`,
    );
    return;
  }

  // リトライ後もシステム混雑(-2)が続く場合 = セッションは生存しており、
  // 単にサーバーが高負荷なだけ。買余力の「値」が要るわけではなく
  // セッション生存確認が目的なので、誤警告を避けてログのみに留める。
  if (resultCode === TACHIBANA_BUSY_RESULT_CODE) {
    console.warn(
      `${tag} ⚠️ システム混雑のため買余力取得できず（セッションは生存）: ${resultText ?? ""}`,
    );
    return;
  }

  // それ以外の失敗（電話認証の場合は login() 内で throw されここには来ない）
  console.warn(
    `${tag} ⚠️ 買余力取得失敗（resultCode=${resultCode}）: ${resultText ?? ""}`,
  );
  await notifySlack({
    title: "⚠️ セッションヘルスチェック: 買余力取得失敗",
    message:
      "ブローカーAPIから買余力を取得できませんでした。セッションは生存している可能性がありますが、確認してください。",
    color: "warning",
  });
}
