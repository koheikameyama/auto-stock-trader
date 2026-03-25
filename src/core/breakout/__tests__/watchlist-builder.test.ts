import { describe, it, expect, vi, beforeEach } from "vitest";

// ----------------------------------------
// Mock definitions (hoisted so vi.mock can reference them)
// ----------------------------------------
const { mockStockFindMany, mockReadHistoricalFromDB, mockGetEffectiveCapital } = vi.hoisted(() => ({
  mockStockFindMany: vi.fn(),
  mockReadHistoricalFromDB: vi.fn(),
  mockGetEffectiveCapital: vi.fn(),
}));

vi.mock("../../../lib/prisma", () => ({
  prisma: {
    stock: { findMany: mockStockFindMany },
  },
}));

vi.mock("../../market-data", () => ({
  readHistoricalFromDB: mockReadHistoricalFromDB,
}));

vi.mock("../../position-manager", () => ({
  getEffectiveCapital: mockGetEffectiveCapital,
}));

import { buildWatchlist } from "../watchlist-builder";

// ----------------------------------------
// Helpers
// ----------------------------------------

/**
 * 指定した終値・出来高で N 本のダミー OHLCVBar を生成する（newest-first）。
 * 週足 SMA13 の計算には 14 週（= 70 営業日）以上が必要なため、デフォルトは 80 本。
 * SCANNER_MIN_BARS の要件 (15 本) も十分に満たす。
 *
 * 日付は実際のカレンダー日付（2025-12-01から遡った平日）を使用する。
 * aggregateDailyToWeekly はカレンダー週でグループ化するため、
 * 有効な日付が必要。
 *
 * @param count 生成するバー数
 * @param opts 上書きオプション
 */
function makeBars(
  count = 80,
  opts: {
    close?: number;
    high?: number;
    volume?: number;
    /** i 番目のバー（newest-first, i=0 が最新）に上書き値を適用するコールバック */
    override?: (i: number) => Partial<{ open: number; high: number; low: number; close: number; volume: number }>;
  } = {},
) {
  const { close = 1000, high = 1050, volume = 100_000 } = opts;

  // 2026-03-21 (金曜) から遡って平日だけ数える
  // 週 5 日 × 20 週 = 100 日分のカレンダー日を生成
  const baseDate = new Date(Date.UTC(2026, 2, 21)); // 2026-03-21

  /** i 日前の平日日付文字列 (newest-first) */
  function getWeekdayDate(newestFirstIndex: number): string {
    const d = new Date(baseDate);
    let weekdaysBack = 0;
    let calendarDaysBack = 0;
    while (weekdaysBack <= newestFirstIndex) {
      const dd = new Date(d.getTime() - calendarDaysBack * 86_400_000);
      const dow = dd.getUTCDay();
      if (dow !== 0 && dow !== 6) {
        if (weekdaysBack === newestFirstIndex) {
          return dd.toISOString().slice(0, 10);
        }
        weekdaysBack++;
      }
      calendarDaysBack++;
    }
    return d.toISOString().slice(0, 10);
  }

  return Array.from({ length: count }, (_, i) => {
    const base = {
      date: getWeekdayDate(i),
      open: close * 0.99,
      high,
      low: close * 0.97,
      close,
      volume,
    };
    return opts.override ? { ...base, ...opts.override(i) } : base;
  });
}

/**
 * stock.findMany が返す最小限のレコードを生成する。
 */
function makeStock(
  ticker: string,
  overrides: Partial<{
    latestPrice: number | null;
    latestVolume: number | null;
    nextEarningsDate: Date | null;
    exDividendDate: Date | null;
  }> = {},
) {
  return {
    tickerCode: ticker,
    latestPrice: 1000,
    latestVolume: 100_000,
    nextEarningsDate: null,
    exDividendDate: null,
    ...overrides,
  };
}

// ----------------------------------------
// Tests
// ----------------------------------------

