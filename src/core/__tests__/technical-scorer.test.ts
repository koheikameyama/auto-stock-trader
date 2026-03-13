import { describe, it, expect } from "vitest";
import {
  scoreRSI,
  scoreMA,
  scoreVolumeChange,
  scoreMACD,
  scoreRS,
  calculateRsScores,
  scoreChartPattern,
  scoreCandlestick,
  scoreTradingValue,
  scoreSpreadProxy,
  scoreStability,
  scorePER,
  scorePBR,
  scoreProfitability,
  scoreTechnicals,
} from "../technical-scorer";
import type { TechnicalSummary } from "../technical-analysis";
import type { OHLCVData } from "../technical-analysis";

// ========================================
// テスト用ヘルパー
// ========================================

function makeSummary(overrides: Partial<TechnicalSummary> = {}): TechnicalSummary {
  return {
    rsi: 55,
    sma5: 100,
    sma25: 95,
    sma75: 90,
    ema12: 100,
    ema26: 98,
    macd: { macd: 0.5, signal: 0.3, histogram: 0.2 },
    bollingerBands: { upper: 110, middle: 100, lower: 90 },
    atr14: 2,
    maAlignment: { trend: "uptrend", orderAligned: true, slopesAligned: true },
    deviationRate25: 5,
    signal: { signal: 1, strength: "buy", reasons: [] },
    supports: [],
    resistances: [],
    gap: { type: null, price: null, isFilled: false },
    trendlines: { support: null, resistance: null, overallTrend: "uptrend" },
    volumeAnalysis: { avgVolume20: 1000, currentVolume: 2000, volumeRatio: 2.0 },
    currentPrice: 500,
    previousClose: 498,
    ...overrides,
  };
}

function makeOHLCV(overrides: Partial<OHLCVData> = {}): OHLCVData {
  return {
    date: "2026-01-01",
    open: 100,
    high: 105,
    low: 95,
    close: 100,
    volume: 10000,
    ...overrides,
  };
}

// ========================================
// scoreRSI
// ========================================

describe("scoreRSI", () => {
  it("スイートスポット(50-65) → 12", () => {
    expect(scoreRSI(55)).toBe(12);
    expect(scoreRSI(50)).toBe(12);
    expect(scoreRSI(64)).toBe(12);
  });

  it("RSI 40-50: linear 4→12 (40→4, 45→8, 49→>=11)", () => {
    expect(scoreRSI(40)).toBe(4);
    expect(scoreRSI(45)).toBe(8);
    expect(scoreRSI(49)).toBeGreaterThanOrEqual(11);
  });

  it("RSI 65-75: linear 12→4 (65→12, 70→8, 74→<=5)", () => {
    expect(scoreRSI(65)).toBe(12);
    expect(scoreRSI(70)).toBe(8);
    expect(scoreRSI(74)).toBeLessThanOrEqual(5);
  });

  it("RSI 30-40: linear 0→4 (30→0, 35→2)", () => {
    expect(scoreRSI(30)).toBe(0);
    expect(scoreRSI(35)).toBe(2);
  });

  it("RSI <30 or >=75 → 0", () => {
    expect(scoreRSI(29)).toBe(0);
    expect(scoreRSI(75)).toBe(0);
    expect(scoreRSI(80)).toBe(0);
  });

  it("null → 0", () => {
    expect(scoreRSI(null)).toBe(0);
  });
});

// ========================================
// scoreMA
// ========================================

describe("scoreMA", () => {
  it("uptrend + order + slopes → 18", () => {
    const summary = makeSummary({
      maAlignment: { trend: "uptrend", orderAligned: true, slopesAligned: true },
    });
    expect(scoreMA(summary)).toBe(18);
  });

  it("uptrend + order → 14", () => {
    const summary = makeSummary({
      maAlignment: { trend: "uptrend", orderAligned: true, slopesAligned: false },
    });
    expect(scoreMA(summary)).toBe(14);
  });

  it("uptrend only → 10", () => {
    const summary = makeSummary({
      maAlignment: { trend: "uptrend", orderAligned: false, slopesAligned: false },
    });
    expect(scoreMA(summary)).toBe(10);
  });

  it("neutral (trend='none') → 6", () => {
    const summary = makeSummary({
      maAlignment: { trend: "none", orderAligned: false, slopesAligned: false },
    });
    expect(scoreMA(summary)).toBe(6);
  });

  it("downtrend + order + slopes → 0", () => {
    const summary = makeSummary({
      maAlignment: { trend: "downtrend", orderAligned: true, slopesAligned: true },
    });
    expect(scoreMA(summary)).toBe(0);
  });
});

