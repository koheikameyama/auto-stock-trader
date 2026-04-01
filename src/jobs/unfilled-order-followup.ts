/**
 * 未約定注文フォローアップジョブ（16:30 JST / 平日）
 *
 * 指値注文を出したが約定しなかった（expired/cancelled）銘柄の
 * 注文後1/3/5営業日の株価を追跡し、指値設定が適切だったかを検証する。
 *
 * 1. 未追跡の未約定買い注文を検出 → フォローアップレコード作成
 * 2. 既存フォローアップの価格取得（営業日ベース）
 * 3. 集計ログ + Slack通知
 */

import { prisma } from "../lib/prisma";
import { fetchHistoricalData } from "../core/market-data";
import { notifyUnfilledOrderFollowUp } from "../lib/slack";
import pLimit from "p-limit";

const FOLLOW_UP_DAYS = [1, 3, 5] as const;

function classifyCancelReason(status: string): string {
  if (status === "expired") return "expired";
  return "cancelled_eod";
}

export async function main() {
  console.log("=== Unfilled Order Follow-Up 開始 ===");

  // 1. 未追跡の未約定買い注文を検出
  console.log("[1/3] 未追跡の未約定買い注文検出中...");
  const unfilledOrders = await prisma.tradingOrder.findMany({
    where: {
      status: { in: ["expired", "cancelled"] },
      side: "buy",
      limitPrice: { not: null },
      unfilledFollowUp: { is: null },
    },
    include: { stock: true },
  });

  if (unfilledOrders.length > 0) {
    console.log(`  新規未約定注文: ${unfilledOrders.length}件`);

    // 注文日の終値を取得するため、ヒストリカルデータをバッチ取得
    const tickerCodes = [...new Set(unfilledOrders.map((o) => o.stock.tickerCode))];
    const limit = pLimit(5);
    const historicalMap = new Map<string, { date: string; close: number; low: number }[]>();

    await Promise.all(
      tickerCodes.map((ticker) =>
        limit(async () => {
          const data = await fetchHistoricalData(ticker);
          if (data) {
            historicalMap.set(
              ticker,
              [...data].reverse(), // oldest-first
            );
          }
        }),
      ),
    );

    for (const order of unfilledOrders) {
      const tickerCode = order.stock.tickerCode;
      const limitPrice = Number(order.limitPrice);
      const orderDateStr = order.createdAt.toISOString().split("T")[0];

      // 注文日の終値をmarketPriceとして使用
      const bars = historicalMap.get(tickerCode);
      const orderDayBar = bars?.find((b) => b.date === orderDateStr);
      const marketPrice = orderDayBar?.close ?? limitPrice; // フォールバック: limitPrice

      const gapPct = ((limitPrice - marketPrice) / marketPrice) * 100;

      const orderDateForDb = new Date(
        Date.UTC(
          order.createdAt.getFullYear(),
          order.createdAt.getMonth(),
          order.createdAt.getDate(),
        ),
      );

      await prisma.unfilledOrderFollowUp.create({
        data: {
          orderId: order.id,
          tickerCode,
          strategy: order.strategy,
          orderDate: orderDateForDb,
          limitPrice,
          marketPrice,
          gapPct,
          cancelReason: classifyCancelReason(order.status),
        },
      });
      console.log(
        `  → ${tickerCode}: 指値¥${limitPrice.toLocaleString()} 市場価格¥${marketPrice.toLocaleString()} (${gapPct >= 0 ? "+" : ""}${gapPct.toFixed(2)}%)`,
      );
    }
  } else {
    console.log("  新規未約定注文なし");
  }

  // 2. 未完了フォローアップの価格取得
  console.log("[2/3] 未完了フォローアップの価格取得中...");
  const pendingFollowUps = await prisma.unfilledOrderFollowUp.findMany({
    where: { isComplete: false },
  });

  if (pendingFollowUps.length === 0) {
    console.log("  未完了フォローアップなし");
    console.log("=== Unfilled Order Follow-Up 終了 ===");
    return;
  }

  console.log(`  未完了: ${pendingFollowUps.length}件`);

  const limit2 = pLimit(5);
  let updatedCount = 0;
  let completedCount = 0;

  await Promise.all(
    pendingFollowUps.map((followUp) =>
      limit2(async () => {
        const historical = await fetchHistoricalData(followUp.tickerCode);
        if (!historical || historical.length === 0) {
          console.log(
            `  → ${followUp.tickerCode}: ヒストリカルデータ取得失敗`,
          );
          return;
        }

        const sortedBars = [...historical].reverse(); // oldest-first
        const orderDateStr = followUp.orderDate.toISOString().split("T")[0];
        const barsAfterOrder = sortedBars.filter(
          (bar) => bar.date > orderDateStr,
        );

        if (barsAfterOrder.length === 0) {
          return;
        }

        const limitPrice = Number(followUp.limitPrice);
        const updateData: Record<string, number | boolean> = {};
        let allFilled = true;

        for (const dayN of FOLLOW_UP_DAYS) {
          const priceField = `day${dayN}Price` as const;
          const pnlField = `day${dayN}PnlPct` as const;
          const reachedField = `day${dayN}ReachedLimit` as const;

          // 既に取得済みならスキップ
          if (followUp[priceField] !== null) continue;

          const bar = barsAfterOrder[dayN - 1];
          if (!bar) {
            allFilled = false;
            continue;
          }

          // N営業日後の終値
          updateData[priceField] = bar.close;

          // 指値で買えていた場合の損益%
          const pnlPct = ((bar.close - limitPrice) / limitPrice) * 100;
          updateData[pnlField] = pnlPct;

          // N営業日目までに指値に到達したか（安値ベース）
          const barsUpToDay = barsAfterOrder.slice(0, dayN);
          const minLow = Math.min(...barsUpToDay.map((b) => b.low));
          updateData[reachedField] = minLow <= limitPrice ? 1 : 0; // Boolean → 1/0 for DB
        }

        // 全日程が埋まったか確認
        if (allFilled) {
          const day1Done =
            followUp.day1Price !== null || updateData.day1Price !== undefined;
          const day3Done =
            followUp.day3Price !== null || updateData.day3Price !== undefined;
          const day5Done =
            followUp.day5Price !== null || updateData.day5Price !== undefined;
          if (day1Done && day3Done && day5Done) {
            updateData.isComplete = true;
          }
        }

        if (Object.keys(updateData).length > 0) {
          // Boolean変換（Prismaはbooleanを期待）
          const prismaData: Record<string, number | boolean> = {};
          for (const [key, value] of Object.entries(updateData)) {
            if (key.includes("ReachedLimit")) {
              prismaData[key] = value === 1;
            } else {
              prismaData[key] = value;
            }
          }

          await prisma.unfilledOrderFollowUp.update({
            where: { id: followUp.id },
            data: prismaData,
          });

          const pnlLog = FOLLOW_UP_DAYS.map((d) => {
            const pnl = updateData[`day${d}PnlPct`];
            const reached = updateData[`day${d}ReachedLimit`];
            if (pnl === undefined) return null;
            const reachedStr = reached === 1 ? "到達" : "未到達";
            return `${d}日後:${Number(pnl) >= 0 ? "+" : ""}${Number(pnl).toFixed(2)}%(${reachedStr})`;
          })
            .filter(Boolean)
            .join(", ");

          if (pnlLog) {
            console.log(`  → ${followUp.tickerCode}: ${pnlLog}`);
          }

          updatedCount++;
          if (updateData.isComplete) completedCount++;
        }
      }),
    ),
  );

  // 3. 集計 + Slack通知
  console.log("[3/3] 集計...");
  console.log(`  更新: ${updatedCount}件, 完了: ${completedCount}件`);

  const completedFollowUps = await prisma.unfilledOrderFollowUp.findMany({
    where: { isComplete: true },
    orderBy: { orderDate: "desc" },
    take: 100, // 直近100件で統計
  });

  if (completedFollowUps.length > 0) {
    // 統計計算
    const day5Pnls = completedFollowUps.map((f) => Number(f.day5PnlPct));
    const avgDay5Pnl =
      day5Pnls.reduce((sum, v) => sum + v, 0) / day5Pnls.length;

    const day5Reached = completedFollowUps.filter(
      (f) => f.day5ReachedLimit === true,
    );
    const reachRate = (day5Reached.length / completedFollowUps.length) * 100;

    const profitableIfReached = day5Reached.filter(
      (f) => Number(f.day5PnlPct) > 0,
    );

    const avgGapPct =
      completedFollowUps.reduce((sum, f) => sum + Number(f.gapPct), 0) /
      completedFollowUps.length;

    console.log(
      `  [統計] ${completedFollowUps.length}件: 指値到達率${reachRate.toFixed(0)}%, 5日後平均損益${avgDay5Pnl >= 0 ? "+" : ""}${avgDay5Pnl.toFixed(2)}%, 平均乖離${avgGapPct >= 0 ? "+" : ""}${avgGapPct.toFixed(2)}%`,
    );

    // 見逃し上位（指値到達 + 5日後利益 > 0の銘柄）
    const missedOpportunities = completedFollowUps
      .filter(
        (f) => f.day5ReachedLimit === true && Number(f.day5PnlPct) > 0,
      )
      .sort((a, b) => Number(b.day5PnlPct) - Number(a.day5PnlPct))
      .slice(0, 5);

    // Slack通知
    await notifyUnfilledOrderFollowUp({
      newCount: unfilledOrders.length,
      updatedCount,
      completedCount,
      totalTracking: pendingFollowUps.length,
      stats: {
        totalCompleted: completedFollowUps.length,
        reachRate,
        avgDay5Pnl,
        avgGapPct,
        profitableIfReachedCount: profitableIfReached.length,
        reachedCount: day5Reached.length,
      },
      topMissed: missedOpportunities.map((f) => ({
        tickerCode: f.tickerCode,
        limitPrice: Number(f.limitPrice),
        day5Price: Number(f.day5Price),
        day5PnlPct: Number(f.day5PnlPct),
        gapPct: Number(f.gapPct),
      })),
    });
  }

  console.log("=== Unfilled Order Follow-Up 終了 ===");
}

const isDirectRun = process.argv[1]?.includes("unfilled-order-followup");
if (isDirectRun) {
  main()
    .catch((error) => {
      console.error("Unfilled Order Follow-Up エラー:", error);
      process.exit(1);
    })
    .finally(() => prisma.$disconnect());
}
