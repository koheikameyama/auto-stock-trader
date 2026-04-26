/**
 * SPY Credit Spread バックテスト CLI
 *
 * Usage:
 *   npx tsx src/backtest/us/us-credit-spread-run.ts
 *   npx tsx src/backtest/us/us-credit-spread-run.ts --start 2024-04-25 --end 2026-04-24 --verbose
 */

import dayjs from "dayjs";
import { US_CREDIT_SPREAD_DEFAULTS } from "./us-credit-spread-config";
import { runUSCreditSpreadBacktest } from "./us-credit-spread-simulation";
import { fetchSP500FromDB, fetchVixFromDB } from "./us-data-fetcher";
import type { USCreditSpreadBacktestConfig } from "./us-credit-spread-types";

async function main() {
  const args = process.argv.slice(2);
  const getArg = (name: string) => {
    const idx = args.indexOf(`--${name}`);
    return idx >= 0 && idx + 1 < args.length ? args[idx + 1] : undefined;
  };

  const endDate = getArg("end") ?? dayjs().format("YYYY-MM-DD");
  const startDate = getArg("start") ?? dayjs(endDate).subtract(24, "month").format("YYYY-MM-DD");
  const verbose = args.includes("--verbose");
  const budget = getArg("budget") ? Number(getArg("budget")) : US_CREDIT_SPREAD_DEFAULTS.initialBudget;
  const dte = getArg("dte") ? Number(getArg("dte")) : US_CREDIT_SPREAD_DEFAULTS.dte;
  const shortDelta = getArg("short-delta") ? Number(getArg("short-delta")) : US_CREDIT_SPREAD_DEFAULTS.shortPutDelta;
  const spreadWidth = getArg("spread-width") ? Number(getArg("spread-width")) : US_CREDIT_SPREAD_DEFAULTS.spreadWidth;
  const profitTarget = getArg("profit-target") ? Number(getArg("profit-target")) : US_CREDIT_SPREAD_DEFAULTS.profitTarget;

  const config: USCreditSpreadBacktestConfig = {
    ...US_CREDIT_SPREAD_DEFAULTS,
    startDate,
    endDate,
    initialBudget: budget,
    dte,
    shortPutDelta: shortDelta,
    spreadWidth,
    profitTarget,
    verbose,
  };

  console.log("=".repeat(60));
  console.log("SPY Credit Spread Backtest - US (Bull Put)");
  console.log("=".repeat(60));
  console.log(`Period: ${startDate} ~ ${endDate}`);
  console.log(`Budget: $${budget.toLocaleString()}`);
  console.log(`Underlying: ${config.underlyingSymbol} (^GSPC ÷ 10 proxy)`);
  console.log(`Short Delta: ${config.shortPutDelta} | Spread Width: $${config.spreadWidth} | DTE: ${config.dte}`);
  console.log(`Profit Target: ${(config.profitTarget * 100).toFixed(0)}% | StopLoss Mult: ${config.stopLossMultiplier || "OFF"}`);
  console.log(`Max Positions: ${config.maxPositions} | Contracts/Spread: ${config.contractsPerSpread}`);
  console.log(`VIX cap: ${config.vixCap} | Index trend SMA: ${config.indexTrendSmaPeriod}`);

  console.log("\nLoading data...");
  const gspcData = await fetchSP500FromDB(startDate, endDate);
  const vixData = await fetchVixFromDB(startDate, endDate);
  console.log(`  ^GSPC: ${gspcData.size} days`);
  console.log(`  VIX: ${vixData.size} days`);

  console.log("\nRunning backtest...");
  const result = await runUSCreditSpreadBacktest(config, gspcData, vixData);
  const m = result.metrics;

  console.log("\n" + "=".repeat(60));
  console.log("Results");
  console.log("=".repeat(60));
  console.log(`Total Spreads: ${m.totalSpreads}`);
  console.log(`  Expired Worthless: ${m.expiredWorthless} (max win)`);
  console.log(`  Profit Target Hits: ${m.profitTargetHits} (early close)`);
  console.log(`  Stop Loss Hits: ${m.stopLossHits}`);
  console.log(`  Expired Partial: ${m.totalSpreads - m.expiredWorthless - m.profitTargetHits - m.stopLossHits - m.maxLossCount}`);
  console.log(`  Max Loss: ${m.maxLossCount}`);
  console.log(`Win Rate: ${m.winRate.toFixed(2)}%`);
  console.log(`Profit Factor: ${m.profitFactor.toFixed(2)}`);
  console.log(`Expectancy: ${m.expectancy >= 0 ? "+" : ""}${m.expectancy.toFixed(2)}%`);
  console.log(`Avg Holding Days: ${m.avgHoldingDays.toFixed(1)}`);
  console.log(`Avg Credit Ratio: ${(m.avgCreditRatio * 100).toFixed(1)}% of width`);
  console.log(`Total Credit Received: $${m.totalCreditReceived.toFixed(2)}`);
  console.log(`Max Drawdown: ${m.maxDrawdown.toFixed(2)}%`);
  console.log(`Sharpe Ratio: ${m.sharpeRatio?.toFixed(2) ?? "N/A"}`);
  console.log("");
  console.log(`Gross P&L: $${m.totalGrossPnl.toFixed(2)}`);
  console.log(`Total Cost: $${m.totalCommission.toFixed(2)}`);
  console.log(`Net P&L: $${m.totalNetPnl.toFixed(2)}`);
  console.log(`Net Return: ${m.netReturnPct.toFixed(2)}%`);

  if (verbose && result.spreads.length > 0) {
    console.log("\n" + "=".repeat(60));
    console.log("Trade Log (last 30)");
    console.log("=".repeat(60));
    result.spreads.slice(-30).forEach((sp) => {
      console.log(
        `  ${sp.entryDate} -> ${sp.closeDate ?? "OPEN"} | shortK=${sp.shortStrike} longK=${sp.longStrike} | ` +
          `credit=$${sp.creditReceived.toFixed(2)} | reason=${sp.closeReason ?? "open"} | pnl=$${sp.netPnl?.toFixed(2) ?? "-"}`,
      );
    });
  }
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
