/**
 * VIX Contango バックテスト CLI
 *
 * Usage:
 *   npx tsx src/backtest/us/us-vix-contango-run.ts
 *   npx tsx src/backtest/us/us-vix-contango-run.ts --start 2021-05-01 --end 2026-04-24 --verbose
 */

import dayjs from "dayjs";
import { US_VIX_CONTANGO_DEFAULTS } from "./us-vix-contango-config";
import { runUSVixContangoBacktest } from "./us-vix-contango-simulation";
import { fetchUSHistoricalFromDB, fetchVixFromDB } from "./us-data-fetcher";
import type { USVixContangoBacktestConfig } from "./us-vix-contango-types";

async function main() {
  const args = process.argv.slice(2);
  const getArg = (n: string) => {
    const i = args.indexOf(`--${n}`);
    return i >= 0 && i + 1 < args.length ? args[i + 1] : undefined;
  };

  const endDate = getArg("end") ?? dayjs().format("YYYY-MM-DD");
  const startDate = getArg("start") ?? dayjs(endDate).subtract(24, "month").format("YYYY-MM-DD");
  const verbose = args.includes("--verbose");
  const budget = getArg("budget") ? Number(getArg("budget")) : US_VIX_CONTANGO_DEFAULTS.initialBudget;
  const ticker = (getArg("ticker") as "SVXY" | "SVIX") ?? US_VIX_CONTANGO_DEFAULTS.underlyingTicker;

  const config: USVixContangoBacktestConfig = {
    ...US_VIX_CONTANGO_DEFAULTS,
    startDate,
    endDate,
    initialBudget: budget,
    underlyingTicker: ticker,
    verbose,
  };

  console.log("=".repeat(60));
  console.log(`VIX Contango Backtest - US (${ticker})`);
  console.log("=".repeat(60));
  console.log(`Period: ${startDate} ~ ${endDate}`);
  console.log(`Budget: $${budget.toLocaleString()}`);
  console.log(`Underlying: ${ticker}`);
  console.log(`VIX entry <= ${config.vixEntryUpperBound} | exit > ${config.vixExitUpperBound} | spike > ${config.vixSpikeThreshold}%`);
  console.log(`StopLoss: ${config.stopLossPct}% | Cooldown: ${config.reentryCooldownDays}d`);

  console.log("\nLoading data...");
  const etfMap = await fetchUSHistoricalFromDB([ticker], startDate, endDate);
  const etfData = etfMap.get(ticker) ?? [];
  const vixData = await fetchVixFromDB(startDate, endDate);
  console.log(`  ${ticker}: ${etfData.length} days`);
  console.log(`  VIX: ${vixData.size} days`);

  if (etfData.length === 0) {
    console.error(`No ${ticker} data. Run backfill first.`);
    process.exit(1);
  }

  const result = runUSVixContangoBacktest(config, etfData, vixData);
  const m = result.metrics;

  console.log("\n" + "=".repeat(60));
  console.log("Results");
  console.log("=".repeat(60));
  console.log(`Total Positions: ${m.totalTrades + (result.positions.length - m.totalTrades)}`);
  console.log(`Closed: ${m.totalTrades} | Wins: ${m.wins} | Losses: ${m.losses} | Open: ${m.stillOpen}`);
  console.log(`  vix_cap exits: ${m.vixCapExits}`);
  console.log(`  vix_spike exits: ${m.vixSpikeExits}`);
  console.log(`  stop_loss exits: ${m.stopLossExits}`);
  console.log(`Win Rate: ${m.winRate.toFixed(2)}%`);
  console.log(`Profit Factor: ${m.profitFactor.toFixed(2)}`);
  console.log(`Expectancy: ${m.expectancy >= 0 ? "+" : ""}${m.expectancy.toFixed(2)}%`);
  console.log(`Avg Win: +${m.avgWinPct.toFixed(2)}% | Avg Loss: ${m.avgLossPct.toFixed(2)}%`);
  console.log(`Avg Holding Days: ${m.avgHoldingDays.toFixed(1)}`);
  console.log(`Avg Entry VIX: ${m.avgEntryVix.toFixed(2)}`);
  console.log(`Market Participation: ${(m.marketParticipationRate * 100).toFixed(1)}%`);
  console.log(`Max Drawdown: ${m.maxDrawdown.toFixed(2)}%`);
  console.log(`Sharpe Ratio: ${m.sharpeRatio?.toFixed(2) ?? "N/A"}`);
  console.log("");
  console.log(`Gross P&L: $${m.totalGrossPnl.toFixed(2)}`);
  console.log(`Total Cost: $${m.totalCommission.toFixed(2)}`);
  console.log(`Net P&L: $${m.totalNetPnl.toFixed(2)}`);
  console.log(`Net Return: ${m.netReturnPct.toFixed(2)}%`);

  if (verbose && result.positions.length > 0) {
    console.log("\n" + "=".repeat(60));
    console.log("Trade Log (last 30)");
    console.log("=".repeat(60));
    result.positions.slice(-30).forEach((p) => {
      console.log(
        `  ${p.entryDate} -> ${p.exitDate ?? "OPEN"} | VIX ${p.entryVix.toFixed(1)} -> ${p.exitVix?.toFixed(1) ?? "-"} | ` +
          `$${p.entryPrice.toFixed(2)} -> $${p.exitPrice?.toFixed(2) ?? "-"} | ${p.exitReason} | pnl=$${p.netPnl?.toFixed(2) ?? "-"}`,
      );
    });
  }
}

main()
  .then(() => process.exit(0))
  .catch((e) => { console.error(e); process.exit(1); });
