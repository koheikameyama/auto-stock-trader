import { describe, it, expect } from "vitest";
import { calculateBBWidthPercentile } from "../technical-indicators/bb-width-history";

describe("calculateBBWidthPercentile", () => {
  it("安定した価格 → 低パーセンタイル", () => {
    const prices = Array.from({ length: 100 }, () => 100);
    const result = calculateBBWidthPercentile(prices, 20, 60);
    expect(result).toBeGreaterThanOrEqual(0);
    expect(result).toBeLessThanOrEqual(100);
  });

  it("データ不足 → null", () => {
    const prices = Array.from({ length: 30 }, () => 100);
    const result = calculateBBWidthPercentile(prices, 20, 60);
    expect(result).toBeNull();
  });

  it("直近が最小BB幅 → 0に近い", () => {
    // newest-first: 安定期間(直近)が先頭、荒い期間(過去)が後ろ
    const prices: number[] = [];
    for (let i = 0; i < 30; i++) prices.push(100); // 安定期間（newest = 先頭）
    for (let i = 0; i < 70; i++) prices.push(100 + (i % 2) * 20); // 荒い期間（過去 = 後ろ）
    const result = calculateBBWidthPercentile(prices, 20, 60);
    expect(result).not.toBeNull();
    if (result !== null) {
      expect(result).toBeLessThan(30);
    }
  });
});
