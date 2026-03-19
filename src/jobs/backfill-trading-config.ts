/**
 * 株価データバックフィル — TradingConfig同期
 *
 * TradingConfigの初期設定・設定値の同期
 */

import { prisma } from "../lib/prisma";
import { TRADING_DEFAULTS } from "../lib/constants";

export async function main() {
  console.log("=== Backfill Trading Config 開始 ===");

  const config = await prisma.tradingConfig.findFirst();

  if (!config) {
    await prisma.tradingConfig.create({
      data: {
        totalBudget: TRADING_DEFAULTS.TOTAL_BUDGET,
        realizedPnl: 0,
        maxPositions: TRADING_DEFAULTS.MAX_POSITIONS,
        maxPositionPct: TRADING_DEFAULTS.MAX_POSITION_PCT,
        maxDailyLossPct: TRADING_DEFAULTS.MAX_DAILY_LOSS_PCT,
        isActive: true,
      },
    });
    console.log(
      `  TradingConfig作成: 予算¥${TRADING_DEFAULTS.TOTAL_BUDGET.toLocaleString()}`,
    );
  } else {
    await prisma.tradingConfig.update({
      where: { id: config.id },
      data: {
        maxPositions: TRADING_DEFAULTS.MAX_POSITIONS,
        maxPositionPct: TRADING_DEFAULTS.MAX_POSITION_PCT,
        maxDailyLossPct: TRADING_DEFAULTS.MAX_DAILY_LOSS_PCT,
      },
    });
    console.log(
      `  TradingConfig更新: 最大保有数=${TRADING_DEFAULTS.MAX_POSITIONS}, 最大比率=${TRADING_DEFAULTS.MAX_POSITION_PCT}%`,
    );
  }

  console.log("=== Backfill Trading Config 終了 ===");
}

const isDirectRun = process.argv[1]?.includes("backfill-trading-config");
if (isDirectRun) {
  main()
    .catch((error) => {
      console.error("Backfill Trading Config エラー:", error);
      process.exit(1);
    })
    .finally(() => prisma.$disconnect());
}
