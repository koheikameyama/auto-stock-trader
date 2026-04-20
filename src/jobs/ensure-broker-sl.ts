/**
 * SL未発注ポジション保険ジョブ
 *
 * status="open" かつ slBrokerOrderId=null のポジションに対し、
 * DBの stopLossPrice を使って逆指値売り注文をブローカーに発注する。
 *
 * 立会終了後〜翌朝前場開始前の「翌日注文受付時間帯」をカバーする目的。
 * position-monitor は取引時間内のみ動作するため、その時間帯はこのジョブが
 * SL抜けを防ぐ。quote を使わず trail再計算もしないため、取引時間外でも安全。
 *
 * リトライ上限（MAX_SL_RETRIES）を設け、超過時は自動再発注を停止し通知のみにする。
 * これにより、ブローカー側で繰り返しSLが取消される場合の無限ループを防止する。
 */

import { prisma } from "../lib/prisma";
import { submitBrokerSL } from "../core/broker-sl-manager";
import { notifySlack } from "../lib/slack";

/** 同一ポジションのSL再発注上限（プロセスライフタイム内） */
const MAX_SL_RETRIES = 3;
const retryCount = new Map<string, number>();

export async function main(): Promise<void> {
  const tag = "[ensure-broker-sl]";

  const targets = await prisma.tradingPosition.findMany({
    where: { status: "open", slBrokerOrderId: null },
    include: { stock: { select: { tickerCode: true } } },
  });

  if (!targets.length) return;

  console.log(`${tag} SL未発注ポジション ${targets.length}件を処理`);

  for (const pos of targets) {
    if (!pos.stopLossPrice) {
      console.warn(
        `${tag} ${pos.stock.tickerCode} (${pos.id}): stopLossPrice が未設定のためスキップ`,
      );
      continue;
    }

    const count = retryCount.get(pos.id) ?? 0;
    if (count >= MAX_SL_RETRIES) {
      console.warn(
        `${tag} ${pos.stock.tickerCode} (${pos.id}): リトライ上限(${MAX_SL_RETRIES})到達 → 通知のみ`,
      );
      await notifySlack({
        title: `🚨 SL再発注リトライ上限: ${pos.stock.tickerCode}`,
        message: `SL注文の自動再発注が${MAX_SL_RETRIES}回失敗しました\npositionId: ${pos.id}\nSLトリガー: ¥${Number(pos.stopLossPrice).toLocaleString()}\n手動でSL注文を確認・再発注してください`,
        color: "danger",
      }).catch(() => {});
      continue;
    }

    retryCount.set(pos.id, count + 1);

    if (count > 0) {
      await notifySlack({
        title: `⚠️ SL自動再発注 (${count + 1}/${MAX_SL_RETRIES}): ${pos.stock.tickerCode}`,
        message: `SL注文を自動再発注します\npositionId: ${pos.id}\nSLトリガー: ¥${Number(pos.stopLossPrice).toLocaleString()}`,
        color: "warning",
      }).catch(() => {});
    }

    await submitBrokerSL({
      positionId: pos.id,
      ticker: pos.stock.tickerCode,
      quantity: pos.quantity,
      stopTriggerPrice: Number(pos.stopLossPrice),
      strategy: pos.strategy,
    });
  }
}
