import { describe, it, expect } from "vitest";
import {
  scorePullbackDepth,
  scoreBreakout,
  scoreCandlestickSignal,
} from "../../scoring/entry-timing";
import type { OHLCVData } from "../../technical-analysis";

function makeBar(overrides: Partial<OHLCVData> = {}): OHLCVData {
  return { date: "2026-01-01", open: 100, high: 105, low: 95, close: 100, volume: 10000, ...overrides };
}

describe("scorePullbackDepth", () => {
  it("SMA25付近(-1%~+2%) + 反発サイン → 15", () => {
    const bars = [
      makeBar({ open: 96, high: 100, low: 93, close: 99 }),
      makeBar({ close: 95 }),
    ];
    const result = scorePullbackDepth(99, 98, 100, 1.0, bars);
    expect(result).toBe(15);
  });

  it("SMA5-SMA25間（浅い押し目） → 10", () => {
    const bars = [makeBar({ close: 97 }), makeBar()];
    const result = scorePullbackDepth(97, 100, 95, 2.1, bars);
    expect(result).toBe(10);
  });

  it("SMA5上（押してない）→ 3", () => {
    const bars = [makeBar(), makeBar()];
    const result = scorePullbackDepth(100, 98, 90, 11.1, bars);
    expect(result).toBe(3);
  });

  it("SMA25大幅下（乖離-3%超） → 0", () => {
    const bars = [makeBar(), makeBar()];
    const result = scorePullbackDepth(90, 95, 100, -10.0, bars);
    expect(result).toBe(0);
  });
});

describe("scoreBreakout", () => {
  it("20日高値更新 + 出来高1.5倍超 → 12", () => {
    const bars: OHLCVData[] = [];
    for (let i = 0; i < 25; i++) {
      bars.push(makeBar({ close: 100 + (i === 0 ? 10 : 0), volume: i === 0 ? 20000 : 10000 }));
    }
    const result = scoreBreakout(bars, 10000);
    expect(result).toBe(12);
  });

  it("高値更新なし → 0", () => {
    const bars = Array.from({ length: 25 }, () => makeBar());
    const result = scoreBreakout(bars, 10000);
    expect(result).toBe(0);
  });
});

describe("scoreCandlestickSignal", () => {
  it("包み足（陽線）+ 出来高増加 → 8", () => {
    const bars = [
      makeBar({ open: 95, close: 105, high: 106, low: 94, volume: 20000 }),
      makeBar({ open: 102, close: 97, high: 103, low: 96, volume: 10000 }),
    ];
    const result = scoreCandlestickSignal(bars, 10000);
    expect(result).toBe(8);
  });

  it("連続陽線（3本）+ 出来高漸増 → 5", () => {
    const bars = [
      makeBar({ open: 100, close: 103, volume: 15000 }),
      makeBar({ open: 98, close: 101, volume: 12000 }),
      makeBar({ open: 96, close: 99, volume: 10000 }),
    ];
    const result = scoreCandlestickSignal(bars, 20000);
    expect(result).toBe(5);
  });

  it("シグナルなし → 0", () => {
    const bars = [
      makeBar({ open: 100, close: 101, volume: 10000 }),
      makeBar({ open: 100, close: 101, volume: 10000 }),
    ];
    const result = scoreCandlestickSignal(bars, 10000);
    expect(result).toBe(0);
  });
});
