/**
 * 資金別シミュレーション（手動実行）
 *
 * 異なる初期資金×同時保有数の組み合わせで戦略を比較し、
 * 最適な資金配分を特定する。
 *
 * 使い方: npm run capital-sim
 */

import { prisma } from "../lib/prisma";
import {
  runCapitalSimulation,
  printCapitalSimulationReport,
} from "../backtest/capital-simulator";

async function main() {
  console.log("=== 資金別シミュレーション 開始 ===");

  const result = await runCapitalSimulation();
  printCapitalSimulationReport(result);

  console.log("=== 資金別シミュレーション 完了 ===");
}

const isDirectRun = process.argv[1]?.includes("capital-simulation");
if (isDirectRun) {
  main()
    .catch((error) => {
      console.error("資金別シミュレーション エラー:", error);
      process.exit(1);
    })
    .finally(() => prisma.$disconnect());
}
