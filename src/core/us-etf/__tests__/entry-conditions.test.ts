import { describe, it, expect } from "vitest";
import {
  detectUSEtfSignal,
  US_ETF_SIGNAL_DEFAULTS,
} from "../entry-conditions";

function build(overrides: Partial<Parameters<typeof detectUSEtfSignal>[0]> = {}) {
  return {
    ticker: "1547",
    todayOpen: 4020,
    todayHigh: 4060,
    todayLow: 4010,
    todayClose: 4050,
    todayVolume: 200_000,
    prevClose: 4000,
    avgVolume25: 100_000,
    japanBreadth: 0.30,
    ...overrides,
  };
}

describe("detectUSEtfSignal", () => {
  it("全条件揃えば triggered=true", () => {
    const r = detectUSEtfSignal(build());
    expect(r.triggered).toBe(true);
    expect(r.gap).toBeCloseTo(0.005, 3);
    expect(r.isUpDay).toBe(true);
    expect(r.volSurge).toBe(2);
    expect(r.breadthOk).toBe(true);
    expect(r.rejectReasons).toEqual([]);
  });

  it("gap < 0.5% で reject", () => {
    const r = detectUSEtfSignal(build({ todayOpen: 4010 })); // gap = 0.25%
    expect(r.triggered).toBe(false);
    expect(r.rejectReasons[0]).toContain("gap");
  });

  it("陰線で reject", () => {
    const r = detectUSEtfSignal(build({ todayClose: 4010, todayOpen: 4020 }));
    expect(r.triggered).toBe(false);
    expect(r.rejectReasons).toContain("陽線でない");
  });

  it("出来高サージ不足で reject", () => {
    const r = detectUSEtfSignal(build({ todayVolume: 100_000 }));
    expect(r.triggered).toBe(false);
    expect(r.rejectReasons.some((s) => s.includes("vol"))).toBe(true);
  });

  it("breadth >= 54% (idle帯外) で reject", () => {
    const r = detectUSEtfSignal(build({ japanBreadth: 0.60 }));
    expect(r.triggered).toBe(false);
    expect(r.rejectReasons.some((s) => s.includes("breadth"))).toBe(true);
  });

  it("複数条件 reject で全 reason が並ぶ", () => {
    const r = detectUSEtfSignal(
      build({ todayOpen: 4010, todayClose: 4005, japanBreadth: 0.70 }),
    );
    expect(r.triggered).toBe(false);
    expect(r.rejectReasons.length).toBeGreaterThanOrEqual(3);
  });

  it("avgVolume25 = 0 のとき volSurge 0", () => {
    const r = detectUSEtfSignal(build({ avgVolume25: 0 }));
    expect(r.volSurge).toBe(0);
    expect(r.triggered).toBe(false);
  });

  it("デフォルトパラメータが正しい", () => {
    expect(US_ETF_SIGNAL_DEFAULTS.gapMinPct).toBe(0.005);
    expect(US_ETF_SIGNAL_DEFAULTS.volumeSurgeRatio).toBe(1.5);
    expect(US_ETF_SIGNAL_DEFAULTS.breadthMax).toBe(0.54);
  });
});
