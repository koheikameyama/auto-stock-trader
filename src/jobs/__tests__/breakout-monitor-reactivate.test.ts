import { describe, it, expect, vi, beforeEach } from "vitest";
import { reactivateCancelledTriggers } from "../breakout-monitor";
import { BreakoutScanner } from "../../core/breakout/breakout-scanner";
import type { WatchlistEntry } from "../../core/breakout/types";

vi.mock("../../lib/prisma", () => ({
  prisma: {
    tradingOrder: {
      findMany: vi.fn().mockResolvedValue([]),
    },
  },
}));

vi.mock("../../lib/date-utils", () => ({
  getTodayForDB: vi.fn().mockReturnValue(new Date("2026-04-02T00:00:00Z")),
}));

// breakout-monitor が依存するモジュールをモック
vi.mock("../../lib/slack", () => ({ notifySlack: vi.fn() }));
vi.mock("../../lib/tachibana-price-client", () => ({ tachibanaFetchQuotesBatch: vi.fn() }));
vi.mock("../watchlist-builder", () => ({ getWatchlist: vi.fn() }));
vi.mock("../../core/position-manager", () => ({ getCashBalance: vi.fn() }));
vi.mock("../../core/contrarian-analyzer", () => ({
  getContrarianHistoryBatch: vi.fn().mockResolvedValue(new Map()),
  calculateContinuousContrarianBonus: vi.fn().mockReturnValue(0),
}));

function makeWatchlistEntry(ticker: string): WatchlistEntry {
  return { ticker, avgVolume25: 100_000, high20: 1000, atr14: 20, latestClose: 980 };
}

function makeScanner(tickers: string[]): BreakoutScanner {
  const scanner = new BreakoutScanner(tickers.map(makeWatchlistEntry));
  const triggeredToday = scanner.getState().triggeredToday as Set<string>;
  for (const ticker of tickers) {
    triggeredToday.add(ticker);
  }
  return scanner;
}

describe("reactivateCancelledTriggers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("全注文がキャンセル済みなら triggeredToday から除去する", async () => {
    const { prisma } = await import("../../lib/prisma");
    vi.mocked(prisma.tradingOrder.findMany).mockResolvedValue([
      { status: "cancelled", stock: { tickerCode: "7203" } } as never,
    ]);

    const scanner = makeScanner(["7203"]);
    expect(scanner.getState().triggeredToday.has("7203")).toBe(true);

    await reactivateCancelledTriggers(scanner);

    expect(scanner.getState().triggeredToday.has("7203")).toBe(false);
  });

  it("pending 注文が残っている銘柄は triggeredToday に残す", async () => {
    const { prisma } = await import("../../lib/prisma");
    vi.mocked(prisma.tradingOrder.findMany).mockResolvedValue([
      { status: "pending", stock: { tickerCode: "7203" } } as never,
    ]);

    const scanner = makeScanner(["7203"]);
    await reactivateCancelledTriggers(scanner);

    expect(scanner.getState().triggeredToday.has("7203")).toBe(true);
  });

  it("filled 注文が残っている銘柄は triggeredToday に残す", async () => {
    const { prisma } = await import("../../lib/prisma");
    vi.mocked(prisma.tradingOrder.findMany).mockResolvedValue([
      { status: "filled", stock: { tickerCode: "7203" } } as never,
    ]);

    const scanner = makeScanner(["7203"]);
    await reactivateCancelledTriggers(scanner);

    expect(scanner.getState().triggeredToday.has("7203")).toBe(true);
  });

  it("本日注文がない銘柄は triggeredToday に残す", async () => {
    const { prisma } = await import("../../lib/prisma");
    vi.mocked(prisma.tradingOrder.findMany).mockResolvedValue([]);

    const scanner = makeScanner(["7203"]);
    await reactivateCancelledTriggers(scanner);

    expect(scanner.getState().triggeredToday.has("7203")).toBe(true);
  });

  it("複数銘柄: キャンセル済みのみ除去し他は残す", async () => {
    const { prisma } = await import("../../lib/prisma");
    vi.mocked(prisma.tradingOrder.findMany).mockResolvedValue([
      { status: "cancelled", stock: { tickerCode: "7203" } } as never,
      { status: "pending",   stock: { tickerCode: "9984" } } as never,
    ]);

    const scanner = makeScanner(["7203", "9984", "6758"]);
    await reactivateCancelledTriggers(scanner);

    expect(scanner.getState().triggeredToday.has("7203")).toBe(false); // 除去
    expect(scanner.getState().triggeredToday.has("9984")).toBe(true);  // pending → 残す
    expect(scanner.getState().triggeredToday.has("6758")).toBe(true);  // 注文なし → 残す
  });

  it("triggeredToday が空なら DB クエリを発行しない", async () => {
    const { prisma } = await import("../../lib/prisma");

    const scanner = new BreakoutScanner([makeWatchlistEntry("7203")]);
    // triggeredToday は空のまま
    await reactivateCancelledTriggers(scanner);

    expect(prisma.tradingOrder.findMany).not.toHaveBeenCalled();
  });
});
