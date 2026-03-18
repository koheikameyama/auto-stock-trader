import { describe, it, expect } from "vitest";
import { scoreSectorMomentum } from "../../scoring/sector-momentum";

describe("scoreSectorMomentum", () => {
  it(">= +2.0% → +5", () => {
    expect(scoreSectorMomentum(3.0)).toBe(5);
    expect(scoreSectorMomentum(2.0)).toBe(5);
  });

  it(">= +1.0% → +3", () => {
    expect(scoreSectorMomentum(1.5)).toBe(3);
    expect(scoreSectorMomentum(1.0)).toBe(3);
  });

  it(">= +0.5% → +1", () => {
    expect(scoreSectorMomentum(0.8)).toBe(1);
    expect(scoreSectorMomentum(0.5)).toBe(1);
  });

  it(">= -0.5% → 0 (neutral)", () => {
    expect(scoreSectorMomentum(0.0)).toBe(0);
    expect(scoreSectorMomentum(-0.5)).toBe(0);
  });

  it(">= -2.0% → -2", () => {
    expect(scoreSectorMomentum(-1.0)).toBe(-2);
    expect(scoreSectorMomentum(-2.0)).toBe(-2);
  });

  it("< -2.0% → -3 (floor)", () => {
    expect(scoreSectorMomentum(-2.5)).toBe(-3);
    expect(scoreSectorMomentum(-5.0)).toBe(-3);
  });

  it("null → DEFAULT_BONUS (0)", () => {
    expect(scoreSectorMomentum(null)).toBe(0);
  });

  it("undefined → DEFAULT_BONUS (0)", () => {
    expect(scoreSectorMomentum(undefined)).toBe(0);
  });
});
