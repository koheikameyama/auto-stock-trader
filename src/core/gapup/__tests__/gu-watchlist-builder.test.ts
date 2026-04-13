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

import { buildGuWatchlist } from "../gu-watchlist-builder";

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
  const { close = 1000, high = 1022, volume = 100_000 } = opts;

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
      low: close * 0.997,
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

describe("buildGuWatchlist", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // デフォルト: 十分な資金があると仮定
    mockGetEffectiveCapital.mockResolvedValue(10_000_000);
  });

  it("直近5日リターンがプラスの銘柄を候補にする", async () => {
    // i=0（最新終値）=1050, i=4（5日前終値）=1000 → momentum5d = (1050-1000)/1000 = 0.05 > 0
    const bars = makeBars(80, {
      override: (i) => {
        if (i === 0) return { close: 1050, open: 1040, high: 1060, low: 1035 };
        if (i === 4) return { close: 1000, open: 990, high: 1010, low: 985 };
        return {};
      },
    });

    mockStockFindMany.mockResolvedValue([makeStock("1234", { latestPrice: 1050 })]);
    mockReadHistoricalFromDB.mockResolvedValue(new Map([["1234", bars]]));

    const { entries } = await buildGuWatchlist();

    expect(entries.length).toBe(1);
    expect(entries[0].ticker).toBe("1234");
    expect(entries[0].momentum5d).toBeGreaterThan(0);
  });

  it("直近5日リターンがゼロ以下の銘柄は除外する", async () => {
    // 週足上昇トレンドを維持しつつ、直近5日だけわずかに下落するケース
    // 価格は810→1205と全体的に上昇（週足SMA13チェック通過）
    // i=0(最新)=1180, i=4=1205（5日前より低い）→ momentum5d < 0
    // ※ 既存テスト「ゲート通過 + 週足SMA13以上 → ウォッチリストに入る」と同じ上昇基調データを使用
    const bars = makeBars(80, {
      override: (i) => {
        const basePrice = 800 + (80 - i) * 5 + 5; // i=0→1205, i=79→810
        if (i === 0) return { open: 1170, high: 1185, low: 1165, close: 1180 }; // 5日前より低い
        return { open: Math.round(basePrice * 0.99), high: Math.round(basePrice * 1.02), low: Math.round(basePrice * 0.99), close: basePrice };
      },
      volume: 100_000,
    });

    mockStockFindMany.mockResolvedValue([makeStock("2222", { latestPrice: 1180 })]);
    mockReadHistoricalFromDB.mockResolvedValue(new Map([["2222", bars]]));

    const { entries, stats } = await buildGuWatchlist();

    expect(entries.length).toBe(0);
    expect(stats.skipMomentum).toBe(1);
  });

  it("high20フィルターは適用しない（high20を超えている銘柄も候補にする）", async () => {
    // breakout では「現在値 >= high20」でないと除外されるが、GU では high20 フィルターがない
    // 価格がすでに20日高値を超えている状態: newest close=1050（上昇）, その他 close=1000
    // i=0: close=1050（最新、20日high=1022 を上回っている）
    // i=4: close=1000（5日前）→ momentum5d = (1050-1000)/1000 = 0.05 > 0
    const bars = makeBars(80, {
      close: 1000,
      high: 1022,
      volume: 200_000,
      override: (i) => {
        if (i === 0) return { close: 1050, open: 1040, high: 1060, low: 1035 };
        return {};
      },
    });

    mockStockFindMany.mockResolvedValue([makeStock("3333", { latestPrice: 1050 })]);
    mockReadHistoricalFromDB.mockResolvedValue(new Map([["3333", bars]]));

    const { entries } = await buildGuWatchlist();

    // high20フィルターなし → breakout では除外される銘柄が GU では通る
    expect(entries.length).toBe(1);
    expect(entries[0].ticker).toBe("3333");
  });
});
