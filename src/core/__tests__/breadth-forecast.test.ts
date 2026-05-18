import { describe, it, expect } from "vitest";
import { computeBreadthForecast } from "../breadth-forecast";

function buildHistory(ticker: string, closes: number[]) {
  return { ticker, closes };
}

describe("computeBreadthForecast", () => {
  it("Day 0 では現状の breadth を返す", () => {
    // 銘柄1: close 100 が 25日続いた後、現在 110 → close > SMA25 (=100.4) → above
    // 銘柄2: close 100 が 25日続いた後、現在 90 → close < SMA25 (=99.6) → below
    const tickerAbove = Array(24).fill(100).concat([110]);
    const tickerBelow = Array(24).fill(100).concat([90]);
    const histories = [
      buildHistory("A", tickerAbove),
      buildHistory("B", tickerBelow),
    ];
    const result = computeBreadthForecast(histories, 0, 5);
    expect(result[0].above).toBe(1);
    expect(result[0].total).toBe(2);
    expect(result[0].breadth).toBe(0.5);
  });

  it("flat (0%/日) シナリオで価格据え置き時、SMA25 が close に収束する", () => {
    // 銘柄: 過去25日は変動あり、現在 100
    const closes = [80, 82, 84, 86, 88, 90, 92, 94, 96, 98, 100, 102, 104, 106, 108, 110, 108, 106, 104, 102, 100, 100, 100, 100, 100];
    const histories = [buildHistory("A", closes)];
    const result = computeBreadthForecast(histories, 0, 25);
    // 25日後には全 close が 100 = SMA25 = 100 → close > SMA25 は false
    expect(result[25].above).toBe(0);
  });

  it("rebound (+1%/日) シナリオでは breadth が単調増加に向かう", () => {
    // 銘柄: 過去25日 100、現在 95（SMA25 下回り）
    const closes = Array(24).fill(100).concat([95]);
    const histories = [buildHistory("A", closes)];
    const result = computeBreadthForecast(histories, 0.01, 20);
    // Day 0 では 95 < 100 (SMA) で below
    expect(result[0].above).toBe(0);
    // どこかの段階で close > SMA を上回るはず
    const ever = result.some((f) => f.above === 1);
    expect(ever).toBe(true);
  });

  it("bear (-1%/日) シナリオでは breadth が単調減少する", () => {
    // 銘柄: 過去25日 100、現在 105（SMA 上回り）
    const closes = Array(24).fill(100).concat([105]);
    const histories = [buildHistory("A", closes)];
    const result = computeBreadthForecast(histories, -0.01, 20);
    // Day 0 では above
    expect(result[0].above).toBe(1);
    // 最終的に below になるはず（25日かけて下落）
    expect(result[20].above).toBe(0);
  });

  it("複数銘柄を独立に計算する", () => {
    const upTrend = Array(24).fill(100).concat([110]);
    const downTrend = Array(24).fill(100).concat([90]);
    const histories = [
      buildHistory("UP", upTrend),
      buildHistory("DOWN", downTrend),
    ];
    const result = computeBreadthForecast(histories, 0.005, 10);
    // Day 0: UP only above
    expect(result[0].above).toBe(1);
    // rebound でも DOWN は SMA に届くまで時間かかる
    expect(result[result.length - 1].above).toBeGreaterThanOrEqual(1);
  });
});
