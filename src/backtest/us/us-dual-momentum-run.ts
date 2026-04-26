/**
 * Dual Momentum (Antonacci GEM) バックテスト CLI
 *
 * Usage:
 *   npx tsx src/backtest/us/us-dual-momentum-run.ts
 *   npx tsx src/backtest/us/us-dual-momentum-run.ts --start 2018-01-01 --end 2026-04-24 --verbose
 */

import dayjs from "dayjs";
import { US_DUAL_MOMENTUM_DEFAULTS } from "./us-dual-momentum-config";
import { runUSDualMomentumBacktest } from "./us-dual-momentum-simulation";
import { fetchUSHistoricalFromDB } from "./us-data-fetcher";
import type { USDualMomentumBacktestConfig } from "./us-dual-momentum-types";

async function main() {
  const args = process.argv.slice(2);
  const getArg = (n: string) => {
    const i = args.indexOf(`--${n}`);
    return i >= 0 && i + 1 < args.length ? args[i + 1] : undefined;
  };

  const endDate = getArg("end") ?? dayjs().format("YYYY-MM-DD");
  const startDate = getArg("start") ?? dayjs(endDate).subtract(60, "month").format("YYYY-MM-DD"); // 5y default
  const verbose = args.includes("--verbose");
  const budget = getArg("budget") ? Number(getArg("budget")) : US_DUAL_MOMENTUM_DEFAULTS.initialBudget;

  const config: USDualMomentumBacktestConfig = {
    ...US_DUAL_MOMENTUM_DEFAULTS,
    startDate,
    endDate,
    initialBudget: budget,
    verbose,
  };

  console.log("=".repeat(60));
  console.log("Dual Momentum (GEM) Backtest - US");
  console.log("=".repeat(60));
  console.log(`Period: ${startDate} ~ ${endDate}`);
  console.log(`Budget: $${budget.toLocaleString()}`);
  console.log(`Equity Universe: ${config.equityUniverse.join(", ")}`);
  console.log(`Risk-off Asset: ${config.riskOffAsset}`);
  console.log(`Lookback: ${config.lookbackDays}d (~${(config.lookbackDays / 21).toFixed(1)}m)`);
  console.log(`Rebalance: ${config.rebalanceDays}d | Abs threshold: ${config.absoluteMomentumThreshold}%`);

  console.log("\nLoading data...");
  const allTickers = [...config.equityUniverse, config.riskOffAsset];
  // lookback バッファ込みで取得
  const dataStart = dayjs(startDate).subtract(config.lookbackDays + 30, "day").format("YYYY-MM-DD");
  const etfMap = await fetchUSHistoricalFromDB(allTickers, dataStart, endDate, 0);
  for (const t of allTickers) {
    console.log(`  ${t}: ${etfMap.get(t)?.length ?? 0} days`);
  }

  const result = runUSDualMomentumBacktest(config, etfMap);
  const m = result.metrics;

  console.log("\n" + "=".repeat(60));
  console.log("Results");
  console.log("=".repeat(60));
  console.log(`Rebalances: ${m.rebalanceCount} | Switches: ${m.switchCount}`);
  console.log(`Closed Positions: ${m.totalTrades} | Wins: ${m.wins} | Losses: ${m.losses}`);
  console.log(`Win Rate: ${m.winRate.toFixed(2)}%`);
  console.log(`Profit Factor: ${m.profitFactor.toFixed(2)}`);
  console.log(`Expectancy: ${m.expectancy >= 0 ? "+" : ""}${m.expectancy.toFixed(2)}%`);
  console.log(`Avg Holding Days: ${m.avgHoldingDays.toFixed(1)}`);
  console.log(`Risk-off Days: ${m.riskOffDays}`);
  console.log(`Max Drawdown: ${m.maxDrawdown.toFixed(2)}%`);
  console.log(`Sharpe Ratio: ${m.sharpeRatio?.toFixed(2) ?? "N/A"}`);
  console.log("");
  console.log(`Asset Participation:`);
  for (const [t, p] of Object.entries(m.assetParticipation)) {
    console.log(`  ${t}: ${(p * 100).toFixed(1)}%`);
  }
  console.log("");
  console.log(`Gross P&L: $${m.totalGrossPnl.toFixed(2)}`);
  console.log(`Total Cost: $${m.totalCommission.toFixed(2)}`);
  console.log(`Net P&L: $${m.totalNetPnl.toFixed(2)}`);
  console.log(`Net Return: ${m.netReturnPct.toFixed(2)}%`);

  if (verbose) {
    console.log("\n" + "=".repeat(60));
    console.log("Rebalance Log");
    console.log("=".repeat(60));
    for (const r of result.rebalances) {
      const ranks = r.rankings.map((x) => `${x.ticker}:${x.momentum.toFixed(1)}%`).join(", ");
      console.log(`  ${r.date} | -> ${r.selectedAsset} (${r.selectedReason}) | ${ranks} ${r.switched ? "🔄" : ""}`);
    }
  }
}

main()
  .then(() => process.exit(0))
  .catch((e) => { console.error(e); process.exit(1); });
