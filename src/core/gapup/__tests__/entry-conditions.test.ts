import { isGapUpSignal } from "../entry-conditions";

describe("isGapUpSignal", () => {
  const base = {
    open: 1060,
    close: 1080,
    prevClose: 1000,
    volume: 300_000,
    avgVolume25: 100_000,
    gapMinPct: 0.03,
    volSurgeRatio: 1.5,
  };

  it("全条件を満たす場合 true", () => {
    expect(isGapUpSignal(base)).toBe(true);
  });

  it("ギャップ不足で false", () => {
    expect(isGapUpSignal({ ...base, open: 1020 })).toBe(false);
  });

  it("陰線引け（close < open）で false", () => {
    expect(isGapUpSignal({ ...base, close: 1050 })).toBe(false);
  });

  it("終値がギャップ閾値未満で false", () => {
    expect(isGapUpSignal({ ...base, close: 1025 })).toBe(false);
  });

  it("出来高不足で false", () => {
    expect(isGapUpSignal({ ...base, volume: 100_000 })).toBe(false);
  });

  it("prevClose=0 で false", () => {
    expect(isGapUpSignal({ ...base, prevClose: 0 })).toBe(false);
  });
});