describe("buildWatchlist", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // デフォルト: 十分な資金があると仮定
    mockGetEffectiveCapital.mockResolvedValue(10_000_000);
  });

  it("ゲートを通過し週足上昇トレンドの銘柄がウォッチリストに入る", async () => {
    const bars = makeBars(80);
    mockStockFindMany.mockResolvedValue([makeStock("1234")]);
    mockReadHistoricalFromDB.mockResolvedValue(new Map([["1234", bars]]));

    const { entries } = await buildWatchlist();

    expect(entries.length).toBe(1);
    expect(entries[0].ticker).toBe("1234");
    expect(entries[0].latestClose).toBeGreaterThan(0);
    expect(entries[0].atr14).toBeGreaterThan(0);
    expect(entries[0].avgVolume25).toBeGreaterThan(0);
    expect(entries[0].high20).toBeGreaterThan(0);
  });

  it("high20 は直近20日の日足 high の最大値", async () => {
    // high はデフォルト 1050。バー i=5 だけ high=2000 にする（直近20本の中）
    // バー i=25 は high=9999 だが 21 本目なので high20 に含まれない
    const bars = makeBars(80, {
      override: (i) => {
        if (i === 5) return { high: 2000 };
        if (i === 25) return { high: 9999 };
        return {};
      },
    });

    mockStockFindMany.mockResolvedValue([makeStock("1234")]);
    mockReadHistoricalFromDB.mockResolvedValue(new Map([["1234", bars]]));

    const { entries } = await buildWatchlist();

    expect(entries.length).toBe(1);
    // high20 = 直近20本（i=0..19）の high の最大値 = 2000
    expect(entries[0].high20).toBe(2000);
  });

  it("avgVolume25 は直近25日の出来高の平均", async () => {
    // 最初の25本（i=0..24）を volume=200_000、それ以降を volume=50_000 にする
    const bars = makeBars(80, {
      override: (i) => (i < 25 ? { volume: 200_000 } : { volume: 50_000 }),
    });

    mockStockFindMany.mockResolvedValue([makeStock("1234")]);
    mockReadHistoricalFromDB.mockResolvedValue(new Map([["1234", bars]]));

    const { entries } = await buildWatchlist();

    expect(entries.length).toBe(1);
    expect(entries[0].avgVolume25).toBeCloseTo(200_000);
  });

  it("株価が MAX_PRICE (5000) を超えるとゲート失敗で除外される", async () => {
    const bars = makeBars(80, { close: 6000, high: 6100 });
    mockStockFindMany.mockResolvedValue([makeStock("9999", { latestPrice: 6000 })]);
    mockReadHistoricalFromDB.mockResolvedValue(new Map([["9999", bars]]));

    const { entries, stats } = await buildWatchlist();

    expect(entries.length).toBe(0);
    expect(stats.skipGate).toBe(1);
  });

  it("avgVolume25 が MIN_AVG_VOLUME_25 (50_000) を下回ると流動性ゲート失敗で除外される", async () => {
    const bars = makeBars(80, { volume: 10_000 });
    mockStockFindMany.mockResolvedValue([makeStock("2222", { latestVolume: 10_000 })]);
    mockReadHistoricalFromDB.mockResolvedValue(new Map([["2222", bars]]));

    const { entries, stats } = await buildWatchlist();

    expect(entries.length).toBe(0);
    expect(stats.skipGate).toBe(1);
  });

  it("週足下降トレンドの銘柄（weeklyClose < weeklySma13）はゲート通過でも除外される", async () => {
    // 直近8週（40本）を安値500、古い9週以上（40本）を高値2000にする。
    // newest-first: i=0..39 → close=500 (最近), i=40..79 → close=2000 (古い)
    // weekly SMA13 は高値寄りになり weeklyClose (≈500) < weeklySma13 (>> 500) となる
    const bars = makeBars(80, {
      override: (i) => {
        const price = i < 40 ? 500 : 2000;
        return { open: price * 0.99, high: price * 1.01, low: price * 0.97, close: price };
      },
      volume: 100_000,
    });

    mockStockFindMany.mockResolvedValue([makeStock("3333", { latestPrice: 500 })]);
    mockReadHistoricalFromDB.mockResolvedValue(new Map([["3333", bars]]));

    const { entries, stats } = await buildWatchlist();

    // weeklyClose (≈500) < weeklySma13 (高値寄り) → 除外
    expect(entries.length).toBe(0);
    expect(stats.skipWeeklyTrend).toBe(1);
  });

  it("ゲート通過 + 週足SMA13以上 → ウォッチリストに入る", async () => {
    // 価格が安定して上昇しているケース（oldest から newest へ価格が上昇）
    // newest-first: i=0 が最新（高値）、i=79 が最古（安値）
    const bars = makeBars(80, {
      override: (i) => {
        // i=0 → price=1400, i=79 → price=805 (緩やかに上昇)
        const price = 800 + (80 - i) * 5 + 5;
        return { open: price * 0.99, high: price * 1.02, low: price * 0.97, close: price };
      },
      volume: 100_000,
    });

    mockStockFindMany.mockResolvedValue([makeStock("4444", { latestPrice: 1405 })]);
    mockReadHistoricalFromDB.mockResolvedValue(new Map([["4444", bars]]));

    const { entries } = await buildWatchlist();

    expect(entries.length).toBe(1);
    expect(entries[0].ticker).toBe("4444");
  });

  it("ゲート通過 + 週足SMA13未満 → 除外される", async () => {
    // 急落ケース: 直近8週（40本）が急落価格、古い期間が高値
    // newest-first: i=0..39 → close=400, i=40..79 → close=1800
    const bars = makeBars(80, {
      override: (i) => {
        const price = i < 40 ? 400 : 1800;
        return { open: price * 0.99, high: price * 1.01, low: price * 0.97, close: price };
      },
      volume: 100_000,
    });

    mockStockFindMany.mockResolvedValue([makeStock("5555", { latestPrice: 400 })]);
    mockReadHistoricalFromDB.mockResolvedValue(new Map([["5555", bars]]));

    const { entries } = await buildWatchlist();

    expect(entries.length).toBe(0);
  });

  it("ヒストリカルデータが不足している銘柄は除外される", async () => {
    // SCANNER_MIN_BARS (15) 未満のデータ
    const bars = makeBars(10);
    mockStockFindMany.mockResolvedValue([makeStock("6666")]);
    mockReadHistoricalFromDB.mockResolvedValue(new Map([["6666", bars]]));

    const { entries, stats } = await buildWatchlist();

    expect(entries.length).toBe(0);
    expect(stats.skipInsufficientData).toBe(1);
  });

  it("銘柄がゼロ件のとき空配列を返す", async () => {
    mockStockFindMany.mockResolvedValue([]);
    mockReadHistoricalFromDB.mockResolvedValue(new Map());

    const { entries, stats } = await buildWatchlist();

    expect(entries).toEqual([]);
    expect(stats.totalStocks).toBe(0);
  });

  it("複数銘柄のうちゲートを通過したものだけが返される", async () => {
    const goodBars = makeBars(80);
    const expensiveBars = makeBars(80, { close: 6000, high: 6100 });

    mockStockFindMany.mockResolvedValue([
      makeStock("7777"),                               // ゲート通過（正常銘柄）
      makeStock("8888", { latestPrice: 6000 }),        // 株価高すぎてゲート失敗
    ]);
    mockReadHistoricalFromDB.mockResolvedValue(
      new Map([
        ["7777", goodBars],
        ["8888", expensiveBars],
      ]),
    );

    const { entries, stats } = await buildWatchlist();

    expect(entries.length).toBe(1);
    expect(entries[0].ticker).toBe("7777");
    expect(stats.skipGate).toBe(1);
    expect(stats.passed).toBe(1);
  });
});