// ========================================
// scoreVolumeChange
// ========================================

describe("scoreVolumeChange", () => {
  it("null → 0", () => {
    expect(scoreVolumeChange(null, "neutral")).toBe(0);
  });

  it("2.0 + accumulation → 13", () => {
    expect(scoreVolumeChange(2.0, "accumulation")).toBe(13);
  });

  it("1.0 + neutral → 5", () => {
    expect(scoreVolumeChange(1.0, "neutral")).toBe(5);
  });

  it("1.0 + distribution → 3", () => {
    expect(scoreVolumeChange(1.0, "distribution")).toBe(3);
  });

  it("0.5 + accumulation → 3", () => {
    // baseScore = 0.5 * 5 = 2.5, * 1.3 = 3.25 → 3
    expect(scoreVolumeChange(0.5, "accumulation")).toBe(3);
  });
});

// ========================================
// scoreMACD
// ========================================

describe("scoreMACD", () => {
  it("null macd → 0", () => {
    const summary = makeSummary({
      macd: { macd: null, signal: null, histogram: null },
    });
    expect(scoreMACD(summary, null)).toBe(0);
  });

  it("golden cross + positive histogram + accelerating (prev=0.3, hist=0.5) → 7", () => {
    const summary = makeSummary({
      macd: { macd: 0.5, signal: 0.3, histogram: 0.5 },
    });
    expect(scoreMACD(summary, 0.3)).toBe(7);
  });

  it("golden cross + positive histogram + decelerating (prev=0.5, hist=0.3) → 5", () => {
    const summary = makeSummary({
      macd: { macd: 0.5, signal: 0.3, histogram: 0.3 },
    });
    expect(scoreMACD(summary, 0.5)).toBe(5);
  });

  it("macd > signal but histogram negative → 3", () => {
    const summary = makeSummary({
      macd: { macd: 0.5, signal: 0.3, histogram: -0.1 },
    });
    expect(scoreMACD(summary, null)).toBe(3);
  });

  it("dead cross + improving (prev=-0.3, hist=-0.1) → 1", () => {
    const summary = makeSummary({
      macd: { macd: 0.2, signal: 0.4, histogram: -0.1 },
    });
    expect(scoreMACD(summary, -0.3)).toBe(1);
  });

  it("dead cross + worsening (prev=-0.3, hist=-0.5) → 0", () => {
    const summary = makeSummary({
      macd: { macd: 0.2, signal: 0.4, histogram: -0.5 },
    });
    expect(scoreMACD(summary, -0.3)).toBe(0);
  });
});

// ========================================
// scoreRS
// ========================================

describe("scoreRS", () => {
  it("undefined → 0", () => {
    expect(scoreRS(undefined)).toBe(0);
  });

  it("15 → 15", () => {
    expect(scoreRS(15)).toBe(15);
  });

  it("8 → 8", () => {
    expect(scoreRS(8)).toBe(8);
  });

  it("0 → 0", () => {
    expect(scoreRS(0)).toBe(0);
  });

  it("20 → 15 (clamped)", () => {
    expect(scoreRS(20)).toBe(15);
  });
});

// ========================================
// calculateRsScores
// ========================================

describe("calculateRsScores", () => {
  it("3 IT stocks + 1 金融 stock → IT best > IT worst, 金融 (1 stock) = 0", () => {
    const candidates = [
      { tickerCode: "1001", weekChangeRate: 5.0, sector: "IT" },
      { tickerCode: "1002", weekChangeRate: 2.0, sector: "IT" },
      { tickerCode: "1003", weekChangeRate: -1.0, sector: "IT" },
      { tickerCode: "2001", weekChangeRate: 3.0, sector: "金融" },
    ];
    const sectorAvgs: Record<string, number> = {
      IT: 2.0,
      金融: 3.0,
    };

    const result = calculateRsScores(candidates, sectorAvgs);

    // IT: 3 stocks >= MIN_SECTOR_STOCKS(2), so they get scores
    const it1 = result.get("1001")!; // highest RS: 5-2=3
    const it2 = result.get("1002")!; // RS: 2-2=0
    const it3 = result.get("1003")!; // lowest RS: -1-2=-3
    expect(it1).toBeGreaterThan(it3); // best > worst

    // 金融: only 1 stock < MIN_SECTOR_STOCKS(2) → 0
    expect(result.get("2001")).toBe(0);
  });
});

// ========================================
// scoreChartPattern
// ========================================

