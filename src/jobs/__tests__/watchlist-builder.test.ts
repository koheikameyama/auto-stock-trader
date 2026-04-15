import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockWatchlistEntryFindMany } = vi.hoisted(() => ({
  mockWatchlistEntryFindMany: vi.fn(),
}));

vi.mock("../../lib/prisma", () => ({
  prisma: {
    watchlistEntry: { findMany: mockWatchlistEntryFindMany },
  },
}));

// キャッシュをリセットするためにモジュールを動的インポートする
import { getGuWatchlist, getPscWatchlist } from "../watchlist-builder";

function makeRow(ticker: string, momentum5d: number) {
  return {
    tickerCode: ticker,
    avgVolume25: 100_000,
    atr14: 20,
    latestClose: 1000,
    momentum5d,
    weeklyHigh13: null,
    ma20: null,
  };
}

describe("getGuWatchlist", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("momentum5d > 0 の銘柄のみ返す", async () => {
    mockWatchlistEntryFindMany.mockResolvedValue([
      makeRow("1111", 0.05),   // GU候補
      makeRow("2222", -0.02),  // PSC候補（GUは除外）
      makeRow("3333", 0),      // GUは除外
    ]);

    const result = await getGuWatchlist();

    expect(result.map((e) => e.ticker)).toEqual(["1111"]);
  });
});

describe("getPscWatchlist", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("momentum5d の正負に関わらず全銘柄を返す", async () => {
    mockWatchlistEntryFindMany.mockResolvedValue([
      makeRow("1111", 0.05),
      makeRow("2222", -0.02),
      makeRow("3333", 0),
    ]);

    const result = await getPscWatchlist();

    expect(result.map((e) => e.ticker)).toEqual(["1111", "2222", "3333"]);
  });
});
