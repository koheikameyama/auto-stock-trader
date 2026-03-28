import { describe, it, expect } from "vitest";
import { GapUpScanner, type GapUpQuoteData } from "../gapup-scanner";
import type { WatchlistEntry } from "../../breakout/types";

function makeWatchlist(overrides?: Partial<WatchlistEntry>): WatchlistEntry[] {
  return [
    {
      ticker: "1234",
      avgVolume25: 200_000,
      high20: 1000,
      atr14: 30,
      latestClose: 980,
      ...overrides,
    },
  ];
}

function makeQuote(overrides?: Partial<GapUpQuoteData>): GapUpQuoteData {
  return {
    ticker: "1234",
    open: 1020,       // 980 × 1.03 = 1009.4 → open > prevClose * 1.03
    price: 1025,       // close >= open (陽線) && close > prevClose * 1.03
    high: 1030,
    low: 1015,
    volume: 400_000,   // 200_000 * 1.5 = 300_000 → 400_000 > 300_000
    ...overrides,
  };
}

describe("GapUpScanner", () => {
  it("ギャップアップ条件を満たす銘柄でトリガーを返す", () => {
    const scanner = new GapUpScanner(makeWatchlist());
    const triggers = scanner.scan([makeQuote()], new Set());
    expect(triggers).toHaveLength(1);
    expect(triggers[0].ticker).toBe("1234");
    expect(triggers[0].currentPrice).toBe(1025);
    expect(triggers[0].volumeSurgeRatio).toBe(2); // 400000 / 200000
  });

  it("陰線（close < open）でトリガーしない", () => {
    const scanner = new GapUpScanner(makeWatchlist());
    const triggers = scanner.scan(
      [makeQuote({ price: 1010, open: 1020 })], // close < open
      new Set(),
    );
    expect(triggers).toHaveLength(0);
  });

  it("ギャップが3%未満でトリガーしない", () => {
    const scanner = new GapUpScanner(makeWatchlist());
    const triggers = scanner.scan(
      [makeQuote({ open: 990 })], // (990-980)/980 = 1% < 3%
      new Set(),
    );
    expect(triggers).toHaveLength(0);
  });

  it("出来高サージ不足でトリガーしない", () => {
    const scanner = new GapUpScanner(makeWatchlist());
    const triggers = scanner.scan(
      [makeQuote({ volume: 250_000 })], // 250000/200000 = 1.25 < 1.5
      new Set(),
    );
    expect(triggers).toHaveLength(0);
  });

  it("保有中銘柄はスキップ", () => {
    const scanner = new GapUpScanner(makeWatchlist());
    const triggers = scanner.scan([makeQuote()], new Set(["1234"]));
    expect(triggers).toHaveLength(0);
  });

  it("volumeSurgeRatio降順でソートされる", () => {
    const watchlist: WatchlistEntry[] = [
      { ticker: "1111", avgVolume25: 200_000, high20: 1000, atr14: 30, latestClose: 980 },
      { ticker: "2222", avgVolume25: 100_000, high20: 1000, atr14: 30, latestClose: 980 },
    ];
    const quotes: GapUpQuoteData[] = [
      { ticker: "1111", open: 1020, price: 1025, high: 1030, low: 1015, volume: 400_000 },
      { ticker: "2222", open: 1020, price: 1025, high: 1030, low: 1015, volume: 400_000 },
    ];
    const scanner = new GapUpScanner(watchlist);
    const triggers = scanner.scan(quotes, new Set());
    expect(triggers).toHaveLength(2);
    // 2222: 400000/100000=4.0, 1111: 400000/200000=2.0
    expect(triggers[0].ticker).toBe("2222");
    expect(triggers[1].ticker).toBe("1111");
  });
});
