import { describe, it, expect } from "vitest";
import {
  scoreAtrStability,
  scoreRangeContraction,
  scoreVolumeStability,
  calculateAtrCv,
  calculateVolumeCv,
} from "../../scoring/risk-quality";

describe("scoreAtrStability", () => {
  it("CV < 0.15 → 10", () => {
    expect(scoreAtrStability(0.10)).toBe(10);
  });

  it("CV 0.15-0.25 → 7", () => {
    expect(scoreAtrStability(0.20)).toBe(7);
  });

  it("CV 0.25-0.35 → 4", () => {
    expect(scoreAtrStability(0.30)).toBe(4);
  });

  it("CV > 0.35 → 0", () => {
    expect(scoreAtrStability(0.40)).toBe(0);
  });

  it("null → 0", () => {
    expect(scoreAtrStability(null)).toBe(0);
  });
});

describe("scoreRangeContraction", () => {
  it("下位20% → 8", () => {
    expect(scoreRangeContraction(10)).toBe(8);
  });

  it("下位20-40% → 5", () => {
    expect(scoreRangeContraction(30)).toBe(5);
  });

  it("中央 → 3", () => {
    expect(scoreRangeContraction(50)).toBe(3);
  });

  it("上位40%(60以上) → 0", () => {
    expect(scoreRangeContraction(70)).toBe(0);
  });

  it("null → 0", () => {
    expect(scoreRangeContraction(null)).toBe(0);
  });
});

describe("scoreVolumeStability", () => {
  it("5日MA > 25日MA & CV < 0.5 → 7 (増加+安定)", () => {
    expect(scoreVolumeStability(15000, 10000, 0.3)).toBe(7);
  });

  it("5日MA > 25日MA & CV 0.5-0.8 → 5 (増加+やや安定)", () => {
    expect(scoreVolumeStability(15000, 10000, 0.6)).toBe(5);
  });

  it("5日MA <= 25日MA & CV < 0.5 → 3 (安定のみ)", () => {
    expect(scoreVolumeStability(8000, 10000, 0.3)).toBe(3);
  });

  it("5日MA <= 25日MA & CV 0.5-0.8 → 1 (やや安定)", () => {
    expect(scoreVolumeStability(8000, 10000, 0.6)).toBe(1);
  });

  it("CV >= 0.8 → 0 (不安定)", () => {
    expect(scoreVolumeStability(15000, 10000, 0.9)).toBe(0);
  });

  it("null入力 → 0", () => {
    expect(scoreVolumeStability(null, null, null)).toBe(0);
  });
});

describe("calculateAtrCv", () => {
  it("データ不足(20未満) → null", () => {
    expect(calculateAtrCv([1, 2, 3])).toBeNull();
  });

  it("全て同じ値 → 0", () => {
    const values = Array.from({ length: 20 }, () => 5);
    expect(calculateAtrCv(values)).toBe(0);
  });
});

describe("calculateVolumeCv", () => {
  it("データ不足(25未満) → null", () => {
    expect(calculateVolumeCv([100, 200])).toBeNull();
  });

  it("全て同じ値 → 0", () => {
    const values = Array.from({ length: 25 }, () => 10000);
    expect(calculateVolumeCv(values)).toBe(0);
  });
});
