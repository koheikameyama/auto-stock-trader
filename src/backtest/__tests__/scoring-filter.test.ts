import {
  scoreAtrStability,
  scoreRangeContraction,
  scoreVolumeStability,
  calculateAtrCv,
  calculateVolumeCv,
  scoreMaAlignment,
  scoreWeeklyTrend,
  scoreTrendContinuity,
  countDaysAboveSma25,
} from "../scoring-filter";

import type { OHLCVData } from "../../core/technical-analysis";

describe("Risk Quality sub-scores", () => {
  describe("scoreAtrStability", () => {
    it("returns 10 for excellent stability (CV < 0.15)", () => {
      expect(scoreAtrStability(0.10)).toBe(10);
    });
    it("returns 7 for good stability (CV < 0.25)", () => {
      expect(scoreAtrStability(0.20)).toBe(7);
    });
    it("returns 4 for fair stability (CV < 0.35)", () => {
      expect(scoreAtrStability(0.30)).toBe(4);
    });
    it("returns 0 for poor stability (CV >= 0.35)", () => {
      expect(scoreAtrStability(0.50)).toBe(0);
    });
    it("returns 0 for null", () => {
      expect(scoreAtrStability(null)).toBe(0);
    });
  });

  describe("scoreRangeContraction", () => {
    it("returns 8 for strong squeeze (< 20th percentile)", () => {
      expect(scoreRangeContraction(15)).toBe(8);
    });
    it("returns 5 for moderate squeeze (< 40th)", () => {
      expect(scoreRangeContraction(30)).toBe(5);
    });
    it("returns 3 for mild squeeze (< 60th)", () => {
      expect(scoreRangeContraction(50)).toBe(3);
    });
    it("returns 0 for no squeeze (>= 60th)", () => {
      expect(scoreRangeContraction(70)).toBe(0);
    });
    it("returns 0 for null", () => {
      expect(scoreRangeContraction(null)).toBe(0);
    });
  });

  describe("scoreVolumeStability", () => {
    it("returns 7 for increasing + stable (CV < 0.5)", () => {
      expect(scoreVolumeStability(1200, 1000, 0.3)).toBe(7);
    });
    it("returns 5 for increasing + moderate (CV < 0.8)", () => {
      expect(scoreVolumeStability(1200, 1000, 0.6)).toBe(5);
    });
    it("returns 3 for not increasing + stable (CV < 0.5)", () => {
      expect(scoreVolumeStability(900, 1000, 0.3)).toBe(3);
    });
    it("returns 1 for not increasing + moderate (CV < 0.8)", () => {
      expect(scoreVolumeStability(900, 1000, 0.6)).toBe(1);
    });
    it("returns 0 for unstable (CV >= 0.8)", () => {
      expect(scoreVolumeStability(1200, 1000, 0.9)).toBe(0);
    });
    it("returns 0 for null inputs", () => {
      expect(scoreVolumeStability(null, null, null)).toBe(0);
    });
  });

  describe("calculateAtrCv", () => {
    it("returns null if fewer than 20 values", () => {
      expect(calculateAtrCv(Array(19).fill(100))).toBeNull();
    });
    it("returns 0 for constant ATR values", () => {
      expect(calculateAtrCv(Array(20).fill(100))).toBe(0);
    });
    it("returns a positive number for varying ATR values", () => {
      const values = Array.from({ length: 20 }, (_, i) => 100 + i * 5);
      const result = calculateAtrCv(values);
      expect(result).not.toBeNull();
      expect(result!).toBeGreaterThan(0);
    });
  });

  describe("calculateVolumeCv", () => {
    it("returns null if fewer than 25 values", () => {
      expect(calculateVolumeCv(Array(24).fill(1000))).toBeNull();
    });
    it("returns 0 for constant volumes", () => {
      expect(calculateVolumeCv(Array(25).fill(1000))).toBe(0);
    });
  });
});

