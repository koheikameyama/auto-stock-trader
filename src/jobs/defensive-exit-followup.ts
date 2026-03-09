/**
 * ディフェンシブモード妥当性検証ジョブ（16:20 JST / 平日）
 *
 * defensive exit（crisis全決済/bearish微益撤退）した銘柄の
 * exit後1/3/5営業日の株価を追跡し、決済判断が正しかったかを検証する。
 *
 * 1. 未追跡のdefensive exitポジションを検出 → フォローアップレコード作成
 * 2. 既存フォローアップの価格取得（営業日ベース）
 * 3. 集計ログ出力
 */

import { Prisma } from "@prisma/client";
import { prisma } from "../lib/prisma";
import { fetchHistoricalData } from "../core/market-data";
import pLimit from "p-limit";

const FOLLOW_UP_DAYS = [1, 3, 5] as const;

interface ExitSnapshotData {
  exitReason?: string;
}

function isDefensiveExit(exitSnapshot: unknown): boolean {
  if (!exitSnapshot || typeof exitSnapshot !== "object") return false;
  const snapshot = exitSnapshot as ExitSnapshotData;
  if (!snapshot.exitReason) return false;
  return (
    snapshot.exitReason.includes("crisis") ||
    snapshot.exitReason.includes("bearish微益撤退")
  );
}

function classifyExitReason(exitSnapshot: unknown): "crisis" | "bearish" {
  const snapshot = exitSnapshot as ExitSnapshotData;
  return snapshot.exitReason?.includes("crisis") ? "crisis" : "bearish";
}

export async function main() {
  console.log("=== Defensive Exit Follow-Up 開始 ===");

  // 1. 未追跡のdefensive exitポジションを検出
  console.log("[1/3] 未追跡のdefensive exitポジション検出中...");
  const defensivePositions = await prisma.tradingPosition.findMany({
    where: {
      status: "closed",
      exitSnapshot: { not: Prisma.DbNull },
      defensiveFollowUp: { is: null },
    },
    include: { stock: true },
  });

  // defensive exitのみフィルタ
  const newDefensiveExits = defensivePositions.filter((p) =>
    isDefensiveExit(p.exitSnapshot),
  );

  if (newDefensiveExits.length > 0) {
    console.log(`  新規defensive exit: ${newDefensiveExits.length}件`);
    for (const position of newDefensiveExits) {
      const exitDate = position.exitedAt!;
      // exitDateをJST日付としてDate型に変換（@db.Date用）
      const exitDateForDb = new Date(
        Date.UTC(
          exitDate.getFullYear(),
          exitDate.getMonth(),
          exitDate.getDate(),
        ),
      );

      await prisma.defensiveExitFollowUp.create({
        data: {
          positionId: position.id,
          tickerCode: position.stock.tickerCode,
          exitDate: exitDateForDb,
          exitPrice: position.exitPrice!,
          exitReason: classifyExitReason(position.exitSnapshot),
        },
      });
      console.log(
        `  → ${position.stock.tickerCode}: フォローアップ作成（${classifyExitReason(position.exitSnapshot)}）`,
      );
    }
  } else {
    console.log("  新規defensive exitなし");
  }

  // 2. 未完了フォローアップの価格取得
  console.log("[2/3] 未完了フォローアップの価格取得中...");
  const pendingFollowUps = await prisma.defensiveExitFollowUp.findMany({
    where: { isComplete: false },
  });

  if (pendingFollowUps.length === 0) {
    console.log("  未完了フォローアップなし");
    console.log("=== Defensive Exit Follow-Up 終了 ===");
    return;
  }

  console.log(`  未完了: ${pendingFollowUps.length}件`);

  const limit = pLimit(5);
  let updatedCount = 0;
  let completedCount = 0;

  await Promise.all(
    pendingFollowUps.map((followUp) =>
      limit(async () => {
        const historical = await fetchHistoricalData(followUp.tickerCode);
        if (!historical || historical.length === 0) {
          console.log(
            `  → ${followUp.tickerCode}: ヒストリカルデータ取得失敗`,
          );
          return;
        }

        // ヒストリカルデータは新しい順 → 古い順に並び替え
        const sortedBars = [...historical].reverse();

        // exitDate以降の営業日データを抽出
        const exitDateStr = followUp.exitDate.toISOString().split("T")[0];
        const barsAfterExit = sortedBars.filter(
          (bar) => bar.date > exitDateStr,
        );

        if (barsAfterExit.length === 0) {
          return; // まだexit後の営業日データがない
        }

        const exitPrice = Number(followUp.exitPrice);
        const updateData: Record<string, number | boolean> = {};
        let allFilled = true;

        for (const dayN of FOLLOW_UP_DAYS) {
          const priceField = `day${dayN}Price` as const;
          const pnlField = `day${dayN}PnlPct` as const;

          // 既に取得済みならスキップ
          if (followUp[priceField] !== null) continue;

          // N営業日目のバーを取得（0-indexed）
          const bar = barsAfterExit[dayN - 1];
          if (!bar) {
            allFilled = false;
            continue;
          }

          const pnlPct = ((bar.close - exitPrice) / exitPrice) * 100;
          updateData[priceField] = bar.close;
          updateData[pnlField] = pnlPct;
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
          await prisma.defensiveExitFollowUp.update({
            where: { id: followUp.id },
            data: updateData,
          });

          const pnlLog = FOLLOW_UP_DAYS.map((d) => {
            const pnl = updateData[`day${d}PnlPct`];
            return pnl !== undefined
              ? `${d}日後:${Number(pnl) >= 0 ? "+" : ""}${Number(pnl).toFixed(2)}%`
              : null;
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

  // 3. 集計ログ
  console.log("[3/3] 集計...");
  console.log(`  更新: ${updatedCount}件, 完了: ${completedCount}件`);

  // 完了済みフォローアップの統計
  const completedFollowUps = await prisma.defensiveExitFollowUp.findMany({
    where: { isComplete: true },
  });

  if (completedFollowUps.length > 0) {
    const crisisExits = completedFollowUps.filter(
      (f) => f.exitReason === "crisis",
    );
    const bearishExits = completedFollowUps.filter(
      (f) => f.exitReason === "bearish",
    );

    const summarize = (
      exits: typeof completedFollowUps,
      label: string,
    ) => {
      if (exits.length === 0) return;
      const day5Pnls = exits.map((f) => Number(f.day5PnlPct));
      const avgPnl =
        day5Pnls.reduce((sum, v) => sum + v, 0) / day5Pnls.length;
      const savedCount = day5Pnls.filter((v) => v < 0).length; // 下落=決済正解
      console.log(
        `  [${label}] ${exits.length}件: 5日後平均${avgPnl >= 0 ? "+" : ""}${avgPnl.toFixed(2)}%, 正答率${((savedCount / exits.length) * 100).toFixed(0)}%（下落=${savedCount}件）`,
      );
    };

    summarize(crisisExits, "crisis");
    summarize(bearishExits, "bearish");
    summarize(completedFollowUps, "合計");
  }

  console.log("=== Defensive Exit Follow-Up 終了 ===");
}

const isDirectRun = process.argv[1]?.includes("defensive-exit-followup");
if (isDirectRun) {
  main()
    .catch((error) => {
      console.error("Defensive Exit Follow-Up エラー:", error);
      process.exit(1);
    })
    .finally(() => prisma.$disconnect());
}
