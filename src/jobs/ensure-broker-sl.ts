/**
 * SL未発注ポジション検出ジョブ（通知のみ）
 *
 * status="open" かつ slBrokerOrderId=null のポジションを検出し、
 * Slack通知で手動確認を促す。
 *
 * 以前は自動再発注していたが、ブローカー側でSLが取消された場合に
 * 自動再発注 → 再取消 のループが発生し、誤った約定データで
 * ポジションが自動クローズされる事故が発生した（2026-04-20 7730.T ¥100事件）。
 *
 * SLの初回発注は broker-fill-handler が担当する。
 * SLの更新（トレーリングストップ変更）は position-monitor が担当する。
 * このジョブは検出と通知のみ。再発注が必要な場合は手動で対応する。
 */

import { prisma } from "../lib/prisma";
import { notifySlack } from "../lib/slack";

// 同一ポジションへの通知を30分間スロットリング
const SL_MISSING_NOTIFY_THROTTLE_MS = 30 * 60 * 1000;
const lastNotifiedAt = new Map<string, number>();

export async function main(): Promise<void> {
  const tag = "[ensure-broker-sl]";

  const targets = await prisma.tradingPosition.findMany({
    where: { status: "open", slBrokerOrderId: null },
    include: { stock: { select: { tickerCode: true } } },
  });

  if (!targets.length) return;

  console.log(`${tag} SL未発注ポジション ${targets.length}件を検出`);

  for (const pos of targets) {
    if (!pos.stopLossPrice) {
      console.warn(
        `${tag} ${pos.stock.tickerCode} (${pos.id}): stopLossPrice が未設定のためスキップ`,
      );
      continue;
    }

    const now = Date.now();
    const last = lastNotifiedAt.get(pos.id);
    if (last && now - last < SL_MISSING_NOTIFY_THROTTLE_MS) continue;
    lastNotifiedAt.set(pos.id, now);

    console.warn(
      `${tag} ${pos.stock.tickerCode} (${pos.id}): SL未発注 → 通知のみ（自動再発注は停止中）`,
    );
    await notifySlack({
      title: `⚠️ SL未発注検出: ${pos.stock.tickerCode}`,
      message: `SL注文がブローカーに存在しません\npositionId: ${pos.id}\nSLトリガー: ¥${Number(pos.stopLossPrice).toLocaleString()}\n手動でSL注文を確認・再発注してください`,
      color: "warning",
    }).catch(() => {});
  }
}
