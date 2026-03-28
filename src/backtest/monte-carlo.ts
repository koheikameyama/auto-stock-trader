/**
 * Monte Carlo Simulation for breakout strategy
 *
 * Bootstrap resampling of trade results to estimate:
 * - PF / expectancy / win rate confidence intervals
 * - MaxDD distribution (worst-case scenario)
 * - Ruin probability (chance of losing X% of capital)
 */

import type { SimulatedPosition } from "./types";

// ── Types ──────────────────────────────────────────

export interface MonteCarloConfig {
  iterations: number; // default 10,000
  maxPositions: number; // for position sizing fraction
  initialCapital: number; // for equity curve & ruin
  ruinThresholdPct: number; // % loss = "ruin" (default 50)
}

interface Percentiles {
  p5: number;
  p25: number;
  p50: number;
  p75: number;
  p95: number;
  mean: number;
}

export interface MonteCarloResult {
  iterations: number;
  tradeCount: number;

  pfDist: Percentiles;
  returnPctDist: Percentiles;
  maxDDDist: Percentiles;
  expectancyDist: Percentiles;
  winRateDist: Percentiles;

  ruinProbabilityPct: number;

  // Original (actual) values for comparison
  original: {
    pf: number;
    returnPct: number;
    maxDD: number;
    expectancy: number;
    winRate: number;
  };
}

// ── Helpers ────────────────────────────────────────

function percentiles(values: number[]): Percentiles {
  const sorted = [...values].sort((a, b) => a - b);
  const n = sorted.length;
  const sum = sorted.reduce((a, b) => a + b, 0);
  return {
    p5: sorted[Math.floor(n * 0.05)],
    p25: sorted[Math.floor(n * 0.25)],
    p50: sorted[Math.floor(n * 0.5)],
    p75: sorted[Math.floor(n * 0.75)],
    p95: sorted[Math.floor(n * 0.95)],
    mean: sum / n,
  };
}

/** Calculate PF, expectancy, winRate, return%, maxDD from a pnlPct sequence */
function calcIterationMetrics(
  sampled: number[],
  positionFraction: number,
  initialCapital: number,
): {
  pf: number;
  returnPct: number;
  maxDD: number;
  expectancy: number;
  winRate: number;
  finalEquity: number;
} {
  let grossProfit = 0;
  let grossLoss = 0;
  let wins = 0;

  for (const pnl of sampled) {
    if (pnl > 0) {
      grossProfit += pnl;
      wins++;
    } else if (pnl < 0) {
      grossLoss += Math.abs(pnl);
    }
  }

  const n = sampled.length;
  const losses = n - wins;
  const pf = grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? Infinity : 0;
  const winRate = n > 0 ? (wins / n) * 100 : 0;
  const avgWin = wins > 0 ? grossProfit / wins : 0;
  const avgLoss = losses > 0 ? -(grossLoss / losses) : 0;
  const expectancy = (winRate / 100) * avgWin + (1 - winRate / 100) * avgLoss;

  // Equity curve for MaxDD
  let equity = initialCapital;
  let peak = equity;
  let maxDD = 0;

  for (const pnl of sampled) {
    equity += equity * positionFraction * (pnl / 100);
    if (equity > peak) peak = equity;
    const dd = ((peak - equity) / peak) * 100;
    if (dd > maxDD) maxDD = dd;
  }

  const returnPct = ((equity - initialCapital) / initialCapital) * 100;

  return { pf, returnPct, maxDD, expectancy, winRate, finalEquity: equity };
}

// ── Main ───────────────────────────────────────────

export function runMonteCarloSimulation(
  trades: SimulatedPosition[],
  config: MonteCarloConfig,
): MonteCarloResult {
  // Extract closed trade P&L percentages
  const closedTrades = trades.filter(
    (t) => t.exitReason && t.exitReason !== "still_open" && t.pnlPct !== null,
  );
  const pnlPcts = closedTrades.map((t) => t.pnlPct!);
  const tradeCount = pnlPcts.length;
  const positionFraction = 1 / config.maxPositions;

  // Original metrics
  const orig = calcIterationMetrics(pnlPcts, positionFraction, config.initialCapital);

  // Bootstrap iterations
  const pfs: number[] = [];
  const returns: number[] = [];
  const maxDDs: number[] = [];
  const expectancies: number[] = [];
  const winRates: number[] = [];
  let ruinCount = 0;

  for (let i = 0; i < config.iterations; i++) {
    // Sample with replacement
    const sampled: number[] = [];
    for (let j = 0; j < tradeCount; j++) {
      sampled.push(pnlPcts[Math.floor(Math.random() * tradeCount)]);
    }

    const m = calcIterationMetrics(sampled, positionFraction, config.initialCapital);

    pfs.push(m.pf);
    returns.push(m.returnPct);
    maxDDs.push(m.maxDD);
    expectancies.push(m.expectancy);
    winRates.push(m.winRate);

    if (m.finalEquity <= config.initialCapital * (1 - config.ruinThresholdPct / 100)) {
      ruinCount++;
    }
  }

  return {
    iterations: config.iterations,
    tradeCount,
    pfDist: percentiles(pfs),
    returnPctDist: percentiles(returns),
    maxDDDist: percentiles(maxDDs),
    expectancyDist: percentiles(expectancies),
    winRateDist: percentiles(winRates),
    ruinProbabilityPct: (ruinCount / config.iterations) * 100,
    original: {
      pf: orig.pf,
      returnPct: orig.returnPct,
      maxDD: orig.maxDD,
      expectancy: orig.expectancy,
      winRate: orig.winRate,
    },
  };
}

