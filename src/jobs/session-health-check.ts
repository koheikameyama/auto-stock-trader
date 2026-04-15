/**
 * セッションヘルスチェックジョブ
 *
 * 15:20のポストマーケット処理（gapup/weekly-break/PSCモニター）前に
 * ブローカーセッションの生存を確認し、電話番号認証が必要な場合を
 * 早期に検出する。
 *
 * スケジュール:
 *   - 8:50 JST（プレマーケット）: 朝一のセッション確認
 *   - 14:50 JST（プレクローズ）: 15:20の処理に備えた最終確認
 *
 * 仕組み:
 *   getBuyingPower() → client.request() → requestWithRetry() → ensureSession()
 *   セッション切れの場合は reLoginOnce() → login() が自動で走る。
 *   login() で電話番号認証（10089）が検出されると handleAccountLock() が
 *   Slack通知を送信し、ユーザーが15:20前に対応できる。
 */

import { getBuyingPower } from "../core/broker-orders";
import { notifySlack } from "../lib/slack";

export async function main(): Promise<void> {
  const tag = "[session-health-check]";

  console.log(`${tag} セッション生存確認を開始...`);

  const buyingPower = await getBuyingPower();

  if (buyingPower !== null) {
    console.log(
      `${tag} ✅ セッション正常（買付余力: ${buyingPower.toLocaleString()}円）`,
    );
  } else {
    // getBuyingPower が null を返す = sResultCode !== "0" だがエラーはスローされなかった
    // （電話認証の場合は login() 内で throw されるためここには来ない）
    console.warn(`${tag} ⚠️ 買余力取得失敗（セッションは生存している可能性あり）`);
    await notifySlack({
      title: "⚠️ セッションヘルスチェック: 買余力取得失敗",
      message:
        "ブローカーAPIから買余力を取得できませんでした。セッションは生存している可能性がありますが、確認してください。",
      color: "warning",
    });
  }
}
