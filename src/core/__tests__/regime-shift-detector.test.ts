import { describe, it, expect } from "vitest";
import {
  determineLevel,
  formatBullMarketMessage,
  type BullMarketResult,
} from "../regime-shift-detector";

describe("determineLevel", () => {
  it("5/5 は STRONG_BULL", () => expect(determineLevel(5)).toBe("STRONG_BULL"));
  it("4/5 は MODERATE_BULL", () => expect(determineLevel(4)).toBe("MODERATE_BULL"));
  it("3/5 は EARLY_SIGNAL", () => expect(determineLevel(3)).toBe("EARLY_SIGNAL"));
  it("2/5 は NEUTRAL", () => expect(determineLevel(2)).toBe("NEUTRAL"));
  it("0/5 は NEUTRAL", () => expect(determineLevel(0)).toBe("NEUTRAL"));
});

describe("formatBullMarketMessage", () => {
  function build(signalCount: number, allOn = false): BullMarketResult {
    const onCount = signalCount;
    const signals = {
      breadthAboveThreshold5Days: onCount > 0,
      breadthRecovery10pp: onCount > 1,
      nikkeiAboveSma50: onCount > 2,
      nikkeiSma50Rising: onCount > 3,
      vixLow: onCount > 4 || allOn,
    };
    return {
      asOfDate: new Date(2026, 5, 1),
      level: determineLevel(signalCount),
      signalCount,
      signals,
      current: {
        breadth: 0.65,
        breadthChange30d: 0.15,
        nikkei: 41000,
        nikkeiSma50: 39500,
        nikkeiSma50Slope10d: 0.012,
        vix: 18.5,
      },
    };
  }

  it("5/5 で 🔥 大強気相場 ラベル + 全 ✅", () => {
    const text = formatBullMarketMessage(build(5));
    expect(text).toContain("🔥");
    expect(text).toContain("大強気相場");
    expect((text.match(/✅/g) || []).length).toBe(5);
  });

  it("4/5 で 🟢 強気優勢 ラベル + 4 ✅ 1 ❌", () => {
    const text = formatBullMarketMessage(build(4));
    expect(text).toContain("🟢");
    expect(text).toContain("強気優勢");
    expect((text.match(/✅/g) || []).length).toBe(4);
    expect((text.match(/❌/g) || []).length).toBe(1);
  });

  it("0/5 で ⚪ 中立 ラベル + 全 ❌", () => {
    const text = formatBullMarketMessage(build(0));
    expect(text).toContain("⚪");
    expect(text).toContain("中立");
    expect((text.match(/❌/g) || []).length).toBe(5);
  });
});
