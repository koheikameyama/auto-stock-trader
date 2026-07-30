import { describe, it, expect, vi, beforeEach } from "vitest";

const {
  mockAssessmentFindUnique,
  mockWatchlistFindMany,
  mockBarFindMany,
  mockRecordSkipped,
} = vi.hoisted(() => ({
  mockAssessmentFindUnique: vi.fn(),
  mockWatchlistFindMany: vi.fn(),
  mockBarFindMany: vi.fn(),
  mockRecordSkipped: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../lib/prisma", () => ({
  prisma: {
    marketAssessment: { findUnique: mockAssessmentFindUnique },
    watchlistEntry: { findMany: mockWatchlistFindMany },
    stockDailyBar: { findMany: mockBarFindMany },
    $disconnect: vi.fn(),
  },
}));
vi.mock("../../core/breakout/entry-executor", () => ({
  recordSkippedCandidates: mockRecordSkipped,
}));
vi.mock("../../lib/market-date", () => ({
  getTodayForDB: vi.fn().mockReturnValue(new Date("2026-04-10T00:00:00Z")),
}));

import { main } from "../signal-replay";

const TODAY = new Date("2026-04-10T00:00:00Z");

/** 直近 n 営業日分の平坦なバー（当日分は含まない） */
function history(ticker: string, n: number, close: number) {
  return Array.from({ length: n }, (_, i) => ({
    tickerCode: ticker,
    date: new Date(Date.UTC(2026, 2, 1 + i)),
    open: close,
    close,
    volume: 100_000n,
  }));
}

function todayBar(ticker: string, o: number, c: number, v: bigint) {
  return { tickerCode: ticker, date: TODAY, open: o, close: c, volume: v };
}

describe("signal-replay main()", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockWatchlistFindMany.mockResolvedValue([]);
    mockBarFindMany.mockResolvedValue([]);
  });

  it("取引日(shouldTrade=true)は monitor が記録済みなのでスキップ", async () => {
    mockAssessmentFindUnique.mockResolvedValue({ shouldTrade: true });
    await main();
    expect(mockWatchlistFindMany).not.toHaveBeenCalled();
    expect(mockRecordSkipped).not.toHaveBeenCalled();
  });

  it("見送り日でウォッチリストが空なら何も記録しない", async () => {
    mockAssessmentFindUnique.mockResolvedValue({ shouldTrade: false });
    mockWatchlistFindMany.mockResolvedValue([]);
    await main();
    expect(mockRecordSkipped).not.toHaveBeenCalled();
  });

  it("見送り日にGUシグナルが成立した銘柄を『相場停止』で記録", async () => {
    mockAssessmentFindUnique.mockResolvedValue({ shouldTrade: false });
    mockWatchlistFindMany.mockResolvedValue([
      { tickerCode: "7203", avgVolume25: 100_000, latestClose: 1000, momentum5d: 0.05 },
    ]);
    // gap = (1040-1000)/1000 = 4% ≥ 3%、陽線、出来高サージ 3x ≥ 1.5x
    mockBarFindMany.mockResolvedValue([todayBar("7203", 1040, 1060, 300_000n)]);

    await main();

    const guCall = mockRecordSkipped.mock.calls.find((c) => c[1] === "gapup");
    expect(guCall?.[0]).toEqual([{ ticker: "7203", currentPrice: 1060 }]);
    expect(guCall?.[3]).toBe("相場停止");
    expect(String(guCall?.[2])).toContain("shouldTrade");
  });

  it("momentum5d <= 0 の銘柄は GU 判定の対象外（getGuWatchlist と揃える）", async () => {
    mockAssessmentFindUnique.mockResolvedValue({ shouldTrade: false });
    mockWatchlistFindMany.mockResolvedValue([
      { tickerCode: "7203", avgVolume25: 100_000, latestClose: 1000, momentum5d: -0.02 },
    ]);
    mockBarFindMany.mockResolvedValue([todayBar("7203", 1040, 1060, 300_000n)]);

    await main();

    const guCall = mockRecordSkipped.mock.calls.find((c) => c[1] === "gapup");
    expect(guCall?.[0]).toEqual([]);
  });

  // psc-monitor は 15:24 に走るため当日バーが DB に無く、過去バーだけで
  // close20DaysAgo / high20 を作る。リプレイで当日を含めると基準が1日ずれる。
  it("PSC判定は当日バーを除いた過去25営業日から作る", async () => {
    mockAssessmentFindUnique.mockResolvedValue({ shouldTrade: false });
    mockWatchlistFindMany.mockResolvedValue([
      { tickerCode: "6758", avgVolume25: 100_000, latestClose: 1000, momentum5d: 0.05 },
    ]);
    // 過去25本は 1000 で平坦 → close20DaysAgo=1000, high20=1000。
    // 当日 close 1200 = +20% ≥ 15%、高値からの距離0%、陽線、出来高3x
    mockBarFindMany.mockResolvedValue([
      ...history("6758", 25, 1000),
      todayBar("6758", 1100, 1200, 300_000n),
    ]);

    await main();

    const pscCall = mockRecordSkipped.mock.calls.find(
      (c) => c[1] === "post-surge-consolidation",
    );
    expect(pscCall?.[0]).toEqual([{ ticker: "6758", currentPrice: 1200 }]);
    expect(pscCall?.[3]).toBe("相場停止");
  });

  it("当日バーが1銘柄も無ければ throw（backfill未完了の検知）", async () => {
    mockAssessmentFindUnique.mockResolvedValue({ shouldTrade: false });
    mockWatchlistFindMany.mockResolvedValue([
      { tickerCode: "7203", avgVolume25: 100_000, latestClose: 1000, momentum5d: 0.05 },
    ]);
    // 当日より前のバーしか無い
    mockBarFindMany.mockResolvedValue(history("7203", 3, 1000));

    await expect(main()).rejects.toThrow(/当日バー/);
  });
});
