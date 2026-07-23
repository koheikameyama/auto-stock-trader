import { describe, it, expect, vi, beforeEach } from "vitest";

// ========================================
// モック設定
// ========================================

const { mockOrderFindMany, mockOrderUpdateMany, mockPositionFindMany, mockCountTradingDaysBetween } =
  vi.hoisted(() => ({
    mockOrderFindMany: vi.fn(),
    mockOrderUpdateMany: vi.fn().mockResolvedValue({ count: 0 }),
    mockPositionFindMany: vi.fn(),
    mockCountTradingDaysBetween: vi.fn(),
  }));

vi.mock("../../lib/prisma", () => ({
  prisma: {
    tradingOrder: {
      findMany: mockOrderFindMany,
      updateMany: mockOrderUpdateMany,
    },
    tradingPosition: {
      findMany: mockPositionFindMany,
    },
  },
}));

// getStartOfDayJST は固定値で十分（クエリ条件の検証用）。
// countTradingDaysBetween はテストごとに「決済からの経過営業日数」を制御する。
vi.mock("../../lib/market-date", () => ({
  getStartOfDayJST: () => new Date("2026-06-30T00:00:00.000Z"),
  countTradingDaysBetween: mockCountTradingDaysBetween,
}));

import { getSameDayPendingBuyTickers, getRecentlyExitedTickers, expireOrders } from "../order-executor";

// ========================================
// getSameDayPendingBuyTickers（Issue #322: 戦略横断の二重発注防止）
// ========================================

describe("getSameDayPendingBuyTickers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("当日の pending 買い注文を全戦略横断で名寄せして返す（GU と PSC が同一銘柄でも除外できる）", async () => {
    mockOrderFindMany.mockResolvedValue([
      { stock: { tickerCode: "3989" }, strategy: "gapup" },
      { stock: { tickerCode: "7203" }, strategy: "post-surge-consolidation" },
    ]);

    const tickers = await getSameDayPendingBuyTickers();

    expect(tickers).toEqual(new Set(["3989", "7203"]));
    // 戦略で絞らず side=buy / status=pending / 当日 で抽出していること
    const where = mockOrderFindMany.mock.calls[0][0].where;
    expect(where.side).toBe("buy");
    expect(where.status).toBe("pending");
    expect(where.strategy).toBeUndefined();
    expect(where.createdAt).toEqual({ gte: new Date("2026-06-30T00:00:00.000Z") });
  });

  it("当日の pending 買い注文が無ければ空集合", async () => {
    mockOrderFindMany.mockResolvedValue([]);
    expect(await getSameDayPendingBuyTickers()).toEqual(new Set());
  });
});

// ========================================
// getRecentlyExitedTickers（KOH-586: 決済後3営業日の再エントリー cooldown）
// ========================================

describe("getRecentlyExitedTickers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("cooldown(=3営業日)未満で決済した銘柄だけを除外集合に入れる（3営業日後に解禁）", async () => {
    const mk = (code: string, iso: string) => ({
      exitedAt: new Date(iso),
      stock: { tickerCode: code },
    });
    // 経過営業日数を exitedAt ごとに制御: 0=当日 / 2=2営業日前 / 3=3営業日前（解禁）
    const daysByExit = new Map<string, number>([
      ["2026-07-16T00:00:00.000Z", 0], // 当日決済 → 除外
      ["2026-07-14T00:00:00.000Z", 2], // 2営業日前 → 除外
      ["2026-07-11T00:00:00.000Z", 3], // 3営業日前 → 解禁（含めない）
    ]);
    mockPositionFindMany.mockResolvedValue([
      mk("3276.T", "2026-07-16T00:00:00.000Z"),
      mk("9900.T", "2026-07-14T00:00:00.000Z"),
      mk("7203.T", "2026-07-11T00:00:00.000Z"),
    ]);
    mockCountTradingDaysBetween.mockImplementation(
      (from: Date) => daysByExit.get(from.toISOString()) ?? 99,
    );

    const tickers = await getRecentlyExitedTickers();

    expect(tickers).toEqual(new Set(["3276.T", "9900.T"]));
    // status=closed / exitedAt を lookback で絞っていること
    const where = mockPositionFindMany.mock.calls[0][0].where;
    expect(where.status).toBe("closed");
    expect(where.exitedAt.gte).toBeInstanceOf(Date);
  });

  it("cooldownTradingDays=0 なら DB を引かずに空集合（cooldown無効）", async () => {
    const tickers = await getRecentlyExitedTickers(0);
    expect(tickers).toEqual(new Set());
    expect(mockPositionFindMany).not.toHaveBeenCalled();
  });

  it("exitedAt が null のポジションは無視する", async () => {
    mockPositionFindMany.mockResolvedValue([
      { exitedAt: null, stock: { tickerCode: "1234.T" } },
    ]);
    mockCountTradingDaysBetween.mockReturnValue(0);
    expect(await getRecentlyExitedTickers()).toEqual(new Set());
  });
});

// ========================================
// expireOrders（Issue #322: 約定×expire 競合の防止）
// ========================================

describe("expireOrders", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("ブローカー発注済み(brokerOrderId あり)の注文は時間ベースで expired にしない", async () => {
    mockOrderUpdateMany.mockResolvedValue({ count: 0 });

    await expireOrders();

    const where = mockOrderUpdateMany.mock.calls[0][0].where;
    // 立花に出した注文（引け成行の約定と競合しうる）を時間失効の対象外にする防御
    expect(where.brokerOrderId).toBeNull();
    expect(where.status).toBe("pending");
    expect(where.expiresAt.lte).toBeInstanceOf(Date);
  });

  it("更新件数を返す", async () => {
    mockOrderUpdateMany.mockResolvedValue({ count: 3 });
    expect(await expireOrders()).toBe(3);
  });
});
