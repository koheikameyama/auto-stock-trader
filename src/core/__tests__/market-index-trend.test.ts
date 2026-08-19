import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockBarFindMany } = vi.hoisted(() => ({ mockBarFindMany: vi.fn() }));

vi.mock("../../lib/prisma", () => ({
  prisma: { stockDailyBar: { findMany: mockBarFindMany } },
}));

import { getNikkeiTrendFilterState } from "../market-index";
import { INDEX_TREND_HYSTERESIS } from "../../lib/constants";

const { SMA_PERIOD } = INDEX_TREND_HYSTERESIS;

/** closes は oldest-first。prisma は desc で返すので反転して渡す */
function setBars(closes: number[]) {
  const bars = closes.map((close, i) => ({
    date: new Date(Date.UTC(2026, 0, 1 + i)),
    close,
  }));
  mockBarFindMany.mockResolvedValue([...bars].reverse());
}

describe("getNikkeiTrendFilterState", () => {
  beforeEach(() => mockBarFindMany.mockReset());

  it("バーが SMA 期間に満たなければ null（フィルター不適用）", async () => {
    setBars(Array(SMA_PERIOD - 1).fill(30000));
    expect(await getNikkeiTrendFilterState()).toBeNull();
  });

  it("終値が SMA を上回っていれば filterOn=true", async () => {
    // 一貫した上昇 → 直近終値 > SMA
    setBars(Array.from({ length: SMA_PERIOD + 10 }, (_, i) => 30000 + i * 100));
    const state = await getNikkeiTrendFilterState();
    expect(state).not.toBeNull();
    expect(state!.filterOn).toBe(true);
    expect(state!.close).toBeGreaterThan(state!.sma);
  });

  it("終値が SMA を下回っていれば filterOn=false", async () => {
    setBars(Array.from({ length: SMA_PERIOD + 10 }, (_, i) => 30000 - i * 100));
    const state = await getNikkeiTrendFilterState();
    expect(state!.filterOn).toBe(false);
    expect(state!.close).toBeLessThan(state!.sma);
  });

  it("SMA を割った後に回復すれば filterOn=true に戻る（バッファ0のヒステリシス）", async () => {
    // 上昇 → 急落で SMA 割れ → 再上昇で SMA 超え
    const up = Array.from({ length: SMA_PERIOD }, (_, i) => 30000 + i * 100);
    const down = Array.from({ length: 15 }, (_, i) => 34900 - (i + 1) * 500);
    const recover = Array.from({ length: 25 }, (_, i) => 27400 + (i + 1) * 700);
    setBars([...up, ...down, ...recover]);
    const state = await getNikkeiTrendFilterState();
    expect(state!.close).toBeGreaterThan(state!.sma);
    expect(state!.filterOn).toBe(true);
  });

  it("判定に使った営業日を asOfDate として返す", async () => {
    setBars(Array.from({ length: SMA_PERIOD + 3 }, (_, i) => 30000 + i * 100));
    const state = await getNikkeiTrendFilterState();
    expect(state!.asOfDate).toEqual(new Date(Date.UTC(2026, 0, SMA_PERIOD + 3)));
  });
});
