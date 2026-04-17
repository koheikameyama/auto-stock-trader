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
 * 場外で broker-reconciliation を走らせると getOrders/getHoldings が 0件で
 * 返ってくる仕様のため誤判定（Phase 3 の誤voidPosition等）リスクがある。
 * このジョブは立花APIへの能動的な発注のみで、状態取得に依存しないため安全。
 */

import { prisma } from "../lib/prisma";
import { submitBrokerSL } from "../core/broker-sl-manager";

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
    await submitBrokerSL({
      positionId: pos.id,
      ticker: pos.stock.tickerCode,
      quantity: pos.quantity,
      stopTriggerPrice: Number(pos.stopLossPrice),
      strategy: pos.strategy,
    });
  }
}
