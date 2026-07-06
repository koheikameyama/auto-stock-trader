import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockSummaryFindFirst, mockPositionFindMany } = vi.hoisted(() => ({
  mockSummaryFindFirst: vi.fn(),
  mockPositionFindMany: vi.fn(),
}));

vi.mock("../../lib/prisma", () => ({
  prisma: {
    tradingDailySummary: { findFirst: mockSummaryFindFirst },
    tradingPosition: { findMany: mockPositionFindMany },
  },
}));

import { cumulativeReturnPct } from "../public-performance";

/** findFirst は date asc（最古）→ date desc（最新）の順で呼ばれる */
function setSummaries(
  first: { portfolioValue: number; cashBalance: number } | null,
  last: { date: Date; portfolioValue: number; cashBalance: number } | null,
) {
  mockSummaryFindFirst.mockImplementation(
    ({ orderBy }: { orderBy: { date: "asc" | "desc" } }) =>
      Promise.resolve(orderBy.date === "asc" ? first : last),
  );
}

describe("cumulativeReturnPct", () => {
  beforeEach(() => {
    mockSummaryFindFirst.mockReset();
    mockPositionFindMany.mockReset();
    mockPositionFindMany.mockResolvedValue([]);
  });

  it("最古と最新の equity 比で累計を返す", async () => {
    setSummaries(
      { portfolioValue: 0, cashBalance: 500_000 },
      {
        date: new Date("2026-07-03T00:00:00Z"),
        portfolioValue: 0,
        cashBalance: 516_930,
      },
    );

    const pct = await cumulativeReturnPct();
    expect(pct).toBeCloseTo(3.386, 3);
    // 最新行の portfolioValue=0 → 保有復元クエリが走る（保有なしなら補完 0）
    expect(mockPositionFindMany).toHaveBeenCalledTimes(1);
  });

  it("サマリーが無ければ null", async () => {
    setSummaries(null, null);
    expect(await cumulativeReturnPct()).toBeNull();
  });

  it("初日 equity が 0 なら null", async () => {
    setSummaries(
      { portfolioValue: 0, cashBalance: 0 },
      {
        date: new Date("2026-07-06T00:00:00Z"),
        portfolioValue: 0,
        cashBalance: 100_000,
      },
    );
    expect(await cumulativeReturnPct()).toBeNull();
  });

  it("約定同期遅延の壊れた最新行（portfolioValue=0 + 保有あり）を保有コストで補完する (KOH-530)", async () => {
    // 7/6 実データの再現: 買付 ¥314,400 が cash からだけ消えたサマリー
    setSummaries(
      { portfolioValue: 0, cashBalance: 500_000 },
      {
        date: new Date("2026-07-06T00:00:00Z"),
        portfolioValue: 0,
        cashBalance: 202_332,
      },
    );
    mockPositionFindMany.mockResolvedValue([
      { entryPrice: 1889, quantity: 100 },
      { entryPrice: 1255, quantity: 100 },
    ]);

    const pct = await cumulativeReturnPct();
    // (202,332 + 314,400) / 500,000 - 1 = +3.3464%
    expect(pct).toBeCloseTo(3.3464, 3);

    // JST 7/6 の終わり（= UTC 7/6 15:00）を境界に「当日引け時点で保有」を判定
    const where = mockPositionFindMany.mock.calls[0][0].where;
    expect(where.createdAt.lt.toISOString()).toBe("2026-07-06T15:00:00.000Z");
    expect(where.OR).toEqual([
      { exitedAt: null },
      { exitedAt: { gte: new Date("2026-07-06T15:00:00.000Z") } },
    ]);
  });

  it("最新行の portfolioValue が正なら保有復元をスキップする", async () => {
    setSummaries(
      { portfolioValue: 0, cashBalance: 500_000 },
      {
        date: new Date("2026-07-02T00:00:00Z"),
        portfolioValue: 236_500,
        cashBalance: 250_028,
      },
    );

    const pct = await cumulativeReturnPct();
    expect(pct).toBeCloseTo(((236_500 + 250_028) / 500_000 - 1) * 100, 3);
    expect(mockPositionFindMany).not.toHaveBeenCalled();
  });
});
