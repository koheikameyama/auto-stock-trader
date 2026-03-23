import { describe, it, expect } from "vitest";
import { applyNikkeiFilter } from "../market-regime";
import type { NikkeiTrendResult } from "../market-regime";
import type { MarketRegime } from "../market-regime";

const baseRegime: MarketRegime = {
  level: "normal",
  vix: 18,
  maxPositions: 5,
  minScore: null,
  shouldHaltTrading: false,
  reason: "VIX正常",
};

describe("applyNikkeiFilter", () => {
  it("uptrend時はregimeを変更しない", () => {
    const nikkei: NikkeiTrendResult = {
      isUptrend: true,
      nikkeiClose: 40000,
      sma25: 38000,
      maxPositions: Infinity,
      minScore: null,
      reason: "Nikkei SMA上",
    };
    const result = applyNikkeiFilter(baseRegime, nikkei);
    expect(result).toEqual(baseRegime);
  });

  it("downtrend時はmaxPositionsを制限する", () => {
    const nikkei: NikkeiTrendResult = {
      isUptrend: false,
      nikkeiClose: 35000,
      sma25: 38000,
      maxPositions: 1,
      minScore: 75,
      reason: "Nikkei SMA下",
    };
    const result = applyNikkeiFilter(baseRegime, nikkei);
    expect(result.maxPositions).toBe(1);
    expect(result.minScore).toBe(75);
    expect(result.reason).toContain("Nikkei SMA下");
  });

  it("regime.minScoreがNikkeiより厳しい場合はregime側を維持", () => {
    const strictRegime: MarketRegime = { ...baseRegime, minScore: 80 };
    const nikkei: NikkeiTrendResult = {
      isUptrend: false,
      nikkeiClose: 35000,
      sma25: 38000,
      maxPositions: 1,
      minScore: 75,
      reason: "Nikkei SMA下",
    };
    const result = applyNikkeiFilter(strictRegime, nikkei);
    expect(result.minScore).toBe(80); // 80 > 75 なので regime 側を維持
  });

  it("regime.maxPositionsがNikkeiより厳しい場合はregime側を維持", () => {
    const haltRegime: MarketRegime = { ...baseRegime, maxPositions: 0 };
    const nikkei: NikkeiTrendResult = {
      isUptrend: false,
      nikkeiClose: 35000,
      sma25: 38000,
      maxPositions: 1,
      minScore: 75,
      reason: "Nikkei SMA下",
    };
    const result = applyNikkeiFilter(haltRegime, nikkei);
    expect(result.maxPositions).toBe(0); // 0 < 1 なので regime 側を維持
  });
});
