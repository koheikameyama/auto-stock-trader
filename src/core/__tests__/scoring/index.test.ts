import { describe, it, expect } from "vitest";
import { scoreStock } from "../../scoring";
import type { OHLCVData, TechnicalSummary } from "../../technical-analysis";

function makeOHLCV(count: number, close = 100): OHLCVData[] {
  return Array.from({ length: count }, (_, i) => ({
    date: `2026-01-${String(count - i).padStart(2, "0")}`,
    open: close,
    high: close + 5,
    low: close - 5,
    close,
    volume: 100000,
  }));
}

function makeSummary(overrides: Partial<TechnicalSummary> = {}): TechnicalSummary {
  return {
    rsi: 55, sma5: 102, sma25: 98, sma75: 95,
    ema12: 100, ema26: 98,
    macd: { macd: 0.5, signal: 0.3, histogram: 0.2 },
    bollingerBands: { upper: 110, middle: 100, lower: 90 },
    atr14: 2,
    maAlignment: { trend: "uptrend", orderAligned: true, slopesAligned: true },
    deviationRate25: 1.5,
    signal: { signal: 1, strength: "buy", reasons: [] },
    supports: [], resistances: [],
    gap: { type: null, price: null, isFilled: false },
    trendlines: { support: null, resistance: null, overallTrend: "uptrend" },
    volumeAnalysis: { avgVolume20: 100000, currentVolume: 120000, volumeRatio: 1.2 },
    currentPrice: 100, previousClose: 99,
    ...overrides,
  };
}

describe("scoreStock", () => {
  it("totalScore は 0-100 の範囲", () => {
    const result = scoreStock({
      historicalData: makeOHLCV(100),
      latestPrice: 100,
      latestVolume: 100000,
      weeklyVolatility: 3,
      summary: makeSummary(),
      avgVolume25: 100000,
    });
    expect(result.totalScore).toBeGreaterThanOrEqual(0);
    expect(result.totalScore).toBeLessThanOrEqual(100);
  });

  it("ゲート不合格 → totalScore=0, isDisqualified=true", () => {
    const result = scoreStock({
      historicalData: makeOHLCV(100),
      latestPrice: 5000, // 価格超過
      latestVolume: 100000,
      weeklyVolatility: 3,
      summary: makeSummary({ currentPrice: 5000 }),
      avgVolume25: 100000,
    });
    expect(result.totalScore).toBe(0);
    expect(result.isDisqualified).toBe(true);
    expect(result.gate.passed).toBe(false);
  });

  it("4カテゴリの合計が totalScore と一致", () => {
    const result = scoreStock({
      historicalData: makeOHLCV(100),
      latestPrice: 100,
      latestVolume: 100000,
      weeklyVolatility: 3,
      summary: makeSummary(),
      avgVolume25: 100000,
    });
    const expected = result.trendQuality.total + result.entryTiming.total + result.riskQuality.total + result.sectorMomentumScore;
    expect(result.totalScore).toBe(expected);
  });

  it("出来高不足のゲート → liquidity", () => {
    const result = scoreStock({
      historicalData: makeOHLCV(100),
      latestPrice: 100,
      latestVolume: 100000,
      weeklyVolatility: 3,
      summary: makeSummary(),
      avgVolume25: 10000, // 不足
    });
    expect(result.isDisqualified).toBe(true);
    expect(result.gate.failedGate).toBe("liquidity");
  });

  it("週足下降トレンド → weeklyDowntrend 即死", () => {
    // newest-first: 直近50日=80円、過去50日=120円 → 週足SMA13 > 直近週終値
    const baseDate = new Date("2026-01-01");
    const declining: OHLCVData[] = Array.from({ length: 100 }, (_, i) => {
      const close = i < 50 ? 80 : 120;
      const d = new Date(baseDate);
      d.setDate(baseDate.getDate() - i);
      return { date: d.toISOString().slice(0, 10), open: close, high: close + 5, low: close - 5, close, volume: 100000 };
    });
    const result = scoreStock({
      historicalData: declining,
      latestPrice: 80,
      latestVolume: 100000,
      weeklyVolatility: 3,
      summary: makeSummary({ currentPrice: 80, sma5: 80, sma25: 80 }),
      avgVolume25: 100000,
    });
    expect(result.isDisqualified).toBe(true);
    expect(result.gate.failedGate).toBe("weeklyDowntrend");
    expect(result.totalScore).toBe(0);
  });

  it("週足上昇トレンド → weeklyDowntrend 即死にならない", () => {
    // newest-first: 直近50日=120円、過去50日=80円 → 週足SMA13 < 直近週終値
    const baseDate = new Date("2026-01-01");
    const rising: OHLCVData[] = Array.from({ length: 100 }, (_, i) => {
      const close = i < 50 ? 120 : 80;
      const d = new Date(baseDate);
      d.setDate(baseDate.getDate() - i);
      return { date: d.toISOString().slice(0, 10), open: close, high: close + 5, low: close - 5, close, volume: 100000 };
    });
    const result = scoreStock({
      historicalData: rising,
      latestPrice: 120,
      latestVolume: 100000,
      weeklyVolatility: 3,
      summary: makeSummary({ currentPrice: 120, sma5: 120, sma25: 115, sma75: 110 }),
      avgVolume25: 100000,
    });
    expect(result.gate.failedGate).not.toBe("weeklyDowntrend");
  });

  it("各サブスコアが非負", () => {
    const result = scoreStock({
      historicalData: makeOHLCV(100),
      latestPrice: 100,
      latestVolume: 100000,
      weeklyVolatility: 3,
      summary: makeSummary(),
      avgVolume25: 100000,
    });
    expect(result.trendQuality.maAlignment).toBeGreaterThanOrEqual(0);
    expect(result.trendQuality.weeklyTrend).toBeGreaterThanOrEqual(0);
    expect(result.trendQuality.trendContinuity).toBeGreaterThanOrEqual(0);
    expect(result.entryTiming.pullbackDepth).toBeGreaterThanOrEqual(0);
    expect(result.entryTiming.priorBreakout).toBeGreaterThanOrEqual(0);
    expect(result.entryTiming.candlestickSignal).toBeGreaterThanOrEqual(0);
    expect(result.riskQuality.atrStability).toBeGreaterThanOrEqual(0);
    expect(result.riskQuality.rangeContraction).toBeGreaterThanOrEqual(0);
    expect(result.riskQuality.volumeStability).toBeGreaterThanOrEqual(0);
  });
});