// ── Print ──────────────────────────────────────────

export function printMonteCarloReport(result: MonteCarloResult): void {
  const SEP = "=".repeat(70);

  console.log(`\n${SEP}`);
  console.log(`  Monte Carlo Simulation (${result.iterations.toLocaleString()} iterations)`);
  console.log(`  Trade count: ${result.tradeCount} trades (bootstrap w/ replacement)`);
  console.log(SEP);

  // Header
  const hdr = `${"Metric".padEnd(18)}| ${"5%".padStart(8)} | ${"25%".padStart(8)} | ${"50%".padStart(8)} | ${"75%".padStart(8)} | ${"95%".padStart(8)} | ${"Actual".padStart(8)}`;
  console.log(`\n${hdr}`);
  console.log("-".repeat(hdr.length));

  // Rows
  const rows: { label: string; dist: typeof result.pfDist; actual: number; fmt: (v: number) => string }[] = [
    {
      label: "Profit Factor",
      dist: result.pfDist,
      actual: result.original.pf,
      fmt: (v) => (v === Infinity ? "   ∞" : v.toFixed(2)),
    },
    {
      label: "Expectancy(%)",
      dist: result.expectancyDist,
      actual: result.original.expectancy,
      fmt: (v) => (v >= 0 ? "+" : "") + v.toFixed(2),
    },
    {
      label: "Win Rate(%)",
      dist: result.winRateDist,
      actual: result.original.winRate,
      fmt: (v) => v.toFixed(1),
    },
    {
      label: "Return(%)",
      dist: result.returnPctDist,
      actual: result.original.returnPct,
      fmt: (v) => (v >= 0 ? "+" : "") + v.toFixed(1),
    },
    {
      label: "Max DD(%)",
      dist: result.maxDDDist,
      actual: result.original.maxDD,
      fmt: (v) => v.toFixed(1),
    },
  ];

  for (const row of rows) {
    const d = row.dist;
    console.log(
      `${row.label.padEnd(18)}| ${row.fmt(d.p5).padStart(8)} | ${row.fmt(d.p25).padStart(8)} | ${row.fmt(d.p50).padStart(8)} | ${row.fmt(d.p75).padStart(8)} | ${row.fmt(d.p95).padStart(8)} | ${row.fmt(row.actual).padStart(8)}`,
    );
  }

  console.log("");
  console.log(`  Ruin probability (${50}% loss): ${result.ruinProbabilityPct.toFixed(2)}%`);
  console.log(`  PF > 1.0 probability: ${((1 - findPercentileRank(result.pfDist, 1.0)) * 100).toFixed(1)}%`);
  console.log(`  PF > 1.3 probability: ${((1 - findPercentileRank(result.pfDist, 1.3)) * 100).toFixed(1)}%`);
  console.log(SEP);
}

// ── Compound Growth Simulation ─────────────────────

export interface CompoundGrowthConfig {
  iterations: number;
  years: number; // projection horizon (default 5)
  maxPositions: number;
  initialCapital: number;
}

export interface CompoundGrowthResult {
  iterations: number;
  years: number;
  initialCapital: number;
  tradesPerYear: number;
  /** equityByYear[y] = Percentiles of equity at end of year y (1-indexed) */
  equityByYear: Percentiles[];
  /** maxDDByYear[y] = Percentiles of max drawdown experienced up to year y */
  maxDDByYear: Percentiles[];
}

