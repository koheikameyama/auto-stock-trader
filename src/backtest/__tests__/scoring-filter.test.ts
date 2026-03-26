import {
  scoreAtrStability,
  scoreRangeContraction,
  scoreVolumeStability,
  calculateAtrCv,
  calculateVolumeCv,
} from "../scoring-filter";

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
