import { describe, it, expect } from "vitest";
import { scoreSectorMomentum } from "../../scoring/sector-momentum";

describe("scoreSectorMomentum", () => {
  it(">= +3.0% → 5", () => {
    expect(scoreSectorMomentum(3.5)).toBe(5);
    expect(scoreSectorMomentum(3.0)).toBe(5);
  });

  it(">= +1.5% → 4", () => {
    expect(scoreSectorMomentum(2.0)).toBe(4);
    expect(scoreSectorMomentum(1.5)).toBe(4);
  });

  it(">= +0.5% → 3", () => {
    expect(scoreSectorMomentum(1.0)).toBe(3);
    expect(scoreSectorMomentum(0.5)).toBe(3);
  });

  it(">= -0.5% → 2", () => {
    expect(scoreSectorMomentum(0.0)).toBe(2);
    expect(scoreSectorMomentum(-0.5)).toBe(2);
  });

  it(">= -2.0% → 1", () => {
    expect(scoreSectorMomentum(-1.0)).toBe(1);
    expect(scoreSectorMomentum(-2.0)).toBe(1);
  });

  it("< -2.0% → 0", () => {
    expect(scoreSectorMomentum(-2.5)).toBe(0);
    expect(scoreSectorMomentum(-5.0)).toBe(0);
  });

  it("null → DEFAULT_SCORE (2)", () => {
    expect(scoreSectorMomentum(null)).toBe(2);
  });

  it("undefined → DEFAULT_SCORE (2)", () => {
    expect(scoreSectorMomentum(undefined)).toBe(2);
  });
});
