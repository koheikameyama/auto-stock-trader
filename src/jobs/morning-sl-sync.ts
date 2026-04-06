/**
 * 朝のSL注文同期ジョブ（市場オープン前・毎営業日）
 *
 * デモサーバーは毎日データをリセットするため、前日に発注したSL注文が消える。
 * 市場オープン前にDBのオープンポジション全件のSL注文を再発注して状態を同期する。
 *
 * 本番環境でも実行可能（既存SL注文がある場合は上書き）。
 */

import { prisma } from "../lib/prisma";
import { notifySlack } from "../lib/slack";
import { submitBrokerSL } from "../core/broker-sl-manager";
import { isTachibanaProduction } from "../lib/constants/broker";

export async function main(): Promise<void> {
  console.log("=== Morning SL Sync 開始 ===");

  if (!isTachibanaProduction) {
    console.log("[morning-sl-sync] デモ環境のためスキップ（価格ベース管理に移行）");
    return;
  }

  const openPositions = await prisma.tradingPosition.findMany({
    where: { status: "open" },
    include: { stock: true },
  });

  if (!openPositions.length) {
    console.log("[morning-sl-sync] オープンポジションなし → スキップ");
    return;
  }

  console.log(`[morning-sl-sync] ${openPositions.length}件のポジションのSLを再発注`);

  let successCount = 0;
  let failCount = 0;

  for (const position of openPositions) {
    const ticker = position.stock.tickerCode;

    if (position.slBrokerOrderId) {
      await prisma.tradingPosition.update({
        where: { id: position.id },
        data: { slBrokerOrderId: null, slBrokerBusinessDay: null },
      });
      console.log(`[morning-sl-sync] ${ticker}: 旧SL注文IDをクリア (${position.slBrokerOrderId})`);
    }

    const stopPrice =
      position.trailingStopPrice != null
        ? Number(position.trailingStopPrice)
        : Number(position.stopLossPrice ?? 0);

    if (stopPrice <= 0) {
      console.warn(`[morning-sl-sync] ${ticker}: SL価格が不明 → スキップ`);
      failCount++;
      continue;
    }

    try {
      await submitBrokerSL({
        positionId: position.id,
        ticker,
        quantity: position.quantity,
        stopTriggerPrice: stopPrice,
        strategy: position.strategy,
      });
      successCount++;
    } catch (err) {
      console.error(`[morning-sl-sync] ${ticker}: SL再発注失敗:`, err);
      failCount++;
    }
  }

  console.log(`=== Morning SL Sync 完了 (成功=${successCount}, 失敗=${failCount}) ===`);

  await notifySlack({
    title: `📋 朝のSL注文同期完了`,
    message: `${openPositions.length}件のポジションを処理\n✅ 成功: ${successCount}件\n${failCount > 0 ? `❌ 失敗: ${failCount}件` : ""}`,
    color: failCount > 0 ? "warning" : "good",
  }).catch(() => {});
}

const isDirectRun = process.argv[1]?.includes("morning-sl-sync");
if (isDirectRun) {
  import("../core/broker-client").then(({ getTachibanaClient }) => {
    const client = getTachibanaClient();
    client
      .login()
      .then(() => main())
      .catch((error) => {
        console.error("Morning SL Sync エラー:", error);
        process.exit(1);
      })
      .finally(async () => {
        await client.logout().catch(() => {});
        await prisma.$disconnect();
      });
  });
}