describe("Trend Quality sub-scores", () => {
  describe("scoreMaAlignment", () => {
    it("returns 18 for perfect order (close > SMA5 > SMA25 > SMA75)", () => {
      expect(scoreMaAlignment(400, 380, 350, 300)).toBe(18);
    });
    it("returns 14 for close > SMA5 > SMA25 (no SMA75)", () => {
      expect(scoreMaAlignment(400, 380, 350, null)).toBe(14);
    });
    it("returns 14 for close > SMA5 > SMA25 (SMA75 present but broken)", () => {
      expect(scoreMaAlignment(400, 380, 350, 360)).toBe(14);
    });
    it("returns 8 for close > SMA25 but below SMA5", () => {
      expect(scoreMaAlignment(360, 380, 350, 300)).toBe(8);
    });
    it("returns 4 for pullback in uptrend (close < SMA25, close > SMA75, SMA25 > SMA75)", () => {
      expect(scoreMaAlignment(310, 360, 350, 300)).toBe(4);
    });
    it("returns 0 for close below all MAs", () => {
      expect(scoreMaAlignment(200, 380, 350, 300)).toBe(0);
    });
    it("returns 0 if SMA25 is null", () => {
      expect(scoreMaAlignment(400, 380, null, null)).toBe(0);
    });
  });

  describe("scoreWeeklyTrend", () => {
    it("returns 12 for above SMA13 + rising", () => {
      expect(scoreWeeklyTrend(1100, 1000, 990)).toBe(12);
    });
    it("returns 8 for above SMA13 + flat", () => {
      expect(scoreWeeklyTrend(1010, 1000, 999)).toBe(8);
    });
    it("returns 4 for below SMA13 + rising", () => {
      expect(scoreWeeklyTrend(990, 1000, 990)).toBe(4);
    });
    it("returns 0 for below SMA13 + falling", () => {
      expect(scoreWeeklyTrend(990, 1000, 1020)).toBe(0);
    });
    it("returns 0 if SMA13 is null", () => {
      expect(scoreWeeklyTrend(1000, null, null)).toBe(0);
    });
  });

  describe("scoreTrendContinuity", () => {
    it("returns 10 for sweet spot (10-30 days)", () => {
      expect(scoreTrendContinuity(15)).toBe(10);
      expect(scoreTrendContinuity(30)).toBe(10);
    });
    it("returns 7 for early trend (< 10 days)", () => {
      expect(scoreTrendContinuity(5)).toBe(7);
    });
    it("returns 5 for mature trend (31-50 days)", () => {
      expect(scoreTrendContinuity(40)).toBe(5);
    });
    it("returns 2 for over-mature trend (> 50 days)", () => {
      expect(scoreTrendContinuity(60)).toBe(2);
    });
    it("returns 0 for zero days", () => {
      expect(scoreTrendContinuity(0)).toBe(0);
    });
  });

  describe("countDaysAboveSma25", () => {
    it("returns 0 if data is too short", () => {
      const data: OHLCVData[] = Array.from({ length: 24 }, (_, i) => ({
        date: `2025-01-${String(i + 1).padStart(2, "0")}`,
        open: 100, high: 105, low: 95, close: 100, volume: 1000,
      }));
      expect(countDaysAboveSma25(data)).toBe(0);
    });
    it("counts consecutive days above SMA25 from newest", () => {
      // 25 bars at close=100, then 5 bars at close=200 (newest-first)
      const highBars: OHLCVData[] = Array.from({ length: 5 }, (_, i) => ({
        date: `2025-02-${String(5 - i).padStart(2, "0")}`,
        open: 200, high: 210, low: 190, close: 200, volume: 1000,
      }));
      const lowBars: OHLCVData[] = Array.from({ length: 25 }, (_, i) => ({
        date: `2025-01-${String(25 - i).padStart(2, "0")}`,
        open: 100, high: 105, low: 95, close: 100, volume: 1000,
      }));
      const data = [...highBars, ...lowBars]; // newest-first
      const result = countDaysAboveSma25(data);
      expect(result).toBeGreaterThan(0);
    });
  });
});
