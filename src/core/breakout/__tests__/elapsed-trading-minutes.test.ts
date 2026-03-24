import { describe, it, expect } from "vitest";
import { getElapsedTradingMinutes, getElapsedFraction } from "../elapsed-trading-minutes";

describe("getElapsedTradingMinutes", () => {
  it("前場開始直後: 9:01 → 1分", () => {
    expect(getElapsedTradingMinutes(9, 1)).toBe(1);
  });

  it("前場中盤: 10:00 → 60分", () => {
    expect(getElapsedTradingMinutes(10, 0)).toBe(60);
  });

  it("前場終了: 11:30 → 150分", () => {
    expect(getElapsedTradingMinutes(11, 30)).toBe(150);
  });

  it("昼休み中: 12:00 → 150分（前場分のみ）", () => {
    expect(getElapsedTradingMinutes(12, 0)).toBe(150);
  });

  it("後場開始直後: 12:31 → 151分", () => {
    expect(getElapsedTradingMinutes(12, 31)).toBe(151);
  });

  it("後場中盤: 14:00 → 240分", () => {
    expect(getElapsedTradingMinutes(14, 0)).toBe(240);
  });

  it("大引け: 15:00 → 300分", () => {
    expect(getElapsedTradingMinutes(15, 0)).toBe(300);
  });

  it("場前: 8:30 → 0分", () => {
    expect(getElapsedTradingMinutes(8, 30)).toBe(0);
  });
});

describe("getElapsedFraction", () => {
  it("9:30 → 0.1", () => {
    expect(getElapsedFraction(9, 30)).toBeCloseTo(0.1);
  });

  it("15:00 → 1.0", () => {
    expect(getElapsedFraction(15, 0)).toBeCloseTo(1.0);
  });
});
