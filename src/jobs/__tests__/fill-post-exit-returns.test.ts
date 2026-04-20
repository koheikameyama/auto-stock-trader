import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockPositionFindMany, mockPositionUpdate, mockBarFindMany } = vi.hoisted(() => ({
  mockPositionFindMany: vi.fn().mockResolvedValue([]),
  mockPositionUpdate: vi.fn().mockResolvedValue({}),
  mockBarFindMany: vi.fn().mockResolvedValue([]),
}));

vi.mock("../../lib/prisma", () => ({
  prisma: {
    tradingPosition: {
      findMany: mockPositionFindMany,
      update: mockPositionUpdate,
    },
    stockDailyBar: {
      findMany: mockBarFindMany,
    },
  },
}));

vi.mock("../../lib/market-date", () => ({
  toJSTDateForDB: vi.fn((date: Date) => {
    const d = new Date(date);
    return new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  }),
  addTradingDays: vi.fn((from: Date, n: number) => {
    const d = new Date(from);
    d.setDate(d.getDate() + n);
    return d;
  }),
}));

import { fillPostExitReturns } from "../end-of-day";

function makePosition(overrides: Record<string, unknown> = {}) {
  return {
    id: "pos-1",
    exitedAt: new Date("2026-04-10T06:00:00Z"),
    exitPrice: 1000,
    stock: { tickerCode: "1234" },
    postExitClose5d: null,
    postExitClose10d: null,
    postExitMaxHigh10d: null,
    postExitMinLow10d: null,
    postExitReturn5dPct: null,
    postExitReturn10dPct: null,
    postExitMaxHighPct: null,
    postExitMinLowPct: null,
    ...overrides,
  };
}

function makeBars(count: number) {
  return Array.from({ length: count }, (_, i) => ({
    close: 1000 + (i + 1) * 10, // 1010, 1020, 1030, ...
    high: 1000 + (i + 1) * 15,  // 1015, 1030, 1045, ...
    low: 1000 + (i + 1) * 5,    // 1005, 1010, 1015, ...
  }));
}

describe("fillPostExitReturns", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("対象ポジションなし → 更新なし", async () => {
    mockPositionFindMany.mockResolvedValue([]);

    await fillPostExitReturns();

    expect(mockPositionUpdate).not.toHaveBeenCalled();
  });

  it("bars < 5本 → 何もセットされない", async () => {
    mockPositionFindMany.mockResolvedValue([makePosition()]);
    mockBarFindMany.mockResolvedValue(makeBars(3));

    await fillPostExitReturns();

    expect(mockPositionUpdate).not.toHaveBeenCalled();
  });

  it("bars = 5本 → close5dのみセット、10d系はnull", async () => {
    const pos = makePosition();
    mockPositionFindMany.mockResolvedValue([pos]);
    mockBarFindMany.mockResolvedValue(makeBars(5));

    await fillPostExitReturns();

    expect(mockPositionUpdate).toHaveBeenCalledTimes(1);
    const updateCall = mockPositionUpdate.mock.calls[0][0];
    expect(updateCall.data.postExitClose5d).toBe(1050); // bars[4].close
    expect(updateCall.data.postExitReturn5dPct).toBeCloseTo(5.0); // (1050-1000)/1000*100
    expect(updateCall.data.postExitClose10d).toBeUndefined();
    expect(updateCall.data.postExitMaxHigh10d).toBeUndefined();
  });

  it("bars = 10本 → 全8フィールドがセットされる", async () => {
    const pos = makePosition();
    mockPositionFindMany.mockResolvedValue([pos]);
    mockBarFindMany.mockResolvedValue(makeBars(10));

    await fillPostExitReturns();

    expect(mockPositionUpdate).toHaveBeenCalledTimes(1);
    const data = mockPositionUpdate.mock.calls[0][0].data;

    // close5d: bars[4].close = 1050
    expect(data.postExitClose5d).toBe(1050);
    expect(data.postExitReturn5dPct).toBeCloseTo(5.0);

    // close10d: bars[9].close = 1100
    expect(data.postExitClose10d).toBe(1100);
    expect(data.postExitReturn10dPct).toBeCloseTo(10.0);

    // maxHigh: max of bars[0..9].high = bars[9].high = 1150
    expect(data.postExitMaxHigh10d).toBe(1150);
    expect(data.postExitMaxHighPct).toBeCloseTo(15.0);

    // minLow: min of bars[0..9].low = bars[0].low = 1005
    expect(data.postExitMinLow10d).toBe(1005);
    expect(data.postExitMinLowPct).toBeCloseTo(0.5);
  });

  it("return%が負の場合も正しく計算される", async () => {
    const pos = makePosition();
    mockPositionFindMany.mockResolvedValue([pos]);
    // 株価が下がるバー
    const bars = Array.from({ length: 10 }, (_, i) => ({
      close: 1000 - (i + 1) * 10, // 990, 980, ...
      high: 1000 - (i + 1) * 5,   // 995, 990, ...
      low: 1000 - (i + 1) * 15,   // 985, 970, ...
    }));
    mockBarFindMany.mockResolvedValue(bars);

    await fillPostExitReturns();

    const data = mockPositionUpdate.mock.calls[0][0].data;
    expect(data.postExitReturn5dPct).toBeCloseTo(-5.0); // (950-1000)/1000*100
    expect(data.postExitReturn10dPct).toBeCloseTo(-10.0);
    expect(data.postExitMinLowPct).toBeCloseTo(-15.0); // min low = 850
  });

  it("close5dが既に埋まっている場合、close10dのみ処理", async () => {
    const pos = makePosition({ postExitClose5d: 1050, postExitReturn5dPct: 5.0 });
    mockPositionFindMany.mockResolvedValue([pos]);
    mockBarFindMany.mockResolvedValue(makeBars(10));

    await fillPostExitReturns();

    const data = mockPositionUpdate.mock.calls[0][0].data;
    expect(data.postExitClose5d).toBeUndefined(); // 既存値を上書きしない
    expect(data.postExitClose10d).toBe(1100);
  });
});
