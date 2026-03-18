/**
 * テーシス無効化チェック（8:30 JST / 平日）
 *
 * pending swing注文のエントリー根拠が崩壊していないか、
 * 前日終値ベースで軽量チェックし、該当注文をキャンセルする。
 *
 * 無効化条件（いずれか1つでキャンセル）:
 * 1. 前日終値が損切りラインを下回った
 * 2. MA配列がuptrendからdowntrendに反転
 * 3. SMA25乖離率 < -3%
 *
 * market-scanner（8:30）と並列実行される。
 * 寄り付き前にチェックが完了し、9:20のposition-monitor開始前に
 * テーシス崩壊注文がキャンセルされている状態を保証する。
 */

import { prisma } from "../lib/prisma";
import { TECHNICAL_MIN_DATA, THESIS_INVALIDATION } from "../lib/constants";
import { fetchHistoricalData } from "../core/market-data";
import { analyzeTechnicals } from "../core/technical-analysis";
import { notifySlack } from "../lib/slack";
import type { EntrySnapshot } from "../types/snapshots";
import pLimit from "p-limit";

export async function main() {
  console.log("=== Thesis Check 開始 ===");

  const pendingSwingOrders = await prisma.tradingOrder.findMany({
    where: { side: "buy", status: "pending", strategy: "swing" },
    include: { stock: true },
  });

  if (pendingSwingOrders.length === 0) {
    console.log("  pending swing注文なし");
    console.log("=== Thesis Check 終了 ===");
    return;
  }

  console.log(`  pending swing注文: ${pendingSwingOrders.length}件`);

  const limit = pLimit(THESIS_INVALIDATION.CONCURRENCY);
  const invalidated: Array<{
    id: string;
    tickerCode: string;
    name: string;
    reason: string;
  }> = [];

  await Promise.all(
    pendingSwingOrders.map((order) =>
      limit(async () => {
        const tickerCode = order.stock.tickerCode;
        const stockName = order.stock.name;

        try {
          const historical = await fetchHistoricalData(tickerCode);
          if (
            !historical ||
            historical.length < TECHNICAL_MIN_DATA.SCANNER_MIN_BARS
          ) {
            console.log(`    [${tickerCode}] データ不足、チェックスキップ`);
            return;
          }

          const currentPrice = historical[0].close; // newest-first（前日終値）
          const techSummary = analyzeTechnicals(historical);
          const snapshot = order.entrySnapshot as EntrySnapshot | null;

          // 条件1: 前日終値が損切りラインを下回った
          const stopLossPrice = order.stopLossPrice
            ? Number(order.stopLossPrice)
            : (snapshot?.logicEntryCondition?.stopLossPrice ?? null);

          if (stopLossPrice != null && currentPrice < stopLossPrice) {
            invalidated.push({
              id: order.id,
              tickerCode,
              name: stockName,
              reason: `損切りライン割れ（前日終値 ¥${currentPrice.toLocaleString()} < SL ¥${stopLossPrice.toLocaleString()}）`,
            });
            return;
          }

          // 条件2: MA配列がuptrendからdowntrendに反転
          const entryTrend = snapshot?.technicals?.maAlignment?.trend;
          const currentTrend = techSummary.maAlignment.trend;

          if (entryTrend === "uptrend" && currentTrend === "downtrend") {
            invalidated.push({
              id: order.id,
              tickerCode,
              name: stockName,
              reason: `MA配列反転（uptrend → downtrend）`,
            });
            return;
          }

          // 条件3: SMA25乖離率が深すぎる
          if (
            techSummary.deviationRate25 != null &&
            techSummary.deviationRate25 <
              THESIS_INVALIDATION.DEVIATION_RATE_25_THRESHOLD
          ) {
            invalidated.push({
              id: order.id,
              tickerCode,
              name: stockName,
              reason: `SMA25乖離 ${techSummary.deviationRate25.toFixed(1)}% < ${THESIS_INVALIDATION.DEVIATION_RATE_25_THRESHOLD}%`,
            });
            return;
          }

          console.log(`    [${tickerCode}] テーシス有効`);
        } catch (error) {
          console.error(`    [${tickerCode}] テーシスチェック失敗:`, error);
          // エラー時は安全側に倒してキャンセルしない
        }
      }),
    ),
  );

  if (invalidated.length > 0) {
    await prisma.tradingOrder.updateMany({
      where: { id: { in: invalidated.map((r) => r.id) } },
      data: { status: "cancelled" },
    });

    for (const r of invalidated) {
      console.log(
        `  [${r.tickerCode}] テーシス無効化でキャンセル: ${r.reason}`,
      );
    }

    await notifySlack({
      title: `🔍 テーシス無効化: ${invalidated.length}件のswing注文をキャンセル`,
      message: invalidated
        .map((r) => `- ${r.tickerCode} ${r.name}: ${r.reason}`)
        .join("\n"),
      color: "warning",
      fields: [
        {
          title: "キャンセル数",
          value: `${invalidated.length}件`,
          short: true,
        },
        {
          title: "残存swing注文",
          value: `${pendingSwingOrders.length - invalidated.length}件`,
          short: true,
        },
      ],
    });
  }

  console.log(
    `  完了: ${invalidated.length}件キャンセル / ${pendingSwingOrders.length - invalidated.length}件継続`,
  );
  console.log("=== Thesis Check 終了 ===");
}

const isDirectRun = process.argv[1]?.includes("thesis-check");
if (isDirectRun) {
  main()
    .catch((error) => {
      console.error("Thesis Check エラー:", error);
      process.exit(1);
    })
    .finally(() => prisma.$disconnect());
}
