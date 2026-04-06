import { describe, it, expect } from "vitest";
import { computeRecoveredStop } from "../trailing-stop-recovery";

const basePosition = {
  entryPrice: 2000,
  maxHighDuringHold: 2000,
  currentTrailingStop: null,
  stopLossPrice: 1940,
  entryAtr: 80,
  strategy: "breakout" as const,
};

describe("computeRecoveredStop", () => {
  it("barHighs が maxHighDuringHold を超えなければ improved=false", () => {
    const result = computeRecoveredStop(basePosition, [1990, 2000]);
    expect(result.improved).toBe(false);
    expect(result.newMaxHigh).toBe(2000);
  });

  it("barHighs が maxHighDuringHold を超えると newMaxHigh が更新される", () => {
    const result = computeRecoveredStop(basePosition, [2200, 2100]);
    expect(result.newMaxHigh).toBe(2200);
  });

  it("トレーリング発動後: newStopPrice = newMaxHigh - trailWidth (80)", () => {
    // BE = 2000 + 80*1.0 = 2080, maxHigh=2200 → 発動
    // trailWidth = 80, raw = 2200 - 80 = 2120
    const result = computeRecoveredStop(basePosition, [2200]);
    expect(result.newStopPrice).toBe(2120);
    expect(result.improved).toBe(true);
  });

  it("currentTrailingStop より低くなる場合はラチェット維持", () => {
    const position = { ...basePosition, currentTrailingStop: 2150 };
    // maxHigh=2200 → raw=2120 < 2150 → 2150 を維持
    const result = computeRecoveredStop(position, [2200]);
    expect(result.newStopPrice).toBe(2150);
    expect(result.improved).toBe(false); // 2150 === 2150, 改善なし
  });

  it("currentTrailingStop より高くなる場合は切り上げ", () => {
    const position = { ...basePosition, currentTrailingStop: 2050 };
    // maxHigh=2300 → raw=2220 > 2050 → 2220
    const result = computeRecoveredStop(position, [2300]);
    expect(result.newStopPrice).toBe(2220);
    expect(result.improved).toBe(true);
  });

  it("トレーリング未発動ならば stopLossPrice をそのまま返す", () => {
    // maxHigh=2050 < BE=2080 → 未発動
    const result = computeRecoveredStop(basePosition, [2050]);
    expect(result.newStopPrice).toBe(1940); // stopLossPrice
    expect(result.improved).toBe(false);
  });

  it("barHighs が空配列でも currentTrailingStop を保持", () => {
    const position = { ...basePosition, currentTrailingStop: 2100 };
    const result = computeRecoveredStop(position, []);
    expect(result.newStopPrice).toBe(2100);
    expect(result.improved).toBe(false);
  });
});