export function runCompoundGrowthSimulation(
  trades: SimulatedPosition[],
  config: CompoundGrowthConfig,
): CompoundGrowthResult {
  const closedTrades = trades.filter(
    (t) => t.exitReason && t.exitReason !== "still_open" && t.pnlPct !== null,
  );
  const pnlPcts = closedTrades.map((t) => t.pnlPct!);
  const tradesPerYear = pnlPcts.length;
  const positionFraction = 1 / config.maxPositions;

  // Per-year equity and maxDD collectors
  const equityCollectors: number[][] = Array.from({ length: config.years }, () => []);
  const ddCollectors: number[][] = Array.from({ length: config.years }, () => []);

  for (let i = 0; i < config.iterations; i++) {
    let equity = config.initialCapital;
    let peak = equity;
    let maxDD = 0;

    for (let y = 0; y < config.years; y++) {
      // Sample one year's worth of trades
      for (let t = 0; t < tradesPerYear; t++) {
        const pnl = pnlPcts[Math.floor(Math.random() * tradesPerYear)];
        equity += equity * positionFraction * (pnl / 100);
        if (equity > peak) peak = equity;
        const dd = ((peak - equity) / peak) * 100;
        if (dd > maxDD) maxDD = dd;
      }
      equityCollectors[y].push(equity);
      ddCollectors[y].push(maxDD);
    }
  }

  return {
    iterations: config.iterations,
    years: config.years,
    initialCapital: config.initialCapital,
    tradesPerYear,
    equityByYear: equityCollectors.map((v) => percentiles(v)),
    maxDDByYear: ddCollectors.map((v) => percentiles(v)),
  };
}

export function printCompoundGrowthReport(result: CompoundGrowthResult): void {
  const SEP = "=".repeat(78);
  const fmtYen = (v: number) => `¥${Math.round(v).toLocaleString()}`;

  console.log(`\n${SEP}`);
  console.log(`  Compound Growth Simulation (${result.iterations.toLocaleString()} iterations, ${result.years} years)`);
  console.log(`  Initial: ${fmtYen(result.initialCapital)} | ${result.tradesPerYear} trades/year | compound reinvestment`);
  console.log(SEP);

  // Equity table
  const hdr = `${"Year".padEnd(6)}| ${"5%(worst)".padStart(12)} | ${"25%".padStart(12)} | ${"50%(median)".padStart(12)} | ${"75%".padStart(12)} | ${"95%(best)".padStart(12)}`;
  console.log(`\n${hdr}`);
  console.log("-".repeat(hdr.length));

  // Year 0 row
  const initStr = fmtYen(result.initialCapital);
  console.log(
    `${"0".padEnd(6)}| ${initStr.padStart(12)} | ${initStr.padStart(12)} | ${initStr.padStart(12)} | ${initStr.padStart(12)} | ${initStr.padStart(12)}`,
  );

  for (let y = 0; y < result.years; y++) {
    const eq = result.equityByYear[y];
    console.log(
      `${String(y + 1).padEnd(6)}| ${fmtYen(eq.p5).padStart(12)} | ${fmtYen(eq.p25).padStart(12)} | ${fmtYen(eq.p50).padStart(12)} | ${fmtYen(eq.p75).padStart(12)} | ${fmtYen(eq.p95).padStart(12)}`,
    );
  }

  // CAGR from median
  const medianFinal = result.equityByYear[result.years - 1].p50;
  const cagr = (Math.pow(medianFinal / result.initialCapital, 1 / result.years) - 1) * 100;

  // Max DD table
  console.log(`\n${"Year".padEnd(6)}| ${"MaxDD 50%".padStart(10)} | ${"MaxDD 95%".padStart(10)}`);
  console.log("-".repeat(30));
  for (let y = 0; y < result.years; y++) {
    const dd = result.maxDDByYear[y];
    console.log(
      `${String(y + 1).padEnd(6)}| ${(dd.p50.toFixed(1) + "%").padStart(10)} | ${(dd.p95.toFixed(1) + "%").padStart(10)}`,
    );
  }

  console.log(`\n  Median CAGR: ${cagr >= 0 ? "+" : ""}${cagr.toFixed(1)}%`);
  console.log(`  Median ${result.years}Y equity: ${fmtYen(medianFinal)} (${((medianFinal / result.initialCapital - 1) * 100).toFixed(0)}% total)`);
  console.log(SEP);
}

/** Approximate percentile rank of a value in a distribution (0-1) */
function findPercentileRank(dist: { p5: number; p25: number; p50: number; p75: number; p95: number }, value: number): number {
  const points = [
    { pct: 0.05, val: dist.p5 },
    { pct: 0.25, val: dist.p25 },
    { pct: 0.5, val: dist.p50 },
    { pct: 0.75, val: dist.p75 },
    { pct: 0.95, val: dist.p95 },
  ];

  if (value <= points[0].val) return 0;
  if (value >= points[points.length - 1].val) return 1;

  for (let i = 0; i < points.length - 1; i++) {
    if (value >= points[i].val && value < points[i + 1].val) {
      const frac = (value - points[i].val) / (points[i + 1].val - points[i].val);
      return points[i].pct + frac * (points[i + 1].pct - points[i].pct);
    }
  }
  return 0.5;
}