describe("scoreChartPattern", () => {
  it("empty → 0", () => {
    const result = scoreChartPattern([]);
    expect(result.score).toBe(0);
    expect(result.topPattern).toBeNull();
  });

  it("S rank buy → 10", () => {
    const result = scoreChartPattern([
      { pattern: "cup", patternName: "カップ", signal: "buy", rank: "S", winRate: 70, strength: 90, confidence: 0.8, description: "", explanation: "", startIndex: 0, endIndex: 10 },
    ]);
    expect(result.score).toBe(10);
  });

  it("neutral pattern → 4", () => {
    const result = scoreChartPattern([
      { pattern: "flag", patternName: "フラッグ", signal: "neutral", rank: "C", winRate: 50, strength: 50, confidence: 0.5, description: "", explanation: "", startIndex: 0, endIndex: 5 },
    ]);
    expect(result.score).toBe(4);
  });
});

// ========================================
// scoreCandlestick
// ========================================

describe("scoreCandlestick", () => {
  it("null → 0", () => {
    expect(scoreCandlestick(null)).toBe(0);
  });

  it("buy signal strength 80 → 4", () => {
    // Math.round(80 * 5 / 100) = Math.round(4) = 4
    expect(scoreCandlestick({ signal: "buy", strength: 80, pattern: "hammer", description: "ハンマー", learnMore: "" })).toBe(4);
  });
});

// ========================================
// scoreTradingValue
// ========================================

describe("scoreTradingValue", () => {
  it("6億円 (1000*600000) → 5", () => {
    // 600,000,000 >= 500,000,000 (tiers[0]) → scores[0] = 5
    expect(scoreTradingValue(1000, 600000)).toBe(5);
  });
});

// ========================================
// scoreSpreadProxy
// ========================================

describe("scoreSpreadProxy", () => {
  it("empty data → 0", () => {
    expect(scoreSpreadProxy([])).toBe(0);
  });
});

// ========================================
// scoreStability
// ========================================

describe("scoreStability", () => {
  it("empty data → 0", () => {
    expect(scoreStability([])).toBe(0);
  });
});

// ========================================
// scorePER
// ========================================

describe("scorePER", () => {
  it("null → 0", () => {
    expect(scorePER(null)).toBe(0);
  });

  it("PER 10 → 4", () => {
    // 5 <= 10 < 15 → score=4
    expect(scorePER(10)).toBe(4);
  });
});

// ========================================
// scorePBR
// ========================================

describe("scorePBR", () => {
  it("null → 0", () => {
    expect(scorePBR(null)).toBe(0);
  });
});

// ========================================
// scoreProfitability
// ========================================

describe("scoreProfitability", () => {
  it("null → 0", () => {
    expect(scoreProfitability(null, 500)).toBe(0);
  });
});

// ========================================
// scoreTechnicals (integration)
// ========================================

describe("scoreTechnicals", () => {
  function makeBaseOHLCV(count: number): OHLCVData[] {
    return Array.from({ length: count }, (_, i) => ({
      date: `2026-01-${String(i + 1).padStart(2, "0")}`,
      open: 500,
      high: 505,
      low: 495,
      close: 500,
      volume: 100000,
    }));
  }

  function makeBaseInput(overrides: Partial<Parameters<typeof scoreTechnicals>[0]> = {}) {
    return {
      summary: makeSummary(),
      chartPatterns: [],
      candlestickPattern: null,
      historicalData: makeBaseOHLCV(10),
      latestPrice: 500,
      latestVolume: 100000,
      weeklyVolatility: 3,
      ...overrides,
    };
  }

  it("totalScore <= 100 and > 0", () => {
    const result = scoreTechnicals(makeBaseInput());
    expect(result.totalScore).toBeGreaterThan(0);
    expect(result.totalScore).toBeLessThanOrEqual(100);
  });

  it("rsScore=12 → technical.rs = 12", () => {
    const result = scoreTechnicals(makeBaseInput({ rsScore: 12 }));
    expect(result.technical.rs).toBe(12);
  });

  it("rsScore=undefined → technical.rs = 0", () => {
    const result = scoreTechnicals(makeBaseInput({ rsScore: undefined }));
    expect(result.technical.rs).toBe(0);
  });

  it("latestPrice=5000 → totalScore=0, isDisqualified=true", () => {
    const result = scoreTechnicals(makeBaseInput({
      latestPrice: 5000,
      summary: makeSummary({ currentPrice: 5000 }),
    }));
    expect(result.totalScore).toBe(0);
    expect(result.isDisqualified).toBe(true);
  });

  it("technical.total <= 65", () => {
    const result = scoreTechnicals(makeBaseInput());
    expect(result.technical.total).toBeLessThanOrEqual(65);
  });
});
