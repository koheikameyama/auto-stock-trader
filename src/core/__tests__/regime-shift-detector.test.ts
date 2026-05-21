import { describe, it, expect } from "vitest";
import { formatRegimeShiftMessage, type RegimeShiftResult } from "../regime-shift-detector";

describe("formatRegimeShiftMessage", () => {
  it("全シグナルON のときは ✅ × 5", () => {
    const r: RegimeShiftResult = {
      isRegimeShift: true,
      asOfDate: new Date(2026, 5, 1),
      signals: {
        breadthInBand3Days: true,
        breadthRecovery20pp: true,
        nikkeiAboveSma50: true,
        nikkeiSma50Rising: true,
        vixLow: true,
      },
      current: {
        breadth: 0.65,
        breadthChange30d: 0.25,
        nikkei: 41000,
        nikkeiSma50: 39500,
        nikkeiSma50Slope10d: 0.012,
        vix: 18.5,
      },
      signalCount: 5,
    };
    const text = formatRegimeShiftMessage(r);
    const tickCount = (text.match(/✅/g) || []).length;
    expect(tickCount).toBe(5);
    expect(text).toContain("65.0%");
    expect(text).toContain("+25.0pp");
    expect(text).toContain("VIX: 18.5");
    expect(text).toContain("シグナルカウント: 5/5");
  });

  it("一部シグナル OFF を ❌ で表示", () => {
    const r: RegimeShiftResult = {
      isRegimeShift: false,
      asOfDate: new Date(2026, 4, 21),
      signals: {
        breadthInBand3Days: false,
        breadthRecovery20pp: false,
        nikkeiAboveSma50: true,
        nikkeiSma50Rising: false,
        vixLow: true,
      },
      current: {
        breadth: 0.328,
        breadthChange30d: -0.05,
        nikkei: 38000,
        nikkeiSma50: 38500,
        nikkeiSma50Slope10d: -0.005,
        vix: 18.0,
      },
      signalCount: 2,
    };
    const text = formatRegimeShiftMessage(r);
    const tickCount = (text.match(/✅/g) || []).length;
    const xCount = (text.match(/❌/g) || []).length;
    expect(tickCount).toBe(2);
    expect(xCount).toBe(3);
    expect(text).toContain("シグナルカウント: 2/5");
    expect(text).toContain("-5.0pp");
  });
});
