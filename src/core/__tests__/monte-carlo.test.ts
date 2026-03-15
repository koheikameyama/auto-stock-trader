import { describe, it, expect } from "vitest";
import {
  runMonteCarloSimulation,
  type MonteCarloConfig,
  type MonteCarloResult,
} from "../monte-carlo";

function makeConfig(overrides: Partial<MonteCarloConfig> = {}): MonteCarloConfig {
  return {
    tradeReturns: [3.0, -2.5, 5.0, -3.0, 2.0, -1.5, 4.0, -2.0, 1.0, -2.8],
    initialBudget: 300000,
    numPaths: 100,
    tradesPerPath: 50,
    ruinThresholdPct: 50,
    riskPerTradePct: 2,
    avgStopLossPct: 2.5,
    ...overrides,
  };
}

describe("runMonteCarloSimulation", () => {
  it("returns valid result structure", () => {
    const result = runMonteCarloSimulation(makeConfig());

    expect(result.totalPaths).toBe(100);
    expect(result.ruinProbability).toBeGreaterThanOrEqual(0);
    expect(result.ruinProbability).toBeLessThanOrEqual(1);
    expect(result.ruinedPaths).toBeGreaterThanOrEqual(0);
    expect(result.ruinedPaths).toBeLessThanOrEqual(100);

    // finalEquityPercentiles are ordered
    expect(result.finalEquityPercentiles.p5).toBeLessThanOrEqual(
      result.finalEquityPercentiles.p25,
    );
    expect(result.finalEquityPercentiles.p25).toBeLessThanOrEqual(
      result.finalEquityPercentiles.p50,
    );
    expect(result.finalEquityPercentiles.p50).toBeLessThanOrEqual(
      result.finalEquityPercentiles.p75,
    );
    expect(result.finalEquityPercentiles.p75).toBeLessThanOrEqual(
      result.finalEquityPercentiles.p95,
    );

    // maxDrawdownPercentiles are non-negative
    expect(result.maxDrawdownPercentiles.p5).toBeGreaterThanOrEqual(0);
    expect(result.maxDrawdownPercentiles.p50).toBeGreaterThanOrEqual(0);
    expect(result.maxDrawdownPercentiles.p95).toBeGreaterThanOrEqual(0);

    // thresholdBreachRates: dd10 >= dd20 >= dd30 >= dd50
    expect(result.thresholdBreachRates.dd10).toBeGreaterThanOrEqual(
      result.thresholdBreachRates.dd20,
    );
    expect(result.thresholdBreachRates.dd20).toBeGreaterThanOrEqual(
      result.thresholdBreachRates.dd30,
    );
    expect(result.thresholdBreachRates.dd30).toBeGreaterThanOrEqual(
      result.thresholdBreachRates.dd50,
    );
  });

  it("equity curves have correct length", () => {
    const config = makeConfig({ tradesPerPath: 50 });
    const result = runMonteCarloSimulation(config);

    const expectedLen = 51;
    expect(result.equityCurves.p5.length).toBe(expectedLen);
    expect(result.equityCurves.p50.length).toBe(expectedLen);
    expect(result.equityCurves.p95.length).toBe(expectedLen);

    expect(result.equityCurves.p5[0]).toBe(300000);
    expect(result.equityCurves.p50[0]).toBe(300000);
    expect(result.equityCurves.p95[0]).toBe(300000);
  });

  it("downsamples equity curves when tradesPerPath > 200", () => {
    const config = makeConfig({ tradesPerPath: 500 });
    const result = runMonteCarloSimulation(config);

    expect(result.equityCurves.p50.length).toBeLessThanOrEqual(201);
  });

  it("100% loss trades cause high ruin probability", () => {
    const config = makeConfig({
      tradeReturns: [-5.0, -4.0, -6.0, -3.0, -5.5],
      numPaths: 500,
      tradesPerPath: 200,
    });
    const result = runMonteCarloSimulation(config);

    expect(result.ruinProbability).toBeGreaterThan(0.5);
  });

  it("100% win trades cause zero ruin probability", () => {
    const config = makeConfig({
      tradeReturns: [3.0, 2.0, 4.0, 5.0, 2.5],
      numPaths: 500,
      tradesPerPath: 200,
    });
    const result = runMonteCarloSimulation(config);

    expect(result.ruinProbability).toBe(0);
    expect(result.ruinedPaths).toBe(0);
  });

  it("ruined paths have equity set to 0 after ruin", () => {
    const config = makeConfig({
      tradeReturns: [-10.0],
      numPaths: 10,
      tradesPerPath: 100,
      ruinThresholdPct: 50,
      riskPerTradePct: 5,
      avgStopLossPct: 10.0,
    });
    const result = runMonteCarloSimulation(config);

    const lastIdx = result.equityCurves.p5.length - 1;
    expect(result.equityCurves.p5[lastIdx]).toBe(0);
  });

  it("inputStats reflects the input data correctly", () => {
    const returns = [3.0, -2.5, 5.0, -3.0, 2.0];
    const config = makeConfig({ tradeReturns: returns });
    const result = runMonteCarloSimulation(config);

    expect(result.inputStats.totalTrades).toBe(5);
    expect(result.inputStats.winRate).toBeCloseTo(60, 0);
    expect(result.inputStats.avgWinPct).toBeCloseTo(
      (3.0 + 5.0 + 2.0) / 3,
      2,
    );
    expect(result.inputStats.avgLossPct).toBeCloseTo(
      (-2.5 + -3.0) / 2,
      2,
    );
    expect(result.inputStats.expectancy).toBeCloseTo(
      (3.0 + -2.5 + 5.0 + -3.0 + 2.0) / 5,
      2,
    );
  });

  it("throws on empty tradeReturns", () => {
    const config = makeConfig({ tradeReturns: [] });
    expect(() => runMonteCarloSimulation(config)).toThrow();
  });

  it("throws on avgStopLossPct = 0", () => {
    const config = makeConfig({ avgStopLossPct: 0 });
    expect(() => runMonteCarloSimulation(config)).toThrow();
  });
});
